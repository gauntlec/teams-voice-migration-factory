import { Fragment, useEffect, useMemo, useState, type ReactNode } from 'react';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Button,
  Card,
  Dialog,
  DialogActions,
  DialogBody,
  DialogContent,
  DialogSurface,
  DialogTitle,
  DialogTrigger,
  Dropdown,
  Field,
  Input,
  MessageBar,
  MessageBarBody,
  Option,
  SearchBox,
  Spinner,
  Switch,
  Table,
  TableBody,
  TableCell,
  TableHeader,
  TableHeaderCell,
  TableRow,
  Text,
  Textarea,
  makeStyles,
  shorthands,
  tokens,
} from '@fluentui/react-components';
import {
  AddRegular,
  ChevronLeftRegular,
  ChevronRightRegular,
  DeleteRegular,
  EditRegular,
} from '@fluentui/react-icons';
import type { Paginated } from '@tvmf/shared';
import { api, ApiError } from '../api';

/* ------------------------------ shared bits ------------------------------ */

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

export const yesNo = (v: unknown) => (v ? 'Yes' : 'No');

export type Row = Record<string, unknown> & { id: string };
export type Choice = { value: string; label: string };

export interface FieldDef {
  key: string;
  label: string;
  type?: 'text' | 'textarea' | 'number' | 'select' | 'boolean' | 'ref';
  options?: readonly string[];
  choices?: Choice[] | ((row: Row | null) => Choice[]);
  required?: boolean;
  placeholder?: string;
  default?: string;
  full?: boolean;
}

export interface ColumnDef {
  key: string;
  label: string;
  render?: (r: Row) => ReactNode;
}

export const useRecordStyles = makeStyles({
  card: { ...shorthands.padding('14px'), display: 'grid', ...shorthands.gap('10px') },
  tableWrap: {
    overflowX: 'auto',
    overflowY: 'hidden',
    ...shorthands.padding('0', '0', '2px', '0'),
  },
  /* nowrap cells keep the table at its natural width; when that exceeds a
     narrow viewport the wrapper scrolls instead of columns overlapping */
  table: { width: '100%' },
  nowrapCell: { whiteSpace: 'nowrap' },
  cellText: {
    display: 'inline-block',
    maxWidth: '280px',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    verticalAlign: 'middle',
  },
  actionsCol: { width: '1%', whiteSpace: 'nowrap' },
  cardHead: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    ...shorthands.gap('8px'),
    flexWrap: 'wrap',
  },
  formGrid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))', ...shorthands.gap('12px') },
  dialogForm: { display: 'grid', ...shorthands.gap('12px'), minWidth: '440px' },
  rowActions: { display: 'flex', ...shorthands.gap('4px'), justifyContent: 'flex-end' },
  muted: { color: tokens.colorNeutralForeground3 },
  chips: { display: 'flex', ...shorthands.gap('6px'), flexWrap: 'wrap' },
  summary: { display: 'flex', ...shorthands.gap('16px'), flexWrap: 'wrap' },
  pager: { display: 'flex', alignItems: 'center', justifyContent: 'flex-end', ...shorthands.gap('8px') },
  toolbar: { display: 'flex', alignItems: 'center', ...shorthands.gap('8px'), flexWrap: 'wrap' },
});

/** Turn a form's string values into a JSON payload using the field types. */
export function buildPayload(fields: FieldDef[], values: Record<string, string>) {
  const payload: Record<string, unknown> = {};
  for (const f of fields) {
    const v = values[f.key] ?? '';
    if (f.type === 'number') payload[f.key] = v === '' ? null : Number(v);
    else if (f.type === 'boolean') payload[f.key] = v === 'true';
    else if (f.type === 'ref') payload[f.key] = v || null;
    else payload[f.key] = v;
  }
  return payload;
}

/* ---------------------------- the add/edit modal ---------------------------- */

