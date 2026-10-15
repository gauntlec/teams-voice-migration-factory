import type { Kysely } from 'kysely';
import type { DB } from './schema';

/**
 * The address people use to reach this installation (Administration > Web address), read from
 * platform.app_settings, else the WEB_ORIGIN environment value, else ''. Cached for 30 seconds so
 * the worker can ask on every email without a query each time; the API refreshes it on a save.
 * No trailing slash.
 */
let cache: { at: number; value: string | null } | null = null;
const TTL_MS = 30_000;

export async function savedBaseUrl(db: Kysely<DB>, opts: { fresh?: boolean } = {}): Promise<string | null> {
  if (!opts.fresh && cache && Date.now() - cache.at < TTL_MS) return cache.value;
  const row = await db.withSchema('platform').selectFrom('app_settings').select('base_url').executeTakeFirst();
  cache = { at: Date.now(), value: row?.base_url ?? null };
  return cache.value;
}

export function forgetBaseUrl(): void {
  cache = null;
}

/** The effective address: the saved setting, else WEB_ORIGIN. A failed read falls back to the environment value. */
export async function webOrigin(db: Kysely<DB>, env: string | undefined = process.env.WEB_ORIGIN): Promise<string> {
  let saved: string | null = null;
  try {
    saved = await savedBaseUrl(db);
  } catch {
    saved = null;
  }
  return (saved ?? env ?? '').replace(/\/+$/, '');
}
