import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useParams } from 'react-router-dom';
import {
  Badge,
  Button,
  Card,
  Checkbox,
  Dialog,
  DialogActions,
  DialogBody,
  DialogContent,
  DialogSurface,
  DialogTitle,
  DialogTrigger,
  Dropdown,
  Field,
  Input,
  Option,
  Spinner,
  Tab,
  TabList,
  Text,
  Textarea,
  tokens,
} from '@fluentui/react-components';
import { ArrowLeftRegular, CheckmarkCircleRegular, DeleteRegular, WarningRegular } from '@fluentui/react-icons';
import {
  AA_CALLABLE_ENTITY_KINDS,
  AA_DIRECTORY_SEARCH_METHODS,
  AA_DTMF_RESPONSES,
  AA_MENU_OPTION_ACTIONS,
  AA_SCHEDULE_TYPES,
  AA_SUPPORTED_LANGUAGES,
  AA_TIME_ZONES,
  buildAutoAttendantFlowGraphFromDesign,
  buildCallQueueFlowGraphFromDesign,
  BUSY_ON_BUSY_OPTIONS,
  CALL_FORWARDING_TYPES,
  CALL_GROUP_ORDERS,
  CALL_QUEUE_NO_AGENT_ACTIONS,
  CALL_QUEUE_NO_AGENT_APPLY_TO,
  CALL_QUEUE_OVERFLOW_ACTIONS,
  CALL_QUEUE_ROUTING_METHODS,
  CALL_QUEUE_TIMEOUT_ACTIONS,
  CALL_TARGET_TYPES,
  NUMBER_TYPES,
  POLICY_KIND_TO_TENANT_TYPE,
  POLICY_KINDS,
  RESOURCE_ACCOUNT_KINDS,
  VOICEMAIL_PROMPT_LANGUAGES,
  type AutoAttendantCallableEntity,
  type AutoAttendantCallFlow,
  type AutoAttendantHolidayCallFlow,
  type AutoAttendantMenuOption,
  type AutoAttendantSchedule,
  type AutoAttendantTimeRange,
  type BuildRowValidation,
  type BuildSiteRollup,
  type CallDelegate,
  type CallForwardingSettings,
  type CallQueueActionSettings,
  type DesignAutoAttendantInput,
  type DesignCallQueueInput,
  type FileRow,
  type Paginated,
  type PickupGroupSettings,
  type PolicyKey,
  type TenantPolicySummary,
} from '@tvmf/shared';
import { api, apiDownload, ApiError } from '../api';
import { useAuth } from '../auth';
import { CallFlowDiagram } from '../components/CallFlowDiagram';
import { Page } from '../components/Page';
import { UpnAutocomplete } from '../components/UpnAutocomplete';
import {
  BulkEditDialog,
  LoadError,
  NoTenant,
  PagedSection,
  useRecordStyles,
  type Choice,
  type ColumnDef,
  type FieldDef,
  type Row,
} from '../components/records';

/** Last 10 significant digits, for loose number matching (same rule Data Collection uses). */
const numKey = (v: string | null | undefined): string => String(v ?? '').replace(/\D/g, '').slice(-10);

const VOICEMAIL_LANGUAGE_CHOICES: Choice[] = VOICEMAIL_PROMPT_LANGUAGES.map((l) => ({
  value: l.code,
  label: `${l.label} (${l.code})`,
}));

/** Every language New-CsAutoAttendant/Set-CsAutoAttendant -LanguageId accepts - see AA_SUPPORTED_LANGUAGES. */
const AA_LANGUAGE_CHOICES: Choice[] = AA_SUPPORTED_LANGUAGES.map((l) => ({
  value: l.code,
  label: l.speechInput ? `${l.label} (${l.code})` : `${l.label} (${l.code}, no voice input)`,
}));
/** Every Windows time zone ID New-CsAutoAttendant/Set-CsAutoAttendant -TimeZoneId accepts - see AA_TIME_ZONES. */
const AA_TIME_ZONE_CHOICES: Choice[] = AA_TIME_ZONES.map((z) => ({
  value: z.id,
  label: `${z.label} (${z.id})`,
}));

/** Small live-vs-target badge - the replacement for the workbook's `G-*` columns. */
function ValidationBadge({ v }: { v: BuildRowValidation | null }) {
  if (!v) return <>—</>;
  if (!v.existsInTenant) {
    return (
      <Badge appearance="tint" color="danger" icon={<WarningRegular />}>
        not in tenant
      </Badge>
    );
  }
  const issues =
    v.unknownPolicies.length + v.policyMismatches.length + (v.numberConflict ? 1 : 0) + (v.numberTypeMissing ? 1 : 0);
  // Renames aren't a real issue - deployment always resolves the live name
  // via policy_ids regardless - but still worth surfacing so the stale
  // display text next to it isn't mistaken for what will actually deploy.
  if (issues === 0) {
    const renameTitle = v.renamedPolicies.map((p) => `${p.label}: policy was renamed to "${p.liveName}" - refresh to sync`).join('\n');
    return v.renamedPolicies.length ? (
      <Badge appearance="tint" color="informative" title={renameTitle}>
        {v.renamedPolicies.length} renamed
      </Badge>
    ) : (
      <Badge appearance="tint" color="success" icon={<CheckmarkCircleRegular />}>
        matches
      </Badge>
    );
  }
  const title = [
    v.numberConflict ? 'This number is also assigned to another user, CAP or resource account in this tenant' : null,
    v.numberTypeMissing ? 'Phone number set but no Number type - the number won\'t actually be assigned (and Enterprise Voice won\'t be enabled) on deployment' : null,
    ...v.unknownPolicies.map((p) => `${p.label}: "${p.value}" doesn't exist in the tenant`),
    ...v.policyMismatches.map((p) => `${p.label}: live is ${p.live ?? '(none)'}, target is ${p.target}`),
    ...v.renamedPolicies.map((p) => `${p.label}: policy was renamed to "${p.liveName}" - refresh to sync`),
  ]
    .filter(Boolean)
    .join('\n');
  return (
    <Badge appearance="tint" color="warning" icon={<WarningRegular />} title={title}>
      {issues} issue{issues === 1 ? '' : 's'}
    </Badge>
  );
}

/** Short label for the "Calling settings" button - what's actually designed for this row, at a glance. */
function callingSettingsSummary(r: Row): string {
  const cf = r.call_forwarding as CallForwardingSettings | null;
  const pg = r.pickup_group as PickupGroupSettings | null;
  const delegates = Array.isArray(r.delegates) ? (r.delegates as CallDelegate[]) : [];
  const bits: string[] = [];
  if (cf?.forwarding?.enabled) bits.push('Forwarding');
  if (cf?.unanswered?.enabled) bits.push('Unanswered');
  if (cf?.busyOnBusy) bits.push('Busy on busy');
  if (pg?.targets?.length) bits.push('Pickup group');
  if (delegates.length) bits.push(`${delegates.length} delegate${delegates.length === 1 ? '' : 's'}`);
  return bits.length ? bits.join(', ') : 'Calling settings…';
}

