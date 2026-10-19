import type { Kysely } from 'kysely';
import { platformDb, type DB } from '@tvmf/db';
import { buildHubHeartbeat, hubErrorText, type HubHeartbeat } from '@tvmf/shared';
import { decryptSecret } from './crypto';

/**
 * Reports this installation to its Voxshift Hub (Administration > Platform settings), once a minute: a version, a health word, whether staff may open
 * this installation through the hub and whether hub sign-in is on: nothing else. Customer data never goes in here, and the hub's schema refuses any other field. Does nothing when no hub is connected.
 */
/** This installation's release number, yyyy.mm.N (set at image build); "dev" for a hand-built image. */
export const hubVersion = () => (process.env.APP_VERSION ?? '').trim() || 'dev';

/**
 * Is hub sign-in switched on here? True only when the `hub` provider row exists and is enabled. If the table is missing (a database not yet
 * migrated) or the query fails, the answer is "unknown" (undefined) and the heartbeat simply leaves the field out.
 */
export async function hubSsoEnabled(db: Kysely<DB>): Promise<boolean | undefined> {
  try {
    const row = await platformDb(db).selectFrom('sso_providers').select('enabled').where('kind', '=', 'hub').executeTakeFirst();
    return row?.enabled ?? false;
  } catch {
    return undefined;
  }
}

export async function sendHubHeartbeat(db: Kysely<DB>, opts: { fetchFn?: typeof fetch; now?: Date } = {}): Promise<'skipped' | 'sent' | 'failed'> {
  const row = await platformDb(db).selectFrom('app_settings').select(['hub_url', 'hub_token_enc', 'hub_remote_access']).executeTakeFirst();
  if (!row?.hub_url || !row.hub_token_enc) return 'skipped';
  const fetchFn = opts.fetchFn ?? fetch;
  const at = (opts.now ?? new Date()).toISOString();
  const body: HubHeartbeat = buildHubHeartbeat({ version: hubVersion(), uptimeSeconds: Math.round(process.uptime()), remoteAccess: row.hub_remote_access, sso: await hubSsoEnabled(db) });

  let error: string | null = null;
  let mailRelay: boolean | null = null;
  try {
    const res = await fetchFn(`${row.hub_url}/api/v1/heartbeat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${decryptSecret(row.hub_token_enc)}` },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) error = hubErrorText(res.status);
    else {
      // The hub's reply says whether its mail service is ready for this installation (shown in Platform settings > Email).
      const reply = typeof res.json === 'function' ? ((await res.json().catch(() => null)) as { mailRelay?: unknown } | null) : null;
      if (typeof reply?.mailRelay === 'boolean') mailRelay = reply.mailRelay;
    }
  } catch (e) {
    // The message of a network error holds no secret (the token is only in the header), but keep it short.
    error = hubErrorText(null, (e as Error).message.slice(0, 120));
  }
  await platformDb(db)
    .updateTable('app_settings')
    .set(error ? { hub_last_attempt_at: at, hub_last_error: error } : { hub_last_attempt_at: at, hub_last_ok_at: at, hub_last_error: null, ...(mailRelay !== null ? { hub_mail_relay: mailRelay } : {}) })
    .where('id', '=', true)
    .execute();
  return error ? 'failed' : 'sent';
}