export interface GeocodeConfig {
  /** field key holding the street address to look up */
  addressField: string;
  /** field keys the result is written into */
  latField: string;
  lonField: string;
  /** returns coordinates for an address, or null if none found */
  run: (
    address: string,
  ) => Promise<{ latitude: number; longitude: number; label?: string; approximate?: boolean } | null>;
}

export function RecordDialog({
  open,
  onOpenChange,
  title,
  fields,
  editing,
  saving,
  error,
  onSave,
  geocode,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  fields: FieldDef[];
  editing: Row | null;
  saving: boolean;
  error: string | null;
  onSave: (payload: Record<string, unknown>) => void;
  geocode?: GeocodeConfig;
}) {
  const s = useRecordStyles();
  const [values, setValues] = useState<Record<string, string>>({});
  const [geoBusy, setGeoBusy] = useState(false);
  const [geoMsg, setGeoMsg] = useState<string | null>(null);

  const runGeocode = async () => {
    if (!geocode) return;
    const addr = (values[geocode.addressField] ?? '').trim();
    if (!addr) {
      setGeoMsg('Enter the address first.');
      return;
    }
    setGeoBusy(true);
    setGeoMsg(null);
    try {
      const hit = await geocode.run(addr);
      if (!hit) {
        setGeoMsg('No coordinates found for that address — enter them manually.');
      } else {
        setValues((v) => ({
          ...v,
          [geocode.latField]: String(hit.latitude),
          [geocode.lonField]: String(hit.longitude),
        }));
        const where = hit.label ?? `${hit.latitude}, ${hit.longitude}`;
        setGeoMsg(
          hit.approximate
            ? `Approximate (area only): ${where}. Adjust if you have the exact spot.`
            : `Matched ${where}`,
        );
      }
    } catch {
      setGeoMsg('Lookup failed — enter coordinates manually.');
    } finally {
      setGeoBusy(false);
    }
  };

  const initial = useMemo(
    () => (r: Row | null) =>
      Object.fromEntries(
        fields.map((f) => {
          if (!r) return [f.key, f.default ?? (f.type === 'boolean' ? 'false' : '')];
          const v = r[f.key];
          if (f.type === 'boolean')
            return [f.key, v === true ? 'true' : v === false ? 'false' : (f.default ?? 'false')];
          return [f.key, v == null ? '' : String(v)];
        }),
      ),
    [fields],
  );

  useEffect(() => {
    if (open) {
      setValues(initial(editing));
      setGeoMsg(null);
    }
  }, [open, editing, initial]);

  const resolveChoices = (f: FieldDef): Choice[] =>
    typeof f.choices === 'function' ? f.choices(editing) : (f.choices ?? []);

  return (
    <Dialog open={open} onOpenChange={(_, d) => onOpenChange(d.open)}>
      <DialogSurface>
        <DialogBody>
          <DialogTitle>
            {editing ? 'Edit' : 'Add'} {title.replace(/s$/, '').toLowerCase()}
          </DialogTitle>
          <DialogContent>
            <div className={s.dialogForm}>
              {fields.map((f) => (
                <Fragment key={f.key}>
                <Field
                  label={f.label}
                  required={f.required}
                  style={f.full ? { gridColumn: '1 / -1' } : undefined}
                >
                  {f.type === 'boolean' ? (
                    <Switch
                      checked={values[f.key] === 'true'}
                      onChange={(_, d) =>
                        setValues((v) => ({ ...v, [f.key]: d.checked ? 'true' : 'false' }))
                      }
                    />
                  ) : f.type === 'textarea' ? (
                    <Textarea
                      value={values[f.key] ?? ''}
                      resize="vertical"
                      onChange={(_, d) => setValues((v) => ({ ...v, [f.key]: d.value }))}
                    />
                  ) : f.type === 'select' || f.type === 'ref' ? (
                    <Dropdown
                      placeholder="Select…"
                      selectedOptions={values[f.key] ? [values[f.key]!] : []}
                      value={
                        f.type === 'ref'
                          ? (resolveChoices(f).find((c) => c.value === values[f.key])?.label ?? '')
                          : (values[f.key] ?? '')
                      }
                      onOptionSelect={(_, d) => setValues((v) => ({ ...v, [f.key]: d.optionValue ?? '' }))}
                    >
                      {(f.type === 'ref'
                        ? [{ value: '', label: '— none —' }, ...resolveChoices(f)]
                        : (f.options ?? []).map((o) => ({ value: o, label: o }))
                      ).map((o) => (
                        <Option key={o.value || '__none'} value={o.value} text={o.label}>
                          {o.label}
                        </Option>
                      ))}
                    </Dropdown>
                  ) : (
                    <Input
                      type={f.type === 'number' ? 'number' : 'text'}
                      placeholder={f.placeholder}
                      value={values[f.key] ?? ''}
                      onChange={(_, d) => setValues((v) => ({ ...v, [f.key]: d.value }))}
                    />
                  )}
                </Field>
                {geocode && f.key === geocode.addressField && (
                  <div style={{ gridColumn: '1 / -1', display: 'grid', gap: 4 }}>
                    <Button
                      size="small"
                      appearance="secondary"
                      disabled={geoBusy}
                      onClick={() => void runGeocode()}
                    >
                      {geoBusy ? <Spinner size="tiny" /> : 'Get coordinates from address'}
                    </Button>
                    {geoMsg && (
                      <Text size={200} className={s.muted}>
                        {geoMsg}
                      </Text>
                    )}
                  </div>
                )}
                </Fragment>
              ))}
              {error && <Text style={{ color: tokens.colorPaletteRedForeground1 }}>{error}</Text>}
            </div>
          </DialogContent>
          <DialogActions>
            <DialogTrigger disableButtonEnhancement>
              <Button appearance="secondary">Cancel</Button>
            </DialogTrigger>
            <Button
              appearance="primary"
              disabled={saving || fields.some((f) => f.required && !values[f.key])}
              onClick={() => onSave(buildPayload(fields, values))}
            >
              Save
            </Button>
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
}

/* ------------------------ client-side CRUD section ------------------------ */
/** For small, fully-loaded lists (calling policies, sites). Rows are supplied. */
export function CrudSection({
  title,
  hint,
  fields,
  rows,
  columns,
  basePath,
  readOnly,
  onChanged,
  extraRowAction,
  geocode,
}: {
  title: string;
  hint?: string;
  fields: FieldDef[];
  rows: Row[];
  columns: ColumnDef[];
  basePath: string;
  readOnly: boolean;
  onChanged: () => void;
  extraRowAction?: (r: Row) => ReactNode;
  geocode?: GeocodeConfig;
}) {
  const s = useRecordStyles();
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<Row | null>(null);
  const [error, setError] = useState<string | null>(null);

  const save = useMutation({
    mutationFn: (payload: Record<string, unknown>) =>
      editing
        ? api(`${basePath}/${editing.id}`, { method: 'PATCH', body: JSON.stringify(payload) })
        : api(basePath, { method: 'POST', body: JSON.stringify(payload) }),
    onSuccess: () => {
      setOpen(false);
      onChanged();
    },
    onError: (e) => setError(e instanceof ApiError ? e.message : 'Save failed'),
  });
  const remove = useMutation({
    mutationFn: (id: string) => api(`${basePath}/${id}`, { method: 'DELETE' }),
    onSuccess: () => onChanged(),
    onError: (e) => setError(e instanceof ApiError ? e.message : 'Delete failed'),
  });

  return (
    <Card className={s.card}>
      <div className={s.cardHead}>
        <div>
          <Text weight="semibold">
            {title} <span className={s.muted}>({rows.length})</span>
          </Text>
          {hint && (
            <Text size={200} className={s.muted} block>
              {hint}
            </Text>
          )}
        </div>
        {!readOnly && (
          <Button
            size="small"
            icon={<AddRegular />}
            onClick={() => {
              setEditing(null);
              setError(null);
              setOpen(true);
            }}
          >
            Add
          </Button>
        )}
      </div>

      {error && <LoadError message={error} />}

      {rows.length === 0 ? (
        <Text size={200} className={s.muted}>
          Nothing captured yet.
        </Text>
      ) : (
        <RecordTable
          rows={rows}
          columns={columns}
          readOnly={readOnly}
          removing={remove.isPending}
          extraRowAction={extraRowAction}
          onEdit={(r) => {
            setEditing(r);
            setError(null);
            setOpen(true);
          }}
          onDelete={(id) => remove.mutate(id)}
        />
      )}

      <RecordDialog
        open={open}
        onOpenChange={setOpen}
        title={title}
        fields={fields}
        editing={editing}
        saving={save.isPending}
        error={error}
        onSave={(payload) => save.mutate(payload)}
        geocode={geocode}
      />
    </Card>
  );
}

/* --------------------- server-paginated CRUD section --------------------- */
/**
 * For lists that grow with scale (users, numbers, ...). Fetches one page at a
 * time from `endpoint` with `?siteId=&q=&page=&limit=`; create posts to
 * `endpoint` (merging `fixed`), edit/delete hit `endpoint/:id`.
 */
export function PagedSection({
  title,
  hint,
  endpoint,
  queryKey,
  params,
  fixed,
  fields,
  columns,
  readOnly,
  onChanged,
  extraRowAction,
  emptyText = 'Nothing captured yet.',
  pageSize = 50,
}: {
  title: string;
  hint?: string;
  endpoint: string;
  queryKey: unknown[];
  params?: Record<string, string | undefined>;
  fixed?: Record<string, unknown>;
  fields: FieldDef[];
  columns: ColumnDef[];
  readOnly: boolean;
  onChanged?: () => void;
  extraRowAction?: (r: Row) => ReactNode;
  emptyText?: string;
  pageSize?: number;
}) {
  const s = useRecordStyles();
  const qc = useQueryClient();
  const [page, setPage] = useState(1);
  const [qInput, setQInput] = useState('');
  const [q, setQ] = useState('');
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<Row | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const h = setTimeout(() => {
      setQ(qInput.trim());
      setPage(1);
    }, 250);
    return () => clearTimeout(h);
  }, [qInput]);

  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params ?? {})) if (v) qs.set(k, v);
  if (q) qs.set('q', q);
  qs.set('page', String(page));
  qs.set('limit', String(pageSize));

  const list = useQuery({
    queryKey: [...queryKey, params, q, page, pageSize],
    queryFn: () => api<Paginated<Row>>(`${endpoint}?${qs.toString()}`),
    placeholderData: keepPreviousData,
  });

  const invalidate = () => {
    qc.invalidateQueries({ queryKey });
    onChanged?.();
  };
  const save = useMutation({
    mutationFn: (payload: Record<string, unknown>) =>
      editing
        ? api(`${endpoint}/${editing.id}`, { method: 'PATCH', body: JSON.stringify(payload) })
        : api(endpoint, { method: 'POST', body: JSON.stringify({ ...fixed, ...payload }) }),
    onSuccess: () => {
      setOpen(false);
      invalidate();
    },
    onError: (e) => setError(e instanceof ApiError ? e.message : 'Save failed'),
  });
  const remove = useMutation({
    mutationFn: (id: string) => api(`${endpoint}/${id}`, { method: 'DELETE' }),
    onSuccess: invalidate,
    onError: (e) => setError(e instanceof ApiError ? e.message : 'Delete failed'),
  });

  const total = list.data?.total ?? 0;
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const items = (list.data?.items ?? []) as Row[];

  return (
    <Card className={s.card}>
      <div className={s.cardHead}>
        <div>
          <Text weight="semibold">
            {title} <span className={s.muted}>({total})</span>
          </Text>
          {hint && (
            <Text size={200} className={s.muted} block>
              {hint}
            </Text>
          )}
        </div>
        <div className={s.toolbar}>
          <SearchBox
            size="small"
            placeholder="Search…"
            value={qInput}
            onChange={(_, d) => setQInput(d.value)}
            style={{ minWidth: 200 }}
          />
          {!readOnly && (
            <Button
              size="small"
              icon={<AddRegular />}
              onClick={() => {
                setEditing(null);
                setError(null);
                setOpen(true);
              }}
            >
              Add
            </Button>
          )}
        </div>
      </div>

      {error && <LoadError message={error} />}
      {list.isError && <LoadError message={(list.error as Error).message} />}

      {list.isLoading ? (
        <Spinner size="tiny" />
      ) : items.length === 0 ? (
        <Text size={200} className={s.muted}>
          {q ? 'No matches.' : emptyText}
        </Text>
      ) : (
        <>
          <RecordTable
            rows={items}
            columns={columns}
            readOnly={readOnly}
            removing={remove.isPending}
            extraRowAction={extraRowAction}
            onEdit={(r) => {
              setEditing(r);
              setError(null);
              setOpen(true);
            }}
            onDelete={(id) => remove.mutate(id)}
          />
          {pages > 1 && (
            <div className={s.pager}>
              <Text size={200} className={s.muted}>
                Page {page} of {pages} · {total} total
              </Text>
              <Button
                size="small"
                appearance="subtle"
                icon={<ChevronLeftRegular />}
                disabled={page <= 1 || list.isFetching}
                onClick={() => setPage((p) => Math.max(1, p - 1))}
              />
              <Button
                size="small"
                appearance="subtle"
                icon={<ChevronRightRegular />}
                disabled={page >= pages || list.isFetching}
                onClick={() => setPage((p) => Math.min(pages, p + 1))}
              />
            </div>
          )}
        </>
      )}

      <RecordDialog
        open={open}
        onOpenChange={setOpen}
        title={title}
        fields={fields}
        editing={editing}
        saving={save.isPending}
        error={error}
        onSave={(payload) => save.mutate(payload)}
      />
    </Card>
  );
}

