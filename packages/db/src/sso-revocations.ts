import { sql, type Kysely } from 'kysely';
import type { DB } from './schema';
import { hasUsablePassword } from './sso-settings';

/**
 * Applying the hub's revocation channel (docs/SSO.md 4.7 and 5.3). The worker calls this with the lines from a heartbeat reply. Safe to run
 * again with the same lines (the hub repeats them until they are acknowledged, and replays a week of them after a restore).
 */

/** The reason codes written to the audit log (`sso.revoked`). */
export const HUB_REVOKE_AUDIT_REASON = {
  grant_removed: 'hub-grant-removed',
  user_disabled: 'hub-user-disabled',
  sessions_revoked: 'hub-session-revoked',
  role_changed: 'hub-role-changed',
} as const;

export interface RevocationLine {
  id: number;
  sub: string;
  before: string;
  reason: keyof typeof HUB_REVOKE_AUDIT_REASON;
}

export interface RevocationResult {
  /** Lines that named somebody who has an identity here. */
  applied: number;
  /** Provider sessions ended. */
  sessionsEnded: number;
}

/** A `before` further ahead than this is clamped: a cut-off in the future would keep a person out of every sign-in until then. */
const FUTURE_SLACK_MS = 60_000;

/**
 * What a line does here, in order:
 *  - Sign-ins through the hub that began before `before` are over: the identity gets a cut-off (`revoked_before`, which the request guard checks, so
 *    an access token already issued stops working at once) and the refresh cookies of those sign-ins are revoked.
 *  - `grant_removed` (the person's access to this installation was taken away at the hub) also removes what the person could use:
 *    an account that exists only through the provider is switched off; a local account that was linked to the hub identity (it has its own
 *    password) is unlinked and otherwise left alone. If the person has signed in again since (access was given back), only the sessions step applies.
 *  - `user_disabled`, `sessions_revoked` and `role_changed` end the sessions and nothing else: the hub will not vouch for a disabled person, and
 *    after a role change the next sign-in simply gets the new role.
 * Nothing happens for a person this installation has never seen, and break-glass accounts are never federated, so they are never touched.
 */
export async function applySsoRevocations(db: Kysely<DB>, lines: RevocationLine[], opts: { now?: Date } = {}): Promise<RevocationResult> {
  const now = opts.now ?? new Date();
  const result: RevocationResult = { applied: 0, sessionsEnded: 0 };
  const p = db.withSchema('platform');
  const hub = await p.selectFrom('sso_providers').select('id').where('kind', '=', 'hub').executeTakeFirst();
  if (!hub) return result;

  for (const line of [...lines].sort((a, b) => a.id - b.id)) {
    const asked = new Date(line.before);
    if (Number.isNaN(asked.getTime())) continue;
    const before = new Date(Math.min(asked.getTime(), now.getTime() + FUTURE_SLACK_MS));

    await db.transaction().execute(async (trx) => {
      const t = trx.withSchema('platform');
      const identity = await t
        .selectFrom('external_identities as i')
        .innerJoin('users as u', 'u.id', 'i.user_id')
        .select(['i.id as identityId', 'i.subject', 'i.revoked_before', 'i.last_login_at', 'u.id as userId', 'u.email', 'u.status', 'u.break_glass', 'u.password_hash'])
        .where('i.provider_id', '=', hub.id)
        .where('i.subject', '=', line.sub)
        .forUpdate()
        .executeTakeFirst();
      if (!identity || identity.break_glass) return;
      result.applied += 1;

      const cutoffMoved = !identity.revoked_before || new Date(identity.revoked_before).getTime() < before.getTime();
      if (cutoffMoved) await t.updateTable('external_identities').set({ revoked_before: before.toISOString() }).where('id', '=', identity.identityId).execute();

      // Every sign-in through the hub that began before `before`. A refresh makes a new row in the same family, so the family's first row says when it began.
      const ended = await sql<{ id: string }>`
        UPDATE platform.auth_sessions SET revoked_at = now()
        WHERE user_id = ${identity.userId} AND idp = ${hub.id} AND revoked_at IS NULL
          AND family_id IN (
            SELECT family_id FROM platform.auth_sessions
            WHERE user_id = ${identity.userId} AND idp = ${hub.id}
            GROUP BY family_id HAVING min(created_at) < ${before.toISOString()}::timestamptz)
        RETURNING id`.execute(trx);
      result.sessionsEnded += ended.rows.length;

      let accountDisabled = false;
      let unlinked = false;
      const signedInSince = identity.last_login_at !== null && new Date(identity.last_login_at).getTime() > before.getTime();
      if (line.reason === 'grant_removed' && !signedInSince) {
        if (hasUsablePassword(identity.password_hash)) {
          await t.deleteFrom('external_identities').where('id', '=', identity.identityId).execute();
          await t.deleteFrom('sso_link_requests').where('provider_id', '=', hub.id).where('subject', '=', line.sub).execute();
          unlinked = true;
        } else if (identity.status === 'active') {
          await t.updateTable('users').set({ status: 'disabled', updated_at: now.toISOString() }).where('id', '=', identity.userId).execute();
          accountDisabled = true;
        }
      }

      if (cutoffMoved || ended.rows.length > 0 || accountDisabled || unlinked) {
        await t
          .insertInto('platform_audit_log')
          .values({
            action: 'sso.revoked',
            actor_user_id: null,
            actor_email: null,
            target_type: 'user',
            target_id: identity.userId,
            tenant_id: null,
            ip: null,
            detail: {
              reason: HUB_REVOKE_AUDIT_REASON[line.reason],
              source: 'hub',
              providerId: hub.id,
              subject: line.sub,
              email: identity.email,
              sessionsEnded: ended.rows.length,
              accountDisabled,
              identityRemoved: unlinked,
              hubLine: line.id,
            } as object,
            at: now.toISOString(),
          })
          .execute();
      }
    });
  }
  return result;
}

/** The highest hub revocation line applied so far (0 = none). */
export async function hubRevocationAck(db: Kysely<DB>): Promise<number> {
  const row = await db.withSchema('platform').selectFrom('app_settings').select('hub_sso_revocation_ack').executeTakeFirst();
  return Number(row?.hub_sso_revocation_ack ?? 0);
}

/** Remembers the highest line applied. The hub's numbering is the authority (a hub restored from an older copy numbers from a lower point), so this simply stores what it is given. */
export async function setHubRevocationAck(db: Kysely<DB>, ack: number): Promise<void> {
  await db.withSchema('platform').updateTable('app_settings').set({ hub_sso_revocation_ack: ack }).where('id', '=', true).execute();
}
