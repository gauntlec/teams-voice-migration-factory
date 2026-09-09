import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
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
import { api } from '../api';
import { useAuth } from '../auth';
import { DataTable } from '../components/DataTable';
import { Page } from '../components/Page';
import { LoadError, NoTenant } from './DataCollection';

const useStyles = makeStyles({
  row: { display: 'flex', ...shorthands.gap('8px'), flexWrap: 'wrap', alignItems: 'center' },
  mono: { fontFamily: 'ui-monospace, monospace' },
});

interface Connection {
  id: string;
  status: string;
  user_code: string | null;
  verification_uri: string | null;
  upn: string | null;
  started_at: string;
}
interface Deployment {
  id: string;
  mode: string;
  status: string;
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

export function Deployment() {
  const s = useStyles();
  const { activeTenantId, can } = useAuth();
  const qc = useQueryClient();
  const [selected, setSelected] = useState<string | null>(null);

  const connections = useQuery({
    queryKey: ['connections', activeTenantId],
    enabled: !!activeTenantId,
    refetchInterval: 4000,
    queryFn: () => api<Connection[]>(`/t/${activeTenantId}/deployments/connections`),
  });
  const deployments = useQuery({
    queryKey: ['deployments', activeTenantId],
    enabled: !!activeTenantId,
    refetchInterval: 4000,
    queryFn: () => api<Deployment[]>(`/t/${activeTenantId}/deployments`),
  });
  const changes = useQuery({
    queryKey: ['changes', activeTenantId, selected],
    enabled: !!activeTenantId && !!selected,
    queryFn: () => api<Change[]>(`/t/${activeTenantId}/deployments/${selected}/changes`),
  });

  const connect = useMutation({
    mutationFn: () =>
      api(`/t/${activeTenantId}/deployments/connections`, { method: 'POST', body: JSON.stringify({}) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['connections', activeTenantId] }),
  });

  const activeConn = connections.data?.find((c) => c.status === 'active');

  const run = useMutation({
    mutationFn: (mode: 'dry_run' | 'execute') =>
      api(`/t/${activeTenantId}/deployments`, {
        method: 'POST',
        body: JSON.stringify({
          connectionId: activeConn?.id,
          mode,
          scope: { sheets: ['users'] },
        }),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['deployments', activeTenantId] }),
  });

  if (!activeTenantId) return <NoTenant />;
  if (connections.isError) return <LoadError message={(connections.error as Error).message} />;

  return (
    <Page
      title="Deployment"
      subtitle="Sign in to the customer tenant live, run the migration, and review every change. No customer credentials are stored."
    >
      <Card>
        <Text weight="semibold">Tenant connection</Text>
        {connections.isLoading ? (
          <Spinner size="tiny" />
        ) : (
          <>
            {can('deployment:connect') && (
              <div className={s.row}>
                <Button appearance="primary" onClick={() => connect.mutate()} disabled={connect.isPending}>
                  Connect to customer tenant
                </Button>
                <Text size={200}>Starts a device-code sign-in you complete in your browser.</Text>
              </div>
            )}
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
                {(connections.data ?? []).map((c) => (
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
                          <span className={s.mono}>{c.user_code}</span>{' '}
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
          </>
        )}
      </Card>

      <Card>
        <div className={s.row} style={{ justifyContent: 'space-between' }}>
          <Text weight="semibold">Deployments</Text>
          <div className={s.row}>
            <Button
              disabled={!activeConn || run.isPending || !can('deployment:dryrun')}
              onClick={() => run.mutate('dry_run')}
            >
              Dry run (What-If)
            </Button>
            <Button
              appearance="primary"
              disabled={!activeConn || run.isPending || !can('deployment:execute')}
              onClick={() => run.mutate('execute')}
            >
              Execute
            </Button>
          </div>
        </div>
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
            {(deployments.data ?? []).map((d) => (
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
                  <Link onClick={() => setSelected(d.id)}>View changes</Link>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </DataTable>
      </Card>

      {selected && (
        <Card>
          <Text weight="semibold">Change audit · deployment {selected.slice(0, 8)}</Text>
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
                    <TableCell className={s.mono}>{c.cmdlet}</TableCell>
                    <TableCell>{c.result}</TableCell>
                    <TableCell className={s.mono}>
                      <div style={{ maxWidth: 420, whiteSpace: 'pre-wrap' }}>{c.message ?? ''}</div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </DataTable>
          )}
        </Card>
      )}
    </Page>
  );
}
