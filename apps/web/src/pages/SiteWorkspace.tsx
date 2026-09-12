import { useEffect, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
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
  SearchBox,
  Spinner,
  Tab,
  TabList,
  TableBody,
  TableCell,
  TableHeader,
  TableHeaderCell,
  TableRow,
  Text,
  Textarea,
} from '@fluentui/react-components';
import {
  ArrowLeftRegular,
  ArrowUploadRegular,
  DeleteRegular,
  LinkRegular,
  WarningRegular,
} from '@fluentui/react-icons';
import {
  CALLER_ID_OPTIONS,
  FLOW_KINDS,
  LICENSING_MODELS,
  NETWORK_LOCATIONS,
  NETWORK_SCOPES,
  NETWORK_TYPES,
  NUMBER_RANGE_KINDS,
  RESOURCE_ACCOUNT_KINDS,
  SITE_REGIONS,
  VOICEMAIL_PROMPT_LANGUAGES,
  type DiscoverySiteOverview,
  type Paginated,
  type TenantUserSummary,
} from '@tvmf/shared';
import { api, ApiError } from '../api';
import { useAuth } from '../auth';
import { DataTable } from '../components/DataTable';
import { ImportUsersDialog } from '../components/ImportUsersDialog';
import { Page } from '../components/Page';
import { NetworkDiagram, type NetworkRow } from '../components/NetworkDiagram';
import {
  LoadError,
  NoTenant,
  PagedSection,
  useRecordStyles,
  type Choice,
  type FieldDef,
  type Row,
} from '../components/records';

interface StaffMember {
  id: string;
  displayName: string;
  role: string;
}

interface SiteSummary {
  site: {
    id: string;
    sitecode: string;
    name: string | null;
    address: string | null;
    country: string | null;
    region: string | null;
  };
  status: 'draft' | 'submitted' | 'accepted';
  callingPolicies: (Row & { name: string })[];
  numberSummary: { total: number; available: number; reserved: number; assigned: number };
  overview: DiscoverySiteOverview;
  assignedStaff: StaffMember[];
}

const TABS = [
  'overview',
  'ranges',
  'numbers',
  'users',
  'caps',
  'resource-accounts',
  'network',
  'flows',
] as const;
type TabKey = (typeof TABS)[number];

/** Last 10 significant digits — for loosely matching a requested vs assigned number. */
const numKey = (v: unknown) => String(v ?? '').replace(/\D/g, '').slice(-10);

const TAB_LABEL: Record<TabKey, string> = {
  overview: 'Overview',
  ranges: 'Number ranges',
  numbers: 'Numbers',
  users: 'Users',
  caps: 'Common area phones',
  'resource-accounts': 'Resource accounts',
  network: 'Network (E911)',
  flows: 'Call flows',
};

/**
 * "Link to tenant" — matches every unlinked Data Collection user for this site
 * to the tenant user with the same UPN (from the last Discovery run).
 */
function RelinkUsersButton({
  base,
  siteId,
  disabled,
  onDone,
}: {
  base: string;
  siteId: string;
  disabled: boolean;
  onDone: () => void;
}) {
  const [msg, setMsg] = useState<string | null>(null);
  const relink = useMutation({
    mutationFn: () =>
      api<{ linked: number; unmatched: number }>(`${base}/users/relink`, {
        method: 'POST',
        body: JSON.stringify({ site_id: siteId }),
      }),
    onSuccess: (r) => {
      setMsg(
        `Linked ${r.linked}` +
          (r.unmatched ? ` · ${r.unmatched} with no match in the last Discovery run` : ''),
      );
      onDone();
      setTimeout(() => setMsg(null), 6000);
    },
    onError: (e) => setMsg(e instanceof ApiError ? e.message : 'Link failed'),
  });
  return (
    <>
      <Button
        size="small"
        icon={<LinkRegular />}
        disabled={disabled || relink.isPending}
        onClick={() => {
          setMsg(null);
          relink.mutate();
        }}
        title="Link users to the matching tenant user by UPN"
      >
        {relink.isPending ? 'Linking…' : 'Link to tenant'}
      </Button>
      {msg && (
        <Text size={200} style={{ color: '#606060' }}>
          {msg}
        </Text>
      )}
    </>
  );
}

