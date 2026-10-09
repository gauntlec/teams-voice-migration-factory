import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Badge,
  Button,
  Card,
  Checkbox,
  Combobox,
  Dialog,
  DialogActions,
  DialogBody,
  DialogContent,
  DialogSurface,
  DialogTitle,
  Field,
  Input,
  Link,
  Option,
  Select,
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
  tokens,
} from '@fluentui/react-components';
import {
  COUNTRY_CODES,
  NUMBER_NEED_NEW,
  SITE_MODE_LABELS,
  SITE_MODES,
  SR_MENU_KEYS,
  SR_NEW_NUMBER_KEY,
  SR_PRIORITIES,
  SR_STATUS_LABELS,
  SR_STATUSES,
  SR_TYPES,
  SR_TYPE_DEFS,
  canMoveSr,
  countryName,
  nextSrStatus,
  srDetailLines,
  srFieldVisible,
  type SiteMode,
  type SrFieldSpec,
  type SrMenuOption,
  type SrPerson,
  type SrPriority,
  type SrStatus,
  type SrTarget,
  type SrType,
} from '@tvmf/shared';
import { api, ApiError } from '../api';
import { useAuth } from '../auth';
import { DataTable } from '../components/DataTable';
import { useDebounced } from '../hooks/useDebounced';
import { Page } from '../components/Page';
import { LoadError, NoTenant } from './DataCollection';

interface RequestRow {
  id: string;
  number: number;
  reference: string;
  type: SrType;
  title: string;
  priority: SrPriority;
  status: SrStatus;
  site_id: string | null;
  sitecode: string | null;
  requested_by: string;
  requested_by_name: string | null;
  assigned_to: string | null;
  assigned_to_name: string | null;
  target_date: string | null;
  created_at: string;
}

interface RequestDetail extends RequestRow {
  details: Record<string, unknown>;
  site_name: string | null;
  planned_at: string | null;
  built_at: string | null;
  deployed_at: string | null;
  cancelled_at: string | null;
}

interface RequestEvent {
  id: string;
  kind: 'created' | 'status_changed' | 'assigned' | 'comment';
  from_status: SrStatus | null;
  to_status: SrStatus | null;
  body: string | null;
  internal: boolean;
  author_name: string | null;
  created_at: string;
}

interface SiteOption {
  id: string;
  sitecode: string;
  name: string | null;
  mode: SiteMode;
  mode_changed_at: string | null;
  mode_changed_by_name: string | null;
}

/** What the form can offer for the chosen site - see ServiceRequestsService.options. */
interface FormOptions {
  deviceModels: string[];
  availableNumbers: string[];
  siteNumbers: string[];
  ranges: { id: string; label: string }[];
  callQueues: { id: string; name: string }[];
  autoAttendants: { id: string; name: string }[];
}

const COUNTRY_OPTIONS = [...COUNTRY_CODES].map((c) => ({ code: c, name: countryName(c) })).sort((a, b) => a.name.localeCompare(b.name));

const STATUS_COLOR: Record<SrStatus, 'informative' | 'brand' | 'warning' | 'success' | 'subtle'> = {
  new: 'informative',
  planned: 'brand',
  built: 'warning',
  deployed: 'success',
  cancelled: 'subtle',
};

const PRIORITY_LABEL: Record<SrPriority, string> = { low: 'Low', normal: 'Normal', high: 'High', urgent: 'Urgent' };

const useStyles = makeStyles({
  toolbar: { display: 'flex', columnGap: tokens.spacingHorizontalM, alignItems: 'end', flexWrap: 'wrap', marginBottom: tokens.spacingVerticalM },
  stack: { display: 'flex', flexDirection: 'column', rowGap: tokens.spacingVerticalM },
  facts: { display: 'grid', gridTemplateColumns: 'max-content 1fr', columnGap: tokens.spacingHorizontalL, rowGap: tokens.spacingVerticalXS },
  factLabel: { color: tokens.colorNeutralForeground3 },
  section: { display: 'flex', flexDirection: 'column', rowGap: tokens.spacingVerticalS },
  event: {
    ...shorthands.padding(tokens.spacingVerticalS, tokens.spacingHorizontalM),
    ...shorthands.borderLeft('3px', 'solid', tokens.colorNeutralStroke2),
    display: 'flex',
    flexDirection: 'column',
    rowGap: tokens.spacingVerticalXXS,
  },
  internal: { ...shorthands.borderLeft('3px', 'solid', tokens.colorPaletteMarigoldBorder2), backgroundColor: tokens.colorPaletteYellowBackground1 },
  actions: { display: 'flex', columnGap: tokens.spacingHorizontalS, flexWrap: 'wrap', alignItems: 'center' },
  error: { color: tokens.colorPaletteRedForeground1 },
  row: { cursor: 'pointer' },
});

