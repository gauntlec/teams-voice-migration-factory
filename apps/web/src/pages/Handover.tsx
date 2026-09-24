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
} from '@fluentui/react-components';
import { api, apiDownload, ApiError } from '../api';
import { useAuth } from '../auth';
import { DataTable } from '../components/DataTable';
import { Page } from '../components/Page';
import { LoadError, NoTenant } from './DataCollection';

interface Pack {
  id: string;
  version: number;
  status: string;
  generated_at: string | null;
  file_id: string | null;
  created_at: string;
}

export function Handover() {
  const { activeTenantId, can } = useAuth();
  const qc = useQueryClient();
  const [downloadError, setDownloadError] = useState<string | null>(null);
  const packs = useQuery({
    queryKey: ['handover', activeTenantId],
    enabled: !!activeTenantId,
    queryFn: () => api<Pack[]>(`/t/${activeTenantId}/handover/packs`),
  });
  const generate = useMutation({
    mutationFn: () => api(`/t/${activeTenantId}/handover/packs`, { method: 'POST', body: JSON.stringify({}) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['handover', activeTenantId] }),
  });

  const download = async (p: Pack) => {
    setDownloadError(null);
    try {
      await apiDownload(`/t/${activeTenantId}/files/${p.file_id}/download`, `service-handover-v${p.version}.docx`);
    } catch (e) {
      setDownloadError(e instanceof ApiError ? e.message : 'Could not download the file');
    }
  };

  if (!activeTenantId) return <NoTenant />;
  if (packs.isError) return <LoadError message={(packs.error as Error).message} />;

  return (
    <Page
      title="Service Handover"
      subtitle="Generate the handover pack from the final tenant configuration, using the existing document as the template."
      actions={
        can('handover:generate') ? (
          <Button appearance="primary" onClick={() => generate.mutate()} disabled={generate.isPending}>
            Generate draft pack
          </Button>
        ) : undefined
      }
    >
      {downloadError && <LoadError message={downloadError} />}
      <Card>
        {packs.isLoading ? (
          <Spinner size="tiny" />
        ) : (packs.data?.length ?? 0) === 0 ? (
          <Text size={200}>No handover packs generated yet.</Text>
        ) : (
          <DataTable size="small" minWidth={520}>
            <TableHeader>
              <TableRow>
                <TableHeaderCell>Version</TableHeaderCell>
                <TableHeaderCell>Status</TableHeaderCell>
                <TableHeaderCell>Created</TableHeaderCell>
                <TableHeaderCell>Document</TableHeaderCell>
              </TableRow>
            </TableHeader>
            <TableBody>
              {packs.data!.map((p) => (
                <TableRow key={p.id}>
                  <TableCell>v{p.version}</TableCell>
                  <TableCell>
                    <Badge appearance="tint" color={p.status === 'issued' ? 'success' : 'informative'}>
                      {p.status}
                    </Badge>
                  </TableCell>
                  <TableCell>{new Date(p.created_at).toLocaleString()}</TableCell>
                  <TableCell>{p.file_id ? <Link onClick={() => download(p)}>Download .docx</Link> : '—'}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </DataTable>
        )}
      </Card>
    </Page>
  );
}
