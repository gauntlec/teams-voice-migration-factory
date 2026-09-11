import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  Badge,
  Card,
  Dropdown,
  Link,
  Option,
  Spinner,
  TableBody,
  TableCell,
  TableHeader,
  TableHeaderCell,
  TableRow,
  Text,
} from '@fluentui/react-components';
import type { FileRow } from '@tvmf/shared';
import { api, apiDownload, ApiError } from '../api';
import { useAuth } from '../auth';
import { DataTable } from '../components/DataTable';
import { Page } from '../components/Page';
import { LoadError, NoTenant, useRecordStyles } from '../components/records';

const CATEGORY_LABEL: Record<string, string> = {
  deployment_change_document: 'Deployment change document',
};

interface Site {
  id: string;
  sitecode: string;
  name: string | null;
}

export function Files() {
  const s = useRecordStyles();
  const { activeTenantId: tid } = useAuth();
  const [siteId, setSiteId] = useState<string>('');
  const [downloadError, setDownloadError] = useState<string | null>(null);

  // Site picker: Deployment's summary needs deployment:read, which
  // PROJECT_MANAGER and CUSTOMER don't have, but this page (files:read) is
  // visible to all 4 roles - so it lists sites via Data Collection's landing
  // endpoint (discovery:read, granted to all 4, and already site-scope-aware
  // for a CUSTOMER site contact) instead.
  const sites = useQuery({
    queryKey: ['discovery-sites', tid],
    enabled: !!tid,
    queryFn: () => api<{ sites: Site[] }>(`/t/${tid}/discovery`).then((r) => r.sites),
  });

  const files = useQuery({
    queryKey: ['files', tid, siteId],
    enabled: !!tid,
    queryFn: () => api<FileRow[]>(`/t/${tid}/files${siteId ? `?siteId=${siteId}` : ''}`),
  });

  if (!tid) return <NoTenant />;

  const download = async (f: FileRow) => {
    setDownloadError(null);
    try {
      await apiDownload(`/t/${tid}/files/${f.id}/download`, f.filename);
    } catch (e) {
      setDownloadError(e instanceof ApiError ? e.message : 'Could not download the file');
    }
  };

  return (
    <Page title="Files" subtitle="Browse generated and stored files for this customer, per site.">
      <Card className={s.card}>
        <div className={s.cardHead}>
          <Text weight="semibold" size={400}>
            Files <span className={s.muted}>({files.data?.length ?? 0})</span>
          </Text>
          <Dropdown
            placeholder="All sites"
            value={sites.data?.find((x) => x.id === siteId)?.sitecode ?? 'All sites'}
            selectedOptions={[siteId]}
            onOptionSelect={(_, d) => setSiteId(d.optionValue ?? '')}
          >
            <Option value="">All sites</Option>
            {(sites.data ?? []).map((site) => (
              <Option key={site.id} value={site.id} text={site.sitecode}>
                {site.name ? `${site.sitecode} — ${site.name}` : site.sitecode}
              </Option>
            ))}
          </Dropdown>
        </div>

        {downloadError && <LoadError message={downloadError} />}

        {files.isLoading ? (
          <Spinner label="Loading files…" />
        ) : files.isError ? (
          <LoadError message={(files.error as Error).message} />
        ) : (files.data ?? []).length === 0 ? (
          <Text size={200} className={s.muted}>
            No files yet.
          </Text>
        ) : (
          <DataTable size="small" minWidth={860}>
            <TableHeader>
              <TableRow>
                <TableHeaderCell>Filename</TableHeaderCell>
                <TableHeaderCell>Category</TableHeaderCell>
                <TableHeaderCell>Size</TableHeaderCell>
                <TableHeaderCell>Created</TableHeaderCell>
                <TableHeaderCell />
              </TableRow>
            </TableHeader>
            <TableBody>
              {(files.data ?? []).map((f) => (
                <TableRow key={f.id}>
                  <TableCell>{f.filename}</TableCell>
                  <TableCell>
                    <Badge appearance="tint" color="informative">
                      {CATEGORY_LABEL[f.category] ?? f.category}
                    </Badge>
                  </TableCell>
                  <TableCell>{(f.byteSize / 1024).toFixed(1)} KB</TableCell>
                  <TableCell>{new Date(f.createdAt).toLocaleString()}</TableCell>
                  <TableCell>
                    <Link onClick={() => download(f)}>Download</Link>
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
