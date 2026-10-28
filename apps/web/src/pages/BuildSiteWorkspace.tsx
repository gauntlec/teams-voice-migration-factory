import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useParams, useSearchParams } from 'react-router';
import { Badge, Button, Card, Dialog, DialogActions, DialogBody, DialogContent, DialogSurface, DialogTitle, DialogTrigger, Spinner, Tab, TabList, Text, tokens , makeStyles } from '@fluentui/react-components';
import { ArrowLeftRegular } from '@fluentui/react-icons';
import { CALL_QUEUE_ROUTING_METHODS, NUMBER_TYPES, POLICY_KIND_GROUPS, POLICY_KIND_TO_TENANT_TYPE, POLICY_KINDS, RESOURCE_ACCOUNT_KINDS, type AutoAttendantCallFlow, type BuildIssueRow, type BuildRowValidation, type BuildSiteRollup, type CallQueueActionSettings, type FileRow, type Paginated, type TenantPolicySummary } from '@tvmf/shared';
import { api, apiDownload, ApiError } from '../api';
import { useAuth } from '../auth';
import { Page } from '../components/Page';
import { BulkEditDialog, LoadError, NoTenant, PagedSection, useRecordStyles, type Choice, type FieldDef, type Row } from '../components/records';
import { numKey, AA_TIME_ZONE_CHOICES, AA_LANGUAGE_CHOICES, withSrTags, BUILD_TABS, callingSettingsSummary, ValidationBadge, type BuildEmbedding, type BuildTab } from './build/buildShared';
import { EmbeddedShell, LinkDiscoveredResourceAccountDialog } from './build/buildDialogs';
import { bulkIdentityFields, identityFields, policyColumns } from './build/buildFields';
import { ValidationIssuesTab } from './build/issuesTab';
import { QuickAddDialog } from './build/quickAddDialog';
import { AutoAttendantFlowDialog, CallQueueFlowDialog } from './build/flowDialogs';
import { CallingPolicyMapDialog, CallingSettingsDialog } from './build/callingDialogs';
import { TemplatesDialog } from './build/templatesDialog';
import { CallQueueSettingsDialog } from './build/callQueueSettingsDialog';
import { AutoAttendantSettingsDialog } from './build/autoAttendantDialogs';
import { DangerText } from '../components/ui';
import { RefreshFromTeamsButton } from './build/refreshFromTeams';
import { AccessDialog } from './build/accessDialog';

const useLocalStyles = makeStyles({
  mt8: { marginTop: '8px' },
  ml6: { marginLeft: '6px' },
  mt8Danger: { marginTop: '8px', color: tokens.colorPaletteRedForeground1 },
});


