import { useMemo, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Badge, Button, Spinner, Tab, TabList, Text , makeStyles, shorthands, tokens } from '@fluentui/react-components';
import { ArrowLeftRegular, ArrowUploadRegular, WarningRegular } from '@fluentui/react-icons';
import { portDue, portStageText, CALLER_ID_OPTIONS, FLOW_KINDS, NETWORK_LOCATIONS, NETWORK_SCOPES, NETWORK_TYPES, NUMBER_RANGE_KINDS, RESOURCE_ACCOUNT_KINDS, VOICEMAIL_PROMPT_LANGUAGES, type AutoAttendantWizardAnswers, type CallQueueWizardAnswers, type Paginated, type TenantUserSummary } from '@tvmf/shared';
import { api, ApiError } from '../api';
import { useAuth } from '../auth';
import { AutoAttendantWizard } from '../components/AutoAttendantWizard';
import { CallQueueWizard } from '../components/CallQueueWizard';
import { ImportRangesDialog } from '../components/ImportRangesDialog';
import { ImportUsersDialog } from '../components/ImportUsersDialog';
import { Page } from '../components/Page';
import { WizardTiles, useTeamChoices } from '../components/WizardTiles';
import { BulkEditDialog, LoadError, NoTenant, PagedSection, useRecordStyles, type Choice, type FieldDef, type Row } from '../components/records';
import { RelinkUsersButton, TAB_LABEL, isFlowStale, TABS, numKey, type SiteSummary, type TabKey } from './site/siteShared';
import { OverviewTab, NetworkDiagramCard } from './site/siteOverview';
import { HandsetTrackerCard } from './site/siteHandsets';
import { SiteSuggestionsCard } from './discovery/siteSuggestions';
import { SiteChangesCard, SiteReviewBar } from './site/siteReview';
import { NumberInventory, FlowImportButton, RaNumbersButton } from './site/siteNumbers';

const useLocalStyles = makeStyles({
  inlineFlexItemsCenterGap6: { display: "inline-flex", ...shorthands.gap('6px'), alignItems: "center" },
  flexWrapGap4: { display: "flex", ...shorthands.gap('4px'), flexWrap: "wrap" },
  mutedText: { color: tokens.colorNeutralForeground3 },
});