export function BuildSiteWorkspace() {
  const s = useRecordStyles();
  const { siteId = '' } = useParams();
  const { activeTenantId, can } = useAuth();
  const qc = useQueryClient();
  const [tab, setTab] = useState<'users' | 'caps' | 'resource-accounts' | 'call-queues' | 'auto-attendants'>('users');

  const tid = activeTenantId;
  const base = `/t/${tid}/build`;
  const canWrite = can('build:write');

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

  const [populateError, setPopulateError] = useState<string | null>(null);
  const populate = useMutation({
    mutationFn: (kind: 'users' | 'caps' | 'resource-accounts') =>
      api(`${base}/${kind}/populate`, { method: 'POST', body: JSON.stringify({ site_id: siteId }) }),
    onSuccess: () => {
      setPopulateError(null);
      qc.invalidateQueries({ queryKey: ['users', tid, siteId] });
      qc.invalidateQueries({ queryKey: ['caps', tid, siteId] });
      qc.invalidateQueries({ queryKey: ['resource-accounts', tid, siteId] });
      qc.invalidateQueries({ queryKey: ['call-queues', tid, siteId] });
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

  const policyFields: FieldDef[] = POLICY_KINDS.map((k) => ({
    key: `policy_ids.${k.key}`,
    label: k.label,
    type: 'ref',
    choices: policyChoicesByKey[k.key] ?? [],
  }));

  return (
    <Page
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
        <Text size={200}>
          Users: <b>{site.counts.users}</b>
        </Text>
        <Text size={200}>
          CAPs: <b>{site.counts.caps}</b>
        </Text>
        <Text size={200}>
          Resource accounts: <b>{site.counts.resourceAccounts}</b>
        </Text>
        {canWrite && (
          <Button size="small" disabled={validate.isPending} onClick={() => validate.mutate({})}>
            {validate.isPending ? 'Validating…' : 'Validate against tenant'}
          </Button>
        )}
        {canWrite && (
          <Button size="small" appearance="subtle" onClick={() => setMapOpen(true)}>
            Calling policy map
          </Button>
        )}
        {validateMsg && (
          <Text size={200} className={s.muted}>
            {validateMsg}
          </Text>
        )}
        {canWrite && (site.counts.users + site.counts.caps + site.counts.resourceAccounts) > 0 && (
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
        <Text block style={{ color: tokens.colorPaletteRedForeground1 }}>
          {populateError}
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
                designed for this site, and releases any numbers they hold back to the inventory.
                Data Collection is not affected - you can Populate from Discovery again afterwards.
              </Text>
              <Text block weight="semibold" style={{ marginTop: 8 }}>
                This cannot be undone.
              </Text>
              {resetError && (
                <Text block style={{ marginTop: 8, color: tokens.colorPaletteRedForeground1 }}>
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
          }}
        />
      )}
      {aaFlowFor && tid && (
        <AutoAttendantFlowDialog tid={tid} base={base} siteId={siteId} row={aaFlowFor} onClose={() => setAaFlowFor(null)} />
      )}
      {cqFlowFor && <CallQueueFlowDialog row={cqFlowFor} onClose={() => setCqFlowFor(null)} />}

      <TabList selectedValue={tab} onTabSelect={(_, d) => setTab(d.value as typeof tab)}>
        <Tab value="users">Users</Tab>
        <Tab value="caps">Common area phones</Tab>
        <Tab value="resource-accounts">Resource accounts</Tab>
        <Tab value="call-queues">Call queues</Tab>
        <Tab value="auto-attendants">Auto attendants</Tab>
      </TabList>

      {tab === 'users' && (
        <PagedSection
          title="Users"
          hint="Teams users with Enterprise Voice - target numbers and policies for this site. Replaces the USERS build sheet."
          endpoint={`${base}/users`}
          queryKey={['users', tid, siteId]}
          params={{ siteId }}
          fixed={{ site_id: siteId }}
          readOnly={!canWrite}
          pageSize={500}
          selectable={canWrite}
          selected={usersSelected}
          onSelectedChange={setUsersSelected}
          headerActions={
            canWrite && (
              <>
                <Button size="small" disabled={populate.isPending} onClick={() => populate.mutate('users')}>
                  Populate from Discovery
                </Button>
                <Button size="small" disabled={usersSelected.size === 0} onClick={() => setBulkOpen('users')}>
                  Bulk edit ({usersSelected.size} selected)
                </Button>
                <Button size="small" appearance="subtle" onClick={() => setTemplatesOpen('user')}>
                  Templates
                </Button>
              </>
            )
          }
          columns={[
            { key: 'upn', label: 'UPN' },
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
              render: (r) => (
                <Button
                  size="small"
                  appearance="subtle"
                  onClick={() =>
                    setCallingSettingsFor({ endpoint: `${base}/users`, queryKey: ['users', tid, siteId], row: r })
                  }
                >
                  {callingSettingsSummary(r)}
                </Button>
              ),
            },
            { key: 'validation', label: 'Validation', render: (r) => <ValidationBadge v={r.validation as BuildRowValidation | null} /> },
          ]}
          fields={identityFields(policyFields, numberChoicesFor)}
        />
      )}

      {tab === 'caps' && (
        <PagedSection
          title="Common area phones"
          hint="Phones logged in permanently (lobbies, meeting rooms) - target numbers and policies. Replaces the CAPS build sheet."
          endpoint={`${base}/caps`}
          queryKey={['caps', tid, siteId]}
          params={{ siteId }}
          fixed={{ site_id: siteId }}
          readOnly={!canWrite}
          pageSize={500}
          selectable={canWrite}
          selected={capsSelected}
          onSelectedChange={setCapsSelected}
          headerActions={
            canWrite && (
              <>
                <Button size="small" disabled={populate.isPending} onClick={() => populate.mutate('caps')}>
                  Populate from Discovery
                </Button>
                <Button size="small" disabled={capsSelected.size === 0} onClick={() => setBulkOpen('caps')}>
                  Bulk edit ({capsSelected.size} selected)
                </Button>
                <Button size="small" appearance="subtle" onClick={() => setTemplatesOpen('cap')}>
                  Templates
                </Button>
              </>
            )
          }
          columns={[
            { key: 'upn', label: 'UPN' },
            { key: 'display_name', label: 'Name' },
            { key: 'e164', label: 'Number' },
            { key: 'phone_model', label: 'Model' },
            ...policyColumns(),
            {
              key: 'calling_settings',
              label: 'Calling',
              render: (r) => (
                <Button
                  size="small"
                  appearance="subtle"
                  onClick={() =>
                    setCallingSettingsFor({ endpoint: `${base}/caps`, queryKey: ['caps', tid, siteId], row: r })
                  }
                >
                  {callingSettingsSummary(r)}
                </Button>
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
          title="Resource accounts"
          hint="Identity + number for Auto Attendant / Call Queue resource accounts. Model a new one before it exists live, then use Request accounts below to ask the customer to create and license it - see the note below."
          endpoint={`${base}/resource-accounts`}
          queryKey={['resource-accounts', tid, siteId]}
          params={{ siteId }}
          fixed={{ site_id: siteId }}
          readOnly={!canWrite}
          headerActions={
            canWrite && (
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
            { key: 'display_name', label: 'Name' },
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

      {tab === 'call-queues' && (
        <PagedSection
          title="Call queues"
          hint="Routing, agents and overflow/timeout behaviour for Call Queue resource accounts. New rows are seeded by Populate from Discovery on the Resource accounts tab."
          endpoint={`${base}/call-queues`}
          queryKey={['call-queues', tid, siteId]}
          params={{ siteId }}
          fixed={{ site_id: siteId }}
          readOnly={!canWrite}
          emptyText="No call queues yet - Populate from Discovery on the Resource accounts tab first."
          columns={[
            { key: 'name', label: 'Name' },
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
              render: (r) => (
                <Button size="small" appearance="subtle" onClick={() => setCallQueueSettingsFor(r)}>
                  Configure…
                </Button>
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
          title="Auto attendants"
          hint="Language/voice and the real call-flow menu (business hours, after hours, holidays) for Auto Attendant resource accounts. Populate from Discovery pre-fills these from a live tenant; for a greenfield site, add one by hand and link resource accounts to it in Configure… - it just won't get a phone number until that account is created and licensed."
          endpoint={`${base}/auto-attendants`}
          queryKey={['auto-attendants', tid, siteId]}
          params={{ siteId }}
          fixed={{ site_id: siteId }}
          readOnly={!canWrite}
          emptyText="No auto attendants yet - add one, or Populate from Discovery on the Resource accounts tab."
          columns={[
            { key: 'name', label: 'Name' },
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
              render: (r) => (
                <Button size="small" appearance="subtle" onClick={() => setAaSettingsFor(r)}>
                  Configure…
                </Button>
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

    </Page>
  );
}

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
 * "Link discovered resource account" - pulls one specific live resource
 * account (not yet in Data Collection at all) straight into this site,
 * without the engineer having to visit Data Collection first. Candidates
 * come from the same tenant-wide preview Data Collection's own Resource
 * accounts import uses (TenantDiscoveryService.importResourceAccountsPreview) -
 * ones whose auto-suggested site matches this workspace sort first, since
 * the live object may not carry this site's own naming convention at all.
 */
function LinkDiscoveredResourceAccountDialog({
  tid,
  siteId,
  onClose,
  onDone,
}: {
  tid: string;
  siteId: string;
  onClose: () => void;
  onDone: () => void;
}) {
  const [objectId, setObjectId] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const preview = useQuery({
    queryKey: ['tdisc', 'import-resource-accounts-preview', tid],
    queryFn: () =>
      api<{ candidates: { id: string; name: string | null; kind: string | null; phone: string | null; suggestedSiteId: string | null }[] }>(
        `/t/${tid}/tenant-discovery/import-resource-accounts/preview`,
      ),
  });
  const candidates = useMemo(() => {
    const items = preview.data?.candidates ?? [];
    return [...items].sort((a, b) => Number(b.suggestedSiteId === siteId) - Number(a.suggestedSiteId === siteId));
  }, [preview.data, siteId]);
  const link = useMutation({
    mutationFn: () =>
      api(`/t/${tid}/build/resource-accounts/import-and-link`, {
        method: 'POST',
        body: JSON.stringify({ site_id: siteId, object_id: objectId }),
      }),
    onSuccess: onDone,
    onError: (e) => setErr(e instanceof ApiError ? e.message : 'Link failed'),
  });
  const selected = candidates.find((c) => c.id === objectId);

  return (
    <Dialog open onOpenChange={(_, d) => !d.open && onClose()}>
      <DialogSurface>
        <DialogBody>
          <DialogTitle>Link discovered resource account</DialogTitle>
          <DialogContent>
            <div style={{ display: 'grid', gap: 12 }}>
              <Text size={200}>
                Pulls one live resource account that isn't in Data Collection yet straight into this
                site - creates its Data Collection row and populates it here in one step.
              </Text>
              {preview.isLoading ? (
                <Spinner size="tiny" />
              ) : preview.isError ? (
                <LoadError message={(preview.error as Error).message} />
              ) : candidates.length === 0 ? (
                <Text size={200}>Every discovered resource account is already captured.</Text>
              ) : (
                <Field label="Resource account">
                  <Dropdown
                    placeholder="Pick a resource account…"
                    selectedOptions={objectId ? [objectId] : []}
                    value={selected ? `${selected.name ?? '(unnamed)'}${selected.phone ? ` · ${selected.phone}` : ''}` : ''}
                    onOptionSelect={(_, d) => setObjectId(d.optionValue ?? '')}
                  >
                    {candidates.map((c) => (
                      <Option key={c.id} value={c.id} text={c.name ?? c.id}>
                        {c.name ?? '(unnamed)'}
                        {c.phone ? ` · ${c.phone}` : ''}
                        {c.suggestedSiteId === siteId ? ' · suggested for this site' : ''}
                      </Option>
                    ))}
                  </Dropdown>
                </Field>
              )}
              {err && <LoadError message={err} />}
            </div>
          </DialogContent>
          <DialogActions>
            <Button appearance="secondary" onClick={onClose}>
              Cancel
            </Button>
            <Button appearance="primary" disabled={!objectId || link.isPending} onClick={() => link.mutate()}>
              Link
            </Button>
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
}

/**
 * The "as-designed" call-flow diagram for one Call Queue - what happens on
 * Overflow/Timeout/No-agent, built from this row's own columns via
 * buildCallQueueFlowGraphFromDesign. No fetch needed - the row the "View
 * diagram" button was clicked from already carries everything.
 */
function CallQueueFlowDialog({ row, onClose }: { row: Row; onClose: () => void }) {
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
function AutoAttendantFlowDialog({ tid, base, siteId, row, onClose }: { tid: string; base: string; siteId: string; row: Row; onClose: () => void }) {
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

/** One grid column per POLICY_KINDS entry, reading the same `policies` jsonb the edit dialog writes to. */
function policyColumns(): ColumnDef[] {
  return POLICY_KINDS.map((k) => ({
    key: `policies.${k.key}`,
    label: k.label,
    render: (r: Row) => {
      const target = (r.policies as Record<string, string>)?.[k.key];
      if (!target) return '—';
      // Blank targets get backfilled from live on Validate (BuildService.backfillPolicyTargets)
      // as a starting point; once the target diverges from live - by that
      // backfill matching nothing, or the engineer picking something else -
      // policyMismatches flags it, so it's obvious which accounts have a
      // real pending change before deploying.
      const v = r.validation as BuildRowValidation | null;
      const mismatch = v?.policyMismatches.find((p) => p.key === k.key);
      if (!mismatch) return target;
      return (
        <span
          title={`Live: ${mismatch.live ?? '(none)'} → will change to "${target}" on deploy`}
          style={{ color: tokens.colorPaletteMarigoldForeground1, fontWeight: tokens.fontWeightSemibold }}
        >
          {target}
        </span>
      );
    },
  }));
}

function identityFields(policyFields: FieldDef[], numberChoicesFor: (row: Row | null) => Choice[]): FieldDef[] {
  return [
    { key: 'upn', label: 'UPN', required: true, placeholder: 'user@customer.com' },
    { key: 'phone_number_id', label: 'Phone number', type: 'ref', choices: numberChoicesFor },
    { key: 'did', label: 'DID (if not yet in inventory)' },
    { key: 'number_type', label: 'Number type', type: 'select', options: NUMBER_TYPES },
    { key: 'revoke_ev', label: 'Revoke Enterprise Voice', type: 'boolean' },
    { key: 'migration_wave', label: 'Migration wave' },
    // The actual Set-CsOnlineVoicemailUserSettings target - separate from
    // voicemail_policy below (a policy grant, a different setting). Populate
    // prefills this from Data Collection; it deploys from here.
    { key: 'voicemail.enabled', label: 'Voicemail enabled', type: 'boolean' },
    // Culture codes only - Teams rejects a plain name like "English" (see VOICEMAIL_PROMPT_LANGUAGES).
    { key: 'voicemail.language', label: 'Voicemail language', type: 'ref', choices: VOICEMAIL_LANGUAGE_CHOICES },
    ...policyFields,
    { key: 'comments', label: 'Comments', type: 'textarea', full: true },
  ];
}

/**
 * The fields bulk edit exposes - identityFields() (shared by Users and
 * CAPs) minus upn/phone_number_id/did. Those three are per-row-unique
 * identifiers - bulk-applying the same UPN, phone number, or raw DID text
 * to many rows would be destructive, not a real bulk operation (see
 * buildBulkPatchSchema, packages/shared/src/dto.ts). numberChoicesFor isn't
 * needed since phone_number_id is excluded.
 */
function bulkIdentityFields(policyFields: FieldDef[]): FieldDef[] {
  return identityFields(policyFields, () => []).filter((f) => !['upn', 'phone_number_id', 'did'].includes(f.key));
}

interface CallingPolicyMapRow {
  discoveryCallingPolicyId: string;
  name: string;
  inUse: boolean;
  tenantPolicyId: string | null;
  tenantPolicyName: string | null;
}

/**
 * Which real tenant Voice Routing Policy each Data Collection generic
 * calling policy ("International", "Standard", …) means for THIS site -
 * OnlineVoiceRoutingPolicy is the Teams concept that actually governs
 * local/national/international dialing permission (not TeamsCallingPolicy,
 * which is call features like forwarding/park/busy-on-busy). See
 * BuildService.assertCallingPoliciesMapped, which blocks Populate until
 * every policy actually in use here has a row.
 */
function CallingPolicyMapDialog({
  open,
  onOpenChange,
  base,
  siteId,
  callingPolicyChoices,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  base: string;
  siteId: string;
  callingPolicyChoices: Choice[];
}) {
  const qc = useQueryClient();
  const rowsQ = useQuery({
    queryKey: ['calling-policy-map', base, siteId],
    enabled: open,
    queryFn: () => api<CallingPolicyMapRow[]>(`${base}/calling-policy-map?siteId=${siteId}`),
  });
  const setMut = useMutation({
    mutationFn: (body: { discovery_calling_policy_id: string; tenant_policy_id: string }) =>
      api(`${base}/calling-policy-map`, { method: 'POST', body: JSON.stringify({ site_id: siteId, ...body }) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['calling-policy-map', base, siteId] }),
  });

  return (
    <Dialog open={open} onOpenChange={(_, d) => onOpenChange(d.open)}>
      <DialogSurface>
        <DialogBody>
          <DialogTitle>Calling policy map</DialogTitle>
          <DialogContent>
            <Text size={200} block style={{ marginBottom: 12 }}>
              Which real tenant Voice Routing Policy each Data Collection calling policy means for this site -
              that's the Teams policy that actually governs local/national/international dialing, not the Teams
              Calling Policy. "International" here might be a different real policy on a US site than on a Belgium
              one. A policy marked "in use, unmapped" must be mapped before Populate from Discovery can run.
            </Text>
            {rowsQ.isLoading ? (
              <Spinner size="tiny" label="Loading…" />
            ) : (rowsQ.data ?? []).length === 0 ? (
              <Text size={200}>No calling policies defined in Data Collection yet.</Text>
            ) : (
              <div style={{ display: 'grid', gap: 8 }}>
                {(rowsQ.data ?? []).map((r) => (
                  <div key={r.discoveryCallingPolicyId} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <Text style={{ width: 160 }}>{r.name}</Text>
                    {r.inUse && !r.tenantPolicyId && (
                      <Badge appearance="tint" color="danger" size="small">
                        in use, unmapped
                      </Badge>
                    )}
                    <Dropdown
                      style={{ minWidth: 260, flex: 1 }}
                      placeholder="Select the real tenant policy…"
                      value={callingPolicyChoices.find((c) => c.value === r.tenantPolicyId)?.label ?? ''}
                      selectedOptions={r.tenantPolicyId ? [r.tenantPolicyId] : []}
                      onOptionSelect={(_, d) => {
                        if (d.optionValue) {
                          setMut.mutate({ discovery_calling_policy_id: r.discoveryCallingPolicyId, tenant_policy_id: d.optionValue });
                        }
                      }}
                    >
                      {callingPolicyChoices.map((c) => (
                        <Option key={c.value} value={c.value} text={c.label}>
                          {c.label}
                        </Option>
                      ))}
                    </Dropdown>
                  </div>
                ))}
              </div>
            )}
          </DialogContent>
          <DialogActions>
            <DialogTrigger disableButtonEnhancement>
              <Button appearance="secondary">Close</Button>
            </DialogTrigger>
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
}

interface BuildTemplateRow {
  id: string;
  site_id: string;
  kind: 'user' | 'cap';
  name: string;
  policy_ids: Record<string, string | null>;
  policies: Record<string, string | null>;
  voicemail_enabled: boolean | null;
  voicemail_language: string | null;
  is_default: boolean;
}

/** The subset of PolicyKeys a Build Template covers - matches the "Standard
 * User Template" example (voice routing, dial plan, calling policy,
 * emergency calling + routing) - not the full 13-key set per-row edit
 * exposes, to keep a template focused on what's actually meant to default. */
const TEMPLATE_POLICY_KEYS: PolicyKey[] = [
  'voice_routing_policy',
  'dial_plan',
  'calling_policy',
  'emergency_calling_policy',
  'emergency_call_routing_policy',
];
const VM_UNSET = '__unset__';

/**
 * A named, reusable preset of policy targets + voicemail defaults for Users
 * or CAPs on one site ("Standard User Template"). The one marked Default
 * seeds every new row Populate creates for that site+kind; any template can
 * also be applied on demand to the rows currently selected in the table.
 */
function TemplatesDialog({
  open,
  onOpenChange,
  base,
  siteId,
  kind,
  kindLabel,
  policyChoicesByKey,
  selectedIds,
  onApplied,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  base: string;
  siteId: string;
  kind: 'user' | 'cap';
  kindLabel: string;
  policyChoicesByKey: Record<string, Choice[]>;
  selectedIds: Set<string>;
  onApplied: () => void;
}) {
  const qc = useQueryClient();
  const [editing, setEditing] = useState<BuildTemplateRow | 'new' | null>(null);
  const [form, setForm] = useState<{
    name: string;
    policy_ids: Record<string, string>;
    voicemail_enabled: string;
    voicemail_language: string;
    is_default: boolean;
  }>({ name: '', policy_ids: {}, voicemail_enabled: '', voicemail_language: '', is_default: false });
  const [error, setError] = useState<string | null>(null);
  const [applyError, setApplyError] = useState<string | null>(null);
  const [applyingId, setApplyingId] = useState<string | null>(null);

  const rowsQ = useQuery({
    queryKey: ['build-templates', base, siteId, kind],
    enabled: open,
    queryFn: () => api<BuildTemplateRow[]>(`${base}/templates?siteId=${siteId}&kind=${kind}`),
  });

  const startNew = () => {
    setForm({ name: '', policy_ids: {}, voicemail_enabled: '', voicemail_language: '', is_default: (rowsQ.data ?? []).length === 0 });
    setError(null);
    setEditing('new');
  };
  const startEdit = (tpl: BuildTemplateRow) => {
    const ids: Record<string, string> = {};
    for (const k of TEMPLATE_POLICY_KEYS) if (tpl.policy_ids[k]) ids[k] = tpl.policy_ids[k]!;
    setForm({
      name: tpl.name,
      policy_ids: ids,
      voicemail_enabled: tpl.voicemail_enabled === null ? '' : String(tpl.voicemail_enabled),
      voicemail_language: tpl.voicemail_language ?? '',
      is_default: tpl.is_default,
    });
    setError(null);
    setEditing(tpl);
  };

  const save = useMutation({
    mutationFn: () => {
      const body = {
        site_id: siteId,
        kind,
        name: form.name,
        // Only the keys actually set in the form - same "only sets, never
        // clears" convention as bulk edit (buildBulkPayload): a null entry
        // here would jsonb-merge as "clear this key" on Apply to already-
        // populated rows, wiping a field the template was never meant to
        // touch. To clear a field the template previously set, delete and
        // recreate the template rather than blanking it back to "— none —".
        policy_ids: Object.fromEntries(TEMPLATE_POLICY_KEYS.filter((k) => form.policy_ids[k]).map((k) => [k, form.policy_ids[k]])),
        voicemail_enabled: form.voicemail_enabled === '' ? null : form.voicemail_enabled === 'true',
        voicemail_language: form.voicemail_language || null,
        is_default: form.is_default,
      };
      return editing === 'new'
        ? api(`${base}/templates`, { method: 'POST', body: JSON.stringify(body) })
        : api(`${base}/templates/${(editing as BuildTemplateRow).id}`, { method: 'PATCH', body: JSON.stringify(body) });
    },
    onSuccess: () => {
      setEditing(null);
      qc.invalidateQueries({ queryKey: ['build-templates', base, siteId, kind] });
    },
    onError: (e) => setError(e instanceof ApiError ? e.message : 'Save failed'),
  });

  const del = useMutation({
    mutationFn: (id: string) => api(`${base}/templates/${id}`, { method: 'DELETE' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['build-templates', base, siteId, kind] }),
  });

  const apply = useMutation({
    mutationFn: (id: string) =>
      api<{ updated: number }>(`${base}/templates/${id}/apply`, { method: 'POST', body: JSON.stringify({ ids: [...selectedIds] }) }),
    onSuccess: () => {
      setApplyError(null);
      setApplyingId(null);
      onApplied();
    },
    onError: (e) => {
      setApplyError(e instanceof ApiError ? e.message : 'Apply failed');
      setApplyingId(null);
    },
  });

  return (
    <Dialog open={open} onOpenChange={(_, d) => onOpenChange(d.open)}>
      <DialogSurface style={{ maxWidth: 760 }}>
        <DialogBody>
          <DialogTitle>{kindLabel} templates</DialogTitle>
          <DialogContent>
            <Text size={200} block style={{ marginBottom: 12 }}>
              A named preset applied automatically to new rows Populate creates for this site (the one marked
              Default), or on demand to the rows selected in the table below.
            </Text>
            {rowsQ.isLoading ? (
              <Spinner size="tiny" label="Loading…" />
            ) : (
              <div style={{ display: 'grid', gap: 8, marginBottom: 12 }}>
                {(rowsQ.data ?? []).map((tpl) => (
                  <div key={tpl.id} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <Text weight={tpl.is_default ? 'semibold' : 'regular'} style={{ flex: 1 }}>
                      {tpl.name}
                      {tpl.is_default && (
                        <Badge appearance="tint" color="brand" size="small" style={{ marginLeft: 6 }}>
                          Default
                        </Badge>
                      )}
                    </Text>
                    <Button
                      size="small"
                      disabled={selectedIds.size === 0 || apply.isPending}
                      onClick={() => {
                        setApplyingId(tpl.id);
                        apply.mutate(tpl.id);
                      }}
                    >
                      {apply.isPending && applyingId === tpl.id ? 'Applying…' : `Apply to ${selectedIds.size} selected`}
                    </Button>
                    <Button size="small" appearance="subtle" onClick={() => startEdit(tpl)}>
                      Edit
                    </Button>
                    <Button size="small" appearance="subtle" icon={<DeleteRegular />} onClick={() => del.mutate(tpl.id)} />
                  </div>
                ))}
                {(rowsQ.data ?? []).length === 0 && <Text size={200}>No templates yet.</Text>}
              </div>
            )}
            {applyError && (
              <Text block style={{ color: tokens.colorPaletteRedForeground1, marginBottom: 8 }}>
                {applyError}
              </Text>
            )}

            {editing ? (
              <div style={{ borderTop: `1px solid ${tokens.colorNeutralStroke2}`, paddingTop: 12, display: 'grid', gap: 12 }}>
                <Field label="Name">
                  <Input value={form.name} placeholder="Standard User Template" onChange={(_, d) => setForm((p) => ({ ...p, name: d.value }))} />
                </Field>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                  {TEMPLATE_POLICY_KEYS.map((k) => {
                    const label = POLICY_KINDS.find((p) => p.key === k)?.label ?? k;
                    const choices = policyChoicesByKey[k] ?? [];
                    const value = form.policy_ids[k] ?? '';
                    return (
                      <Field key={k} label={label}>
                        <Dropdown
                          value={choices.find((c) => c.value === value)?.label ?? '— none —'}
                          selectedOptions={[value || '']}
                          onOptionSelect={(_, d) => setForm((p) => ({ ...p, policy_ids: { ...p.policy_ids, [k]: d.optionValue ?? '' } }))}
                        >
                          <Option value="">— none —</Option>
                          {choices.map((c) => (
                            <Option key={c.value} value={c.value} text={c.label}>
                              {c.label}
                            </Option>
                          ))}
                        </Dropdown>
                      </Field>
                    );
                  })}
                  <Field label="Voicemail enabled">
                    <Dropdown
                      value={form.voicemail_enabled === 'true' ? 'On' : form.voicemail_enabled === 'false' ? 'Off' : '— unset —'}
                      selectedOptions={[form.voicemail_enabled || VM_UNSET]}
                      onOptionSelect={(_, d) => setForm((p) => ({ ...p, voicemail_enabled: d.optionValue === VM_UNSET ? '' : d.optionValue ?? '' }))}
                    >
                      <Option value={VM_UNSET}>— unset —</Option>
                      <Option value="true">On</Option>
                      <Option value="false">Off</Option>
                    </Dropdown>
                  </Field>
                  <Field label="Voicemail default language">
                    <Dropdown
                      value={VOICEMAIL_PROMPT_LANGUAGES.find((l) => l.code === form.voicemail_language)?.label ?? '— unset —'}
                      selectedOptions={[form.voicemail_language || VM_UNSET]}
                      onOptionSelect={(_, d) => setForm((p) => ({ ...p, voicemail_language: d.optionValue === VM_UNSET ? '' : d.optionValue ?? '' }))}
                    >
                      <Option value={VM_UNSET}>— unset —</Option>
                      {VOICEMAIL_PROMPT_LANGUAGES.map((l) => (
                        <Option key={l.code} value={l.code} text={l.label}>
                          {l.label}
                        </Option>
                      ))}
                    </Dropdown>
                  </Field>
                </div>
                <Checkbox
                  label="Default - auto-applied when Populate creates a new row"
                  checked={form.is_default}
                  onChange={(_, d) => setForm((p) => ({ ...p, is_default: !!d.checked }))}
                />
                {error && (
                  <Text block style={{ color: tokens.colorPaletteRedForeground1 }}>
                    {error}
                  </Text>
                )}
                <div style={{ display: 'flex', gap: 8 }}>
                  <Button appearance="primary" disabled={!form.name.trim() || save.isPending} onClick={() => save.mutate()}>
                    {save.isPending ? 'Saving…' : 'Save'}
                  </Button>
                  <Button appearance="secondary" onClick={() => setEditing(null)}>
                    Cancel
                  </Button>
                </div>
              </div>
            ) : (
              <Button size="small" onClick={startNew}>
                Add template
              </Button>
            )}
          </DialogContent>
          <DialogActions>
            <DialogTrigger disableButtonEnhancement>
              <Button appearance="secondary">Close</Button>
            </DialogTrigger>
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
}

/* ------------------------- calling settings dialog ------------------------- */

/** unset = no cmdlet planned at all; off = explicitly disabled (Set-...-Enabled $false); on = configured. */
type TriState = 'unset' | 'off' | 'on';
const UNANSWERED_DELAYS = [5, 10, 15, 20, 30, 40, 50, 60];

function CallingSettingsDialog({
  tenantId,
  endpoint,
  row,
  onClose,
  onSaved,
}: {
  tenantId: string;
  endpoint: string;
  row: Row;
  onClose: () => void;
  onSaved: () => void;
}) {
  const cf = (row.call_forwarding as CallForwardingSettings | null) ?? null;
  const pg = (row.pickup_group as PickupGroupSettings | null) ?? null;

  const [fwdMode, setFwdMode] = useState<TriState>(cf?.forwarding ? (cf.forwarding.enabled ? 'on' : 'off') : 'unset');
  const [fwdType, setFwdType] = useState<string>(cf?.forwarding?.type ?? 'Immediate');
  const [fwdTargetType, setFwdTargetType] = useState<string>(cf?.forwarding?.targetType ?? 'Voicemail');
  const [fwdTarget, setFwdTarget] = useState(cf?.forwarding?.target ?? '');

  const [unaMode, setUnaMode] = useState<TriState>(cf?.unanswered ? (cf.unanswered.enabled ? 'on' : 'off') : 'unset');
  const [unaDelay, setUnaDelay] = useState<number>(cf?.unanswered?.delaySeconds ?? 20);
  const [unaTargetType, setUnaTargetType] = useState<string>(cf?.unanswered?.targetType ?? 'Voicemail');
  const [unaTarget, setUnaTarget] = useState(cf?.unanswered?.target ?? '');

  const [busyOnBusy, setBusyOnBusy] = useState<string>(cf?.busyOnBusy ?? '');

  const [pgOrder, setPgOrder] = useState<string>(pg?.order ?? 'Simultaneous');
  const [pgTargets, setPgTargets] = useState<string[]>(pg?.targets ? [...pg.targets] : []);

  const [delegates, setDelegates] = useState<CallDelegate[]>(
    Array.isArray(row.delegates) ? (row.delegates as CallDelegate[]).slice() : [],
  );

  const [err, setErr] = useState<string | null>(null);

  const save = useMutation({
    mutationFn: () => {
      const call_forwarding: CallForwardingSettings = {};
      if (fwdMode !== 'unset') {
        call_forwarding.forwarding =
          fwdMode === 'on'
            ? {
                enabled: true,
                type: fwdType as (typeof CALL_FORWARDING_TYPES)[number],
                targetType: fwdTargetType as (typeof CALL_TARGET_TYPES)[number],
                target: fwdTargetType === 'SingleTarget' ? fwdTarget : undefined,
              }
            : { enabled: false };
      }
      if (unaMode !== 'unset') {
        call_forwarding.unanswered =
          unaMode === 'on'
            ? {
                enabled: true,
                delaySeconds: unaDelay,
                targetType: unaTargetType as (typeof CALL_TARGET_TYPES)[number],
                target: unaTargetType === 'SingleTarget' ? unaTarget : undefined,
              }
            : { enabled: false };
      }
      if (busyOnBusy) call_forwarding.busyOnBusy = busyOnBusy as (typeof BUSY_ON_BUSY_OPTIONS)[number];

      const targets = pgTargets.map((t) => t.trim()).filter(Boolean);
      // Always send a full { order, targets } object, even when targets is
      // empty - pgOrder always has a real value (defaults to 'Simultaneous'),
      // so this still matches pickupGroupSchema and lets an intentional
      // clear-to-empty actually reach the server, instead of vanishing as
      // `undefined` (which JSON.stringify drops, leaving the DB column
      // untouched - confirmed this was why a save here couldn't clear a
      // previously-saved group).
      const pickup_group = { order: pgOrder as (typeof CALL_GROUP_ORDERS)[number], targets };

      return api(`${endpoint}/${row.id}`, {
        method: 'PATCH',
        // call_forwarding/delegates/pickup_group are always sent (even {}/[])
        // so this dialog can explicitly clear a previously-designed setting,
        // not just add one.
        body: JSON.stringify({ call_forwarding, pickup_group, delegates }),
      });
    },
    onSuccess: onSaved,
    onError: (e) => setErr(e instanceof ApiError ? e.message : 'Failed'),
  });

  const addPgTarget = () => setPgTargets((t) => [...t, '']);
  const updatePgTarget = (i: number, value: string) => setPgTargets((t) => t.map((x, idx) => (idx === i ? value : x)));
  const removePgTarget = (i: number) => setPgTargets((t) => t.filter((_, idx) => idx !== i));

  const addDelegate = () =>
    setDelegates((d) => [
      ...d,
      { delegateUpn: '', makeCalls: true, receiveCalls: true, manageSettings: false, pickUpHeldCalls: true, joinActiveCalls: true },
    ]);
  const updateDelegate = (i: number, patch: Partial<CallDelegate>) =>
    setDelegates((d) => d.map((x, idx) => (idx === i ? { ...x, ...patch } : x)));
  const removeDelegate = (i: number) => setDelegates((d) => d.filter((_, idx) => idx !== i));

  const triStateDropdown = (value: TriState, onChange: (v: TriState) => void) => (
    <Dropdown
      value={value === 'on' ? 'On' : value === 'off' ? 'Off' : '— not set —'}
      selectedOptions={[value]}
      onOptionSelect={(_, d) => onChange((d.optionValue as TriState) ?? 'unset')}
      style={{ minWidth: 140 }}
    >
      <Option value="unset">— not set —</Option>
      <Option value="off">Off</Option>
      <Option value="on">On</Option>
    </Dropdown>
  );

  return (
    <Dialog open onOpenChange={(_, d) => !d.open && onClose()}>
      <DialogSurface style={{ maxWidth: 640 }}>
        <DialogBody>
          <DialogTitle>Calling settings — {String(row.upn)}</DialogTitle>
          <DialogContent>
            <div style={{ display: 'grid', gap: 16, minWidth: 560 }}>
              <div>
                <Text weight="semibold">Forwarding</Text>
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'end', marginTop: 6 }}>
                  <Field label="Status">{triStateDropdown(fwdMode, setFwdMode)}</Field>
                  {fwdMode === 'on' && (
                    <>
                      <Field label="Type">
                        <Dropdown value={fwdType} selectedOptions={[fwdType]} onOptionSelect={(_, d) => setFwdType(d.optionValue ?? '')}>
                          {CALL_FORWARDING_TYPES.map((t) => (
                            <Option key={t} value={t}>
                              {t}
                            </Option>
                          ))}
                        </Dropdown>
                      </Field>
                      <Field label="Target type">
                        <Dropdown
                          value={fwdTargetType}
                          selectedOptions={[fwdTargetType]}
                          onOptionSelect={(_, d) => setFwdTargetType(d.optionValue ?? '')}
                        >
                          {CALL_TARGET_TYPES.map((t) => (
                            <Option key={t} value={t}>
                              {t}
                            </Option>
                          ))}
                        </Dropdown>
                      </Field>
                      {fwdTargetType === 'SingleTarget' && (
                        <Field label="Target (user, SIP address or number)">
                          <UpnAutocomplete tenantId={tenantId} value={fwdTarget} onChange={setFwdTarget} style={{ minWidth: 220 }} />
                        </Field>
                      )}
                    </>
                  )}
                </div>
              </div>

              <div>
                <Text weight="semibold">Unanswered calls</Text>
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'end', marginTop: 6 }}>
                  <Field label="Status">{triStateDropdown(unaMode, setUnaMode)}</Field>
                  {unaMode === 'on' && (
                    <>
                      <Field label="Ring for">
                        <Dropdown
                          value={`${unaDelay}s`}
                          selectedOptions={[String(unaDelay)]}
                          onOptionSelect={(_, d) => setUnaDelay(Number(d.optionValue) || 20)}
                        >
                          {UNANSWERED_DELAYS.map((s) => (
                            <Option key={s} value={String(s)} text={`${s}s`}>
                              {s}s
                            </Option>
                          ))}
                        </Dropdown>
                      </Field>
                      <Field label="Target type">
                        <Dropdown
                          value={unaTargetType}
                          selectedOptions={[unaTargetType]}
                          onOptionSelect={(_, d) => setUnaTargetType(d.optionValue ?? '')}
                        >
                          {CALL_TARGET_TYPES.map((t) => (
                            <Option key={t} value={t}>
                              {t}
                            </Option>
                          ))}
                        </Dropdown>
                      </Field>
                      {unaTargetType === 'SingleTarget' && (
                        <Field label="Target (user, SIP address or number)">
                          <UpnAutocomplete tenantId={tenantId} value={unaTarget} onChange={setUnaTarget} style={{ minWidth: 220 }} />
                        </Field>
                      )}
                    </>
                  )}
                </div>
              </div>

              <Field label="Busy on busy" hint="What happens to a new call while already on one">
                <Dropdown
                  value={BUSY_ON_BUSY_OPTIONS.find((o) => o === busyOnBusy) ?? '— not set —'}
                  selectedOptions={[busyOnBusy || 'unset']}
                  onOptionSelect={(_, d) => setBusyOnBusy(d.optionValue === 'unset' ? '' : d.optionValue ?? '')}
                  style={{ maxWidth: 260 }}
                >
                  <Option value="unset">— not set —</Option>
                  {BUSY_ON_BUSY_OPTIONS.map((o) => (
                    <Option key={o} value={o}>
                      {o}
                    </Option>
                  ))}
                </Dropdown>
              </Field>

              <div>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <Text weight="semibold">Pickup group (call group)</Text>
                  <Button size="small" appearance="subtle" disabled={pgTargets.length >= 25} onClick={addPgTarget}>
                    Add member
                  </Button>
                </div>
                <div style={{ marginTop: 6 }}>
                  <Field label="Order">
                    <Dropdown value={pgOrder} selectedOptions={[pgOrder]} onOptionSelect={(_, d) => setPgOrder(d.optionValue ?? '')} style={{ maxWidth: 200 }}>
                      {CALL_GROUP_ORDERS.map((o) => (
                        <Option key={o} value={o}>
                          {o}
                        </Option>
                      ))}
                    </Dropdown>
                  </Field>
                </div>
                {pgTargets.map((t, i) => (
                  <div key={i} style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 6 }}>
                    <UpnAutocomplete tenantId={tenantId} value={t} onChange={(v) => updatePgTarget(i, v)} style={{ minWidth: 220 }} />
                    <Button size="small" appearance="subtle" icon={<DeleteRegular />} onClick={() => removePgTarget(i)} />
                  </div>
                ))}
                {pgTargets.length === 0 && (
                  <Text size={200} style={{ color: '#616161', display: 'block', marginTop: 6 }}>
                    No members - saving now will clear a previously-saved group on next deploy.
                  </Text>
                )}
              </div>

              <div>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <Text weight="semibold">Delegates</Text>
                  <Button size="small" appearance="subtle" disabled={delegates.length >= 25} onClick={addDelegate}>
                    Add delegate
                  </Button>
                </div>
                {delegates.map((d, i) => (
                  <div key={i} style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', marginTop: 6 }}>
                    <UpnAutocomplete
                      tenantId={tenantId}
                      value={d.delegateUpn}
                      onChange={(v) => updateDelegate(i, { delegateUpn: v })}
                      placeholder="delegate@contoso.com"
                      style={{ minWidth: 220 }}
                    />
                    <Checkbox label="Make calls" checked={d.makeCalls} onChange={(_, ev) => updateDelegate(i, { makeCalls: !!ev.checked })} />
                    <Checkbox label="Receive calls" checked={d.receiveCalls} onChange={(_, ev) => updateDelegate(i, { receiveCalls: !!ev.checked })} />
                    <Checkbox label="Manage settings" checked={d.manageSettings} onChange={(_, ev) => updateDelegate(i, { manageSettings: !!ev.checked })} />
                    <Checkbox label="Pick up held calls" checked={d.pickUpHeldCalls} onChange={(_, ev) => updateDelegate(i, { pickUpHeldCalls: !!ev.checked })} />
                    <Checkbox label="Join active calls" checked={d.joinActiveCalls} onChange={(_, ev) => updateDelegate(i, { joinActiveCalls: !!ev.checked })} />
                    <Button size="small" appearance="subtle" icon={<DeleteRegular />} onClick={() => removeDelegate(i)} />
                  </div>
                ))}
              </div>

              {err && (
                <Text block style={{ color: tokens.colorPaletteRedForeground1 }}>
                  {err}
                </Text>
              )}
            </div>
          </DialogContent>
          <DialogActions>
            <DialogTrigger disableButtonEnhancement>
              <Button appearance="secondary" onClick={onClose}>
                Cancel
              </Button>
            </DialogTrigger>
            <Button appearance="primary" disabled={save.isPending} onClick={() => save.mutate()}>
              {save.isPending ? 'Saving…' : 'Save'}
            </Button>
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
}

/* ----------------------- call queue settings dialog ----------------------- */

/**
 * Agents/overflow/timeout/linked resource accounts for one build_call_queues
 * row - same "compound JSON doesn't fit the generic FieldDef grid" reasoning
 * as CallingSettingsDialog above; the scalar fields (name, routing method,
 * agent alert time, ...) go through the normal PagedSection edit dialog.
 */
function CallQueueSettingsDialog({
  tenantId,
  base,
  siteId,
  row,
  onClose,
  onSaved,
}: {
  tenantId: string;
  base: string;
  siteId: string;
  row: Row;
  onClose: () => void;
  onSaved: () => void;
}) {
  const overflowInit = (row.overflow as CallQueueActionSettings | null) ?? null;
  const timeoutInit = (row.timeout as CallQueueActionSettings | null) ?? null;
  const noAgentInit = (row.no_agent_action as CallQueueActionSettings | null) ?? null;

  const [agents, setAgents] = useState<string[]>(Array.isArray(row.agents) ? (row.agents as string[]).slice() : []);
  const [overflowAction, setOverflowAction] = useState(overflowInit?.action ?? '');
  const [overflowThreshold, setOverflowThreshold] = useState(
    overflowInit?.threshold != null ? String(overflowInit.threshold) : '',
  );
  const [overflowTarget, setOverflowTarget] = useState(overflowInit?.target ?? '');
  const [timeoutAction, setTimeoutAction] = useState(timeoutInit?.action ?? '');
  const [timeoutThreshold, setTimeoutThreshold] = useState(
    timeoutInit?.threshold != null ? String(timeoutInit.threshold) : '',
  );
  const [timeoutTarget, setTimeoutTarget] = useState(timeoutInit?.target ?? '');
  const [noAgentAction, setNoAgentAction] = useState(noAgentInit?.action ?? '');
  const [noAgentTarget, setNoAgentTarget] = useState(noAgentInit?.target ?? '');
  const [noAgentApplyTo, setNoAgentApplyTo] = useState((row.no_agent_apply_to as string) ?? '');
  const [resourceAccounts, setResourceAccounts] = useState<string[]>(
    Array.isArray(row.resource_accounts) ? (row.resource_accounts as string[]).slice() : [],
  );
  const [err, setErr] = useState<string | null>(null);

  // Only Call Queue-kind resource accounts on this site can be linked -
  // reuses the Resource accounts tab's own list rather than a new endpoint.
  const raQ = useQuery({
    queryKey: ['resource-accounts', tenantId, siteId, 'for-call-queue'],
    queryFn: () => api<Paginated<Row>>(`${base}/resource-accounts?siteId=${siteId}&limit=500`),
  });
  const raChoices = (raQ.data?.items ?? []).filter((r) => r.kind === 'call_queue');

  const save = useMutation({
    mutationFn: () => {
      const overflow: CallQueueActionSettings = overflowAction
        ? {
            action: overflowAction as (typeof CALL_QUEUE_OVERFLOW_ACTIONS)[number],
            threshold: overflowThreshold ? Number(overflowThreshold) : undefined,
            target: overflowTarget || undefined,
          }
        : {};
      const timeout: CallQueueActionSettings = timeoutAction
        ? {
            action: timeoutAction as (typeof CALL_QUEUE_TIMEOUT_ACTIONS)[number],
            threshold: timeoutThreshold ? Number(timeoutThreshold) : undefined,
            target: timeoutTarget || undefined,
          }
        : {};
      const no_agent_action: CallQueueActionSettings = noAgentAction
        ? { action: noAgentAction as (typeof CALL_QUEUE_NO_AGENT_ACTIONS)[number], target: noAgentTarget || undefined }
        : {};
      return api(`${base}/call-queues/${row.id}`, {
        method: 'PATCH',
        body: JSON.stringify({
          agents,
          overflow,
          timeout,
          no_agent_action,
          no_agent_apply_to: noAgentApplyTo || null,
          resource_accounts: resourceAccounts,
        }),
      });
    },
    onSuccess: onSaved,
    onError: (e) => setErr(e instanceof ApiError ? e.message : 'Failed'),
  });

  const addAgent = () => setAgents((a) => [...a, '']);
  const updateAgent = (i: number, v: string) => setAgents((a) => a.map((x, idx) => (idx === i ? v : x)));
  const removeAgent = (i: number) => setAgents((a) => a.filter((_, idx) => idx !== i));
  const toggleRa = (id: string) =>
    setResourceAccounts((cur) => (cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id]));

  const actionDropdown = (
    label: string,
    value: string,
    onChange: (v: string) => void,
    options: readonly string[],
  ) => (
    <Field label={label}>
      <Dropdown
        value={value || '— not set —'}
        selectedOptions={[value || 'unset']}
        onOptionSelect={(_, d) => onChange(d.optionValue === 'unset' ? '' : (d.optionValue ?? ''))}
        style={{ minWidth: 180 }}
      >
        <Option value="unset">— not set —</Option>
        {options.map((o) => (
          <Option key={o} value={o}>
            {o}
          </Option>
        ))}
      </Dropdown>
    </Field>
  );

  return (
    <Dialog open onOpenChange={(_, d) => !d.open && onClose()}>
      <DialogSurface style={{ maxWidth: 640 }}>
        <DialogBody>
          <DialogTitle>Call queue settings — {String(row.name)}</DialogTitle>
          <DialogContent>
            <div style={{ display: 'grid', gap: 16, minWidth: 560 }}>
              <div>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <Text weight="semibold">Agents</Text>
                  <Button size="small" appearance="subtle" disabled={agents.length >= 200} onClick={addAgent}>
                    Add agent
                  </Button>
                </div>
                {agents.map((a, i) => (
                  <div key={i} style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 6 }}>
                    <UpnAutocomplete tenantId={tenantId} value={a} onChange={(v) => updateAgent(i, v)} style={{ minWidth: 220 }} />
                    <Button size="small" appearance="subtle" icon={<DeleteRegular />} onClick={() => removeAgent(i)} />
                  </div>
                ))}
                {agents.length === 0 && (
                  <Text size={200} style={{ color: '#616161', display: 'block', marginTop: 6 }}>
                    No agents yet.
                  </Text>
                )}
              </div>

              <div>
                <Text weight="semibold">Overflow (queue full)</Text>
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'end', marginTop: 6 }}>
                  {actionDropdown('Action', overflowAction, setOverflowAction, CALL_QUEUE_OVERFLOW_ACTIONS)}
                  {overflowAction && (
                    <>
                      <Field label="Threshold (0-200 calls)">
                        <Input
                          type="number"
                          value={overflowThreshold}
                          onChange={(_, d) => setOverflowThreshold(d.value)}
                          style={{ width: 120 }}
                        />
                      </Field>
                      {(overflowAction === 'Forward' || overflowAction === 'SharedVoicemail') && (
                        <Field label="Target">
                          <UpnAutocomplete tenantId={tenantId} value={overflowTarget} onChange={setOverflowTarget} style={{ minWidth: 220 }} />
                        </Field>
                      )}
                    </>
                  )}
                </div>
              </div>

              <div>
                <Text weight="semibold">Timeout (waited too long)</Text>
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'end', marginTop: 6 }}>
                  {actionDropdown('Action', timeoutAction, setTimeoutAction, CALL_QUEUE_TIMEOUT_ACTIONS)}
                  {timeoutAction && (
                    <>
                      <Field label="Threshold (0-2700 seconds)">
                        <Input
                          type="number"
                          value={timeoutThreshold}
                          onChange={(_, d) => setTimeoutThreshold(d.value)}
                          style={{ width: 120 }}
                        />
                      </Field>
                      {(timeoutAction === 'Forward' || timeoutAction === 'SharedVoicemail') && (
                        <Field label="Target">
                          <UpnAutocomplete tenantId={tenantId} value={timeoutTarget} onChange={setTimeoutTarget} style={{ minWidth: 220 }} />
                        </Field>
                      )}
                    </>
                  )}
                </div>
              </div>

              <div>
                <Text weight="semibold">No agents (zero opted in)</Text>
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'end', marginTop: 6 }}>
                  {actionDropdown('Action', noAgentAction, setNoAgentAction, CALL_QUEUE_NO_AGENT_ACTIONS)}
                  {(noAgentAction === 'Forward' || noAgentAction === 'SharedVoicemail') && (
                    <Field label="Target">
                      <UpnAutocomplete tenantId={tenantId} value={noAgentTarget} onChange={setNoAgentTarget} style={{ minWidth: 220 }} />
                    </Field>
                  )}
                  {noAgentAction && actionDropdown('Applies to', noAgentApplyTo, setNoAgentApplyTo, CALL_QUEUE_NO_AGENT_APPLY_TO)}
                </div>
              </div>

              {(overflowAction === 'SharedVoicemail' || timeoutAction === 'SharedVoicemail' || noAgentAction === 'SharedVoicemail') && (
                <Text size={200} style={{ color: tokens.colorPaletteMarigoldForeground1 }}>
                  Shared Voicemail needs a Language ID set on this row - edit it from the table's Edit form.
                </Text>
              )}

              <div>
                <Text weight="semibold">Linked resource accounts (phone numbers)</Text>
                {raQ.isLoading ? (
                  <Spinner size="tiny" label="Loading…" />
                ) : raChoices.length === 0 ? (
                  <Text size={200} style={{ color: '#616161', display: 'block', marginTop: 6 }}>
                    No Call Queue-kind resource accounts on this site yet - add one on the Resource accounts tab.
                  </Text>
                ) : (
                  <div style={{ display: 'grid', gap: 4, marginTop: 6 }}>
                    {raChoices.map((r) => (
                      <Checkbox
                        key={String(r.id)}
                        label={`${r.display_name ?? r.upn}${r.upn ? ` (${r.upn})` : ''}`}
                        checked={resourceAccounts.includes(String(r.id))}
                        onChange={() => toggleRa(String(r.id))}
                      />
                    ))}
                  </div>
                )}
              </div>

              {err && (
                <Text block style={{ color: tokens.colorPaletteRedForeground1 }}>
                  {err}
                </Text>
              )}
            </div>
          </DialogContent>
          <DialogActions>
            <DialogTrigger disableButtonEnhancement>
              <Button appearance="secondary" onClick={onClose}>
                Cancel
              </Button>
            </DialogTrigger>
            <Button appearance="primary" disabled={save.isPending} onClick={() => save.mutate()}>
              {save.isPending ? 'Saving…' : 'Save'}
            </Button>
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
}

/** A menu-option target (New-CsAutoAttendantCallableEntity) - same-site AA/CQ by name, a person by UPN, or a raw external number. */
function CallableEntityEditor({
  tenantId,
  value,
  onChange,
  aaChoices,
  cqChoices,
}: {
  tenantId: string;
  value: AutoAttendantCallableEntity | undefined;
  onChange: (v: AutoAttendantCallableEntity | undefined) => void;
  aaChoices: { id: string; name: string }[];
  cqChoices: { id: string; name: string }[];
}) {
  const kind = value?.kind ?? '';
  return (
    <div style={{ display: 'flex', gap: 8, alignItems: 'end', flexWrap: 'wrap' }}>
      <Field label="Target kind">
        <Dropdown
          value={kind || '— none —'}
          selectedOptions={[kind || 'none']}
          onOptionSelect={(_, d) => {
            const k = d.optionValue === 'none' ? '' : (d.optionValue ?? '');
            onChange(k ? { kind: k as (typeof AA_CALLABLE_ENTITY_KINDS)[number] } : undefined);
          }}
          style={{ minWidth: 170 }}
        >
          <Option value="none">— none —</Option>
          {AA_CALLABLE_ENTITY_KINDS.map((k) => (
            <Option key={k} value={k}>
              {k}
            </Option>
          ))}
        </Dropdown>
      </Field>
      {kind === 'auto_attendant' && (
        <Field label="Auto Attendant">
          <Dropdown
            value={aaChoices.find((a) => a.id === value?.buildId)?.name ?? '— select —'}
            selectedOptions={value?.buildId ? [value.buildId] : []}
            onOptionSelect={(_, d) => onChange({ kind: 'auto_attendant', buildId: d.optionValue })}
            style={{ minWidth: 220 }}
          >
            {aaChoices.map((a) => (
              <Option key={a.id} value={a.id}>
                {a.name}
              </Option>
            ))}
          </Dropdown>
        </Field>
      )}
      {kind === 'call_queue' && (
        <Field label="Call Queue">
          <Dropdown
            value={cqChoices.find((c) => c.id === value?.buildId)?.name ?? '— select —'}
            selectedOptions={value?.buildId ? [value.buildId] : []}
            onOptionSelect={(_, d) => onChange({ kind: 'call_queue', buildId: d.optionValue })}
            style={{ minWidth: 220 }}
          >
            {cqChoices.map((c) => (
              <Option key={c.id} value={c.id}>
                {c.name}
              </Option>
            ))}
          </Dropdown>
        </Field>
      )}
      {kind === 'user' && (
        <Field label="User">
          <UpnAutocomplete tenantId={tenantId} value={value?.upn ?? ''} onChange={(v) => onChange({ kind: 'user', upn: v })} style={{ minWidth: 220 }} />
        </Field>
      )}
      {kind === 'external' && (
        <Field label="External number">
          <Input
            value={value?.number ?? ''}
            onChange={(_, d) => onChange({ kind: 'external', number: d.value })}
            placeholder="tel:+1..."
            style={{ minWidth: 180 }}
          />
        </Field>
      )}
    </div>
  );
}

/** One New-CsAutoAttendantMenuOption row - DTMF digit, action, and (for TransferCallToTarget) its target. */
function MenuOptionRow({
  tenantId,
  value,
  onChange,
  onRemove,
  aaChoices,
  cqChoices,
}: {
  tenantId: string;
  value: AutoAttendantMenuOption;
  onChange: (v: AutoAttendantMenuOption) => void;
  onRemove: () => void;
  aaChoices: { id: string; name: string }[];
  cqChoices: { id: string; name: string }[];
}) {
  return (
    <div style={{ border: `1px solid ${tokens.colorNeutralStroke2}`, borderRadius: 4, padding: 8, display: 'grid', gap: 8 }}>
      <div style={{ display: 'flex', gap: 8, alignItems: 'end', flexWrap: 'wrap' }}>
        <Field label="DTMF">
          <Dropdown
            value={value.dtmf}
            selectedOptions={[value.dtmf]}
            onOptionSelect={(_, d) => onChange({ ...value, dtmf: (d.optionValue ?? 'Automatic') as AutoAttendantMenuOption['dtmf'] })}
            style={{ minWidth: 110 }}
          >
            {AA_DTMF_RESPONSES.map((d) => (
              <Option key={d} value={d}>
                {d}
              </Option>
            ))}
          </Dropdown>
        </Field>
        <Field label="Action">
          <Dropdown
            value={value.action}
            selectedOptions={[value.action]}
            onOptionSelect={(_, d) => {
              const action = (d.optionValue ?? 'DisconnectCall') as AutoAttendantMenuOption['action'];
              onChange({ ...value, action, target: action === 'TransferCallToTarget' ? value.target : undefined });
            }}
            style={{ minWidth: 190 }}
          >
            {AA_MENU_OPTION_ACTIONS.map((a) => (
              <Option key={a} value={a}>
                {a}
              </Option>
            ))}
          </Dropdown>
        </Field>
        <Button size="small" appearance="subtle" icon={<DeleteRegular />} onClick={onRemove} />
      </div>
      {value.action === 'TransferCallToTarget' && (
        <CallableEntityEditor
          tenantId={tenantId}
          value={value.target}
          onChange={(t) => onChange({ ...value, target: t })}
          aaChoices={aaChoices}
          cqChoices={cqChoices}
        />
      )}
    </div>
  );
}

/** New-CsAutoAttendantCallFlow editor - greeting, dial-by-name, and the ordered DTMF menu. Reused for business hours, after hours, and each holiday. */
function CallFlowEditor({
  tenantId,
  value,
  onChange,
  aaChoices,
  cqChoices,
}: {
  tenantId: string;
  value: AutoAttendantCallFlow;
  onChange: (v: AutoAttendantCallFlow) => void;
  aaChoices: { id: string; name: string }[];
  cqChoices: { id: string; name: string }[];
}) {
  // Only a text-to-speech greeting/menu prompt is editable here - an AudioFile
  // prompt needs a file upload + Import-CsOnlineAudioFile flow not built yet
  // (planAutoAttendantRow silently drops one for the same reason, see its buildPrompt).
  const greetingText = value.greetings.find((g) => g.type === 'Text')?.text ?? '';
  const setGreetingText = (text: string) => onChange({ ...value, greetings: text ? [{ type: 'Text', text }] : [] });
  // New-CsAutoAttendantMenu -Prompts - what the menu itself reads out (e.g.
  // "For Sales press 1, for Support press 2") - distinct from the greeting
  // above, which only plays once when the call is answered.
  const menuPromptText = value.menu.prompts?.find((p) => p.type === 'Text')?.text ?? '';
  const setMenuPromptText = (text: string) =>
    onChange({ ...value, menu: { ...value.menu, prompts: text ? [{ type: 'Text', text }] : [] } });

  const addOption = () => {
    const used = new Set(value.menu.options.map((o) => o.dtmf));
    const next = AA_DTMF_RESPONSES.find((d) => !used.has(d)) ?? 'Automatic';
    onChange({ ...value, menu: { ...value.menu, options: [...value.menu.options, { dtmf: next, action: 'DisconnectCall' }] } });
  };
  const updateOption = (i: number, opt: AutoAttendantMenuOption) =>
    onChange({ ...value, menu: { ...value.menu, options: value.menu.options.map((o, idx) => (idx === i ? opt : o)) } });
  const removeOption = (i: number) =>
    onChange({ ...value, menu: { ...value.menu, options: value.menu.options.filter((_, idx) => idx !== i) } });

  return (
    <div style={{ display: 'grid', gap: 10 }}>
      <Field label="Greeting (text-to-speech)" hint="Played once when the call is answered.">
        <Textarea value={greetingText} onChange={(_, d) => setGreetingText(d.value)} rows={2} />
      </Field>
      <Field label="Menu prompt (text-to-speech)" hint='Read out after the greeting, e.g. "For Sales press 1, for Support press 2."'>
        <Textarea value={menuPromptText} onChange={(_, d) => setMenuPromptText(d.value)} rows={2} />
      </Field>
      <div style={{ display: 'flex', gap: 16, alignItems: 'center', flexWrap: 'wrap' }}>
        <Checkbox
          label="Enable dial-by-name directory"
          checked={!!value.menu.enableDialByName}
          onChange={(_, d) => onChange({ ...value, menu: { ...value.menu, enableDialByName: !!d.checked } })}
        />
        {value.menu.enableDialByName && (
          <Field label="Search by">
            <Dropdown
              value={value.menu.directorySearchMethod ?? 'ByName'}
              selectedOptions={[value.menu.directorySearchMethod ?? 'ByName']}
              onOptionSelect={(_, d) =>
                onChange({ ...value, menu: { ...value.menu, directorySearchMethod: d.optionValue as (typeof AA_DIRECTORY_SEARCH_METHODS)[number] } })
              }
              style={{ minWidth: 130 }}
            >
              {AA_DIRECTORY_SEARCH_METHODS.map((m) => (
                <Option key={m} value={m}>
                  {m}
                </Option>
              ))}
            </Dropdown>
          </Field>
        )}
      </div>
      <div>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <Text weight="semibold" size={200}>
            Menu options
          </Text>
          <Button size="small" appearance="subtle" disabled={value.menu.options.length >= 12} onClick={addOption}>
            Add option
          </Button>
        </div>
        <div style={{ display: 'grid', gap: 8, marginTop: 6 }}>
          {value.menu.options.map((o, i) => (
            <MenuOptionRow
              key={i}
              tenantId={tenantId}
              value={o}
              onChange={(v) => updateOption(i, v)}
              onRemove={() => removeOption(i)}
              aaChoices={aaChoices}
              cqChoices={cqChoices}
            />
          ))}
          {value.menu.options.length === 0 && (
            <Text size={200} style={{ color: '#616161' }}>
              No menu options yet - callers hear the greeting then silence.
            </Text>
          )}
        </div>
      </div>
    </div>
  );
}

const WEEKDAYS = [
  { key: 'monday', label: 'Mon' },
  { key: 'tuesday', label: 'Tue' },
  { key: 'wednesday', label: 'Wed' },
  { key: 'thursday', label: 'Thu' },
  { key: 'friday', label: 'Fri' },
  { key: 'saturday', label: 'Sat' },
  { key: 'sunday', label: 'Sun' },
] as const;

function emptyWeekly(): NonNullable<AutoAttendantSchedule['weekly']> {
  return { monday: [], tuesday: [], wednesday: [], thursday: [], friday: [], saturday: [], sunday: [] };
}

/** New-CsOnlineSchedule editor - a weekly hours grid (with -Complement) or a fixed date-range list. Reused for the after-hours schedule and each holiday's own dates. */
function ScheduleEditor({ value, onChange }: { value: AutoAttendantSchedule; onChange: (v: AutoAttendantSchedule) => void }) {
  const setType = (type: (typeof AA_SCHEDULE_TYPES)[number]) =>
    onChange(type === 'weekly' ? { type: 'weekly', weekly: value.weekly ?? emptyWeekly() } : { type: 'fixed', fixed: value.fixed ?? { ranges: [] } });

  const setDayRanges = (day: (typeof WEEKDAYS)[number]['key'], ranges: AutoAttendantTimeRange[]) => {
    if (!value.weekly) return;
    onChange({ ...value, weekly: { ...value.weekly, [day]: ranges } });
  };

  return (
    <div style={{ display: 'grid', gap: 10 }}>
      <Field label="Type">
        <Dropdown value={value.type} selectedOptions={[value.type]} onOptionSelect={(_, d) => setType((d.optionValue ?? 'weekly') as (typeof AA_SCHEDULE_TYPES)[number])} style={{ minWidth: 130 }}>
          {AA_SCHEDULE_TYPES.map((t) => (
            <Option key={t} value={t}>
              {t}
            </Option>
          ))}
        </Dropdown>
      </Field>
      {value.type === 'weekly' && value.weekly && (
        <>
          <div style={{ display: 'grid', gap: 6 }}>
            {WEEKDAYS.map(({ key, label }) => {
              const ranges = value.weekly![key] ?? [];
              return (
                <div key={key} style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                  <Text size={200} style={{ width: 32 }}>
                    {label}
                  </Text>
                  {ranges.map((r, i) => (
                    <div key={i} style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
                      <Input
                        value={r.start}
                        onChange={(_, d) => setDayRanges(key, ranges.map((rr, idx) => (idx === i ? { ...rr, start: d.value } : rr)))}
                        placeholder="08:00"
                        style={{ width: 76 }}
                      />
                      <Text size={200}>–</Text>
                      <Input
                        value={r.end}
                        onChange={(_, d) => setDayRanges(key, ranges.map((rr, idx) => (idx === i ? { ...rr, end: d.value } : rr)))}
                        placeholder="16:00"
                        style={{ width: 76 }}
                      />
                      <Button size="small" appearance="subtle" icon={<DeleteRegular />} onClick={() => setDayRanges(key, ranges.filter((_, idx) => idx !== i))} />
                    </div>
                  ))}
                  <Button size="small" appearance="subtle" disabled={ranges.length >= 4} onClick={() => setDayRanges(key, [...ranges, { start: '08:00', end: '17:00' }])}>
                    + hours
                  </Button>
                </div>
              );
            })}
          </div>
          <Checkbox
            label="Complement (fires outside these hours, not during them - this is what makes it an after-hours schedule)"
            checked={!!value.weekly.complement}
            onChange={(_, d) => onChange({ ...value, weekly: { ...value.weekly!, complement: !!d.checked } })}
          />
        </>
      )}
      {value.type === 'fixed' && value.fixed && (
        <div>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <Text weight="semibold" size={200}>
              Date ranges
            </Text>
            <Button
              size="small"
              appearance="subtle"
              disabled={value.fixed.ranges.length >= 10}
              onClick={() => onChange({ ...value, fixed: { ranges: [...value.fixed!.ranges, { start: '', end: '' }] } })}
            >
              Add range
            </Button>
          </div>
          {value.fixed.ranges.map((r, i) => (
            <div key={i} style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 6 }}>
              <Input
                value={r.start}
                onChange={(_, d) => onChange({ ...value, fixed: { ranges: value.fixed!.ranges.map((rr, idx) => (idx === i ? { ...rr, start: d.value } : rr)) } })}
                placeholder="2026-12-25T00:00:00"
                style={{ minWidth: 190 }}
              />
              <Text size={200}>–</Text>
              <Input
                value={r.end}
                onChange={(_, d) => onChange({ ...value, fixed: { ranges: value.fixed!.ranges.map((rr, idx) => (idx === i ? { ...rr, end: d.value } : rr)) } })}
                placeholder="2026-12-26T00:00:00"
                style={{ minWidth: 190 }}
              />
              <Button
                size="small"
                appearance="subtle"
                icon={<DeleteRegular />}
                onClick={() => onChange({ ...value, fixed: { ranges: value.fixed!.ranges.filter((_, idx) => idx !== i) } })}
              />
            </div>
          ))}
          {value.fixed.ranges.length === 0 && (
            <Text size={200} style={{ color: '#616161', display: 'block', marginTop: 6 }}>
              No date ranges yet.
            </Text>
          )}
        </div>
      )}
    </div>
  );
}

function AutoAttendantSettingsDialog({
  tenantId,
  base,
  siteId,
  row,
  onClose,
  onSaved,
}: {
  tenantId: string;
  base: string;
  siteId: string;
  row: Row;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [operator, setOperator] = useState<AutoAttendantCallableEntity | undefined>((row.operator as AutoAttendantCallableEntity | null) ?? undefined);
  const [defaultCallFlow, setDefaultCallFlow] = useState<AutoAttendantCallFlow>(
    (row.default_call_flow as AutoAttendantCallFlow | null) ?? { greetings: [], menu: { options: [] } },
  );
  const initialAfterHours = row.after_hours_call_flow as AutoAttendantCallFlow | null;
  const [afterHoursEnabled, setAfterHoursEnabled] = useState(!!initialAfterHours);
  const [afterHoursCallFlow, setAfterHoursCallFlow] = useState<AutoAttendantCallFlow>(initialAfterHours ?? { greetings: [], menu: { options: [] } });
  const [schedule, setSchedule] = useState<AutoAttendantSchedule>((row.schedule as AutoAttendantSchedule | null) ?? { type: 'weekly', weekly: emptyWeekly() });
  const [holidays, setHolidays] = useState<AutoAttendantHolidayCallFlow[]>(
    Array.isArray(row.holiday_call_flows) ? (row.holiday_call_flows as AutoAttendantHolidayCallFlow[]).slice() : [],
  );
  const [resourceAccounts, setResourceAccounts] = useState<string[]>(
    Array.isArray(row.resource_accounts) ? (row.resource_accounts as string[]).slice() : [],
  );
  const [err, setErr] = useState<string | null>(null);

  // Same-site AA/CQ choices for menu-option/-Operator targets - this row excluded
  // from its own AA list (an AA can't transfer to itself).
  const aaQ = useQuery({
    queryKey: ['auto-attendants', tenantId, siteId, 'for-target-picker'],
    queryFn: () => api<Paginated<Row>>(`${base}/auto-attendants?siteId=${siteId}&limit=500`),
  });
  const cqQ = useQuery({
    queryKey: ['call-queues', tenantId, siteId, 'for-target-picker'],
    queryFn: () => api<Paginated<Row>>(`${base}/call-queues?siteId=${siteId}&limit=500`),
  });
  const aaChoices = (aaQ.data?.items ?? []).filter((r) => r.id !== row.id).map((r) => ({ id: String(r.id), name: String(r.name) }));
  const cqChoices = (cqQ.data?.items ?? []).map((r) => ({ id: String(r.id), name: String(r.name) }));

  // Only Auto Attendant-kind resource accounts on this site can be linked -
  // same pattern as CallQueueSettingsDialog's own raQ/raChoices. An AA can
  // have several resource accounts, or none yet, exactly like a Call Queue.
  const raQ = useQuery({
    queryKey: ['resource-accounts', tenantId, siteId, 'for-auto-attendant'],
    queryFn: () => api<Paginated<Row>>(`${base}/resource-accounts?siteId=${siteId}&limit=500`),
  });
  const raChoices = (raQ.data?.items ?? []).filter((r) => r.kind === 'auto_attendant');
  const toggleRa = (id: string) =>
    setResourceAccounts((cur) => (cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id]));

  const save = useMutation({
    mutationFn: () =>
      api(`${base}/auto-attendants/${row.id}`, {
        method: 'PATCH',
        body: JSON.stringify({
          operator: operator ?? null,
          default_call_flow: defaultCallFlow,
          after_hours_call_flow: afterHoursEnabled ? afterHoursCallFlow : null,
          schedule: afterHoursEnabled ? schedule : null,
          holiday_call_flows: holidays,
          resource_accounts: resourceAccounts,
        }),
      }),
    onSuccess: onSaved,
    onError: (e) => setErr(e instanceof ApiError ? e.message : 'Failed'),
  });

  const addHoliday = () =>
    setHolidays((h) => [
      ...h,
      { name: `Holiday ${h.length + 1}`, callFlow: { greetings: [], menu: { options: [] } }, schedule: { type: 'fixed', fixed: { ranges: [] } } },
    ]);
  const updateHoliday = (i: number, patch: Partial<AutoAttendantHolidayCallFlow>) => setHolidays((h) => h.map((x, idx) => (idx === i ? { ...x, ...patch } : x)));
  const removeHoliday = (i: number) => setHolidays((h) => h.filter((_, idx) => idx !== i));

  return (
    <Dialog open onOpenChange={(_, d) => !d.open && onClose()}>
      <DialogSurface style={{ maxWidth: 780 }}>
        <DialogBody>
          <DialogTitle>Auto Attendant call flow — {String(row.name)}</DialogTitle>
          <DialogContent>
            <div style={{ display: 'grid', gap: 20, minWidth: 700, maxHeight: '65vh', overflowY: 'auto', paddingRight: 4 }}>
              <div>
                <Text weight="semibold">Operator (optional)</Text>
                <div style={{ marginTop: 6 }}>
                  <CallableEntityEditor tenantId={tenantId} value={operator} onChange={setOperator} aaChoices={aaChoices} cqChoices={cqChoices} />
                </div>
              </div>

              <div>
                <Text weight="semibold">Business hours</Text>
                <div style={{ marginTop: 6 }}>
                  <CallFlowEditor tenantId={tenantId} value={defaultCallFlow} onChange={setDefaultCallFlow} aaChoices={aaChoices} cqChoices={cqChoices} />
                </div>
              </div>

              <div>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <Text weight="semibold">After hours</Text>
                  <Checkbox label="Has its own after-hours call flow" checked={afterHoursEnabled} onChange={(_, d) => setAfterHoursEnabled(!!d.checked)} />
                </div>
                {afterHoursEnabled && (
                  <div style={{ display: 'grid', gap: 12, marginTop: 6 }}>
                    <CallFlowEditor tenantId={tenantId} value={afterHoursCallFlow} onChange={setAfterHoursCallFlow} aaChoices={aaChoices} cqChoices={cqChoices} />
                    <div>
                      <Text weight="semibold" size={200}>
                        Schedule (when this fires)
                      </Text>
                      <ScheduleEditor value={schedule} onChange={setSchedule} />
                    </div>
                  </div>
                )}
              </div>

              <div>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <Text weight="semibold">Holidays</Text>
                  <Button size="small" appearance="subtle" disabled={holidays.length >= 10} onClick={addHoliday}>
                    Add holiday
                  </Button>
                </div>
                <div style={{ display: 'grid', gap: 12, marginTop: 6 }}>
                  {holidays.map((h, i) => (
                    <Card key={i} style={{ padding: 12 }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'end', gap: 8 }}>
                        <Field label="Name" style={{ flex: 1 }}>
                          <Input value={h.name} onChange={(_, d) => updateHoliday(i, { name: d.value })} />
                        </Field>
                        <Button size="small" appearance="subtle" icon={<DeleteRegular />} onClick={() => removeHoliday(i)} />
                      </div>
                      <div style={{ marginTop: 8 }}>
                        <CallFlowEditor tenantId={tenantId} value={h.callFlow} onChange={(cf) => updateHoliday(i, { callFlow: cf })} aaChoices={aaChoices} cqChoices={cqChoices} />
                      </div>
                      <div style={{ marginTop: 8 }}>
                        <Text weight="semibold" size={200}>
                          Dates
                        </Text>
                        <ScheduleEditor value={h.schedule} onChange={(sc) => updateHoliday(i, { schedule: sc })} />
                      </div>
                    </Card>
                  ))}
                  {holidays.length === 0 && (
                    <Text size={200} style={{ color: '#616161' }}>
                      No holiday call flows yet.
                    </Text>
                  )}
                </div>
              </div>

              <div>
                <Text weight="semibold">Linked resource accounts (phone numbers)</Text>
                {raQ.isLoading ? (
                  <Spinner size="tiny" label="Loading…" />
                ) : raChoices.length === 0 ? (
                  <Text size={200} style={{ color: '#616161', display: 'block', marginTop: 6 }}>
                    No Auto Attendant-kind resource accounts on this site yet - add one on the Resource accounts tab.
                  </Text>
                ) : (
                  <div style={{ display: 'grid', gap: 4, marginTop: 6 }}>
                    {raChoices.map((r) => (
                      <Checkbox
                        key={String(r.id)}
                        label={`${r.display_name ?? r.upn}${r.upn ? ` (${r.upn})` : ''}`}
                        checked={resourceAccounts.includes(String(r.id))}
                        onChange={() => toggleRa(String(r.id))}
                      />
                    ))}
                  </div>
                )}
              </div>

              {err && (
                <Text block style={{ color: tokens.colorPaletteRedForeground1 }}>
                  {err}
                </Text>
              )}
            </div>
          </DialogContent>
          <DialogActions>
            <DialogTrigger disableButtonEnhancement>
              <Button appearance="secondary" onClick={onClose}>
                Cancel
              </Button>
            </DialogTrigger>
            <Button appearance="primary" disabled={save.isPending} onClick={() => save.mutate()}>
              {save.isPending ? 'Saving…' : 'Save'}
            </Button>
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
}

