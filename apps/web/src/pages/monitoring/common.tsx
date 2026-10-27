import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Badge, Button, Card, Dialog, DialogActions, DialogBody, DialogContent, DialogSurface, DialogTitle, Field, Input, Select, Switch, Text, makeStyles, tokens } from '@fluentui/react-components';
import { DEVICE_CHECK_LABEL, DEVICE_KINDS, DEVICE_KIND_LABEL, type DeviceCheckType, type DeviceInventoryRow, type DeviceKind, type DeviceState, type DeviceStatusOverview } from '@tvmf/shared';
import { api, ApiError } from '../../api';
import { DangerText, MutedText } from '../../components/ui';
import { useNotify } from '../../hooks/useNotify';

/** What the Monitoring pages share: styles, the status words, the overview query, setting monitoring up, and the add / change device form. */

export const useStyles = makeStyles({
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
  region: { display: 'grid', rowGap: '10px' },
  regionHead: { display: 'flex', alignItems: 'center', columnGap: '10px', flexWrap: 'wrap', paddingBottom: '4px', borderBottomWidth: '1px', borderBottomStyle: 'solid', borderBottomColor: tokens.colorNeutralStroke2 },
  countryHead: { display: 'flex', alignItems: 'center', columnGap: '8px', flexWrap: 'wrap', marginTop: '4px' },
  banner: { padding: '10px 14px', display: 'flex', flexDirection: 'row', columnGap: '10px', alignItems: 'center', flexWrap: 'wrap' },
  form: { display: 'grid', rowGap: '12px', maxWidth: '520px', padding: '16px' },
  wideForm: { display: 'grid', rowGap: '14px', maxWidth: '640px', padding: '16px' },
  actions: { display: 'flex', columnGap: '8px', flexWrap: 'wrap' },
  rowActions: { display: 'flex', columnGap: '4px' },
  dialogForm: { display: 'grid', rowGap: '12px' },
  twoCol: { display: 'grid', gridTemplateColumns: '1fr 1fr', columnGap: '12px' },
});

export const STATE: Record<DeviceState, { label: string; color: 'success' | 'danger' | 'warning' | 'informative' | 'subtle' }> = {
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

export function StateBadge({ state }: { state: DeviceState }) {
  return (
    <Badge appearance="tint" color={STATE[state].color}>
      {STATE[state].label}
    </Badge>
  );
}


export const SYNC: Record<DeviceInventoryRow['syncState'], { label: string; color: 'success' | 'warning' | 'danger' }> = {
  synced: { label: 'Being watched', color: 'success' },
  pending: { label: 'Setting up', color: 'warning' },
  error: { label: 'Problem', color: 'danger' },
};


/** The overview, refreshed every 15 seconds (the worker reads the monitoring status at that pace). */
export function useOverview(base: string) {
  return useQuery({ queryKey: ['device-status', base], queryFn: () => api<DeviceStatusOverview>(base), refetchInterval: 15_000 });
}

/** Makes "x ago" texts move on without a refetch. */
export function useTick(ms = 30_000) {
  const [, tick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => tick((n) => n + 1), ms);
    return () => clearInterval(t);
  }, [ms]);
}

/** Has Voxshift look after monitoring: switches it on, points it at the monitoring module installed alongside Voxshift, and asks for a sync. */
export function useAutoSetup(base: string) {
  const qc = useQueryClient();
  const notify = useNotify();
  return useMutation({
    mutationFn: () => api<DeviceStatusOverview>(`${base}/auto-setup`, { method: 'POST', body: JSON.stringify({}) }),
    onSuccess: (data) => {
      qc.setQueryData(['device-status', base], data);
      notify('Voxshift is setting up monitoring', { body: 'Add your devices. The first results appear within about 15 seconds.' });
    },
    onError: (e) => notify('Could not set up', { intent: 'error', body: (e as Error).message }),
  });
}

export const isConfigured = (d: DeviceStatusOverview) => !!d.settings.kumaUrl && !!d.settings.statusSlug;

