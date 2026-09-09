import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  Button,
  Card,
  Input,
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
  stats: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(150px,1fr))', ...shorthands.gap('12px') },
  stat: { ...shorthands.padding('14px') },
  addRow: { display: 'flex', ...shorthands.gap('8px'), alignItems: 'end', flexWrap: 'wrap' },
});

interface Summary {
  users: number;
  caps: number;
  autoAttendants: number;
  callQueues: number;
  m365Groups: number;
}
interface BuildUser {
  id: string;
  upn: string;
  e164: string | null;
  number_type: string | null;
  migration_wave: string | null;
}

export function Build() {
  const s = useStyles();
  const { activeTenantId, can } = useAuth();
  const qc = useQueryClient();
  const [upn, setUpn] = useState('');
  const [did, setDid] = useState('');

  const summary = useQuery({
    queryKey: ['build-summary', activeTenantId],
    enabled: !!activeTenantId,
    queryFn: () => api<Summary>(`/t/${activeTenantId}/build/summary`),
  });
  const users = useQuery({
    queryKey: ['build-users', activeTenantId],
    enabled: !!activeTenantId,
    queryFn: () => api<BuildUser[]>(`/t/${activeTenantId}/build/users`),
  });
  const addUser = useMutation({
    mutationFn: () =>
      api(`/t/${activeTenantId}/build/users`, { method: 'POST', body: JSON.stringify({ upn, did }) }),
    onSuccess: () => {
      setUpn('');
      setDid('');
      qc.invalidateQueries({ queryKey: ['build-users', activeTenantId] });
      qc.invalidateQueries({ queryKey: ['build-summary', activeTenantId] });
    },
  });

  if (!activeTenantId) return <NoTenant />;
  if (summary.isError) return <LoadError message={(summary.error as Error).message} />;

  const st = summary.data;
  return (
    <Page
      title="Design & Build"
      subtitle="Map users and phones to Teams voice policies and numbers. Replaces the build workbook."
    >
      <div className={s.stats}>
        {(
          [
            ['Users', st?.users],
            ['Common area phones', st?.caps],
            ['Auto attendants', st?.autoAttendants],
            ['Call queues', st?.callQueues],
            ['M365 groups', st?.m365Groups],
          ] as const
        ).map(([label, n]) => (
          <Card key={label} className={s.stat}>
            <Text size={500} weight="semibold">
              {summary.isLoading ? '—' : (n ?? 0)}
            </Text>
            <Text size={200}>{label}</Text>
          </Card>
        ))}
      </div>

      {can('build:write') && (
        <Card>
          <Text weight="semibold">Add a user row</Text>
          <div className={s.addRow}>
            <div style={{ display: 'grid', gap: 4 }}>
              <Text size={200}>User principal name</Text>
              <Input value={upn} onChange={(_, d) => setUpn(d.value)} placeholder="user@customer.com" />
            </div>
            <div style={{ display: 'grid', gap: 4 }}>
              <Text size={200}>DID</Text>
              <Input value={did} onChange={(_, d) => setDid(d.value)} placeholder="+1913…" />
            </div>
            <Button appearance="primary" disabled={!upn || addUser.isPending} onClick={() => addUser.mutate()}>
              Add
            </Button>
          </div>
        </Card>
      )}

      <Card>
        <Text weight="semibold">User rows</Text>
        {users.isLoading ? (
          <Spinner size="tiny" />
        ) : (users.data?.length ?? 0) === 0 ? (
          <Text size={200}>No user rows yet.</Text>
        ) : (
          <DataTable size="small" minWidth={620}>
            <TableHeader>
              <TableRow>
                <TableHeaderCell>UPN</TableHeaderCell>
                <TableHeaderCell>Number</TableHeaderCell>
                <TableHeaderCell>Type</TableHeaderCell>
                <TableHeaderCell>Wave</TableHeaderCell>
              </TableRow>
            </TableHeader>
            <TableBody>
              {users.data!.map((u) => (
                <TableRow key={u.id}>
                  <TableCell>{u.upn}</TableCell>
                  <TableCell>{u.e164 ?? u.number_type ? u.e164 ?? '—' : '—'}</TableCell>
                  <TableCell>{u.number_type ?? '—'}</TableCell>
                  <TableCell>{u.migration_wave ?? '—'}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </DataTable>
        )}
      </Card>
    </Page>
  );
}