export function SiteWorkspace() {
  const s = useRecordStyles();
  const { siteId = '' } = useParams();
  const { activeTenantId, can } = useAuth();
  const qc = useQueryClient();
  const [tab, setTab] = useState<TabKey>('overview');
  const [importOpen, setImportOpen] = useState(false);

  const tid = activeTenantId;
  const base = `/t/${tid}/discovery`;

  const summary = useQuery({
    queryKey: ['site-summary', tid, siteId],
    enabled: !!tid && !!siteId,
    queryFn: () => api<SiteSummary>(`${base}/sites/${siteId}`),
  });

  // Available numbers for this site, for the phone-number pickers.
  const avail = useQuery({
    queryKey: ['site-avail-numbers', tid, siteId],
    enabled: !!tid && !!siteId,
    queryFn: () =>
      api<Paginated<{ id: string; e164: string }>>(
        `${base}/numbers?siteId=${siteId}&status=available&limit=200`,
      ),
  });

  const availableChoices: Choice[] = useMemo(
    () => (avail.data?.items ?? []).map((n) => ({ value: n.id, label: n.e164 })),
    [avail.data],
  );
  const numberChoicesFor = (row: Row | null): Choice[] => {
    const cur =
      row && row.phone_number_id
        ? [{ value: String(row.phone_number_id), label: `${row.phone_number} (current)` }]
        : [];
    return [...cur, ...availableChoices];
  };

  if (!tid) return <NoTenant />;
  if (summary.isLoading) return <Spinner label="Loading site…" />;
  if (summary.isError) return <LoadError message={(summary.error as Error).message} />;

  const { site, status, callingPolicies, numberSummary, overview, assignedStaff } = summary.data!;
  const canReview = can('discovery:review');
  const locked = !can('discovery:write') || status === 'accepted' || (status === 'submitted' && !canReview);
  const canManageOverview = can('discovery:sites:manage');

  const policyChoices: Choice[] = callingPolicies.map((p) => ({ value: p.id, label: p.name }));
  const policyName = (id: unknown) => callingPolicies.find((p) => p.id === id)?.name ?? '—';
  const yesNo = (v: unknown) => (v ? 'Yes' : 'No');

  const refreshSummary = () => summary.refetch();

  return (
    <Page
      title={site.name || site.sitecode}
      subtitle={[site.sitecode, site.address, site.country].filter(Boolean).join(' · ')}
      actions={
        <Link to="/data-collection">
          <Button appearance="subtle" icon={<ArrowLeftRegular />}>
            All sites
          </Button>
        </Link>
      }
    >
      <div className={s.summary}>
        <Text size={200}>
          Numbers: <b>{numberSummary.total}</b>
        </Text>
        <Text size={200}>
          Available: <b>{numberSummary.available}</b>
        </Text>
        <Text size={200}>
          Reserved: <b>{numberSummary.reserved}</b>
        </Text>
        <Text size={200}>
          Assigned: <b>{numberSummary.assigned}</b>
        </Text>
        {locked && (
          <Badge appearance="tint" color="warning">
            {status === 'accepted' ? 'accepted — locked' : 'submitted — read-only'}
          </Badge>
        )}
      </div>

      <TabList selectedValue={tab} onTabSelect={(_, d) => setTab(d.value as TabKey)}>
        {TABS.map((t) => (
          <Tab key={t} value={t}>
            {TAB_LABEL[t]}
          </Tab>
        ))}
      </TabList>

      {tab === 'overview' && (
        <OverviewTab
          base={base}
          siteId={siteId}
          overview={overview}
          assignedStaff={assignedStaff}
          canEdit={canManageOverview}
          locked={locked}
          onSaved={refreshSummary}
        />
      )}

      {tab === 'ranges' && (
        <PagedSection
          title="Number ranges"
          hint="Creating a range generates its individual numbers into this site's inventory."
          endpoint={`${base}/number-ranges`}
          queryKey={['ranges', tid, siteId]}
          params={{ siteId }}
          fixed={{ sitecode: site.sitecode }}
          readOnly={locked}
          onChanged={refreshSummary}
          columns={[
            { key: 'range_start', label: 'From' },
            { key: 'range_end', label: 'To' },
            { key: 'kind', label: 'Kind' },
            {
              key: 'size',
              label: 'Numbers',
              render: (r) => String((r as Row & { counts: { total: number } }).counts?.total ?? 0),
            },
            {
              key: 'assigned',
              label: 'Assigned',
              render: (r) =>
                String((r as Row & { counts: { assigned: number } }).counts?.assigned ?? 0),
            },
            { key: 'carrier', label: 'Carrier' },
            {
              key: 'loa',
              label: 'LOA',
              render: (r) => `${r.loa_sent ? 'sent' : '—'} / ${r.loa_completed ? 'done' : '—'}`,
            },
          ]}
          fields={[
            { key: 'range_start', label: 'Range start', required: true, placeholder: '19133743250' },
            { key: 'range_end', label: 'Range end', required: true, placeholder: '19133743257' },
            { key: 'kind', label: 'Kind', type: 'select', options: NUMBER_RANGE_KINDS, required: true },
            { key: 'carrier', label: 'Carrier' },
            { key: 'loa_sent', label: 'LOA sent to customer', type: 'boolean' },
            { key: 'loa_completed', label: 'LOA completed', type: 'boolean' },
            { key: 'comments', label: 'Comments', type: 'textarea', full: true },
          ]}
        />
      )}

      {tab === 'numbers' && (
        <NumberInventory base={base} siteId={siteId} locked={locked} onChanged={refreshSummary} />
      )}

      {tab === 'users' && (
        <PagedSection
          title="Users"
          hint="Teams users with Enterprise Voice. Each holds at most one number from this site's inventory."
          endpoint={`${base}/users`}
          queryKey={['users', tid, siteId]}
          params={{ siteId }}
          fixed={{ site_id: siteId }}
          readOnly={locked}
          onChanged={refreshSummary}
          headerActions={
            <>
              <RelinkUsersButton
                base={base}
                siteId={siteId}
                disabled={locked}
                onDone={() => {
                  qc.invalidateQueries({ queryKey: ['users', tid, siteId] });
                  refreshSummary();
                }}
              />
              {!locked && (
                <Button
                  size="small"
                  icon={<ArrowUploadRegular />}
                  onClick={() => setImportOpen(true)}
                >
                  Import from Excel…
                </Button>
              )}
            </>
          }
          columns={[
            { key: 'upn', label: 'UPN' },
            { key: 'display_name', label: 'Name' },
            {
              key: 'phone_number',
              label: 'Number',
              render: (r) => {
                const linked = (r.phone_number as string | null) ?? null;
                const requested = (r.requested_number as string | null) ?? null;
                const mismatch =
                  requested &&
                  numKey(requested) !== numKey(linked ?? '') &&
                  numKey(requested) !== '';
                return (
                  <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
                    {linked ?? '—'}
                    {mismatch && (
                      <Badge
                        appearance="tint"
                        color="warning"
                        size="small"
                        icon={<WarningRegular />}
                        title="The number the customer requested isn't the one assigned here — reconcile in Design & Build."
                      >
                        Requested {requested}
                      </Badge>
                    )}
                  </span>
                );
              },
            },
            {
              key: 'calling_policy_id',
              label: 'Calling policy',
              render: (r) => policyName(r.calling_policy_id),
            },
            { key: 'caller_id', label: 'Caller ID' },
            { key: 'voicemail_enabled', label: 'Voicemail', render: (r) => yesNo(r.voicemail_enabled) },
            {
              key: 'tenant_user_id',
              label: 'Tenant',
              render: (r) =>
                r.tenant_user_id ? (
                  <Badge appearance="tint" color="success" size="small">
                    Linked
                  </Badge>
                ) : (
                  '—'
                ),
            },
          ]}
          suggest={{
            field: 'upn',
            run: async (upn) => {
              const hit = await api<TenantUserSummary | null>(
                `/t/${tid}/tenant-discovery/users/lookup?upn=${encodeURIComponent(upn)}`,
              );
              if (!hit) return { found: false, note: 'Not found in the last Discovery run.' };
              const bits = [
                hit.line_uri ? hit.line_uri.replace(/^tel:/, '') : null,
                hit.enterprise_voice_enabled ? 'Enterprise Voice on' : 'Enterprise Voice off',
                hit.policies?.TeamsCallingPolicy ? `Calling policy ${hit.policies.TeamsCallingPolicy}` : null,
                hit.department,
              ].filter(Boolean);
              return {
                found: true,
                values: { display_name: hit.display_name ?? '' },
                note: `Found in tenant: ${bits.join(' · ')}`,
              };
            },
          }}
          fields={[
            { key: 'upn', label: 'M365 UPN', required: true, placeholder: 'user@customer.com' },
            { key: 'display_name', label: 'Display name' },
            { key: 'phone_number_id', label: 'Phone number', type: 'ref', choices: numberChoicesFor },
            {
              key: 'requested_number',
              label: 'Requested number',
              placeholder: '+441234567890',
            },
            { key: 'calling_policy_id', label: 'Calling policy', type: 'ref', choices: policyChoices },
            { key: 'caller_id', label: 'Caller ID', type: 'select', options: CALLER_ID_OPTIONS },
            { key: 'voicemail_enabled', label: 'Voicemail enabled', type: 'boolean', default: 'true' },
            {
              key: 'voicemail_language',
              label: 'Voicemail language',
              type: 'ref',
              // Culture codes only - Teams rejects a plain name like "English".
              choices: VOICEMAIL_PROMPT_LANGUAGES.map((l) => ({ value: l.code, label: `${l.label} (${l.code})` })),
            },
            { key: 'requires_handset', label: 'Requires a physical handset', type: 'boolean' },
            { key: 'handset_model', label: 'Handset model' },
            { key: 'access_port_id', label: 'Access port ID' },
            { key: 'comments', label: 'Comments', type: 'textarea', full: true },
          ]}
        />
      )}

      {importOpen && (
        <ImportUsersDialog
          base={base}
          siteId={siteId}
          availableE164={availableChoices.map((c) => c.label)}
          policyNames={callingPolicies.map((p) => p.name)}
          onClose={() => setImportOpen(false)}
          onDone={() => {
            qc.invalidateQueries({ queryKey: ['users', tid, siteId] });
            refreshSummary();
          }}
        />
      )}

      {tab === 'caps' && (
        <PagedSection
          title="Common area phones"
          hint="Shared / lobby / meeting-room phones. Each holds at most one number."
          endpoint={`${base}/caps`}
          queryKey={['caps', tid, siteId]}
          params={{ siteId }}
          fixed={{ site_id: siteId }}
          readOnly={locked}
          onChanged={refreshSummary}
          columns={[
            { key: 'display_name', label: 'Display name' },
            { key: 'phone_number', label: 'Number' },
            { key: 'device_model', label: 'Device' },
            {
              key: 'calling_policy_id',
              label: 'Calling policy',
              render: (r) => policyName(r.calling_policy_id),
            },
            { key: 'caller_id', label: 'Caller ID' },
          ]}
          fields={[
            { key: 'display_name', label: 'Display name', required: true },
            { key: 'upn', label: 'UPN (if known)' },
            { key: 'phone_number_id', label: 'Phone number', type: 'ref', choices: numberChoicesFor },
            { key: 'device_model', label: 'Device model' },
            { key: 'calling_policy_id', label: 'Calling policy', type: 'ref', choices: policyChoices },
            { key: 'caller_id', label: 'Caller ID', type: 'select', options: CALLER_ID_OPTIONS },
            { key: 'access_port_id', label: 'Access port ID' },
            { key: 'comments', label: 'Comments', type: 'textarea', full: true },
          ]}
        />
      )}

      {tab === 'resource-accounts' && (
        <PagedSection
          title="Resource accounts"
          hint="Auto attendants & call queues. May hold several numbers — use the Numbers button."
          endpoint={`${base}/resource-accounts`}
          queryKey={['ras', tid, siteId]}
          params={{ siteId }}
          fixed={{ site_id: siteId }}
          readOnly={locked}
          onChanged={refreshSummary}
          extraRowAction={(r) =>
            !locked ? (
              <RaNumbersButton
                ra={r as Row & { name: string; phone_numbers: { id: string; e164: string }[] }}
                available={availableChoices}
                base={base}
                onChanged={() => {
                  refreshSummary();
                  avail.refetch();
                }}
              />
            ) : null
          }
          columns={[
            { key: 'name', label: 'Name' },
            { key: 'kind', label: 'Kind' },
            {
              key: 'phone_numbers',
              label: 'Numbers',
              render: (r) =>
                (r.phone_numbers as { e164: string }[])?.map((n) => n.e164).join(', ') || '—',
            },
            { key: 'business_hours', label: 'Business hours' },
            { key: 'who_answers', label: 'Who answers' },
          ]}
          fields={[
            { key: 'name', label: 'Name of service', required: true, placeholder: 'Main Line' },
            { key: 'kind', label: 'Kind', type: 'select', options: RESOURCE_ACCOUNT_KINDS, required: true },
            { key: 'directory_entry', label: 'Directory entry' },
            { key: 'business_hours', label: 'Business hours', placeholder: '24/7' },
            { key: 'who_answers', label: 'Who should answer the call', type: 'textarea', full: true },
            { key: 'ooh_action', label: 'Out-of-hours action', type: 'textarea', full: true },
            { key: 'exception_conditions', label: 'Exception handling — conditions', type: 'textarea', full: true },
            { key: 'exception_action', label: 'Exception handling — action', type: 'textarea', full: true },
            { key: 'holiday', label: 'Holiday handling', type: 'textarea', full: true },
            { key: 'advanced_features', label: 'Advanced features', type: 'textarea', full: true },
            { key: 'comments', label: 'Comments', type: 'textarea', full: true },
          ]}
        />
      )}

      {tab === 'network' && (
        <>
          <NetworkDiagramCard base={base} tid={tid ?? ''} siteId={siteId} />
          <PagedSection
            title="Network (E911)"
            hint="Internal and external subnets used for emergency-call location and media routing."
            endpoint={`${base}/network`}
            queryKey={['network', tid, siteId]}
            params={{ siteId }}
            fixed={{ site_id: siteId }}
            readOnly={locked}
            columns={[
              { key: 'scope', label: 'Scope' },
              { key: 'subnet', label: 'Subnet' },
              { key: 'mask', label: 'Mask' },
              { key: 'location', label: 'Location' },
              { key: 'vlan_id', label: 'VLAN ID', render: (r) => (r.vlan_id as number | null) ?? '—' },
              { key: 'network_type', label: 'Type' },
            ]}
            fields={[
              { key: 'scope', label: 'Scope', type: 'select', options: NETWORK_SCOPES, required: true },
              { key: 'subnet', label: 'Subnet', required: true, placeholder: '10.20.0.0' },
              { key: 'mask', label: 'Mask (bits)', type: 'number', placeholder: '24' },
              { key: 'location', label: 'Location', type: 'select', options: NETWORK_LOCATIONS },
              { key: 'vlan_id', label: 'VLAN ID (optional)', type: 'number', placeholder: 'e.g. 20' },
              { key: 'network_type', label: 'Network type', type: 'select', options: NETWORK_TYPES },
            ]}
          />
        </>
      )}

      {tab === 'flows' && (
        <PagedSection
          title="Call flows"
          hint="Free-text notes on existing routing. Structured AA/CQ config lives under Resource accounts."
          endpoint={`${base}/flows`}
          queryKey={['flows', tid, siteId]}
          params={{ siteId }}
          fixed={{ site_id: siteId }}
          readOnly={locked}
          columns={[
            { key: 'kind', label: 'Kind' },
            { key: 'name', label: 'Name' },
            {
              key: 'description',
              label: 'Description',
              render: (r) => {
                const v = (r.description as string) ?? '';
                return v.length > 90 ? `${v.slice(0, 90)}…` : v || '—';
              },
            },
          ]}
          fields={[
            { key: 'kind', label: 'Kind', type: 'select', options: FLOW_KINDS, required: true },
            { key: 'name', label: 'Name', required: true },
            { key: 'description', label: 'Description', type: 'textarea', full: true },
          ]}
        />
      )}
    </Page>
  );
}

