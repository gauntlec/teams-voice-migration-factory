import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Badge, Button, Card, Dialog, DialogActions, DialogBody, DialogContent, DialogSurface, DialogTitle, Field, Input, Select, Spinner, Switch, TableBody, TableCell, TableHeader, TableHeaderCell, TableRow, Text, makeStyles, mergeClasses, tokens } from '@fluentui/react-components';
import { DEVICE_CHECK_LABEL, DEVICE_KINDS, DEVICE_KIND_LABEL, type DeviceCheckType, type DeviceInventoryRow, type DeviceKind, type DeviceState, type DeviceStatusOverview } from '@tvmf/shared';
import { api, ApiError } from '../../api';
import { DataTable } from '../../components/DataTable';
import { LoadError } from '../../components/records';
import { EmptyState } from '../../components/states';
import { DangerText, MutedText } from '../../components/ui';
import { useNotify } from '../../hooks/useNotify';

const useStyles = makeStyles({
  page: { display: 'grid', rowGap: '16px' },
  head: { display: 'flex', alignItems: 'center', columnGap: '10px', flexWrap: 'wrap' },
  tiles: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(190px, 1fr))', gap: '12px' },
  tile: { display: 'grid', rowGap: '4px', padding: '12px 14px', borderLeftWidth: '4px', borderLeftStyle: 'solid' },
  tileTop: { display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', columnGap: '8px' },
  up: { borderLeftColor: tokens.colorPaletteGreenBorderActive },
  down: { borderLeftColor: tokens.colorPaletteRedBorderActive },
  pending: { borderLeftColor: tokens.colorPaletteYellowBorderActive },
  maintenance: { borderLeftColor: tokens.colorPaletteBlueBorderActive },
  unknown: { borderLeftColor: tokens.colorNeutralStroke1 },
  section: { display: 'grid', rowGap: '8px' },
  banner: { padding: '10px 14px', display: 'flex', flexDirection: 'row', columnGap: '10px', alignItems: 'center', flexWrap: 'wrap' },
  form: { display: 'grid', rowGap: '12px', maxWidth: '520px', padding: '16px' },
  actions: { display: 'flex', columnGap: '8px' },
  rowActions: { display: 'flex', columnGap: '4px' },
  dialogForm: { display: 'grid', rowGap: '12px' },
  twoCol: { display: 'grid', gridTemplateColumns: '1fr 1fr', columnGap: '12px' },
});

const STATE: Record<DeviceState, { label: string; color: 'success' | 'danger' | 'warning' | 'informative' | 'subtle' }> = {
  up: { label: 'Up', color: 'success' },
  down: { label: 'Down', color: 'danger' },
  pending: { label: 'Checking', color: 'warning' },
  maintenance: { label: 'Maintenance', color: 'informative' },
  unknown: { label: 'No data', color: 'subtle' },
};

/** "3 min", "2 h 5 min", "4 d": how long ago, for a time that is shown next to what happened. */
export function ago(iso: string, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  if (s < 90) return `${s} s`;
  const m = Math.round(s / 60);
  if (m < 120) return `${m} min`;
  const h = Math.floor(m / 60);
  if (h < 48) return m % 60 === 0 ? `${h} h` : `${h} h ${m % 60} min`;
  return `${Math.round(h / 24)} d`;
}

function StateBadge({ state }: { state: DeviceState }) {
  return (
    <Badge appearance="tint" color={STATE[state].color}>
      {STATE[state].label}
    </Badge>
  );
}


const SYNC: Record<DeviceInventoryRow['syncState'], { label: string; color: 'success' | 'warning' | 'danger' }> = {
  synced: { label: 'Being watched', color: 'success' },
  pending: { label: 'Setting up', color: 'warning' },
  error: { label: 'Problem', color: 'danger' },
};

interface DeviceForm { siteCode: string; name: string; kind: DeviceKind; checkType: DeviceCheckType; address: string; port: string }
const emptyForm = (siteCode: string): DeviceForm => ({ siteCode, name: '', kind: 'other', checkType: 'ping', address: '', port: '' });

