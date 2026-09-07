import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  Badge,
  Button,
  Card,
  MessageBar,
  MessageBarBody,
  Spinner,
  Table,
  TableBody,
  TableCell,
  TableHeader,
  TableHeaderCell,
  TableRow,
  Text,
} from '@fluentui/react-components';
import { api } from '../api';
import { useAuth } from '../auth';
import { Page } from '../components/Page';

interface DiscoveryResponse {
  discovery: { id: string; status: string; submitted_at: string | null } | null;
  sites: { id: string; name: string | null; site_code: string | null; country: string | null }[];
  ranges: { id: string; range_start: string; range_end: string; kind: string }[];
  network: { id: string; scope: string; subnet: string }[];
}

export function DataCollection() {
  const { activeTenantId, can } = useAuth();
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: ['discovery', activeTenantId],
    enabled: !!activeTenantId,
    queryFn: () => api<DiscoveryResponse>(`/t/${activeTenantId}/discovery`),
  });

  const submit = useMutation({
    mutationFn: () => api(`/t/${activeTenantId}/discovery/submit`, { method: 'POST' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['discovery', activeTenantId] }),
  });

  if (!activeTenantId) return <NoTenant />;
  if (q.isLoading) return <Spinner label="Loading discovery…" />;
  if (q.isError) return <LoadError message={(q.error as Error).message} />;

  const d = q.data!;
  return (
    <Page
      title="Data Collection"
      subtitle="Discovery of the customer's current voice estate. Replaces the discovery workbook."
      actions={
        can('discovery:write') && d.discovery?.status !== 'submitted' ? (
          <Button appearance="primary" onClick={() => submit.mutate()} disabled={submit.isPending}>
            Submit discovery
          </Button>
        ) : undefined
      }
    >
      <Text>
        Status:{' '}
        <Badge appearance="tint" color={d.discovery?.status === 'submitted' ? 'success' : 'informative'}>
          {d.discovery?.status ?? 'draft'}
        </Badge>
      </Text>

      <Card>
        <Text weight="semibold">Sites ({d.sites.length})</Text>
        {d.sites.length === 0 ? (
          <Text size={200}>No sites captured yet.</Text>
        ) : (
          <Table size="small">
            <TableHeader>
              <TableRow>
                <TableHeaderCell>Name</TableHeaderCell>
                <TableHeaderCell>Code</TableHeaderCell>
                <TableHeaderCell>Country</TableHeaderCell>
              </TableRow>
            </TableHeader>
            <TableBody>
              {d.sites.map((s) => (
                <TableRow key={s.id}>
                  <TableCell>{s.name ?? '—'}</TableCell>
                  <TableCell>{s.site_code ?? '—'}</TableCell>
                  <TableCell>{s.country ?? '—'}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </Card>

      <Card>
        <Text weight="semibold">Number ranges ({d.ranges.length})</Text>
        {d.ranges.length === 0 ? (
          <Text size={200}>No number ranges captured yet.</Text>
        ) : (
          <Table size="small">
            <TableHeader>
              <TableRow>
                <TableHeaderCell>From</TableHeaderCell>
                <TableHeaderCell>To</TableHeaderCell>
                <TableHeaderCell>Kind</TableHeaderCell>
              </TableRow>
            </TableHeader>
            <TableBody>
              {d.ranges.map((r) => (
                <TableRow key={r.id}>
                  <TableCell>{r.range_start}</TableCell>
                  <TableCell>{r.range_end}</TableCell>
                  <TableCell>{r.kind}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </Card>
    </Page>
  );
}

export function NoTenant() {
  return (
    <MessageBar intent="info">
      <MessageBarBody>Select a customer from the switcher in the header to continue.</MessageBarBody>
    </MessageBar>
  );
}

export function LoadError({ message }: { message: string }) {
  return (
    <MessageBar intent="error">
      <MessageBarBody>{message}</MessageBarBody>
    </MessageBar>
  );
}
