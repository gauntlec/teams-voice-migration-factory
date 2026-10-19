import { Inject, Injectable, Logger } from '@nestjs/common';
import { FEDERATED_PASSWORD_HASH, platformDb, ssoNotifyAdminSignin, ssoSessionMaxHours, sweepStaffAccess } from '@tvmf/db';
import {
  OIDC_CALLBACK_PATH,
  ROLE_LABELS,
  capRole,
  ceilingForIdentity,
  hubGateHost,
  safeReturnTo,
  type Role,
  type SsoAdminSigninContext,
  type SsoPublicError,
} from '@tvmf/shared';
import { timingSafeEqual } from 'node:crypto';
import { AuditService } from '../common/audit.service';
import { APP_CONFIG, type AppConfig } from '../common/config';
import { decryptSecret, sha256 } from '../common/crypto';
import { InjectDb, type Db } from '../db/db.module';
import { AuthService } from '../auth/auth.service';
import { MailService } from '../mail/mail.service';
import { SsoStaffAccessService } from './sso-staff-access.service';
import { OidcClient, createPkce, randomToken, type OidcClientRegistration } from './oidc/oidc-client';
import { OidcError } from './oidc/oidc-error';
import type { VerifiedIdToken } from './oidc/id-token';
import { readState, signState } from './oidc/state-cookie';
import { consumeOnce } from './replay-guard';
import { requestedRole } from './roles';

export const OIDC_CLIENT = Symbol('OIDC_CLIENT');

interface Meta {
  ip?: string;
  userAgent?: string;
}

export type BeginResult = { ok: true; redirectUrl: string; stateCookie: string } | { ok: false; error: SsoPublicError };

export type CompleteResult =
  | { kind: 'session'; redirectTo: string; refreshCookieValue: string; refreshExpiresAt: Date }
  | { kind: 'refused'; error: SsoPublicError; /** Set when this was an administrator's "Test sign-in": the page to return to shows the result. */ testProviderId?: string }
  /** A Voxshift staff sign-in that needs an administrator's approval (docs/SSO.md 4.3a): no session yet; the browser keeps `waitToken` and waits. */
  | { kind: 'waiting'; waitToken: string }
  | { kind: 'tested'; providerId: string };

type ProviderRow = Awaited<ReturnType<SsoSignInService['loadProvider']>> & object;

/** The public message for a failed ID token check: a missing second factor is the one thing the person can fix, everything else is generic. */
const publicErrorFor = (e: OidcError): SsoPublicError => (e.reason === 'mfa_not_proven' ? 'mfa_required' : 'failed');

const same = (a: string, b: string) => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

/**
 * Signing people in through an OpenID Connect provider (docs/SSO.md 4.2-4.5, 4.8): starts the authorization code flow, completes it at
 * the callback, applies the rules for users and roles, and starts the same kind of session a password sign-in does.
 *
 * What it never does: log a token, code or secret; link a provider identity to a local account by email; hand out more than the provider's
 * role ceiling; or ask for the local authenticator (the provider's `amr` proves the second factor when it is required).
 */
@Injectable()
export class SsoSignInService {
  private readonly log = new Logger(SsoSignInService.name);

  constructor(
    @InjectDb() private readonly db: Db,
    @Inject(APP_CONFIG) private readonly cfg: AppConfig,
    @Inject(OIDC_CLIENT) private readonly oidc: OidcClient,
    private readonly auth: AuthService,
    private readonly audit: AuditService,
    private readonly mail: MailService,
    private readonly staffAccess: SsoStaffAccessService,
  ) {}

  loadProvider(id: string) {
    return platformDb(this.db).selectFrom('sso_providers').selectAll().where('id', '=', id).executeTakeFirst();
  }

  private registration(p: ProviderRow): OidcClientRegistration {
    return { issuer: p.issuer, clientId: p.client_id, clientSecret: p.client_secret_enc ? decryptSecret(p.client_secret_enc) : null, scopes: p.scopes };
  }