/** Add or change a device. Voxshift makes the Kuma monitor from this; nobody opens Kuma. */
function DeviceDialog({ base, sites, device, onClose }: { base: string; sites: Array<{ sitecode: string; name: string | null }>; device: DeviceInventoryRow | null; onClose: () => void }) {
  const s = useStyles();
  const qc = useQueryClient();
  const notify = useNotify();
  const [f, setF] = useState<DeviceForm>(
    device ? { siteCode: device.siteCode, name: device.name, kind: device.kind, checkType: device.checkType, address: device.address, port: device.port ? String(device.port) : '' } : emptyForm(sites[0]?.sitecode ?? ''),
  );
  const [error, setError] = useState<string | null>(null);
  const save = useMutation({
    mutationFn: () => {
      const body = JSON.stringify({ siteCode: f.siteCode, name: f.name, kind: f.kind, checkType: f.checkType, address: f.address, port: f.checkType === 'port' && f.port ? Number(f.port) : null });
      return device ? api(`${base}/devices/${device.id}`, { method: 'PUT', body }) : api(`${base}/devices`, { method: 'POST', body });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['device-status', base] });
      notify(device ? 'Device changed' : 'Device added', { body: 'Voxshift sets it up in Kuma within about 15 seconds.' });
      onClose();
    },
    onError: (e) => setError(e instanceof ApiError ? e.message : (e as Error).message),
  });
  const set = (patch: Partial<DeviceForm>) => { setError(null); setF({ ...f, ...patch }); };
  return (
    <Dialog open onOpenChange={(_, d) => !d.open && onClose()}>
      <DialogSurface>
        <DialogBody>
          <DialogTitle>{device ? 'Change device' : 'Add a device'}</DialogTitle>
          <DialogContent className={s.dialogForm}>
            <Field label="Site" required>
              <Select value={f.siteCode} onChange={(_, d) => set({ siteCode: d.value })}>
                {sites.map((x) => (
                  <option key={x.sitecode} value={x.sitecode}>
                    {x.sitecode}
                    {x.name ? ` · ${x.name}` : ''}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Name" required hint="What people call it, for example Reception door paging.">
              <Input value={f.name} onChange={(_, d) => set({ name: d.value })} />
            </Field>
            <div className={s.twoCol}>
              <Field label="Type of device">
                <Select value={f.kind} onChange={(_, d) => set({ kind: d.value as DeviceKind })}>
                  {DEVICE_KINDS.map((k) => (
                    <option key={k} value={k}>
                      {DEVICE_KIND_LABEL[k]}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="How to check it" hint={f.checkType === 'ping' ? 'Does it answer a ping?' : 'Is this TCP port open?'}>
                <Select value={f.checkType} onChange={(_, d) => set({ checkType: d.value as DeviceCheckType })}>
                  {(Object.keys(DEVICE_CHECK_LABEL) as DeviceCheckType[]).map((k) => (
                    <option key={k} value={k}>
                      {DEVICE_CHECK_LABEL[k]}
                    </option>
                  ))}
                </Select>
              </Field>
            </div>
            <div className={s.twoCol}>
              <Field label="IP address or host name" required>
                <Input value={f.address} onChange={(_, d) => set({ address: d.value })} placeholder="10.20.30.40" />
              </Field>
              {f.checkType === 'port' && (
                <Field label="Port" required>
                  <Input value={f.port} inputMode="numeric" onChange={(_, d) => set({ port: d.value.replace(/\D/g, '') })} placeholder="5060" />
                </Field>
              )}
            </div>
            {error && <DangerText size={200}>{error}</DangerText>}
          </DialogContent>
          <DialogActions>
            <Button onClick={onClose}>Cancel</Button>
            <Button appearance="primary" onClick={() => save.mutate()} disabled={save.isPending || !f.siteCode || !f.name || !f.address}>
              {device ? 'Save' : 'Add device'}
            </Button>
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
}

/** The devices Voxshift watches (it makes the Kuma monitors from this list). */
function DeviceList({ base, data, canManage }: { base: string; data: DeviceStatusOverview; canManage: boolean }) {
  const s = useStyles();
  const qc = useQueryClient();
  const notify = useNotify();
  const [dialog, setDialog] = useState<{ device: DeviceInventoryRow | null } | null>(null);
  const remove = useMutation({
    mutationFn: (id: string) => api(`${base}/devices/${id}`, { method: 'DELETE' }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['device-status', base] }); notify('Device removed', { body: 'Voxshift stops watching it within about 15 seconds.' }); },
    onError: (e) => notify('Could not remove it', { intent: 'error', body: (e as Error).message }),
  });
  const sites = data.siteOptions;
  return (
    <div className={s.section}>
      <div className={s.head}>
        <Text weight="semibold">Devices to watch</Text>
        {canManage && (
          <Button size="small" appearance="primary" onClick={() => setDialog({ device: null })} disabled={sites.length === 0}>
            Add a device
          </Button>
        )}
        {sites.length === 0 && <MutedText size={200}>Add a site in Data Collection first.</MutedText>}
      </div>
      {!data.managed.managed && data.inventory.length > 0 && <MutedText size={200}>Voxshift is not looking after Kuma, so these are only a list until it is switched on.</MutedText>}
      {data.inventory.length === 0 ? (
        <MutedText size={200}>No devices yet. Add each phone, paging unit or gateway and Voxshift sets up the checking.</MutedText>
      ) : (
        <DataTable size="small" minWidth={760}>
          <TableHeader>
            <TableRow>
              <TableHeaderCell>Device</TableHeaderCell>
              <TableHeaderCell>Site</TableHeaderCell>
              <TableHeaderCell>Type</TableHeaderCell>
              <TableHeaderCell>Check</TableHeaderCell>
              <TableHeaderCell>In Kuma</TableHeaderCell>
              {canManage && <TableHeaderCell />}
            </TableRow>
          </TableHeader>
          <TableBody>
            {data.inventory.map((d) => (
              <TableRow key={d.id}>
                <TableCell>{d.name}</TableCell>
                <TableCell>{d.siteCode}</TableCell>
                <TableCell>{DEVICE_KIND_LABEL[d.kind]}</TableCell>
                <TableCell>
                  {DEVICE_CHECK_LABEL[d.checkType]} {d.address}
                  {d.port ? `:${d.port}` : ''}
                </TableCell>
                <TableCell title={d.syncError ?? undefined}>
                  <Badge appearance="tint" color={SYNC[d.syncState].color}>
                    {SYNC[d.syncState].label}
                  </Badge>
                  {d.syncError && <MutedText size={200}> {d.syncError}</MutedText>}
                </TableCell>
                {canManage && (
                  <TableCell>
                    <div className={s.rowActions}>
                      <Button size="small" appearance="subtle" onClick={() => setDialog({ device: d })}>
                        Change
                      </Button>
                      <Button size="small" appearance="subtle" onClick={() => remove.mutate(d.id)} disabled={remove.isPending}>
                        Remove
                      </Button>
                    </div>
                  </TableCell>
                )}
              </TableRow>
            ))}
          </TableBody>
        </DataTable>
      )}
      {dialog && <DeviceDialog base={base} sites={sites} device={dialog.device} onClose={() => setDialog(null)} />}
    </div>
  );
}

/** Voxshift looks after Kuma: a plain status line, a way to give it Kuma's sign-in when Kuma already has an administrator, and a way to hand Kuma back. */
function ManagedPanel({ base, data, canManage }: { base: string; data: DeviceStatusOverview; canManage: boolean }) {
  const s = useStyles();
  const qc = useQueryClient();
  const notify = useNotify();
  const [user, setUser] = useState('');
  const [pass, setPass] = useState('');
  const m = data.managed;
  const needsLogin = !!m.lastSyncError && /administrator/i.test(m.lastSyncError);
  const retry = useMutation({
    mutationFn: () => api<DeviceStatusOverview>(`${base}/auto-setup`, { method: 'POST', body: JSON.stringify({ adminUser: user, adminPassword: pass }) }),
    onSuccess: (d) => { qc.setQueryData(['device-status', base], d); setPass(''); notify('Saved', { body: 'Voxshift will try again now.' }); },
    onError: (e) => notify('Could not save', { intent: 'error', body: (e as Error).message }),
  });
  const stop = useMutation({
    mutationFn: () => api<DeviceStatusOverview>(`${base}/auto-setup`, { method: 'DELETE' }),
    onSuccess: (d) => { qc.setQueryData(['device-status', base], d); notify('Voxshift no longer looks after Kuma', { body: 'What is in Kuma stays as it is.' }); },
  });
  return (
    <>
      <div className={s.head}>
        <Badge appearance="tint" color={m.lastSyncError ? 'danger' : m.syncNeeded ? 'warning' : 'success'}>
          {m.lastSyncError ? 'Kuma needs attention' : m.syncNeeded ? 'Updating Kuma' : 'Kuma is up to date'}
        </Badge>
        <MutedText size={200}>Voxshift looks after Kuma{m.lastSyncAt ? ` (last checked ${ago(m.lastSyncAt)} ago)` : ''}. Add devices below; you never need to open Kuma.</MutedText>
        {canManage && (
          <Button size="small" appearance="subtle" onClick={() => stop.mutate()} disabled={stop.isPending}>
            Stop managing Kuma
          </Button>
        )}
      </div>
      {m.lastSyncError && (
        <Card className={s.banner}>
          <DangerText weight="semibold">{needsLogin ? 'Kuma has its own administrator.' : 'Voxshift could not update Kuma.'}</DangerText>
          <Text size={200}>{m.lastSyncError}</Text>
        </Card>
      )}
      {needsLogin && canManage && (
        <Card className={s.form}>
          <Text size={200}>This Kuma was set up by hand, so Voxshift needs the administrator's sign-in. It is kept encrypted and never shown again.</Text>
          <Field label="Kuma administrator">
            <Input value={user} onChange={(_, d) => setUser(d.value)} autoComplete="off" />
          </Field>
          <Field label="Password">
            <Input type="password" value={pass} onChange={(_, d) => setPass(d.value)} autoComplete="new-password" />
          </Field>
          <div className={s.actions}>
            <Button appearance="primary" onClick={() => retry.mutate()} disabled={!user || !pass || retry.isPending}>
              Save and try again
            </Button>
          </div>
        </Card>
      )}
    </>
  );
}

/** Discovery > Device status: what Voxshift last read from the customer's Uptime Kuma (docs/DEVICE-MONITORING.md). Read-only; the monitors live in Kuma. */
export function DeviceStatus({ base, canManage }: { base: string; canManage: boolean }) {
  const s = useStyles();
  const qc = useQueryClient();
  const notify = useNotify();
  const q = useQuery({ queryKey: ['device-status', base], queryFn: () => api<DeviceStatusOverview>(base), refetchInterval: 15_000 });
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState({ enabled: true, kumaUrl: '', statusSlug: '' });
  const [, tick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => tick((n) => n + 1), 30_000);
    return () => clearInterval(t);
  }, []);

  const settings = q.data?.settings;
  useEffect(() => {
    if (settings && !editing) setForm({ enabled: settings.enabled || !settings.kumaUrl, kumaUrl: settings.kumaUrl, statusSlug: settings.statusSlug });
  }, [settings, editing]);

  const save = useMutation({
    mutationFn: () => api<DeviceStatusOverview>(`${base}/settings`, { method: 'PUT', body: JSON.stringify(form) }),
    onSuccess: (data) => {
      qc.setQueryData(['device-status', base], data);
      setEditing(false);
      notify(form.enabled ? 'Device status switched on' : 'Device status switched off', { body: form.enabled ? 'It can take up to 15 seconds to show the first results.' : undefined });
    },
    onError: (e) => notify('Could not save', { intent: 'error', body: (e as Error).message }),
  });

  const autoSetup = useMutation({
    mutationFn: () => api<DeviceStatusOverview>(`${base}/auto-setup`, { method: 'POST', body: JSON.stringify({}) }),
    onSuccess: (data) => {
      qc.setQueryData(['device-status', base], data);
      notify('Voxshift is setting Kuma up', { body: 'Add your devices below. The first results appear within about 15 seconds.' });
    },
    onError: (e) => notify('Could not set up', { intent: 'error', body: (e as Error).message }),
  });

  if (q.isLoading) return <Spinner size="tiny" />;
  if (q.isError) return <LoadError message={(q.error as Error).message} />;
  const data = q.data!;
  const configured = !!data.settings.kumaUrl && !!data.settings.statusSlug;
  const down = data.devices.filter((d) => d.state === 'down').sort((a, b) => Date.parse(a.since) - Date.parse(b.since));
  const now = Date.now();

  const settingsForm = (
    <Card className={s.form}>
      <Switch checked={form.enabled} onChange={(_, d) => setForm({ ...form, enabled: d.checked })} label="Read device status from Kuma" />
      <Field label="Kuma address" hint="Where Voxshift reaches Kuma on the network, like http://kuma:3001. Address only, no path.">
        <Input value={form.kumaUrl} onChange={(_, d) => setForm({ ...form, kumaUrl: d.value })} placeholder="http://kuma:3001" />
      </Field>
      <Field label="Status page name" hint="The last part of the status page's address in Kuma (…/status/this-bit).">
        <Input value={form.statusSlug} onChange={(_, d) => setForm({ ...form, statusSlug: d.value })} placeholder="voxshift" />
      </Field>
      <MutedText size={200}>
        Voxshift only reads Kuma. In Kuma, put the devices on that status page and tag each monitor <b>site</b> (the site code) and <b>device</b> (algo, poly, dect, audiocodes, teams-room or other).
      </MutedText>
      <div className={s.actions}>
        <Button appearance="primary" onClick={() => save.mutate()} disabled={save.isPending}>
          Save
        </Button>
        <Button onClick={() => setEditing(false)}>Cancel</Button>
      </div>
    </Card>
  );

  if (!configured && !editing) {
    return (
      <EmptyState
        title="Device status is not set up"
        hint="Voxshift can show whether each site's phones, paging units and gateways are answering. It runs the checks with Uptime Kuma, which is installed alongside Voxshift: Voxshift sets Kuma up for you, so you only list the devices."
        action={
          canManage ? (
            <div className={s.actions}>
              <Button appearance="primary" onClick={() => autoSetup.mutate()} disabled={autoSetup.isPending}>
                Set up automatically
              </Button>
              <Button onClick={() => setEditing(true)}>I run Kuma myself</Button>
            </div>
          ) : undefined
        }
      />
    );
  }

  return (
    <div className={s.page}>
      <div className={s.head}>
        <MutedText size={200}>
          {!data.settings.enabled
            ? 'Switched off.'
            : data.settings.lastOkAt
              ? `Last read from Kuma ${ago(data.settings.lastOkAt, now)} ago.`
              : 'Waiting for the first read from Kuma.'}
        </MutedText>
        {canManage && !editing && (
          <Button size="small" onClick={() => setEditing(true)}>
            Settings
          </Button>
        )}
        {canManage && !editing && !data.managed.managed && (
          <Button size="small" appearance="primary" onClick={() => autoSetup.mutate()} disabled={autoSetup.isPending}>
            Let Voxshift look after Kuma
          </Button>
        )}
      </div>

      {editing && settingsForm}

      {data.managed.managed && <ManagedPanel base={base} data={data} canManage={canManage} />}

      {data.settings.enabled && data.settings.lastError && (
        <Card className={s.banner}>
          <DangerText weight="semibold">Voxshift cannot read Kuma.</DangerText>
          <Text size={200}>{data.settings.lastError}</Text>
        </Card>
      )}
      {data.stale && !data.settings.lastError && data.settings.lastOkAt && (
        <Card className={s.banner}>
          <Text weight="semibold">The colours below are from {ago(data.settings.lastOkAt, now)} ago.</Text>
        </Card>
      )}

      {(data.managed.managed || data.inventory.length > 0) && <DeviceList base={base} data={data} canManage={canManage} />}

      {data.devices.length === 0 ? (
        data.settings.enabled && !data.settings.lastError && data.settings.lastOkAt ? (
          <EmptyState title="No devices on that status page" hint="In Kuma, add the monitors to the status page (Edit status page > add a group) and tag them site and device." />
        ) : null
      ) : (
        <>
          <div className={s.tiles}>
            {data.sites.map((t) => (
              <Card key={t.sitecode ?? '—'} className={mergeClasses(s.tile, s[t.state])}>
                <div className={s.tileTop}>
                  <Text weight="semibold">{t.sitecode ?? 'No site tag'}</Text>
                  <StateBadge state={t.state} />
                </div>
                <MutedText size={200}>{t.sitecode ? (t.name ?? (t.known ? '' : 'Not a site in Voxshift')) : 'Monitors with no site tag'}</MutedText>
                <Text size={200}>
                  {t.total} device{t.total === 1 ? '' : 's'}
                  {t.counts.down > 0 && <DangerText size={200}> · {t.counts.down} down</DangerText>}
                  {t.counts.pending > 0 && ` · ${t.counts.pending} checking`}
                  {t.counts.maintenance > 0 && ` · ${t.counts.maintenance} in maintenance`}
                </Text>
              </Card>
            ))}
          </div>

          {down.length > 0 && (
            <div className={s.section}>
              <Text weight="semibold">Down now</Text>
              <DataTable size="small" minWidth={560}>
                <TableHeader>
                  <TableRow>
                    <TableHeaderCell>Device</TableHeaderCell>
                    <TableHeaderCell>Site</TableHeaderCell>
                    <TableHeaderCell>Down for</TableHeaderCell>
                    <TableHeaderCell>What Kuma says</TableHeaderCell>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {down.map((d) => (
                    <TableRow key={d.kumaId}>
                      <TableCell>{d.name}</TableCell>
                      <TableCell>{d.sitecode ?? '—'}</TableCell>
                      <TableCell>
                        {d.sinceExact ? '' : 'at least '}
                        {ago(d.since, now)}
                      </TableCell>
                      <TableCell>{d.message || '—'}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </DataTable>
            </div>
          )}

          <div className={s.section}>
            <Text weight="semibold">All devices</Text>
            <DataTable size="small" minWidth={760}>
              <TableHeader>
                <TableRow>
                  <TableHeaderCell>Device</TableHeaderCell>
                  <TableHeaderCell>Site</TableHeaderCell>
                  <TableHeaderCell>Type</TableHeaderCell>
                  <TableHeaderCell>Status</TableHeaderCell>
                  <TableHeaderCell>For</TableHeaderCell>
                  <TableHeaderCell>Response</TableHeaderCell>
                  <TableHeaderCell>Up, last 24 h</TableHeaderCell>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.devices.map((d) => (
                  <TableRow key={d.kumaId}>
                    <TableCell>{d.name}</TableCell>
                    <TableCell>{d.sitecode ?? '—'}</TableCell>
                    <TableCell>{DEVICE_KIND_LABEL[d.deviceKind]}</TableCell>
                    <TableCell>
                      <StateBadge state={d.state} />
                    </TableCell>
                    <TableCell>
                      {d.sinceExact ? '' : 'at least '}
                      {ago(d.since, now)}
                    </TableCell>
                    <TableCell>{d.responseMs === null ? '—' : `${d.responseMs < 10 ? d.responseMs.toFixed(1) : Math.round(d.responseMs)} ms`}</TableCell>
                    <TableCell>{d.uptime24h === null ? '—' : `${(d.uptime24h * 100).toFixed(d.uptime24h === 1 ? 0 : 1)}%`}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </DataTable>
          </div>

          <div className={s.section}>
            <Text weight="semibold">Recent changes</Text>
            {data.changes.length === 0 ? (
              <MutedText size={200}>No changes seen yet. Voxshift keeps them for 90 days.</MutedText>
            ) : (
              <DataTable size="small" minWidth={620}>
                <TableHeader>
                  <TableRow>
                    <TableHeaderCell>When</TableHeaderCell>
                    <TableHeaderCell>Device</TableHeaderCell>
                    <TableHeaderCell>Site</TableHeaderCell>
                    <TableHeaderCell>Change</TableHeaderCell>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {data.changes.map((c) => (
                    <TableRow key={c.id}>
                      <TableCell>{new Date(c.at).toLocaleString()}</TableCell>
                      <TableCell>{c.name}</TableCell>
                      <TableCell>{c.sitecode ?? '—'}</TableCell>
                      <TableCell>
                        {c.from ? `${STATE[c.from].label} → ` : 'First seen '}
                        <StateBadge state={c.to} />
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </DataTable>
            )}
          </div>
        </>
      )}
    </div>
  );
}
