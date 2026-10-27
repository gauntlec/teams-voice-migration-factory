import type { Kysely } from 'kysely';
import { platformDb } from './index';
import type { DB } from './schema';

/**
 * The monitoring module's administrator, one per installation (platform migration 0037). Every customer's monitoring is looked after through this one
 * sign-in, so the first customer to set monitoring up makes it and the rest reuse it. The password is stored encrypted by the caller (the worker).
 */
export async function getMonitoringAdmin(db: Kysely<DB>): Promise<{ user: string; passEnc: string } | null> {
  const r = await platformDb(db).selectFrom('monitoring_admin').select(['admin_user', 'admin_pass_enc']).executeTakeFirst();
  return r ? { user: r.admin_user, passEnc: r.admin_pass_enc } : null;
}

export async function saveMonitoringAdmin(db: Kysely<DB>, user: string, passEnc: string, now = new Date()): Promise<void> {
  await platformDb(db)
    .insertInto('monitoring_admin')
    .values({ id: true, admin_user: user, admin_pass_enc: passEnc, updated_at: now.toISOString() })
    .onConflict((oc) => oc.column('id').doUpdateSet({ admin_user: user, admin_pass_enc: passEnc, updated_at: now.toISOString() }))
    .execute();
}
