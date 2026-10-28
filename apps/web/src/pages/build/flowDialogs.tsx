import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Button, Dialog, DialogActions, DialogBody, DialogContent, DialogSurface, DialogTitle, Spinner, Text , makeStyles, mergeClasses } from '@fluentui/react-components';
import { buildAutoAttendantFlowGraphFromDesign, buildCallQueueFlowGraphFromDesign, type LiveVoiceApps, type TenantObject, type TenantUserSummary, type AutoAttendantCallableEntity, type AutoAttendantCallFlow, type AutoAttendantHolidayCallFlow, type AutoAttendantSchedule, type CallFlowResourceAccount, type CallQueueActionSettings, type DesignAutoAttendantInput, type DesignCallQueueInput, type Paginated } from '@tvmf/shared';
import { api } from '../../api';
import { CallFlowDiagram } from '../../components/CallFlowDiagram';
import { LoadError, useRecordStyles, type Row } from '../../components/records';
import { fetchAllPages } from '../discovery/discoveryShared';

const useLocalStyles = makeStyles({
  w95vwMaxW95vw: { maxWidth: "95vw", width: "95vw" },
  blockMb10: { display: "block", marginBottom: '10px' },
});


/** Maps a Design & Build Call Queue row to the shape buildCallQueueFlowGraphFromDesign/buildAutoAttendantFlowGraphFromDesign need. */
function toDesignCqInput(r: Row): DesignCallQueueInput {
  return {
    buildId: String(r.id),
    name: String(r.name),
    overflow: (r.overflow as CallQueueActionSettings | null) ?? null,
    timeout: (r.timeout as CallQueueActionSettings | null) ?? null,
    noAgentAction: (r.no_agent_action as CallQueueActionSettings | null) ?? null,
    routingMethod: (r.routing_method as string | null) ?? undefined,
    agentAlertTime: typeof r.agent_alert_time === 'number' ? r.agent_alert_time : undefined,
    agentCount: Array.isArray(r.agents) ? (r.agents as string[]).length : undefined,
    agents: Array.isArray(r.agents) ? (r.agents as string[]) : undefined,
  };
}

/**
 * Maps a Design & Build Auto Attendant row to the shape
 * buildAutoAttendantFlowGraphFromDesign needs. `hasPhoneNumberById` looks up
 * this AA's own `discovery_resource_account_id` against the site's resource
 * accounts to tell whether it's a front door (a phone number rings into it
 * directly) vs. only reachable via another AA's menu - see
 * AutoAttendantFlowDialog, which builds that map.
 */
function toDesignAaInput(
  r: Row,
  hasPhoneNumberById?: Map<string, boolean>,
  resourceAccountById?: Map<string, CallFlowResourceAccount>,
): DesignAutoAttendantInput {
  const discoveryResourceAccountId = r.discovery_resource_account_id as string | null;
  const ownAccounts = (Array.isArray(r.resource_accounts) ? (r.resource_accounts as string[]) : [])
    .map((id) => resourceAccountById?.get(id))
    .filter((x): x is CallFlowResourceAccount => !!x);
  return {
    buildId: String(r.id),
    name: String(r.name),
    operator: (r.operator as AutoAttendantCallableEntity | null) ?? null,
    defaultCallFlow: (r.default_call_flow as AutoAttendantCallFlow | null) ?? null,
    afterHoursCallFlow: (r.after_hours_call_flow as AutoAttendantCallFlow | null) ?? null,
    holidayCallFlows: Array.isArray(r.holiday_call_flows) ? (r.holiday_call_flows as AutoAttendantHolidayCallFlow[]) : [],
    hasPhoneNumber: discoveryResourceAccountId ? hasPhoneNumberById?.get(discoveryResourceAccountId) : undefined,
    resourceAccounts: ownAccounts,
    schedule: (r.schedule as AutoAttendantSchedule | null) ?? null,
    timeZone: (r.time_zone_id as string | null) ?? null,
    userNameExtension: (r.user_name_extension as string | null) ?? null,
  };
}

