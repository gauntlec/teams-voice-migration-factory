import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link as RouterLink, useParams } from 'react-router-dom';
import {
  Badge,
  Button,
  Card,
  Checkbox,
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
} from '@fluentui/react-components';
import { ArrowLeftRegular } from '@fluentui/react-icons';
import type { DeploymentPreviewRow, DeploymentSiteRollup, FileRow } from '@tvmf/shared';
import { api, apiDownload, ApiError } from '../api';
import { useAuth } from '../auth';
import { DataTable } from '../components/DataTable';
import { Page } from '../components/Page';
import { LoadError, NoTenant, useRecordStyles } from '../components/records';

const useStyles = makeStyles({
  row: { display: 'flex', ...shorthands.gap('8px'), flexWrap: 'wrap', alignItems: 'center' },
  mono: { fontFamily: 'ui-monospace, monospace' },
  commands: { fontFamily: 'ui-monospace, monospace', fontSize: '12px', whiteSpace: 'pre-wrap', margin: 0 },
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
  scope: { siteId?: string } | null;
  summary: Record<string, number>;
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

const OBJECT_TYPE_LABEL: Record<DeploymentPreviewRow['objectType'], string> = {
  user: 'User',
  cap: 'Common Area Phone',
  resource_account: 'Resource Account',
};

export function DeploymentSiteWorkspace() {
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
  const [selectedDeployment, setSelectedDeployment] = useState<string | null>(null);
  const [generatedFile, setGeneratedFile] = useState<FileRow | null>(null);

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
        `${base}/preview?siteId=${siteId}&sheets=users,caps,resource_accounts`,
      ),
  });

  const deployments = useQuery({
    queryKey: ['deployments', tid],
    enabled: !!tid,
    refetchInterval: tab === 'history' ? 4000 : false,
    queryFn: () => api<Deployment[]>(base),
  });
  const siteDeployments = (deployments.data ?? []).filter((d) => d.scope?.siteId === siteId);

  const changes = useQuery({
    queryKey: ['changes', tid, selectedDeployment],
    enabled: !!tid && !!selectedDeployment,
    queryFn: () => api<Change[]>(`${base}/${selectedDeployment}/changes`),
  });

  const sheetsFor = (rowIds: Set<string> | undefined) => {
    if (!rowIds || rowIds.size === 0) return ['users', 'caps', 'resource_accounts'];
    const selectedTypes = new Set(
      (preview.data ?? []).filter((r) => rowIds.has(r.rowId)).map((r) => r.objectType),
    );
    const sheets: string[] = [];
    if (selectedTypes.has('user')) sheets.push('users');
    if (selectedTypes.has('cap')) sheets.push('caps');
    if (selectedTypes.has('resource_account')) sheets.push('resource_accounts');
    return sheets;
  };

  const run = useMutation({
    mutationFn: ({ mode, everyone }: { mode: 'dry_run' | 'execute'; everyone: boolean }) =>
      api(base, {
        method: 'POST',
        body: JSON.stringify({
          connectionId: activeConn?.id,
          mode,
          scope: {
            siteId,
            sheets: everyone ? ['users', 'caps', 'resource_accounts'] : sheetsFor(selectedRowIds),
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
          <div className={cs.row} style={{ justifyContent: 'space-between' }}>
            <Text weight="semibold" size={400}>
              Planned changes <span className={s.muted}>({rows.length})</span>
            </Text>
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
                onClick={() => run.mutate({ mode: 'execute', everyone: selectedRowIds.size === 0 })}
              >
                {selectedRowIds.size > 0 ? `Deploy selected (${selectedRowIds.size})` : 'Deploy everything'}
              </Button>
              <Button disabled={!canDryRun || generateDoc.isPending} onClick={() => generateDoc.mutate()}>
                {generateDoc.isPending ? 'Generating…' : 'Generate change document'}
              </Button>
            </div>
          </div>
          <Text size={200} className={s.muted}>
            Only rows with something to change are shown — a row disappears once it matches the tenant. Voicemail and
            Dial Out Policy can't be checked against live Teams data yet, so those always re-run when a target is set.
            What-If mode runs every check but sends nothing to Microsoft Teams — cmdlets are rendered to a script
            instead. Select rows below to act on just those; with nothing selected, buttons act on the whole site.
          </Text>
          {generateDoc.isError && (
            <Text size={200} style={{ color: 'var(--colorPaletteRedForeground1)' }}>
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
                {rows.map((r) => (
                  <TableRow key={r.rowId}>
                    <TableCell>
                      <Checkbox checked={selectedRowIds.has(r.rowId)} onChange={() => toggleRow(r.rowId)} />
                    </TableCell>
                    <TableCell>{r.upn}</TableCell>
                    <TableCell>{OBJECT_TYPE_LABEL[r.objectType]}</TableCell>
                    <TableCell>
                      <pre className={cs.commands}>{r.renderedCommands.join('\n')}</pre>
                    </TableCell>
                  </TableRow>
                ))}
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
            <DataTable size="small" minWidth={780}>
              <TableHeader>
                <TableRow>
                  <TableHeaderCell>Created</TableHeaderCell>
                  <TableHeaderCell>Mode</TableHeaderCell>
                  <TableHeaderCell>Status</TableHeaderCell>
                  <TableHeaderCell>Summary</TableHeaderCell>
                  <TableHeaderCell></TableHeaderCell>
                </TableRow>
              </TableHeader>
              <TableBody>
                {siteDeployments.map((d) => (
                  <TableRow key={d.id}>
                    <TableCell>{new Date(d.created_at).toLocaleString()}</TableCell>
                    <TableCell>{d.mode}</TableCell>
                    <TableCell>
                      <Badge appearance="tint" color={d.status === 'completed' ? 'success' : 'informative'}>
                        {d.status}
                      </Badge>
                    </TableCell>
                    <TableCell>
                      {Object.entries(d.summary ?? {})
                        .map(([k, v]) => `${k}:${v}`)
                        .join('  ') || '—'}
                    </TableCell>
                    <TableCell>
                      <Link onClick={() => setSelectedDeployment(d.id)}>View changes</Link>
                    </TableCell>
                  </TableRow>
                ))}
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
                      <TableRow key={c.id}>
                        <TableCell>{c.seq}</TableCell>
                        <TableCell>{c.object_type}</TableCell>
                        <TableCell className={cs.mono}>{c.cmdlet}</TableCell>
                        <TableCell>{c.result}</TableCell>
                        <TableCell className={cs.mono}>
                          <div style={{ maxWidth: 420, whiteSpace: 'pre-wrap' }}>{c.message ?? ''}</div>
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
