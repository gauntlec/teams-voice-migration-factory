import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Badge, Button, Card, Field, Input, Spinner, Switch, TableBody, TableCell, TableHeader, TableHeaderCell, TableRow, Text, makeStyles, mergeClasses, tokens } from '@fluentui/react-components';
import { DEVICE_KIND_LABEL, type DeviceState, type DeviceStatusOverview } from '@tvmf/shared';
import { api } from '../../api';
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
        hint="Voxshift can show whether each site's phones, paging units and gateways are answering, by reading an Uptime Kuma status page on this network."
        action={canManage ? <Button appearance="primary" onClick={() => setEditing(true)}>Set up</Button> : undefined}
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
      </div>

      {editing && settingsForm}

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
