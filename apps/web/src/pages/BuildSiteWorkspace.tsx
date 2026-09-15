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
  BUSY_ON_BUSY_OPTIONS,
  CALL_FORWARDING_TYPES,
  CALL_GROUP_ORDERS,
  CALL_TARGET_TYPES,
  NUMBER_TYPES,
  POLICY_KIND_TO_TENANT_TYPE,
  POLICY_KINDS,
  RESOURCE_ACCOUNT_KINDS,
  VOICEMAIL_PROMPT_LANGUAGES,
  type BuildRowValidation,
  type BuildSiteRollup,
  type CallDelegate,
  type CallForwardingSettings,
  type Paginated,
  type PickupGroupSettings,
  type PolicyKey,
  type TenantPolicySummary,
} from '@tvmf/shared';
import { api, ApiError } from '../api';
import { useAuth } from '../auth';
import { Page } from '../components/Page';
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
  const delegates = (r.delegates as CallDelegate[] | null) ?? [];
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
  const [tab, setTab] = useState<'users' | 'caps' | 'resource-accounts'>('users');

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
      qc.invalidateQueries({ queryKey: ['build-summary', tid] });
    },
    // Most commonly assertCallingPoliciesMapped - some calling policies used
    // on this site aren't mapped to a real tenant policy yet (see the
    // Calling policy map panel below).
    onError: (e) => setPopulateError(e instanceof ApiError ? e.message : 'Populate failed'),
  });
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
      {callingSettingsFor && (
        <CallingSettingsDialog
          endpoint={callingSettingsFor.endpoint}
          row={callingSettingsFor.row}
          onClose={() => setCallingSettingsFor(null)}
          onSaved={() => {
            qc.invalidateQueries({ queryKey: callingSettingsFor.queryKey });
            setCallingSettingsFor(null);
          }}
        />
      )}

      <TabList selectedValue={tab} onTabSelect={(_, d) => setTab(d.value as typeof tab)}>
        <Tab value="users">Users</Tab>
        <Tab value="caps">Common area phones</Tab>
        <Tab value="resource-accounts">Resource accounts</Tab>
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
          hint="Identity + number for Auto Attendant / Call Queue resource accounts. Creating one always needs a manual licensing step - see the note below."
          endpoint={`${base}/resource-accounts`}
          queryKey={['resource-accounts', tid, siteId]}
          params={{ siteId }}
          fixed={{ site_id: siteId }}
          readOnly={!canWrite}
          headerActions={
            canWrite && (
              <Button size="small" disabled={populate.isPending} onClick={() => populate.mutate('resource-accounts')}>
                Populate from Discovery
              </Button>
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
                ) : (
                  <Badge appearance="tint" color="informative">
                    not yet created
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
      {tab === 'resource-accounts' && (
        <Card className={s.card}>
          <Text size={200} className={s.muted}>
            New-CsOnlineApplicationInstance always needs a Phone System license applied by a
            User/Global Admin - a role a Teams Administrator doesn't have. Running a deployment
            on this site generates a script for that step (see the Deployment page); once it's
            run and the account is licensed, tick "Created &amp; licensed" above so the number and
            voice routing policy can be assigned live on the next run.
          </Text>
        </Card>
      )}
    </Page>
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
  endpoint,
  row,
  onClose,
  onSaved,
}: {
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
  const [pgTargetsRaw, setPgTargetsRaw] = useState(pg?.targets?.join(', ') ?? '');

  const [delegates, setDelegates] = useState<CallDelegate[]>(((row.delegates as CallDelegate[] | null) ?? []).slice());

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

      const targets = pgTargetsRaw
        .split(',')
        .map((t) => t.trim())
        .filter(Boolean);
      const pickup_group = targets.length ? { order: pgOrder as (typeof CALL_GROUP_ORDERS)[number], targets } : undefined;

      return api(`${endpoint}/${row.id}`, {
        method: 'PATCH',
        // call_forwarding/delegates are always sent (even {}/[]) so this dialog
        // can explicitly clear a previously-designed setting, not just add one.
        // pickup_group can't represent "cleared" (order is required whenever
        // the object is present at all) - see the hint under that field.
        body: JSON.stringify({ call_forwarding, pickup_group, delegates }),
      });
    },
    onSuccess: onSaved,
    onError: (e) => setErr(e instanceof ApiError ? e.message : 'Failed'),
  });

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
                          <Input value={fwdTarget} onChange={(_, d) => setFwdTarget(d.value)} style={{ minWidth: 200 }} />
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
                          <Input value={unaTarget} onChange={(_, d) => setUnaTarget(d.value)} style={{ minWidth: 200 }} />
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
                <Text weight="semibold">Pickup group (call group)</Text>
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'end', marginTop: 6 }}>
                  <Field label="Order">
                    <Dropdown value={pgOrder} selectedOptions={[pgOrder]} onOptionSelect={(_, d) => setPgOrder(d.optionValue ?? '')}>
                      {CALL_GROUP_ORDERS.map((o) => (
                        <Option key={o} value={o}>
                          {o}
                        </Option>
                      ))}
                    </Dropdown>
                  </Field>
                  <Field
                    label="Members (UPNs)"
                    hint="Comma-separated. Clearing this leaves a previously-saved group untouched - removing all members isn't deployed automatically yet."
                  >
                    <Input value={pgTargetsRaw} onChange={(_, d) => setPgTargetsRaw(d.value)} style={{ minWidth: 260 }} />
                  </Field>
                </div>
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
                    <Input
                      placeholder="delegate@contoso.com"
                      value={d.delegateUpn}
                      onChange={(_, ev) => updateDelegate(i, { delegateUpn: ev.value })}
                      style={{ minWidth: 200 }}
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

