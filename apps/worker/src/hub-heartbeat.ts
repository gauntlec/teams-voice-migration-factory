import type { Kysely } from 'kysely';
import { platformDb, type DB } from '@tvmf/db';
import { hubErrorText, type HubHeartbeat } from '@tvmf/shared';
import { decryptSecret } from './crypto';

/**
 * Reports this installation to its Voxshift Hub (Administration > Platform settings), once a minute: a version and a health word, nothing
 * else. Customer data never goes in here, and the hub's schema refuses any other field. Does nothing when no hub is connected.
 */
export const hubVersion = () => {
  const sha = (process.env.APP_VERSION ?? '').trim();
  return sha ? `0.1.0+${sha.slice(0, 7)}` : '0.1.0+dev';
};

export async function sendHubHeartbeat(db: Kysely<DB>, opts: { fetchFn?: typeof fetch; now?: Date } = {}): Promise<'skipped' | 'sent' | 'failed'> {
  const row = await platformDb(db).selectFrom('app_settings').select(['hub_url', 'hub_token_enc']).executeTakeFirst();
  if (!row?.hub_url || !row.hub_token_enc) return 'skipped';
  const fetchFn = opts.fetchFn ?? fetch;
  const at = (opts.now ?? new Date()).toISOString();
  const body: HubHeartbeat = { version: hubVersion(), health: 'ok', uptimeSeconds: Math.round(process.uptime()) };

  let error: string | null = null;
  try {
    const res = await fetchFn(`${row.hub_url}/api/v1/heartbeat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${decryptSecret(row.hub_token_enc)}` },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) error = hubErrorText(res.status);
  } catch (e) {
    // The message of a network error holds no secret (the token is only in the header), but keep it short.
    error = hubErrorText(null, (e as Error).message.slice(0, 120));
  }
  await platformDb(db)
    .updateTable('app_settings')
    .set(error ? { hub_last_attempt_at: at, hub_last_error: error } : { hub_last_attempt_at: at, hub_last_ok_at: at, hub_last_error: null })
    .where('id', '=', true)
    .execute();
  return error ? 'failed' : 'sent';
}
