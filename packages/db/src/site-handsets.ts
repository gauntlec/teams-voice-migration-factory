import { handsetModelKey, needsHandset, summariseHandsets, type HandsetStage, type SiteHandsetDevices, type SiteHandsets } from '@tvmf/shared';
import type { Scoped } from './live-state';

/*
 * The handsets a site needs, counted from Site Data: each user's handset model and each common area phone's device model, one row
 * per model with how many of each and the stage the project manager has recorded (site_handset_tracking, migration 0078).
 */

export async function siteHandsets(s: Scoped, siteId: string): Promise<SiteHandsets> {
  const [users, caps, tracking] = await Promise.all([
    s.selectFrom('discovery_users').select(['handset_model', 'requires_handset', 'handset_installed_at']).where('site_id', '=', siteId).execute(),
    s.selectFrom('discovery_caps').select(['device_model', 'handset_installed_at']).where('site_id', '=', siteId).execute(),
    s.selectFrom('site_handset_tracking').select(['model_key', 'status', 'updated_by', 'updated_at']).where('site_id', '=', siteId).execute(),
  ]);
  const withoutModel = users.filter((u) => u.requires_handset && !handsetModelKey(u.handset_model)).length;
  const summary = summariseHandsets(
    users.map((u) => u.handset_model),
    caps.map((c) => c.device_model),
    tracking,
    withoutModel,
  );
  // How many of each model have been ticked as installed on the Deployment page.
  const installed = new Map<string, number>();
  for (const m of [...users.filter((u) => u.handset_installed_at).map((u) => u.handset_model), ...caps.filter((c) => c.handset_installed_at).map((c) => c.device_model)]) {
    const key = handsetModelKey(m);
    if (key) installed.set(key, (installed.get(key) ?? 0) + 1);
  }
  for (const m of summary.models) m.installed = installed.get(m.key) ?? 0;
  return summary;
}

/** Every user who gets a handset and every common area phone at a site, with its installed tick: users first, then phones, by name. */
export async function siteHandsetDevices(s: Scoped, siteId: string): Promise<SiteHandsetDevices> {
  const [users, caps] = await Promise.all([
    s.selectFrom('discovery_users').select(['id', 'upn', 'display_name', 'requires_handset', 'handset_model', 'handset_installed_at', 'handset_installed_by']).where('site_id', '=', siteId).execute(),
    s.selectFrom('discovery_caps').select(['id', 'upn', 'display_name', 'device_model', 'handset_installed_at', 'handset_installed_by']).where('site_id', '=', siteId).execute(),
  ]);
  const iso = (v: unknown) => (v ? new Date(v as string).toISOString() : null);
  const byName = (a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name);
  const devices = [
    ...users
      .filter(needsHandset)
      .map((u) => ({ kind: 'user' as const, id: u.id, name: u.display_name || u.upn, upn: u.upn, model: u.handset_model?.trim() || null, installedAt: iso(u.handset_installed_at), installedBy: u.handset_installed_by }))
      .sort(byName),
    ...caps
      .map((c) => ({ kind: 'cap' as const, id: c.id, name: c.display_name, upn: c.upn, model: c.device_model?.trim() || null, installedAt: iso(c.handset_installed_at), installedBy: c.handset_installed_by }))
      .sort(byName),
  ];
  return { devices, installed: devices.filter((d) => d.installedAt).length, total: devices.length };
}

/**
 * Ticks or clears one handset as installed and working. Its own update, leaving updated_at alone: installing a phone is not a change to
 * what the customer asked for, so it must not show as a Site Data change. Returns false when the row is not on this site.
 */
export async function setHandsetInstalled(s: Scoped, siteId: string, kind: 'user' | 'cap', id: string, installed: boolean, by: string | null): Promise<boolean> {
  const table = kind === 'user' ? 'discovery_users' : 'discovery_caps';
  const res = await s
    .updateTable(table)
    .set(installed ? { handset_installed_at: new Date().toISOString(), handset_installed_by: by } : { handset_installed_at: null, handset_installed_by: null })
    .where('id', '=', id)
    .where('site_id', '=', siteId)
    .executeTakeFirst();
  return Number(res.numUpdatedRows ?? 0) > 0;
}

/** Records the stage a model has reached; "not_ordered" removes the row. */
export async function setHandsetStage(s: Scoped, siteId: string, model: string, stage: HandsetStage, updatedBy: string | null): Promise<void> {
  const key = handsetModelKey(model);
  if (!key) return;
  if (stage === 'not_ordered') {
    await s.deleteFrom('site_handset_tracking').where('site_id', '=', siteId).where('model_key', '=', key).execute();
    return;
  }
  await s
    .insertInto('site_handset_tracking')
    .values({ site_id: siteId, model_key: key, status: stage, updated_by: updatedBy })
    .onConflict((oc) => oc.columns(['site_id', 'model_key']).doUpdateSet({ status: stage, updated_by: updatedBy, updated_at: new Date().toISOString() }))
    .execute();
}