function errorText(e: unknown, fallback: string) {
  return e instanceof ApiError ? e.message : fallback;
}

function when(iso: string | null) {
  return iso ? new Date(iso).toLocaleString() : '—';
}

export function ServiceRequests() {
  const { activeTenantId, can, me } = useAuth();
  const cs = useStyles();
  const [params, setParams] = useSearchParams();
  const [status, setStatus] = useState<string>('open');
  const [type, setType] = useState<string>('');
  const [creating, setCreating] = useState(false);
  const openId = params.get('id');

  const enabled = me?.tenants.find((t) => t.id === activeTenantId)?.managedServices ?? false;
  const base = `/t/${activeTenantId}/service-requests`;

  const list = useQuery({
    queryKey: ['service-requests', activeTenantId, status, type],
    enabled: !!activeTenantId && enabled,
    queryFn: () => api<RequestRow[]>(`${base}?status=${status}${type ? `&type=${type}` : ''}`),
  });
  const sitesQ = useQuery({
    queryKey: ['service-request-sites', activeTenantId],
    enabled: !!activeTenantId && enabled,
    queryFn: () => api<SiteOption[]>(`${base}/sites`),
  });
  const [modesOpen, setModesOpen] = useState(false);

  const open = (id: string | null) => {
    const next = new URLSearchParams(params);
    if (id) next.set('id', id);
    else next.delete('id');
    setParams(next, { replace: true });
  };

  if (!activeTenantId) return <NoTenant />;
  if (!enabled) {
    return (
      <Page title="Service Requests" subtitle="Raise and track changes to your Teams calling.">
        <Card>
          <Text>
            Managed Services isn&apos;t switched on for this customer. A Super Admin can switch it on from <b>Customers</b>.
          </Text>
        </Card>
      </Page>
    );
  }

  return (
    <Page
      title="Service Requests"
      subtitle="Ask for new users, numbers, sites, phones, call queues and auto attendants. Each request is planned, designed and built, then deployed, and you're emailed as it moves on."
      actions={
        <div className={cs.actions}>
          {can('sr:manage') && <Button onClick={() => setModesOpen(true)}>Site modes</Button>}
          {can('sr:create') && (
            <Button appearance="primary" onClick={() => setCreating(true)}>
              New request
            </Button>
          )}
        </div>
      }
    >
      <div className={cs.toolbar}>
        <Field label="Status">
          <Select value={status} onChange={(_, d) => setStatus(d.value)}>
            <option value="open">Open</option>
            {SR_STATUSES.map((s) => (
              <option key={s} value={s}>
                {SR_STATUS_LABELS[s]}
              </option>
            ))}
            <option value="all">All</option>
          </Select>
        </Field>
        <Field label="Type">
          <Select value={type} onChange={(_, d) => setType(d.value)}>
            <option value="">All types</option>
            {SR_TYPES.map((t) => (
              <option key={t} value={t}>
                {SR_TYPE_DEFS[t].label}
              </option>
            ))}
          </Select>
        </Field>
      </div>
      {list.isError && <LoadError message={(list.error as Error).message} />}
      <Card>
        {list.isLoading ? (
          <Spinner size="tiny" />
        ) : (list.data?.length ?? 0) === 0 ? (
          <Text size={200}>No requests here.</Text>
        ) : (
          <DataTable size="small" minWidth={900}>
            <TableHeader>
              <TableRow>
                <TableHeaderCell>Ref</TableHeaderCell>
                <TableHeaderCell>Title</TableHeaderCell>
                <TableHeaderCell>Type</TableHeaderCell>
                <TableHeaderCell>Site</TableHeaderCell>
                <TableHeaderCell>Priority</TableHeaderCell>
                <TableHeaderCell>Status</TableHeaderCell>
                <TableHeaderCell>Assigned to</TableHeaderCell>
                <TableHeaderCell>Raised</TableHeaderCell>
              </TableRow>
            </TableHeader>
            <TableBody>
              {list.data!.map((r) => (
                <TableRow key={r.id} className={cs.row} onClick={() => open(r.id)}>
                  <TableCell>
                    <Link onClick={() => open(r.id)}>{r.reference}</Link>
                  </TableCell>
                  <TableCell>{r.title}</TableCell>
                  <TableCell>{SR_TYPE_DEFS[r.type].label}</TableCell>
                  <TableCell>{r.sitecode ?? '—'}</TableCell>
                  <TableCell>{PRIORITY_LABEL[r.priority]}</TableCell>
                  <TableCell>
                    <Badge appearance="tint" color={STATUS_COLOR[r.status]}>
                      {SR_STATUS_LABELS[r.status]}
                    </Badge>
                  </TableCell>
                  <TableCell>{r.assigned_to_name ?? '—'}</TableCell>
                  <TableCell>
                    {r.requested_by_name ?? '—'}
                    <Text size={100} block>
                      {new Date(r.created_at).toLocaleDateString()}
                    </Text>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </DataTable>
        )}
      </Card>

      {creating && (
        <NewRequestDialog
          base={base}
          sites={sitesQ.data ?? []}
          onClose={() => setCreating(false)}
          onCreated={(id) => {
            setCreating(false);
            open(id);
          }}
        />
      )}
      {openId && <RequestDialog base={base} id={openId} onClose={() => open(null)} />}
      {modesOpen && <SiteModesDialog base={base} sites={sitesQ.data ?? []} onClose={() => setModesOpen(false)} />}
    </Page>
  );
}

/* ------------------------------ new request ------------------------------ */

/** Search the customer's directory and pick one person. "Not listed" allows typing someone not synced yet. */
function PersonPicker({ base, value, onChange, placeholder }: { base: string; value?: SrPerson; onChange: (p: SrPerson | undefined) => void; placeholder?: string }) {
  const [text, setText] = useState(value ? `${value.name} (${value.upn})` : '');
  const [manual, setManual] = useState(false);
  const term = useDebounced(text);
  const hits = useQuery({
    queryKey: ['sr-people', base, term],
    enabled: !manual && term.length >= 2 && !(value && text === `${value.name} (${value.upn})`),
    queryFn: () => api<{ upn: string; name: string; synced: boolean }[]>(`${base}/people?q=${encodeURIComponent(term)}`),
  });
  useEffect(() => {
    setText(value ? `${value.name} (${value.upn})` : '');
  }, [value?.upn, value?.name]);

  if (manual) {
    return (
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
        <Input placeholder="Name" value={value?.name ?? ''} onChange={(_, d) => onChange({ name: d.value, upn: value?.upn ?? '' })} />
        <Input placeholder="name@company.com" value={value?.upn ?? ''} onChange={(_, d) => onChange({ name: value?.name ?? '', upn: d.value })} />
        <Link onClick={() => setManual(false)}>Search the directory instead</Link>
      </div>
    );
  }
  return (
    <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
      <Combobox
        freeform
        placeholder={placeholder ?? 'Type a name or sign-in address'}
        value={text}
        style={{ minWidth: 320 }}
        onChange={(e) => {
          setText(e.target.value);
          if (value) onChange(undefined);
        }}
        onOptionSelect={(_, d) => {
          const hit = (hits.data ?? []).find((h) => h.upn === d.optionValue);
          if (hit) onChange({ upn: hit.upn, name: hit.name });
        }}
      >
        {(hits.data ?? []).map((h) => (
          <Option key={h.upn} value={h.upn} text={`${h.name} (${h.upn})`}>
            {h.name} — {h.upn}
            {!h.synced && ' (not yet synced)'}
          </Option>
        ))}
      </Combobox>
      <Link
        onClick={() => {
          setManual(true);
          onChange(undefined);
        }}
      >
        Not listed?
      </Link>
    </div>
  );
}

/** Several people from the directory. */
function PeoplePicker({ base, value, onChange }: { base: string; value: SrPerson[]; onChange: (p: SrPerson[]) => void }) {
  const [adding, setAdding] = useState<SrPerson | undefined>();
  useEffect(() => {
    if (adding && adding.upn && adding.name && !value.some((p) => p.upn.toLowerCase() === adding.upn.toLowerCase())) {
      onChange([...value, adding]);
      setAdding(undefined);
    }
  }, [adding]);
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      {value.length > 0 && (
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          {value.map((p) => (
            <Badge key={p.upn} appearance="outline" size="large">
              {p.name}&nbsp;
              <Link aria-label={`Remove ${p.name}`} onClick={() => onChange(value.filter((x) => x.upn !== p.upn))}>
                ✕
              </Link>
            </Badge>
          ))}
        </div>
      )}
      <PersonPicker base={base} value={adding} onChange={setAdding} placeholder="Add a person" />
    </div>
  );
}

/** Where a call goes: a queue or auto attendant at the site, a person, voicemail, or disconnect. */
function TargetPicker({ base, options, value, onChange }: { base: string; options?: FormOptions; value?: SrTarget; onChange: (t: SrTarget | undefined) => void }) {
  const key = !value ? '' : value.kind === 'call_queue' || value.kind === 'auto_attendant' ? `${value.kind}:${value.id}` : value.kind;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <Select
        value={key}
        onChange={(_, d) => {
          const v = d.value;
          if (!v) return onChange(undefined);
          if (v === 'voicemail') return onChange({ kind: 'voicemail', label: 'Voicemail' });
          if (v === 'disconnect') return onChange({ kind: 'disconnect', label: 'Disconnect' });
          if (v === 'person') return onChange({ kind: 'person', label: '' });
          const [kind, id] = v.split(':') as ['call_queue' | 'auto_attendant', string];
          const list = kind === 'call_queue' ? options?.callQueues : options?.autoAttendants;
          const hit = list?.find((x) => x.id === id);
          onChange({ kind, id, label: hit ? `${hit.name} (${kind === 'call_queue' ? 'call queue' : 'auto attendant'})` : id });
        }}
      >
        <option value="">Choose…</option>
        <option value="voicemail">Voicemail</option>
        <option value="disconnect">Disconnect</option>
        <option value="person">A person…</option>
        {(options?.callQueues ?? []).map((q) => (
          <option key={q.id} value={`call_queue:${q.id}`}>
            Call queue: {q.name}
          </option>
        ))}
        {(options?.autoAttendants ?? []).map((a) => (
          <option key={a.id} value={`auto_attendant:${a.id}`}>
            Auto attendant: {a.name}
          </option>
        ))}
      </Select>
      {value?.kind === 'person' && (
        <PersonPicker
          base={base}
          value={value.upn ? { upn: value.upn, name: value.label } : undefined}
          onChange={(p) => onChange(p ? { kind: 'person', upn: p.upn, label: p.name } : { kind: 'person', label: '' })}
        />
      )}
    </div>
  );
}

/** Auto attendant key presses, each to a target. */
function MenuEditor({ base, options, value, onChange }: { base: string; options?: FormOptions; value: SrMenuOption[]; onChange: (m: SrMenuOption[]) => void }) {
  const used = new Set(value.map((o) => o.key));
  const nextKey = SR_MENU_KEYS.find((k) => !used.has(k));
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      {value.map((o, i) => (
        <div key={i} style={{ display: 'flex', gap: 8, alignItems: 'start', flexWrap: 'wrap' }}>
          <Select
            aria-label="Key"
            value={o.key}
            style={{ width: 90 }}
            onChange={(_, d) => onChange(value.map((x, j) => (j === i ? { ...x, key: d.value as SrMenuOption['key'] } : x)))}
          >
            {SR_MENU_KEYS.filter((k) => k === o.key || !used.has(k)).map((k) => (
              <option key={k} value={k}>
                Press {k}
              </option>
            ))}
          </Select>
          <div style={{ flex: 1, minWidth: 260 }}>
            <TargetPicker
              base={base}
              options={options}
              value={o.target}
              onChange={(t) => onChange(value.map((x, j) => (j === i ? { ...x, target: t ?? { kind: 'disconnect', label: 'Disconnect' } } : x)))}
            />
          </div>
          <Button appearance="subtle" onClick={() => onChange(value.filter((_, j) => j !== i))}>
            Remove
          </Button>
        </div>
      ))}
      {nextKey && (
        <div>
          <Button size="small" onClick={() => onChange([...value, { key: nextKey, target: { kind: 'disconnect', label: 'Disconnect' } }])}>
            Add a menu option
          </Button>
        </div>
      )}
    </div>
  );
}

