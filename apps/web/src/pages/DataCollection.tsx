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
  Table,
  TableBody,
  TableCell,
  TableHeader,
  TableHeaderCell,
  TableRow,
  Text,
  Textarea,
  Title3,
  makeStyles,
  shorthands,
  tokens,
} from '@fluentui/react-components';
import { AddRegular, DeleteRegular, EditRegular } from '@fluentui/react-icons';
import {
  FLOW_KINDS,
  LICENSING_MODELS,
  NETWORK_SCOPES,
  NETWORK_TYPES,
  NUMBER_RANGE_KINDS,
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
  statusRow: { display: 'flex', alignItems: 'center', ...shorthands.gap('10px'), flexWrap: 'wrap' },
  card: { ...shorthands.padding('16px'), display: 'grid', ...shorthands.gap('12px') },
  cardHead: { display: 'flex', justifyContent: 'space-between', alignItems: 'center' },
  formGrid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))',
    ...shorthands.gap('12px'),
  },
  dialogForm: { display: 'grid', ...shorthands.gap('12px'), minWidth: '420px' },
  rowActions: { display: 'flex', ...shorthands.gap('4px'), justifyContent: 'flex-end' },
  muted: { color: tokens.colorNeutralForeground3 },
});

type Row = Record<string, unknown> & { id: string };

