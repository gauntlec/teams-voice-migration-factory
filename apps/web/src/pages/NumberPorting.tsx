import { useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Badge,
  Button,
  Card,
  Checkbox,
  Dialog,
  DialogActions,
  DialogBody,
  DialogContent,
  DialogSurface,
  DialogTitle,
  DialogTrigger,
  Field,
  Input,
  Spinner,
  Switch,
  TableBody,
  TableCell,
  TableHeader,
  TableHeaderCell,
  TableRow,
  Text,
  Textarea,
} from '@fluentui/react-components';
import { AddRegular, ArrowLeftRegular, ArrowUploadRegular, DeleteRegular } from '@fluentui/react-icons';
import type { Paginated } from '@tvmf/shared';
import { api, apiDownload, apiUpload, ApiError } from '../api';
import { useAuth } from '../auth';
import { DataTable } from '../components/DataTable';
import { Page } from '../components/Page';
import { LoadError, NoTenant, useRecordStyles } from '../components/records';

/**
 * "LOA Data Collection and Tracking" - one page per site, gated internally by
 * permission rather than split into separate routes (per the feature-request
 * clarification that PM/Engineer roles are interchangeable and site rules
 * differ by country): catalog + site-enablement admin, PM/Engineer checklist
 * builder, and the customer-facing upload view all live here.
 */

interface DocumentType {
  id: string;
  key: string;
  label: string;
  ordinal: number;
  active: boolean;
}

interface SiteDocumentType {
  id: string;
  key: string;
  label: string;
  ordinal: number;
  enabled: boolean;
}

interface NumberRangeRow {
  id: string;
  range_start: string;
  range_end: string;
  kind: 'new' | 'port' | 'retain';
  carrier: string | null;
  port_status: string | null;
}

type ItemStatus = 'pending' | 'uploaded' | 'rejected' | 'waived';

interface PortItem {
  id: string;
  document_type_id: string;
  note: string | null;
  status: ItemStatus;
  reject_reason: string | null;
  file_id: string | null;
  document_key: string;
  document_label: string;
}

interface PortRequest {
  id: string;
  range_id: string;
  status: 'draft' | 'awaiting_documents' | 'complete';
  submitted_by: string | null;
  submitted_at: string | null;
}

const REQUEST_STATUS_COLOR = {
  draft: 'informative',
  awaiting_documents: 'warning',
  complete: 'success',
} as const;

const ITEM_STATUS_COLOR: Record<ItemStatus, 'informative' | 'warning' | 'success' | 'danger'> = {
  pending: 'informative',
  uploaded: 'success',
  rejected: 'danger',
  waived: 'informative',
};

const ITEM_STATUS_LABEL: Record<ItemStatus, string> = {
  pending: 'Needed',
  uploaded: 'Uploaded',
  rejected: 'Rejected',
  waived: 'Waived',
};