/**
 * The "as-designed" call-flow diagram for one Call Queue - what happens on
 * Overflow/Timeout/No-agent, built from this row's own columns via
 * buildCallQueueFlowGraphFromDesign. No fetch needed - the row the "View
 * diagram" button was clicked from already carries everything.
 */
export function CallQueueFlowDialog({ row, onClose }: { row: Row; onClose: () => void }) {
  const ls = useLocalStyles();
  const s = useRecordStyles();
  const graph = useMemo(() => buildCallQueueFlowGraphFromDesign(toDesignCqInput(row)), [row]);

  return (
    <Dialog open onOpenChange={(_, d) => !d.open && onClose()}>
      <DialogSurface className={ls.w95vwMaxW95vw}>
        <DialogBody>
          <DialogTitle>Call flow: {String(row.name)}</DialogTitle>
          <DialogContent>
            <Text size={200} className={mergeClasses(s.muted, ls.blockMb10)}>
              What happens to a call in this queue - overflow, timeout and no-agent routing, as currently configured here - not yet deployed.
            </Text>
            <CallFlowDiagram graph={graph} exportFilename={`call-flow-${String(row.name)}`} />
          </DialogContent>
          <DialogActions>
            <Button appearance="primary" onClick={onClose}>
              Close
            </Button>
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
}

/**
 * The "as-designed" call-flow diagram for one Auto Attendant - business
 * hours, after hours and holiday routing, built from Design & Build's
 * structured columns via buildAutoAttendantFlowGraphFromDesign, following
 * every menu option that transfers to another Auto Attendant and expanding
 * it too. Fetches the site's other Auto Attendants/Call Queues to do that
 * (and to label a target with its real name), plus the site's resource
 * accounts to tell which Auto Attendant is the "front door" (has a phone
 * number attached) - the counterpart to Discovery's own per-object "as-is"
 * diagram (LiveCallFlowDialog in Discovery.tsx), which reads live
 * tenant_objects directly instead.
 */
export function AutoAttendantFlowDialog({ tid, base, siteId, row, onClose }: { tid: string; base: string; siteId: string; row: Row; onClose: () => void }) {
  const ls = useLocalStyles();
  const s = useRecordStyles();
  const aaQ = useQuery({
    queryKey: ['auto-attendants', tid, siteId, 'call-flow'],
    queryFn: () => api<Paginated<Row>>(`${base}/auto-attendants?siteId=${siteId}&limit=500`),
  });
  const cqQ = useQuery({
    queryKey: ['call-queues', tid, siteId, 'call-flow'],
    queryFn: () => api<Paginated<Row>>(`${base}/call-queues?siteId=${siteId}&limit=500`),
  });
  const raQ = useQuery({
    queryKey: ['resource-accounts', tid, siteId, 'call-flow'],
    queryFn: () => api<Paginated<Row>>(`${base}/resource-accounts?siteId=${siteId}&limit=500`),
  });

  const hasPhoneNumberById = useMemo(() => {
    const m = new Map<string, boolean>();
    for (const r of raQ.data?.items ?? []) {
      const discoveryResourceAccountId = r.discovery_resource_account_id as string | null;
      if (!discoveryResourceAccountId) continue;
      m.set(discoveryResourceAccountId, !!(r.phone_number_id || r.phone_number));
    }
    return m;
  }, [raQ.data]);

  // Each resource account by its Design & Build row id (what an attendant's resource_accounts hold), for the front door's name and number.
  const resourceAccountById = useMemo(() => {
    const m = new Map<string, CallFlowResourceAccount>();
    for (const r of raQ.data?.items ?? []) {
      m.set(String(r.id), {
        name: (r.display_name as string | null) ?? (r.name as string | null) ?? null,
        upn: (r.upn as string | null) ?? null,
        number: (r.phone_number as string | null) ?? (r.e164 as string | null) ?? null,
      });
    }
    return m;
  }, [raQ.data]);

  // A menu option can transfer to a voice app that is in Teams but not on this site (kept by its Teams id). Drawing it, with its agents and
  // routing, needs the discovered data, so that is only fetched when some option does.
  const needsLive = useMemo(() => JSON.stringify(aaQ.data?.items ?? []).includes('"liveId"') || JSON.stringify(row).includes('"liveId"'), [aaQ.data, row]);
  const discoveryBase = `/t/${tid}/tenant-discovery`;
  const liveAaQ = useQuery({ queryKey: ['tdisc', 'callflow-aa-all', discoveryBase], queryFn: () => fetchAllPages<TenantObject>(`${discoveryBase}/objects?type=auto_attendant`), enabled: needsLive });
  const liveCqQ = useQuery({ queryKey: ['tdisc', 'callflow-cq-all', discoveryBase], queryFn: () => fetchAllPages<TenantObject>(`${discoveryBase}/objects?type=call_queue`), enabled: needsLive });
  const liveSchedQ = useQuery({ queryKey: ['tdisc', 'callflow-sched-all', discoveryBase], queryFn: () => fetchAllPages<TenantObject>(`${discoveryBase}/objects?type=schedule`), enabled: needsLive });
  const liveUsersQ = useQuery({ queryKey: ['tdisc', 'callflow-users-all', discoveryBase], queryFn: () => fetchAllPages<TenantUserSummary>(`${discoveryBase}/users?`), enabled: needsLive });
  const liveLoading = needsLive && (liveAaQ.isLoading || liveCqQ.isLoading || liveSchedQ.isLoading || liveUsersQ.isLoading);
  const live = useMemo<LiveVoiceApps | undefined>(() => {
    if (!needsLive || !liveAaQ.data || !liveCqQ.data || !liveSchedQ.data) return undefined;
    return {
      autoAttendants: liveAaQ.data.items.map((o) => ({ name: o.display_name ?? o.object_key, data: o.data })),
      callQueues: liveCqQ.data.items.map((o) => ({ name: o.display_name ?? o.object_key, data: o.data })),
      schedules: liveSchedQ.data.items.map((o) => ({ key: o.object_key, data: o.data })),
      usersByEntraId: new Map((liveUsersQ.data?.items ?? []).filter((u) => u.entra_id).map((u) => [u.entra_id!.toLowerCase(), u.upn])),
    };
  }, [needsLive, liveAaQ.data, liveCqQ.data, liveSchedQ.data, liveUsersQ.data]);

  const graph = useMemo(() => {
    if (!aaQ.data || !cqQ.data) return null;
    return buildAutoAttendantFlowGraphFromDesign(
      toDesignAaInput(row, hasPhoneNumberById, resourceAccountById),
      aaQ.data.items.map((r) => toDesignAaInput(r, hasPhoneNumberById, resourceAccountById)),
      cqQ.data.items.map(toDesignCqInput),
      live,
    );
  }, [aaQ.data, cqQ.data, row, hasPhoneNumberById, resourceAccountById, live]);

  return (
    <Dialog open onOpenChange={(_, d) => !d.open && onClose()}>
      <DialogSurface className={ls.w95vwMaxW95vw}>
        <DialogBody>
          <DialogTitle>Call flow: {String(row.name)}</DialogTitle>
          <DialogContent>
            <Text size={200} className={mergeClasses(s.muted, ls.blockMb10)}>
              Business hours, after hours and holiday routing, as currently configured here - not yet deployed - including every Auto Attendant a menu
              option hands off to, followed all the way through. "Front door" marks an Auto Attendant with a phone number attached.
            </Text>
            {aaQ.isLoading || cqQ.isLoading || raQ.isLoading || liveLoading ? (
              <Spinner size="tiny" label="Loading…" />
            ) : aaQ.isError || cqQ.isError || raQ.isError ? (
              <LoadError message={((aaQ.error ?? cqQ.error ?? raQ.error) as Error).message} />
            ) : !graph || graph.nodes.length === 0 ? (
              <Text size={200} className={s.muted}>
                Nothing to draw yet - configure a business hours menu first.
              </Text>
            ) : (
              <CallFlowDiagram graph={graph} exportFilename={`call-flow-${String(row.name)}`} />
            )}
          </DialogContent>
          <DialogActions>
            <Button appearance="primary" onClick={onClose}>
              Close
            </Button>
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
}
