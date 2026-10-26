import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link as RouterLink, useParams } from 'react-router';
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
  Link,
  Spinner,
  Tab,
  TabList,
  TableBody,
  TableCell,
  TableHeader,
  TableHeaderCell,
  TableRow,
  Text,
  makeStyles,
  shorthands,
  tokens,

  mergeClasses,
} from '@fluentui/react-components';
import { ArrowLeftRegular, CheckmarkCircleRegular, WarningRegular } from '@fluentui/react-icons';
import {
  DEPLOYMENT_SHEETS,
  groupDeploymentRows,
  verificationHeadline,
  type DeploymentGroupBy,
  type DeploymentPreviewRow,
  type DeploymentSiteRollup,
  type DeploymentVerification,
  type FileRow,
} from '@tvmf/shared';
import { api, apiDownload, ApiError } from '../api';
import { useAuth } from '../auth';
import { DataTable } from '../components/DataTable';
import { Page } from '../components/Page';
import { LoadError, NoTenant, useRecordStyles } from '../components/records';
import { DangerText } from '../components/ui';

const useLocalStyles = makeStyles({
  justifySpacebetween: { justifyContent: "space-between" },
  mt8: { marginTop: '8px' },
  colored: { color: "var(--colorPaletteRedForeground1)" },
  flexWrapGap6: { display: "flex", ...shorthands.gap('6px'), flexWrap: "wrap" },
  flexColGap4: { display: "flex", flexDirection: "column", ...shorthands.gap('4px') },
  maxW420PreWrap: { maxWidth: '420px', whiteSpace: "pre-wrap" },
});


const useStyles = makeStyles({
  row: { display: 'flex', ...shorthands.gap('8px'), flexWrap: 'wrap', alignItems: 'center' },
  mono: { fontFamily: 'ui-monospace, monospace' },
  commands: { fontFamily: 'ui-monospace, monospace', fontSize: '12px', whiteSpace: 'pre-wrap', margin: 0 },
  // A Fluent `Badge` is a fixed-height pill meant for a short single-line
  // label - forcing one to wrap a full warning sentence (as this used to)
  // gave it more text than its fixed height has room for, so the wrapped
  // line(s) overflowed on top of whatever sat below it instead of pushing it
  // down, reading as garbled/overlapping text. This is a plain flex row
  // instead, which grows with its content like any other block element.
  warningRow: {
    display: 'flex',
    alignItems: 'flex-start',
    ...shorthands.gap('4px'),
    ...shorthands.borderRadius('4px'),
    ...shorthands.padding('2px', '6px'),
    marginTop: '4px',
    color: tokens.colorPaletteYellowForeground1,
    backgroundColor: tokens.colorPaletteYellowBackground2,
    fontSize: '12px',
    lineHeight: '16px',
  },
  warningIcon: { flexShrink: 0, marginTop: '2px' },
  // Same amber treatment as warningRow, but full-width and a touch roomier -
  // this is the "you're about to act on the whole site" notice, not a
  // per-row data problem, so it sits above the table rather than inside a cell.
  wholeSiteBanner: {
    display: 'flex',
    alignItems: 'center',
    ...shorthands.gap('8px'),
    ...shorthands.borderRadius('4px'),
    ...shorthands.padding('8px', '12px'),
    color: tokens.colorPaletteYellowForeground1,
    backgroundColor: tokens.colorPaletteYellowBackground2,
    ...shorthands.border('1px', 'solid', tokens.colorPaletteYellowBorder1),
  },
  groupHeaderCell: {
    backgroundColor: tokens.colorNeutralBackground3,
    color: tokens.colorBrandForeground1,
    fontWeight: tokens.fontWeightSemibold,
    fontSize: tokens.fontSizeBase200,
    textTransform: 'uppercase',
    letterSpacing: '.02em',
  },
  autoIncludedTag: {
    display: 'inline-block',
    marginLeft: '6px',
  },
  // Run History's version sits below the summary badges (a block element
  // breaks the line already) rather than beside inline text, so it wants
  // vertical breathing room instead of autoIncludedTag's horizontal gap.
  autoIncludedNote: {
    display: 'inline-block',
    marginTop: '4px',
  },
  verifyList: { margin: '4px 0 0', paddingLeft: '16px', fontSize: '12px', lineHeight: '16px' },
  verifyDetail: { margin: 0, paddingLeft: '16px', color: tokens.colorNeutralForeground2 },
  verifyNote: { marginTop: '4px', color: tokens.colorNeutralForeground3 },
});

