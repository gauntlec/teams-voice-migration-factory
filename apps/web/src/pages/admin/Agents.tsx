import { Fragment, useState } from 'react';
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
  Field,
  Input,
  Link,
  Select,
  Spinner,
  Tab,
  TabList,
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
  AGENT_ACTION_CLASSES,
  AGENT_ACTION_CLASS_LABELS,
  AGENT_KINDS,
  AGENT_KIND_LABELS,
  AGENT_LEVELS,
  AGENT_LEVEL_HELP,
  AGENT_LEVEL_LABELS,
  AGENT_SCOPES,
  AGENT_SCOPE_LABELS,
  AGENT_EVENT_KINDS,
  AGENT_DEFAULT_SCOPES,
  type AgentActionClass,
  type AgentKind,
  type AgentLevel,
  type AgentScope,
  type AgentStatus,
} from '@tvmf/shared';
import { api } from '../../api';
import { DataTable } from '../../components/DataTable';
import { Page } from '../../components/Page';
import { LoadError } from '../../components/records';
import { errorText, when } from '../ServiceRequests';

const useStyles = makeStyles({
  stack: { display: 'flex', flexDirection: 'column', rowGap: tokens.spacingVerticalM },
  muted: { color: tokens.colorNeutralForeground3 },
  error: { color: tokens.colorPaletteRedForeground1 },
  row: { display: 'flex', columnGap: tokens.spacingHorizontalS, flexWrap: 'wrap', alignItems: 'end' },
  kill: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', columnGap: tokens.spacingHorizontalM, rowGap: tokens.spacingVerticalS, ...shorthands.padding(tokens.spacingVerticalS, tokens.spacingHorizontalM), ...shorthands.borderRadius(tokens.borderRadiusMedium), ...shorthands.border('1px', 'solid', tokens.colorNeutralStroke2) },
  killOn: { ...shorthands.border('1px', 'solid', tokens.colorPaletteRedBorder1), backgroundColor: tokens.colorPaletteRedBackground1 },
  secret: { fontFamily: 'ui-monospace, Consolas, monospace', wordBreak: 'break-all', ...shorthands.padding(tokens.spacingVerticalS, tokens.spacingHorizontalM), ...shorthands.borderRadius(tokens.borderRadiusMedium), backgroundColor: tokens.colorNeutralBackground3 },
  levels: { display: 'grid', gridTemplateColumns: 'minmax(180px, 1.3fr) 150px', columnGap: tokens.spacingHorizontalS, rowGap: tokens.spacingVerticalXS, alignItems: 'center' },
});

interface AgentRow {
  id: string;
  name: string;
  kind: AgentKind;
  status: AgentStatus;
  description: string;
  model_label: string;
  msp_name: string | null;
  live_tokens: number;
  customers: number;
  last_seen_at: string | null;
}
interface AgentDetail {
  agent: AgentRow;
  tokens: { id: string; name: string; hint: string; scopes: AgentScope[]; ip_allow: string[]; expires_at: string | null; last_used_at: string | null; revoked_at: string | null; created_at: string }[];
  customers: { tenant_id: string; name: string; agents_enabled: boolean; allowed: boolean; enabled: boolean; autonomy: Record<AgentActionClass, AgentLevel> }[];
  webhooks: { id: string; url: string; kinds: string[]; active: boolean; failures: number; last_status: string | null; last_delivery_at: string | null }[];
  caps: Record<AgentActionClass, AgentLevel>;
}

const STATUS_COLOR: Record<AgentStatus, 'success' | 'warning' | 'subtle'> = { active: 'success', paused: 'warning', disabled: 'subtle' };

/**
 * Assistants (Super Admins): the AI agents that work incidents. Who they are, their tokens (shown once), which
 * customers they may work and how far on each kind of action, their webhooks, and the kill switches. See docs/AGENTS.md.
 */