interface FieldDef {
  key: string;
  label: string;
  type?: 'text' | 'textarea' | 'number' | 'select';
  options?: readonly string[];
  required?: boolean;
  placeholder?: string;
}

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
}: {
  title: string;
  hint?: string;
  fields: FieldDef[];
  rows: Row[];
  columns: { key: string; label: string; render?: (r: Row) => ReactNode }[];
  basePath: string; // e.g. /t/<id>/discovery/sites
  readOnly: boolean;
  onChanged: () => void;
}) {
  const s = useStyles();
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<Row | null>(null);
  const [values, setValues] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);

  const startAdd = () => {
    setEditing(null);
    setValues(Object.fromEntries(fields.map((f) => [f.key, ''])));
    setError(null);
    setOpen(true);
  };
  const startEdit = (r: Row) => {
    setEditing(r);
    setValues(Object.fromEntries(fields.map((f) => [f.key, r[f.key] == null ? '' : String(r[f.key])])));
    setError(null);
    setOpen(true);
  };

  const save = useMutation({
    mutationFn: async () => {
      const payload: Record<string, unknown> = {};
      for (const f of fields) {
        const v = values[f.key] ?? '';
        if (f.type === 'number') payload[f.key] = v === '' ? null : Number(v);
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
          <Button size="small" icon={<AddRegular />} onClick={startAdd}>
            Add
          </Button>
        )}
      </div>

      {rows.length === 0 ? (
        <Text size={200} className={s.muted}>
          Nothing captured yet.
        </Text>
      ) : (
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
                  <TableCell key={c.key}>
                    {c.render ? c.render(r) : ((r[c.key] as string) ?? '—') || '—'}
                  </TableCell>
                ))}
                {!readOnly && (
                  <TableCell>
                    <div className={s.rowActions}>
                      <Button
                        size="small"
                        appearance="subtle"
                        icon={<EditRegular />}
                        aria-label="Edit"
                        onClick={() => startEdit(r)}
                      />
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
                  <Field key={f.key} label={f.label} required={f.required}>
                    {f.type === 'textarea' ? (
                      <Textarea
                        value={values[f.key] ?? ''}
                        resize="vertical"
                        onChange={(_, d) => setValues((v) => ({ ...v, [f.key]: d.value }))}
                      />
                    ) : f.type === 'select' ? (
                      <Dropdown
                        placeholder="Select…"
                        selectedOptions={values[f.key] ? [values[f.key]!] : []}
                        value={values[f.key] ?? ''}
                        onOptionSelect={(_, d) =>
                          setValues((v) => ({ ...v, [f.key]: d.optionValue ?? '' }))
                        }
                      >
                        {(f.options ?? []).map((o) => (
                          <Option key={o} value={o}>
                            {o}
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
  { key: 'notes', label: 'Notes', type: 'textarea' },
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
    setDraft(Object.fromEntries(GENERAL_FIELDS.map((f) => [f.key, (value as any)?.[f.key] ?? ''])));
  }, [value]);

  const dirty = useMemo(
    () => GENERAL_FIELDS.some((f) => (draft[f.key] ?? '') !== ((value as any)?.[f.key] ?? '')),
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
          <Button
            size="small"
            appearance="primary"
            disabled={!dirty || save.isPending}
            onClick={() => save.mutate()}
          >
            {save.isPending ? <Spinner size="tiny" /> : 'Save'}
          </Button>
        )}
      </div>
      <div className={s.formGrid}>
        {GENERAL_FIELDS.map((f) => (
          <Field key={f.key} label={f.label} style={f.type === 'textarea' ? { gridColumn: '1 / -1' } : undefined}>
            {readOnly ? (
              <Text>{draft[f.key] || '—'}</Text>
            ) : f.type === 'textarea' ? (
              <Textarea
                value={draft[f.key] ?? ''}
                resize="vertical"
                onChange={(_, d) => setDraft((v) => ({ ...v, [f.key]: d.value }))}
              />
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
              <Input
                placeholder={f.placeholder}
                value={draft[f.key] ?? ''}
                onChange={(_, d) => setDraft((v) => ({ ...v, [f.key]: d.value }))}
              />
            )}
          </Field>
        ))}
      </div>
      {error && <Text style={{ color: tokens.colorPaletteRedForeground1 }}>{error}</Text>}
    </Card>
  );
}

/* -------------------------------- page -------------------------------- */

interface DiscoveryResponse {
  discovery: { id: string; status: 'draft' | 'submitted' | 'accepted'; general: DiscoveryGeneral } | null;
  sites: Row[];
  ranges: Row[];
  network: Row[];
  flows: Row[];
}

const STATUS_COLOR: Record<string, 'informative' | 'warning' | 'success'> = {
  draft: 'informative',
  submitted: 'warning',
  accepted: 'success',
};

export function DataCollection() {
  const { activeTenantId, can } = useAuth();
  const qc = useQueryClient();
  const key = ['discovery', activeTenantId];
  const refetch = () => qc.invalidateQueries({ queryKey: key });

  const q = useQuery({
    queryKey: key,
    enabled: !!activeTenantId,
    queryFn: () => api<DiscoveryResponse>(`/t/${activeTenantId}/discovery`),
  });

  const action = useMutation({
    mutationFn: (verb: 'submit' | 'accept' | 'reopen') =>
      api(`/t/${activeTenantId}/discovery/${verb}`, { method: 'POST' }),
    onSuccess: refetch,
  });

  if (!activeTenantId) return <NoTenant />;
  if (q.isLoading) return <Spinner label="Loading discovery…" />;
  if (q.isError) return <LoadError message={(q.error as Error).message} />;

  const d = q.data!;
  const status = d.discovery?.status ?? 'draft';
  const canWrite = can('discovery:write');
  const canReview = can('discovery:review');
  const locked = !canWrite || status === 'accepted' || (status === 'submitted' && !canReview);
  const base = `/t/${activeTenantId}/discovery`;

  return (
    <Page
      title="Data Collection"
      subtitle="Capture the customer's current voice estate. This feeds the Design & Build stage."
      actions={
        <div className="dc-actions" style={{ display: 'flex', gap: 8 }}>
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
      <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
        <Text>Status:</Text>
        <Badge appearance="tint" color={STATUS_COLOR[status]}>
          {status}
        </Badge>
        {locked && (
          <Text size={200} style={{ color: tokens.colorNeutralForeground3 }}>
            {status === 'accepted'
              ? 'Accepted and locked — reopen to edit.'
              : status === 'submitted'
                ? 'Submitted for engineer review.'
                : 'Read-only for your role.'}
          </Text>
        )}
      </div>
      {action.isError && <LoadError message={(action.error as Error).message} />}

      <GeneralForm
        value={d.discovery?.general ?? {}}
        readOnly={locked}
        tenantId={activeTenantId}
        onChanged={refetch}
      />

      <CrudSection
        title="Sites"
        hint="Physical locations in scope, with any paging/overhead requirements."
        basePath={`${base}/sites`}
        readOnly={locked}
        onChanged={refetch}
        rows={d.sites}
        columns={[
          { key: 'name', label: 'Name' },
          { key: 'site_code', label: 'Code' },
          { key: 'address', label: 'Address' },
          { key: 'country', label: 'Country' },
          { key: 'region', label: 'Region' },
        ]}
        fields={[
          { key: 'name', label: 'Site name' },
          { key: 'site_code', label: 'Site / company code' },
          { key: 'address', label: 'Address', type: 'textarea' },
          { key: 'country', label: 'Country' },
          { key: 'region', label: 'Region' },
        ]}
      />

      <CrudSection
        title="Number ranges"
        hint="DID ranges: new numbers to request, ranges to port, or numbers to retain."
        basePath={`${base}/number-ranges`}
        readOnly={locked}
        onChanged={refetch}
        rows={d.ranges}
        columns={[
          { key: 'range_start', label: 'From' },
          { key: 'range_end', label: 'To' },
          { key: 'kind', label: 'Kind' },
          { key: 'carrier', label: 'Carrier' },
          { key: 'port_status', label: 'Port status' },
        ]}
        fields={[
          { key: 'range_start', label: 'Range start (E.164)', required: true, placeholder: '+14255551000' },
          { key: 'range_end', label: 'Range end (E.164)', required: true, placeholder: '+14255551099' },
          { key: 'kind', label: 'Kind', type: 'select', options: NUMBER_RANGE_KINDS, required: true },
          { key: 'carrier', label: 'Carrier' },
          { key: 'port_status', label: 'Port status' },
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
        title="Call flows"
        hint="Describe existing auto attendants / call queues / IVRs. Attach diagrams later."
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
          { key: 'description', label: 'Description', type: 'textarea' },
        ]}
      />
    </Page>
  );
}