  /** `https://<base>/api/auth/oidc/callback`, or on the hub's gate address when the request came in on it (docs/SSO.md 4.2). */
  async redirectUriFor(p: Pick<ProviderRow, 'kind'>, requestHost: string | undefined): Promise<string> {
    if (p.kind === 'hub') {
      const hub = await platformDb(this.db).selectFrom('app_settings').select('hub_url').executeTakeFirst();
      const gate = hubGateHost(requestHost, hub?.hub_url ?? null);
      if (gate) return `https://${gate}${OIDC_CALLBACK_PATH}`;
    }
    return `${this.cfg.WEB_ORIGIN.replace(/\/+$/, '')}${OIDC_CALLBACK_PATH}`;
  }

  private async refuse(
    reason: string,
    error: SsoPublicError,
    meta: Meta,
    who: { provider?: { id: string; name: string } | null; subject?: string | null; email?: string | null; userId?: string | null } = {},
  ): Promise<{ kind: 'refused'; error: SsoPublicError }> {
    await this.audit.platform('sso.login.refused', {
      actor: { id: who.userId ?? null, email: who.email ?? null, ip: meta.ip },
      targetType: who.provider ? 'sso_provider' : undefined,
      targetId: who.provider?.id,
      detail: { reason, provider: who.provider?.name ?? null, subject: who.subject ?? null, email: who.email ?? null },
    });
    return { kind: 'refused', error };
  }

  /** Step 1: where to send the browser, and the cookie that binds the answer to this browser. `testBy` = an administrator's "Test sign-in" (nothing is created). */
  async begin(a: { providerId: string; returnTo?: string; requestHost?: string; testBy?: string; meta: Meta }): Promise<BeginResult> {
    const p = await this.loadProvider(a.providerId);
    if (!p || (!p.enabled && !a.testBy)) {
      await this.refuse('provider_off', 'provider_off', a.meta, { provider: p ? { id: p.id, name: p.name } : null });
      return { ok: false, error: 'provider_off' };
    }
    try {
      const doc = await this.oidc.discover(p.issuer);
      const redirectUri = await this.redirectUriFor(p, a.requestHost);
      const pkce = createPkce();
      const state = randomToken();
      const nonce = randomToken();
      const redirectUrl = this.oidc.authorizationUrl(doc, { clientId: p.client_id, scopes: p.scopes }, { redirectUri, state, nonce, codeChallenge: pkce.challenge });
      const stateCookie = signState(
        { providerId: p.id, state, nonce, codeVerifier: pkce.verifier, redirectUri, returnTo: safeReturnTo(a.returnTo), ...(a.testBy ? { testBy: a.testBy } : {}) },
        this.cfg.JWT_ACCESS_SECRET,
      );
      return { ok: true, redirectUrl, stateCookie };
    } catch (err) {
      const reason = err instanceof OidcError ? err.reason : 'discovery_failed';
      await this.refuse(reason, 'failed', a.meta, { provider: p });
      return { ok: false, error: 'failed' };
    }
  }

  /** Step 2: the provider has sent the browser back with a code. */
  async complete(a: { code?: string; state?: string; error?: string; stateCookie?: string; meta: Meta }): Promise<CompleteResult> {
    const st = readState(a.stateCookie, this.cfg.JWT_ACCESS_SECRET);
    const result = await this.finish(a, st);
    return result.kind === 'refused' && st?.testBy ? { ...result, testProviderId: st.providerId } : result;
  }

