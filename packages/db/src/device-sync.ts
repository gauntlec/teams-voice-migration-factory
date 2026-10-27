import { KUMA_MANAGED_SLUG, KUMA_MANAGED_TITLE, kumaMonitorFields, kumaNewMonitor, kumaTagsFor, planTagChanges, type DeviceKind } from '@tvmf/shared';
import type { Scoped } from './live-state';

/*
 * Keeps Uptime Kuma in step with device_inventory (migration 0071). The worker connects to Kuma (apps/worker/src/kuma-client.ts, which is the only
 * code that speaks Kuma's Socket.IO API) and hands this function the small set of operations it needs, so the rules here are tested without a Kuma.
 *
 * Voxshift owns what it made: monitors whose id is stored on an inventory row, the two tags site and device, and the status page "voxshift". Monitors
 * and tags a person adds in Kuma by hand are never edited, except that this status page lists only what Voxshift manages.
 */

export interface KumaMonitorInfo {
  id: number;
  name?: string;
  type?: string;
  hostname?: string | null;
  port?: number | null;
  tags?: Array<{ tag_id?: number; name?: string; value?: string | null }>;
  [key: string]: unknown;
}

export interface KumaApi {
  /** Every monitor Kuma has, by id. */
  listMonitors(): Promise<Map<number, KumaMonitorInfo>>;
  /** The id of the tag with this name, making it if Kuma has none. */
  ensureTag(name: string, color: string): Promise<number>;
  addMonitor(payload: Record<string, unknown>): Promise<number>;
  /** `current` is the monitor as Kuma has it; `fields` are the values to change. */
  editMonitor(current: KumaMonitorInfo, fields: Record<string, unknown>): Promise<void>;
  deleteMonitor(id: number): Promise<void>;
  addMonitorTag(tagId: number, monitorId: number, value: string): Promise<void>;
  deleteMonitorTag(tagId: number, monitorId: number, value: string): Promise<void>;
  /** Makes the status page exist and show exactly these groups, with Show Tags on. */
  saveStatusPage(slug: string, title: string, groups: Array<{ name: string; monitorIds: number[] }>): Promise<void>;
}

const TAG_COLOUR: Record<'site' | 'device', string> = { site: '#4657D2', device: '#354BC0' };

export interface DeviceSyncResult { created: number; updated: number; deleted: number; errors: number }

const message = (e: unknown) => (e instanceof Error ? e.message : String(e)).slice(0, 300);

