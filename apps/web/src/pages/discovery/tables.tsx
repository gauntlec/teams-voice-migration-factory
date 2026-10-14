import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { keepPreviousData, useMutation, useQuery } from '@tanstack/react-query';
import { Badge, Button, Card, Checkbox, Dialog, DialogActions, DialogBody, DialogContent, DialogSurface, DialogTitle, Dropdown, Field, MessageBar, MessageBarBody, Option, SearchBox, Spinner, TableBody, TableCell, TableHeader, TableHeaderCell, TableRow, Text , makeStyles, shorthands, mergeClasses } from '@fluentui/react-components';
import { EyeRegular } from '@fluentui/react-icons';
import { buildAutoAttendantFlowGraphFromLive, buildCallQueueFlowGraphFromLive, TENANT_OBJECT_TYPE_LABELS, TENANT_POLICY_TYPE_LABELS, TENANT_POLICY_TYPES, type Paginated, type TenantEndpoint, type TenantObject, type TenantObjectType, type TenantPolicySummary, type TenantPolicyType, type TenantUserSummary, type TenantGroupSummary } from '@tvmf/shared';
import { api, ApiError } from '../../api';
import { useAuth } from '../../auth';
import { CallFlowDiagram } from '../../components/CallFlowDiagram';
import { DataTable } from '../../components/DataTable';
import { LoadError } from '../../components/records';
import { useDebounced } from '../../hooks/useDebounced';
import { useStyles, fmt, Pager, JsonDialog, str, fetchAllPages } from './discoveryShared';
import { HistoryButton } from './history';
import { TableSkeleton } from '../../components/states';

const useLocalStyles = makeStyles({
  w95vwMaxW95vw: { maxWidth: "95vw", width: "95vw" },
  blockMb10: { display: "block", marginBottom: '10px' },
  minW220: { minWidth: '220px' },
  minW200: { minWidth: '200px' },
  minW170: { minWidth: '170px' },
  minW260: { minWidth: '260px' },
  gridGap12: { display: "grid", ...shorthands.gap('12px') },
  flexGap8: { display: "flex", ...shorthands.gap('8px') },
  gridGap10: { display: "grid", ...shorthands.gap('10px') },
});


