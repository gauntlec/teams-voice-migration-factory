import {
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import * as argon2 from 'argon2';
import { platformDb } from '@tvmf/db';
import type { Branding, Me } from '@tvmf/shared';
import { AuditService } from '../common/audit.service';
import { decryptSecret, encryptSecret } from '../common/crypto';
import { resolveMspId } from '../common/msp-resolution.util';
import { InjectDb, type Db } from '../db/db.module';
import { TokenService } from './token.service';
import { TotpService } from './totp.service';

const ARGON = { type: argon2.argon2id, memoryCost: 19456, timeCost: 2, parallelism: 1 } as const;
const MAX_FAILED = 10;
const LOCK_MINUTES = 15;

interface Meta {
  userAgent?: string;
  ip?: string;
}

@Injectable()
export class AuthService {
  constructor(
    @InjectDb() private readonly db: Db,
    private readonly tokens: TokenService,
    private readonly totp: TotpService,
    private readonly audit: AuditService,
  ) {}

  async login(email: string, password: string, totpCode: string | undefined, meta: Meta) {
    const user = await platformDb(this.db)
      .selectFrom('users')
      .selectAll()
      .where('email', '=', email)
      .executeTakeFirst();

    // Uniform failure to avoid user enumeration.
    const fail = async (reason: string) => {
      await this.audit.platform('auth.login.failed', {
        actor: { email, ip: meta.ip },
        detail: { reason },
      });
      throw new UnauthorizedException('Invalid credentials');
    };

    if (!user) {
      await argon2.hash(password, ARGON).catch(() => undefined); // timing padding
      return fail('unknown-user');
    }
    if (user.status !== 'active') return fail('disabled');
    if (user.locked_until && new Date(user.locked_until).getTime() > Date.now()) {
      return fail('locked');
    }

    const ok = await argon2.verify(user.password_hash, password).catch(() => false);
    if (!ok) {
      await this.recordFailedAttempt(user.id, user.failed_logins);
      return fail('bad-password');
    }

    // NB: failed_logins is deliberately NOT reset here. A correct password is
    // only half of a login when TOTP is enrolled - resetting the counter now
    // would let a stolen password grind the TOTP code with a fresh 10-attempt
    // budget on every single request. The counter is shared across both
    // factors and only cleared once the attempt fully succeeds (below, and in
    // the must-change-password / enrol-required branches, which don't gate on
    // a second secret so there's nothing left to brute-force there).

    // Invited users sign in with a one-time password and must choose a new one
    // before anything else (including MFA enrolment).
    if (user.must_change_password) {
      const { token } = this.tokens.signAccess({
        sub: user.id,
        role: user.role,
        email: user.email,
        typ: 'pwreset',
      });
      await this.clearFailedAttempts(user.id, user.failed_logins);
      await this.audit.platform('auth.login.pwreset_required', {
        actor: { id: user.id, email: user.email, ip: meta.ip },
      });
      return { passwordResetRequired: true as const, accessToken: token };
    }

    if (!user.totp_enrolled) {
      const { token } = this.tokens.signAccess({
        sub: user.id,
        role: user.role,
        email: user.email,
        typ: 'enrol',
      });
      await this.clearFailedAttempts(user.id, user.failed_logins);
      await this.audit.platform('auth.login.enrol_required', {
        actor: { id: user.id, email: user.email, ip: meta.ip },
      });
      return { enrolRequired: true as const, accessToken: token };
    }

    if (!totpCode) throw new UnauthorizedException('MFA code required');
    const secretRow = await platformDb(this.db)
      .selectFrom('totp_secrets')
      .select('secret_enc')
      .where('user_id', '=', user.id)
      .executeTakeFirst();
    if (!secretRow || !this.totp.verify(totpCode, decryptSecret(secretRow.secret_enc))) {
      // Counts toward the same lockout as a bad password - otherwise a
      // stolen/reused password gives an attacker unlimited TOTP guesses.
      await this.recordFailedAttempt(user.id, user.failed_logins);
      // Password already verified, so a distinct message here leaks nothing and
      // lets the UI keep showing the code field.
      await this.audit.platform('auth.login.failed', {
        actor: { id: user.id, email, ip: meta.ip },
        detail: { reason: 'bad-totp' },
      });
      throw new UnauthorizedException('MFA code incorrect or expired');
    }

    await this.clearFailedAttempts(user.id, user.failed_logins);
    return this.issueLogin(user.id, user.role, user.email, meta);
  }

  /** Increments the shared login-failure counter and locks the account once it hits MAX_FAILED. */
  private async recordFailedAttempt(userId: string, currentFailed: number): Promise<void> {
    const failed = currentFailed + 1;
    await platformDb(this.db)
      .updateTable('users')
      .set({
        failed_logins: failed,
        locked_until:
          failed >= MAX_FAILED ? new Date(Date.now() + LOCK_MINUTES * 60_000).toISOString() : null,
        updated_at: new Date().toISOString(),
      })
      .where('id', '=', userId)
      .execute();
  }

  /** Clears the login-failure counter once an attempt fully succeeds (or reaches a step with nothing left to guess). */
  private async clearFailedAttempts(userId: string, currentFailed: number): Promise<void> {
    if (currentFailed === 0) return;
    await platformDb(this.db)
      .updateTable('users')
      .set({ failed_logins: 0, locked_until: null, updated_at: new Date().toISOString() })
      .where('id', '=', userId)
      .execute();
  }

  /**
   * Forced first-sign-in password change. Reachable only with a `pwreset` token.
   * On success the user still needs MFA, so this returns the same shape as
   * `login()` - an enrol token when TOTP is not set up, otherwise a full session.
   */
  async changePassword(
    userId: string,
    role: string,
    email: string,
    newPassword: string,
    meta: Meta,
  ) {
    const user = await platformDb(this.db)
      .selectFrom('users')
      .select(['id', 'password_hash', 'totp_enrolled'])
      .where('id', '=', userId)
      .executeTakeFirstOrThrow();

    const reused = await argon2.verify(user.password_hash, newPassword).catch(() => false);
    if (reused) {
      throw new ForbiddenException('Choose a password you have not used before');
    }

    const passwordHash = await argon2.hash(newPassword, ARGON);
    await platformDb(this.db)
      .updateTable('users')
      .set({
        password_hash: passwordHash,
        must_change_password: false,
        password_changed_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .where('id', '=', userId)
      .execute();

    await platformDb(this.db)
      .updateTable('auth_sessions')
      .set({ revoked_at: new Date().toISOString() })
      .where('user_id', '=', userId)
      .where('revoked_at', 'is', null)
      .execute();

    await this.audit.platform('auth.password.changed', {
      actor: { id: userId, email, ip: meta.ip },
    });

    if (!user.totp_enrolled) {
      const { token } = this.tokens.signAccess({ sub: userId, role, email, typ: 'enrol' });
      return { enrolRequired: true as const, accessToken: token };
    }
    return this.issueLogin(userId, role, email, meta);
  }

  async beginTotpEnrol(userId: string, email: string) {
    const secret = this.totp.generateSecret();
    await platformDb(this.db)
      .insertInto('totp_secrets')
      .values({ user_id: userId, secret_enc: encryptSecret(secret), confirmed_at: null })
      .onConflict((oc) =>
        oc.column('user_id').doUpdateSet({ secret_enc: encryptSecret(secret), confirmed_at: null }),
      )
      .execute();
    const otpauthUrl = this.totp.otpauthUrl(email, secret);
    return { secret, otpauthUrl, qrDataUrl: await this.totp.qrDataUrl(otpauthUrl) };
  }

  async confirmTotpEnrol(userId: string, role: string, email: string, code: string, meta: Meta) {
    // Same lockout counter as login() - this can grant a full session on a
    // correct guess, so it needs the same guess-limiting a bad TOTP at login
    // gets, or an attacker who can't overwrite an already-confirmed secret
    // (see AuthController#totpStart) could just grind codes here instead.
    const user = await platformDb(this.db)
      .selectFrom('users')
      .select(['failed_logins', 'locked_until'])
      .where('id', '=', userId)
      .executeTakeFirstOrThrow();
    if (user.locked_until && new Date(user.locked_until).getTime() > Date.now()) {
      throw new UnauthorizedException('Account temporarily locked - try again later');
    }
    const row = await platformDb(this.db)
      .selectFrom('totp_secrets')
      .select('secret_enc')
      .where('user_id', '=', userId)
      .executeTakeFirst();
    if (!row || !this.totp.verify(code, decryptSecret(row.secret_enc))) {
      await this.recordFailedAttempt(userId, user.failed_logins);
      throw new UnauthorizedException('Incorrect code');
    }
    await this.clearFailedAttempts(userId, user.failed_logins);
    await platformDb(this.db)
      .updateTable('totp_secrets')
      .set({ confirmed_at: new Date().toISOString() })
      .where('user_id', '=', userId)
      .execute();
    await platformDb(this.db)
      .updateTable('users')
      .set({ totp_enrolled: true, updated_at: new Date().toISOString() })
      .where('id', '=', userId)
      .execute();
    await this.audit.platform('auth.totp.enrolled', { actor: { id: userId, email, ip: meta.ip } });
    return this.issueLogin(userId, role, email, meta);
  }

  async refresh(cookieValue: string, meta: Meta) {
    const rotated = await this.tokens.rotate(cookieValue, meta);
    const user = await platformDb(this.db)
      .selectFrom('users')
      .select(['id', 'role', 'email', 'status'])
      .where('id', '=', rotated.userId)
      .executeTakeFirst();
    if (!user || user.status !== 'active') throw new ForbiddenException('Account unavailable');
    const access = this.tokens.signAccess({
      sub: user.id,
      role: user.role,
      email: user.email,
      typ: 'access',
    });
    return {
      accessToken: access.token,
      accessExpiresIn: access.expiresIn,
      refreshCookieValue: rotated.cookieValue,
      refreshExpiresAt: rotated.expiresAt,
    };
  }

  async logout(cookieValue: string | undefined) {
    if (cookieValue) await this.tokens.revoke(cookieValue);
  }

  async me(userId: string): Promise<Me> {
    const user = await platformDb(this.db)
      .selectFrom('users')
      .select(['id', 'email', 'display_name', 'role', 'totp_enrolled', 'msp_id'])
      .where('id', '=', userId)
      .executeTakeFirstOrThrow();

    const resolvedMsp =
      user.role === 'ENGINEER' || user.role === 'PROJECT_MANAGER'
        ? await this.resolveMspBranding(user.email, user.msp_id)
        : null;

    let tenants: Me['tenants'];
    if (user.role === 'SUPER_ADMIN') {
      const rows = await platformDb(this.db)
        .selectFrom('tenants')
        .select(['id', 'slug', 'name', 'branding'])
        .where('status', '=', 'active')
        .orderBy('name')
        .execute();
      tenants = rows.map((r) => ({ ...r, siteScoped: false, siteIds: [], branding: r.branding ?? null }));
    } else {
      const rows = await platformDb(this.db)
        .selectFrom('tenant_memberships as m')
        .innerJoin('tenants as t', 't.id', 'm.tenant_id')
        .select(['t.id as id', 't.slug as slug', 't.name as name', 'm.site_ids as siteIds', 't.branding as branding'])
        .where('m.user_id', '=', userId)
        .where('t.status', '=', 'active')
        .orderBy('t.name')
        .execute();
      tenants = rows.map((r) => {
        const siteIds = Array.isArray(r.siteIds) ? r.siteIds : [];
        return { id: r.id, slug: r.slug, name: r.name, siteScoped: siteIds.length > 0, siteIds, branding: r.branding ?? null };
      });
    }

    return {
      id: user.id,
      email: user.email,
      displayName: user.display_name,
      role: user.role,
      totpEnrolled: user.totp_enrolled,
      tenants,
      mspId: resolvedMsp?.id ?? null,
      mspBranding: resolvedMsp?.branding ?? null,
    };
  }

  /**
   * Which MSP staff (ENGINEER/PROJECT_MANAGER) belong to, for branding in
   * the app chrome regardless of which customer tenant they're currently
   * looking at. Domain match is the primary mechanism (an org's engineers
   * all share a corporate email domain); the explicit per-user override is
   * only a fallback for personal/shared domains a domain match can't
   * resolve - see the MSP branding plan.
   */
  private async resolveMspBranding(
    email: string,
    mspIdOverride: string | null,
  ): Promise<{ id: string; branding: Branding | null } | null> {
    const id = await resolveMspId(this.db, email, mspIdOverride);
    if (!id) return null;
    const msp = await platformDb(this.db).selectFrom('msps').select('branding').where('id', '=', id).executeTakeFirst();
    return { id, branding: msp?.branding ?? null };
  }

  private async issueLogin(userId: string, role: string, email: string, meta: Meta) {
    const access = this.tokens.signAccess({ sub: userId, role, email, typ: 'access' });
    const session = await this.tokens.issueSession(userId, meta);
    await this.audit.platform('auth.login.ok', { actor: { id: userId, email, ip: meta.ip } });
    return {
      enrolRequired: false as const,
      accessToken: access.token,
      accessExpiresIn: access.expiresIn,
      refreshCookieValue: session.cookieValue,
      refreshExpiresAt: session.expiresAt,
    };
  }
}
