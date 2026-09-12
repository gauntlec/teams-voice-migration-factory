import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useParams } from 'react-router-dom';
import {
  Badge,
  Button,
  Card,
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
import { ArrowLeftRegular, CheckmarkCircleRegular, WarningRegular } from '@fluentui/react-icons';
import {
  NUMBER_TYPES,
  POLICY_KIND_TO_TENANT_TYPE,
  POLICY_KINDS,
  RESOURCE_ACCOUNT_KINDS,
  VOICEMAIL_PROMPT_LANGUAGES,
  type BuildRowValidation,
  type BuildSiteRollup,
  type Paginated,
  type TenantPolicySummary,
} from '@tvmf/shared';
import { api, ApiError } from '../api';
import { useAuth } from '../auth';
import { Page } from '../components/Page';
import {
  LoadError,
  NoTenant,
  PagedSection,
  buildBulkPayload,
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
  const issues = v.unknownPolicies.length + v.policyMismatches.length + (v.numberConflict ? 1 : 0);
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

  const populate = useMutation({
    mutationFn: (kind: 'users' | 'caps' | 'resource-accounts') =>
      api(`${base}/${kind}/populate`, { method: 'POST', body: JSON.stringify({ site_id: siteId }) }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['users', tid, siteId] });
      qc.invalidateQueries({ queryKey: ['caps', tid, siteId] });
      qc.invalidateQueries({ queryKey: ['resource-accounts', tid, siteId] });
      qc.invalidateQueries({ queryKey: ['build-summary', tid] });
    },
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
              </>
            )
          }
          columns={[
            { key: 'upn', label: 'UPN' },
            { key: 'display_name', label: 'Name' },
            { key: 'e164', label: 'Number' },
            { key: 'phone_model', label: 'Model' },
            ...policyColumns(),
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

const UNCHANGED = '__unchanged__';

/**
 * Select many rows, set a handful of fields once, apply to all of them in
 * one request - the bulk-edit flow (BuildSiteWorkspace, "Bulk edit (N
 * selected)"). Deliberately not a mode of the shared RecordDialog
 * (records.tsx): that component's blast radius is every page in the app,
 * and the semantics genuinely differ - RecordDialog seeds from one real row
 * and a blank field means "clear it"; here there's no single row to seed
 * from, and a field left alone must mean "don't touch any selected row",
 * the opposite convention (see buildBulkPayload). A boolean field can't
 * reuse a plain two-state Switch for the same reason - it needs a real
 * third "leave unchanged" state, not a default of off.
 */
function BulkEditDialog({
  open,
  onOpenChange,
  kindLabel,
  fields,
  count,
  saving,
  error,
  onSave,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  kindLabel: string;
  fields: FieldDef[];
  count: number;
  saving: boolean;
  error: string | null;
  onSave: (payload: Record<string, unknown>) => void;
}) {
  const [values, setValues] = useState<Record<string, string>>({});
  useEffect(() => {
    if (open) setValues({});
  }, [open]);

  const set = (key: string, v: string) => setValues((prev) => ({ ...prev, [key]: v === UNCHANGED ? '' : v }));
  const touched = Object.values(values).some((v) => v !== '');

  return (
    <Dialog open={open} onOpenChange={(_, d) => onOpenChange(d.open)}>
      <DialogSurface>
        <DialogBody>
          <DialogTitle>
            Bulk edit {kindLabel} ({count} selected)
          </DialogTitle>
          <DialogContent>
            <Text size={200} block style={{ marginBottom: 12 }}>
              Only the fields you set below will change. Leave a field on “— leave unchanged —” (or blank) to skip
              it - every other selected row's value for that field stays exactly as it is.
            </Text>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
              {fields.map((f) => {
                const value = values[f.key] ?? '';
                const wide = f.full ? { gridColumn: '1 / -1' } : undefined;
                if (f.type === 'boolean') {
                  return (
                    <Field key={f.key} label={f.label} style={wide}>
                      <Dropdown
                        value={value === 'true' ? 'On' : value === 'false' ? 'Off' : '— leave unchanged —'}
                        selectedOptions={[value || UNCHANGED]}
                        onOptionSelect={(_, d) => set(f.key, d.optionValue ?? UNCHANGED)}
                      >
                        <Option value={UNCHANGED}>— leave unchanged —</Option>
                        <Option value="true">On</Option>
                        <Option value="false">Off</Option>
                      </Dropdown>
                    </Field>
                  );
                }
                if (f.type === 'select' || f.type === 'ref') {
                  const choices: Choice[] =
                    f.type === 'select'
                      ? (f.options ?? []).map((o) => ({ value: o, label: o }))
                      : typeof f.choices === 'function'
                        ? f.choices(null)
                        : (f.choices ?? []);
                  return (
                    <Field key={f.key} label={f.label} style={wide}>
                      <Dropdown
                        value={choices.find((c) => c.value === value)?.label ?? '— leave unchanged —'}
                        selectedOptions={[value || UNCHANGED]}
                        onOptionSelect={(_, d) => set(f.key, d.optionValue ?? UNCHANGED)}
                      >
                        <Option value={UNCHANGED}>— leave unchanged —</Option>
                        {choices.map((c) => (
                          <Option key={c.value} value={c.value} text={c.label}>
                            {c.label}
                          </Option>
                        ))}
                      </Dropdown>
                    </Field>
                  );
                }
                if (f.type === 'textarea') {
                  return (
                    <Field key={f.key} label={f.label} style={wide}>
                      <Textarea
                        value={value}
                        placeholder="Leave blank to skip"
                        onChange={(_, d) => set(f.key, d.value)}
                      />
                    </Field>
                  );
                }
                return (
                  <Field key={f.key} label={f.label} style={wide}>
                    <Input value={value} placeholder="Leave blank to skip" onChange={(_, d) => set(f.key, d.value)} />
                  </Field>
                );
              })}
            </div>
            {error && (
              <Text block style={{ color: tokens.colorPaletteRedForeground1, marginTop: 8 }}>
                {error}
              </Text>
            )}
          </DialogContent>
          <DialogActions>
            <DialogTrigger disableButtonEnhancement>
              <Button appearance="secondary">Cancel</Button>
            </DialogTrigger>
            <Button
              appearance="primary"
              disabled={saving || !touched || count === 0}
              onClick={() => onSave(buildBulkPayload(fields, values))}
            >
              {saving ? 'Applying…' : `Apply to ${count} row${count === 1 ? '' : 's'}`}
            </Button>
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
}
