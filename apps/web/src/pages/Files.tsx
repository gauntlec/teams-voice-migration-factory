import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  Badge,
  Button,
  Card,
  Checkbox,
  Input,
  Link,
  Popover,
  PopoverSurface,
  PopoverTrigger,
  SearchBox,
  Spinner,
  TableBody,
  TableCell,
  TableHeader,
  TableHeaderCell,
  TableRow,
  Text,
  tokens,
} from '@fluentui/react-components';
import { FilterRegular } from '@fluentui/react-icons';
import type { FileRow } from '@tvmf/shared';
import { api, apiDownload, ApiError } from '../api';
import { useAuth } from '../auth';
import { DataTable } from '../components/DataTable';
import { Page } from '../components/Page';
import { useDebounced } from '../hooks/useDebounced';
import { LoadError, NoTenant, useRecordStyles } from '../components/records';

const CATEGORY_LABEL: Record<string, string> = {
  deployment_change_document: 'Deployment change document',
  number_port_document: 'Number port document',
};

interface Site {
  id: string;
  sitecode: string;
  name: string | null;
}

/** Excel-style column filter: a search box plus a checkbox per distinct value, applied immediately. */
function ColumnFilter({
  label,
  options,
  selected,
  onChange,
}: {
  label: string;
  options: { value: string; label: string }[];
  selected: Set<string>;
  onChange: (next: Set<string>) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const active = selected.size > 0;
  const shown = options.filter((o) => o.label.toLowerCase().includes(query.trim().toLowerCase()));

  return (
    <Popover
      open={open}
      onOpenChange={(_, d) => {
        setOpen(d.open);
        if (!d.open) setQuery('');
      }}
      positioning="below-start"
    >
      <PopoverTrigger disableButtonEnhancement>
        <Button
          appearance="subtle"
          size="small"
          icon={<FilterRegular />}
          style={active ? { color: tokens.colorBrandForeground1 } : undefined}
          aria-label={`Filter by ${label}`}
        />
      </PopoverTrigger>
      <PopoverSurface style={{ display: 'grid', gap: '8px', width: '240px' }}>
        <Input
          size="small"
          placeholder={`Search ${label.toLowerCase()}…`}
          value={query}
          onChange={(_, d) => setQuery(d.value)}
        />
        <div style={{ maxHeight: '240px', overflowY: 'auto', display: 'grid', gap: '2px' }}>
          {shown.length === 0 ? (
            <Text size={200} style={{ color: tokens.colorNeutralForeground3 }}>
              No matches.
            </Text>
          ) : (
            shown.map((o) => (
              <Checkbox
                key={o.value}
                label={o.label}
                checked={selected.has(o.value)}
                onChange={(_, d) => {
                  const next = new Set(selected);
                  if (d.checked) next.add(o.value);
                  else next.delete(o.value);
                  onChange(next);
                }}
              />
            ))
          )}
        </div>
        {active && <Link onClick={() => onChange(new Set())}>Clear filter</Link>}
      </PopoverSurface>
    </Popover>
  );
}

export function Files() {
  const s = useRecordStyles();
  const { activeTenantId: tid } = useAuth();
  const [downloadError, setDownloadError] = useState<string | null>(null);
  const [siteFilter, setSiteFilter] = useState<Set<string>>(new Set());
  const [categoryFilter, setCategoryFilter] = useState<Set<string>>(new Set());
  const [searchInput, setSearchInput] = useState('');
  const search = useDebounced(searchInput);

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
    queryKey: ['files', tid, search],
    enabled: !!tid,
    queryFn: () => api<FileRow[]>(`/t/${tid}/files${search ? `?q=${encodeURIComponent(search)}` : ''}`),
  });

  if (!tid) return <NoTenant />;

  const siteLabel = (id: string | null) => {
    if (!id) return '—';
    const site = sites.data?.find((x) => x.id === id);
    if (!site) return '—';
    return site.name ? `${site.sitecode} — ${site.name}` : site.sitecode;
  };

  const siteOptions = useMemo(() => {
    const ids = new Set((files.data ?? []).map((f) => f.siteId ?? ''));
    return Array.from(ids)
      .map((id) => ({ value: id, label: id ? siteLabel(id) : '(no site)' }))
      .sort((a, b) => a.label.localeCompare(b.label));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [files.data, sites.data]);

  const categoryOptions = useMemo(() => {
    const cats = new Set((files.data ?? []).map((f) => f.category));
    return Array.from(cats)
      .map((c) => ({ value: c, label: CATEGORY_LABEL[c] ?? c }))
      .sort((a, b) => a.label.localeCompare(b.label));
  }, [files.data]);

  const filteredFiles = (files.data ?? []).filter((f) => {
    if (siteFilter.size > 0 && !siteFilter.has(f.siteId ?? '')) return false;
    if (categoryFilter.size > 0 && !categoryFilter.has(f.category)) return false;
    return true;
  });

  const totalCount = files.data?.length ?? 0;
  const hasFilter = siteFilter.size > 0 || categoryFilter.size > 0;

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
            Files{' '}
            <span className={s.muted}>
              ({filteredFiles.length}
              {hasFilter ? ` of ${totalCount}` : ''})
            </span>
          </Text>
          {hasFilter && (
            <Link
              onClick={() => {
                setSiteFilter(new Set());
                setCategoryFilter(new Set());
              }}
            >
              Clear filters
            </Link>
          )}
        </div>

        <SearchBox
          size="small"
          placeholder="Search by filename…"
          value={searchInput}
          onChange={(_, d) => setSearchInput(d.value)}
          style={{ maxWidth: 320 }}
        />

        {downloadError && <LoadError message={downloadError} />}

        {files.isLoading ? (
          <Spinner label="Loading files…" />
        ) : files.isError ? (
          <LoadError message={(files.error as Error).message} />
        ) : totalCount === 0 ? (
          <Text size={200} className={s.muted}>
            No files yet.
          </Text>
        ) : (
          <DataTable size="small" minWidth={1000}>
            <TableHeader>
              <TableRow>
                <TableHeaderCell>Filename</TableHeaderCell>
                <TableHeaderCell>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
                    Site
                    <ColumnFilter label="site" options={siteOptions} selected={siteFilter} onChange={setSiteFilter} />
                  </div>
                </TableHeaderCell>
                <TableHeaderCell>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
                    Category
                    <ColumnFilter
                      label="category"
                      options={categoryOptions}
                      selected={categoryFilter}
                      onChange={setCategoryFilter}
                    />
                  </div>
                </TableHeaderCell>
                <TableHeaderCell>Size</TableHeaderCell>
                <TableHeaderCell>Created</TableHeaderCell>
                <TableHeaderCell />
              </TableRow>
            </TableHeader>
            <TableBody>
              {filteredFiles.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={6}>
                    <Text size={200} className={s.muted}>
                      No files match the current filter.
                    </Text>
                  </TableCell>
                </TableRow>
              ) : (
                filteredFiles.map((f) => (
                  <TableRow key={f.id}>
                    <TableCell>{f.filename}</TableCell>
                    <TableCell>{siteLabel(f.siteId)}</TableCell>
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
                ))
              )}
            </TableBody>
          </DataTable>
        )}
      </Card>
    </Page>
  );
}