/* ------------------------------ the table ------------------------------ */

function RecordTable({
  rows,
  columns,
  readOnly,
  removing,
  extraRowAction,
  onEdit,
  onDelete,
}: {
  rows: Row[];
  columns: ColumnDef[];
  readOnly: boolean;
  removing: boolean;
  extraRowAction?: (r: Row) => ReactNode;
  onEdit: (r: Row) => void;
  onDelete: (id: string) => void;
}) {
  const s = useRecordStyles();
  return (
    <div className={s.tableWrap}>
      <Table size="small" className={s.table}>
        <TableHeader>
          <TableRow>
            {columns.map((c) => (
              <TableHeaderCell key={c.key} className={s.nowrapCell}>
                {c.label}
              </TableHeaderCell>
            ))}
            {!readOnly && <TableHeaderCell className={s.actionsCol} />}
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((r) => (
            <TableRow key={r.id}>
              {columns.map((c) => {
                const content = c.render ? c.render(r) : ((r[c.key] as string) ?? '—') || '—';
                return (
                  <TableCell key={c.key} className={s.nowrapCell}>
                    <span
                      className={s.cellText}
                      title={typeof content === 'string' ? content : undefined}
                    >
                      {content}
                    </span>
                  </TableCell>
                );
              })}
              {!readOnly && (
                <TableCell className={s.actionsCol}>
                  <div className={s.rowActions}>
                    {extraRowAction?.(r)}
                    <Button
                      size="small"
                      appearance="subtle"
                      icon={<EditRegular />}
                      aria-label="Edit"
                      onClick={() => onEdit(r)}
                    />
                    <Button
                      size="small"
                      appearance="subtle"
                      icon={<DeleteRegular />}
                      aria-label="Delete"
                      disabled={removing}
                      onClick={() => onDelete(r.id)}
                    />
                  </div>
                </TableCell>
              )}
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