export function SiteWorkspace() {
  const ls = useLocalStyles();
  const s = useRecordStyles();
  const { siteId = '' } = useParams();
  const { activeTenantId, can } = useAuth();
  const qc = useQueryClient();
  // ?tab=ranges opens the site on that tab (the Number porting screen's Back button uses it); otherwise Overview.
  const [searchParams] = useSearchParams();
  const wantedTab = searchParams.get('tab');
  const [tab, setTab] = useState<TabKey>((TABS as readonly string[]).includes(wantedTab ?? '') ? (wantedTab as TabKey) : 'overview');
  const [importOpen, setImportOpen] = useState(false);
  const [importRangesOpen, setImportRangesOpen] = useState(false);

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

  // This site's resource accounts, for the AA/CQ wizard's "which phone
  // identity will answer this" picker - a light, separate query from the
  // Resource accounts tab's own paginated list, since the wizard needs
  // every row up front rather than one page at a time.
  const siteResourceAccounts = useQuery({
    queryKey: ['site-ras-lite', tid, siteId],
    enabled: !!tid && !!siteId,
    queryFn: () => api<Paginated<{ id: string; name: string }>>(`${base}/resource-accounts?siteId=${siteId}&limit=200`),
  });
  const siteVoiceApps = useQuery({
    queryKey: ['voice-apps-choices', tid, siteId],
    queryFn: () => api<Paginated<{ id: string; name: string; kind: string }>>(`${base}/voice-apps?siteId=${siteId}&limit=200`),
  });
  const voiceAppChoices: Choice[] = useMemo(
    () => (siteVoiceApps.data?.items ?? []).map((v) => ({ value: v.id, label: `${v.name} (${v.kind === 'call_queue' ? 'call queue' : 'auto attendant'})` })),
    [siteVoiceApps.data],
  );
  const resourceAccountChoices: Choice[] = useMemo(
    () => (siteResourceAccounts.data?.items ?? []).map((r) => ({ value: r.id, label: r.name })),
    [siteResourceAccounts.data],
  );

  // Shares WizardTiles' own query/cache (same queryKey) - the "edit an
  // existing wizard capture" flow below needs the same "department/team"
  // suggestions the "New" tiles already fetch, without a second network call.
  const teamChoices = useTeamChoices(tid ?? '', siteId);
  // The wizard-captured Call flows row currently reopened for editing (see
  // onEditRow on the flows PagedSection below) - null when nothing's open.
  const [editingFlow, setEditingFlow] = useState<Row | null>(null);

  const numberChoicesFor = (row: Row | null): Choice[] => {
    const cur =
      row && row.phone_number_id
        ? [{ value: String(row.phone_number_id), label: `${row.phone_number} (current)` }]
        : [];
    return [...cur, ...availableChoices];
  };

  // Bulk edit: select many rows (checkboxes, records.tsx), set a handful of
  // fields once in one dialog, apply to every selected row in a single
  // PATCH .../bulk request - see TelephonyService.bulkUpdateUsers/Caps,
  // shared with Design & Build's identical flow via applyBulkPatch.
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
      refreshSummary();
    },
    onError: (e) => setBulkError(e instanceof ApiError ? e.message : 'Bulk update failed'),
  });

  if (!tid) return <NoTenant />;
  if (summary.isLoading) return <Spinner label="Loading site…" />;
  if (summary.isError) return <LoadError message={(summary.error as Error).message} />;

  const { site, review, pendingChanges, callingPolicies, numberSummary, overview, contactUsers } = summary.data!;
  const canReview = can('discovery:review');
  // Nothing is locked by the review: data keeps changing until the migration, and changes after submission are tracked.
  const locked = !can('discovery:write');
  const canManageOverview = can('discovery:sites:manage');

  const policyChoices: Choice[] = callingPolicies.map((p) => ({ value: p.id, label: p.name }));
  const policyName = (id: unknown) => callingPolicies.find((p) => p.id === id)?.name ?? '—';
  const yesNo = (v: unknown) => (v ? 'Yes' : 'No');

  // Anything that changes users or numbers also changes which numbers are free, so the pickers' list is read again too.
  const refreshSummary = () => {
    qc.invalidateQueries({ queryKey: ['site-avail-numbers', tid, siteId] });
    return summary.refetch();
  };

  // Fields bulk edit exposes - the Users/CAPs fields above minus upn,
  // display_name, phone_number_id and requested_number, which are per-row-
  // unique identifiers (see discoveryUserBulkPatchSchema/
  // discoveryCapBulkPatchSchema, packages/shared/src/dto.ts).
  const userBulkFields: FieldDef[] = [
    { key: 'calling_policy_id', label: 'Calling policy', type: 'ref', choices: policyChoices },
    { key: 'caller_id', label: 'Caller ID', type: 'select', options: CALLER_ID_OPTIONS },
    { key: 'voicemail_enabled', label: 'Voicemail enabled', type: 'boolean' },
    {
      key: 'voicemail_language',
      label: 'Voicemail language',
      type: 'ref',
      choices: VOICEMAIL_PROMPT_LANGUAGES.map((l) => ({ value: l.code, label: `${l.label} (${l.code})` })),
    },
    { key: 'requires_handset', label: 'Requires a physical handset', type: 'boolean' },
    { key: 'handset_model', label: 'Handset model' },
    { key: 'access_port_id', label: 'Access port ID' },
    { key: 'comments', label: 'Comments', type: 'textarea', full: true },
  ];
  const capBulkFields: FieldDef[] = [
    { key: 'device_model', label: 'Device model' },
    { key: 'calling_policy_id', label: 'Calling policy', type: 'ref', choices: policyChoices },
    { key: 'caller_id', label: 'Caller ID', type: 'select', options: CALLER_ID_OPTIONS },
    { key: 'access_port_id', label: 'Access port ID' },
    { key: 'comments', label: 'Comments', type: 'textarea', full: true },
  ];

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
      </div>

      <SiteReviewBar
        base={base}
        siteId={siteId}
        review={review}
        pendingChanges={pendingChanges}
        canWrite={can('discovery:write')}
        canReview={canReview}
        onChanged={refreshSummary}
      />
      {canReview && pendingChanges > 0 && <SiteChangesCard base={base} siteId={siteId} onChanged={refreshSummary} />}

      <BulkEditDialog
        open={bulkOpen !== null}
        onOpenChange={(o) => !o && setBulkOpen(null)}
        kindLabel={bulkOpen === 'caps' ? 'common area phones' : 'users'}
        fields={bulkOpen === 'caps' ? capBulkFields : userBulkFields}
        count={bulkOpen === 'caps' ? capsSelected.size : usersSelected.size}
        saving={bulkSave.isPending}
        error={bulkError}
        onSave={(patch) => {
          if (!bulkOpen) return;
          const ids = [...(bulkOpen === 'caps' ? capsSelected : usersSelected)];
          bulkSave.mutate({ kind: bulkOpen, ids, patch });
        }}
      />

      <SiteSuggestionsCard siteId={siteId} sitecode={site.sitecode} locked={locked} onAdded={refreshSummary} />

      <TabList selectedValue={tab} onTabSelect={(_, d) => setTab(d.value as TabKey)}>
        {TABS.map((t) => (
          <Tab key={t} value={t}>
            {TAB_LABEL[t]}
          </Tab>
        ))}
      </TabList>

      {tab === 'overview' && (
        <>
          <OverviewTab
            base={base}
            siteId={siteId}
            overview={overview}
            contactUsers={contactUsers}
            canEdit={canManageOverview}
            locked={locked}
            onSaved={refreshSummary}
          />
          <HandsetTrackerCard base={base} siteId={siteId} canEdit={canManageOverview} />
        </>
      )}

      {tab === 'ranges' && (
        <PagedSection
          title="Number ranges"
          hint="Creating a range generates its individual numbers into this site's inventory. Use Number porting to track LOA/CSR documents for a port."
          endpoint={`${base}/number-ranges`}
          queryKey={['ranges', tid, siteId]}
          params={{ siteId }}
          fixed={{ sitecode: site.sitecode }}
          readOnly={locked}
          onChanged={refreshSummary}
          headerActions={
            <>
              {!locked && (
                <Button size="small" icon={<ArrowUploadRegular />} onClick={() => setImportRangesOpen(true)}>
                  Import from Excel…
                </Button>
              )}
              <Link to={`/data-collection/sites/${siteId}/number-porting`}>
                <Button size="small">Number porting</Button>
              </Link>
            </>
          }
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
              key: 'new_carrier',
              label: 'Moving to',
              render: (r) => (r.kind === 'port' ? ((r.new_carrier as string | null) ?? '—') : '—'),
            },
            {
              key: 'port_status',
              label: 'Port status',
              sortValue: (r) => portStageText(r as never),
              render: (r) => {
                if (r.kind === 'retain') return 'not applicable';
                if (r.kind !== 'port') return r.port_status ? String(r.port_status).replace(/_/g, ' ') : '—';
                const due = portDue(r as never, new Date().toISOString().slice(0, 10));
                return (
                  <span>
                    {portStageText(r as never)}
                    {due && (
                      <>
                        {' '}
                        <Badge appearance="tint" color="warning" size="small" title="The scheduled port date has arrived. Confirm on the Number porting page when the port completes.">
                          confirm port
                        </Badge>
                      </>
                    )}
                  </span>
                );
              },
            },
          ]}
          fields={[
            { key: 'range_start', label: 'Range start', required: true, placeholder: '19133743250' },
            { key: 'range_end', label: 'Range end', required: true, placeholder: '19133743257' },
            { key: 'kind', label: 'Kind', type: 'select', options: NUMBER_RANGE_KINDS, required: true },
            { key: 'carrier', label: 'Carrier (where the numbers are now)' },
            { key: 'new_carrier', label: 'New carrier (port-in: where they are moving to)', placeholder: 'Required for a port-in', disabledWhen: (v) => v.kind !== 'port' },
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
          bulkDelete={{ noun: 'user', plural: 'users', note: "Their phone numbers go back to this site's free pool. Anything already populated into Design & Build stays there, unlinked." }}
          hint="Teams users with Enterprise Voice. Each holds at most one number from this site's inventory."
          endpoint={`${base}/users`}
          queryKey={['users', tid, siteId]}
          params={{ siteId }}
          fixed={{ site_id: siteId }}
          readOnly={locked}
          onChanged={refreshSummary}
          selectable={!locked}
          selected={usersSelected}
          onSelectedChange={setUsersSelected}
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
              {!locked && (
                <Button size="small" disabled={usersSelected.size === 0} onClick={() => setBulkOpen('users')}>
                  Bulk edit ({usersSelected.size} selected)
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
                  <span className={ls.inlineFlexItemsCenterGap6}>
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

      {importRangesOpen && (
        <ImportRangesDialog
          base={base}
          siteId={siteId}
          onClose={() => setImportRangesOpen(false)}
          onDone={() => {
            qc.invalidateQueries({ queryKey: ['ranges', tid, siteId] });
            qc.invalidateQueries({ queryKey: ['site-numbers'] });
            refreshSummary();
          }}
        />
      )}

      {importOpen && (
        <ImportUsersDialog
          base={base}
          siteId={siteId}
          siteCode={site.sitecode}
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
          bulkDelete={{ noun: 'common area phone', plural: 'common area phones', note: "Their phone numbers go back to this site's free pool. Anything already populated into Design & Build stays there, unlinked." }}
          hint="Shared / lobby / meeting-room phones. Each holds at most one number."
          endpoint={`${base}/caps`}
          queryKey={['caps', tid, siteId]}
          params={{ siteId }}
          fixed={{ site_id: siteId }}
          readOnly={locked}
          onChanged={refreshSummary}
          selectable={!locked}
          selected={capsSelected}
          onSelectedChange={setCapsSelected}
          headerActions={
            !locked && (
              <Button size="small" disabled={capsSelected.size === 0} onClick={() => setBulkOpen('caps')}>
                Bulk edit ({capsSelected.size} selected)
              </Button>
            )
          }
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

      {tab === 'voice-apps' && (
        <PagedSection
          title="Voice apps"
          bulkDelete={{ noun: 'voice app', plural: 'voice apps', note: 'Their resource accounts and numbers stay on the site; they just stop answering for a voice app. Anything already populated into Design & Build stays there, unlinked.' }}
          hint="Auto attendants & call queues, named as they are in Teams. The resource accounts that answer for each one are listed here and managed under Resource accounts."
          endpoint={`${base}/voice-apps`}
          queryKey={['voice-apps', tid, siteId]}
          params={{ siteId }}
          fixed={{ site_id: siteId }}
          readOnly={locked}
          onChanged={() => {
            refreshSummary();
            siteVoiceApps.refetch();
            // adding one with a number also makes its resource account
            qc.invalidateQueries({ queryKey: ['ras', tid, siteId] });
            qc.invalidateQueries({ queryKey: ['site-ras-lite', tid, siteId] });
          }}
          columns={[
            { key: 'name', label: 'Name' },
            { key: 'kind', label: 'Kind', render: (r) => (r.kind === 'call_queue' ? 'Call queue' : 'Auto attendant') },
            {
              key: 'resource_accounts',
              label: 'Resource accounts',
              render: (r) => {
                const ras = (r.resource_accounts as { id: string; name: string; upn: string | null; numbers: string[] }[] | undefined) ?? [];
                if (ras.length === 0) return '—';
                return (
                  <div>
                    {ras.map((a) => (
                      <div key={a.id}>
                        {a.upn ?? a.name}
                        {a.numbers.length ? ` · ${a.numbers.join(', ')}` : ''}
                      </div>
                    ))}
                  </div>
                );
              },
            },
            { key: 'business_hours', label: 'Business hours' },
            { key: 'who_answers', label: 'Who answers' },
          ]}
          fields={[
            { key: 'name', label: 'Name of service', required: true, placeholder: 'Main Line' },
            { key: 'kind', label: 'Kind', type: 'select', options: RESOURCE_ACCOUNT_KINDS, required: true },
            { key: 'phone_number_id', label: 'Telephone number (optional - one of this site\'s free numbers)', type: 'ref', choices: availableChoices, addOnly: true, full: true },
            { key: 'directory_entry', label: 'Directory entry' },
            { key: 'business_hours', label: 'Business hours', placeholder: '24/7' },
            { key: 'who_answers', label: 'Who should answer the call', type: 'textarea', full: true },
            { key: 'ooh_action', label: 'Out-of-hours action', type: 'textarea', full: true },
            { key: 'exception_conditions', label: 'Exception handling — conditions', type: 'textarea', full: true },
            { key: 'exception_action', label: 'Exception handling — action', type: 'textarea', full: true },
            { key: 'holiday', label: 'Holiday handling', type: 'textarea', full: true },
            { key: 'advanced_features', label: 'Advanced features', type: 'textarea', full: true },
            { key: 'comments', label: 'Comments', type: 'textarea', full: true, rows: 6 },
          ]}
        />
      )}

      {tab === 'resource-accounts' && (
        <PagedSection
          title="Resource accounts"
          bulkDelete={{ noun: 'resource account', plural: 'resource accounts', note: "Their phone numbers go back to this site's free pool. Anything already populated into Design & Build stays there, unlinked." }}
          hint="The accounts that hold a phone number for an auto attendant or call queue. Each answers for one voice app (leave it blank if none is set up yet). May hold several numbers — use the Numbers button."
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
            { key: 'upn', label: 'UPN' },
            { key: 'kind', label: 'Kind', render: (r) => (r.kind === 'call_queue' ? 'Call queue' : 'Auto attendant') },
            {
              key: 'phone_numbers',
              label: 'Numbers',
              render: (r) => {
                const nums = (r.phone_numbers as { e164: string }[] | undefined) ?? [];
                const found = r.discovered_number as string | null;
                return (
                  <div>
                    {nums.length ? nums.map((n) => n.e164).join(', ') : '—'}
                    {found && !r.discovered_number_attached && (
                      <Text size={200} className={ls.mutedText} block>
                        {found} in Teams is not in this site's number ranges, so not attached here
                      </Text>
                    )}
                  </div>
                );
              },
            },
            { key: 'voice_app_name', label: 'Answers for', render: (r) => (r.voice_app_name as string | null) ?? '—' },
          ]}
          fields={[
            { key: 'name', label: 'Name', required: true, placeholder: 'Main Line RA' },
            { key: 'upn', label: 'UPN (if known)' },
            { key: 'kind', label: 'Kind', type: 'select', options: RESOURCE_ACCOUNT_KINDS, required: true },
            { key: 'voice_app_id', label: 'Answers for (voice app)', type: 'ref', choices: voiceAppChoices },
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
        <>
        {!locked && (
          <WizardTiles
            base={base}
            tenantId={tid}
            siteId={siteId}
            resourceAccountChoices={resourceAccountChoices}
            onCreated={() => qc.invalidateQueries({ queryKey: ['flows', tid, siteId] })}
          />
        )}

        <PagedSection
          title="Call flows"
          hint="Free-text notes on existing routing, or captured via the guided wizards above. Structured AA/CQ config lives under Voice apps and Design & Build."
          endpoint={`${base}/flows`}
          queryKey={['flows', tid, siteId]}
          params={{ siteId }}
          fixed={{ site_id: siteId }}
          readOnly={locked}
          onEditRow={(r) => {
            // A wizard-captured row reopens the same guided wizard it was
            // built with (pre-filled), instead of the generic kind/name/
            // description dialog every other Call flows row still uses -
            // editing structured wizard_answers through a plain textarea
            // isn't something a customer should have to do.
            if (!r.wizard_answers) return false;
            setEditingFlow(r);
            return true;
          }}
          extraRowAction={(r) =>
            // "Import to Design & Build" is engineer/admin-only work - the
            // API already blocks it (RequirePermission('build:write'), which
            // only SUPER_ADMIN/ENGINEER hold), but the button itself must
            // not even appear for a PROJECT_MANAGER/CUSTOMER viewing this
            // same Call flows tab, or it just looks broken when they click it.
            !locked && tid && can('build:write') ? (
              <FlowImportButton flow={r} tid={tid} siteId={siteId} onChanged={() => qc.invalidateQueries({ queryKey: ['flows', tid, siteId] })} />
            ) : null
          }
          columns={[
            { key: 'kind', label: 'Kind' },
            { key: 'name', label: 'Name' },
            {
              key: 'wizard_answers',
              label: 'Source',
              render: (r) =>
                r.wizard_answers || r.tenant_object_id ? (
                  <div className={ls.flexWrapGap4}>
                    <Badge appearance="tint" color="brand">{r.tenant_object_id ? 'Discovery' : 'Wizard'}</Badge>
                    {isFlowStale(r) && (
                      <Badge appearance="tint" color="warning" title="Edited since it was last imported into Design & Build">
                        Edited
                      </Badge>
                    )}
                  </div>
                ) : (
                  <Badge appearance="outline">Manual</Badge>
                ),
            },
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
        </>
      )}

      {/* Reopening a wizard-captured Call flows row for editing (see onEditRow above) - a
          fresh instance per row (key={editingFlow.id}) so each edit starts from that row's
          own saved answers, not whatever an earlier edit left behind. */}
      {tid && editingFlow?.kind === 'auto_attendant' && (
        <AutoAttendantWizard
          key={editingFlow.id}
          open
          onOpenChange={(o) => !o && setEditingFlow(null)}
          base={base}
          tenantId={tid}
          siteId={siteId}
          resourceAccountChoices={resourceAccountChoices}
          teamChoices={teamChoices}
          editing={{
            id: editingFlow.id,
            name: editingFlow.name as string,
            answers: editingFlow.wizard_answers as AutoAttendantWizardAnswers,
            resourceAccountId: (editingFlow.resource_account_id as string | null) ?? null,
          }}
          onCreated={() => {
            setEditingFlow(null);
            qc.invalidateQueries({ queryKey: ['flows', tid, siteId] });
          }}
        />
      )}
      {tid && editingFlow?.kind === 'call_queue' && (
        <CallQueueWizard
          key={editingFlow.id}
          open
          onOpenChange={(o) => !o && setEditingFlow(null)}
          base={base}
          tenantId={tid}
          siteId={siteId}
          resourceAccountChoices={resourceAccountChoices}
          editing={{
            id: editingFlow.id,
            name: editingFlow.name as string,
            answers: editingFlow.wizard_answers as CallQueueWizardAnswers,
            resourceAccountId: (editingFlow.resource_account_id as string | null) ?? null,
          }}
          onCreated={() => {
            setEditingFlow(null);
            qc.invalidateQueries({ queryKey: ['flows', tid, siteId] });
          }}
        />
      )}
    </Page>
  );
}

/* -------------------------------- overview ------------------------------- */
