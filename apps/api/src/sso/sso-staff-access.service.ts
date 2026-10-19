import { ConflictException, ForbiddenException, Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { endHubSessionsOf, platformDb, sweepStaffAccess } from '@tvmf/db';
import {
  ROLE_LABELS,
  STAFF_ACCESS_DENIED_COOLDOWN_MINUTES,
  STAFF_ACCESS_REQUEST_MINUTES,
  STAFF_WAIT_PATH,
  type Role,
  type SsoStaffAccessRequestContext,
  type StaffAccessOverview,
  type StaffAccessRequestView,
  type StaffWaitStatus,
} from '@tvmf/shared';
import { AuditService, type AuditActor } from '../common/audit.service';
import { APP_CONFIG, type AppConfig } from '../common/config';
import { randomToken } from './oidc/oidc-client';
import { sha256 } from '../common/crypto';
import { InjectDb, type Db } from '../db/db.module';
import { MailService } from '../mail/mail.service';

interface Meta {
  ip?: string;
  userAgent?: string;
}

export interface BeginAccessRequest {
  providerId: string;
  userId: string;
  subject: string;
  email: string;
  displayName: string | null;
  requestedRole: Role;
  effectiveRole: Role;
  amr: string[];
  providerSessionId: string | null;
  returnTo: string;
  meta: Meta;
}

type RequestRow = Awaited<ReturnType<SsoStaffAccessService['rows']>>[number];

const iso = (v: string | Date | null | undefined): string | null => (v ? new Date(v).toISOString() : null);
const minutes = (n: number) => n * 60_000;

/**
 * Customer-approved, time-limited access for Voxshift hub STAFF accounts (docs/SSO.md 4.3a). In "needs approval" mode a staff sign-in does not
 * get a session: it becomes a request, the administrators of this installation are emailed, the person waits on a page, and an administrator
 * approves it for a time they choose (default 4 hours, at most 24) or denies it. An approved window ends exactly when it says: the person's
 * identity carries the end time (`access_until`), which the request guard checks on every call, and a session started from it is capped to it.
 *
 * Who decides: an administrator who did not come in through the Voxshift Hub. Otherwise the staff person asking, or a colleague, could approve themselves.
 */
@Injectable()
export class SsoStaffAccessService {
  private readonly log = new Logger(SsoStaffAccessService.name);

  constructor(
    @InjectDb() private readonly db: Db,
    @Inject(APP_CONFIG) private readonly cfg: AppConfig,
    private readonly audit: AuditService,
    private readonly mail: MailService,
  ) {}

  private rows() {
    return platformDb(this.db)
      .selectFrom('sso_access_requests as r')
      .leftJoin('users as d', 'd.id', 'r.decided_by')
      .leftJoin('users as e', 'e.id', 'r.ended_by')
      .selectAll('r')
      .select(['d.display_name as decided_by_name', 'e.display_name as ended_by_name'])
      .orderBy('r.requested_at', 'desc')
      .limit(300)
      .execute();
  }

  private view(r: RequestRow): StaffAccessRequestView {
    return {
      id: r.id,
      displayName: r.display_name,
      email: r.email,
      requestedRole: r.requested_role as Role,
      effectiveRole: r.effective_role as Role,
      ip: r.ip,
      providerSessionId: r.provider_session,
      requestedAt: iso(r.requested_at)!,
      requestExpiresAt: iso(r.request_expires_at)!,
      status: r.status,
      decidedByName: r.decided_by_name,
      decidedAt: iso(r.decided_at),
      decisionNote: r.decision_note,
      windowHours: r.window_hours,
      windowEndsAt: iso(r.window_ends_at),
      signedIn: !!r.claimed_at,
      endedAt: iso(r.ended_at),
      endedByName: r.ended_by_name,
    };
  }

  /** What the administrators' screen shows: waiting requests, running windows, and the latest finished ones. */
  async overview(): Promise<StaffAccessOverview> {
    await sweepStaffAccess(this.db);
    const hub = await platformDb(this.db).selectFrom('sso_providers').select('staff_access').where('kind', '=', 'hub').executeTakeFirst();
    const all = (await this.rows()).map((r) => this.view(r));
    return {
      mode: hub?.staff_access ?? null,
      pending: all.filter((r) => r.status === 'pending').reverse(),
      windows: all.filter((r) => r.status === 'approved'),
      recent: all.filter((r) => r.status !== 'pending' && r.status !== 'approved').slice(0, 20),
    };
  }

  /** The end of this person's running approved window, or null if they have none. */
  async activeWindow(providerId: string, userId: string): Promise<Date | null> {
    await sweepStaffAccess(this.db);
    const r = await platformDb(this.db)
      .selectFrom('sso_access_requests')
      .select('window_ends_at')
      .where('provider_id', '=', providerId)
      .where('user_id', '=', userId)
      .where('status', '=', 'approved')
      .where('window_ends_at', '>', new Date().toISOString())
      .orderBy('window_ends_at', 'desc')
      .executeTakeFirst();
    return r?.window_ends_at ? new Date(r.window_ends_at) : null;
  }

  /**
   * A staff sign-in has been verified and the person has no running window: make (or find) the request and hand back the token the waiting
   * browser keeps in a cookie. The administrators are emailed once per request. A person who asks again while waiting keeps the same request;
   * one who was just denied is shown the denial again instead of starting a new request (so a refusal cannot be turned into a stream of emails).
   */
  async begin(a: BeginAccessRequest): Promise<{ waitToken: string; requestId: string; created: boolean }> {
    await sweepStaffAccess(this.db);
    const t = platformDb(this.db);
    const waitToken = randomToken();
    const hash = sha256(waitToken);
    const details = { requested_role: a.requestedRole, effective_role: a.effectiveRole, amr: a.amr, provider_session: a.providerSessionId, ip: a.meta.ip ?? null, user_agent: (a.meta.userAgent ?? '').slice(0, 300) || null, return_to: a.returnTo };

    const existing = await t
      .selectFrom('sso_access_requests')
      .select(['id', 'status', 'decided_at'])
      .where('provider_id', '=', a.providerId)
      .where('user_id', '=', a.userId)
      .where((eb) =>
        eb.or([
          eb('status', '=', 'pending'),
          eb.and([eb('status', '=', 'denied'), eb('decided_at', '>', new Date(Date.now() - minutes(STAFF_ACCESS_DENIED_COOLDOWN_MINUTES)).toISOString())]),
        ]),
      )
      .orderBy('requested_at', 'desc')
      .executeTakeFirst();
    if (existing) {
      await t.updateTable('sso_access_requests').set({ wait_token_hash: hash, ...(existing.status === 'pending' ? details : { return_to: a.returnTo }) }).where('id', '=', existing.id).execute();
      return { waitToken, requestId: existing.id, created: false };
    }

    const created = await t
      .insertInto('sso_access_requests')
      .values({
        provider_id: a.providerId,
        user_id: a.userId,
        subject: a.subject,
        email: a.email,
        display_name: a.displayName,
        wait_token_hash: hash,
        request_expires_at: new Date(Date.now() + minutes(STAFF_ACCESS_REQUEST_MINUTES)).toISOString(),
        ...details,
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    await this.audit.platform('sso.access.requested', {
      actor: { id: a.userId, email: a.email, ip: a.meta.ip },
      targetType: 'user',
      targetId: a.userId,
      detail: { requestId: created.id, subject: a.subject, requestedRole: a.requestedRole, role: a.effectiveRole, providerSessionId: a.providerSessionId },
    });
    await this.notifyAdministrators(created.id, a);
    return { waitToken, requestId: created.id, created: true };
  }

  /** Everyone who can decide is told by email: active administrators who are not themselves hub people. Never stops the request. */
  private async notifyAdministrators(requestId: string, a: BeginAccessRequest): Promise<void> {
    try {
      const admins = await platformDb(this.db)
        .selectFrom('users as u')
        .select(['u.id', 'u.email', 'u.display_name'])
        .where('u.role', '=', 'SUPER_ADMIN')
        .where('u.status', '=', 'active')
        .where(({ not, exists, selectFrom }) =>
          not(
            exists(
              selectFrom('external_identities as i')
                .innerJoin('sso_providers as p', 'p.id', 'i.provider_id')
                .select('i.id')
                .whereRef('i.user_id', '=', 'u.id')
                .where('p.kind', '=', 'hub'),
            ),
          ),
        )
        .execute();
      const origin = this.cfg.WEB_ORIGIN.replace(/\/+$/, '');
      const context: SsoStaffAccessRequestContext = {
        displayName: a.displayName ?? a.email,
        email: a.email,
        role: ROLE_LABELS[a.effectiveRole],
        at: new Date().toISOString().replace('T', ' ').slice(0, 19) + ' UTC',
        ip: a.meta.ip ?? null,
        installation: origin,
        reviewUrl: `${origin}/admin/settings/sso`,
      };
      for (const admin of admins) {
        await this.mail.enqueue({ template: 'sso_staff_access_request', to: { email: admin.email, name: admin.display_name }, context: context as unknown as Record<string, unknown>, related: { type: 'user', id: a.userId } });
      }
    } catch (err) {
      this.log.warn(`Could not email the administrators about a staff access request (${requestId}): ${(err as Error).message}`);
    }
  }

  /** What the waiting page asks, with the cookie the browser holds. Says nothing about anyone else's request. */
  async waitStatus(waitToken: string | undefined): Promise<StaffWaitStatus> {
    const installation = this.cfg.WEB_ORIGIN.replace(/\/+$/, '');
    if (!waitToken) return { state: 'unknown', until: null, installation };
    await sweepStaffAccess(this.db);
    const r = await platformDb(this.db)
      .selectFrom('sso_access_requests')
      .select(['status', 'request_expires_at', 'window_ends_at', 'claimed_at'])
      .where('wait_token_hash', '=', sha256(waitToken))
      .executeTakeFirst();
    if (!r) return { state: 'unknown', until: null, installation };
    // Approved but already used (the session was started from it): the page has nothing more to do.
    if (r.status === 'approved' && r.claimed_at) return { state: 'unknown', until: null, installation };
    return { state: r.status === 'pending' ? 'pending' : r.status === 'approved' ? 'approved' : r.status, until: iso(r.status === 'approved' ? r.window_ends_at : r.request_expires_at), installation };
  }

  /* ----------------------------- the administrators' side ----------------------------- */

  /** Whoever decides must not have come in through the Voxshift Hub (see the class note). */
  async assertCanDecide(actor: { id?: string | null; idp?: string }): Promise<void> {
    if (!actor.idp) return;
    const hub = await platformDb(this.db).selectFrom('sso_providers').select('id').where('kind', '=', 'hub').executeTakeFirst();
    if (hub && hub.id === actor.idp) {
      throw new ForbiddenException('Access for Voxshift staff has to be decided by an administrator who signed in with their own account on this installation, not through the Voxshift Hub.');
    }
  }

  private async load(id: string) {
    await sweepStaffAccess(this.db);
    const r = await platformDb(this.db).selectFrom('sso_access_requests').selectAll().where('id', '=', id).executeTakeFirst();
    if (!r) throw new NotFoundException('That request is no longer here.');
    return r;
  }

  private async one(id: string): Promise<StaffAccessRequestView> {
    const r = (await this.rows()).find((x) => x.id === id);
    return this.view(r!);
  }

  async approve(id: string, hours: number, actor: AuditActor & { idp?: string }): Promise<StaffAccessRequestView> {
    await this.assertCanDecide(actor);
    const r = await this.load(id);
    if (r.status !== 'pending') throw new ConflictException(r.status === 'approved' ? 'That request has already been approved.' : 'That request can no longer be approved. Ask the person to sign in again.');
    const mode = (await platformDb(this.db).selectFrom('sso_providers').select('staff_access').where('id', '=', r.provider_id).executeTakeFirst())?.staff_access;
    if (mode !== 'needs_approval') throw new ConflictException('Staff access is not set to "Needs approval" any more, so there is nothing to approve.');
    const now = new Date();
    const ends = new Date(now.getTime() + hours * 3_600_000);
    // One statement, so two administrators pressing Approve at once give one window.
    const done = await platformDb(this.db)
      .updateTable('sso_access_requests')
      .set({ status: 'approved', decided_by: actor.id ?? null, decided_at: now.toISOString(), window_hours: hours, window_starts_at: now.toISOString(), window_ends_at: ends.toISOString() })
      .where('id', '=', id)
      .where('status', '=', 'pending')
      .returning('id')
      .executeTakeFirst();
    if (!done) throw new ConflictException('Someone else has just answered that request.');
    // The person's identity carries the end of the window; the guard refuses them from that moment on.
    await platformDb(this.db).updateTable('external_identities').set({ access_until: ends.toISOString() }).where('provider_id', '=', r.provider_id).where('user_id', '=', r.user_id).execute();
    await this.audit.platform('sso.access.approved', {
      actor,
      targetType: 'user',
      targetId: r.user_id,
      detail: { requestId: id, email: r.email, subject: r.subject, role: r.effective_role, windowHours: hours, windowEndsAt: ends.toISOString() },
    });
    return this.one(id);
  }

  async deny(id: string, note: string | undefined, actor: AuditActor & { idp?: string }): Promise<StaffAccessRequestView> {
    await this.assertCanDecide(actor);
    const r = await this.load(id);
    if (r.status !== 'pending') throw new ConflictException('That request has already been answered or has lapsed.');
    const done = await platformDb(this.db)
      .updateTable('sso_access_requests')
      .set({ status: 'denied', decided_by: actor.id ?? null, decided_at: new Date().toISOString(), decision_note: note || null })
      .where('id', '=', id)
      .where('status', '=', 'pending')
      .returning('id')
      .executeTakeFirst();
    if (!done) throw new ConflictException('Someone else has just answered that request.');
    await this.audit.platform('sso.access.denied', { actor, targetType: 'user', targetId: r.user_id, detail: { requestId: id, email: r.email, subject: r.subject, role: r.effective_role, note: note || null } });
    return this.one(id);
  }

  /** Ends a running window now: the person is signed out at once, and has to ask again. */
  async end(id: string, actor: AuditActor & { idp?: string }): Promise<StaffAccessRequestView> {
    await this.assertCanDecide(actor);
    const r = await this.load(id);
    if (r.status !== 'approved') throw new ConflictException('That access is not running any more.');
    const now = new Date();
    const done = await platformDb(this.db)
      .updateTable('sso_access_requests')
      .set({ status: 'ended', ended_at: now.toISOString(), ended_by: actor.id ?? null })
      .where('id', '=', id)
      .where('status', '=', 'approved')
      .returning('id')
      .executeTakeFirst();
    if (!done) throw new ConflictException('That access is not running any more.');
    await platformDb(this.db).updateTable('external_identities').set({ access_until: now.toISOString() }).where('provider_id', '=', r.provider_id).where('user_id', '=', r.user_id).execute();
    const ended = await endHubSessionsOf(this.db, r.provider_id, r.user_id, now);
    await this.audit.platform('sso.access.ended', {
      actor,
      targetType: 'user',
      targetId: r.user_id,
      detail: { requestId: id, email: r.email, subject: r.subject, reason: 'ended early by an administrator', sessionsEnded: ended, windowWouldHaveEnded: iso(r.window_ends_at) },
    });
    return this.one(id);
  }

  /** The path of the waiting page (exported for the controller's redirect). */
  static readonly waitPath = STAFF_WAIT_PATH;
}
