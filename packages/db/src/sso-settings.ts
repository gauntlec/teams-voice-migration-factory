import type { Kysely } from 'kysely';
import type { DB } from './schema';

/**
 * Single sign-on settings both the sign-in code and the settings screen read (docs/SSO.md). Not cached: they are read on a sign-in, not on
 * every request, and a change must apply at once.
 */

/** A password stored for an account that signs in only through a provider. It is not an argon2 hash, so no password can ever match it. */
export const FEDERATED_PASSWORD_HASH = '!federated';

export function hasUsablePassword(passwordHash: string): boolean {
  return !passwordHash.startsWith('!');
}

/**
 * May people sign in on this installation with a local password? Yes, unless an ENABLED provider has switched local passwords off
 * (a provider that is off cannot lock anyone out). Break-glass administrators are exempt: that is decided per user, not here.
 */
export async function localPasswordsAllowed(db: Kysely<DB>): Promise<boolean> {
  const row = await db
    .withSchema('platform')
    .selectFrom('sso_providers')
    .select('id')
    .where('enabled', '=', true)
    .where('allow_local_passwords', '=', false)
    .limit(1)
    .executeTakeFirst();
  return !row;
}

/** How long a federated session may last in total, in hours (Platform settings > Single sign-on). */
export async function ssoSessionMaxHours(db: Kysely<DB>): Promise<number> {
  const row = await db.withSchema('platform').selectFrom('app_settings').select('sso_session_max_hours').executeTakeFirst();
  return row?.sso_session_max_hours ?? 12;
}

/** Should administrators be emailed when someone signs in as Super Admin through a provider? On unless switched off. */
export async function ssoNotifyAdminSignin(db: Kysely<DB>): Promise<boolean> {
  const row = await db.withSchema('platform').selectFrom('app_settings').select('sso_notify_admin_signin').executeTakeFirst();
  return row?.sso_notify_admin_signin ?? true;
}
