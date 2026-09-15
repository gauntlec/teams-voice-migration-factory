import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  Card,
  SearchBox,
  Spinner,
  TableBody,
  TableCell,
  TableHeader,
  TableHeaderCell,
  TableRow,
} from '@fluentui/react-components';
import { api } from '../../api';
import { DataTable } from '../../components/DataTable';
import { Page } from '../../components/Page';
import { useDebounced } from '../../hooks/useDebounced';
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
  const [searchInput, setSearchInput] = useState('');
  const search = useDebounced(searchInput);
  const entries = useQuery({
    queryKey: ['platform-audit', search],
    refetchInterval: 10000,
    queryFn: () => api<Entry[]>(`/audit/platform${search ? `?q=${encodeURIComponent(search)}` : ''}`),
  });

  return (
    <Page title="Platform Audit" subtitle="Authentication, user and customer administration, and tenant connections.">
      <Card>
        <SearchBox
          size="small"
          placeholder="Search by actor, action or target…"
          value={searchInput}
          onChange={(_, d) => setSearchInput(d.value)}
          style={{ maxWidth: 320 }}
        />
        {entries.isLoading ? (
          <Spinner size="tiny" />
        ) : entries.isError ? (
          <LoadError message={(entries.error as Error).message} />
        ) : (
          <DataTable size="small" minWidth={760}>
            <TableHeader>
              <TableRow>
                <TableHeaderCell>When</TableHeaderCell>
                <TableHeaderCell>Actor</TableHeaderCell>
                <TableHeaderCell>Action</TableHeaderCell>
                <TableHeaderCell>Target</TableHeaderCell>
              </TableRow>
            </TableHeader>
            <TableBody>
              {entries.data!.map((e) => (
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
          </DataTable>
        )}
      </Card>
    </Page>
  );
}
