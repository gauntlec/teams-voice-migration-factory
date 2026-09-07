import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Badge,
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
import { AddRegular, DeleteRegular, EditRegular } from '@fluentui/react-icons';
import {
  CALLER_ID_OPTIONS,
  FLOW_KINDS,
  LICENSING_MODELS,
  NETWORK_SCOPES,
  NETWORK_TYPES,
  NUMBER_RANGE_KINDS,
  RESOURCE_ACCOUNT_KINDS,
  type DiscoveryGeneral,
} from '@tvmf/shared';
import { api, ApiError } from '../api';
import { useAuth } from '../auth';
import { Page } from '../components/Page';

/* ----------------------------- shared bits ----------------------------- */

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

const useStyles = makeStyles({
  card: { ...shorthands.padding('16px'), display: 'grid', ...shorthands.gap('12px') },
  cardHead: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', ...shorthands.gap('8px') },
  formGrid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))', ...shorthands.gap('12px') },
  dialogForm: { display: 'grid', ...shorthands.gap('12px'), minWidth: '440px' },
  rowActions: { display: 'flex', ...shorthands.gap('4px'), justifyContent: 'flex-end' },
  muted: { color: tokens.colorNeutralForeground3 },
  chips: { display: 'flex', ...shorthands.gap('6px'), flexWrap: 'wrap' },
  summary: { display: 'flex', ...shorthands.gap('16px'), flexWrap: 'wrap' },
});

type Row = Record<string, unknown> & { id: string };
type Choice = { value: string; label: string };

interface FieldDef {
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

const yesNo = (v: unknown) => (v ? 'Yes' : 'No');

/* --------------------------- generic CRUD section --------------------------- */

function CrudSection({
  title,
  hint,
  fields,
  rows,
  columns,
  basePath,
  readOnly,
  onChanged,
  extraRowAction,
}: {
  title: string;
  hint?: string;
  fields: FieldDef[];
  rows: Row[];
  columns: { key: string; label: string; render?: (r: Row) => ReactNode }[];
  basePath: string;
  readOnly: boolean;
  onChanged: () => void;
  extraRowAction?: (r: Row) => ReactNode;
}) {
  const s = useStyles();
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<Row | null>(null);
  const [values, setValues] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);

  const initial = (r: Row | null) =>
    Object.fromEntries(
      fields.map((f) => {
        if (!r) return [f.key, f.default ?? (f.type === 'boolean' ? 'false' : '')];
        const v = r[f.key];
        if (f.type === 'boolean') return [f.key, v === true ? 'true' : v === false ? 'false' : (f.default ?? 'false')];
        return [f.key, v == null ? '' : String(v)];
      }),
    );

  const startAdd = () => {
    setEditing(null);
    setValues(initial(null));
    setError(null);
    setOpen(true);
  };
  const startEdit = (r: Row) => {
    setEditing(r);
    setValues(initial(r));
    setError(null);
    setOpen(true);
  };

