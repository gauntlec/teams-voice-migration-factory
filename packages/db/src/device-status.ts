import { DEVICE_STATUS_STALE_SECONDS, parseKumaStatus, summariseBySite, type DeviceChangeRow, type DeviceKind, type DeviceMonitor, type DeviceMonitorSettingsInput, type DeviceMonitorSettingsView, type DeviceRow, type DeviceState, type DeviceStatusOverview } from '@tvmf/shared';
import { deviceManagedView, listDeviceInventory } from './device-inventory';
import type { Scoped } from './live-state';

/*
 * Device status (migration 0070, docs/DEVICE-MONITORING.md): reads the customer's Uptime Kuma status page and keeps one row per monitor
 * plus every change of state. Voxshift only reads Kuma. A failed read leaves the last known states in place and records why, so the
 * page can say "last checked" instead of showing old colours as current.
 */

export const DEVICE_CHANGES_KEPT_DAYS = 90;
const FETCH_TIMEOUT_MS = 10_000;
const MAX_BODY_BYTES = 4_000_000;

const iso = (v: string | Date | null | undefined) => (v ? new Date(v).toISOString() : null);

export async function deviceMonitorSettings(s: Scoped): Promise<DeviceMonitorSettingsView> {
  const r = await s.selectFrom('device_monitor_settings').selectAll().executeTakeFirst();
  return {
    enabled: r?.enabled ?? false,
    kumaUrl: r?.kuma_url ?? '',
    statusSlug: r?.status_slug ?? '',
    lastPolledAt: iso(r?.last_polled_at),
    lastOkAt: iso(r?.last_ok_at),
    lastError: r?.last_error ?? null,
  };
}

/** Saves the address. A different Kuma means different monitors, so what was read from the old one is dropped. */
export async function saveDeviceMonitorSettings(s: Scoped, input: DeviceMonitorSettingsInput): Promise<DeviceMonitorSettingsView> {
  const before = await deviceMonitorSettings(s);
  const moved = before.kumaUrl !== input.kumaUrl || before.statusSlug !== input.statusSlug;
  const enabled = input.enabled && !!input.kumaUrl && !!input.statusSlug;
  await s.transaction().execute(async (trx) => {
    await trx
      .insertInto('device_monitor_settings')
      .values({ id: true, enabled, kuma_url: input.kumaUrl || null, status_slug: input.statusSlug || null })
      .onConflict((oc) =>
        oc.column('id').doUpdateSet({
          enabled,
          kuma_url: input.kumaUrl || null,
          status_slug: input.statusSlug || null,
          ...(moved ? { last_polled_at: null, last_ok_at: null, last_error: null } : {}),
        }),
      )
      .execute();
    if (moved) await trx.deleteFrom('device_monitors').execute();
  });
  return deviceMonitorSettings(s);
}

async function getJson(fetchFn: typeof fetch, url: string): Promise<unknown> {
  const res = await fetchFn(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS), redirect: 'manual', headers: { Accept: 'application/json' } });
  if (res.status === 404) throw new Error('Kuma answered 404: check the status page name (it is the last part of the status page address in Kuma).');
  if (!res.ok) throw new Error(`Kuma answered ${res.status}${res.status >= 300 && res.status < 400 ? ' (a redirect: use the address Kuma itself listens on)' : ''}.`);
  const text = await res.text();
  if (text.length > MAX_BODY_BYTES) throw new Error('Kuma sent more data than a status page should.');
  try {
    return JSON.parse(text);
  } catch {
    throw new Error('Kuma did not answer with JSON: check the address points at Kuma itself.');
  }
}

