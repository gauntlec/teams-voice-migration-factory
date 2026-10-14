import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Button, Dialog, DialogActions, DialogBody, DialogContent, DialogSurface, DialogTitle, Spinner, Text } from '@fluentui/react-components';
import { buildAutoAttendantFlowGraphFromDesign, buildCallQueueFlowGraphFromDesign, type AutoAttendantCallableEntity, type AutoAttendantCallFlow, type AutoAttendantHolidayCallFlow, type CallQueueActionSettings, type DesignAutoAttendantInput, type DesignCallQueueInput, type Paginated } from '@tvmf/shared';
import { api } from '../../api';
import { CallFlowDiagram } from '../../components/CallFlowDiagram';
import { LoadError, useRecordStyles, type Row } from '../../components/records';

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
function toDesignAaInput(r: Row, hasPhoneNumberById?: Map<string, boolean>): DesignAutoAttendantInput {
  const discoveryResourceAccountId = r.discovery_resource_account_id as string | null;
  return {
    buildId: String(r.id),
    name: String(r.name),
    operator: (r.operator as AutoAttendantCallableEntity | null) ?? null,
    defaultCallFlow: (r.default_call_flow as AutoAttendantCallFlow | null) ?? null,
    afterHoursCallFlow: (r.after_hours_call_flow as AutoAttendantCallFlow | null) ?? null,
    holidayCallFlows: Array.isArray(r.holiday_call_flows) ? (r.holiday_call_flows as AutoAttendantHolidayCallFlow[]) : [],
    hasPhoneNumber: discoveryResourceAccountId ? hasPhoneNumberById?.get(discoveryResourceAccountId) : undefined,
  };
}

/**
 * The "as-designed" call-flow diagram for one Call Queue - what happens on
 * Overflow/Timeout/No-agent, built from this row's own columns via
 * buildCallQueueFlowGraphFromDesign. No fetch needed - the row the "View
 * diagram" button was clicked from already carries everything.
 */
export function CallQueueFlowDialog({ row, onClose }: { row: Row; onClose: () => void }) {
  const s = useRecordStyles();
  const graph = useMemo(() => buildCallQueueFlowGraphFromDesign(toDesignCqInput(row)), [row]);

  return (
    <Dialog open onOpenChange={(_, d) => !d.open && onClose()}>
      <DialogSurface style={{ maxWidth: '95vw', width: '95vw' }}>
        <DialogBody>
          <DialogTitle>Call flow: {String(row.name)}</DialogTitle>
          <DialogContent>
            <Text size={200} className={s.muted} style={{ display: 'block', marginBottom: 10 }}>
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

  const graph = useMemo(() => {
    if (!aaQ.data || !cqQ.data) return null;
    return buildAutoAttendantFlowGraphFromDesign(
      toDesignAaInput(row, hasPhoneNumberById),
      aaQ.data.items.map((r) => toDesignAaInput(r, hasPhoneNumberById)),
      cqQ.data.items.map(toDesignCqInput),
    );
  }, [aaQ.data, cqQ.data, row, hasPhoneNumberById]);

  return (
    <Dialog open onOpenChange={(_, d) => !d.open && onClose()}>
      <DialogSurface style={{ maxWidth: '95vw', width: '95vw' }}>
        <DialogBody>
          <DialogTitle>Call flow: {String(row.name)}</DialogTitle>
          <DialogContent>
            <Text size={200} className={s.muted} style={{ display: 'block', marginBottom: 10 }}>
              Business hours, after hours and holiday routing, as currently configured here - not yet deployed - including every Auto Attendant a menu
              option hands off to, followed all the way through. "Front door" marks an Auto Attendant with a phone number attached.
            </Text>
            {aaQ.isLoading || cqQ.isLoading || raQ.isLoading ? (
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