/* -------------------------------- overview ------------------------------- */

const OVERVIEW_FIELDS: FieldDef[] = [
  { key: 'migrationId', label: 'Migration ID' },
  { key: 'region', label: 'Region', type: 'select', options: SITE_REGIONS },
  { key: 'author', label: 'Author' },
  { key: 'licensingModel', label: 'PSTN / licensing model', type: 'select', options: LICENSING_MODELS },
  { key: 'targetGoLive', label: 'Target go-live', placeholder: 'e.g. Q3 2026' },
  { key: 'primaryContactEmail', label: 'Primary contact email' },
  { key: 'notes', label: 'Notes', type: 'textarea', full: true },
];

const sameIds = (a: string[], b: string[]) =>
  a.length === b.length && [...a].sort().join() === [...b].sort().join();

/**
 * Per-site overview. Editable only by SUPER_ADMIN / PROJECT_MANAGER / ENGINEER
 * (`discovery:sites:manage`); everyone else sees it read-only.
 */
function OverviewTab({
  base,
  siteId,
  overview,
  assignedStaff,
  canEdit,
  locked,
  onSaved,
}: {
  base: string;
  siteId: string;
  overview: DiscoverySiteOverview;
  assignedStaff: StaffMember[];
  canEdit: boolean;
  locked: boolean;
  onSaved: () => void;
}) {
  const s = useRecordStyles();
  const editable = canEdit && !locked;
  const initial = () =>
    Object.fromEntries(
      OVERVIEW_FIELDS.map((f) => [f.key, (overview as Record<string, string>)?.[f.key] ?? '']),
    );
  const [draft, setDraft] = useState<Record<string, string>>(initial);
  const [staffIds, setStaffIds] = useState<string[]>(overview.assignedUserIds ?? []);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setDraft(initial());
    setStaffIds(overview.assignedUserIds ?? []);
    setError(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [overview]);

  const staff = useQuery({
    queryKey: ['discovery-staff', base],
    enabled: editable,
    queryFn: () => api<StaffMember[]>(`${base}/staff`),
  });

  const nameFor = (id: string) =>
    staff.data?.find((m) => m.id === id)?.displayName ??
    assignedStaff.find((m) => m.id === id)?.displayName ??
    id.slice(0, 6);

  const dirty = useMemo(
    () =>
      OVERVIEW_FIELDS.some(
        (f) => (draft[f.key] ?? '') !== ((overview as Record<string, string>)?.[f.key] ?? ''),
      ) || !sameIds(staffIds, overview.assignedUserIds ?? []),
    [draft, staffIds, overview],
  );

  const save = useMutation({
    mutationFn: () =>
      api(`${base}/sites/${siteId}/overview`, {
        method: 'PATCH',
        body: JSON.stringify({ ...draft, assignedUserIds: staffIds }),
      }),
    onSuccess: () => {
      setError(null);
      onSaved();
    },
    onError: (e) => setError(e instanceof ApiError ? e.message : 'Save failed'),
  });

  return (
    <Card className={s.card}>
      <div className={s.cardHead}>
        <div>
          <Text weight="semibold">Overview</Text>
          {!editable && (
            <Text size={200} className={s.muted} block>
              {canEdit
                ? 'Locked — reopen the discovery to edit.'
                : 'Read-only. The migration team maintains this.'}
            </Text>
          )}
        </div>
        {editable && (
          <Button
            size="small"
            appearance="primary"
            disabled={!dirty || save.isPending}
            onClick={() => save.mutate()}
          >
            {save.isPending ? <Spinner size="tiny" /> : 'Save'}
          </Button>
        )}
      </div>

      <div className={s.formGrid}>
        {OVERVIEW_FIELDS.map((f) => (
          <Field key={f.key} label={f.label} style={f.full ? { gridColumn: '1 / -1' } : undefined}>
            {!editable ? (
              <Text>{draft[f.key] || '—'}</Text>
            ) : f.type === 'textarea' ? (
              <Textarea
                value={draft[f.key] ?? ''}
                resize="vertical"
                onChange={(_, d) => setDraft((v) => ({ ...v, [f.key]: d.value }))}
              />
            ) : f.type === 'select' ? (
              <Dropdown
                placeholder="Select…"
                selectedOptions={draft[f.key] ? [draft[f.key]!] : []}
                value={draft[f.key] ?? ''}
                onOptionSelect={(_, d) => setDraft((v) => ({ ...v, [f.key]: d.optionValue ?? '' }))}
              >
                {(f.options ?? []).map((o) => (
                  <Option key={o} value={o}>
                    {o}
                  </Option>
                ))}
              </Dropdown>
            ) : (
              <Input
                placeholder={f.placeholder}
                value={draft[f.key] ?? ''}
                onChange={(_, d) => setDraft((v) => ({ ...v, [f.key]: d.value }))}
              />
            )}
          </Field>
        ))}

        <Field label="Assigned staff" hint="Engineers / project managers watching this site" style={{ gridColumn: '1 / -1' }}>
          {!editable ? (
            <div className={s.chips}>
              {assignedStaff.length === 0 ? (
                <Text>—</Text>
              ) : (
                assignedStaff.map((m) => (
                  <Badge key={m.id} appearance="tint" color="informative">
                    {m.displayName} · {m.role}
                  </Badge>
                ))
              )}
            </div>
          ) : (
            <Dropdown
              multiselect
              placeholder="Select staff…"
              selectedOptions={staffIds}
              value={staffIds.map(nameFor).join(', ')}
              onOptionSelect={(_, d) => setStaffIds(d.selectedOptions)}
            >
              {(staff.data ?? []).map((m) => (
                <Option key={m.id} value={m.id} text={m.displayName}>
                  {m.displayName} · {m.role}
                </Option>
              ))}
            </Dropdown>
          )}
        </Field>
      </div>

      {error && <LoadError message={error} />}
    </Card>
  );
}