export function NumberPorting() {
  const s = useRecordStyles();
  const { siteId = '' } = useParams();
  const { activeTenantId, can } = useAuth();
  const tid = activeTenantId;
  const base = `/t/${tid}/discovery`;

  const canAdmin = can('discovery:sites:manage');
  const canReview = can('discovery:review');
  const canUpload = can('discovery:write');

  const site = useQuery({
    queryKey: ['site-summary-brief', tid, siteId],
    enabled: !!tid && !!siteId,
    queryFn: () => api<{ site: { id: string; sitecode: string; name: string | null } }>(`${base}/sites/${siteId}`),
  });

  const ranges = useQuery({
    queryKey: ['port-ranges', tid, siteId],
    enabled: !!tid && !!siteId,
    queryFn: () => api<Paginated<NumberRangeRow>>(`${base}/number-ranges?siteId=${siteId}&limit=200`),
  });

  const siteDocTypes = useQuery({
    queryKey: ['port-site-doctypes', tid, siteId],
    enabled: !!tid && !!siteId && (canAdmin || canReview),
    queryFn: () => api<SiteDocumentType[]>(`${base}/sites/${siteId}/document-types`),
  });

  if (!tid) return <NoTenant />;
  if (site.isLoading || ranges.isLoading) return <Spinner label="Loading…" />;
  if (site.isError) return <LoadError message={(site.error as Error).message} />;
  if (ranges.isError) return <LoadError message={(ranges.error as Error).message} />;

  const siteInfo = site.data!.site;
  const portableRanges = (ranges.data?.items ?? []).filter((r) => r.kind !== 'retain');
  const enabledTypes = (siteDocTypes.data ?? []).filter((t) => t.enabled);

  return (
    <Page
      title="Number porting"
      subtitle={[siteInfo.sitecode, siteInfo.name].filter(Boolean).join(' · ')}
      actions={
        <Link to={`/data-collection/sites/${siteId}`}>
          <Button appearance="subtle" icon={<ArrowLeftRegular />}>
            Back to site
          </Button>
        </Link>
      }
    >
      {canAdmin && <DocumentCatalogCard base={base} />}
      {canAdmin && <SiteEnablementCard base={base} siteId={siteId} />}

      {portableRanges.length === 0 ? (
        <Card className={s.card}>
          <Text size={200} className={s.muted}>
            No new or port-in number ranges on this site yet — add one under Number ranges.
          </Text>
        </Card>
      ) : (
        portableRanges.map((r) => (
          <RangeChecklistCard
            key={r.id}
            base={base}
            filesBase={`/t/${tid}/files`}
            range={r}
            canReview={canReview}
            canUpload={canUpload}
            enabledTypes={enabledTypes}
            enabledTypesLoading={siteDocTypes.isLoading}
          />
        ))
      )}
    </Page>
  );
}

/* ----------------------------- admin: catalog ---------------------------- */