export function AdminAgents() {
  const s = useStyles();
  const qc = useQueryClient();
  const [open, setOpen] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const list = useQuery({ queryKey: ['agents'], queryFn: () => api<AgentRow[]>('/agents') });
  const kill = useQuery({ queryKey: ['agents', 'kill-switch'], queryFn: () => api<{ all_disabled: boolean; note: string | null; changed_at: string | null }>('/agents/kill-switch') });
  const setKill = useMutation({
    mutationFn: (allDisabled: boolean) => api('/agents/kill-switch', { method: 'PUT', body: JSON.stringify({ allDisabled, note: allDisabled ? 'Switched off from the Assistants page' : undefined }) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['agents'] }),
  });

  return (
    <Page
      title="Assistants"
      subtitle="AI agents that work incidents alongside your engineers. Each has its own identity and tokens, is allowed on named customers only, and starts at suggest-only: a person approves anything it proposes."
      actions={
        <Button appearance="primary" onClick={() => setCreating(true)}>
          New assistant
        </Button>
      }
    >
      <div className={`${s.kill} ${kill.data?.all_disabled ? s.killOn : ''}`}>
        <Text>
          {kill.data?.all_disabled ? (
            <>
              <b>All assistants are switched off.</b> Every token is refused until you switch them back on.
            </>
          ) : (
            <>Assistants are on. In an emergency, switch every one of them off at once.</>
          )}
        </Text>
        <Button
          appearance={kill.data?.all_disabled ? 'primary' : 'secondary'}
          disabled={setKill.isPending || !kill.data}
          onClick={() => (kill.data?.all_disabled ? setKill.mutate(false) : window.confirm('Switch off every assistant on every customer?') && setKill.mutate(true))}
        >
          {kill.data?.all_disabled ? 'Switch assistants back on' : 'Switch all assistants off'}
        </Button>
      </div>
      {list.isError && <LoadError message={(list.error as Error).message} />}
      <Card>
        {list.isLoading ? (
          <Spinner size="tiny" />
        ) : (list.data ?? []).length === 0 ? (
          <Text>No assistants yet. Create one, give it a token, and allow it on a customer to let it start suggesting.</Text>
        ) : (
          <DataTable size="small" minWidth={820}>
            <TableHeader>
              <TableRow>
                <TableHeaderCell>Name</TableHeaderCell>
                <TableHeaderCell>Kind</TableHeaderCell>
                <TableHeaderCell>Status</TableHeaderCell>
                <TableHeaderCell>Customers</TableHeaderCell>
                <TableHeaderCell>Live tokens</TableHeaderCell>
                <TableHeaderCell>Last seen</TableHeaderCell>
              </TableRow>
            </TableHeader>
            <TableBody>
              {list.data!.map((a) => (
                <TableRow key={a.id} onClick={() => setOpen(a.id)} style={{ cursor: 'pointer' }}>
                  <TableCell>
                    <Link onClick={() => setOpen(a.id)}>{a.name}</Link>
                    {a.model_label && (
                      <Text size={100} block className={s.muted}>
                        {a.model_label}
                      </Text>
                    )}
                  </TableCell>
                  <TableCell>{AGENT_KIND_LABELS[a.kind]}</TableCell>
                  <TableCell>
                    <Badge appearance="tint" color={STATUS_COLOR[a.status]}>
                      {a.status[0]!.toUpperCase() + a.status.slice(1)}
                    </Badge>
                  </TableCell>
                  <TableCell>{a.customers}</TableCell>
                  <TableCell>{a.live_tokens}</TableCell>
                  <TableCell>{a.last_seen_at ? when(a.last_seen_at) : 'Never'}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </DataTable>
        )}
      </Card>
      {creating && (
        <CreateDialog
          onClose={() => setCreating(false)}
          onCreated={(id) => {
            setCreating(false);
            qc.invalidateQueries({ queryKey: ['agents'] });
            setOpen(id);
          }}
        />
      )}
      {open && <AgentDialog id={open} onClose={() => setOpen(null)} />}
    </Page>
  );
}

function CreateDialog({ onClose, onCreated }: { onClose: () => void; onCreated: (id: string) => void }) {
  const s = useStyles();
  const [name, setName] = useState('');
  const [kind, setKind] = useState<AgentKind>('triage');
  const [description, setDescription] = useState('');
  const [modelLabel, setModelLabel] = useState('');
  const create = useMutation({ mutationFn: () => api<{ id: string }>('/agents', { method: 'POST', body: JSON.stringify({ name, kind, description, modelLabel }) }), onSuccess: (r) => onCreated(r.id) });
  return (
    <Dialog open onOpenChange={(_, d) => !d.open && onClose()}>
      <DialogSurface style={{ maxWidth: '520px' }}>
        <DialogBody>
          <DialogTitle>New assistant</DialogTitle>
          <DialogContent className={s.stack}>
            <Field label="Name" required hint="Shown to your engineers as 'Name (AI)'. Customers only ever see 'Voxshift assistant'.">
              <Input value={name} maxLength={60} onChange={(_, d) => setName(d.value)} />
            </Field>
            <Field label="What it is for">
              <Select value={kind} onChange={(_, d) => setKind(d.value as AgentKind)}>
                {AGENT_KINDS.map((k) => (
                  <option key={k} value={k}>
                    {AGENT_KIND_LABELS[k]}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Description">
              <Textarea value={description} maxLength={500} rows={2} onChange={(_, d) => setDescription(d.value)} />
            </Field>
            <Field label="Model or runbook (for people)">
              <Input value={modelLabel} maxLength={120} placeholder="e.g. Claude Sonnet 5.5, triage runbook v2" onChange={(_, d) => setModelLabel(d.value)} />
            </Field>
            {create.error && <Text className={s.error}>{errorText(create.error, 'Could not create it')}</Text>}
          </DialogContent>
          <DialogActions>
            <Button appearance="secondary" onClick={onClose}>
              Cancel
            </Button>
            <Button appearance="primary" disabled={name.trim().length < 2 || create.isPending} onClick={() => create.mutate()}>
              Create
            </Button>
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
}

function AgentDialog({ id, onClose }: { id: string; onClose: () => void }) {
  const s = useStyles();
  const qc = useQueryClient();
  const [tab, setTab] = useState<'overview' | 'tokens' | 'customers' | 'webhooks'>('overview');
  const q = useQuery({ queryKey: ['agents', id], queryFn: () => api<AgentDetail>(`/agents/${id}`) });
  const refresh = () => {
    qc.invalidateQueries({ queryKey: ['agents'] });
    qc.invalidateQueries({ queryKey: ['agents', id] });
  };
  const status = useMutation({ mutationFn: (st: AgentStatus) => api(`/agents/${id}`, { method: 'PATCH', body: JSON.stringify({ status: st }) }), onSuccess: refresh });
  const a = q.data?.agent;
  return (
    <Dialog open onOpenChange={(_, d) => !d.open && onClose()}>
      <DialogSurface style={{ maxWidth: '900px', width: '95vw' }}>
        <DialogBody>
          <DialogTitle>{a ? a.name : 'Assistant'}</DialogTitle>
          <DialogContent className={s.stack} style={{ maxHeight: '72vh', overflowY: 'auto' }}>
            {q.isLoading && <Spinner size="tiny" />}
            {q.isError && <LoadError message={(q.error as Error).message} />}
            {q.data && a && (
              <>
                <TabList selectedValue={tab} onTabSelect={(_, d) => setTab(d.value as typeof tab)}>
                  <Tab value="overview">Overview</Tab>
                  <Tab value="tokens">Tokens ({q.data.tokens.filter((t) => !t.revoked_at).length})</Tab>
                  <Tab value="customers">Customers ({q.data.customers.filter((c) => c.enabled).length})</Tab>
                  <Tab value="webhooks">Webhooks ({q.data.webhooks.length})</Tab>
                </TabList>
                {tab === 'overview' && (
                  <div className={s.stack}>
                    <div className={s.row}>
                      <Badge appearance="tint" color={STATUS_COLOR[a.status]}>
                        {a.status}
                      </Badge>
                      <Text>
                        {AGENT_KIND_LABELS[a.kind]}
                        {a.model_label ? ` · ${a.model_label}` : ''}
                      </Text>
                    </div>
                    {a.description && <Text>{a.description}</Text>}
                    <Text size={200} className={s.muted}>
                      Last seen {a.last_seen_at ? when(a.last_seen_at) : 'never'}. <b>Paused</b>: it can read, but every change is refused. <b>Disabled</b>: its tokens stop working.
                    </Text>
                    <div className={s.row}>
                      {a.status !== 'active' && <Button appearance="primary" disabled={status.isPending} onClick={() => status.mutate('active')}>Resume</Button>}
                      {a.status === 'active' && <Button disabled={status.isPending} onClick={() => status.mutate('paused')}>Pause</Button>}
                      {a.status !== 'disabled' && <Button disabled={status.isPending} onClick={() => window.confirm(`Disable ${a.name}? Its tokens stop working.`) && status.mutate('disabled')}>Disable</Button>}
                    </div>
                    {status.error && <Text className={s.error}>{errorText(status.error, 'Could not change it')}</Text>}
                  </div>
                )}
                {tab === 'tokens' && <TokensTab id={id} data={q.data} onChanged={refresh} />}
                {tab === 'customers' && <CustomersTab id={id} data={q.data} onChanged={refresh} />}
                {tab === 'webhooks' && <WebhooksTab id={id} data={q.data} onChanged={refresh} />}
              </>
            )}
          </DialogContent>
          <DialogActions>
            <Button appearance="primary" onClick={onClose}>
              Close
            </Button>
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
}

function TokensTab({ id, data, onChanged }: { id: string; data: AgentDetail; onChanged: () => void }) {
  const s = useStyles();
  const [name, setName] = useState('');
  const [scopes, setScopes] = useState<AgentScope[]>(AGENT_DEFAULT_SCOPES);
  const [days, setDays] = useState('90');
  const [ips, setIps] = useState('');
  const [fresh, setFresh] = useState<{ token: string; name: string } | null>(null);
  const create = useMutation({
    mutationFn: () => api<{ token: string; name: string }>(`/agents/${id}/tokens`, { method: 'POST', body: JSON.stringify({ name, scopes, expiresInDays: Number(days) || 90, ipAllow: ips.split(/[\s,]+/).filter(Boolean) }) }),
    onSuccess: (r) => {
      setFresh({ token: r.token, name: r.name });
      setName('');
      onChanged();
    },
  });
  const revoke = useMutation({ mutationFn: (tid: string) => api(`/agents/${id}/tokens/${tid}`, { method: 'DELETE' }), onSuccess: onChanged });
  return (
    <div className={s.stack}>
      {fresh && (
        <div className={s.stack}>
          <Text weight="semibold">Token &ldquo;{fresh.name}&rdquo; - copy it now, it is not shown again</Text>
          <div className={s.secret}>{fresh.token}</div>
          <div className={s.row}>
            <Button size="small" onClick={() => navigator.clipboard?.writeText(fresh.token)}>
              Copy
            </Button>
            <Button size="small" appearance="subtle" onClick={() => setFresh(null)}>
              I have saved it
            </Button>
          </div>
        </div>
      )}
      <DataTable size="small" minWidth={640}>
        <TableHeader>
          <TableRow>
            <TableHeaderCell>Name</TableHeaderCell>
            <TableHeaderCell>Token</TableHeaderCell>
            <TableHeaderCell>Can</TableHeaderCell>
            <TableHeaderCell>Expires</TableHeaderCell>
            <TableHeaderCell>Last used</TableHeaderCell>
            <TableHeaderCell />
          </TableRow>
        </TableHeader>
        <TableBody>
          {data.tokens.map((t) => (
            <TableRow key={t.id}>
              <TableCell>{t.name}</TableCell>
              <TableCell>
                <code>{t.hint}</code>
              </TableCell>
              <TableCell>{t.scopes.join(', ')}</TableCell>
              <TableCell>{t.revoked_at ? <Badge appearance="tint" color="subtle">Revoked</Badge> : t.expires_at ? new Date(t.expires_at).toLocaleDateString() : 'Never'}</TableCell>
              <TableCell>{t.last_used_at ? when(t.last_used_at) : 'Never'}</TableCell>
              <TableCell>{!t.revoked_at && <Button size="small" disabled={revoke.isPending} onClick={() => window.confirm('Revoke this token? The agent using it stops working immediately.') && revoke.mutate(t.id)}>Revoke</Button>}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </DataTable>
      <Text weight="semibold">New token</Text>
      <div className={s.row}>
        <Field label="Name">
          <Input value={name} maxLength={60} placeholder="e.g. Triage runner" onChange={(_, d) => setName(d.value)} />
        </Field>
        <Field label="Expires in (days)">
          <Input type="number" min={1} max={365} style={{ width: 100 }} value={days} onChange={(_, d) => setDays(d.value)} />
        </Field>
        <Field label="Only from these addresses (optional)">
          <Input value={ips} placeholder="203.0.113.7, 198.51.100.0/24" onChange={(_, d) => setIps(d.value)} />
        </Field>
      </div>
      <div className={s.row}>
        {AGENT_SCOPES.map((sc) => (
          <Checkbox key={sc} label={AGENT_SCOPE_LABELS[sc]} checked={scopes.includes(sc)} onChange={(_, d) => setScopes(d.checked ? [...scopes, sc] : scopes.filter((x) => x !== sc))} />
        ))}
      </div>
      <div>
        <Button appearance="primary" disabled={name.trim().length < 2 || scopes.length === 0 || create.isPending} onClick={() => create.mutate()}>
          Create token
        </Button>
      </div>
      {create.error && <Text className={s.error}>{errorText(create.error, 'Could not create it')}</Text>}
    </div>
  );
}

function CustomersTab({ id, data, onChanged }: { id: string; data: AgentDetail; onChanged: () => void }) {
  const s = useStyles();
  const [editing, setEditing] = useState<string | null>(null);
  return (
    <div className={s.stack}>
      <Text size={200} className={s.muted}>
        An assistant can only work the customers you allow here. New customers start at <b>Suggest</b> (it adds notes and proposes; a person approves). Customer-facing text and deployments can never go above &ldquo;Act with approval&rdquo;.
      </Text>
      {data.customers.length === 0 && <Text>No customers have Managed Services switched on.</Text>}
      {data.customers.map((c) => (
        <Card key={c.tenant_id}>
          <div className={s.row} style={{ justifyContent: 'space-between' }}>
            <div>
              <Text weight="semibold">{c.name}</Text>{' '}
              {c.allowed && (
                <Badge appearance="tint" color={c.enabled ? 'success' : 'subtle'}>
                  {c.enabled ? 'Allowed' : 'Switched off here'}
                </Badge>
              )}
              {!c.agents_enabled && (
                <Badge appearance="tint" color="warning" style={{ marginLeft: 4 }} title="Every assistant is switched off on this customer">
                  Assistants off for this customer
                </Badge>
              )}
            </div>
            <Button size="small" onClick={() => setEditing(editing === c.tenant_id ? null : c.tenant_id)}>
              {editing === c.tenant_id ? 'Close' : c.allowed ? 'Edit' : 'Allow'}
            </Button>
          </div>
          {editing === c.tenant_id && <PolicyEditor agentId={id} customer={c} caps={data.caps} onDone={() => (setEditing(null), onChanged())} />}
        </Card>
      ))}
    </div>
  );
}

function PolicyEditor({ agentId, customer, caps, onDone }: { agentId: string; customer: AgentDetail['customers'][number]; caps: Record<AgentActionClass, AgentLevel>; onDone: () => void }) {
  const s = useStyles();
  const qc = useQueryClient();
  const [enabled, setEnabled] = useState(customer.allowed ? customer.enabled : true);
  const [levels, setLevels] = useState<Record<AgentActionClass, AgentLevel>>(customer.autonomy);
  const save = useMutation({ mutationFn: () => api(`/agents/${agentId}/policies/${customer.tenant_id}`, { method: 'PUT', body: JSON.stringify({ enabled, autonomy: levels }) }), onSuccess: onDone });
  const remove = useMutation({ mutationFn: () => api(`/agents/${agentId}/policies/${customer.tenant_id}`, { method: 'DELETE' }), onSuccess: onDone });
  const tenantSwitch = useMutation({ mutationFn: (on: boolean) => api(`/agents/customers/${customer.tenant_id}`, { method: 'PUT', body: JSON.stringify({ enabled: on }) }), onSuccess: () => (qc.invalidateQueries({ queryKey: ['agents'] }), onDone()) });
  return (
    <div className={s.stack} style={{ marginTop: 12 }}>
      <Checkbox checked={enabled} label="Allowed on this customer" onChange={(_, d) => setEnabled(!!d.checked)} />
      <div className={s.levels}>
        {AGENT_ACTION_CLASSES.map((cls) => (
          <Fragment key={cls}>
            <Text>{AGENT_ACTION_CLASS_LABELS[cls]}</Text>
            <Select size="small" value={String(levels[cls])} onChange={(_, d) => setLevels({ ...levels, [cls]: Number(d.value) as AgentLevel })} title={AGENT_LEVEL_HELP[levels[cls]]}>
              {AGENT_LEVELS.filter((l) => l <= caps[cls]).map((l) => (
                <option key={l} value={l}>
                  {l} · {AGENT_LEVEL_LABELS[l]}
                </option>
              ))}
            </Select>
          </Fragment>
        ))}
      </div>
      <Text size={200} className={s.muted}>
        {AGENT_LEVELS.map((l) => `${l} ${AGENT_LEVEL_LABELS[l]}: ${AGENT_LEVEL_HELP[l]}`).join('  ')}
      </Text>
      <div className={s.row}>
        <Button appearance="primary" disabled={save.isPending} onClick={() => save.mutate()}>
          Save
        </Button>
        {customer.allowed && (
          <Button disabled={remove.isPending} onClick={() => window.confirm('Remove this assistant from the customer?') && remove.mutate()}>
            Remove from this customer
          </Button>
        )}
        <Button disabled={tenantSwitch.isPending} onClick={() => tenantSwitch.mutate(!customer.agents_enabled)}>
          {customer.agents_enabled ? 'Switch every assistant off for this customer' : 'Switch assistants back on for this customer'}
        </Button>
      </div>
      {(save.error ?? remove.error ?? tenantSwitch.error) && <Text className={s.error}>{errorText(save.error ?? remove.error ?? tenantSwitch.error, 'That did not work')}</Text>}
    </div>
  );
}

function WebhooksTab({ id, data, onChanged }: { id: string; data: AgentDetail; onChanged: () => void }) {
  const s = useStyles();
  const [url, setUrl] = useState('');
  const [kinds, setKinds] = useState<string[]>([]);
  const [fresh, setFresh] = useState<{ url: string; secret: string } | null>(null);
  const create = useMutation({
    mutationFn: () => api<{ secret: string; url: string }>(`/agents/${id}/webhooks`, { method: 'POST', body: JSON.stringify({ url, kinds }) }),
    onSuccess: (r) => {
      setFresh({ url: r.url, secret: r.secret });
      setUrl('');
      setKinds([]);
      onChanged();
    },
  });
  const toggle = useMutation({ mutationFn: (v: { wid: string; active: boolean }) => api(`/agents/${id}/webhooks/${v.wid}`, { method: 'PATCH', body: JSON.stringify({ active: v.active }) }), onSuccess: onChanged });
  const remove = useMutation({ mutationFn: (wid: string) => api(`/agents/${id}/webhooks/${wid}`, { method: 'DELETE' }), onSuccess: onChanged });
  return (
    <div className={s.stack}>
      <Text size={200} className={s.muted}>
        Events are sent to the address, signed, at least once and in order. Verify <code>X-Voxshift-Signature</code> = sha256 HMAC of <code>timestamp.body</code> with the secret. After 12 failures in a row a webhook switches itself off.
      </Text>
      {fresh && (
        <div className={s.stack}>
          <Text weight="semibold">Signing secret for {fresh.url} - copy it now, it is not shown again</Text>
          <div className={s.secret}>{fresh.secret}</div>
          <div>
            <Button size="small" onClick={() => setFresh(null)}>
              I have saved it
            </Button>
          </div>
        </div>
      )}
      {data.webhooks.length > 0 && (
        <DataTable size="small" minWidth={640}>
          <TableHeader>
            <TableRow>
              <TableHeaderCell>Address</TableHeaderCell>
              <TableHeaderCell>Events</TableHeaderCell>
              <TableHeaderCell>Status</TableHeaderCell>
              <TableHeaderCell>Last delivery</TableHeaderCell>
              <TableHeaderCell />
            </TableRow>
          </TableHeader>
          <TableBody>
            {data.webhooks.map((w) => (
              <TableRow key={w.id}>
                <TableCell>{w.url}</TableCell>
                <TableCell>{w.kinds.length ? w.kinds.join(', ') : 'All'}</TableCell>
                <TableCell>
                  <Badge appearance="tint" color={w.active ? 'success' : 'danger'}>
                    {w.active ? 'On' : 'Off'}
                  </Badge>
                  {w.failures > 0 && <Text size={100} block>{w.failures} failure(s): {w.last_status}</Text>}
                </TableCell>
                <TableCell>{w.last_delivery_at ? when(w.last_delivery_at) : '—'}</TableCell>
                <TableCell>
                  <Button size="small" onClick={() => toggle.mutate({ wid: w.id, active: !w.active })}>
                    {w.active ? 'Switch off' : 'Switch on'}
                  </Button>{' '}
                  <Button size="small" onClick={() => window.confirm('Remove this webhook?') && remove.mutate(w.id)}>
                    Remove
                  </Button>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </DataTable>
      )}
      <Text weight="semibold">New webhook</Text>
      <Field label="Address" hint="https:// only (http is accepted for localhost, for development)">
        <Input value={url} placeholder="https://agent.example.com/voxshift" onChange={(_, d) => setUrl(d.value)} />
      </Field>
      <Field label="Only these events (none ticked = all)">
        <div className={s.row}>
          {AGENT_EVENT_KINDS.map((k) => (
            <Checkbox key={k} label={k} checked={kinds.includes(k)} onChange={(_, d) => setKinds(d.checked ? [...kinds, k] : kinds.filter((x) => x !== k))} />
          ))}
        </div>
      </Field>
      <div>
        <Button appearance="primary" disabled={!url.trim() || create.isPending} onClick={() => create.mutate()}>
          Add webhook
        </Button>
      </div>
      {(create.error ?? toggle.error ?? remove.error) && <Text className={s.error}>{errorText(create.error ?? toggle.error ?? remove.error, 'That did not work')}</Text>}
    </div>
  );
}