function LiveCallFlowDialog({ base, type, row, onClose }: { base: string; type: 'auto_attendant' | 'call_queue'; row: TenantObject; onClose: () => void }) {
  const ls = useLocalStyles();
  const s = useStyles();
  const needsSiblings = type === 'auto_attendant';
  // Every page, not just the first 200: on a big tenant a menu option or
  // agent beyond the first page would otherwise show as a raw id.
  const aaQ = useQuery({
    queryKey: ['tdisc', 'callflow-aa-all', base],
    queryFn: () => fetchAllPages<TenantObject>(`${base}/objects?type=auto_attendant`),
  });
  const cqQ = useQuery({
    queryKey: ['tdisc', 'callflow-cq-all', base],
    queryFn: () => fetchAllPages<TenantObject>(`${base}/objects?type=call_queue`),
  });
  const schedQ = useQuery({
    queryKey: ['tdisc', 'callflow-sched-all', base],
    queryFn: () => fetchAllPages<TenantObject>(`${base}/objects?type=schedule`),
    enabled: needsSiblings,
  });
  const usersQ = useQuery({
    queryKey: ['tdisc', 'callflow-users-all', base],
    queryFn: () => fetchAllPages<TenantUserSummary>(`${base}/users?`),
  });

  // Get-CsAutoAttendant/Get-CsCallQueue's own CallTarget/Agent ObjectId
  // fields are tenant_users.entra_id, not object_id - matching on the wrong
  // column silently resolved nothing.
  const usersByEntraId = useMemo(
    () => new Map((usersQ.data?.items ?? []).filter((u) => u.entra_id).map((u) => [u.entra_id!.toLowerCase(), u.upn])),
    [usersQ.data],
  );

  const graph = useMemo(() => {
    if (type === 'call_queue') {
      // Siblings name a Forward-to-voice-app target; drawn without them until they load.
      const siblings =
        aaQ.data && cqQ.data
          ? {
              autoAttendants: aaQ.data.items.map((o) => ({ name: o.display_name ?? o.object_key, data: o.data })),
              callQueues: cqQ.data.items.map((o) => ({ name: o.display_name ?? o.object_key, data: o.data })),
            }
          : undefined;
      return buildCallQueueFlowGraphFromLive({ name: row.display_name ?? row.object_key, data: row.data }, usersByEntraId, siblings);
    }
    if (!aaQ.data || !cqQ.data || !schedQ.data) return null;
    return buildAutoAttendantFlowGraphFromLive(
      { name: row.display_name ?? row.object_key, data: row.data },
      aaQ.data.items.map((o) => ({ name: o.display_name ?? o.object_key, data: o.data })),
      cqQ.data.items.map((o) => ({ name: o.display_name ?? o.object_key, data: o.data })),
      schedQ.data.items.map((o) => ({ key: o.object_key, data: o.data })),
      usersByEntraId,
    );
  }, [type, row, aaQ.data, cqQ.data, schedQ.data, usersByEntraId]);

  const loading = (needsSiblings && (aaQ.isLoading || cqQ.isLoading || schedQ.isLoading)) || usersQ.isLoading;
  const loadError = ((needsSiblings ? (aaQ.error ?? cqQ.error ?? schedQ.error) : null) ?? usersQ.error) as Error | null;

  return (
    <Dialog open onOpenChange={(_, d) => !d.open && onClose()}>
      <DialogSurface className={ls.w95vwMaxW95vw}>
        <DialogBody>
          <DialogTitle>Call flow: {row.display_name ?? row.object_key}</DialogTitle>
          <DialogContent>
            <Text size={200} className={mergeClasses(s.muted, ls.blockMb10)}>
              {type === 'auto_attendant'
                ? "Business hours, after hours and holiday routing, from this tenant's live configuration - including every Auto Attendant a menu option hands off to, followed all the way through. \"Front door\" marks an Auto Attendant with a phone number attached."
                : 'What happens to a call in this queue - overflow, timeout and no-agent routing, from live configuration.'}
            </Text>
            {loading ? (
              <Spinner size="tiny" label="Loading…" />
            ) : loadError ? (
              <LoadError message={loadError.message} />
            ) : !graph || graph.nodes.length === 0 ? (
              <Text size={200} className={s.muted}>
                Nothing to draw.
              </Text>
            ) : (
              <CallFlowDiagram graph={graph} exportFilename={`call-flow-${row.display_name ?? row.object_key}`} />
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

/** Generic snapshot list for one object type. */
export function ObjectsTable({
  base,
  type,
  title,
  columns,
  flowType,
  actions,
}: {
  base: string;
  type: TenantObjectType;
  title?: string;
  columns?: { label: string; render: (o: TenantObject) => ReactNode }[];
  /** When set, adds a "Call flow" button per row opening LiveCallFlowDialog scoped to that object. */
  flowType?: 'auto_attendant' | 'call_queue';
  /** Extra toolbar content (e.g. an Import button) rendered after the search box. */
  actions?: ReactNode;
}) {
  const ls = useLocalStyles();
  const s = useStyles();
  const [qInput, setQInput] = useState('');
  const q = useDebounced(qInput);
  const [page, setPage] = useState(1);
  const [view, setView] = useState<TenantObject | null>(null);
  const [flowFor, setFlowFor] = useState<TenantObject | null>(null);
  const limit = 50;
  useEffect(() => setPage(1), [q]);

  const list = useQuery({
    queryKey: ['tdisc', 'objects', base, type, q, page],
    queryFn: () =>
      api<Paginated<TenantObject>>(
        `${base}/objects?type=${type}&page=${page}&limit=${limit}${q ? `&q=${encodeURIComponent(q)}` : ''}`,
      ),
    placeholderData: keepPreviousData,
  });
  const items = list.data?.items ?? [];
  const total = list.data?.total ?? 0;
  const pages = Math.max(1, Math.ceil(total / limit));
  const cols = columns ?? [
    { label: 'Name', render: (o: TenantObject) => o.display_name ?? o.object_key },
    { label: 'Identity', render: (o: TenantObject) => o.object_key },
  ];

  return (
    <Card className={s.card}>
      <div className={s.toolbar}>
        <Text weight="semibold">
          {title ?? TENANT_OBJECT_TYPE_LABELS[type]} <span className={s.muted}>({total.toLocaleString()})</span>
        </Text>
        <div className={s.row}>
          <SearchBox size="small" placeholder="Search…" value={qInput} onChange={(_, d) => setQInput(d.value)} className={ls.minW220} />
          {actions}
        </div>
      </div>
      {list.isLoading ? (
        <TableSkeleton rows={4} cols={5} />
      ) : list.isError ? (
        <LoadError message={(list.error as Error).message} />
      ) : items.length === 0 ? (
        <Text size={200} className={s.muted}>
          {q ? 'No matches.' : 'Nothing discovered yet.'}
        </Text>
      ) : (
        <>
          <DataTable size="small" minWidth={Math.max(560, (cols.length + 2) * 150)}>
            <TableHeader>
              <TableRow>
                {cols.map((c) => (
                  <TableHeaderCell key={c.label}>{c.label}</TableHeaderCell>
                ))}
                <TableHeaderCell>Last seen</TableHeaderCell>
                <TableHeaderCell />
              </TableRow>
            </TableHeader>
            <TableBody>
              {items.map((o) => (
                <TableRow key={o.id}>
                  {cols.map((c) => (
                    <TableCell key={c.label}>{c.render(o)}</TableCell>
                  ))}
                  <TableCell>{fmt(o.discovered_at)}</TableCell>
                  <TableCell>
                    <div className={s.row}>
                      <Button size="small" appearance="subtle" icon={<EyeRegular />} onClick={() => setView(o)}>
                        View
                      </Button>
                      {flowType && (
                        <Button size="small" appearance="subtle" onClick={() => setFlowFor(o)}>
                          Call flow
                        </Button>
                      )}
                      <HistoryButton base={base} objectId={o.id} title={o.display_name ?? o.object_key} />
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </DataTable>
          <Pager page={page} pages={pages} total={total} onPage={setPage} />
        </>
      )}
      {view && <JsonDialog title={view.display_name ?? view.object_key} data={view.data} onClose={() => setView(null)} />}
      {flowFor && flowType && <LiveCallFlowDialog base={base} type={flowType} row={flowFor} onClose={() => setFlowFor(null)} />}
    </Card>
  );
}

export function PoliciesTable({ base }: { base: string }) {
  const ls = useLocalStyles();
  const s = useStyles();
  const [type, setType] = useState<TenantPolicyType | ''>('');
  const [qInput, setQInput] = useState('');
  const q = useDebounced(qInput);
  const [page, setPage] = useState(1);
  const [view, setView] = useState<TenantPolicySummary | null>(null);
  const limit = 50;
  useEffect(() => setPage(1), [q, type]);

  const list = useQuery({
    queryKey: ['tdisc', 'policies', base, type, q, page],
    queryFn: () =>
      api<Paginated<TenantPolicySummary>>(
        `${base}/policies?page=${page}&limit=${limit}${type ? `&policyType=${type}` : ''}${q ? `&q=${encodeURIComponent(q)}` : ''}`,
      ),
    placeholderData: keepPreviousData,
  });
  const items = list.data?.items ?? [];
  const total = list.data?.total ?? 0;
  const pages = Math.max(1, Math.ceil(total / limit));

  return (
    <Card className={s.card}>
      <div className={s.toolbar}>
        <Text weight="semibold">
          Policies <span className={s.muted}>({total.toLocaleString()})</span>
        </Text>
        <div className={s.row}>
          <Dropdown
            size="small"
            placeholder="All policy types"
            selectedOptions={type ? [type] : []}
            value={type ? TENANT_POLICY_TYPE_LABELS[type] : ''}
            onOptionSelect={(_, d) => setType((d.optionValue ?? '') as TenantPolicyType | '')}
            className={ls.minW220}
          >
            <Option value="" text="All policy types">
              All policy types
            </Option>
            {TENANT_POLICY_TYPES.map((p) => (
              <Option key={p} value={p} text={TENANT_POLICY_TYPE_LABELS[p]}>
                {TENANT_POLICY_TYPE_LABELS[p]}
              </Option>
            ))}
          </Dropdown>
          <SearchBox size="small" placeholder="Search…" value={qInput} onChange={(_, d) => setQInput(d.value)} className={ls.minW200} />
        </div>
      </div>
      {list.isLoading ? (
        <TableSkeleton rows={4} cols={5} />
      ) : list.isError ? (
        <LoadError message={(list.error as Error).message} />
      ) : items.length === 0 ? (
        <Text size={200} className={s.muted}>
          {q || type ? 'No matches.' : 'Nothing discovered yet.'}
        </Text>
      ) : (
        <>
          <DataTable size="small" minWidth={720}>
            <TableHeader>
              <TableRow>
                <TableHeaderCell>Type</TableHeaderCell>
                <TableHeaderCell>Name</TableHeaderCell>
                <TableHeaderCell>Scope</TableHeaderCell>
                <TableHeaderCell />
              </TableRow>
            </TableHeader>
            <TableBody>
              {items.map((p) => (
                <TableRow key={p.id}>
                  <TableCell>{TENANT_POLICY_TYPE_LABELS[p.policy_type] ?? p.policy_type}</TableCell>
                  <TableCell>{p.name}</TableCell>
                  <TableCell>
                    {p.is_global ? (
                      <Badge appearance="tint" color="brand" size="small">
                        Global
                      </Badge>
                    ) : (
                      <Badge appearance="outline" size="small">
                        Per-user
                      </Badge>
                    )}
                  </TableCell>
                  <TableCell>
                    <div className={s.row}>
                      <Button size="small" appearance="subtle" icon={<EyeRegular />} onClick={() => setView(p)}>
                        View
                      </Button>
                      <HistoryButton
                        base={base}
                        objectId={p.object_id}
                        title={`${TENANT_POLICY_TYPE_LABELS[p.policy_type] ?? p.policy_type}: ${p.name}`}
                      />
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </DataTable>
          <Pager page={page} pages={pages} total={total} onPage={setPage} />
        </>
      )}
      {view && (
        <JsonDialog
          title={`${TENANT_POLICY_TYPE_LABELS[view.policy_type] ?? view.policy_type}: ${view.name}`}
          data={view.data}
          onClose={() => setView(null)}
        />
      )}
    </Card>
  );
}

/** Get-CsOnlineUser AccountType values, spelled exactly as Teams returns them (the filter is an exact match). */
const ACCOUNT_TYPES = ['User', 'ResourceAccount', 'Guest', 'IneligibleUser', 'SfbOnPremUser', 'Unknown'] as const;

export function UsersTable({ base, canImport, onImported }: { base: string; canImport: boolean; onImported: () => void }) {
  const ls = useLocalStyles();
  const s = useStyles();
  const [qInput, setQInput] = useState('');
  const q = useDebounced(qInput);
  const [page, setPage] = useState(1);
  const [evOnly, setEvOnly] = useState(false);
  const [acctType, setAcctType] = useState('');
  const [view, setView] = useState<TenantUserSummary | null>(null);
  const [importOpen, setImportOpen] = useState(false);
  const limit = 50;
  useEffect(() => setPage(1), [q, evOnly, acctType]);

  const list = useQuery({
    queryKey: ['tdisc', 'users', base, q, page, evOnly, acctType],
    queryFn: () =>
      api<Paginated<TenantUserSummary>>(
        `${base}/users?page=${page}&limit=${limit}${q ? `&q=${encodeURIComponent(q)}` : ''}${evOnly ? '&ev=true' : ''}${acctType ? `&accountType=${acctType}` : ''}`,
      ),
    placeholderData: keepPreviousData,
  });
  const items = list.data?.items ?? [];
  const total = list.data?.total ?? 0;
  const pages = Math.max(1, Math.ceil(total / limit));

  return (
    <Card className={s.card}>
      <div className={s.toolbar}>
        <Text weight="semibold">
          Users <span className={s.muted}>({total.toLocaleString()})</span>
        </Text>
        <div className={s.row}>
          <Dropdown
            size="small"
            placeholder="All account types"
            selectedOptions={acctType ? [acctType] : []}
            value={acctType}
            onOptionSelect={(_, d) => setAcctType(d.optionValue ?? '')}
            className={ls.minW170}
          >
            <Option value="" text="All account types">
              All account types
            </Option>
            {ACCOUNT_TYPES.map((t) => (
              <Option key={t} value={t} text={t}>
                {t}
              </Option>
            ))}
          </Dropdown>
          <Checkbox size="medium" label="Voice-enabled only" checked={evOnly} onChange={(_, d) => setEvOnly(!!d.checked)} />
          <SearchBox size="small" placeholder="Search UPN, name, number, department…" value={qInput} onChange={(_, d) => setQInput(d.value)} className={ls.minW260} />
          {canImport && (
            <Button size="small" appearance="primary" onClick={() => setImportOpen(true)}>
              Import into Data Collection…
            </Button>
          )}
        </div>
      </div>
      {list.isLoading ? (
        <TableSkeleton rows={4} cols={5} />
      ) : list.isError ? (
        <LoadError message={(list.error as Error).message} />
      ) : items.length === 0 ? (
        <Text size={200} className={s.muted}>
          {q ? 'No matches.' : 'Nothing discovered yet.'}
        </Text>
      ) : (
        <>
          <DataTable size="small" minWidth={1100}>
            <TableHeader>
              <TableRow>
                <TableHeaderCell>UPN</TableHeaderCell>
                <TableHeaderCell>Name</TableHeaderCell>
                <TableHeaderCell>Type</TableHeaderCell>
                <TableHeaderCell>Voice</TableHeaderCell>
                <TableHeaderCell>Number</TableHeaderCell>
                <TableHeaderCell>Features</TableHeaderCell>
                <TableHeaderCell>Calling policy</TableHeaderCell>
                <TableHeaderCell>Department</TableHeaderCell>
                <TableHeaderCell>Data Collection</TableHeaderCell>
                <TableHeaderCell />
              </TableRow>
            </TableHeader>
            <TableBody>
              {items.map((u) => (
                <TableRow key={u.id}>
                  <TableCell title={u.upn}>{u.upn}</TableCell>
                  <TableCell title={u.display_name ?? ''}>{u.display_name ?? '—'}</TableCell>
                  <TableCell>{u.account_type ?? '—'}</TableCell>
                  <TableCell>
                    {u.enterprise_voice_enabled ? (
                      <Badge appearance="tint" color="success" size="small">
                        EV
                      </Badge>
                    ) : (
                      <span className={s.muted}>—</span>
                    )}
                  </TableCell>
                  <TableCell>{u.line_uri ? u.line_uri.replace(/^tel:/, '') : '—'}</TableCell>
                  <TableCell>
                    <div className={s.chips}>
                      {(u.feature_types ?? []).slice(0, 4).map((f) => (
                        <Badge key={f} appearance="outline" size="small">
                          {f}
                        </Badge>
                      ))}
                      {(u.feature_types ?? []).length > 4 && (
                        <span className={s.muted}>+{u.feature_types.length - 4}</span>
                      )}
                    </div>
                  </TableCell>
                  <TableCell>{u.policies?.TeamsCallingPolicy ?? '—'}</TableCell>
                  <TableCell>{u.department ?? '—'}</TableCell>
                  <TableCell>
                    {u.discovery_user_id ? (
                      <Badge appearance="tint" color="success" size="small">
                        Linked
                      </Badge>
                    ) : (
                      <span className={s.muted}>—</span>
                    )}
                  </TableCell>
                  <TableCell>
                    <div className={s.row}>
                      <Button size="small" appearance="subtle" icon={<EyeRegular />} onClick={() => setView(u)}>
                        View
                      </Button>
                      <HistoryButton base={base} objectId={u.object_id} title={u.display_name ?? u.upn} />
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </DataTable>
          <Pager page={page} pages={pages} total={total} onPage={setPage} />
        </>
      )}
      {view && <JsonDialog title={view.display_name ?? view.upn} data={view} onClose={() => setView(null)} />}
      {importOpen && (
        <ImportDialog
          base={base}
          kind="user"
          onClose={() => setImportOpen(false)}
          onDone={() => {
            setImportOpen(false);
            onImported();
          }}
        />
      )}
    </Card>
  );
}

export function ResourceAccountsTab({ base, canImport, onImported }: { base: string; canImport: boolean; onImported: () => void }) {
  const [importOpen, setImportOpen] = useState(false);

  return (
    <>
      <ObjectsTable
        base={base}
        type="resource_account"
        columns={[
          { label: 'Name', render: (o) => o.display_name ?? o.object_key },
          { label: 'UPN', render: (o) => str(o, 'UserPrincipalName') },
          { label: 'Application', render: (o) => str(o, 'ApplicationId') },
          { label: 'Number', render: (o) => str(o, 'PhoneNumber') },
        ]}
        actions={
          canImport && (
            <Button size="small" appearance="primary" onClick={() => setImportOpen(true)}>
              Import into Data Collection…
            </Button>
          )
        }
      />
      {importOpen && (
        <ImportDialog
          base={base}
          kind="resource_account"
          onClose={() => setImportOpen(false)}
          onDone={() => {
            setImportOpen(false);
            onImported();
          }}
        />
      )}
    </>
  );
}

/** Import dialog row choice: leave this candidate out. */
const SKIP = '__skip__';

/** One discovered-but-not-yet-captured candidate, shape shared by the users and resource-account import previews. */
type ImportCandidate = { id: string; name: string | null; upn?: string | null; kind?: string | null; phone: string | null; suggestedSiteId: string | null };

/**
 * Reverse-import a live-discovered object (Users tab or Resource accounts
 * tab) into Data Collection. Each candidate gets its own destination site -
 * pre-filled from a best-effort suggestion (phone-number range match, then
 * naming-convention match against known sitecodes) and editable per row -
 * plus a "set all to" convenience for the common single-site case.
 */
function ImportDialog({
  base,
  kind,
  onClose,
  onDone,
}: {
  base: string;
  kind: 'user' | 'resource_account';
  onClose: () => void;
  onDone: () => void;
}) {
  const ls = useLocalStyles();
  const s = useStyles();
  const { activeTenantId } = useAuth();
  const [evOnly, setEvOnly] = useState(true);
  const [bulkSiteId, setBulkSiteId] = useState('');
  const [rowSiteId, setRowSiteId] = useState<Record<string, string>>({});
  const [result, setResult] = useState<{ created: number; skipped: number; linked?: number } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const importPath = kind === 'user' ? 'import-users' : 'import-resource-accounts';

  const sites = useQuery({
    queryKey: ['tdisc', 'sites', activeTenantId],
    queryFn: () =>
      api<{ sites: { id: string; sitecode: string; name: string | null }[] }>(`/t/${activeTenantId}/discovery`),
  });
  const preview = useQuery({
    queryKey: ['tdisc', 'import-preview', kind, base, evOnly],
    queryFn: () =>
      api<{ candidates: ImportCandidate[] }>(
        `${base}/${importPath}/preview${kind === 'user' ? `?onlyEnterpriseVoice=${evOnly}` : ''}`,
      ),
  });
  const candidates = preview.data?.candidates ?? [];
  const run = useMutation({
    mutationFn: () =>
      api<{ created: number; skipped: number; linked?: number }>(`${base}/${importPath}`, {
        method: 'POST',
        body: JSON.stringify({
          assignments: candidates
            .map((c) => ({ id: c.id, siteId: rowSiteId[c.id] ?? c.suggestedSiteId ?? '' }))
            .filter((a) => a.siteId),
          ...(kind === 'user' ? { onlyEnterpriseVoice: evOnly } : {}),
        }),
      }),
    onSuccess: (r) => setResult(r),
    onError: (e) => setErr(e instanceof ApiError ? e.message : 'Import failed'),
  });

  const siteList = sites.data?.sites ?? [];
  const siteLabel = (id: string) => {
    const x = siteList.find((s) => s.id === id);
    return x ? `${x.sitecode} · ${x.name ?? ''}` : '';
  };
  const readyCount = candidates.filter((c) => rowSiteId[c.id] ?? c.suggestedSiteId).length;
  const noun = kind === 'user' ? 'user' : 'resource account';

  return (
    <Dialog open onOpenChange={(_, d) => !d.open && onClose()}>
      <DialogSurface>
        <DialogBody>
          <DialogTitle>Import discovered {noun}s into Data Collection</DialogTitle>
          <DialogContent>
            {result ? (
              <MessageBar intent="success">
                <MessageBarBody>
                  Created <b>{result.created}</b> Data Collection {noun}
                  {result.created === 1 ? '' : 's'}
                  {result.linked ? ` and linked ${result.linked} existing` : ''}
                  {result.skipped ? `; skipped ${result.skipped} left out or with no site` : ''}.
                </MessageBarBody>
              </MessageBar>
            ) : (
              <div className={ls.gridGap12}>
                <Text size={200}>
                  {kind === 'user'
                    ? 'Creates a Data Collection user for every discovered tenant user that is not captured yet (matched on UPN). Existing users are never overwritten; unlinked matches are linked.'
                    : 'Creates a Data Collection resource account for every discovered resource account that is not captured yet (matched on name).'}
                  {' '}Each row below is pre-filled with a best-effort site suggestion (phone number range, then
                  naming convention) - review and override before importing; rows left blank are skipped.
                </Text>
                {kind === 'user' && (
                  <Checkbox
                    checked={evOnly}
                    onChange={(_, d) => setEvOnly(!!d.checked)}
                    label="Only users with Enterprise Voice enabled"
                  />
                )}
                <Field label="Set all rows to">
                  <div className={ls.flexGap8}>
                    <Dropdown
                      placeholder={sites.isLoading ? 'Loading sites…' : 'Select a site'}
                      selectedOptions={bulkSiteId ? [bulkSiteId] : []}
                      value={bulkSiteId ? siteLabel(bulkSiteId) : ''}
                      onOptionSelect={(_, d) => setBulkSiteId(d.optionValue ?? '')}
                      className={ls.minW220}
                    >
                      {siteList.map((x) => (
                        <Option key={x.id} value={x.id} text={`${x.sitecode} · ${x.name ?? ''}`}>
                          {x.sitecode} · {x.name ?? ''}
                        </Option>
                      ))}
                    </Dropdown>
                    <Button
                      size="small"
                      disabled={!bulkSiteId}
                      onClick={() =>
                        setRowSiteId(Object.fromEntries(candidates.map((c) => [c.id, bulkSiteId])))
                      }
                    >
                      Apply to all
                    </Button>
                  </div>
                </Field>
                {preview.isError ? (
                  <LoadError message={`Could not load candidates: ${(preview.error as Error).message}`} />
                ) : preview.isLoading ? (
                  <Spinner size="tiny" />
                ) : candidates.length === 0 ? (
                  <Text size={200} className={s.muted}>
                    Nothing to import - every discovered {noun} is already captured.
                  </Text>
                ) : (
                  <DataTable size="small" minWidth={560}>
                    <TableHeader>
                      <TableRow>
                        <TableHeaderCell>Name</TableHeaderCell>
                        <TableHeaderCell>{kind === 'user' ? 'UPN' : 'Number'}</TableHeaderCell>
                        <TableHeaderCell>Site</TableHeaderCell>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {candidates.map((c) => {
                        const value = rowSiteId[c.id] ?? c.suggestedSiteId ?? '';
                        return (
                          <TableRow key={c.id}>
                            <TableCell>{c.name ?? '—'}</TableCell>
                            <TableCell>{kind === 'user' ? c.upn : c.phone ?? '—'}</TableCell>
                            <TableCell>
                              <Dropdown
                                size="small"
                                placeholder={rowSiteId[c.id] === '' ? "Don't import" : 'Pick a site…'}
                                selectedOptions={value ? [value] : []}
                                value={value ? siteLabel(value) : ''}
                                onOptionSelect={(_, d) =>
                                  setRowSiteId((prev) => ({ ...prev, [c.id]: d.optionValue === SKIP ? '' : d.optionValue ?? '' }))
                                }
                                className={ls.minW200}
                              >
                                {/* A suggested row could not be left out before - every row had a site. */}
                                <Option value={SKIP} text="Don't import">
                                  Don't import
                                </Option>
                                {siteList.map((x) => (
                                  <Option key={x.id} value={x.id} text={`${x.sitecode} · ${x.name ?? ''}`}>
                                    {x.sitecode} · {x.name ?? ''}
                                  </Option>
                                ))}
                              </Dropdown>
                            </TableCell>
                          </TableRow>
                        );
                      })}
                    </TableBody>
                  </DataTable>
                )}
                {err && <LoadError message={err} />}
              </div>
            )}
          </DialogContent>
          <DialogActions>
            {result ? (
              <Button appearance="primary" onClick={onDone}>
                Done
              </Button>
            ) : (
              <>
                <Button appearance="secondary" onClick={onClose}>
                  Cancel
                </Button>
                <Button appearance="primary" disabled={readyCount === 0 || run.isPending} onClick={() => run.mutate()}>
                  Import {readyCount > 0 ? readyCount.toLocaleString() : ''}
                </Button>
              </>
            )}
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
}

/* --------------------------------- page --------------------------------- */

/**
 * The M365 group cache (`tenant_groups`) - populated by the optional
 * Microsoft Graph sign-in on the Discovery connect card and kept fresh by
 * regular discovery runs (see `syncTenantGroups`,
 * apps/worker/src/discovery/run.ts). A plain browsable/searchable list of
 * what's available to `GroupAutocomplete`'s Shared Voicemail groupId
 * picker - not a `tenant_objects` type, so no change history here.
 */
export function GroupsTable({ base }: { base: string }) {
  const ls = useLocalStyles();
  const s = useStyles();
  const [qInput, setQInput] = useState('');
  const q = useDebounced(qInput);
  const [page, setPage] = useState(1);
  const limit = 50;
  useEffect(() => setPage(1), [q]);

  const list = useQuery({
    queryKey: ['tdisc', 'groups', base, q, page],
    queryFn: () =>
      api<Paginated<TenantGroupSummary>>(
        `${base}/groups?page=${page}&limit=${limit}${q ? `&q=${encodeURIComponent(q)}` : ''}`,
      ),
    placeholderData: keepPreviousData,
  });
  const items = list.data?.items ?? [];
  const total = list.data?.total ?? 0;
  const pages = Math.max(1, Math.ceil(total / limit));

  return (
    <Card className={s.card}>
      <div className={s.toolbar}>
        <Text weight="semibold">
          M365 groups <span className={s.muted}>({total.toLocaleString()})</span>
        </Text>
        <SearchBox
          size="small"
          placeholder="Search name, mail, object ID…"
          value={qInput}
          onChange={(_, d) => setQInput(d.value)}
          className={ls.minW260}
        />
      </div>
      {list.isLoading ? (
        <TableSkeleton rows={4} cols={5} />
      ) : list.isError ? (
        <LoadError message={(list.error as Error).message} />
      ) : items.length === 0 ? (
        <Text size={200} className={s.muted}>
          {q
            ? 'No matches.'
            : 'Nothing discovered yet - connect Microsoft Graph on the Discovery connect card, or run a discovery once it is connected.'}
        </Text>
      ) : (
        <>
          <DataTable size="small" minWidth={720}>
            <TableHeader>
              <TableRow>
                <TableHeaderCell>Display name</TableHeaderCell>
                <TableHeaderCell>Mail</TableHeaderCell>
                <TableHeaderCell>Object ID</TableHeaderCell>
                <TableHeaderCell>Last synced</TableHeaderCell>
              </TableRow>
            </TableHeader>
            <TableBody>
              {items.map((g) => (
                <TableRow key={g.object_id}>
                  <TableCell title={g.display_name}>{g.display_name}</TableCell>
                  <TableCell>{g.mail ?? '—'}</TableCell>
                  <TableCell title={g.object_id}>{g.object_id}</TableCell>
                  <TableCell>{fmt(g.synced_at)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </DataTable>
          <Pager page={page} pages={pages} total={total} onPage={setPage} />
        </>
      )}
    </Card>
  );
}

/**
 * Shared phone endpoints — Common Area Phones and phone-enabled resource
 * accounts, derived from the users / resource-account snapshot. (Microsoft
 * retired the Graph device-inventory API, so there is no hardware model /
 * serial / firmware to show.)
 */
export function EndpointsTable({ base }: { base: string }) {
  const ls = useLocalStyles();
  const s = useStyles();
  const list = useQuery({
    queryKey: ['tdisc', 'endpoints', base],
    queryFn: () => api<{ items: TenantEndpoint[] }>(`${base}/endpoints`),
  });
  const items = list.data?.items ?? [];

  return (
    <div className={ls.gridGap10}>
      <MessageBar intent="info">
        <MessageBarBody>
          Common Area Phones and phone-enabled resource accounts found in the tenant. Microsoft
          retired the Graph device-inventory API, so hardware model / serial / firmware aren’t
          available here — that detail lives in the Teams admin center.
        </MessageBarBody>
      </MessageBar>
      {list.isLoading ? (
        <Spinner size="tiny" label="Loading…" />
      ) : list.isError ? (
        <LoadError message={(list.error as Error).message} />
      ) : items.length === 0 ? (
        <Text size={200} className={s.muted}>
          No Common Area Phones or phone-enabled resource accounts in the last discovery.
        </Text>
      ) : (
        <DataTable minWidth={720}>
          <TableHeader>
            <TableRow>
              <TableHeaderCell>Type</TableHeaderCell>
              <TableHeaderCell>Name</TableHeaderCell>
              <TableHeaderCell>UPN</TableHeaderCell>
              <TableHeaderCell>Number</TableHeaderCell>
              <TableHeaderCell>Calling policy</TableHeaderCell>
              <TableHeaderCell>IP phone policy</TableHeaderCell>
              <TableHeaderCell>Enabled</TableHeaderCell>
            </TableRow>
          </TableHeader>
          <TableBody>
            {items.map((e, i) => (
              <TableRow key={`${e.kind}-${e.upn ?? e.name ?? i}`}>
                <TableCell>
                  <Badge appearance="tint" size="small">
                    {e.kind === 'common_area_phone' ? 'Common area phone' : 'Resource account'}
                  </Badge>
                </TableCell>
                <TableCell>{e.name ?? '—'}</TableCell>
                <TableCell>{e.upn ?? '—'}</TableCell>
                <TableCell>{e.number ?? '—'}</TableCell>
                <TableCell>{e.callingPolicy ?? '—'}</TableCell>
                <TableCell>{e.ipPhonePolicy ?? '—'}</TableCell>
                <TableCell>{e.enabled == null ? '—' : e.enabled ? 'Yes' : 'No'}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </DataTable>
      )}
    </div>
  );
}
