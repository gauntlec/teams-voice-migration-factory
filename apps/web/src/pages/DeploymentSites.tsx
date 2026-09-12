import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import {
  Badge,
  Button,
  Card,
  Link,
  Spinner,
  TableBody,
  TableCell,
  TableHeader,
  TableHeaderCell,
  TableRow,
  Text,
  makeStyles,
  shorthands,
} from '@fluentui/react-components';
import { ArrowRightRegular, ChevronLeftRegular, ChevronRightRegular } from '@fluentui/react-icons';
import type { DeploymentSiteRollup } from '@tvmf/shared';
import { api } from '../api';
import { useAuth } from '../auth';
import { DataTable } from '../components/DataTable';
import { Page } from '../components/Page';
import { LoadError, NoTenant, useRecordStyles } from '../components/records';

const useStyles = makeStyles({
  row: { display: 'flex', ...shorthands.gap('8px'), flexWrap: 'wrap', alignItems: 'center' },
  mono: { fontFamily: 'ui-monospace, monospace' },
  pager: { display: 'flex', alignItems: 'center', justifyContent: 'flex-end', ...shorthands.gap('8px') },
});

const CONNECTIONS_PAGE_SIZE = 5;

const DEPLOY_COLOR: Record<string, 'informative' | 'warning' | 'success' | 'danger'> = {
  queued: 'informative',
  running: 'informative',
  completed: 'success',
  failed: 'danger',
  cancelled: 'warning',
};

interface TenantRow {
  id: string;
  teams_read_only: boolean;
}
interface Connection {
  id: string;
  status: string;
  user_code: string | null;
  verification_uri: string | null;
  upn: string | null;
  started_at: string;
}