export async function syncDeviceInventory(s: Scoped, kuma: KumaApi): Promise<DeviceSyncResult> {
  const result: DeviceSyncResult = { created: 0, updated: 0, deleted: 0, errors: 0 };
  const rows = await s.selectFrom('device_inventory').selectAll().orderBy('site_code').orderBy('name').execute();
  const monitors = await kuma.listMonitors();
  const tagIds = { site: await kuma.ensureTag('site', TAG_COLOUR.site), device: await kuma.ensureTag('device', TAG_COLOUR.device) };
  const grouped = new Map<string, number[]>();
  const now = () => new Date().toISOString();

  for (const r of rows) {
    try {
      if (r.removed) {
        if (r.kuma_monitor_id !== null && monitors.has(r.kuma_monitor_id)) { await kuma.deleteMonitor(r.kuma_monitor_id); result.deleted++; }
        await s.deleteFrom('device_inventory').where('id', '=', r.id).execute();
        continue;
      }
      const device = { name: r.name, checkType: r.check_type as 'ping' | 'port', address: r.address, port: r.port };
      let id = r.kuma_monitor_id;
      let current = id !== null ? monitors.get(id) : undefined;
      if (!current) {
        // New, or deleted by hand in Kuma: make it again.
        id = await kuma.addMonitor(kumaNewMonitor(device));
        current = { id, tags: [] };
        result.created++;
      } else {
        const want = kumaMonitorFields(device);
        const differs = (['name', 'type', 'hostname', 'port'] as const).some((k) => (current![k] ?? null) !== (want[k] ?? null));
        if (differs) { await kuma.editMonitor(current, want); result.updated++; }
      }
      const { remove, add } = planTagChanges(kumaTagsFor({ siteCode: r.site_code, kind: r.kind as DeviceKind }), current.tags ?? []);
      for (const t of remove) await kuma.deleteMonitorTag(t.tagId, id!, t.value);
      for (const t of add) await kuma.addMonitorTag(tagIds[t.name as 'site' | 'device'], id!, t.value);
      await s.updateTable('device_inventory').set({ kuma_monitor_id: id, sync_state: 'synced', sync_error: null, updated_at: now() }).where('id', '=', r.id).execute();
      grouped.set(r.site_code, [...(grouped.get(r.site_code) ?? []), id!]);
    } catch (e) {
      result.errors++;
      await s.updateTable('device_inventory').set({ sync_state: 'error', sync_error: message(e) }).where('id', '=', r.id).execute();
      // A device that was synced before keeps its place on the status page while its update is failing.
      if (r.kuma_monitor_id !== null && monitors.has(r.kuma_monitor_id) && !r.removed) grouped.set(r.site_code, [...(grouped.get(r.site_code) ?? []), r.kuma_monitor_id]);
    }
  }

  const sites = await s.selectFrom('discovery_sites').select(['sitecode', 'name']).execute();
  const nameOf = new Map(sites.map((x) => [x.sitecode, x.name]));
  const groups = [...grouped.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([code, monitorIds]) => ({ name: nameOf.get(code) ? `${code} · ${nameOf.get(code)}` : code, monitorIds }));
  await kuma.saveStatusPage(KUMA_MANAGED_SLUG, KUMA_MANAGED_TITLE, groups);
  return result;
}

/** Records how a sync went. A sync that left errors keeps the "needed" flag on, so the worker tries again. */
export async function recordDeviceSync(s: Scoped, outcome: { error?: string; deviceErrors?: number }, now = new Date()): Promise<void> {
  const failed = !!outcome.error || !!outcome.deviceErrors;
  await s
    .updateTable('device_monitor_settings')
    .set({
      last_sync_at: now.toISOString(),
      last_sync_error: outcome.error ?? (outcome.deviceErrors ? `${outcome.deviceErrors} device${outcome.deviceErrors === 1 ? '' : 's'} could not be set up in Kuma: see the list.` : null),
      sync_needed: failed,
    })
    .execute();
}

export const DEVICE_SYNC_RETRY_MS = 60_000;
export const DEVICE_SYNC_RECHECK_MS = 3_600_000;

/**
 * What the worker should do now for this customer: their Kuma's address and the stored sign-in, or null for nothing.
 * Due: a change nobody has synced yet (at once), a sync that failed (again after a minute), and a healthy one hourly (a monitor deleted by hand comes back).
 */
export async function deviceSyncDue(s: Scoped, now = new Date()): Promise<{ url: string; adminUser: string | null; adminPassEnc: string | null } | null> {
  const c = await s.selectFrom('device_monitor_settings').selectAll().executeTakeFirst();
  if (!c?.enabled || !c.managed || !c.kuma_url) return null;
  const since = now.getTime() - (c.last_sync_at ? new Date(c.last_sync_at).getTime() : 0);
  const due = c.sync_needed ? (c.last_sync_error ? since >= DEVICE_SYNC_RETRY_MS : true) : since >= DEVICE_SYNC_RECHECK_MS;
  return due ? { url: c.kuma_url, adminUser: c.kuma_admin_user, adminPassEnc: c.kuma_admin_pass_enc } : null;
}

/** Stores the administrator Voxshift made in Kuma (the password is already encrypted). */
export async function saveKumaAdmin(s: Scoped, user: string, passEnc: string): Promise<void> {
  await s.updateTable('device_monitor_settings').set({ kuma_admin_user: user, kuma_admin_pass_enc: passEnc }).execute();
}