  private async finish(a: { code?: string; state?: string; error?: string; meta: Meta }, st: ReturnType<typeof readState>): Promise<CompleteResult> {
    if (!st) return this.refuse('state_missing_or_expired', 'failed', a.meta);
    const p = await this.loadProvider(st.providerId);
    const prov = p ? { id: p.id, name: p.name } : null;
    if (a.error) return this.refuse(`provider_error:${/^[a-z_]{1,40}$/.test(a.error) ? a.error : 'other'}`, 'failed', a.meta, { provider: prov });
    if (!a.code || !a.state || !same(a.state, st.state)) return this.refuse('state_mismatch', 'failed', a.meta, { provider: prov });
    if (!p || (!p.enabled && !st.testBy)) return this.refuse('provider_off', 'provider_off', a.meta, { provider: prov });

    // The code works once: a second use of it (a replayed callback) is refused before anything is sent to the provider.
    if (!(await consumeOnce(this.db, 'code', p.id, a.code, 15 * 60_000))) return this.refuse('code_replayed', 'failed', a.meta, { provider: prov });

    let token: VerifiedIdToken;
    try {
      const reg = this.registration(p);
      const doc = await this.oidc.discover(p.issuer);
      const idToken = await this.oidc.exchangeCode(doc, reg, { code: a.code, redirectUri: st.redirectUri, codeVerifier: st.codeVerifier });
      token = await this.oidc.verify(idToken, doc, reg, { nonce: st.nonce, requireMfa: p.require_mfa_claim });
    } catch (err) {
      const e = err instanceof OidcError ? err : new OidcError('token_endpoint_error');
      if (!(err instanceof OidcError)) this.log.warn(`Unexpected error completing a sign-in with "${p.name}": ${(err as Error).name}`);
      if (st.testBy) await this.recordTest(p.id, false, `The provider answered, but the ID token was refused (${e.reason}).`);
      return this.refuse(e.reason, publicErrorFor(e), a.meta, { provider: prov });
    }
    if (token.jti && !(await consumeOnce(this.db, 'jti', p.id, token.jti, Math.max(token.expiresAt - Date.now(), 0) + 5 * 60_000))) {
      return this.refuse('token_replayed', 'failed', a.meta, { provider: prov, subject: token.subject });
    }

    const email = this.emailOf(token);
    const requested = requestedRole(p, token.claims);
    const accountKind = typeof token.claims.vx_kind === 'string' ? token.claims.vx_kind : null;
    const ceiling = ceilingForIdentity(p, accountKind);
    const effective = capRole(requested.role, ceiling);

    if (st.testBy) {
      const detail = `Signed in as ${email ?? token.subject}. The provider asks for ${ROLE_LABELS[requested.role]} (${requested.fromProvider ? 'from its role claim' : 'the default role'}); the ceiling is ${ROLE_LABELS[ceiling]}, so this person would sign in as ${ROLE_LABELS[effective]}. Second factor reported: ${token.amr.length ? token.amr.join(', ') : 'none'}${p.require_mfa_claim ? ' (required)' : ' (not required)'}.`;
      await this.recordTest(p.id, true, detail);
      await this.audit.platform('sso.provider.changed', { actor: { id: st.testBy, ip: a.meta.ip }, targetType: 'sso_provider', targetId: p.id, detail: { change: 'test sign-in', ok: true, provider: p.name } });
      return { kind: 'tested', providerId: p.id };
    }

    if (token.emailVerified === false) return this.refuse('email_unverified', 'no_email', a.meta, { provider: prov, subject: token.subject, email });
    const domains = p.email_domains;
    if (domains.length > 0) {
      const domain = email?.split('@')[1]?.toLowerCase();
      if (!domain) return this.refuse('email_missing', 'no_email', a.meta, { provider: prov, subject: token.subject });
      if (!domains.includes(domain)) return this.refuse('domain_not_allowed', 'domain', a.meta, { provider: prov, subject: token.subject, email });
    }

    // Voxshift staff on a hub account (anyone the hub does not say is the customer's own person) may be held to the installation's own rule (docs/SSO.md 4.3a).
    const staffAccount = p.kind === 'hub' && accountKind !== 'customer';
    if (staffAccount && p.staff_access === 'off') return this.refuse('staff_access_off', 'staff_off', a.meta, { provider: prov, subject: token.subject, email });

    const found = await this.findOrCreateUser(p, token, email, effective, accountKind, a.meta);
    if (found.kind === 'refused') return found;
    const user = found.user;

    const hours = await ssoSessionMaxHours(this.db);
    let sessionEnds = new Date(Date.now() + hours * 3_600_000);
    let windowEnds: Date | null = null;
    if (staffAccount && p.staff_access === 'needs_approval') {
      windowEnds = await this.staffAccess.activeWindow(p.id, user.id);
      if (!windowEnds) {
        const waiting = await this.staffAccess.begin({
          providerId: p.id,
          userId: user.id,
          subject: token.subject,
          email: user.email,
          displayName: token.name,
          requestedRole: requested.role,
          effectiveRole: effective,
          amr: token.amr,
          providerSessionId: token.sessionId,
          returnTo: st.returnTo,
          meta: a.meta,
        });
        return { kind: 'waiting', waitToken: waiting.waitToken };
      }
      // the time limit applies to the session cap too: the session ends with the window
      if (windowEnds < sessionEnds) sessionEnds = windowEnds;
    } else if (p.kind === 'hub') {
      // no approved window limits this person (the customer's own people, or staff while the rule is "allowed")
      await platformDb(this.db).updateTable('external_identities').set({ access_until: null }).where('provider_id', '=', p.id).where('subject', '=', token.subject).where('access_until', 'is not', null).execute();
    }

    const session = await this.auth.issueFederatedLogin(user.id, effective, user.email, { idp: p.id, amr: token.amr, absoluteExpiresAt: sessionEnds }, a.meta);
    await this.audit.platform('sso.login.success', {
      actor: { id: user.id, email: user.email, ip: a.meta.ip },
      targetType: 'sso_provider',
      targetId: p.id,
      detail: {
        provider: p.name,
        subject: token.subject,
        email: user.email,
        role: effective,
        requestedRole: requested.role,
        ceiling,
        roleChanged: found.roleChanged,
        accountKind,
        providerSessionId: token.sessionId,
        amr: token.amr,
        created: found.created,
        ...(windowEnds ? { accessWindowEndsAt: windowEnds.toISOString() } : {}),
      },
    });
    if (effective === 'SUPER_ADMIN') await this.notifyAdministrators(p.name, user, token.sessionId, a.meta);

    return { kind: 'session', redirectTo: st.returnTo, refreshCookieValue: session.refreshCookieValue, refreshExpiresAt: session.refreshExpiresAt };
  }


