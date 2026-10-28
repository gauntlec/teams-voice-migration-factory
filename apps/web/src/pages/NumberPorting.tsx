import { useRef, useState } from 'react';
import { Link, useParams } from 'react-router';
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
  MessageBar,
  MessageBarBody,
  Spinner,
  TableBody,
  TableCell,
  TableHeader,
  TableHeaderCell,
  TableRow,
  Text,
  Textarea,

  makeStyles,
  shorthands,
} from '@fluentui/react-components';
import { AddRegular, ArrowLeftRegular, ArrowRightRegular, ArrowUploadRegular, ArrowUndoRegular, CheckmarkCircleRegular, DeleteRegular } from '@fluentui/react-icons';
import { PORT_STAGE_LABELS, portDue, portStage, portStageText, type Paginated } from '@tvmf/shared';
import { api, apiDownload, apiUpload, ApiError } from '../api';
import { useAuth } from '../auth';
import { DataTable } from '../components/DataTable';
import { Page } from '../components/Page';
import { LoadError, NoTenant, useRecordStyles } from '../components/records';
import { TableSkeleton } from '../components/states';

const useLocalStyles = makeStyles({
  colored: { color: "var(--colorPaletteRedForeground1)" },
  gridGap8: { display: "grid", ...shorthands.gap('8px') },
  flexItemsCenterGap8: { display: "flex", ...shorthands.gap('8px'), alignItems: "center" },
  flex1: { flex: 1 },
  gridGap6: { display: "grid", ...shorthands.gap('6px') },
  flexWrapItemsCenterGap8: { display: "flex", ...shorthands.gap('8px'), alignItems: "center", flexWrap: "wrap" },
});


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
  /** carrier side of a port-in (migration 0077) */
  new_carrier: string | null;
  previous_carrier: string | null;
  port_order_ref: string | null;
  port_submitted_to_carrier_at: string | null;
  port_foc_date: string | null;
  port_completed_at: string | null;
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
        <Link to={`/data-collection/sites/${siteId}?tab=ranges`}>
          <Button appearance="subtle" icon={<ArrowLeftRegular />}>
            Back to number ranges
          </Button>
        </Link>
      }
    >
      {canAdmin && <DocumentCatalogCard base={base} />}
      {canAdmin && <SiteEnablementCard base={base} tid={tid} siteId={siteId} />}

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
  const ls = useLocalStyles();
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

  return (
    <Card className={s.card}>
      <div className={s.cardHead}>
        <div>
          <Text weight="semibold">Document catalog</Text>
          <Text size={200} className={s.muted} block>
            Every document type Voxshift has ever needed, across every country. Switch on the ones this site
            needs under Active for this site, below.
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
        <TableSkeleton rows={4} cols={2} />
      ) : (
        <DataTable size="small" minWidth={480}>
          <TableHeader>
            <TableRow>
              <TableHeaderCell>Key</TableHeaderCell>
              <TableHeaderCell>Label</TableHeaderCell>
            </TableRow>
          </TableHeader>
          <TableBody>
            {(list.data ?? []).map((row) => (
              <TableRow key={row.id}>
                <TableCell>{row.key}</TableCell>
                <TableCell>{row.label}</TableCell>
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
                {error && <Text className={ls.colored}>{error}</Text>}
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

function SiteEnablementCard({ base, tid, siteId }: { base: string; tid: string; siteId: string }) {
  const s = useRecordStyles();
  const qc = useQueryClient();
  // Same key as NumberPorting's own siteDocTypes query, so a toggle here also
  // refreshes the per-range checklists below (they read the same cache entry).
  const queryKey = ['port-site-doctypes', tid, siteId];

  const list = useQuery({
    queryKey,
    queryFn: () => api<SiteDocumentType[]>(`${base}/sites/${siteId}/document-types`),
  });

  const toggle = useMutation({
    mutationFn: (row: SiteDocumentType) =>
      api(`${base}/sites/${siteId}/document-types`, {
        method: 'PATCH',
        body: JSON.stringify({ document_type_id: row.id, enabled: !row.enabled }),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey }),
  });

  return (
    <Card className={s.card}>
      <div>
        <Text weight="semibold">Active for this site</Text>
        <Text size={200} className={s.muted} block>
          Only these show up when building a port request's checklist below.
        </Text>
      </div>
      {list.isLoading ? (
        <TableSkeleton rows={4} cols={5} />
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
  const ls = useLocalStyles();
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

      {range.kind === 'port' && <CarrierPortSection base={base} range={range} canReview={canReview} documentsComplete={request?.status === 'complete'} />}

      {data.isLoading ? (
        <Spinner size="tiny" />
      ) : (
        <>
          {canReview && request?.status !== 'complete' && (
            <div className={ls.gridGap8}>
              <Text size={200} className={s.muted}>
                Checklist — pick the documents this port needs (only types active for this site shown).
              </Text>
              {enabledTypesLoading ? (
                <Spinner size="tiny" />
              ) : enabledTypes.length === 0 ? (
                <Text size={200} className={s.muted}>
                  No document types are active for this site yet — switch some on above.
                </Text>
              ) : (
                enabledTypes.map((t) => {
                  const existing = itemByType.get(t.id);
                  return (
                    <div key={t.id} className={ls.flexItemsCenterGap8}>
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
                        className={ls.flex1}
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
            <div className={ls.gridGap6}>
              {items.length === 0 ? (
                <Text size={200} className={s.muted}>
                  No documents were requested for this port.
                </Text>
              ) : (
                items.map((item) => (
                  <div
                    key={item.id}
                    className={ls.flexWrapItemsCenterGap8}
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
                      <Text size={200} className={ls.colored}>
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


/* --------------------- carrier side of a port-in range --------------------- */

const useCarrierStyles = makeStyles({
  box: { display: 'grid', rowGap: '14px', padding: '14px 16px', borderRadius: '8px', backgroundColor: 'var(--colorNeutralBackground2)' },
  route: { display: 'flex', alignItems: 'center', columnGap: '10px', flexWrap: 'wrap' },
  fields: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', columnGap: '16px', rowGap: '12px' },
  actions: { display: 'flex', alignItems: 'center', columnGap: '8px', rowGap: '8px', flexWrap: 'wrap' },
  steps: { display: 'flex', columnGap: '6px', rowGap: '6px', flexWrap: 'wrap' },
});

/**
 * Where a port-in range is moving to and where the port has got to at the carrier. The range is with `carrier` now and moving to
 * `new_carrier`: once the documents are in, the port goes to the new carrier (order reference), gets a scheduled date, and when it
 * completes "Port completed" switches the range's carrier to the new one.
 */
function CarrierPortSection({ base, range, canReview, documentsComplete }: { base: string; range: NumberRangeRow; canReview: boolean; documentsComplete: boolean }) {
  const cs = useCarrierStyles();
  const s = useRecordStyles();
  const qc = useQueryClient();
  const today = new Date().toISOString().slice(0, 10);
  const ported = !!range.port_completed_at;
  const stage = portStage(range)!;
  const due = portDue(range, today);

  const [newCarrier, setNewCarrier] = useState(range.new_carrier ?? '');
  const [orderRef, setOrderRef] = useState(range.port_order_ref ?? '');
  const [foc, setFoc] = useState(range.port_foc_date?.slice(0, 10) ?? '');
  const [completing, setCompleting] = useState(false);
  const [completedOn, setCompletedOn] = useState(today);
  const [error, setError] = useState<string | null>(null);
  // follow the saved values when the range reloads
  const saved = `${range.new_carrier}|${range.port_order_ref}|${range.port_foc_date}`;
  const [seen, setSeen] = useState(saved);
  if (seen !== saved) {
    setSeen(saved);
    setNewCarrier(range.new_carrier ?? '');
    setOrderRef(range.port_order_ref ?? '');
    setFoc(range.port_foc_date?.slice(0, 10) ?? '');
  }
  const dirty = newCarrier !== (range.new_carrier ?? '') || orderRef !== (range.port_order_ref ?? '') || foc !== (range.port_foc_date?.slice(0, 10) ?? '');

  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['port-ranges'] });
    void qc.invalidateQueries({ queryKey: ['ranges'] });
  };
  const onError = (e: unknown) => setError(e instanceof ApiError ? e.message : 'That did not save');
  const call = (path: string, method: string, body?: unknown) => api(`${base}/number-ranges/${range.id}/${path}`, { method, ...(body ? { body: JSON.stringify(body) } : {}) });

  const save = useMutation({
    mutationFn: () => call('port', 'PATCH', { newCarrier, portOrderRef: orderRef, focDate: foc }),
    onSuccess: () => {
      setError(null);
      refresh();
    },
    onError,
  });
  const submitted = useMutation({
    mutationFn: (on: boolean) => call('port', 'PATCH', { submittedToCarrier: on, ...(dirty ? { newCarrier, portOrderRef: orderRef, focDate: foc } : {}) }),
    onSuccess: () => {
      setError(null);
      refresh();
    },
    onError,
  });
  const complete = useMutation({
    mutationFn: () => call('port/complete', 'POST', { completedOn }),
    onSuccess: () => {
      setCompleting(false);
      setError(null);
      refresh();
    },
    onError,
  });
  const reopen = useMutation({
    mutationFn: () => call('port/reopen', 'POST'),
    onSuccess: () => {
      setError(null);
      refresh();
    },
    onError,
  });

  const stepOrder = ['awaiting_documents', 'documents_complete', 'with_carrier', 'scheduled', 'ported'] as const;
  const dateText = (v: string | null) => (v ? new Date(`${v.slice(0, 10)}T00:00:00Z`).toLocaleDateString(undefined, { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' }) : '');

  return (
    <div className={cs.box}>
      <div className={cs.route}>
        <Text weight="semibold">Carrier</Text>
        <Text>{ported ? (range.previous_carrier ?? 'Previous carrier') : (range.carrier ?? 'Not set')}</Text>
        <ArrowRightRegular aria-hidden />
        <Text weight="semibold">{(ported ? range.carrier : range.new_carrier) ?? 'New carrier not set'}</Text>
        <Badge appearance="tint" color={ported ? 'success' : due ? 'warning' : 'informative'}>
          {portStageText(range)}
        </Badge>
      </div>

      {!ported && (
        <div className={cs.steps} aria-label="Port progress">
          {stepOrder.map((st) => {
            const reached = stepOrder.indexOf(stage as (typeof stepOrder)[number]) >= stepOrder.indexOf(st) || (st === 'documents_complete' && documentsComplete);
            return (
              <Badge key={st} appearance={st === stage ? 'filled' : reached ? 'tint' : 'outline'} color={reached ? 'brand' : 'informative'} size="small">
                {PORT_STAGE_LABELS[st]}
              </Badge>
            );
          })}
        </div>
      )}

      {due && (
        <MessageBar intent="warning">
          <MessageBarBody>The scheduled port date ({dateText(range.port_foc_date)}) has arrived. When the carrier confirms the port, choose Port completed.</MessageBarBody>
        </MessageBar>
      )}

      {ported ? (
        <div className={cs.actions}>
          <Text size={200} className={s.muted}>
            Completed {dateText(range.port_completed_at)}. {range.previous_carrier ? `Was with ${range.previous_carrier}.` : ''}
          </Text>
          {canReview && (
            <Button size="small" appearance="subtle" icon={<ArrowUndoRegular />} disabled={reopen.isPending} onClick={() => reopen.mutate()}>
              Reopen
            </Button>
          )}
        </div>
      ) : canReview ? (
        <>
          <div className={cs.fields}>
            <Field label="New carrier" required hint="The carrier the numbers are moving to.">
              <Input value={newCarrier} onChange={(_, d) => setNewCarrier(d.value)} maxLength={160} />
            </Field>
            <Field label="Port order reference" hint="The new carrier's order or ticket number.">
              <Input value={orderRef} onChange={(_, d) => setOrderRef(d.value)} maxLength={120} />
            </Field>
            <Field label="Scheduled port date" hint="The date the carrier committed to (FOC).">
              <Input type="date" value={foc} onChange={(_, d) => setFoc(d.value)} />
            </Field>
          </div>
          <div className={cs.actions}>
            <Button size="medium" appearance="secondary" disabled={!dirty || save.isPending} onClick={() => save.mutate()}>
              {save.isPending ? <Spinner size="tiny" /> : 'Save details'}
            </Button>
            {range.port_submitted_to_carrier_at ? (
              <Button size="medium" appearance="subtle" disabled={submitted.isPending} onClick={() => submitted.mutate(false)}>
                Not submitted after all
              </Button>
            ) : (
              <Button size="medium" appearance="secondary" disabled={submitted.isPending || !newCarrier.trim()} onClick={() => submitted.mutate(true)}>
                Mark submitted to the new carrier
              </Button>
            )}
            <Button size="medium" appearance="primary" icon={<CheckmarkCircleRegular />} disabled={!range.new_carrier || dirty} onClick={() => { setCompletedOn(foc && foc <= today ? foc : today); setCompleting(true); }}>
              Port completed…
            </Button>
          </div>
          {!documentsComplete && (
            <Text size={200} className={s.muted}>
              The documents are not all in yet. You can still record the carrier details.
            </Text>
          )}
        </>
      ) : (
        <Text size={200} className={s.muted}>
          {range.port_order_ref ? `Order ${range.port_order_ref}. ` : ''}
          {range.port_foc_date ? `Scheduled for ${dateText(range.port_foc_date)}.` : ''}
        </Text>
      )}

      {error && <Text className={s.muted} style={{ color: 'var(--colorPaletteRedForeground1)' }}>{error}</Text>}

      {completing && (
        <Dialog open onOpenChange={(_, d) => !d.open && setCompleting(false)}>
          <DialogSurface>
            <DialogBody>
              <DialogTitle>Port completed</DialogTitle>
              <DialogContent>
                <div style={{ display: 'grid', rowGap: 16 }}>
                  <Text>
                    The carrier for {range.range_start} – {range.range_end} changes from <b>{range.carrier ?? 'not set'}</b> to <b>{range.new_carrier}</b>. The site contacts are emailed that the numbers have moved.
                  </Text>
                  <Field label="Date the port completed" hint="Today or an earlier date.">
                    <Input type="date" size="large" value={completedOn} max={today} onChange={(_, d) => setCompletedOn(d.value)} />
                  </Field>
                  {error && <Text style={{ color: 'var(--colorPaletteRedForeground1)' }}>{error}</Text>}
                </div>
              </DialogContent>
              <DialogActions>
                <Button appearance="secondary" onClick={() => setCompleting(false)}>
                  Cancel
                </Button>
                <Button appearance="primary" disabled={!completedOn || complete.isPending} onClick={() => complete.mutate()}>
                  {complete.isPending ? <Spinner size="tiny" /> : 'Switch to the new carrier'}
                </Button>
              </DialogActions>
            </DialogBody>
          </DialogSurface>
        </Dialog>
      )}
    </div>
  );
}
