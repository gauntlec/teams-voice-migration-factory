import type { Kysely } from 'kysely';
import { applySsoRevocations, hubRevocationAck, platformDb, setHubRevocationAck, type DB } from '@tvmf/db';
import { buildHubHeartbeat, hubErrorText, parseHubRevocations, type HubHeartbeat } from '@tvmf/shared';
import { decryptSecret } from './crypto';

/**
 * Reports this installation to its Voxshift Hub (Administration > Platform settings), once a minute: a version, a health word, whether staff may open
 * this installation through the hub and whether hub sign-in is on: nothing else. Customer data never goes in here, and the hub's schema refuses any other field. Does nothing when no hub is connected.
 *
 * The hub's reply can name people whose access has ended (`ssoRevocations`, docs/SSO.md 5.3); they are signed out here and the highest line applied is sent back
 * as `ssoRevocationsAck` in the next report. That is how a removal at the hub reaches this installation within about a minute, with or without remote access.
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

/**
 * What to send as the revocation acknowledgement: the highest line applied so far, but only when a hub sign-in provider record exists here (nobody
 * could have signed in through the hub otherwise). Unknown (a database not yet migrated) is left out, like `sso`.
 */
export async function hubRevocationCursor(db: Kysely<DB>): Promise<number | undefined> {
  try {
    const has = await platformDb(db).selectFrom('sso_providers').select('id').where('kind', '=', 'hub').executeTakeFirst();
    return has ? await hubRevocationAck(db) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * A hub release from before the revocation channel refuses a heartbeat that carries a field it does not know (400). When that happens the report is
 * sent again without it, at once, and the field is left out for an hour before trying again (so the hub can be updated without anyone noticing).
 */
const REVOCATION_RETRY_AFTER_MS = 60 * 60_000;
let hubLacksRevocations: { hub: string; until: number } | null = null;
/** For tests: forget what was learned about the hub. */
export const resetHubRevocationSupport = () => { hubLacksRevocations = null; };

export async function sendHubHeartbeat(db: Kysely<DB>, opts: { fetchFn?: typeof fetch; now?: Date } = {}): Promise<'skipped' | 'sent' | 'failed'> {
  const row = await platformDb(db).selectFrom('app_settings').select(['hub_url', 'hub_token_enc', 'hub_remote_access']).executeTakeFirst();
  if (!row?.hub_url || !row.hub_token_enc) return 'skipped';
  const fetchFn = opts.fetchFn ?? fetch;
  const at = (opts.now ?? new Date()).toISOString();
  const nowMs = (opts.now ?? new Date()).getTime();
  const skipRevocations = hubLacksRevocations !== null && hubLacksRevocations.hub === row.hub_url && hubLacksRevocations.until > nowMs;
  const cursor = skipRevocations ? undefined : await hubRevocationCursor(db);
  const base = { version: hubVersion(), uptimeSeconds: Math.round(process.uptime()), remoteAccess: row.hub_remote_access, sso: await hubSsoEnabled(db) };
  const token = decryptSecret(row.hub_token_enc);
  const send = (body: HubHeartbeat) =>
    fetchFn(`${row.hub_url}/api/v1/heartbeat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    });

  let error: string | null = null;
  let mailRelay: boolean | null = null;
  let revocations: ReturnType<typeof parseHubRevocations> = { lines: [], maxId: 0 };
  let revocationsAsked = cursor !== undefined;
  try {
    let res = await send(buildHubHeartbeat({ ...base, ssoRevocationsAck: cursor }));
    if (res.status === 400 && cursor !== undefined) {
      // Only an older hub is blamed: if the report is refused without the field as well, the field was not the reason.
      const again = await send(buildHubHeartbeat(base));
      if (again.ok) hubLacksRevocations = { hub: row.hub_url, until: nowMs + REVOCATION_RETRY_AFTER_MS };
      res = again;
      revocationsAsked = false;
    }
    if (!res.ok) error = hubErrorText(res.status);
    else {
      // The hub's reply says whether its mail service is ready for this installation (shown in Platform settings > Email), and who has lost access.
      const reply = typeof res.json === 'function' ? ((await res.json().catch(() => null)) as { mailRelay?: unknown } | null) : null;
      if (typeof reply?.mailRelay === 'boolean') mailRelay = reply.mailRelay;
      if (revocationsAsked) revocations = parseHubRevocations(reply);
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
  // Applied after the report is recorded, and acknowledged only once applied: a failure here is tried again with the next report, never lost.
  if (!error && revocations.maxId > 0) {
    try {
      await applySsoRevocations(db, revocations.lines, { now: opts.now });
      await setHubRevocationAck(db, revocations.maxId);
    } catch (e) {
      console.warn('could not apply the hub revocations', (e as Error).message);
    }
  }
  return error ? 'failed' : 'sent';
}