function FieldInput({
  spec,
  value,
  onChange,
  base,
  options,
  siteChosen,
}: {
  spec: SrFieldSpec;
  value: unknown;
  onChange: (v: unknown) => void;
  base: string;
  options?: FormOptions;
  siteChosen: boolean;
}) {
  const [otherModel, setOtherModel] = useState(false);
  switch (spec.kind) {
    case 'textarea':
      return <Textarea value={(value as string) ?? ''} maxLength={spec.max} resize="vertical" onChange={(_, d) => onChange(d.value)} />;
    case 'number':
      return (
        <Input
          type="number"
          min={spec.min}
          max={spec.max}
          value={value === undefined ? '' : String(value)}
          onChange={(_, d) => onChange(d.value === '' ? undefined : Number(d.value))}
        />
      );
    case 'select':
      return (
        <Select value={(value as string) ?? ''} onChange={(_, d) => onChange(d.value || undefined)}>
          <option value="">Choose…</option>
          {(spec.options ?? []).map((o) => (
            <option key={o} value={o}>
              {o}
            </option>
          ))}
        </Select>
      );
    case 'boolean':
      return <Checkbox checked={!!value} label="Yes" onChange={(_, d) => onChange(!!d.checked)} />;
    case 'date':
      return <Input type="date" value={(value as string) ?? ''} onChange={(_, d) => onChange(d.value || undefined)} />;
    case 'person':
      return <PersonPicker base={base} value={value as SrPerson | undefined} onChange={onChange} />;
    case 'people':
      return <PeoplePicker base={base} value={(value as SrPerson[]) ?? []} onChange={onChange} />;
    case 'phone_number': {
      if (!siteChosen) return <Text size={200}>Choose the site first.</Text>;
      const list = spec.numberSource === 'available' ? (options?.availableNumbers ?? []) : (options?.siteNumbers ?? []);
      if (options && list.length === 0) {
        return (
          <Text size={200} style={{ color: tokens.colorPaletteRedForeground1 }}>
            {spec.numberSource === 'available'
              ? 'There are no free numbers at this site. Raise a "New phone numbers" request first, or keep an existing number.'
              : 'This site has no numbers recorded yet.'}
          </Text>
        );
      }
      return (
        <Select value={(value as string) ?? ''} onChange={(_, d) => onChange(d.value || undefined)}>
          <option value="">Choose a number…</option>
          {list.map((n) => (
            <option key={n} value={n}>
              {n}
            </option>
          ))}
        </Select>
      );
    }
    case 'target':
      return <TargetPicker base={base} options={options} value={value as SrTarget | undefined} onChange={onChange} />;
    case 'menu':
      return <MenuEditor base={base} options={options} value={(value as SrMenuOption[]) ?? []} onChange={onChange} />;
    case 'number_range': {
      const v = value as { id: string; label: string } | undefined;
      return (
        <Select
          value={v?.id ?? ''}
          disabled={!siteChosen}
          onChange={(_, d) => {
            const r = options?.ranges.find((x) => x.id === d.value);
            onChange(r ? { id: r.id, label: r.label } : undefined);
          }}
        >
          <option value="">A new range</option>
          {(options?.ranges ?? []).map((r) => (
            <option key={r.id} value={r.id}>
              {r.label}
            </option>
          ))}
        </Select>
      );
    }
    case 'device_model': {
      const models = options?.deviceModels ?? [];
      const known = !value || models.includes(value as string);
      if (models.length === 0 || otherModel || !known) {
        return (
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <Input value={(value as string) ?? ''} maxLength={120} placeholder="e.g. Poly CCX 400" onChange={(_, d) => onChange(d.value)} />
            {models.length > 0 && (
              <Link
                onClick={() => {
                  setOtherModel(false);
                  onChange(undefined);
                }}
              >
                Pick from the list
              </Link>
            )}
          </div>
        );
      }
      return (
        <Select
          value={(value as string) ?? ''}
          onChange={(_, d) => {
            if (d.value === '__other') {
              setOtherModel(true);
              onChange(undefined);
            } else onChange(d.value || undefined);
          }}
        >
          <option value="">Not sure yet</option>
          {models.map((m) => (
            <option key={m} value={m}>
              {m}
            </option>
          ))}
          <option value="__other">Another model…</option>
        </Select>
      );
    }
    case 'country':
      return (
        <Select value={(value as string) ?? ''} onChange={(_, d) => onChange(d.value || undefined)}>
          <option value="">Choose a country…</option>
          {COUNTRY_OPTIONS.map((c) => (
            <option key={c.code} value={c.code}>
              {c.name}
            </option>
          ))}
        </Select>
      );
    default:
      return <Input value={(value as string) ?? ''} maxLength={spec.max} onChange={(_, d) => onChange(d.value)} />;
  }
}