/** One look at Kuma. 'skipped' when it is not switched on or not set up. Never throws. */
export async function pollDeviceStatus(s: Scoped, opts: { fetchFn?: typeof fetch; now?: Date } = {}): Promise<'skipped' | 'ok' | 'failed'> {
  const cfg = await s.selectFrom('device_monitor_settings').selectAll().executeTakeFirst();
  if (!cfg?.enabled || !cfg.kuma_url || !cfg.status_slug) return 'skipped';
  const now = opts.now ?? new Date();
  const nowIso = now.toISOString();
  const fetchFn = opts.fetchFn ?? fetch;
  const base = `${cfg.kuma_url}/api/status-page`;
  let monitors: DeviceMonitor[];
  try {
    const slug = encodeURIComponent(cfg.status_slug);
    const [page, beats] = await Promise.all([getJson(fetchFn, `${base}/${slug}`), getJson(fetchFn, `${base}/heartbeat/${slug}`)]);
    monitors = parseKumaStatus(page, beats);
  } catch (e) {
    const msg = e instanceof Error ? (e.name === 'TimeoutError' ? 'Kuma did not answer in time.' : e.message) : String(e);
    await s.updateTable('device_monitor_settings').set({ last_polled_at: nowIso, last_error: msg.slice(0, 300) }).execute();
    return 'failed';
  }

  await s.transaction().execute(async (trx) => {
    const existing = new Map((await trx.selectFrom('device_monitors').selectAll().execute()).map((r) => [r.kuma_id, r]));
    const seen = new Set<number>();
    for (const m of monitors) {
      seen.add(m.kumaId);
      const old = existing.get(m.kumaId);
      const base = {
        name: m.name,
        monitor_type: m.monitorType,
        group_name: m.group,
        sitecode: m.sitecode,
        device_kind: m.deviceKind,
        last_beat_at: m.lastBeatAt,
        response_ms: m.responseMs,
        message: m.message,
        uptime_24h: m.uptime24h,
        updated_at: nowIso,
      };
      const changed = !old || old.state !== m.state;
      let since = m.since ?? nowIso;
      let exact = m.sinceExact;
      if (old && !changed) {
        // Same state as last time: keep the earlier "since" unless the window now shows the real start.
        if (old.since_exact || !m.sinceExact) { since = iso(old.since)!; exact = old.since_exact; }
      }
      if (changed && (old || (m.state !== 'up' && m.state !== 'unknown'))) {
        await trx
          .insertInto('device_status_changes')
          .values({ kuma_id: m.kumaId, name: m.name, sitecode: m.sitecode, device_kind: m.deviceKind, from_state: old?.state ?? null, to_state: m.state, at: since, message: m.message })
          .execute();
      }
      await trx
        .insertInto('device_monitors')
        .values({ kuma_id: m.kumaId, state: m.state, since, since_exact: exact, ...base })
        .onConflict((oc) => oc.column('kuma_id').doUpdateSet({ state: m.state, since, since_exact: exact, ...base }))
        .execute();
    }
    const gone = [...existing.keys()].filter((id) => !seen.has(id));
    if (gone.length) await trx.deleteFrom('device_monitors').where('kuma_id', 'in', gone).execute();
    await trx.deleteFrom('device_status_changes').where('at', '<', new Date(now.getTime() - DEVICE_CHANGES_KEPT_DAYS * 86400_000).toISOString()).execute();
    await trx.updateTable('device_monitor_settings').set({ last_polled_at: nowIso, last_ok_at: nowIso, last_error: null }).execute();
  });
  return 'ok';
}

const num = (v: string | number | null | undefined) => (v === null || v === undefined ? null : Number(v));

/** What the Device status tab shows: the settings, every device, a tile per site and the latest changes. */
export async function deviceStatusOverview(s: Scoped, now = new Date()): Promise<DeviceStatusOverview> {
  const [settings, managed, inventory, rows, changes, sites] = await Promise.all([
    deviceMonitorSettings(s),
    deviceManagedView(s),
    listDeviceInventory(s),
    s.selectFrom('device_monitors').selectAll().orderBy('name').execute(),
    s.selectFrom('device_status_changes').selectAll().orderBy('at', 'desc').orderBy('id', 'desc').limit(50).execute(),
    s.selectFrom('discovery_sites').select(['sitecode', 'name']).execute(),
  ]);
  // A tag may differ from the site code in case only; show the site's own code.
  const canon = new Map(sites.map((x) => [x.sitecode.toLowerCase(), x]));
  const codeOf = (c: string | null) => (c === null ? null : (canon.get(c.toLowerCase())?.sitecode ?? c));
  const devices: DeviceRow[] = rows.map((r) => ({
    kumaId: r.kuma_id,
    name: r.name,
    group: r.group_name,
    sitecode: codeOf(r.sitecode),
    deviceKind: r.device_kind as DeviceKind,
    state: r.state as DeviceState,
    since: iso(r.since)!,
    sinceExact: r.since_exact,
    lastBeatAt: iso(r.last_beat_at),
    responseMs: num(r.response_ms),
    message: r.message,
    uptime24h: num(r.uptime_24h),
    monitorType: r.monitor_type,
  }));
  const tiles = summariseBySite(devices).map((t) => {
    const site = t.sitecode ? canon.get(t.sitecode.toLowerCase()) : undefined;
    return { ...t, name: site?.name ?? null, known: !!site };
  });
  const stale = settings.enabled && (!settings.lastOkAt || now.getTime() - Date.parse(settings.lastOkAt) > DEVICE_STATUS_STALE_SECONDS * 1000);
  return {
    settings,
    managed,
    inventory,
    siteOptions: [...sites].sort((a, b) => a.sitecode.localeCompare(b.sitecode)),
    stale,
    devices,
    sites: tiles,
    changes: changes.map((c) => ({
      id: String(c.id),
      name: c.name,
      sitecode: codeOf(c.sitecode),
      deviceKind: c.device_kind as DeviceKind,
      from: (c.from_state as DeviceState | null) ?? null,
      to: c.to_state as DeviceState,
      at: iso(c.at)!,
      message: c.message,
    })),
  };
}