  /**
   * Step 3 for a Voxshift staff sign-in that was waiting for approval: the waiting page, holding the token from its cookie, asks for the session.
   * It is given once, only for an approved request that is still inside its window, and only if everything that was true at sign-in still is:
   * the provider is on and still set to "needs approval", the account is active and not a break-glass administrator, the identity is still linked.
   * The role is worked out again from the ceiling as it is now; the session ends with the window.
   */
  async claimApproved(a: { waitToken?: string; meta: Meta }): Promise<{ kind: 'session'; redirectTo: string; refreshCookieValue: string; refreshExpiresAt: Date } | { kind: 'refused'; error: SsoPublicError }> {
    const db = platformDb(this.db);
    if (!a.waitToken) return this.refuse('access_no_wait_token', 'failed', a.meta);
    await sweepStaffAccess(this.db);
    // One statement: two clicks, or two browsers with the same cookie, give one session.
    const req = await db
      .updateTable('sso_access_requests')
      .set({ claimed_at: new Date().toISOString() })
      .where('wait_token_hash', '=', sha256(a.waitToken))
      .where('status', '=', 'approved')
      .where('claimed_at', 'is', null)
      .where('window_ends_at', '>', new Date().toISOString())
      .returning(['id', 'provider_id', 'user_id', 'subject', 'email', 'effective_role', 'amr', 'provider_session', 'window_ends_at', 'return_to'])
      .executeTakeFirst();
    if (!req) return this.refuse('access_not_approved', 'failed', a.meta);

    const p = await this.loadProvider(req.provider_id);
    const prov = p ? { id: p.id, name: p.name } : null;
    const who = { provider: prov, subject: req.subject, email: req.email, userId: req.user_id };
    if (!p || !p.enabled || p.staff_access !== 'needs_approval') return this.refuse('provider_off', 'provider_off', a.meta, who);
    const identity = await db.selectFrom('external_identities').select(['id', 'account_kind']).where('provider_id', '=', p.id).where('subject', '=', req.subject).executeTakeFirst();
    const user = await db.selectFrom('users').select(['id', 'email', 'status', 'break_glass']).where('id', '=', req.user_id).executeTakeFirst();
    if (!identity || !user || identity.account_kind === 'customer') return this.refuse('access_identity_gone', 'failed', a.meta, who);
    if (user.status !== 'active') return this.refuse('user_disabled', 'disabled', a.meta, who);
    if (user.break_glass) return this.refuse('break_glass_local_only', 'local_only', a.meta, who);

    const ceiling = ceilingForIdentity(p, identity.account_kind);
    const effective = capRole(req.effective_role as Role, ceiling);
    await db.updateTable('users').set({ role: effective, updated_at: new Date().toISOString() }).where('id', '=', user.id).execute();
    const windowEnds = new Date(req.window_ends_at!);
    await db.updateTable('external_identities').set({ access_until: windowEnds.toISOString(), last_login_at: new Date().toISOString() }).where('id', '=', identity.id).execute();
    const hours = await ssoSessionMaxHours(this.db);
    const ends = new Date(Math.min(Date.now() + hours * 3_600_000, windowEnds.getTime()));
    const session = await this.auth.issueFederatedLogin(user.id, effective, user.email, { idp: p.id, amr: req.amr, absoluteExpiresAt: ends }, a.meta);
    await this.audit.platform('sso.login.success', {
      actor: { id: user.id, email: user.email, ip: a.meta.ip },
      targetType: 'sso_provider',
      targetId: p.id,
      detail: { provider: p.name, subject: req.subject, email: user.email, role: effective, ceiling, accountKind: identity.account_kind, providerSessionId: req.provider_session, amr: req.amr, accessRequestId: req.id, accessWindowEndsAt: windowEnds.toISOString() },
    });
    if (effective === 'SUPER_ADMIN') await this.notifyAdministrators(p.name, user, req.provider_session, a.meta);
    return { kind: 'session', redirectTo: safeReturnTo(req.return_to), refreshCookieValue: session.refreshCookieValue, refreshExpiresAt: session.refreshExpiresAt };
  }

