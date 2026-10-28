import { handsetModelKey, summariseHandsets, type SiteHandsets, type HandsetStage } from '@tvmf/shared';
import type { Scoped } from './live-state';

/*
 * The handsets a site needs, counted from Data Collection: each user's handset model and each common area phone's device model, one row
 * per model with how many of each and the stage the project manager has recorded (site_handset_tracking, migration 0078).
 */

export async function siteHandsets(s: Scoped, siteId: string): Promise<SiteHandsets> {
  const [users, caps, tracking] = await Promise.all([
    s.selectFrom('discovery_users').select(['handset_model', 'requires_handset']).where('site_id', '=', siteId).execute(),
    s.selectFrom('discovery_caps').select('device_model').where('site_id', '=', siteId).execute(),
    s.selectFrom('site_handset_tracking').select(['model_key', 'status', 'updated_by', 'updated_at']).where('site_id', '=', siteId).execute(),
  ]);
  const withoutModel = users.filter((u) => u.requires_handset && !handsetModelKey(u.handset_model)).length;
  return summariseHandsets(
    users.map((u) => u.handset_model),
    caps.map((c) => c.device_model),
    tracking,
    withoutModel,
  );
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
