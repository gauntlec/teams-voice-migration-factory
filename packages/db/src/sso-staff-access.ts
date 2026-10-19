import { sql, type Kysely } from 'kysely';
import type { DB } from './schema';
import { writePlatformAudit } from './platform-audit';

/**
 * Customer-approved, time-limited access for Voxshift hub STAFF accounts (docs/SSO.md 4.3a): what ends a window or a request, and what
 * changing the setting does. The interactive parts (a request, approving, the waiting page) are in apps/api/src/sso/sso-staff-access.service.ts.
 * Both the worker (every minute) and the API (whenever the requests are looked at) call `sweepStaffAccess`, so nothing depends on one of them running.
 */

type Db = Kysely<DB>;

/** Ends every hub sign-in of one person: the refresh cookies are revoked, and the guard stops any access token they still hold. Returns how many sessions ended. */
export async function endHubSessionsOf(db: Db, providerId: string, userId: string, at: Date = new Date()): Promise<number> {
  const ended = await sql<{ id: string }>`
    UPDATE platform.auth_sessions SET revoked_at = ${at.toISOString()}::timestamptz
    WHERE user_id = ${userId} AND idp = ${providerId} AND revoked_at IS NULL
    RETURNING id`.execute(db);
  return ended.rows.length;
}

export interface SweepResult {
  windowsExpired: number;
  requestsExpired: number;
}

/**
 * Closes what has run out: approved windows whose time is up (the person is signed out; the guard already refuses them from that very second,
 * because their identity's `access_until` has passed), and requests nobody answered. Each is written to the audit log as `sso.access.expired`.
 * Safe to run at any moment, by any number of processes.
 */
export async function sweepStaffAccess(db: Db, now: Date = new Date()): Promise<SweepResult> {
  const t = db.withSchema('platform');
  const result: SweepResult = { windowsExpired: 0, requestsExpired: 0 };

  const windows = await t
    .updateTable('sso_access_requests')
    .set({ status: 'expired', ended_at: now.toISOString() })
    .where('status', '=', 'approved')
    .where('window_ends_at', '<=', now.toISOString())
    .returning(['id', 'provider_id', 'user_id', 'email', 'subject', 'window_hours', 'window_ends_at', 'claimed_at'])
    .execute();
  for (const w of windows) {
    const ended = await endHubSessionsOf(db, w.provider_id, w.user_id, now);
    result.windowsExpired += 1;
    await writePlatformAudit(db, {
      action: 'sso.access.expired',
      targetType: 'user',
      targetId: w.user_id,
      at: now,
      detail: { stage: 'window', requestId: w.id, email: w.email, subject: w.subject, windowHours: w.window_hours, windowEndedAt: w.window_ends_at, signedIn: !!w.claimed_at, sessionsEnded: ended },
    });
  }

  const requests = await t
    .updateTable('sso_access_requests')
    .set({ status: 'expired', ended_at: now.toISOString() })
    .where('status', '=', 'pending')
    .where('request_expires_at', '<=', now.toISOString())
    .returning(['id', 'user_id', 'email', 'subject', 'requested_at'])
    .execute();
  for (const r of requests) {
    result.requestsExpired += 1;
    await writePlatformAudit(db, {
      action: 'sso.access.expired',
      targetType: 'user',
      targetId: r.user_id,
      at: now,
      detail: { stage: 'request', requestId: r.id, email: r.email, subject: r.subject, requestedAt: r.requested_at, reason: 'nobody answered in time' },
    });
  }
  return result;
}

/**
 * The setting on the hub provider has just been changed from `from` to `to` by `actor`. What follows from that:
 *  - to `allowed`: nothing is waiting any more (pending requests and running windows are closed as cancelled) and no staff window limits anyone.
 *  - to a tighter mode from `allowed`: every hub STAFF person signed in under the old rule is signed out now (the customer's own people are not).
 *  - to `off`: waiting requests and running windows are closed, and anyone signed in through a window is signed out now.
 * Every request closed here is audited as `sso.access.ended`; every person signed out as `sso.revoked` (reason `staff-access-restricted`).
 */
export async function staffAccessModeChanged(
  db: Db,
  p: { providerId: string; from: 'allowed' | 'needs_approval' | 'off'; to: 'allowed' | 'needs_approval' | 'off'; actor: { id?: string | null; email?: string | null }; now?: Date },
): Promise<{ closed: number; signedOut: number }> {
  const now = p.now ?? new Date();
  const t = db.withSchema('platform');
  let closed = 0;
  let signedOut = 0;

  const closeAll = async () => {
    const rows = await t
      .updateTable('sso_access_requests')
      .set({ status: 'cancelled', ended_at: now.toISOString(), ended_by: p.actor.id ?? null })
      .where('provider_id', '=', p.providerId)
      .where('status', 'in', ['pending', 'approved'])
      .returning(['id', 'user_id', 'email', 'status', 'window_ends_at'])
      .execute();
    for (const r of rows) {
      closed += 1;
      await writePlatformAudit(db, {
        action: 'sso.access.ended',
        actorUserId: p.actor.id ?? null,
        actorEmail: p.actor.email ?? null,
        targetType: 'user',
        targetId: r.user_id,
        at: now,
        detail: { requestId: r.id, email: r.email, reason: 'the setting for Voxshift staff access was changed', newMode: p.to },
      });
    }
  };

  if (p.to === 'allowed') {
    await closeAll();
    // no window limits anybody any more
    await t.updateTable('external_identities').set({ access_until: null }).where('provider_id', '=', p.providerId).execute();
    return { closed, signedOut };
  }

  await closeAll();
  if (p.to === 'off' || p.from === 'allowed') {
    // everyone on a staff account who is in through this provider goes now (the customer's own people keep their sessions)
    const staff = await t
      .selectFrom('external_identities')
      .select(['id', 'user_id', 'subject', 'email'])
      .where('provider_id', '=', p.providerId)
      .where((eb) => eb.or([eb('account_kind', 'is', null), eb('account_kind', '<>', 'customer')]))
      .execute();
    for (const s of staff) {
      await t.updateTable('external_identities').set({ revoked_before: now.toISOString(), access_until: null }).where('id', '=', s.id).execute();
      const ended = await endHubSessionsOf(db, p.providerId, s.user_id, now);
      if (ended > 0) {
        signedOut += 1;
        await writePlatformAudit(db, {
          action: 'sso.revoked',
          actorUserId: p.actor.id ?? null,
          actorEmail: p.actor.email ?? null,
          targetType: 'user',
          targetId: s.user_id,
          at: now,
          detail: { reason: 'staff-access-restricted', providerId: p.providerId, subject: s.subject, email: s.email, sessionsEnded: ended, newMode: p.to },
        });
      }
    }
  }
  return { closed, signedOut };
}