/** Voxshift looks after the monitoring module: a plain status line, a way to give it the module's sign-in when it already has an administrator, and a way to hand it back. */
export function ManagedPanel({ base, data, canManage }: { base: string; data: DeviceStatusOverview; canManage: boolean }) {
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
    onSuccess: (d) => { qc.setQueryData(['device-status', base], d); notify('Voxshift no longer looks after the monitoring module', { body: 'What is set up in it stays as it is.' }); },
  });
  return (
    <>
      <div className={s.head}>
        <Badge appearance="tint" color={m.lastSyncError ? 'danger' : m.syncNeeded ? 'warning' : 'success'}>
          {m.lastSyncError ? 'Needs attention' : m.syncNeeded ? 'Updating' : 'Up to date'}
        </Badge>
        <MutedText size={200}>Voxshift looks after the monitoring module{m.lastSyncAt ? ` (last checked ${ago(m.lastSyncAt)} ago)` : ''}. Add devices below: there is nothing to set up by hand.</MutedText>
        {canManage && (
          <Button size="small" appearance="subtle" onClick={() => stop.mutate()} disabled={stop.isPending}>
            Stop managing the monitoring module
          </Button>
        )}
      </div>
      {m.lastSyncError && (
        <Card className={s.banner}>
          <DangerText weight="semibold">{needsLogin ? 'The monitoring module has its own administrator.' : 'Voxshift could not update the monitoring module.'}</DangerText>
          <Text size={200}>{m.lastSyncError}</Text>
        </Card>
      )}
      {needsLogin && canManage && (
        <Card className={s.form}>
          <Text size={200}>The monitoring module was set up by hand, so Voxshift needs its administrator's sign-in. It is kept encrypted and never shown again.</Text>
          <Field label="Administrator">
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


/** Connect to a monitoring service somebody runs themselves: its address and the status page to read. */
export function SettingsForm({ base, data, onClose }: { base: string; data: DeviceStatusOverview; onClose: () => void }) {
  const s = useStyles();
  const qc = useQueryClient();
  const notify = useNotify();
  const [form, setForm] = useState({ enabled: data.settings.enabled || !data.settings.kumaUrl, kumaUrl: data.settings.kumaUrl, statusSlug: data.settings.statusSlug });
  const save = useMutation({
    mutationFn: () => api<DeviceStatusOverview>(`${base}/settings`, { method: 'PUT', body: JSON.stringify(form) }),
    onSuccess: (d) => {
      qc.setQueryData(['device-status', base], d);
      onClose();
      notify(form.enabled ? 'Monitoring switched on' : 'Monitoring switched off', { body: form.enabled ? 'It can take up to 15 seconds to show the first results.' : undefined });
    },
    onError: (e) => notify('Could not save', { intent: 'error', body: (e as Error).message }),
  });
  return (
    <Card className={s.form}>
      <Switch checked={form.enabled} onChange={(_, d) => setForm({ ...form, enabled: d.checked })} label="Read device status from the monitoring service" />
      <Field label="Monitoring service address" hint="Where Voxshift reaches the monitoring service on the network. Address only, no path.">
        <Input value={form.kumaUrl} onChange={(_, d) => setForm({ ...form, kumaUrl: d.value })} placeholder="http://monitoring-host:3001" />
      </Field>
      <Field label="Status page name" hint="The last part of the status page's address (…/status/this-bit).">
        <Input value={form.statusSlug} onChange={(_, d) => setForm({ ...form, statusSlug: d.value })} placeholder="voxshift" />
      </Field>
      <MutedText size={200}>
        Voxshift only reads it. On that status page, put the devices and tag each monitor <b>site</b> (the site code) and <b>device</b> (algo, poly, dect, audiocodes, teams-room or other).
      </MutedText>
      <div className={s.actions}>
        <Button appearance="primary" onClick={() => save.mutate()} disabled={save.isPending}>
          Save
        </Button>
        <Button onClick={onClose}>Cancel</Button>
      </div>
    </Card>
  );
}

// ------------------------------------------------------------------------------------------------------------ the device form

export interface DeviceFormValues { siteCode: string; name: string; kind: DeviceKind; checkType: DeviceCheckType; address: string; port: string }
export const emptyDeviceForm = (siteCode: string): DeviceFormValues => ({ siteCode, name: '', kind: 'other', checkType: 'ping', address: '', port: '' });
export const formFromDevice = (d: DeviceInventoryRow): DeviceFormValues => ({ siteCode: d.siteCode, name: d.name, kind: d.kind, checkType: d.checkType, address: d.address, port: d.port ? String(d.port) : '' });
export const formToBody = (f: DeviceFormValues) => JSON.stringify({ siteCode: f.siteCode, name: f.name, kind: f.kind, checkType: f.checkType, address: f.address, port: f.checkType === 'port' && f.port ? Number(f.port) : null });
export const deviceFormComplete = (f: DeviceFormValues) => !!f.siteCode && !!f.name.trim() && !!f.address.trim() && (f.checkType !== 'port' || !!f.port);
export const errorText = (e: unknown) => (e instanceof ApiError ? e.message : (e as Error).message);

/** The fields of the form, shared by the add form and the Change dialog. */
export function DeviceFields({ value, onChange, sites }: { value: DeviceFormValues; onChange: (patch: Partial<DeviceFormValues>) => void; sites: Array<{ sitecode: string; name: string | null }> }) {
  const s = useStyles();
  return (
    <div className={s.dialogForm}>
      <Field label="Site" required>
        <Select value={value.siteCode} onChange={(_, d) => onChange({ siteCode: d.value })}>
          {sites.map((x) => (
            <option key={x.sitecode} value={x.sitecode}>
              {x.sitecode}
              {x.name ? ` · ${x.name}` : ''}
            </option>
          ))}
        </Select>
      </Field>
      <Field label="Name" required hint="What people call it, for example Reception door paging.">
        <Input value={value.name} onChange={(_, d) => onChange({ name: d.value })} />
      </Field>
      <div className={s.twoCol}>
        <Field label="Type of device">
          <Select value={value.kind} onChange={(_, d) => onChange({ kind: d.value as DeviceKind })}>
            {DEVICE_KINDS.map((k) => (
              <option key={k} value={k}>
                {DEVICE_KIND_LABEL[k]}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="How to check it" hint={value.checkType === 'ping' ? 'Does it answer a ping?' : 'Is this TCP port open?'}>
          <Select value={value.checkType} onChange={(_, d) => onChange({ checkType: d.value as DeviceCheckType })}>
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
          <Input value={value.address} onChange={(_, d) => onChange({ address: d.value })} placeholder="10.20.30.40" />
        </Field>
        {value.checkType === 'port' && (
          <Field label="Port" required>
            <Input value={value.port} inputMode="numeric" onChange={(_, d) => onChange({ port: d.value.replace(/\D/g, '') })} placeholder="5060" />
          </Field>
        )}
      </div>
    </div>
  );
}

/** Change a device on the watch list. */
export function ChangeDeviceDialog({ base, sites, device, onClose }: { base: string; sites: Array<{ sitecode: string; name: string | null }>; device: DeviceInventoryRow; onClose: () => void }) {
  const qc = useQueryClient();
  const notify = useNotify();
  const [f, setF] = useState<DeviceFormValues>(formFromDevice(device));
  const [error, setError] = useState<string | null>(null);
  const save = useMutation({
    mutationFn: () => api(`${base}/devices/${device.id}`, { method: 'PUT', body: formToBody(f) }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['device-status', base] });
      notify('Device changed', { body: 'Voxshift sets up the checking within about 15 seconds.' });
      onClose();
    },
    onError: (e) => setError(errorText(e)),
  });
  return (
    <Dialog open onOpenChange={(_, d) => !d.open && onClose()}>
      <DialogSurface>
        <DialogBody>
          <DialogTitle>Change device</DialogTitle>
          <DialogContent>
            <DeviceFields value={f} onChange={(p) => { setError(null); setF({ ...f, ...p }); }} sites={sites} />
            {error && <DangerText size={200}>{error}</DangerText>}
          </DialogContent>
          <DialogActions>
            <Button onClick={onClose}>Cancel</Button>
            <Button appearance="primary" onClick={() => save.mutate()} disabled={save.isPending || !deviceFormComplete(f)}>
              Save
            </Button>
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
}