export function BuildSiteWorkspace({ embedded }: { embedded?: BuildEmbedding } = {}) {
  const ls = useLocalStyles();
  const s = useRecordStyles();
  const params = useParams();
  const siteId = embedded?.siteId ?? params.siteId ?? '';
  const { activeTenantId, can } = useAuth();
  const qc = useQueryClient();
  // ?tab=call-queues etc. opens straight on that tab (e.g. from a service
  // request's "Created draft rows in Design & Build" link).
  const [searchParams] = useSearchParams();
  const [tab, setTab] = useState<BuildTab>(() => {
    if (embedded?.tab) return embedded.tab;
    const requested = searchParams.get('tab');
    return BUILD_TABS.includes(requested as BuildTab) ? (requested as BuildTab) : 'users';
  });

  const tid = activeTenantId;
  const base = `/t/${tid}/build`;
  const canWrite = can('build:write') && (!embedded || embedded.editable);
  // Site-wide tools (populate, reset, bulk edit, templates, account requests)
  // act on every row of the site, so they're left to the site's own page.
  const siteTools = canWrite && !embedded;
  // Lists: the whole site, or only a service request's rows.
  const listParams = { siteId, serviceRequestId: embedded?.requestId };

  const rollup = useQuery({
    queryKey: ['build-summary', tid],
    enabled: !!tid,
    queryFn: () => api<BuildSiteRollup[]>(`${base}/summary`),
  });

  // Available numbers for this site's phone-number pickers - same inventory Data
  // Collection uses (phone_numbers is tenant-wide, shared across both modules).
  const avail = useQuery({
    queryKey: ['build-avail-numbers', tid, siteId],
    enabled: !!tid,
    queryFn: () =>
      api<Paginated<{ id: string; e164: string }>>(
        `/t/${tid}/discovery/numbers?siteId=${siteId}&status=available&limit=200`,
      ),
  });
  const availableChoices: Choice[] = useMemo(
    () => (avail.data?.items ?? []).map((n) => ({ value: n.id, label: n.e164 })),
    [avail.data],
  );

  const numberChoicesFor = (row: Row | null): Choice[] => {
    const cur =
      row && row.phone_number_id
        ? [{ value: String(row.phone_number_id), label: `${row.e164 ?? row.phone_number} (current)` }]
        : [];
    // Users only: flag the choice that matches what the customer asked for
    // in Data Collection (discovery_users.requested_number), so it's easy to
    // spot and pick - never auto-selected.
    const requested = row?.requested_number ? String(row.requested_number) : null;
    const rest = availableChoices.map((c) =>
      requested && numKey(c.label) === numKey(requested) ? { ...c, label: `${c.label} (requested)` } : c,
    );
    return [...cur, ...rest];
  };

  // This site's resource accounts, for the Shared calling tab's -ResourceAccount picker.
  const sharedCallingRaQ = useQuery({
    queryKey: ['resource-accounts', tid, siteId, 'shared-calling'],
    enabled: !!tid,
    queryFn: () => api<Paginated<Row>>(`${base}/resource-accounts?siteId=${siteId}&limit=500`),
  });
  const resourceAccountChoices: Choice[] = useMemo(
    () => (sharedCallingRaQ.data?.items ?? []).map((r) => ({ value: r.id, label: String(r.display_name ?? r.upn) })),
    [sharedCallingRaQ.data],
  );

  // Every target policy is a live-tenant-name picker, not free text - sourced
  // from what Discovery actually found. Fetched in pages (the endpoint caps
  // `limit` at 200) and bucketed by type client-side - cheaper than 12
  // separate per-type requests, and correct for tenants with 200+ policies.
  const allPoliciesQ = useQuery({
    queryKey: ['build-all-policies', tid],
    enabled: !!tid,
    queryFn: async () => {
      const items: TenantPolicySummary[] = [];
      for (let page = 1; page <= 50; page++) {
        const res = await api<Paginated<TenantPolicySummary>>(
          `/t/${tid}/tenant-discovery/policies?limit=200&page=${page}`,
        );
        items.push(...res.items);
        if (items.length >= res.total || res.items.length === 0) break;
      }
      return items;
    },
  });
  const policyChoicesByKey = useMemo(() => {
    const byType = new Map<string, Choice[]>();
    for (const p of allPoliciesQ.data ?? []) {
      if (!byType.has(p.policy_type)) byType.set(p.policy_type, []);
      byType.get(p.policy_type)!.push({ value: p.id, label: p.is_global ? `${p.name} (global)` : p.name });
    }
    const out: Record<string, Choice[]> = {};
    for (const k of POLICY_KINDS) {
      const tenantType = POLICY_KIND_TO_TENANT_TYPE[k.key];
      out[k.key] = tenantType ? (byType.get(tenantType) ?? []) : [];
    }
    return out;
  }, [allPoliciesQ.data]);

  // Every validation issue on the site, for the Validation issues tab and the count on its label.
  const issuesQ = useQuery({
    queryKey: ['build-issues', tid, siteId],
    enabled: !!tid && !embedded,
    queryFn: () => api<BuildIssueRow[]>(`${base}/issues?siteId=${siteId}`),
  });
  // The list must follow the data: any change made on this page (a row added, edited or deleted, a template applied, a populate)
  // recalculates the issues straight away, and opening the tab always shows a fresh result.
  useEffect(() => {
    if (embedded || !tid) return;
    return qc.getMutationCache().subscribe((event) => {
      if (event.type === 'updated' && event.action.type === 'success') {
        qc.invalidateQueries({ queryKey: ['build-issues', tid, siteId] });
        qc.invalidateQueries({ queryKey: ['build-summary', tid] });
      }
    });
  }, [qc, tid, siteId, embedded]);
  // Changing tab also recalculates (not only opening the issues tab), so the count on its label is right wherever you are and an
  // edit made in a dialog that does not go through the list's own save still shows up. No page refresh is ever needed.
  useEffect(() => {
    if (!embedded && tid) void qc.invalidateQueries({ queryKey: ['build-issues', tid, siteId] });
  }, [tab, qc, tid, siteId, embedded]);
  const decideNumber = useMutation({
    mutationFn: (v: { row: BuildIssueRow; decision: 'accepted' | 'rejected' | 'reset' }) =>
      api(`${base}/${v.row.sheet}/${v.row.rowId}/number-decision`, { method: 'POST', body: JSON.stringify({ decision: v.decision }) }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['build-issues', tid, siteId] });
      qc.invalidateQueries({ queryKey: ['users', tid, siteId] });
      qc.invalidateQueries({ queryKey: ['caps', tid, siteId] });
      qc.invalidateQueries({ queryKey: ['build-summary', tid] });
    },
  });
  const blockingCount = (issuesQ.data ?? []).filter((i) => i.issue.severity === 'blocking').length;
  // The tab's count is what needs the engineer: not the settings that will simply change, nor decided number changes.
  const attentionCount = (issuesQ.data ?? []).filter((i) => i.issue.severity !== 'info').length;

  const [quickAdd, setQuickAdd] = useState<'users' | 'caps' | null>(null);
  const [populateError, setPopulateError] = useState<string | null>(null);
  const [voiceMessage, setVoiceMessage] = useState<string | null>(null);
  // Starts empty rows from what the sync read from Teams: call forwarding, delegates, call group and voicemail.
  const importVoice = useMutation({
    mutationFn: (kind: 'users' | 'caps') => api<{ updated: number; rows: number; notRead: number }>(`${base}/${kind}/import-voice-settings`, { method: 'POST', body: JSON.stringify({ site_id: siteId }) }),
    onSuccess: (r, kind) => {
      setPopulateError(null);
      setVoiceMessage(
        `${r.updated} of ${r.rows} row${r.rows === 1 ? '' : 's'} started from Teams voice settings.` +
          (r.notRead ? ` ${r.notRead} not read from Teams yet (not voice-enabled, or no sync since they were added) - run a Discovery sync.` : ''),
      );
      qc.invalidateQueries({ queryKey: [kind, tid, siteId] });
    },
    onError: (e) => {
      setVoiceMessage(null);
      setPopulateError(e instanceof ApiError ? e.message : 'Import failed');
    },
  });
  const populate = useMutation({
    mutationFn: (kind: 'users' | 'caps' | 'resource-accounts') =>
      api(`${base}/${kind}/populate`, { method: 'POST', body: JSON.stringify({ site_id: siteId }) }),
    onSuccess: () => {
      setPopulateError(null);
      qc.invalidateQueries({ queryKey: ['users', tid, siteId] });
      qc.invalidateQueries({ queryKey: ['caps', tid, siteId] });
      qc.invalidateQueries({ queryKey: ['resource-accounts', tid, siteId] });
      qc.invalidateQueries({ queryKey: ['call-queues', tid, siteId] });
      qc.invalidateQueries({ queryKey: ['auto-attendants', tid, siteId] });
      qc.invalidateQueries({ queryKey: ['build-summary', tid] });
    },
    // Most commonly assertCallingPoliciesMapped - some calling policies used
    // on this site aren't mapped to a real tenant policy yet (see the
    // Calling policy map panel below).
    onError: (e) => setPopulateError(e instanceof ApiError ? e.message : 'Populate failed'),
  });
  // The "Resource Account Request" document: generates a customer-facing
  // request for every not-yet-created resource account on this site and
  // stamps requested_at on them - see BuildService.generateResourceAccountRequestDocument.
  const [requestedFile, setRequestedFile] = useState<FileRow | null>(null);
  const requestAccounts = useMutation({
    mutationFn: () => api<FileRow>(`${base}/resource-accounts/request-document`, { method: 'POST', body: JSON.stringify({ site_id: siteId }) }),
    onSuccess: (file) => {
      setRequestedFile(file);
      qc.invalidateQueries({ queryKey: ['resource-accounts', tid, siteId] });
    },
  });
  // "Link discovered resource account" - pulls one specific live resource
  // account straight into this site without visiting Data Collection first
  // (BuildService.importAndLinkResourceAccount).
  const [linkOpen, setLinkOpen] = useState(false);
  const [validateMsg, setValidateMsg] = useState<string | null>(null);
  // Set when validate() found rows with no stored tenant match and a live
  // connection could check them - polled until the targeted check
  // (tenant_discovery_runs, scope_types: ['user']) finishes, then we
  // re-validate once (live: false) to pick up whatever it found.
  const [liveRunId, setLiveRunId] = useState<string | null>(null);
  const validate = useMutation({
    mutationFn: (opts?: { live?: boolean }) =>
      api<{ rows: number; issues: number; liveCheck: { runId: string } | null }>(`${base}/validate`, {
        method: 'POST',
        body: JSON.stringify({ site_id: siteId, live: opts?.live }),
      }),
    onSuccess: (r) => {
      qc.invalidateQueries({ queryKey: ['users', tid, siteId] });
      qc.invalidateQueries({ queryKey: ['caps', tid, siteId] });
      qc.invalidateQueries({ queryKey: ['build-issues', tid, siteId] });
      qc.invalidateQueries({ queryKey: ['build-summary', tid] });
      if (r.liveCheck) {
        setLiveRunId(r.liveCheck.runId);
        setValidateMsg(`Checked ${r.rows} row(s) — ${r.issues} issue(s). Checking unmatched users live against the tenant…`);
      } else {
        setValidateMsg(`Checked ${r.rows} row(s) — ${r.issues} issue(s).`);
      }
    },
    onError: (e) => setValidateMsg(e instanceof ApiError ? e.message : 'Validation failed'),
  });
  const liveRun = useQuery({
    queryKey: ['discovery-run', tid, liveRunId],
    enabled: !!liveRunId,
    refetchInterval: 3000,
    queryFn: () => api<{ status: string }>(`/t/${tid}/tenant-discovery/runs/${liveRunId}`),
  });
  useEffect(() => {
    if (liveRunId && liveRun.data && ['completed', 'failed'].includes(liveRun.data.status)) {
      setLiveRunId(null);
      validate.mutate({ live: false });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [liveRunId, liveRun.data]);

  const [resetOpen, setResetOpen] = useState(false);
  const [resetError, setResetError] = useState<string | null>(null);
  const reset = useMutation({
    mutationFn: () =>
      api<{ users: number; caps: number; resourceAccounts: number }>(`${base}/reset`, {
        method: 'POST',
        body: JSON.stringify({ site_id: siteId }),
      }),
    onSuccess: () => {
      setResetOpen(false);
      qc.invalidateQueries({ queryKey: ['users', tid, siteId] });
      qc.invalidateQueries({ queryKey: ['caps', tid, siteId] });
      qc.invalidateQueries({ queryKey: ['resource-accounts', tid, siteId] });
      // Reset deletes these too - without this the tabs keep showing them.
      qc.invalidateQueries({ queryKey: ['call-queues', tid, siteId] });
      qc.invalidateQueries({ queryKey: ['auto-attendants', tid, siteId] });
      qc.invalidateQueries({ queryKey: ['build-summary', tid] });
    },
    onError: (e) => setResetError(e instanceof ApiError ? e.message : 'Reset failed'),
  });

  // Bulk edit: select many rows (checkboxes, records.tsx), set a handful of
  // fields once in one dialog, apply to every selected row in a single
  // PATCH .../bulk request - see BuildService.bulkUpdateIdentity.
  const [usersSelected, setUsersSelected] = useState<Set<string>>(new Set());
  const [capsSelected, setCapsSelected] = useState<Set<string>>(new Set());
  const [bulkOpen, setBulkOpen] = useState<'users' | 'caps' | null>(null);
  const [bulkError, setBulkError] = useState<string | null>(null);
  const bulkSave = useMutation({
    mutationFn: ({ kind, ids, patch }: { kind: 'users' | 'caps'; ids: string[]; patch: Record<string, unknown> }) =>
      api<{ updated: number }>(`${base}/${kind}/bulk`, { method: 'PATCH', body: JSON.stringify({ ids, patch }) }),
    onSuccess: (_, vars) => {
      setBulkOpen(null);
      setBulkError(null);
      if (vars.kind === 'users') setUsersSelected(new Set());
      else setCapsSelected(new Set());
      qc.invalidateQueries({ queryKey: [vars.kind, tid, siteId] });
      qc.invalidateQueries({ queryKey: ['build-summary', tid] });
    },
    onError: (e) => setBulkError(e instanceof ApiError ? e.message : 'Bulk update failed'),
  });

  // Calling policy map + templates - see CallingPolicyMapDialog/TemplatesDialog below.
  const [mapOpen, setMapOpen] = useState(false);
  const [templatesOpen, setTemplatesOpen] = useState<'user' | 'cap' | null>(null);

  // Forwarding/delegates/pickup group - see CallingSettingsDialog below. Compound
  // JSON doesn't fit the generic FieldDef grid, so this is its own dialog.
  const [callingSettingsFor, setCallingSettingsFor] = useState<{
    endpoint: string;
    queryKey: unknown[];
    row: Row;
  } | null>(null);

  // Agents/overflow/timeout/linked resource accounts - see CallQueueSettingsDialog
  // below, same "compound JSON needs its own dialog" reasoning as above.
  const [callQueueSettingsFor, setCallQueueSettingsFor] = useState<Row | null>(null);

  // Operator/call-flow/schedule/holidays - see AutoAttendantSettingsDialog
  // below, same "compound JSON needs its own dialog" reasoning as above.
  const [aaSettingsFor, setAaSettingsFor] = useState<Row | null>(null);
  // Authorised users and the PowerShell-only settings - see AccessDialog.
  const [accessFor, setAccessFor] = useState<{ kind: 'auto_attendant' | 'call_queue'; row: Row } | null>(null);

  // Read-only call-flow diagrams - one Auto Attendant or Call Queue at a
  // time (see AutoAttendantFlowDialog/CallQueueFlowDialog below), not a
  // standing tab - a whole-site graph is too dense to read in one diagram.
  const [aaFlowFor, setAaFlowFor] = useState<Row | null>(null);
  const [cqFlowFor, setCqFlowFor] = useState<Row | null>(null);

  if (!tid) return <NoTenant />;
  if (rollup.isLoading) return <Spinner label="Loading site…" />;
  if (rollup.isError) return <LoadError message={(rollup.error as Error).message} />;

  const site = rollup.data?.find((r) => r.id === siteId);
  if (!site) return <LoadError message="Site not found." />;

  // Grouped (Calling, Routing and dialling, ...) so the 17 policies read as sections rather than one long list.
  const policyFields: FieldDef[] = POLICY_KIND_GROUPS.flatMap((g) =>
    POLICY_KINDS.filter((k) => k.group === g).map<FieldDef>((k) => ({
      key: `policy_ids.${k.key}`,
      label: k.label,
      type: 'ref',
      choices: policyChoicesByKey[k.key] ?? [],
      section: g,
    })),
  );

  // Embedded in a service request, the request page supplies the title.
  const Shell = embedded ? EmbeddedShell : Page;

  return (
    <Shell
      title={site.name || site.sitecode}
      subtitle={`Design & Build · ${site.sitecode}`}
      actions={
        <Link to="/build">
          <Button appearance="subtle" icon={<ArrowLeftRegular />}>
            All sites
          </Button>
        </Link>
      }
    >
      <div className={s.summary}>
        {!embedded && (
          <>
            <Text size={200}>
              Users: <b>{site.counts.users}</b>
            </Text>
            <Text size={200}>
              CAPs: <b>{site.counts.caps}</b>
            </Text>
            <Text size={200}>
              Resource accounts: <b>{site.counts.resourceAccounts}</b>
            </Text>
          </>
        )}
        {canWrite && (
          <Button size="small" disabled={validate.isPending} onClick={() => validate.mutate({})}>
            {validate.isPending ? 'Validating…' : 'Validate against tenant'}
          </Button>
        )}
        {canWrite && (
          <Button size="small" onClick={() => setMapOpen(true)}>
            Calling policy map
          </Button>
        )}
        {validateMsg && (
          <Text size={200} className={s.muted}>
            {validateMsg}
          </Text>
        )}
        {siteTools && (site.counts.users + site.counts.caps + site.counts.resourceAccounts) > 0 && (
          <Button
            size="small"
            appearance="subtle"
            onClick={() => {
              setResetError(null);
              setResetOpen(true);
            }}
          >
            Reset site…
          </Button>
        )}
      </div>
      {populateError && (
        <DangerText block>
          {populateError}
        </DangerText>
      )}
      {voiceMessage && (
        <Text size={200} block>
          {voiceMessage}
        </Text>
      )}

      <Dialog open={resetOpen} onOpenChange={(_, d) => setResetOpen(d.open)}>
        <DialogSurface>
          <DialogBody>
            <DialogTitle>Reset {site.name || site.sitecode}?</DialogTitle>
            <DialogContent>
              <Text block>
                This deletes all {site.counts.users} user{site.counts.users === 1 ? '' : 's'},{' '}
                {site.counts.caps} common area phone{site.counts.caps === 1 ? '' : 's'} and{' '}
                {site.counts.resourceAccounts} resource account{site.counts.resourceAccounts === 1 ? '' : 's'}{' '}
                designed for this site, <b>and every call queue and auto attendant</b> (with their agents, menus and
                schedules), and releases any numbers they hold back to the inventory. Data Collection is not
                affected - Populate from Discovery brings back what came from there, but anything designed by hand
                here is lost.
              </Text>
              <Text block weight="semibold" className={ls.mt8}>
                This cannot be undone.
              </Text>
              {resetError && (
                <Text block className={ls.mt8Danger}>
                  {resetError}
                </Text>
              )}
            </DialogContent>
            <DialogActions>
              <DialogTrigger disableButtonEnhancement>
                <Button appearance="secondary">Cancel</Button>
              </DialogTrigger>
              <Button appearance="primary" disabled={reset.isPending} onClick={() => reset.mutate()}>
                {reset.isPending ? 'Resetting…' : 'Reset site'}
              </Button>
            </DialogActions>
          </DialogBody>
        </DialogSurface>
      </Dialog>

      <BulkEditDialog
        open={bulkOpen !== null}
        onOpenChange={(o) => !o && setBulkOpen(null)}
        kindLabel={bulkOpen === 'caps' ? 'common area phones' : 'users'}
        fields={bulkIdentityFields(policyFields)}
        count={bulkOpen === 'caps' ? capsSelected.size : usersSelected.size}
        saving={bulkSave.isPending}
        error={bulkError}
        onSave={(patch) => {
          if (!bulkOpen) return;
          const ids = [...(bulkOpen === 'caps' ? capsSelected : usersSelected)];
          bulkSave.mutate({ kind: bulkOpen, ids, patch });
        }}
      />

      <CallingPolicyMapDialog
        open={mapOpen}
        onOpenChange={setMapOpen}
        base={base}
        siteId={siteId}
        callingPolicyChoices={policyChoicesByKey.voice_routing_policy ?? []}
      />
      {templatesOpen && (
        <TemplatesDialog
          open
          onOpenChange={(o) => !o && setTemplatesOpen(null)}
          base={base}
          siteId={siteId}
          kind={templatesOpen}
          kindLabel={templatesOpen === 'cap' ? 'common area phone' : 'user'}
          policyChoicesByKey={policyChoicesByKey}
          selectedIds={templatesOpen === 'cap' ? capsSelected : usersSelected}
          onApplied={() => {
            qc.invalidateQueries({ queryKey: [templatesOpen === 'cap' ? 'caps' : 'users', tid, siteId] });
            qc.invalidateQueries({ queryKey: ['build-summary', tid] });
          }}
        />
      )}
      {callingSettingsFor && tid && (
        <CallingSettingsDialog
          tenantId={tid}
          endpoint={callingSettingsFor.endpoint}
          row={callingSettingsFor.row}
          onClose={() => setCallingSettingsFor(null)}
          onSaved={() => {
            qc.invalidateQueries({ queryKey: callingSettingsFor.queryKey });
            embedded?.onChanged?.();
            setCallingSettingsFor(null);
          }}
        />
      )}
      {callQueueSettingsFor && tid && (
        <CallQueueSettingsDialog
          tenantId={tid}
          base={base}
          siteId={siteId}
          row={callQueueSettingsFor}
          onClose={() => setCallQueueSettingsFor(null)}
          onSaved={() => {
            qc.invalidateQueries({ queryKey: ['call-queues', tid, siteId] });
            setCallQueueSettingsFor(null);
            embedded?.onChanged?.();
          }}
        />
      )}
      {aaSettingsFor && tid && (
        <AutoAttendantSettingsDialog
          tenantId={tid}
          base={base}
          siteId={siteId}
          row={aaSettingsFor}
          onClose={() => setAaSettingsFor(null)}
          onSaved={() => {
            qc.invalidateQueries({ queryKey: ['auto-attendants', tid, siteId] });
            setAaSettingsFor(null);
            embedded?.onChanged?.();
          }}
        />
      )}
      {accessFor && tid && (
        <AccessDialog
          tenantId={tid}
          endpoint={`${base}/${accessFor.kind === 'auto_attendant' ? 'auto-attendants' : 'call-queues'}`}
          kind={accessFor.kind}
          row={accessFor.row}
          onClose={() => setAccessFor(null)}
          onSaved={() => {
            qc.invalidateQueries({ queryKey: [accessFor.kind === 'auto_attendant' ? 'auto-attendants' : 'call-queues', tid, siteId] });
            setAccessFor(null);
            embedded?.onChanged?.();
          }}
        />
      )}
      {aaFlowFor && tid && (
        <AutoAttendantFlowDialog tid={tid} base={base} siteId={siteId} row={aaFlowFor} onClose={() => setAaFlowFor(null)} />
      )}
      {cqFlowFor && <CallQueueFlowDialog row={cqFlowFor} onClose={() => setCqFlowFor(null)} />}

      {quickAdd && (
        <QuickAddDialog
          base={base}
          kind={quickAdd}
          siteId={siteId}
          onClose={() => setQuickAdd(null)}
          onDone={() => {
            qc.invalidateQueries({ queryKey: [quickAdd, tid, siteId] });
            qc.invalidateQueries({ queryKey: ['build-issues', tid, siteId] });
            qc.invalidateQueries({ queryKey: ['build-summary', tid] });
          }}
        />
      )}

      <TabList selectedValue={tab} onTabSelect={(_, d) => setTab(d.value as typeof tab)}>
        <Tab value="users">Users</Tab>
        <Tab value="caps">Common area phones</Tab>
        <Tab value="resource-accounts">Resource accounts</Tab>
        <Tab value="shared-calling-policies">Shared calling</Tab>
        <Tab value="call-queues">Call queues</Tab>
        <Tab value="auto-attendants">Auto attendants</Tab>
        {!embedded && (
          <Tab value="issues">
            Validation issues
            {attentionCount > 0 && (
              <Badge className={ls.ml6} size="small" appearance="tint" color={blockingCount > 0 ? 'danger' : 'warning'}>
                {attentionCount}
              </Badge>
            )}
          </Tab>
        )}
      </TabList>

      {tab === 'issues' && !embedded && (
        <ValidationIssuesTab
          issues={issuesQ.data}
          loading={issuesQ.isFetching}
          error={issuesQ.error}
          onRefresh={() => void issuesQ.refetch()}
          onOpen={setTab}
          canDecide={canWrite}
          onDecide={(row, decision) => decideNumber.mutate({ row, decision })}
          deciding={decideNumber.isPending}
        />
      )}

      {tab === 'users' && (
        <PagedSection
          fitScreen
          title="Users"
          hint="Teams users with Enterprise Voice - target numbers and policies for this site. Replaces the USERS build sheet."
          endpoint={`${base}/users`}
          queryKey={['users', tid, siteId]}
          params={listParams}
          fixed={{ site_id: siteId }}
          readOnly={!canWrite}
          onChanged={embedded?.onChanged}
          pageSize={500}
          selectable={siteTools}
          selected={usersSelected}
          onSelectedChange={setUsersSelected}
          headerActions={
            siteTools && (
              <>
                <Button size="small" onClick={() => setQuickAdd('users')}>
                  Quick add
                </Button>
                <Button size="small" disabled={populate.isPending} onClick={() => populate.mutate('users')}>
                  Populate from Discovery
                </Button>
                <Button size="small" disabled={importVoice.isPending} onClick={() => importVoice.mutate('users')}>
                  Import voice settings
                </Button>
                <Button size="small" disabled={usersSelected.size === 0} onClick={() => setBulkOpen('users')}>
                  Bulk edit ({usersSelected.size} selected)
                </Button>
                <Button size="small" onClick={() => setTemplatesOpen('user')}>
                  Templates
                </Button>
              </>
            )
          }
          columns={[
            withSrTags({ key: 'upn', label: 'UPN' }),
            { key: 'display_name', label: 'Name' },
            { key: 'e164', label: 'Number' },
            ...policyColumns(),
            {
              key: 'voicemail_target',
              label: 'Voicemail',
              render: (r) => {
                const vm = r.voicemail as { enabled?: boolean | null; language?: string | null } | null;
                if (vm?.enabled == null) return '—';
                return vm.enabled ? `On${vm.language ? ` (${vm.language})` : ''}` : 'Off';
              },
            },
            { key: 'migration_wave', label: 'Wave' },
            {
              key: 'calling_settings',
              label: 'Calling',
              // Read-only (no build:write, or a locked service request): the summary, not an editor.
              render: (r) =>
                canWrite ? (
                  <Button
                    size="small"
                    appearance="subtle"
                    onClick={() =>
                      setCallingSettingsFor({ endpoint: `${base}/users`, queryKey: ['users', tid, siteId], row: r })
                    }
                  >
                    {callingSettingsSummary(r)}
                  </Button>
                ) : (
                  callingSettingsSummary(r)
                ),
            },
            { key: 'validation', label: 'Validation', render: (r) => <ValidationBadge v={r.validation as BuildRowValidation | null} /> },
          ]}
          fields={identityFields(policyFields, numberChoicesFor)}
        />
      )}

      {tab === 'caps' && (
        <PagedSection
          fitScreen
          title="Common area phones"
          hint="Phones logged in permanently (lobbies, meeting rooms) - target numbers and policies. Replaces the CAPS build sheet."
          endpoint={`${base}/caps`}
          queryKey={['caps', tid, siteId]}
          params={listParams}
          fixed={{ site_id: siteId }}
          readOnly={!canWrite}
          onChanged={embedded?.onChanged}
          pageSize={500}
          selectable={siteTools}
          selected={capsSelected}
          onSelectedChange={setCapsSelected}
          headerActions={
            siteTools && (
              <>
                <Button size="small" onClick={() => setQuickAdd('caps')}>
                  Quick add
                </Button>
                <Button size="small" disabled={populate.isPending} onClick={() => populate.mutate('caps')}>
                  Populate from Discovery
                </Button>
                <Button size="small" disabled={importVoice.isPending} onClick={() => importVoice.mutate('caps')}>
                  Import voice settings
                </Button>
                <Button size="small" disabled={capsSelected.size === 0} onClick={() => setBulkOpen('caps')}>
                  Bulk edit ({capsSelected.size} selected)
                </Button>
                <Button size="small" onClick={() => setTemplatesOpen('cap')}>
                  Templates
                </Button>
              </>
            )
          }
          columns={[
            withSrTags({ key: 'upn', label: 'UPN' }),
            { key: 'display_name', label: 'Name' },
            { key: 'e164', label: 'Number' },
            { key: 'phone_model', label: 'Model' },
            ...policyColumns(),
            {
              key: 'calling_settings',
              label: 'Calling',
              // Read-only (no build:write, or a locked service request): the summary, not an editor.
              render: (r) =>
                canWrite ? (
                  <Button
                    size="small"
                    appearance="subtle"
                    onClick={() =>
                      setCallingSettingsFor({ endpoint: `${base}/caps`, queryKey: ['caps', tid, siteId], row: r })
                    }
                  >
                    {callingSettingsSummary(r)}
                  </Button>
                ) : (
                  callingSettingsSummary(r)
                ),
            },
            { key: 'validation', label: 'Validation', render: (r) => <ValidationBadge v={r.validation as BuildRowValidation | null} /> },
          ]}
          fields={[
            ...identityFields(policyFields, numberChoicesFor),
            { key: 'display_name', label: 'Display name' },
            { key: 'phone_model', label: 'Phone model' },
            { key: 'device_config_profile', label: 'Device config profile' },
            { key: 'mac_address', label: 'MAC address' },
            { key: 'serial_number', label: 'Serial number' },
            { key: 'phone_location', label: 'Location in office' },
            { key: 'lan_jack', label: 'LAN jack socket ID' },
          ]}
        />
      )}

      {tab === 'resource-accounts' && (
        <PagedSection
          fitScreen
          title="Resource accounts"
          hint="Identity + number for Auto Attendant / Call Queue resource accounts. Model a new one before it exists live, then use Request accounts below to ask the customer to create and license it - see the note below."
          endpoint={`${base}/resource-accounts`}
          queryKey={['resource-accounts', tid, siteId]}
          params={listParams}
          fixed={{ site_id: siteId }}
          readOnly={!canWrite}
          onChanged={embedded?.onChanged}
          headerActions={
            siteTools && (
              <>
                <Button size="small" disabled={populate.isPending} onClick={() => populate.mutate('resource-accounts')}>
                  Populate from Discovery
                </Button>
                <Button size="small" disabled={requestAccounts.isPending} onClick={() => requestAccounts.mutate()}>
                  {requestAccounts.isPending ? 'Generating…' : 'Request accounts'}
                </Button>
                <Button size="small" onClick={() => setLinkOpen(true)}>
                  Link discovered resource account…
                </Button>
                {requestedFile && (
                  <Button
                    size="small"
                    appearance="subtle"
                    onClick={() => apiDownload(`/t/${tid}/files/${requestedFile.id}/download`, requestedFile.filename)}
                  >
                    Download request
                  </Button>
                )}
              </>
            )
          }
          emptyText="No resource accounts yet."
          columns={[
            withSrTags({ key: 'display_name', label: 'Name' }),
            { key: 'kind', label: 'Kind' },
            { key: 'upn', label: 'UPN' },
            { key: 'phone_number', label: 'Number' },
            {
              key: 'application_id',
              label: 'Status',
              render: (r) =>
                r.application_id ? (
                  <Badge appearance="tint" color="success">
                    created &amp; licensed
                  </Badge>
                ) : r.requested_at ? (
                  <Badge appearance="tint" color="warning">
                    requested {new Date(String(r.requested_at)).toLocaleDateString()}
                  </Badge>
                ) : (
                  <Badge appearance="tint" color="informative">
                    designed
                  </Badge>
                ),
            },
          ]}
          fields={[
            { key: 'display_name', label: 'Name', required: true },
            { key: 'kind', label: 'Kind', type: 'select', options: RESOURCE_ACCOUNT_KINDS, required: true },
            { key: 'upn', label: 'Resource account UPN', placeholder: 'aa-reception@customer.com' },
            { key: 'phone_number_id', label: 'Phone number', type: 'ref', choices: numberChoicesFor },
            { key: 'number_type', label: 'Number type', type: 'select', options: NUMBER_TYPES },
            { key: 'location_id', label: 'Emergency location ID (for shared calling)' },
            {
              key: 'voice_routing_policy_id',
              label: 'Voice routing policy',
              type: 'ref',
              choices: policyChoicesByKey.voice_routing_policy ?? [],
            },
            {
              key: 'created',
              label: 'Created & licensed (run the generated script first, then check this)',
              type: 'boolean',
            },
          ]}
        />
      )}
      {linkOpen && (
        <LinkDiscoveredResourceAccountDialog
          tid={tid}
          siteId={siteId}
          onClose={() => setLinkOpen(false)}
          onDone={() => {
            setLinkOpen(false);
            qc.invalidateQueries({ queryKey: ['resource-accounts', tid, siteId] });
            qc.invalidateQueries({ queryKey: ['call-queues', tid, siteId] });
            qc.invalidateQueries({ queryKey: ['auto-attendants', tid, siteId] });
            qc.invalidateQueries({ queryKey: ['build-summary', tid] });
          }}
        />
      )}
      {tab === 'resource-accounts' && (
        <Card className={s.card}>
          <Text size={200} className={s.muted}>
            New-CsOnlineApplicationInstance always needs a Phone System license applied by a
            User/Global Admin - a role a Teams Administrator doesn't have. Model the account here
            first (name, phone number, and an Auto Attendant/Call Queue linked to it - all before
            it exists live), then click "Request accounts" to generate a document for the
            customer listing what to create and license. Once it's live, the next Discovery sync
            detects it automatically and moves the row to "created &amp; licensed" - no manual
            step needed. The toggle in the edit dialog is a fallback for when the account was
            already created before a formal request, or you want to unblock a row immediately.
          </Text>
        </Card>
      )}

      {tab === 'shared-calling-policies' && (
        <PagedSection
          fitScreen
          title="Shared calling policies"
          hint="Manage the TeamsSharedCallingRoutingPolicy objects themselves - name, resource account (used as outbound/callback caller ID), and emergency callback numbers. Grant an existing policy to a user on the Users/CAPs tab's Policies field."
          endpoint={`${base}/shared-calling-policies`}
          queryKey={['shared-calling-policies', tid, siteId]}
          params={listParams}
          fixed={{ site_id: siteId }}
          readOnly={!canWrite}
          onChanged={embedded?.onChanged}
          emptyText="No Shared Calling policies yet."
          columns={[
            withSrTags({ key: 'name', label: 'Name' }),
            {
              key: 'resource_account_id',
              label: 'Resource account',
              render: (r) => resourceAccountChoices.find((c) => c.value === r.resource_account_id)?.label ?? '—',
            },
            {
              key: 'emergency_numbers',
              label: 'Emergency numbers',
              render: (r) => ((r.emergency_numbers as string[] | null)?.length ?? 0) + ' set',
            },
          ]}
          fields={[
            { key: 'name', label: 'Name', required: true },
            { key: 'resource_account_id', label: 'Resource account', type: 'ref', choices: resourceAccountChoices },
            { key: 'emergency_numbers', label: 'Emergency numbers (one per line)', type: 'string-array', full: true, placeholder: '+14255556677' },
            { key: 'description', label: 'Description' },
          ]}
        />
      )}
      {tab === 'shared-calling-policies' && (
        <Card className={s.card}>
          <Text size={200} className={s.muted}>
            Per Microsoft's Shared Calling setup guide, a user granted a Shared Calling policy
            must not also have a phone number assigned - Design & Build already enforces this on
            the Users/CAPs tabs by disabling the Number fields once a Shared Calling Policy is
            set there. The linked resource account's phone number must have an emergency location
            assigned (see the Resource accounts tab's "Emergency location ID" field), and the
            emergency numbers here must be the same number type/country as it.
          </Text>
        </Card>
      )}

      {tab === 'call-queues' && (
        <PagedSection
          fitScreen
          title="Call queues"
          hint="Routing, agents and overflow/timeout behaviour for Call Queue resource accounts. New rows are seeded by Populate from Discovery on the Resource accounts tab."
          endpoint={`${base}/call-queues`}
          queryKey={['call-queues', tid, siteId]}
          params={listParams}
          fixed={{ site_id: siteId }}
          readOnly={!canWrite}
          onChanged={embedded?.onChanged}
          emptyText="No call queues yet - Populate from Discovery on the Resource accounts tab first."
          columns={[
            withSrTags({ key: 'name', label: 'Name' }),
            { key: 'routing_method', label: 'Routing' },
            { key: 'agent_alert_time', label: 'Alert (s)' },
            {
              key: 'agents',
              label: 'Agents',
              render: (r) => (Array.isArray(r.agents) ? (r.agents as string[]).length : 0),
            },
            {
              key: 'overflow',
              label: 'Overflow',
              render: (r) => (r.overflow as CallQueueActionSettings | null)?.action ?? '—',
            },
            {
              key: 'timeout',
              label: 'Timeout',
              render: (r) => (r.timeout as CallQueueActionSettings | null)?.action ?? '—',
            },
            {
              key: 'no_agent_action',
              label: 'No agents',
              render: (r) => (r.no_agent_action as CallQueueActionSettings | null)?.action ?? '—',
            },
            {
              key: 'settings',
              label: 'Agents / overflow / timeout',
              render: (r) =>
                canWrite ? (
                  <Button size="small" appearance="subtle" onClick={() => setCallQueueSettingsFor(r)}>
                    Configure…
                  </Button>
                ) : (
                  '—'
                ),
            },
            {
              key: 'access',
              label: 'Access',
              render: (r) =>
                canWrite ? (
                  <Button size="small" appearance="subtle" onClick={() => setAccessFor({ kind: 'call_queue', row: r })}>
                    {Array.isArray(r.authorized_users) ? `${(r.authorized_users as unknown[]).length} authorised` : 'Access…'}
                  </Button>
                ) : (
                  '—'
                ),
            },
            {
              key: 'call_flow',
              label: 'Call flow',
              render: (r) => (
                <Button size="small" appearance="subtle" onClick={() => setCqFlowFor(r)}>
                  View diagram
                </Button>
              ),
            },
            {
              key: 'refresh',
              label: 'From Teams',
              render: (r) =>
                canWrite ? (
                  <RefreshFromTeamsButton
                    base={base}
                    kind="call-queues"
                    row={r as { id: string; name: string; discovery_voice_app_id?: string | null }}
                    onDone={() => {
                      qc.invalidateQueries({ queryKey: ['call-queues', tid, siteId] });
                      qc.invalidateQueries({ queryKey: ['build-issues', tid, siteId] });
                    }}
                  />
                ) : (
                  '—'
                ),
            },
          ]}
          fields={[
            { key: 'name', label: 'Name', required: true },
            { key: 'routing_method', label: 'Routing method', type: 'select', options: CALL_QUEUE_ROUTING_METHODS },
            { key: 'agent_alert_time', label: 'Agent alert time (seconds, 15-180)', type: 'number' },
            { key: 'presence_based_routing', label: 'Presence-based routing', type: 'boolean' },
            { key: 'language_id', label: 'Language ID (required if overflow/timeout/no-agent uses Shared Voicemail)' },
            { key: 'notes', label: 'Notes', type: 'textarea', full: true },
          ]}
        />
      )}

      {tab === 'auto-attendants' && (
        <PagedSection
          fitScreen
          title="Auto attendants"
          hint="Language/voice and the real call-flow menu (business hours, after hours, holidays) for Auto Attendant resource accounts. Populate from Discovery pre-fills these from a live tenant; for a greenfield site, add one by hand and link resource accounts to it in Configure… - it just won't get a phone number until that account is created and licensed."
          endpoint={`${base}/auto-attendants`}
          queryKey={['auto-attendants', tid, siteId]}
          params={listParams}
          fixed={{ site_id: siteId }}
          readOnly={!canWrite}
          onChanged={embedded?.onChanged}
          emptyText="No auto attendants yet - add one, or Populate from Discovery on the Resource accounts tab."
          columns={[
            withSrTags({ key: 'name', label: 'Name' }),
            { key: 'language_id', label: 'Language' },
            { key: 'time_zone_id', label: 'Time zone' },
            { key: 'voice_id', label: 'Voice' },
            {
              key: 'default_call_flow',
              label: 'Business hours menu',
              render: (r) => {
                const cf = r.default_call_flow as AutoAttendantCallFlow | null;
                return cf ? `${cf.menu.options.length} option${cf.menu.options.length === 1 ? '' : 's'}` : '—';
              },
            },
            {
              key: 'after_hours',
              label: 'After hours',
              render: (r) => (r.after_hours_call_flow ? 'Configured' : '—'),
            },
            {
              key: 'holidays',
              label: 'Holidays',
              render: (r) => (Array.isArray(r.holiday_call_flows) ? (r.holiday_call_flows as unknown[]).length : 0),
            },
            {
              key: 'settings',
              label: 'Menu editor',
              render: (r) =>
                canWrite ? (
                  <Button size="small" appearance="subtle" onClick={() => setAaSettingsFor(r)}>
                    Configure…
                  </Button>
                ) : (
                  '—'
                ),
            },
            {
              key: 'access',
              label: 'Access',
              render: (r) =>
                canWrite ? (
                  <Button size="small" appearance="subtle" onClick={() => setAccessFor({ kind: 'auto_attendant', row: r })}>
                    {Array.isArray(r.authorized_users) ? `${(r.authorized_users as unknown[]).length} authorised` : 'Access…'}
                  </Button>
                ) : (
                  '—'
                ),
            },
            {
              key: 'call_flow',
              label: 'Call flow',
              render: (r) => (
                <Button size="small" appearance="subtle" onClick={() => setAaFlowFor(r)}>
                  View diagram
                </Button>
              ),
            },
            {
              key: 'refresh',
              label: 'From Teams',
              render: (r) =>
                canWrite ? (
                  <RefreshFromTeamsButton
                    base={base}
                    kind="auto-attendants"
                    row={r as { id: string; name: string; discovery_voice_app_id?: string | null }}
                    onDone={() => {
                      qc.invalidateQueries({ queryKey: ['auto-attendants', tid, siteId] });
                      qc.invalidateQueries({ queryKey: ['build-issues', tid, siteId] });
                    }}
                  />
                ) : (
                  '—'
                ),
            },
          ]}
          fields={[
            { key: 'name', label: 'Name', required: true },
            { key: 'language_id', label: 'Language', type: 'ref', choices: AA_LANGUAGE_CHOICES },
            { key: 'time_zone_id', label: 'Time zone', type: 'ref', choices: AA_TIME_ZONE_CHOICES },
            { key: 'voice_id', label: 'Voice', type: 'radio', options: ['Male', 'Female'] },
            { key: 'voice_response_enabled', label: 'Enable voice response (speech input)', type: 'boolean' },
            { key: 'notes', label: 'Notes', type: 'textarea', full: true },
          ]}
        />
      )}

    </Shell>
  );
}

export type { BuildEmbedding, BuildTab } from './build/buildShared';
