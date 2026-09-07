import { useQuery } from '@tanstack/react-query';
import {
  Card,
  Spinner,
  Table,
  TableBody,
  TableCell,
  TableHeader,
  TableHeaderCell,
  TableRow,
} from '@fluentui/react-components';
import { api } from '../../api';
import { Page } from '../../components/Page';
import { LoadError } from '../DataCollection';

interface Entry {
  id: string;
  at: string;
  actor_email: string | null;
  action: string;
  target_type: string | null;
  target_id: string | null;
  tenant_id: string | null;
}

export function AdminAudit() {
  const q = useQuery({
    queryKey: ['platform-audit'],
    refetchInterval: 10000,
    queryFn: () => api<Entry[]>('/audit/platform'),
  });

  return (
    <Page title="Platform Audit" subtitle="Authentication, user and customer administration, and tenant connections.">
      <Card>
        {q.isLoading ? (
          <Spinner size="tiny" />
        ) : q.isError ? (
          <LoadError message={(q.error as Error).message} />
        ) : (
          <Table size="small">
            <TableHeader>
              <TableRow>
                <TableHeaderCell>When</TableHeaderCell>
                <TableHeaderCell>Actor</TableHeaderCell>
                <TableHeaderCell>Action</TableHeaderCell>
                <TableHeaderCell>Target</TableHeaderCell>
              </TableRow>
            </TableHeader>
            <TableBody>
              {q.data!.map((e) => (
                <TableRow key={e.id}>
                  <TableCell>{new Date(e.at).toLocaleString()}</TableCell>
                  <TableCell>{e.actor_email ?? '—'}</TableCell>
                  <TableCell>{e.action}</TableCell>
                  <TableCell>
                    {e.target_type ? `${e.target_type}${e.target_id ? ` ${e.target_id.slice(0, 8)}` : ''}` : '—'}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </Card>
    </Page>
  );
}