  /** The email the provider vouches for. Entra ID often sends the sign-in name (`preferred_username`) rather than `email`. */
  private emailOf(t: VerifiedIdToken): string | null {
    const fallback = typeof t.claims.preferred_username === 'string' && t.claims.preferred_username.includes('@') ? t.claims.preferred_username : null;
    const e = (t.email ?? fallback)?.trim().toLowerCase();
    return e && /^[^\s@]+@[^\s@]+$/.test(e) ? e : null;
  }

  private async findOrCreateUser(
    p: ProviderRow,
    token: VerifiedIdToken,
    email: string | null,
    effective: Role,
    accountKind: string | null,
    meta: Meta,
  ): Promise<{ kind: 'ok'; user: { id: string; email: string }; created: boolean; roleChanged: boolean } | { kind: 'refused'; error: SsoPublicError }> {
    const db = platformDb(this.db);
    const prov = { id: p.id, name: p.name };
    const now = new Date().toISOString();

    const identity = await db.selectFrom('external_identities').select(['id', 'user_id']).where('provider_id', '=', p.id).where('subject', '=', token.subject).executeTakeFirst();
    if (identity) {
      const user = await db.selectFrom('users').select(['id', 'email', 'role', 'status', 'break_glass']).where('id', '=', identity.user_id).executeTakeFirstOrThrow();
      if (user.status !== 'active') return this.refuse('user_disabled', 'disabled', meta, { provider: prov, subject: token.subject, email: user.email, userId: user.id });
      // A locally created administrator signs in locally: a provider never decides what a break-glass account may do.
      if (user.break_glass) return this.refuse('break_glass_local_only', 'local_only', meta, { provider: prov, subject: token.subject, email: user.email, userId: user.id });
      const roleChanged = user.role !== effective;
      if (roleChanged) await db.updateTable('users').set({ role: effective, updated_at: now }).where('id', '=', user.id).execute();
      await db.updateTable('external_identities').set({ email, account_kind: accountKind, last_login_at: now }).where('id', '=', identity.id).execute();
      return { kind: 'ok', user: { id: user.id, email: user.email }, created: false, roleChanged };
    }

    // First time we see this person (this `sub`). There is NO linking by email: a local account with the same email is a different
    // person until an administrator says otherwise.
    if (!email) return this.refuse('email_missing', 'no_email', meta, { provider: prov, subject: token.subject });
    const local = await db.selectFrom('users').select('id').where('email', '=', email).executeTakeFirst();
    if (local) return this.refuseExistingEmail(p, token, email, accountKind, meta);
    if (!p.jit_create) return this.refuse('no_identity_jit_off', 'no_account', meta, { provider: prov, subject: token.subject, email });

    let userId: string;
    try {
      userId = (
        await db
          .insertInto('users')
          .values({
            email,
            password_hash: FEDERATED_PASSWORD_HASH,
            display_name: token.name ?? email.split('@')[0]!,
            role: effective,
            totp_enrolled: false,
            must_change_password: false,
            break_glass: false,
          })
          .returning('id')
          .executeTakeFirstOrThrow()
      ).id;
    } catch (err) {
      // Someone created the same email a moment ago.
      if ((err as { code?: string }).code === '23505') return this.refuseExistingEmail(p, token, email, accountKind, meta);
      throw err;
    }
    await db.insertInto('external_identities').values({ user_id: userId, provider_id: p.id, subject: token.subject, email, account_kind: accountKind, last_login_at: now }).execute();
    await this.audit.platform('sso.user.created', {
      actor: { id: userId, email, ip: meta.ip },
      targetType: 'user',
      targetId: userId,
      detail: { provider: p.name, subject: token.subject, role: effective, accountKind },
    });
    return { kind: 'ok', user: { id: userId, email }, created: true, roleChanged: false };
  }