function isBlank(v: unknown) {
  return v === undefined || v === null || v === '' || (Array.isArray(v) && v.length === 0);
}

function NewRequestDialog({ base, sites, onClose, onCreated }: { base: string; sites: SiteOption[]; onClose: () => void; onCreated: (id: string) => void }) {
  const cs = useStyles();
  const qc = useQueryClient();
  const operational = sites.filter((s) => s.mode === 'operations');
  const [type, setType] = useState<SrType>('new_user');
  const [title, setTitle] = useState('');
  const [siteId, setSiteId] = useState(operational.length === 1 ? operational[0]!.id : '');
  const [priority, setPriority] = useState<SrPriority>('normal');
  const [targetDate, setTargetDate] = useState('');
  const [details, setDetails] = useState<Record<string, unknown>>({});
  const def = SR_TYPE_DEFS[type];
  const showSite = def.needsSite || type === 'other';

  const options = useQuery({
    queryKey: ['sr-options', base, siteId],
    queryFn: () => api<FormOptions>(`${base}/options${siteId ? `?siteId=${siteId}` : ''}`),
  });

  // A new number at a site: take the first free one, unless the person already picked a valid one.
  const free = options.data?.availableNumbers;
  useEffect(() => {
    if (details.number !== NUMBER_NEED_NEW || !siteId || !free) return;
    const current = details[SR_NEW_NUMBER_KEY] as string | undefined;
    if (current && free.includes(current)) return;
    setDetails((prev) => ({ ...prev, [SR_NEW_NUMBER_KEY]: free[0] }));
  }, [details.number, siteId, free]);

  const chooseSite = (id: string) => {
    setSiteId(id);
    // Numbers, ranges and queue/auto attendant picks belong to the old site.
    setDetails((prev) => {
      const next: Record<string, unknown> = { ...prev };
      for (const k of ['new_number', 'existing_number', 'range', 'unanswered', 'after_hours', 'menu']) delete next[k];
      return next;
    });
  };

  const create = useMutation({
    mutationFn: () =>
      api<{ id: string }>(base, {
        method: 'POST',
        body: JSON.stringify({ type, title, priority, siteId: showSite && siteId ? siteId : null, targetDate: targetDate || null, details }),
      }),
    onSuccess: (r) => {
      qc.invalidateQueries({ queryKey: ['service-requests'] });
      qc.invalidateQueries({ queryKey: ['sr-options'] });
      onCreated(r.id);
    },
  });

  const incomplete = useMemo(() => {
    const missing = def.fields.some((f) => f.required && srFieldVisible(f, details) && isBlank(details[f.key]));
    return missing || title.trim().length < 3 || (def.needsSite && !siteId);
  }, [def, details, title, siteId]);

  return (
    <Dialog open onOpenChange={(_, d) => !d.open && onClose()}>
      <DialogSurface style={{ maxWidth: '680px' }}>
        <DialogBody>
          <DialogTitle>New service request</DialogTitle>
          <DialogContent className={cs.stack}>
            <Field label="What do you need?" hint={def.description}>
              <Select
                value={type}
                onChange={(_, d) => {
                  setType(d.value as SrType);
                  setDetails({});
                }}
              >
                {SR_TYPES.map((t) => (
                  <option key={t} value={t}>
                    {SR_TYPE_DEFS[t].label}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Title" required hint="A short summary, e.g. New starter: Jo Bloggs">
              <Input value={title} maxLength={160} onChange={(_, d) => setTitle(d.value)} />
            </Field>
            {showSite && (
              <Field
                label="Site"
                required={def.needsSite}
                hint={operational.length === 0 ? 'None of your sites are in operations mode yet, so requests for a site are not open.' : 'Only sites in operations mode take service requests.'}
              >
                <Select value={siteId} onChange={(_, d) => chooseSite(d.value)}>
                  <option value="">{def.needsSite ? 'Choose a site…' : 'Not site-specific'}</option>
                  {sites.map((s) => (
                    <option key={s.id} value={s.id} disabled={s.mode !== 'operations'}>
                      {s.name ? `${s.sitecode} — ${s.name}` : s.sitecode}
                      {s.mode !== 'operations' ? ' (project mode)' : ''}
                    </option>
                  ))}
                </Select>
              </Field>
            )}
            {def.fields
              .filter((f) => srFieldVisible(f, details))
              .map((f) => (
                <Field key={f.key} label={f.label} required={f.required} hint={f.hint}>
                  <FieldInput
                    spec={f}
                    value={details[f.key]}
                    base={base}
                    options={options.data}
                    siteChosen={!!siteId}
                    onChange={(v) => setDetails((prev) => ({ ...prev, [f.key]: v }))}
                  />
                </Field>
              ))}
            <div className={cs.toolbar}>
              <Field label="Priority">
                <Select value={priority} onChange={(_, d) => setPriority(d.value as SrPriority)}>
                  {SR_PRIORITIES.map((p) => (
                    <option key={p} value={p}>
                      {PRIORITY_LABEL[p]}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="Needed by">
                <Input type="date" value={targetDate} onChange={(_, d) => setTargetDate(d.value)} />
              </Field>
            </div>
            {create.isError && <Text className={cs.error}>{errorText(create.error, 'Could not raise the request')}</Text>}
          </DialogContent>
          <DialogActions>
            <Button appearance="secondary" onClick={onClose}>
              Cancel
            </Button>
            <Button appearance="primary" disabled={incomplete || create.isPending} onClick={() => create.mutate()}>
              {create.isPending ? 'Raising…' : 'Raise request'}
            </Button>
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
}

/* ------------------------------ site modes ------------------------------ */

/** Engineers and admins: a site takes service requests only once it is in operations mode. */
function SiteModesDialog({ base, sites, onClose }: { base: string; sites: SiteOption[]; onClose: () => void }) {
  const qc = useQueryClient();
  const set = useMutation({
    mutationFn: ({ id, mode }: { id: string; mode: SiteMode }) => api(`${base}/sites/${id}/mode`, { method: 'PATCH', body: JSON.stringify({ mode }) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['service-request-sites'] }),
  });
  return (
    <Dialog open onOpenChange={(_, d) => !d.open && onClose()}>
      <DialogSurface style={{ maxWidth: '720px' }}>
        <DialogBody>
          <DialogTitle>Site modes</DialogTitle>
          <DialogContent>
            <Text block style={{ marginBottom: 12 }}>
              A site stays in <b>project</b> mode while it is being migrated. Move it to <b>operations</b> once it is live, and the customer can then raise
              service requests for it.
            </Text>
            {sites.length === 0 ? (
              <Text size={200}>No sites yet.</Text>
            ) : (
              <DataTable size="small" minWidth={520}>
                <TableHeader>
                  <TableRow>
                    <TableHeaderCell>Site</TableHeaderCell>
                    <TableHeaderCell>Mode</TableHeaderCell>
                    <TableHeaderCell>Last changed</TableHeaderCell>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {sites.map((s) => (
                    <TableRow key={s.id}>
                      <TableCell>{s.name ? `${s.sitecode} — ${s.name}` : s.sitecode}</TableCell>
                      <TableCell>
                        <Select size="small" value={s.mode} disabled={set.isPending} onChange={(_, d) => set.mutate({ id: s.id, mode: d.value as SiteMode })}>
                          {SITE_MODES.map((m) => (
                            <option key={m} value={m}>
                              {SITE_MODE_LABELS[m]}
                            </option>
                          ))}
                        </Select>
                      </TableCell>
                      <TableCell>{s.mode_changed_at ? `${when(s.mode_changed_at)}${s.mode_changed_by_name ? ` · ${s.mode_changed_by_name}` : ''}` : '—'}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </DataTable>
            )}
            {set.isError && <Text style={{ color: tokens.colorPaletteRedForeground1 }}>{errorText(set.error, 'Could not change the mode')}</Text>}
          </DialogContent>
          <DialogActions>
            <Button appearance="secondary" onClick={onClose}>
              Close
            </Button>
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
}

/* ------------------------------ one request ------------------------------ */

function RequestDialog({ base, id, onClose }: { base: string; id: string; onClose: () => void }) {
  const cs = useStyles();
  const qc = useQueryClient();
  const { can, me } = useAuth();
  const canManage = can('sr:manage');
  const [note, setNote] = useState('');
  const [comment, setComment] = useState('');
  const [internal, setInternal] = useState(false);

  const q = useQuery({
    queryKey: ['service-request', base, id],
    queryFn: () => api<{ request: RequestDetail; events: RequestEvent[] }>(`${base}/${id}`),
  });
  const assignees = useQuery({
    queryKey: ['service-request-assignees', base],
    enabled: canManage,
    queryFn: () => api<{ id: string; display_name: string }[]>(`${base}/assignees`),
  });

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ['service-request', base, id] });
    qc.invalidateQueries({ queryKey: ['service-requests'] });
  };
  const move = useMutation({
    mutationFn: (to: SrStatus) => api(`${base}/${id}/status`, { method: 'POST', body: JSON.stringify({ to, note: note.trim() || undefined }) }),
    onSuccess: () => {
      setNote('');
      refresh();
    },
  });
  const assign = useMutation({
    mutationFn: (userId: string | null) => api(`${base}/${id}/assign`, { method: 'POST', body: JSON.stringify({ userId }) }),
    onSuccess: refresh,
  });
  const addComment = useMutation({
    mutationFn: () => api(`${base}/${id}/comments`, { method: 'POST', body: JSON.stringify({ body: comment, internal: canManage && internal }) }),
    onSuccess: () => {
      setComment('');
      setInternal(false);
      refresh();
    },
  });

  const r = q.data?.request;
  const next = r ? nextSrStatus(r.status) : null;
  const canCancelOwn = !!r && r.status === 'new' && r.requested_by === me?.id;
  const actionError = move.error ?? assign.error ?? addComment.error;

  return (
    <Dialog open onOpenChange={(_, d) => !d.open && onClose()}>
      <DialogSurface style={{ maxWidth: '820px', width: '92vw' }}>
        <DialogBody>
          <DialogTitle>
            {r ? (
              <span className={cs.actions}>
                {r.reference} — {r.title}
                <Badge appearance="tint" color={STATUS_COLOR[r.status]}>
                  {SR_STATUS_LABELS[r.status]}
                </Badge>
              </span>
            ) : (
              'Service request'
            )}
          </DialogTitle>
          <DialogContent className={cs.stack} style={{ maxHeight: '72vh', overflowY: 'auto' }}>
            {q.isLoading && <Spinner size="tiny" />}
            {q.isError && <LoadError message={(q.error as Error).message} />}
            {r && (
              <>
                <div className={cs.facts}>
                  <Text className={cs.factLabel}>Type</Text>
                  <Text>{SR_TYPE_DEFS[r.type].label}</Text>
                  <Text className={cs.factLabel}>Site</Text>
                  <Text>{r.sitecode ? (r.site_name ? `${r.sitecode} — ${r.site_name}` : r.sitecode) : '—'}</Text>
                  <Text className={cs.factLabel}>Priority</Text>
                  <Text>{PRIORITY_LABEL[r.priority]}</Text>
                  <Text className={cs.factLabel}>Needed by</Text>
                  <Text>{r.target_date ?? '—'}</Text>
                  <Text className={cs.factLabel}>Raised by</Text>
                  <Text>
                    {r.requested_by_name ?? '—'} · {when(r.created_at)}
                  </Text>
                  <Text className={cs.factLabel}>Assigned to</Text>
                  {canManage && (r.status === 'new' || r.status === 'planned' || r.status === 'built') ? (
                    <Select size="small" value={r.assigned_to ?? ''} disabled={assign.isPending} onChange={(_, d) => assign.mutate(d.value || null)}>
                      <option value="">Unassigned</option>
                      {(assignees.data ?? []).map((a) => (
                        <option key={a.id} value={a.id}>
                          {a.display_name}
                        </option>
                      ))}
                    </Select>
                  ) : (
                    <Text>{r.assigned_to_name ?? 'Unassigned'}</Text>
                  )}
                </div>

                <div className={cs.section}>
                  <Text weight="semibold">Request details</Text>
                  <div className={cs.facts}>
                    {srDetailLines(r.type, r.details).map((l) => (
                      <FactRow key={l.label} label={l.label} value={l.value} />
                    ))}
                  </div>
                </div>

                {(canManage && (next || canMoveSr(r.status, 'cancelled'))) || canCancelOwn ? (
                  <div className={cs.section}>
                    <Text weight="semibold">Move this request on</Text>
                    <Field hint={canManage ? 'Optional. Included in the update emailed to the requester.' : undefined}>
                      <Textarea value={note} maxLength={4000} placeholder="Add a note (optional)" resize="vertical" onChange={(_, d) => setNote(d.value)} />
                    </Field>
                    <div className={cs.actions}>
                      {canManage && next && (
                        <Button appearance="primary" disabled={move.isPending} onClick={() => move.mutate(next)}>
                          Mark as {SR_STATUS_LABELS[next].toLowerCase()}
                        </Button>
                      )}
                      {(canManage || canCancelOwn) && canMoveSr(r.status, 'cancelled') && (
                        <Button disabled={move.isPending} onClick={() => move.mutate('cancelled')}>
                          Cancel request
                        </Button>
                      )}
                    </div>
                  </div>
                ) : null}

                <div className={cs.section}>
                  <Text weight="semibold">Timeline</Text>
                  {q.data!.events.map((e) => (
                    <div key={e.id} className={`${cs.event} ${e.internal ? cs.internal : ''}`}>
                      <Text size={200}>
                        <b>{e.author_name ?? 'Someone'}</b> · {when(e.created_at)}
                        {e.internal ? ' · internal note' : ''}
                      </Text>
                      <Text>{eventText(e)}</Text>
                    </div>
                  ))}
                </div>

                {can('sr:create') && (
                  <div className={cs.section}>
                    <Field label="Add a comment">
                      <Textarea value={comment} maxLength={4000} resize="vertical" onChange={(_, d) => setComment(d.value)} />
                    </Field>
                    <div className={cs.actions}>
                      {canManage && <Checkbox checked={internal} label="Internal note (the customer won't see it)" onChange={(_, d) => setInternal(!!d.checked)} />}
                      <Button disabled={!comment.trim() || addComment.isPending} onClick={() => addComment.mutate()}>
                        Add comment
                      </Button>
                    </div>
                  </div>
                )}
                {actionError && <Text className={cs.error}>{errorText(actionError, 'That did not work')}</Text>}
              </>
            )}
          </DialogContent>
          <DialogActions>
            <Button appearance="secondary" onClick={onClose}>
              Close
            </Button>
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
}

function FactRow({ label, value }: { label: string; value: string }) {
  const cs = useStyles();
  return (
    <>
      <Text className={cs.factLabel}>{label}</Text>
      <Text style={{ whiteSpace: 'pre-wrap' }}>{value}</Text>
    </>
  );
}

function eventText(e: RequestEvent): string {
  switch (e.kind) {
    case 'created':
      return 'Raised the request.';
    case 'status_changed': {
      const moved = `Moved from ${e.from_status ? SR_STATUS_LABELS[e.from_status] : '—'} to ${e.to_status ? SR_STATUS_LABELS[e.to_status] : '—'}.`;
      return e.body ? `${moved} ${e.body}` : moved;
    }
    case 'assigned':
      return e.body === 'Unassigned' ? 'Unassigned the request.' : `Assigned to ${e.body}.`;
    case 'comment':
      return e.body ?? '';
  }
}