  const save = useMutation({
    mutationFn: async () => {
      const payload: Record<string, unknown> = {};
      for (const f of fields) {
        const v = values[f.key] ?? '';
        if (f.type === 'number') payload[f.key] = v === '' ? null : Number(v);
        else if (f.type === 'boolean') payload[f.key] = v === 'true';
        else if (f.type === 'ref') payload[f.key] = v || null;
        else payload[f.key] = v;
      }
      if (editing) return api(`${basePath}/${editing.id}`, { method: 'PATCH', body: JSON.stringify(payload) });
      return api(basePath, { method: 'POST', body: JSON.stringify(payload) });
    },
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

  const resolveChoices = (f: FieldDef): Choice[] =>
    typeof f.choices === 'function' ? f.choices(editing) : (f.choices ?? []);

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
          <Button size="small" icon={<AddRegular />} onClick={startAdd}>
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
        <div style={{ overflowX: 'auto' }}>
          <Table size="small">
            <TableHeader>
              <TableRow>
                {columns.map((c) => (
                  <TableHeaderCell key={c.key}>{c.label}</TableHeaderCell>
                ))}
                {!readOnly && <TableHeaderCell />}
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((r) => (
                <TableRow key={r.id}>
                  {columns.map((c) => (
                    <TableCell key={c.key}>{c.render ? c.render(r) : ((r[c.key] as string) ?? '—') || '—'}</TableCell>
                  ))}
                  {!readOnly && (
                    <TableCell>
                      <div className={s.rowActions}>
                        {extraRowAction?.(r)}
                        <Button size="small" appearance="subtle" icon={<EditRegular />} aria-label="Edit" onClick={() => startEdit(r)} />
                        <Button
                          size="small"
                          appearance="subtle"
                          icon={<DeleteRegular />}
                          aria-label="Delete"
                          disabled={remove.isPending}
                          onClick={() => remove.mutate(r.id)}
                        />
                      </div>
                    </TableCell>
                  )}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      <Dialog open={open} onOpenChange={(_, d) => setOpen(d.open)}>
        <DialogSurface>
          <DialogBody>
            <DialogTitle>
              {editing ? 'Edit' : 'Add'} {title.replace(/s$/, '').toLowerCase()}
            </DialogTitle>
            <DialogContent>
              <div className={s.dialogForm}>
                {fields.map((f) => (
                  <Field key={f.key} label={f.label} required={f.required} style={f.full ? { gridColumn: '1 / -1' } : undefined}>
                    {f.type === 'boolean' ? (
                      <Switch
                        checked={values[f.key] === 'true'}
                        onChange={(_, d) => setValues((v) => ({ ...v, [f.key]: d.checked ? 'true' : 'false' }))}
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
                        {(f.type === 'ref' ? [{ value: '', label: '— none —' }, ...resolveChoices(f)] : (f.options ?? []).map((o) => ({ value: o, label: o }))).map(
                          (o) => (
                            <Option key={o.value || '__none'} value={o.value} text={o.label}>
                              {o.label}
                            </Option>
                          ),
                        )}
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
                disabled={save.isPending || fields.some((f) => f.required && !values[f.key])}
                onClick={() => save.mutate()}
              >
                Save
              </Button>
            </DialogActions>
          </DialogBody>
        </DialogSurface>
      </Dialog>
    </Card>
  );
}

/* ------------------------------ General form ------------------------------ */

const GENERAL_FIELDS: FieldDef[] = [
  { key: 'migrationId', label: 'Migration ID' },
  { key: 'region', label: 'Region' },
  { key: 'author', label: 'Author' },
  { key: 'licensingModel', label: 'PSTN / licensing model', type: 'select', options: LICENSING_MODELS },
  { key: 'targetGoLive', label: 'Target go-live', placeholder: 'e.g. Q3 2026' },
  { key: 'primaryContactEmail', label: 'Primary contact email' },
  { key: 'notes', label: 'Notes', type: 'textarea', full: true },
];

function GeneralForm({
  value,
  readOnly,
  tenantId,
  onChanged,
}: {
  value: DiscoveryGeneral;
  readOnly: boolean;
  tenantId: string;
  onChanged: () => void;
}) {
  const s = useStyles();
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setDraft(Object.fromEntries(GENERAL_FIELDS.map((f) => [f.key, (value as Record<string, string>)?.[f.key] ?? ''])));
  }, [value]);

  const dirty = useMemo(
    () => GENERAL_FIELDS.some((f) => (draft[f.key] ?? '') !== ((value as Record<string, string>)?.[f.key] ?? '')),
    [draft, value],
  );

  const save = useMutation({
    mutationFn: () => api(`/t/${tenantId}/discovery/general`, { method: 'PATCH', body: JSON.stringify(draft) }),
    onSuccess: () => {
      setError(null);
      onChanged();
    },
    onError: (e) => setError(e instanceof ApiError ? e.message : 'Save failed'),
  });

  return (
    <Card className={s.card}>
      <div className={s.cardHead}>
        <Text weight="semibold">Overview</Text>
        {!readOnly && (
          <Button size="small" appearance="primary" disabled={!dirty || save.isPending} onClick={() => save.mutate()}>
            {save.isPending ? <Spinner size="tiny" /> : 'Save'}
          </Button>
        )}
      </div>
      <div className={s.formGrid}>
        {GENERAL_FIELDS.map((f) => (
          <Field key={f.key} label={f.label} style={f.full ? { gridColumn: '1 / -1' } : undefined}>
            {readOnly ? (
              <Text>{draft[f.key] || '—'}</Text>
            ) : f.type === 'textarea' ? (
              <Textarea value={draft[f.key] ?? ''} resize="vertical" onChange={(_, d) => setDraft((v) => ({ ...v, [f.key]: d.value }))} />
            ) : f.type === 'select' ? (
              <Dropdown
                placeholder="Select…"
                selectedOptions={draft[f.key] ? [draft[f.key]!] : []}
                value={draft[f.key] ?? ''}
                onOptionSelect={(_, d) => setDraft((v) => ({ ...v, [f.key]: d.optionValue ?? '' }))}
              >
                {LICENSING_MODELS.map((o) => (
                  <Option key={o} value={o}>
                    {o}
                  </Option>
                ))}
              </Dropdown>
            ) : (
              <Input placeholder={f.placeholder} value={draft[f.key] ?? ''} onChange={(_, d) => setDraft((v) => ({ ...v, [f.key]: d.value }))} />
            )}
          </Field>
        ))}
      </div>
      {error && <Text style={{ color: tokens.colorPaletteRedForeground1 }}>{error}</Text>}
    </Card>
  );
}

/* --------------------------- number inventory --------------------------- */

interface PhoneNumber {
  id: string;
  e164: string;
  status: 'available' | 'reserved' | 'assigned';
  holder_type: string | null;
  holder_name: string | null;
  range_id: string;
}

function NumberInventory({
  numbers,
  summary,
  ranges,
  readOnly,
  base,
  onChanged,
}: {
  numbers: PhoneNumber[];
  summary: { total: number; available: number; reserved: number; assigned: number };
  ranges: { id: string; range_start: string }[];
  readOnly: boolean;
  base: string;
  onChanged: () => void;
}) {
  const s = useStyles();
  const [filter, setFilter] = useState<'all' | 'available' | 'reserved' | 'assigned'>('all');
  const rangeStart = Object.fromEntries(ranges.map((r) => [r.id, r.range_start]));

  const reserve = useMutation({
    mutationFn: ({ id, reserved }: { id: string; reserved: boolean }) =>
      api(`${base}/numbers/${id}/reserve`, { method: 'PATCH', body: JSON.stringify({ reserved }) }),
    onSuccess: onChanged,
  });

  const shown = numbers.filter((n) => filter === 'all' || n.status === filter);

  return (
    <Card className={s.card}>
      <div className={s.cardHead}>
        <div>
          <Text weight="semibold">Number inventory</Text>
          <Text size={200} className={s.muted} block>
            Generated from the ranges above. Assign numbers to users, CAPs or resource accounts below.
          </Text>
        </div>
        <Dropdown
          size="small"
          value={filter}
          selectedOptions={[filter]}
          onOptionSelect={(_, d) => setFilter((d.optionValue as typeof filter) ?? 'all')}
          style={{ minWidth: 140 }}
        >
          {['all', 'available', 'reserved', 'assigned'].map((o) => (
            <Option key={o} value={o}>
              {o}
            </Option>
          ))}
        </Dropdown>
      </div>
      <div className={s.summary}>
        <Text size={200}>Total: <b>{summary.total}</b></Text>
        <Text size={200}>Available: <b>{summary.available}</b></Text>
        <Text size={200}>Reserved: <b>{summary.reserved}</b></Text>
        <Text size={200}>Assigned: <b>{summary.assigned}</b></Text>
      </div>
      {shown.length === 0 ? (
        <Text size={200} className={s.muted}>
          {summary.total === 0 ? 'Add a number range to generate the inventory.' : 'No numbers match this filter.'}
        </Text>
      ) : (
        <div style={{ overflowX: 'auto', maxHeight: 360 }}>
          <Table size="small">
            <TableHeader>
              <TableRow>
                <TableHeaderCell>Number</TableHeaderCell>
                <TableHeaderCell>Range</TableHeaderCell>
                <TableHeaderCell>Status</TableHeaderCell>
                <TableHeaderCell>Holder</TableHeaderCell>
                {!readOnly && <TableHeaderCell />}
              </TableRow>
            </TableHeader>
            <TableBody>
              {shown.slice(0, 500).map((n) => (
                <TableRow key={n.id}>
                  <TableCell style={{ fontFamily: 'ui-monospace, monospace' }}>{n.e164}</TableCell>
                  <TableCell>{rangeStart[n.range_id] ?? '—'}</TableCell>
                  <TableCell>
                    <Badge
                      appearance="tint"
                      color={n.status === 'assigned' ? 'success' : n.status === 'reserved' ? 'warning' : 'informative'}
                    >
                      {n.status}
                    </Badge>
                  </TableCell>
                  <TableCell>{n.holder_name ? `${n.holder_name} (${n.holder_type})` : '—'}</TableCell>
                  {!readOnly && (
                    <TableCell>
                      {n.status !== 'assigned' && (
                        <Button
                          size="small"
                          appearance="subtle"
                          disabled={reserve.isPending}
                          onClick={() => reserve.mutate({ id: n.id, reserved: n.status !== 'reserved' })}
                        >
                          {n.status === 'reserved' ? 'Release' : 'Reserve'}
                        </Button>
                      )}
                    </TableCell>
                  )}
                </TableRow>
              ))}
            </TableBody>
          </Table>
          {shown.length > 500 && (
            <Text size={200} className={s.muted}>
              Showing first 500 of {shown.length}.
            </Text>
          )}
        </div>
      )}
    </Card>
  );
}

/* --------------------- resource-account number manager --------------------- */

function RaNumbersButton({
  ra,
  available,
  base,
  onChanged,
}: {
  ra: Row & { name: string; phone_numbers: { id: string; e164: string }[] };
  available: Choice[];
  base: string;
  onChanged: () => void;
}) {
  const s = useStyles();
  const [open, setOpen] = useState(false);
  const [pick, setPick] = useState('');
  const [error, setError] = useState<string | null>(null);

  const attach = useMutation({
    mutationFn: () => api(`${base}/resource-accounts/${ra.id}/numbers`, { method: 'POST', body: JSON.stringify({ phone_number_id: pick }) }),
    onSuccess: () => {
      setPick('');
      setError(null);
      onChanged();
    },
    onError: (e) => setError(e instanceof ApiError ? e.message : 'Failed'),
  });
  const detach = useMutation({
    mutationFn: (numberId: string) => api(`${base}/resource-accounts/${ra.id}/numbers/${numberId}`, { method: 'DELETE' }),
    onSuccess: onChanged,
  });

  return (
    <>
      <Button size="small" appearance="subtle" onClick={() => setOpen(true)}>
        Numbers ({ra.phone_numbers.length})
      </Button>
      <Dialog open={open} onOpenChange={(_, d) => setOpen(d.open)}>
        <DialogSurface>
          <DialogBody>
            <DialogTitle>Numbers for {ra.name}</DialogTitle>
            <DialogContent>
              <div className={s.dialogForm}>
                <div className={s.chips}>
                  {ra.phone_numbers.length === 0 && <Text size={200} className={s.muted}>None attached.</Text>}
                  {ra.phone_numbers.map((n) => (
                    <Badge key={n.id} appearance="outline" size="large">
                      {n.e164}
                      <Button size="small" appearance="transparent" icon={<DeleteRegular />} aria-label="Detach" onClick={() => detach.mutate(n.id)} />
                    </Badge>
                  ))}
                </div>
                <Field label="Attach an available number">
                  <div style={{ display: 'flex', gap: 8 }}>
                    <Dropdown
                      placeholder="Select…"
                      selectedOptions={pick ? [pick] : []}
                      value={available.find((c) => c.value === pick)?.label ?? ''}
                      onOptionSelect={(_, d) => setPick(d.optionValue ?? '')}
                      style={{ flex: 1 }}
                    >
                      {available.map((c) => (
                        <Option key={c.value} value={c.value}>
                          {c.label}
                        </Option>
                      ))}
                    </Dropdown>
                    <Button appearance="primary" disabled={!pick || attach.isPending} onClick={() => attach.mutate()}>
                      Attach
                    </Button>
                  </div>
                </Field>
                {error && <Text style={{ color: tokens.colorPaletteRedForeground1 }}>{error}</Text>}
              </div>
            </DialogContent>
            <DialogActions>
              <DialogTrigger disableButtonEnhancement>
                <Button appearance="secondary">Close</Button>
              </DialogTrigger>
            </DialogActions>
          </DialogBody>
        </DialogSurface>
      </Dialog>
    </>
  );
}

/* -------------------------------- page -------------------------------- */

interface BaseResponse {
  discovery: { id: string; status: 'draft' | 'submitted' | 'accepted'; general: DiscoveryGeneral } | null;
  sites: Row[];
  network: Row[];
  flows: Row[];
}
interface TelephonyResponse {
  callingPolicies: (Row & { name: string })[];
  ranges: (Row & { range_start: string; counts: { total: number; assigned: number; reserved: number } })[];
  numbers: PhoneNumber[];
  numberSummary: { total: number; available: number; reserved: number; assigned: number };
  users: Row[];
  caps: Row[];
  resourceAccounts: (Row & { name: string; phone_numbers: { id: string; e164: string }[] })[];
}

const STATUS_COLOR: Record<string, 'informative' | 'warning' | 'success'> = {
  draft: 'informative',
  submitted: 'warning',
  accepted: 'success',
};

export function DataCollection() {
  const s = useStyles();
  const { activeTenantId, can } = useAuth();
  const qc = useQueryClient();
  const baseKey = ['discovery', activeTenantId];
  const telKey = ['discovery-telephony', activeTenantId];
  const refetch = () => {
    qc.invalidateQueries({ queryKey: baseKey });
    qc.invalidateQueries({ queryKey: telKey });
  };

  const q = useQuery({
    queryKey: baseKey,
    enabled: !!activeTenantId,
    queryFn: () => api<BaseResponse>(`/t/${activeTenantId}/discovery`),
  });
  const tq = useQuery({
    queryKey: telKey,
    enabled: !!activeTenantId,
    queryFn: () => api<TelephonyResponse>(`/t/${activeTenantId}/discovery/telephony`),
  });

  const action = useMutation({
    mutationFn: (verb: 'submit' | 'accept' | 'reopen') => api(`/t/${activeTenantId}/discovery/${verb}`, { method: 'POST' }),
    onSuccess: refetch,
  });

  if (!activeTenantId) return <NoTenant />;
  if (q.isLoading || tq.isLoading) return <Spinner label="Loading discovery…" />;
  if (q.isError) return <LoadError message={(q.error as Error).message} />;
  if (tq.isError) return <LoadError message={(tq.error as Error).message} />;

  const d = q.data!;
  const tel = tq.data!;
  const status = d.discovery?.status ?? 'draft';
  const canWrite = can('discovery:write');
  const canReview = can('discovery:review');
  const locked = !canWrite || status === 'accepted' || (status === 'submitted' && !canReview);
  const base = `/t/${activeTenantId}/discovery`;

  const policyChoices: Choice[] = tel.callingPolicies.map((p) => ({ value: p.id, label: p.name }));
  const policyName = (id: unknown) => tel.callingPolicies.find((p) => p.id === id)?.name ?? '—';
  const availableChoices: Choice[] = tel.numbers.filter((n) => n.status === 'available').map((n) => ({ value: n.id, label: n.e164 }));
  const numberChoicesFor = (row: Row | null): Choice[] => {
    const cur = row && row.phone_number_id ? [{ value: String(row.phone_number_id), label: `${row.phone_number} (current)` }] : [];
    return [...cur, ...availableChoices];
  };
  const siteChoices: Choice[] = (d.sites as { sitecode?: string; name?: string }[])
    .filter((s0) => !!s0.sitecode)
    .map((s0) => ({ value: s0.sitecode!, label: s0.name ? `${s0.sitecode} — ${s0.name}` : s0.sitecode! }));

  return (
    <Page
      title="Data Collection"
      subtitle="The customer's current voice estate — sites, numbers, users, CAPs and resource accounts. Feeds Design & Build."
      actions={
        <div style={{ display: 'flex', gap: 8 }}>
          {canWrite && status === 'draft' && (
            <Button appearance="primary" disabled={action.isPending} onClick={() => action.mutate('submit')}>
              Submit for review
            </Button>
          )}
          {canReview && status === 'submitted' && (
            <Button appearance="primary" disabled={action.isPending} onClick={() => action.mutate('accept')}>
              Accept
            </Button>
          )}
          {canReview && status !== 'draft' && (
            <Button disabled={action.isPending} onClick={() => action.mutate('reopen')}>
              Reopen
            </Button>
          )}
        </div>
      }
    >
      <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
        <Text>Status:</Text>
        <Badge appearance="tint" color={STATUS_COLOR[status]}>
          {status}
        </Badge>
        {locked && (
          <Text size={200} className={s.muted}>
            {status === 'accepted'
              ? 'Accepted and locked — reopen to edit.'
              : status === 'submitted'
                ? 'Submitted for engineer review.'
                : 'Read-only for your role.'}
          </Text>
        )}
      </div>
      {action.isError && <LoadError message={(action.error as Error).message} />}

      <GeneralForm value={d.discovery?.general ?? {}} readOnly={locked} tenantId={activeTenantId} onChanged={refetch} />

      <CrudSection
        title="Outbound calling policies"
        hint="Customer-defined dialling restrictions. Users and CAPs reference one of these."
        basePath={`${base}/calling-policies`}
        readOnly={locked}
        onChanged={refetch}
        rows={tel.callingPolicies}
        columns={[
          { key: 'name', label: 'Name' },
          { key: 'description', label: 'Description' },
          { key: 'allow_local', label: 'Local', render: (r) => yesNo(r.allow_local) },
          { key: 'allow_national', label: 'National', render: (r) => yesNo(r.allow_national) },
          { key: 'allow_international', label: 'Intl', render: (r) => yesNo(r.allow_international) },
          { key: 'allow_service', label: 'Service', render: (r) => yesNo(r.allow_service) },
          { key: 'allow_premium', label: 'Premium', render: (r) => yesNo(r.allow_premium) },
        ]}
        fields={[
          { key: 'name', label: 'Name', required: true },
          { key: 'description', label: 'Description', full: true },
          { key: 'allow_local', label: 'Allow local dialling', type: 'boolean', default: 'true' },
          { key: 'allow_national', label: 'Allow national dialling', type: 'boolean' },
          { key: 'allow_international', label: 'Allow international dialling', type: 'boolean' },
          { key: 'allow_service', label: 'Allow service numbers', type: 'boolean', default: 'true' },
          { key: 'allow_premium', label: 'Allow premium-rate dialling', type: 'boolean' },
        ]}
      />

      <CrudSection
        title="Number ranges"
        hint={
          siteChoices.length === 0
            ? 'Add a Site (below) first — every range must be linked to a site by its sitecode.'
            : 'Linked to a site by sitecode. Creating a range generates its individual numbers into the inventory below.'
        }
        basePath={`${base}/number-ranges`}
        readOnly={locked || siteChoices.length === 0}
        onChanged={refetch}
        rows={tel.ranges}
        columns={[
          { key: 'sitecode', label: 'Site' },
          { key: 'range_start', label: 'From' },
          { key: 'range_end', label: 'To' },
          { key: 'kind', label: 'Kind' },
          { key: 'size', label: 'Numbers', render: (r) => String((r.counts as TelephonyResponse['ranges'][number]['counts'])?.total ?? 0) },
          { key: 'assigned', label: 'Assigned', render: (r) => String((r.counts as TelephonyResponse['ranges'][number]['counts'])?.assigned ?? 0) },
          { key: 'carrier', label: 'Carrier' },
          { key: 'loa', label: 'LOA', render: (r) => `${r.loa_sent ? 'sent' : '—'} / ${r.loa_completed ? 'done' : '—'}` },
        ]}
        fields={[
          { key: 'sitecode', label: 'Site', type: 'ref', choices: siteChoices, required: true },
          { key: 'range_start', label: 'Range start', required: true, placeholder: '19133743250' },
          { key: 'range_end', label: 'Range end', required: true, placeholder: '19133743257' },
          { key: 'kind', label: 'Kind', type: 'select', options: NUMBER_RANGE_KINDS, required: true },
          { key: 'carrier', label: 'Carrier' },
          { key: 'loa_sent', label: 'LOA sent to customer', type: 'boolean' },
          { key: 'loa_completed', label: 'LOA completed', type: 'boolean' },
          { key: 'comments', label: 'Comments', type: 'textarea', full: true },
        ]}
      />

      <NumberInventory
        numbers={tel.numbers}
        summary={tel.numberSummary}
        ranges={tel.ranges}
        readOnly={locked}
        base={base}
        onChanged={refetch}
      />

      <CrudSection
        title="Users"
        hint="Teams users with Enterprise Voice. Each holds at most one number, allocated from the inventory."
        basePath={`${base}/users`}
        readOnly={locked}
        onChanged={refetch}
        rows={tel.users}
        columns={[
          { key: 'upn', label: 'UPN' },
          { key: 'display_name', label: 'Name' },
          { key: 'phone_number', label: 'Number' },
          { key: 'calling_policy_id', label: 'Calling policy', render: (r) => policyName(r.calling_policy_id) },
          { key: 'caller_id', label: 'Caller ID' },
          { key: 'voicemail_enabled', label: 'Voicemail', render: (r) => yesNo(r.voicemail_enabled) },
        ]}
        fields={[
          { key: 'upn', label: 'M365 UPN', required: true, placeholder: 'user@customer.com' },
          { key: 'display_name', label: 'Display name' },
          { key: 'phone_number_id', label: 'Phone number', type: 'ref', choices: numberChoicesFor },
          { key: 'calling_policy_id', label: 'Calling policy', type: 'ref', choices: policyChoices },
          { key: 'caller_id', label: 'Caller ID', type: 'select', options: CALLER_ID_OPTIONS },
          { key: 'voicemail_enabled', label: 'Voicemail enabled', type: 'boolean', default: 'true' },
          { key: 'voicemail_language', label: 'Voicemail language', placeholder: 'English' },
          { key: 'requires_handset', label: 'Requires a physical handset', type: 'boolean' },
          { key: 'handset_model', label: 'Handset model' },
          { key: 'access_port_id', label: 'Access port ID' },
          { key: 'comments', label: 'Comments', type: 'textarea', full: true },
        ]}
      />

      <CrudSection
        title="Common area phones"
        hint="Shared / lobby / meeting-room phones. Each holds at most one number."
        basePath={`${base}/caps`}
        readOnly={locked}
        onChanged={refetch}
        rows={tel.caps}
        columns={[
          { key: 'display_name', label: 'Display name' },
          { key: 'phone_number', label: 'Number' },
          { key: 'device_model', label: 'Device' },
          { key: 'calling_policy_id', label: 'Calling policy', render: (r) => policyName(r.calling_policy_id) },
          { key: 'caller_id', label: 'Caller ID' },
        ]}
        fields={[
          { key: 'display_name', label: 'Display name', required: true },
          { key: 'upn', label: 'UPN (if known)' },
          { key: 'phone_number_id', label: 'Phone number', type: 'ref', choices: numberChoicesFor },
          { key: 'device_model', label: 'Device model' },
          { key: 'calling_policy_id', label: 'Calling policy', type: 'ref', choices: policyChoices },
          { key: 'caller_id', label: 'Caller ID', type: 'select', options: CALLER_ID_OPTIONS },
          { key: 'access_port_id', label: 'Access port ID' },
          { key: 'comments', label: 'Comments', type: 'textarea', full: true },
        ]}
      />

      <CrudSection
        title="Resource accounts"
        hint="Auto attendants & call queues (the 'Virtual Numbers' tab). May hold several numbers — use the Numbers button."
        basePath={`${base}/resource-accounts`}
        readOnly={locked}
        onChanged={refetch}
        rows={tel.resourceAccounts}
        extraRowAction={(r) =>
          !locked ? (
            <RaNumbersButton
              ra={r as Row & { name: string; phone_numbers: { id: string; e164: string }[] }}
              available={availableChoices}
              base={base}
              onChanged={refetch}
            />
          ) : null
        }
        columns={[
          { key: 'name', label: 'Name' },
          { key: 'kind', label: 'Kind' },
          {
            key: 'phone_numbers',
            label: 'Numbers',
            render: (r) => (r.phone_numbers as { e164: string }[]).map((n) => n.e164).join(', ') || '—',
          },
          { key: 'business_hours', label: 'Business hours' },
          { key: 'who_answers', label: 'Who answers' },
        ]}
        fields={[
          { key: 'name', label: 'Name of service', required: true, placeholder: 'Main Line' },
          { key: 'kind', label: 'Kind', type: 'select', options: RESOURCE_ACCOUNT_KINDS, required: true },
          { key: 'directory_entry', label: 'Directory entry' },
          { key: 'business_hours', label: 'Business hours', placeholder: '24/7, or different out of hours' },
          { key: 'who_answers', label: 'Who should answer the call', type: 'textarea', full: true },
          { key: 'ooh_action', label: 'Out-of-hours action', type: 'textarea', full: true },
          { key: 'exception_conditions', label: 'Exception handling — conditions', type: 'textarea', full: true },
          { key: 'exception_action', label: 'Exception handling — action', type: 'textarea', full: true },
          { key: 'holiday', label: 'Holiday handling', type: 'textarea', full: true },
          { key: 'advanced_features', label: 'Advanced features', type: 'textarea', full: true },
          { key: 'comments', label: 'Comments', type: 'textarea', full: true },
        ]}
      />

      <CrudSection
        title="Sites"
        hint="Physical locations in scope. The Sitecode is the site's unique key — number ranges link to it."
        basePath={`${base}/sites`}
        readOnly={locked}
        onChanged={refetch}
        rows={d.sites}
        columns={[
          { key: 'sitecode', label: 'Sitecode' },
          { key: 'name', label: 'Name' },
          { key: 'address', label: 'Address' },
          { key: 'country', label: 'Country' },
          { key: 'region', label: 'Region' },
        ]}
        fields={[
          { key: 'sitecode', label: 'Sitecode', required: true, placeholder: 'OVP012' },
          { key: 'name', label: 'Site name' },
          { key: 'address', label: 'Address', type: 'textarea', full: true },
          { key: 'country', label: 'Country' },
          { key: 'region', label: 'Region' },
        ]}
      />

      <CrudSection
        title="Network (E911)"
        hint="Internal and external subnets used for emergency-call location and media routing."
        basePath={`${base}/network`}
        readOnly={locked}
        onChanged={refetch}
        rows={d.network}
        columns={[
          { key: 'scope', label: 'Scope' },
          { key: 'subnet', label: 'Subnet' },
          { key: 'mask', label: 'Mask' },
          { key: 'location', label: 'Location' },
          { key: 'network_type', label: 'Type' },
        ]}
        fields={[
          { key: 'scope', label: 'Scope', type: 'select', options: NETWORK_SCOPES, required: true },
          { key: 'subnet', label: 'Subnet', required: true, placeholder: '10.20.0.0' },
          { key: 'mask', label: 'Mask (bits)', type: 'number', placeholder: '24' },
          { key: 'location', label: 'Location' },
          { key: 'network_type', label: 'Network type', type: 'select', options: NETWORK_TYPES },
        ]}
      />

      <CrudSection
        title="Call flows (notes)"
        hint="Free-text notes on existing routing. Structured AA/CQ config lives under Resource accounts."
        basePath={`${base}/flows`}
        readOnly={locked}
        onChanged={refetch}
        rows={d.flows}
        columns={[
          { key: 'kind', label: 'Kind' },
          { key: 'name', label: 'Name' },
          {
            key: 'description',
            label: 'Description',
            render: (r) => {
              const v = (r.description as string) ?? '';
              return v.length > 90 ? `${v.slice(0, 90)}…` : v || '—';
            },
          },
        ]}
        fields={[
          { key: 'kind', label: 'Kind', type: 'select', options: FLOW_KINDS, required: true },
          { key: 'name', label: 'Name', required: true },
          { key: 'description', label: 'Description', type: 'textarea', full: true },
        ]}
      />
    </Page>
  );
}
