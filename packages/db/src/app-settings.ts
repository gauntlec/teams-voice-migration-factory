import type { Kysely } from 'kysely';
import type { DB } from './schema';

/**
 * Platform settings a Super Admin changes on Administration > Platform settings (platform.app_settings, one row):
 * the base URL and the email switch. Cached for 30 seconds so the worker can ask on every email without a query each
 * time; the API forgets the cache on a save, so its own process sees a change at once.
 */
interface Settings {
  base_url: string | null;
  email_enabled: boolean;
}
let cache: { at: number; value: Settings } | null = null;
const TTL_MS = 30_000;

async function load(db: Kysely<DB>, fresh?: boolean): Promise<Settings> {
  if (!fresh && cache && Date.now() - cache.at < TTL_MS) return cache.value;
  const row = await db.withSchema('platform').selectFrom('app_settings').select(['base_url', 'email_enabled']).executeTakeFirst();
  cache = { at: Date.now(), value: { base_url: row?.base_url ?? null, email_enabled: row?.email_enabled ?? true } };
  return cache.value;
}

export function forgetAppSettings(): void {
  cache = null;
}

/** The saved base URL, or null when none is saved (the WEB_ORIGIN environment value applies). */
export async function savedBaseUrl(db: Kysely<DB>, opts: { fresh?: boolean } = {}): Promise<string | null> {
  return (await load(db, opts.fresh)).base_url;
}

/** The effective address: the saved setting, else WEB_ORIGIN. A failed read falls back to the environment value. No trailing slash. */
export async function webOrigin(db: Kysely<DB>, env: string | undefined = process.env.WEB_ORIGIN): Promise<string> {
  let saved: string | null = null;
  try {
    saved = await savedBaseUrl(db);
  } catch {
    saved = null;
  }
  return (saved ?? env ?? '').replace(/\/+$/, '');
}

/** False when a Super Admin has switched email off. A failed read means "on", so a database blip never silences mail by itself. */
export async function emailEnabled(db: Kysely<DB>, opts: { fresh?: boolean } = {}): Promise<boolean> {
  try {
    return (await load(db, opts.fresh)).email_enabled;
  } catch {
    return true;
  }
}
