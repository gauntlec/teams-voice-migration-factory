import { createHash } from 'node:crypto';
import type { Kysely } from 'kysely';
import { platformDb, type DB } from '@tvmf/db';

/**
 * Single use of authorization codes and ID tokens (docs/SSO.md 4.2). Returns true the FIRST time a value is seen and false every time
 * after, until it would have expired anyway. Kept in Postgres so it holds across several API processes.
 */
export async function consumeOnce(db: Kysely<DB>, kind: 'code' | 'jti', providerId: string, value: string, ttlMs: number): Promise<boolean> {
  const key = createHash('sha256').update(`${kind}:${providerId}:${value}`).digest('hex');
  // Tidy up now and then; a row is only useful until its token would have expired.
  if (Math.random() < 0.05) await platformDb(db).deleteFrom('sso_replay_guard').where('expires_at', '<', new Date().toISOString()).execute();
  const r = await platformDb(db)
    .insertInto('sso_replay_guard')
    .values({ key, expires_at: new Date(Date.now() + ttlMs).toISOString() })
    .onConflict((oc) => oc.column('key').doNothing())
    .returning('key')
    .executeTakeFirst();
  return !!r;
}