  /** "An account with this email already exists": refused, and kept as a waiting sign-in the administrator can link on purpose. */
  private async refuseExistingEmail(p: ProviderRow, token: VerifiedIdToken, email: string, accountKind: string | null, meta: Meta) {
    await platformDb(this.db)
      .insertInto('sso_link_requests')
      .values({ provider_id: p.id, subject: token.subject, email, display_name: token.name, account_kind: accountKind })
      .onConflict((oc) => oc.columns(['provider_id', 'subject']).doUpdateSet({ email, display_name: token.name, account_kind: accountKind, last_seen_at: new Date().toISOString() }))
      .execute();
    return this.refuse('email_exists_unlinked', 'email_exists', meta, { provider: { id: p.id, name: p.name }, subject: token.subject, email });
  }

  private async recordTest(providerId: string, ok: boolean, detail: string): Promise<void> {
    await platformDb(this.db)
      .updateTable('sso_providers')
      .set({ last_test_at: new Date().toISOString(), last_test_ok: ok, last_test_detail: detail.slice(0, 1000) })
      .where('id', '=', providerId)
      .execute();
  }

  /** Everyone who is an administrator here is told when someone signs in as one through a provider (docs/SSO.md 4.3). Never stops the sign-in. */
  private async notifyAdministrators(providerName: string, user: { id: string; email: string }, providerSessionId: string | null, meta: Meta): Promise<void> {
    try {
      if (!(await ssoNotifyAdminSignin(this.db))) return;
      const admins = await platformDb(this.db).selectFrom('users').select(['id', 'email', 'display_name']).where('role', '=', 'SUPER_ADMIN').where('status', '=', 'active').execute();
      const who = await platformDb(this.db).selectFrom('users').select('display_name').where('id', '=', user.id).executeTakeFirstOrThrow();
      const context: SsoAdminSigninContext = {
        displayName: who.display_name,
        email: user.email,
        providerName,
        providerSessionId,
        installation: this.cfg.WEB_ORIGIN,
        at: new Date().toISOString().replace('T', ' ').slice(0, 19) + ' UTC',
        ip: meta.ip ?? null,
      };
      for (const admin of admins) {
        await this.mail.enqueue({ template: 'sso_admin_signin', to: { email: admin.email, name: admin.display_name }, context: context as unknown as Record<string, unknown>, related: { type: 'user', id: user.id } });
      }
    } catch (err) {
      this.log.warn(`Could not email the administrators about an administrator sign-in: ${(err as Error).message}`);
    }
  }
}
