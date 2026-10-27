import { KUMA_DEFAULT_URL, KUMA_MANAGED_SLUG, type DeviceCheckType, type DeviceInventoryInput, type DeviceInventoryRow, type DeviceKind, type DeviceManagedView, type DeviceSyncState } from '@tvmf/shared';
import type { Scoped } from './live-state';

/*
 * Device inventory (migration 0071): the devices a customer wants watched. Any change marks the settings "sync needed"; the worker then makes
 * Kuma match (device-sync.ts). Voxshift never edits Kuma from the API: it only writes here.
 */

const iso = (v: string | Date | null | undefined) => (v ? new Date(v).toISOString() : null);
const flagSync = (s: Scoped) => s.updateTable('device_monitor_settings').set({ sync_needed: true }).execute();

type Row = {
  id: string; site_code: string; name: string; kind: string; check_type: string; address: string; port: number | null; sync_state: string; sync_error: string | null;
};
const toRow = (r: Row): DeviceInventoryRow => ({
  id: r.id,
  siteCode: r.site_code,
  name: r.name,
  kind: r.kind as DeviceKind,
  checkType: r.check_type as DeviceCheckType,
  address: r.address,
  port: r.port,
  syncState: r.sync_state as DeviceSyncState,
  syncError: r.sync_error,
});

export async function listDeviceInventory(s: Scoped): Promise<DeviceInventoryRow[]> {
  const rows = await s.selectFrom('device_inventory').selectAll().where('removed', '=', false).orderBy('site_code').orderBy('name').execute();
  return rows.map(toRow);
}

/** A site code written any way round is stored as the Discovery site's own code. Returns null when no such site exists. */
export async function canonicalSiteCode(s: Scoped, code: string): Promise<string | null> {
  const sites = await s.selectFrom('discovery_sites').select('sitecode').execute();
  return sites.find((x) => x.sitecode.toLowerCase() === code.toLowerCase())?.sitecode ?? null;
}

export async function addDevice(s: Scoped, input: DeviceInventoryInput): Promise<DeviceInventoryRow> {
  const r = await s
    .insertInto('device_inventory')
    .values({ site_code: input.siteCode, name: input.name, kind: input.kind, check_type: input.checkType, address: input.address, port: input.port ?? null })
    .returningAll()
    .executeTakeFirstOrThrow();
  await flagSync(s);
  return toRow(r);
}

export async function updateDevice(s: Scoped, id: string, input: DeviceInventoryInput): Promise<DeviceInventoryRow | null> {
  const r = await s
    .updateTable('device_inventory')
    .set({ site_code: input.siteCode, name: input.name, kind: input.kind, check_type: input.checkType, address: input.address, port: input.port ?? null, sync_state: 'pending', sync_error: null, updated_at: new Date().toISOString() })
    .where('id', '=', id)
    .where('removed', '=', false)
    .returningAll()
    .executeTakeFirst();
  if (!r) return null;
  await flagSync(s);
  return toRow(r);
}

/** Takes a device off the list. One that has a Kuma monitor is only marked: the worker deletes the monitor, then the row. */
export async function removeDevice(s: Scoped, id: string): Promise<boolean> {
  const r = await s.selectFrom('device_inventory').select(['id', 'kuma_monitor_id']).where('id', '=', id).where('removed', '=', false).executeTakeFirst();
  if (!r) return false;
  if (r.kuma_monitor_id === null) await s.deleteFrom('device_inventory').where('id', '=', id).execute();
  else await s.updateTable('device_inventory').set({ removed: true, updated_at: new Date().toISOString() }).where('id', '=', id).execute();
  await flagSync(s);
  return true;
}

export async function deviceManagedView(s: Scoped): Promise<DeviceManagedView> {
  const r = await s.selectFrom('device_monitor_settings').selectAll().executeTakeFirst();
  return {
    managed: r?.managed ?? false,
    hasCredentials: !!r?.kuma_admin_user && !!r?.kuma_admin_pass_enc,
    syncNeeded: r?.sync_needed ?? false,
    lastSyncAt: iso(r?.last_sync_at),
    lastSyncError: r?.last_sync_error ?? null,
  };
}

/**
 * Hands Kuma to Voxshift: switches device status on, points it at Kuma (the compose stack's own by default) and the status page Voxshift owns, and
 * asks for a sync. Credentials are only given when Kuma already has an administrator that Voxshift did not create; the password arrives already encrypted.
 */
export async function enableManagedKuma(s: Scoped, opts: { kumaUrl?: string; adminUser?: string; adminPassEnc?: string }): Promise<void> {
  const before = await s.selectFrom('device_monitor_settings').select(['kuma_url', 'status_slug']).executeTakeFirst();
  const url = opts.kumaUrl || before?.kuma_url || KUMA_DEFAULT_URL;
  const moved = before?.kuma_url !== url || before?.status_slug !== KUMA_MANAGED_SLUG;
  const creds = opts.adminUser && opts.adminPassEnc ? { kuma_admin_user: opts.adminUser, kuma_admin_pass_enc: opts.adminPassEnc } : {};
  await s.transaction().execute(async (trx) => {
    await trx
      .insertInto('device_monitor_settings')
      .values({ id: true, enabled: true, managed: true, kuma_url: url, status_slug: KUMA_MANAGED_SLUG, sync_needed: true, ...creds })
      .onConflict((oc) =>
        oc.column('id').doUpdateSet({
          enabled: true, managed: true, kuma_url: url, status_slug: KUMA_MANAGED_SLUG, sync_needed: true, last_sync_error: null,
          ...creds,
          ...(moved ? { last_polled_at: null, last_ok_at: null, last_error: null } : {}),
        }),
      )
      .execute();
    if (moved) await trx.deleteFrom('device_monitors').execute();
    // Monitors Voxshift made in an earlier Kuma do not exist in this one.
    if (moved) await trx.updateTable('device_inventory').set({ kuma_monitor_id: null, sync_state: 'pending', sync_error: null }).where('removed', '=', false).execute();
    if (moved) await trx.deleteFrom('device_inventory').where('removed', '=', true).execute();
  });
}

/** Voxshift stops looking after Kuma. What is in Kuma stays; the dashboard keeps reading the status page. */
export async function disableManagedKuma(s: Scoped): Promise<void> {
  await s.updateTable('device_monitor_settings').set({ managed: false, sync_needed: false }).execute();
}