/* ---------------------------- network diagram ---------------------------- */

/**
 * Fetches every network row for the site (not just the current page) and draws
 * the diagram. Shares the `['network', tid, siteId]` key prefix with
 * PagedSection, so a CRUD there invalidates this and the picture refreshes.
 */
function NetworkDiagramCard({ base, tid, siteId }: { base: string; tid: string; siteId: string }) {
  const s = useRecordStyles();
  const q = useQuery({
    queryKey: ['network', tid, siteId, 'all'],
    enabled: !!tid && !!siteId,
    queryFn: () => api<Paginated<NetworkRow>>(`${base}/network?siteId=${siteId}&limit=200`),
  });
  const rows = q.data?.items ?? [];

  return (
    <Card className={s.card}>
      <Text weight="semibold">Network diagram</Text>
      {q.isLoading ? (
        <Spinner size="tiny" />
      ) : rows.length === 0 ? (
        <Text size={200} className={s.muted}>
          Add subnets below to build the diagram.
        </Text>
      ) : (
        <NetworkDiagram rows={rows} />
      )}
    </Card>
  );
}

/* --------------------------- number inventory --------------------------- */

interface PhoneNumber {
  id: string;
  e164: string;
  status: 'available' | 'reserved' | 'assigned';
  holder_type: string | null;
  holder_name: string | null;
  range_start: string | null;
}