function DocumentCatalogCard({ base }: { base: string }) {
  const s = useRecordStyles();
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [key, setKey] = useState('');
  const [label, setLabel] = useState('');
  const [error, setError] = useState<string | null>(null);

  const list = useQuery({
    queryKey: ['port-doctypes', base],
    queryFn: () => api<DocumentType[]>(`${base}/document-types`),
  });

  const create = useMutation({
    mutationFn: () => api(`${base}/document-types`, { method: 'POST', body: JSON.stringify({ key, label }) }),
    onSuccess: () => {
      setOpen(false);
      setKey('');
      setLabel('');
      qc.invalidateQueries({ queryKey: ['port-doctypes', base] });
    },
    onError: (e) => setError(e instanceof ApiError ? e.message : 'Save failed'),
  });

  const toggleActive = useMutation({
    mutationFn: (row: DocumentType) =>
      api(`${base}/document-types/${row.id}`, { method: 'PATCH', body: JSON.stringify({ active: !row.active }) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['port-doctypes', base] }),
  });

  return (
    <Card className={s.card}>
      <div className={s.cardHead}>
        <div>
          <Text weight="semibold">Document catalog</Text>
          <Text size={200} className={s.muted} block>
            Every document type Voxshift has ever needed, across every country. Enable the ones a site actually
            requires below.
          </Text>
        </div>
        <Button
          size="small"
          icon={<AddRegular />}
          onClick={() => {
            setKey('');
            setLabel('');
            setError(null);
            setOpen(true);
          }}
        >
          Add type
        </Button>
      </div>

      {list.isLoading ? (
        <Spinner size="tiny" />
      ) : (
        <DataTable size="small" minWidth={480}>
          <TableHeader>
            <TableRow>
              <TableHeaderCell>Key</TableHeaderCell>
              <TableHeaderCell>Label</TableHeaderCell>
              <TableHeaderCell>Active</TableHeaderCell>
            </TableRow>
          </TableHeader>
          <TableBody>
            {(list.data ?? []).map((row) => (
              <TableRow key={row.id}>
                <TableCell>{row.key}</TableCell>
                <TableCell>{row.label}</TableCell>
                <TableCell>
                  <Switch
                    checked={row.active}
                    disabled={toggleActive.isPending}
                    onChange={() => toggleActive.mutate(row)}
                  />
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </DataTable>
      )}

      <Dialog open={open} onOpenChange={(_, d) => setOpen(d.open)}>
        <DialogSurface>
          <DialogBody>
            <DialogTitle>Add document type</DialogTitle>
            <DialogContent>
              <div className={s.dialogForm}>
                <Field label="Key" hint="lowercase letters, digits, underscores — e.g. company_reg_doc">
                  <Input value={key} onChange={(_, d) => setKey(d.value)} />
                </Field>
                <Field label="Label">
                  <Input value={label} onChange={(_, d) => setLabel(d.value)} />
                </Field>
                {error && <Text style={{ color: 'var(--colorPaletteRedForeground1)' }}>{error}</Text>}
              </div>
            </DialogContent>
            <DialogActions>
              <DialogTrigger disableButtonEnhancement>
                <Button appearance="secondary">Cancel</Button>
              </DialogTrigger>
              <Button
                appearance="primary"
                disabled={!key.trim() || !label.trim() || create.isPending}
                onClick={() => create.mutate()}
              >
                {create.isPending ? <Spinner size="tiny" /> : 'Add'}
              </Button>
            </DialogActions>
          </DialogBody>
        </DialogSurface>
      </Dialog>
    </Card>
  );
}

/* ------------------------- admin: site enablement ------------------------ */

function SiteEnablementCard({ base, siteId }: { base: string; siteId: string }) {
  const s = useRecordStyles();
  const qc = useQueryClient();

  const list = useQuery({
    queryKey: ['port-site-doctypes', base, siteId],
    queryFn: () => api<SiteDocumentType[]>(`${base}/sites/${siteId}/document-types`),
  });

  const toggle = useMutation({
    mutationFn: (row: SiteDocumentType) =>
      api(`${base}/sites/${siteId}/document-types`, {
        method: 'PATCH',
        body: JSON.stringify({ document_type_id: row.id, enabled: !row.enabled }),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['port-site-doctypes', base, siteId] }),
  });

  return (
    <Card className={s.card}>
      <div>
        <Text weight="semibold">Enabled for this site</Text>
        <Text size={200} className={s.muted} block>
          Only these show up when building a port request's checklist below.
        </Text>
      </div>
      {list.isLoading ? (
        <Spinner size="tiny" />
      ) : (
        <div className={s.chips}>
          {(list.data ?? []).map((row) => (
            <Checkbox
              key={row.id}
              label={row.label}
              checked={row.enabled}
              disabled={toggle.isPending}
              onChange={() => toggle.mutate(row)}
            />
          ))}
        </div>
      )}
    </Card>
  );
}

/* ------------------------------ per-range card ---------------------------- */

function RangeChecklistCard({
  base,
  filesBase,
  range,
  canReview,
  canUpload,
  enabledTypes,
  enabledTypesLoading,
}: {
  base: string;
  filesBase: string;
  range: NumberRangeRow;
  canReview: boolean;
  canUpload: boolean;
  enabledTypes: SiteDocumentType[];
  enabledTypesLoading: boolean;
}) {
  const s = useRecordStyles();
  const qc = useQueryClient();
  const [checked, setChecked] = useState<Set<string> | null>(null);
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [rejecting, setRejecting] = useState<PortItem | null>(null);
  const [rejectReason, setRejectReason] = useState('');
  const fileInputs = useRef<Record<string, HTMLInputElement | null>>({});
  const [uploadError, setUploadError] = useState<string | null>(null);

  const key = ['port-request', base, range.id];
  const data = useQuery({
    queryKey: key,
    queryFn: () => api<{ request: PortRequest; items: PortItem[] }>(`${base}/number-ranges/${range.id}/port-request`),
  });

  const invalidate = () => qc.invalidateQueries({ queryKey: key });

  const request = data.data?.request;
  const items = data.data?.items ?? [];
  const itemByType = new Map(items.map((i) => [i.document_type_id, i]));

  const checkedSet = checked ?? new Set(items.map((i) => i.document_type_id));
  const notesState = { ...Object.fromEntries(items.map((i) => [i.document_type_id, i.note ?? ''])), ...notes };

  const saveChecklist = useMutation({
    mutationFn: () =>
      api(`${base}/port-requests/${request!.id}/items`, {
        method: 'PATCH',
        body: JSON.stringify({
          items: [...checkedSet].map((document_type_id) => ({
            document_type_id,
            note: notesState[document_type_id] || undefined,
          })),
        }),
      }),
    onSuccess: () => {
      setChecked(null);
      setNotes({});
      invalidate();
    },
  });

  const submit = useMutation({
    mutationFn: () => api(`${base}/port-requests/${request!.id}/submit`, { method: 'POST' }),
    onSuccess: invalidate,
  });

  const reject = useMutation({
    mutationFn: () =>
      api(`${base}/port-requests/${request!.id}/items/${rejecting!.id}/reject`, {
        method: 'POST',
        body: JSON.stringify({ reason: rejectReason }),
      }),
    onSuccess: () => {
      setRejecting(null);
      setRejectReason('');
      invalidate();
    },
  });

  const waive = useMutation({
    mutationFn: (item: PortItem) =>
      api(`${base}/port-requests/${request!.id}/items/${item.id}/waive`, {
        method: 'PATCH',
        body: JSON.stringify({ waived: item.status !== 'waived' }),
      }),
    onSuccess: invalidate,
  });

  const upload = useMutation({
    mutationFn: ({ item, file }: { item: PortItem; file: File }) =>
      apiUpload(`${base}/port-requests/${request!.id}/items/${item.id}/upload`, file),
    onSuccess: invalidate,
    onError: (e) => setUploadError(e instanceof ApiError ? e.message : 'Upload failed'),
  });

  const label = `${range.range_start} – ${range.range_end}`;

  return (
    <Card className={s.card}>
      <div className={s.cardHead}>
        <div>
          <Text weight="semibold">
            {label} <Text className={s.muted}>({range.kind})</Text>
          </Text>
          {request && (
            <Badge appearance="tint" color={REQUEST_STATUS_COLOR[request.status]}>
              {request.status.replace(/_/g, ' ')}
            </Badge>
          )}
        </div>
        {canReview && request?.status === 'draft' && (
          <Button
            size="small"
            appearance="primary"
            disabled={items.length === 0 || submit.isPending}
            onClick={() => submit.mutate()}
          >
            {submit.isPending ? <Spinner size="tiny" /> : 'Submit to customer'}
          </Button>
        )}
      </div>

      {data.isLoading ? (
        <Spinner size="tiny" />
      ) : (
        <>
          {canReview && request?.status !== 'complete' && (
            <div style={{ display: 'grid', gap: 8 }}>
              <Text size={200} className={s.muted}>
                Checklist — pick the documents this port needs (only site-enabled types shown).
              </Text>
              {enabledTypesLoading ? (
                <Spinner size="tiny" />
              ) : enabledTypes.length === 0 ? (
                <Text size={200} className={s.muted}>
                  No document types are enabled for this site yet — enable some above.
                </Text>
              ) : (
                enabledTypes.map((t) => {
                  const existing = itemByType.get(t.id);
                  return (
                    <div key={t.id} style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                      <Checkbox
                        label={t.label}
                        checked={checkedSet.has(t.id)}
                        onChange={(_, d) => {
                          const next = new Set(checkedSet);
                          if (d.checked) next.add(t.id);
                          else next.delete(t.id);
                          setChecked(next);
                        }}
                      />
                      <Input
                        placeholder="Note (optional)"
                        size="small"
                        style={{ flex: 1 }}
                        value={notesState[t.id] ?? ''}
                        disabled={!checkedSet.has(t.id)}
                        onChange={(_, d) => setNotes((v) => ({ ...v, [t.id]: d.value }))}
                      />
                      {existing && (
                        <Badge appearance="tint" color={ITEM_STATUS_COLOR[existing.status]} size="small">
                          {ITEM_STATUS_LABEL[existing.status]}
                        </Badge>
                      )}
                    </div>
                  );
                })
              )}
              <div>
                <Button
                  size="small"
                  disabled={saveChecklist.isPending || enabledTypes.length === 0}
                  onClick={() => saveChecklist.mutate()}
                >
                  {saveChecklist.isPending ? <Spinner size="tiny" /> : 'Save checklist'}
                </Button>
              </div>
            </div>
          )}

          {request && request.status !== 'draft' && (
            <div style={{ display: 'grid', gap: 6 }}>
              {items.length === 0 ? (
                <Text size={200} className={s.muted}>
                  No documents were requested for this port.
                </Text>
              ) : (
                items.map((item) => (
                  <div
                    key={item.id}
                    style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}
                  >
                    <Badge appearance="tint" color={ITEM_STATUS_COLOR[item.status]}>
                      {ITEM_STATUS_LABEL[item.status]}
                    </Badge>
                    <Text weight="semibold">{item.document_label}</Text>
                    {item.note && (
                      <Text size={200} className={s.muted}>
                        {item.note}
                      </Text>
                    )}
                    {item.status === 'rejected' && item.reject_reason && (
                      <Text size={200} style={{ color: 'var(--colorPaletteRedForeground1)' }}>
                        {item.reject_reason}
                      </Text>
                    )}

                    {item.file_id && (
                      <Button
                        size="small"
                        appearance="subtle"
                        onClick={() => void apiDownload(`${filesBase}/${item.file_id}/download`, item.document_label)}
                      >
                        Download
                      </Button>
                    )}

                    {canUpload && (item.status === 'pending' || item.status === 'rejected') && (
                      <>
                        <input
                          ref={(el) => {
                            fileInputs.current[item.id] = el;
                          }}
                          type="file"
                          hidden
                          onChange={(e) => {
                            const file = e.target.files?.[0];
                            if (file) upload.mutate({ item, file });
                            e.target.value = '';
                          }}
                        />
                        <Button
                          size="small"
                          icon={<ArrowUploadRegular />}
                          disabled={upload.isPending}
                          onClick={() => fileInputs.current[item.id]?.click()}
                        >
                          Upload
                        </Button>
                      </>
                    )}

                    {canReview && item.status === 'uploaded' && (
                      <Button
                        size="small"
                        appearance="subtle"
                        icon={<DeleteRegular />}
                        onClick={() => {
                          setRejecting(item);
                          setRejectReason('');
                        }}
                      >
                        Reject
                      </Button>
                    )}

                    {canReview && (item.status === 'pending' || item.status === 'waived') && (
                      <Button size="small" appearance="subtle" onClick={() => waive.mutate(item)}>
                        {item.status === 'waived' ? 'Un-waive' : 'Waive'}
                      </Button>
                    )}
                  </div>
                ))
              )}
              {uploadError && <LoadError message={uploadError} />}
            </div>
          )}
        </>
      )}

      <Dialog open={!!rejecting} onOpenChange={(_, d) => !d.open && setRejecting(null)}>
        <DialogSurface>
          <DialogBody>
            <DialogTitle>Reject "{rejecting?.document_label}"</DialogTitle>
            <DialogContent>
              <Field label="Reason" required>
                <Textarea value={rejectReason} onChange={(_, d) => setRejectReason(d.value)} resize="vertical" />
              </Field>
            </DialogContent>
            <DialogActions>
              <DialogTrigger disableButtonEnhancement>
                <Button appearance="secondary">Cancel</Button>
              </DialogTrigger>
              <Button
                appearance="primary"
                disabled={!rejectReason.trim() || reject.isPending}
                onClick={() => reject.mutate()}
              >
                {reject.isPending ? <Spinner size="tiny" /> : 'Reject'}
              </Button>
            </DialogActions>
          </DialogBody>
        </DialogSurface>
      </Dialog>
    </Card>
  );
}