export function DeploymentSites() {
  const cs = useStyles();
  const s = useRecordStyles();
  const navigate = useNavigate();
  const { activeTenantId, can } = useAuth();
  const qc = useQueryClient();

  const q = useQuery({
    queryKey: ['deployment-summary', activeTenantId],
    enabled: !!activeTenantId,
    queryFn: () => api<DeploymentSiteRollup[]>(`/t/${activeTenantId}/deployments/summary`),
  });

  const tenants = useQuery({ queryKey: ['tenants'], queryFn: () => api<TenantRow[]>('/tenants') });
  const teamsReadOnly = tenants.data?.find((t) => t.id === activeTenantId)?.teams_read_only ?? false;

  const connections = useQuery({
    queryKey: ['connections', activeTenantId],
    enabled: !!activeTenantId,
    refetchInterval: 4000,
    queryFn: () => api<Connection[]>(`/t/${activeTenantId}/deployments/connections`),
  });
  const connect = useMutation({
    mutationFn: () =>
      api(`/t/${activeTenantId}/deployments/connections`, { method: 'POST', body: JSON.stringify({}) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['connections', activeTenantId] }),
  });
  const activeConn = connections.data?.find((c) => c.status === 'active');

  // Connections already come back newest-first, capped at 50 server-side
  // (DeploymentService.listConnections) - this just limits the table to 5
  // rows at a time instead of dumping the whole history on screen.
  const [connPage, setConnPage] = useState(1);
  const connTotal = connections.data?.length ?? 0;
  const connPages = Math.max(1, Math.ceil(connTotal / CONNECTIONS_PAGE_SIZE));
  const connPageClamped = Math.min(connPage, connPages);
  const pagedConnections = (connections.data ?? []).slice(
    (connPageClamped - 1) * CONNECTIONS_PAGE_SIZE,
    connPageClamped * CONNECTIONS_PAGE_SIZE,
  );

  if (!activeTenantId) return <NoTenant />;
  if (q.isLoading) return <Spinner label="Loading Deployment…" />;
  if (q.isError) return <LoadError message={(q.error as Error).message} />;

  const sites = q.data ?? [];
  const open = (id: string) => navigate(`/deployment/sites/${id}`);

  return (
    <Page
      title="Deployment"
      subtitle="Sign in to the customer tenant live, then pick a site to review its planned changes, run them, and generate a change-recording document. No customer credentials are stored."
    >
      <Card className={s.card}>
        <div className={s.cardHead} style={{ justifyContent: 'space-between' }}>
          <Text weight="semibold" size={400}>
            Tenant connection
          </Text>
          {teamsReadOnly && (
            <Badge appearance="tint" color="warning" title="Live changes are disabled for this customer - every run is forced to dry-run.">
              Read-only tenant
            </Badge>
          )}
        </div>
        {connections.isLoading ? (
          <Spinner size="tiny" />
        ) : (
          <>
            {can('deployment:connect') && (
              <div className={cs.row} style={{ marginBottom: 8 }}>
                <Button appearance="primary" onClick={() => connect.mutate()} disabled={connect.isPending}>
                  Connect to customer tenant
                </Button>
                <Text size={200}>
                  Starts a device-code sign-in you complete in your browser. One connection covers every site below.
                </Text>
              </div>
            )}
            {connections.data && connections.data.length > 0 && (
              <DataTable size="small" minWidth={720}>
                <TableHeader>
                  <TableRow>
                    <TableHeaderCell>Started</TableHeaderCell>
                    <TableHeaderCell>Status</TableHeaderCell>
                    <TableHeaderCell>Device code</TableHeaderCell>
                    <TableHeaderCell>Signed in as</TableHeaderCell>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {pagedConnections.map((c) => (
                    <TableRow key={c.id}>
                      <TableCell>{new Date(c.started_at).toLocaleString()}</TableCell>
                      <TableCell>
                        <Badge appearance="tint" color={c.status === 'active' ? 'success' : 'informative'}>
                          {c.status}
                        </Badge>
                      </TableCell>
                      <TableCell>
                        {c.status === 'pending' && c.user_code ? (
                          <span>
                            <span className={cs.mono}>{c.user_code}</span>{' '}
                            {c.verification_uri && (
                              <Link href={c.verification_uri} target="_blank" rel="noreferrer">
                                open sign-in
                              </Link>
                            )}
                          </span>
                        ) : (
                          '—'
                        )}
                      </TableCell>
                      <TableCell>{c.upn ?? '—'}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </DataTable>
            )}
            {connPages > 1 && (
              <div className={cs.pager}>
                <Text size={200} className={s.muted}>
                  Page {connPageClamped} of {connPages} · {connTotal} total
                </Text>
                <Button
                  size="small"
                  appearance="subtle"
                  icon={<ChevronLeftRegular />}
                  disabled={connPageClamped <= 1}
                  onClick={() => setConnPage((p) => Math.max(1, p - 1))}
                />
                <Button
                  size="small"
                  appearance="subtle"
                  icon={<ChevronRightRegular />}
                  disabled={connPageClamped >= connPages}
                  onClick={() => setConnPage((p) => Math.min(connPages, p + 1))}
                />
              </div>
            )}
            {!activeConn && (
              <Text size={200} className={s.muted}>
                Planned changes can be previewed without a connection - only What-If/Execute runs need one.
              </Text>
            )}
          </>
        )}
      </Card>

      <Card className={s.card}>
        <div className={s.cardHead}>
          <Text weight="semibold" size={400}>
            Sites <span className={s.muted}>({sites.length})</span>
          </Text>
        </div>

        {sites.length === 0 ? (
          <Text size={200} className={s.muted}>
            No sites yet — add one in Data Collection first.
          </Text>
        ) : (
          <DataTable size="small" minWidth={780}>
            <TableHeader>
              <TableRow>
                <TableHeaderCell>Sitecode</TableHeaderCell>
                <TableHeaderCell>Name</TableHeaderCell>
                <TableHeaderCell>Users</TableHeaderCell>
                <TableHeaderCell>CAPs</TableHeaderCell>
                <TableHeaderCell>Res. accts</TableHeaderCell>
                <TableHeaderCell>Last deployment</TableHeaderCell>
                <TableHeaderCell />
              </TableRow>
            </TableHeader>
            <TableBody>
              {sites.map((r) => (
                <TableRow key={r.id}>
                  <TableCell>{r.sitecode}</TableCell>
                  <TableCell>{r.name || '—'}</TableCell>
                  <TableCell>{r.counts.users}</TableCell>
                  <TableCell>{r.counts.caps}</TableCell>
                  <TableCell>{r.counts.resourceAccounts}</TableCell>
                  <TableCell>
                    {r.lastDeployment ? (
                      <Badge appearance="tint" color={DEPLOY_COLOR[r.lastDeployment.status] ?? 'informative'}>
                        {r.lastDeployment.mode === 'dry_run' ? 'dry run' : 'deployed'} · {r.lastDeployment.status}
                      </Badge>
                    ) : (
                      '—'
                    )}
                  </TableCell>
                  <TableCell>
                    <Button size="small" appearance="subtle" icon={<ArrowRightRegular />} onClick={() => open(r.id)}>
                      Open
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </DataTable>
        )}
      </Card>
    </Page>
  );
}