function NumberInventory({
  base,
  siteId,
  locked,
  onChanged,
}: {
  base: string;
  siteId: string;
  locked: boolean;
  onChanged: () => void;
}) {
  const s = useRecordStyles();
  const [statusFilter, setStatusFilter] = useState<'all' | 'available' | 'reserved' | 'assigned'>('all');
  const [qInput, setQInput] = useState('');
  const [q, setQ] = useState('');
  const [page, setPage] = useState(1);
  const limit = 50;

  useEffect(() => {
    const h = setTimeout(() => {
      setQ(qInput.trim());
      setPage(1);
    }, 250);
    return () => clearTimeout(h);
  }, [qInput]);

  const qs = new URLSearchParams({ siteId, page: String(page), limit: String(limit) });
  if (statusFilter !== 'all') qs.set('status', statusFilter);
  if (q) qs.set('q', q);

  const list = useQuery({
    queryKey: ['site-numbers', base, siteId, statusFilter, q, page],
    queryFn: () => api<Paginated<PhoneNumber>>(`${base}/numbers?${qs.toString()}`),
  });

  const reserve = useMutation({
    mutationFn: ({ id, reserved }: { id: string; reserved: boolean }) =>
      api(`${base}/numbers/${id}/reserve`, { method: 'PATCH', body: JSON.stringify({ reserved }) }),
    onSuccess: () => {
      list.refetch();
      onChanged();
    },
  });

  const total = list.data?.total ?? 0;
  const pages = Math.max(1, Math.ceil(total / limit));
  const items = list.data?.items ?? [];

  return (
    <Card className={s.card}>
      <div className={s.cardHead}>
        <div>
          <Text weight="semibold">
            Numbers <span className={s.muted}>({total})</span>
          </Text>
          <Text size={200} className={s.muted} block>
            Generated from this site's ranges. Assign numbers to users, CAPs or resource accounts.
          </Text>
        </div>
        <div className={s.toolbar}>
          <SearchBox
            size="small"
            placeholder="Search number…"
            value={qInput}
            onChange={(_, d) => setQInput(d.value)}
            style={{ minWidth: 180 }}
          />
          <Dropdown
            size="small"
            value={statusFilter}
            selectedOptions={[statusFilter]}
            onOptionSelect={(_, d) => {
              setStatusFilter((d.optionValue as typeof statusFilter) ?? 'all');
              setPage(1);
            }}
            style={{ minWidth: 130 }}
          >
            {['all', 'available', 'reserved', 'assigned'].map((o) => (
              <Option key={o} value={o}>
                {o}
              </Option>
            ))}
          </Dropdown>
        </div>
      </div>

      {list.isError && <LoadError message={(list.error as Error).message} />}
      {list.isLoading ? (
        <Spinner size="tiny" />
      ) : items.length === 0 ? (
        <Text size={200} className={s.muted}>
          {total === 0 && !q ? 'Add a number range to generate the inventory.' : 'No matches.'}
        </Text>
      ) : (
        <>
          <DataTable size="small" minWidth={640}>
              <TableHeader>
                <TableRow>
                  <TableHeaderCell>Number</TableHeaderCell>
                  <TableHeaderCell>Range</TableHeaderCell>
                  <TableHeaderCell>Status</TableHeaderCell>
                  <TableHeaderCell>Holder</TableHeaderCell>
                  {!locked && <TableHeaderCell />}
                </TableRow>
              </TableHeader>
              <TableBody>
                {items.map((n) => (
                  <TableRow key={n.id}>
                    <TableCell style={{ fontFamily: 'ui-monospace, monospace' }}>{n.e164}</TableCell>
                    <TableCell>{n.range_start ?? '—'}</TableCell>
                    <TableCell>
                      <Badge
                        appearance="tint"
                        color={
                          n.status === 'assigned'
                            ? 'success'
                            : n.status === 'reserved'
                              ? 'warning'
                              : 'informative'
                        }
                      >
                        {n.status}
                      </Badge>
                    </TableCell>
                    <TableCell>
                      {n.holder_name ? `${n.holder_name} (${n.holder_type})` : '—'}
                    </TableCell>
                    {!locked && (
                      <TableCell>
                        {n.status !== 'assigned' && (
                          <Button
                            size="small"
                            appearance="subtle"
                            disabled={reserve.isPending}
                            onClick={() =>
                              reserve.mutate({ id: n.id, reserved: n.status !== 'reserved' })
                            }
                          >
                            {n.status === 'reserved' ? 'Release' : 'Reserve'}
                          </Button>
                        )}
                      </TableCell>
                    )}
                  </TableRow>
                ))}
              </TableBody>
          </DataTable>
          {pages > 1 && (
            <div className={s.pager}>
              <Text size={200} className={s.muted}>
                Page {page} of {pages} · {total} total
              </Text>
              <Button
                size="small"
                appearance="subtle"
                disabled={page <= 1 || list.isFetching}
                onClick={() => setPage((p) => Math.max(1, p - 1))}
              >
                Prev
              </Button>
              <Button
                size="small"
                appearance="subtle"
                disabled={page >= pages || list.isFetching}
                onClick={() => setPage((p) => Math.min(pages, p + 1))}
              >
                Next
              </Button>
            </div>
          )}
        </>
      )}
    </Card>
  );
}