interface Connection {
  id: string;
  status: string;
}
interface TenantRow {
  id: string;
  teams_read_only: boolean;
}
interface Deployment {
  id: string;
  mode: string;
  status: string;
  scope: { siteId?: string; autoIncludedRowIds?: string[] } | null;
  summary: Record<string, number>;
  /** post-deploy live re-check (live runs only) - see apps/worker/src/deployment-verify.ts */
  verification: DeploymentVerification | null;
  created_at: string;
}
interface Change {
  id: string;
  seq: number;
  cmdlet: string;
  object_type: string;
  result: string;
  message: string | null;
}

/**
 * A run's own `status` only ever tracks the pwsh session lifecycle (queued/
 * running/completed/failed) - it says nothing about whether the individual
 * cmdlets inside a "completed" run actually succeeded. A run where every
 * cmdlet failed still shows `status: 'completed'` (the session finished
 * cleanly, it just failed to change anything), so the badge has to look at
 * `summary.failed` too or a 100%-failed run reads as a success at a glance.
 */
function runStatusBadge(d: Deployment): { label: string; color: 'success' | 'danger' | 'informative'; icon?: boolean } {
  const failed = d.summary?.failed ?? 0;
  if (d.status === 'failed') return { label: 'failed', color: 'danger', icon: true };
  if (d.status === 'completed' && failed > 0) return { label: `completed - ${failed} failed`, color: 'danger', icon: true };
  if (d.status === 'completed') return { label: 'completed', color: 'success' };
  return { label: d.status, color: 'informative' };
}

/** A re-check that never finished (worker stopped mid-way) - don't show "Checking…" forever. */
const VERIFY_STALE_MS = 60 * 60_000;

const VERIFY_OBJECT_LABEL: Record<string, string> = { user: 'User', cap: 'Common Area Phone', resource_account: 'Resource Account' };

/**
 * The Run history's answer to "did it land?" for a live run: the one-line
 * verdict, then each person/account that still differs from the design and
 * what differs. Collapsed past a few rows so a big site stays readable.
 */
function VerificationCell({ v }: { v: DeploymentVerification }) {
  const cs = useStyles();
  const [showAll, setShowAll] = useState(false);
  if (v.status === 'pending' && Date.now() - new Date(v.startedAt).getTime() > VERIFY_STALE_MS) {
    return <Text size={200}>Not verified - the re-check didn't finish. Run Validate against tenant to check.</Text>;
  }
  const headline = verificationHeadline(v);
  if (v.status === 'pending') {
    return (
      <span className={cs.row}>
        <Spinner size="extra-tiny" /> <Text size={200}>{headline}</Text>
      </span>
    );
  }
  if (v.status !== 'verified') {
    return (
      <Text size={200} style={{ color: v.status === 'failed' ? tokens.colorPaletteRedForeground1 : undefined }}>
        {headline}
      </Text>
    );
  }
  const differ = v.differing.length;
  const shown = showAll ? v.differing : v.differing.slice(0, 3);
  return (
    <div>
      <Badge
        appearance="tint"
        color={differ ? 'warning' : 'success'}
        icon={differ ? <WarningRegular /> : <CheckmarkCircleRegular />}
        title={`Re-read from Teams ${new Date(v.checkedAt).toLocaleString()}`}
      >
        {headline}
      </Badge>
      {shown.length > 0 && (
        <ul className={cs.verifyList}>
          {shown.map((r) => (
            <li key={r.objectId}>
              <span className={cs.mono}>{r.upn}</span> <Text size={100}>({VERIFY_OBJECT_LABEL[r.objectType] ?? r.objectType})</Text>
              <ul className={cs.verifyDetail}>
                {r.differences.map((d, i) => (
                  <li key={i}>{d}</li>
                ))}
              </ul>
            </li>
          ))}
        </ul>
      )}
      {differ > 3 && (
        <Link onClick={() => setShowAll((x) => !x)}>{showAll ? 'Show fewer' : `Show all ${differ}`}</Link>
      )}
      {differ > 0 && (
        <Text size={100} block className={cs.verifyNote}>
          Teams can take a few minutes to show a change - if these look right, run Validate against tenant later to re-check.
        </Text>
      )}
      {(v.notChecked > 0 || v.unverifiableSettings > 0) && (
        <Text size={100} block className={cs.verifyNote}>
          {v.notChecked > 0 && `${v.notChecked} more changed account(s) not re-checked (limit per run). `}
          {v.unverifiableSettings > 0 &&
            `${v.unverifiableSettings} call forwarding / delegate change(s) can't be read back from Teams, so aren't part of this check.`}
        </Text>
      )}
    </div>
  );
}