/* --------------------- resource-account number manager --------------------- */

function RaNumbersButton({
  ra,
  available,
  base,
  onChanged,
}: {
  ra: Row & { name: string; phone_numbers: { id: string; e164: string }[] };
  available: Choice[];
  base: string;
  onChanged: () => void;
}) {
  const s = useRecordStyles();
  const [open, setOpen] = useState(false);
  const [pick, setPick] = useState('');
  const [error, setError] = useState<string | null>(null);

  const attach = useMutation({
    mutationFn: () =>
      api(`${base}/resource-accounts/${ra.id}/numbers`, {
        method: 'POST',
        body: JSON.stringify({ phone_number_id: pick }),
      }),
    onSuccess: () => {
      setPick('');
      setError(null);
      onChanged();
    },
    onError: (e) => setError(e instanceof ApiError ? e.message : 'Failed'),
  });
  const detach = useMutation({
    mutationFn: (numberId: string) =>
      api(`${base}/resource-accounts/${ra.id}/numbers/${numberId}`, { method: 'DELETE' }),
    onSuccess: onChanged,
  });

  return (
    <>
      <Button size="small" appearance="subtle" onClick={() => setOpen(true)}>
        Numbers ({ra.phone_numbers?.length ?? 0})
      </Button>
      <Dialog open={open} onOpenChange={(_, d) => setOpen(d.open)}>
        <DialogSurface>
          <DialogBody>
            <DialogTitle>Numbers for {ra.name}</DialogTitle>
            <DialogContent>
              <div className={s.dialogForm}>
                <div className={s.chips}>
                  {(ra.phone_numbers?.length ?? 0) === 0 && (
                    <Text size={200} className={s.muted}>
                      None attached.
                    </Text>
                  )}
                  {(ra.phone_numbers ?? []).map((n) => (
                    <Badge key={n.id} appearance="outline" size="large">
                      {n.e164}
                      <Button
                        size="small"
                        appearance="transparent"
                        icon={<DeleteRegular />}
                        aria-label="Detach"
                        onClick={() => detach.mutate(n.id)}
                      />
                    </Badge>
                  ))}
                </div>
                <Field label="Attach an available number">
                  <div style={{ display: 'flex', gap: 8 }}>
                    <Dropdown
                      placeholder="Select…"
                      selectedOptions={pick ? [pick] : []}
                      value={available.find((c) => c.value === pick)?.label ?? ''}
                      onOptionSelect={(_, d) => setPick(d.optionValue ?? '')}
                      style={{ flex: 1 }}
                    >
                      {available.map((c) => (
                        <Option key={c.value} value={c.value}>
                          {c.label}
                        </Option>
                      ))}
                    </Dropdown>
                    <Button
                      appearance="primary"
                      disabled={!pick || attach.isPending}
                      onClick={() => attach.mutate()}
                    >
                      Attach
                    </Button>
                  </div>
                </Field>
                {error && <LoadError message={error} />}
              </div>
            </DialogContent>
            <DialogActions>
              <DialogTrigger disableButtonEnhancement>
                <Button appearance="secondary">Close</Button>
              </DialogTrigger>
            </DialogActions>
          </DialogBody>
        </DialogSurface>
      </Dialog>
    </>
  );
}