/** Result column badge for one deployment_changes row - 'failed' is the one that must never blend in with the rest. */
const RESULT_BADGE_COLOR: Record<string, 'success' | 'danger' | 'informative' | 'subtle'> = {
  applied: 'success',
  failed: 'danger',
  whatif: 'informative',
  skipped: 'subtle',
};

const OBJECT_TYPE_LABEL: Record<DeploymentPreviewRow['objectType'], string> = {
  user: 'User',
  cap: 'Common Area Phone',
  resource_account: 'Resource Account',
  call_queue: 'Call Queue',
  auto_attendant: 'Auto Attendant',
  shared_calling_policy: 'Shared Calling Policy',
};

/** Display/group order for the Planned changes table - matches the worker's own deployment order (users/caps first, auto attendants last), so the grouping doubles as a hint at what runs before what. */
const GROUP_ORDER: DeploymentPreviewRow['objectType'][] = ['user', 'cap', 'resource_account', 'shared_calling_policy', 'call_queue', 'auto_attendant'];

const GROUP_BY_KEY = 'tvmf.deployment.groupBy';

export function DeploymentSiteWorkspace() {
  const ls = useLocalStyles();
  const cs = useStyles();
  const s = useRecordStyles();
  const { siteId = '' } = useParams();
  const { activeTenantId: tid, can } = useAuth();
  const qc = useQueryClient();
  const base = `/t/${tid}/deployments`;
  const canDryRun = can('deployment:dryrun');
  const canExecute = can('deployment:execute');

  const [tab, setTab] = useState<'changes' | 'history'>('changes');
  const [selectedRowIds, setSelectedRowIds] = useState<Set<string>>(new Set());
  // How the planned changes are grouped: by what they are, or by migration wave. Remembered per browser; the page works without it.
  const [groupBy, setGroupByState] = useState<DeploymentGroupBy>(() => {
    try {
      return localStorage.getItem(GROUP_BY_KEY) === 'wave' ? 'wave' : 'type';
    } catch {
      return 'type';
    }
  });
  const setGroupBy = (g: DeploymentGroupBy) => {
    setGroupByState(g);
    try {
      localStorage.setItem(GROUP_BY_KEY, g);
    } catch {
      /* private window or blocked storage: the choice just is not remembered */
    }
  };
  const [selectedDeployment, setSelectedDeployment] = useState<string | null>(null);
  const [generatedFile, setGeneratedFile] = useState<FileRow | null>(null);
  const [rollbackError, setRollbackError] = useState<string | null>(null);
  // Only the live-execute path gets a confirm gate - a What-If run never
  // touches the tenant, so accidentally running it on the whole site instead
  // of a selection has no real consequence beyond a bigger preview.
  const [confirmWholeSiteDeploy, setConfirmWholeSiteDeploy] = useState(false);

  const rollup = useQuery({
    queryKey: ['deployment-summary', tid],
    enabled: !!tid,
    queryFn: () => api<DeploymentSiteRollup[]>(`${base}/summary`),
  });

  const tenants = useQuery({ queryKey: ['tenants'], queryFn: () => api<TenantRow[]>('/tenants') });
  const teamsReadOnly = tenants.data?.find((t) => t.id === tid)?.teams_read_only ?? false;

  const connections = useQuery({
    queryKey: ['connections', tid],
    enabled: !!tid,
    refetchInterval: 4000,
    queryFn: () => api<Connection[]>(`${base}/connections`),
  });
  const activeConn = connections.data?.find((c) => c.status === 'active');

  const preview = useQuery({
    queryKey: ['deployment-preview', tid, siteId],
    enabled: !!tid && !!siteId,
    queryFn: () =>
      api<DeploymentPreviewRow[]>(
        `${base}/preview?siteId=${siteId}&sheets=${DEPLOYMENT_SHEETS.join(',')}`,
      ),
  });

  const deployments = useQuery({
    queryKey: ['deployments', tid, siteId],
    enabled: !!tid && !!siteId,
    refetchInterval: tab === 'history' ? 4000 : false,
    queryFn: () => api<Deployment[]>(`${base}?siteId=${siteId}`),
  });
  const siteDeployments = deployments.data ?? [];

  const changes = useQuery({
    queryKey: ['changes', tid, selectedDeployment],
    enabled: !!tid && !!selectedDeployment,
    queryFn: () => api<Change[]>(`${base}/${selectedDeployment}/changes`),
  });

  const sheetsFor = (rowIds: Set<string> | undefined) => {
    if (!rowIds || rowIds.size === 0) return [...DEPLOYMENT_SHEETS];
    const selectedTypes = new Set(
      (preview.data ?? []).filter((r) => rowIds.has(r.rowId)).map((r) => r.objectType),
    );
    const sheets: string[] = [];
    if (selectedTypes.has('user')) sheets.push('users');
    if (selectedTypes.has('cap')) sheets.push('caps');
    if (selectedTypes.has('resource_account')) sheets.push('resource_accounts');
    if (selectedTypes.has('shared_calling_policy')) sheets.push('shared_calling_policies');
    if (selectedTypes.has('call_queue')) sheets.push('call_queues');
    if (selectedTypes.has('auto_attendant')) sheets.push('auto_attendants');
    return sheets;
  };

  // Only meaningful once something is selected - previews with exactly that
  // rowIds subset, so `autoIncluded` reflects "if this selection deploys
  // right now, these extra rows get pulled in" - the same expansion
  // DeploymentService.expandScopeWithDependencies applies when a real run
  // goes out. `preview` above never restricts rowIds (it always shows the
  // whole site), so on its own it can never produce this signal.
  const selectedRowIdsList = [...selectedRowIds].sort();
  const dependencyPreview = useQuery({
    queryKey: ['deployment-dependency-preview', tid, siteId, selectedRowIdsList.join(',')],
    enabled: !!tid && !!siteId && selectedRowIdsList.length > 0,
    queryFn: () =>
      api<DeploymentPreviewRow[]>(
        `${base}/preview?siteId=${siteId}&sheets=${sheetsFor(selectedRowIds).join(',')}&rowIds=${selectedRowIdsList.join(',')}`,
      ),
  });
  const autoIncludedRowIds = new Set((dependencyPreview.data ?? []).filter((r) => r.autoIncluded).map((r) => r.rowId));

  const run = useMutation({
    mutationFn: ({ mode, everyone }: { mode: 'dry_run' | 'execute'; everyone: boolean }) =>
      api(base, {
        method: 'POST',
        body: JSON.stringify({
          connectionId: activeConn?.id,
          mode,
          scope: {
            siteId,
            sheets: everyone ? [...DEPLOYMENT_SHEETS] : sheetsFor(selectedRowIds),
            rowIds: everyone ? undefined : [...selectedRowIds],
          },
        }),
      }),
    onSuccess: () => {
      setSelectedRowIds(new Set());
      qc.invalidateQueries({ queryKey: ['deployments', tid] });
      qc.invalidateQueries({ queryKey: ['deployment-preview', tid, siteId] });
      qc.invalidateQueries({ queryKey: ['deployment-summary', tid] });
    },
  });

  const generateDoc = useMutation({
    mutationFn: () =>
      api<FileRow>(`${base}/sites/${siteId}/generate-document`, {
        method: 'POST',
        body: JSON.stringify({ rowIds: selectedRowIds.size ? [...selectedRowIds] : undefined }),
      }),
    onSuccess: (file) => setGeneratedFile(file),
  });

  if (!tid) return <NoTenant />;
  if (rollup.isLoading) return <Spinner label="Loading site…" />;
  if (rollup.isError) return <LoadError message={(rollup.error as Error).message} />;

  const site = rollup.data?.find((r) => r.id === siteId);
  if (!site) return <LoadError message="Site not found." />;

  const rows = preview.data ?? [];
  const toggleRow = (rowId: string) =>
    setSelectedRowIds((prev) => {
      const next = new Set(prev);
      if (next.has(rowId)) next.delete(rowId);
      else next.add(rowId);
      return next;
    });
  const toggleAll = () =>
    setSelectedRowIds((prev) => (prev.size === rows.length ? new Set() : new Set(rows.map((r) => r.rowId))));
  /** Ticks a whole group (a wave, or an object type); unticks it when every row in it is already ticked. */
  const toggleGroup = (ids: string[]) =>
    setSelectedRowIds((prev) => {
      const next = new Set(prev);
      const all = ids.every((id) => next.has(id));
      for (const id of ids) {
        if (all) next.delete(id);
        else next.add(id);
      }
      return next;
    });
  // The groups the table shows, in order: object types in deployment order, or waves in name order (rows keep their type order inside a wave).
  const groups = groupDeploymentRows(rows, groupBy, GROUP_ORDER, OBJECT_TYPE_LABEL);

  return (
    <Page
      title={site.name || site.sitecode}
      subtitle={`Deployment · ${site.sitecode}`}
      actions={
        <RouterLink to="/deployment">
          <Button appearance="subtle" icon={<ArrowLeftRegular />}>
            All sites
          </Button>
        </RouterLink>
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
        {teamsReadOnly && (
          <Badge appearance="tint" color="warning" title="Live changes are disabled for this customer - every run is forced to dry-run.">
            Read-only tenant
          </Badge>
        )}
        {!activeConn && (
          <Text size={200} className={s.muted}>
            No active tenant connection — planned changes still preview below; What-If/Execute need a connection
            from the Deployment landing page.
          </Text>
        )}
      </div>

      <TabList selectedValue={tab} onTabSelect={(_, d) => setTab(d.value as typeof tab)}>
        <Tab value="changes">Planned changes</Tab>
        <Tab value="history">Run history</Tab>
      </TabList>

      {tab === 'changes' && (
        <Card className={s.card}>
          <div className={mergeClasses(cs.row, ls.justifySpacebetween)}>
            <div className={cs.row}>
              <Text weight="semibold" size={400}>
                Planned changes <span className={s.muted}>({rows.length})</span>
              </Text>
              <Text size={200} className={s.muted}>
                Group by
              </Text>
              <Button size="small" appearance={groupBy === 'type' ? 'primary' : 'secondary'} aria-pressed={groupBy === 'type'} onClick={() => setGroupBy('type')}>
                Object type
              </Button>
              <Button size="small" appearance={groupBy === 'wave' ? 'primary' : 'secondary'} aria-pressed={groupBy === 'wave'} onClick={() => setGroupBy('wave')}>
                Wave
              </Button>
            </div>
            <div className={cs.row}>
              <Button
                disabled={!activeConn || !canDryRun || run.isPending}
                onClick={() => run.mutate({ mode: 'dry_run', everyone: selectedRowIds.size === 0 })}
              >
                {selectedRowIds.size > 0 ? `What-If selected (${selectedRowIds.size})` : 'What-If everything'}
              </Button>
              <Button
                appearance="primary"
                disabled={!activeConn || !canExecute || teamsReadOnly || run.isPending}
                title={teamsReadOnly ? 'This customer tenant is read-only - live changes are disabled.' : undefined}
                onClick={() => {
                  if (selectedRowIds.size === 0) setConfirmWholeSiteDeploy(true);
                  else run.mutate({ mode: 'execute', everyone: false });
                }}
              >
                {selectedRowIds.size > 0 ? `Deploy selected (${selectedRowIds.size})` : 'Deploy everything'}
              </Button>
              <Button disabled={!canDryRun || generateDoc.isPending} onClick={() => generateDoc.mutate()}>
                {generateDoc.isPending ? 'Generating…' : 'Generate change document'}
              </Button>
            </div>
          </div>
          <Text size={200} className={s.muted}>
            Only rows with something to change are shown — a row disappears once it matches the tenant. Voicemail
            settings are only checked against live Teams data for a UPN after a targeted "Validate against tenant"
            check has run for it — until then that command always re-runs when a target is set. What-If mode runs
            every check but sends nothing to Microsoft Teams — cmdlets are rendered to a script instead. Select rows
            below to act on just those.
          </Text>
          {selectedRowIds.size === 0 && rows.length > 0 && (
            <div className={cs.wholeSiteBanner}>
              <WarningRegular />
              <Text size={200}>
                Nothing selected — What-If/Deploy will act on <b>all {rows.length} rows</b> (the whole site).
              </Text>
            </div>
          )}
          <Dialog open={confirmWholeSiteDeploy} onOpenChange={(_, d) => setConfirmWholeSiteDeploy(d.open)}>
            <DialogSurface>
              <DialogBody>
                <DialogTitle>Deploy the whole site?</DialogTitle>
                <DialogContent>
                  <Text block>
                    Nothing is selected, so this will run every planned change below live — <b>all {rows.length} rows</b>{' '}
                    across users, common area phones, resource accounts, call queues and auto attendants for{' '}
                    {site.name || site.sitecode}.
                  </Text>
                  <Text block className={ls.mt8}>
                    Select specific rows first if you meant to deploy only some of them.
                  </Text>
                </DialogContent>
                <DialogActions>
                  <DialogTrigger disableButtonEnhancement>
                    <Button appearance="secondary">Cancel</Button>
                  </DialogTrigger>
                  <Button
                    appearance="primary"
                    disabled={run.isPending}
                    onClick={() => {
                      run.mutate({ mode: 'execute', everyone: true });
                      setConfirmWholeSiteDeploy(false);
                    }}
                  >
                    Deploy all {rows.length} rows
                  </Button>
                </DialogActions>
              </DialogBody>
            </DialogSurface>
          </Dialog>
          {generateDoc.isError && (
            <Text size={200} className={ls.colored}>
              {generateDoc.error instanceof ApiError ? generateDoc.error.message : 'Could not generate the document'}
            </Text>
          )}
          {generatedFile && (
            <Text size={200}>
              Generated{' '}
              <Link
                onClick={() => apiDownload(`/t/${tid}/files/${generatedFile.id}/download`, generatedFile.filename)}
              >
                {generatedFile.filename}
              </Link>{' '}
              — also available from the Files browser.
            </Text>
          )}

          {preview.isLoading ? (
            <Spinner size="tiny" />
          ) : preview.isError ? (
            <LoadError message={(preview.error as Error).message} />
          ) : rows.length === 0 ? (
            <Text size={200} className={s.muted}>
              No changes are planned for this site right now.
            </Text>
          ) : (
            <DataTable size="small" minWidth={900}>
              <TableHeader>
                <TableRow>
                  <TableHeaderCell>
                    <Checkbox checked={selectedRowIds.size === rows.length} onChange={toggleAll} />
                  </TableHeaderCell>
                  <TableHeaderCell>UPN</TableHeaderCell>
                  <TableHeaderCell>Type</TableHeaderCell>
                  <TableHeaderCell>Commands</TableHeaderCell>
                </TableRow>
              </TableHeader>
              <TableBody>
                {groups.flatMap((g) => {
                  const group = g.rows;
                  const ids = group.map((r) => r.rowId);
                  const ticked = ids.filter((id) => selectedRowIds.has(id)).length;
                  return [
                    <TableRow key={`group-${g.key}`}>
                      <TableCell className={cs.groupHeaderCell}>
                        <Checkbox
                          checked={ticked === ids.length ? true : ticked > 0 ? 'mixed' : false}
                          onChange={() => toggleGroup(ids)}
                          aria-label={`Select all ${g.label}`}
                        />
                      </TableCell>
                      <TableCell colSpan={3} className={cs.groupHeaderCell}>
                        {g.label} · {group.length}
                      </TableCell>
                    </TableRow>,
                    ...group.map((r) => (
                      <TableRow key={r.rowId}>
                        <TableCell>
                          <Checkbox checked={selectedRowIds.has(r.rowId)} onChange={() => toggleRow(r.rowId)} />
                        </TableCell>
                        <TableCell>
                          {r.upn}
                          {autoIncludedRowIds.has(r.rowId) && (
                            <Badge
                              className={cs.autoIncludedTag}
                              appearance="filled"
                              color="brand"
                              title="Not selected directly - included automatically because a selected Call Queue/Auto Attendant references it."
                            >
                              included automatically
                            </Badge>
                          )}
                        </TableCell>
                        <TableCell>{OBJECT_TYPE_LABEL[r.objectType]}</TableCell>
                        <TableCell>
                          {(r.skipReasons?.length ?? 0) > 0 ? (
                            <>
                              <Badge appearance="tint" color="informative" title="This row is left out of the deployment until the problem is fixed in Design & Build. The rest of the deployment goes ahead.">
                                not deployed
                              </Badge>
                              {r.skipReasons!.map((reason) => (
                                <div key={reason} className={cs.warningRow}>
                                  <WarningRegular className={cs.warningIcon} />
                                  <span>{reason}</span>
                                </div>
                              ))}
                              <RouterLink to={`/build/sites/${siteId}?tab=issues`}>Fix in Design &amp; Build</RouterLink>
                            </>
                          ) : (
                            r.renderedCommands.length > 0 && <pre className={cs.commands}>{r.renderedCommands.join('\n')}</pre>
                          )}
                          {r.warnings.map((w) => (
                            <div key={w} className={cs.warningRow}>
                              <WarningRegular className={cs.warningIcon} />
                              <span>{w}</span>
                            </div>
                          ))}
                        </TableCell>
                      </TableRow>
                    )),
                  ];
                })}
              </TableBody>
            </DataTable>
          )}
        </Card>
      )}

      {tab === 'history' && (
        <>
          <Card className={s.card}>
            <Text weight="semibold" size={400}>
              Run history
            </Text>
            {rollbackError && <DangerText>{rollbackError}</DangerText>}
            <DataTable size="small" minWidth={1000}>
              <TableHeader>
                <TableRow>
                  <TableHeaderCell>Created</TableHeaderCell>
                  <TableHeaderCell>Mode</TableHeaderCell>
                  <TableHeaderCell>Status</TableHeaderCell>
                  <TableHeaderCell>Summary</TableHeaderCell>
                  <TableHeaderCell>Verification</TableHeaderCell>
                  <TableHeaderCell></TableHeaderCell>
                </TableRow>
              </TableHeader>
              <TableBody>
                {siteDeployments.map((d) => {
                  const badge = runStatusBadge(d);
                  return (
                  <TableRow key={d.id}>
                    <TableCell>{new Date(d.created_at).toLocaleString()}</TableCell>
                    <TableCell>{d.mode}</TableCell>
                    <TableCell>
                      <Badge appearance="tint" color={badge.color} icon={badge.icon ? <WarningRegular /> : undefined}>
                        {badge.label}
                      </Badge>
                    </TableCell>
                    <TableCell>
                      {Object.keys(d.summary ?? {}).length ? (
                        <div className={ls.flexWrapGap6}>
                          {Object.entries(d.summary ?? {}).map(([k, v]) => (
                            <Badge
                              key={k}
                              appearance={k === 'failed' && v > 0 ? 'tint' : 'outline'}
                              color={k === 'failed' && v > 0 ? 'danger' : 'informative'}
                            >
                              {k}:{v}
                            </Badge>
                          ))}
                        </div>
                      ) : (
                        '—'
                      )}
                      {(d.scope?.autoIncludedRowIds?.length ?? 0) > 0 && (
                        <Badge
                          className={cs.autoIncludedNote}
                          appearance="filled"
                          color="brand"
                          title="Call Queue/Auto Attendant rows in this run referenced Users that weren't selected directly - their own config was pulled in and deployed first."
                        >
                          +{d.scope!.autoIncludedRowIds!.length} row{d.scope!.autoIncludedRowIds!.length === 1 ? '' : 's'} included automatically
                        </Badge>
                      )}
                    </TableCell>
                    <TableCell>
                      {d.verification ? (
                        <VerificationCell v={d.verification} />
                      ) : d.mode === 'execute' && (d.status === 'queued' || d.status === 'running') ? (
                        <Text size={200}>After the run</Text>
                      ) : (
                        '—'
                      )}
                    </TableCell>
                    <TableCell>
                      <div className={ls.flexColGap4}>
                        <Link onClick={() => setSelectedDeployment(d.id)}>View changes</Link>
                        {d.mode === 'execute' && (d.status === 'completed' || d.status === 'failed') && (d.summary?.applied ?? 0) > 0 && (
                          <Link
                            title="A PowerShell script that puts back the previous numbers, policies and voicemail settings. Voxshift never runs it - review it and run it yourself."
                            onClick={() => {
                              setRollbackError(null);
                              apiDownload(`${base}/${d.id}/rollback-script`, `rollback-${d.id}.ps1`).catch((e) =>
                                setRollbackError(e instanceof ApiError ? e.message : 'Could not download the rollback script'),
                              );
                            }}
                          >
                            Download rollback script
                          </Link>
                        )}
                      </div>
                    </TableCell>
                  </TableRow>
                  );
                })}
              </TableBody>
            </DataTable>
          </Card>

          {selectedDeployment && (
            <Card className={s.card}>
              <Text weight="semibold">Change audit · deployment {selectedDeployment.slice(0, 8)}</Text>
              {changes.isLoading ? (
                <Spinner size="tiny" />
              ) : (
                <DataTable size="small" minWidth={880}>
                  <TableHeader>
                    <TableRow>
                      <TableHeaderCell>#</TableHeaderCell>
                      <TableHeaderCell>Object</TableHeaderCell>
                      <TableHeaderCell>Cmdlet</TableHeaderCell>
                      <TableHeaderCell>Result</TableHeaderCell>
                      <TableHeaderCell>Detail</TableHeaderCell>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {(changes.data ?? []).map((c) => (
                      <TableRow
                        key={c.id}
                        style={c.result === 'failed' ? { backgroundColor: 'var(--colorPaletteRedBackground1)' } : undefined}
                      >
                        <TableCell>{c.seq}</TableCell>
                        <TableCell>{c.object_type}</TableCell>
                        <TableCell className={cs.mono}>{c.cmdlet}</TableCell>
                        <TableCell>
                          <Badge
                            appearance="tint"
                            color={RESULT_BADGE_COLOR[c.result] ?? 'informative'}
                            icon={c.result === 'failed' ? <WarningRegular /> : undefined}
                          >
                            {c.result}
                          </Badge>
                        </TableCell>
                        <TableCell className={cs.mono}>
                          <div className={ls.maxW420PreWrap}>{c.message ?? ''}</div>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </DataTable>
              )}
            </Card>
          )}
        </>
      )}
    </Page>
  );
}
