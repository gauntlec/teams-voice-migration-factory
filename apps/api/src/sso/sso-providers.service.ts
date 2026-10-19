import { BadRequestException, ConflictException, Inject, Injectable, Logger, NotFoundException, type OnModuleInit } from '@nestjs/common';
import { platformDb, localPasswordsAllowed, ssoNotifyAdminSignin, ssoSessionMaxHours, staffAccessModeChanged } from '@tvmf/db';
import {
  OIDC_CALLBACK_PATH,
  STAFF_ACCESS_LABELS,
  staffAccessRank,
  type CreateSsoProviderInput,
  type LinkIdentityInput,
  type PublicSsoProviders,
  type SsoGeneralSettingsInput,
  type SsoIdentityView,
  type SsoLinkRequestView,
  type SsoProviderView,
  type SsoSettingsView,
  type UpdateSsoProviderInput,
} from '@tvmf/shared';
import { emailEnabled } from '@tvmf/db';
import { AuditService, type AuditActor } from '../common/audit.service';
import { APP_CONFIG, type AppConfig } from '../common/config';
import { encryptSecret } from '../common/crypto';
import { InjectDb, type Db } from '../db/db.module';
import { ensureHubProvider } from './hub-provider';
import { OidcClient } from './oidc/oidc-client';
import { OidcError } from './oidc/oidc-error';
import { signTestTicket } from './oidc/state-cookie';
import { OIDC_CLIENT } from './sso-signin.service';
import { SsoStaffAccessService } from './sso-staff-access.service';

type Row = Awaited<ReturnType<SsoProvidersService['rows']>>[number];

const iso = (v: string | Date | null | undefined): string | null => (v ? new Date(v).toISOString() : null);

/** Administration > Platform settings > Single sign-on: the providers, their role ceilings, and who is linked to whom (docs/SSO.md 4.1, 4.4, 4.5a). */
@Injectable()
export class SsoProvidersService implements OnModuleInit {
  private readonly log = new Logger(SsoProvidersService.name);

  constructor(
    @InjectDb() private readonly db: Db,
    @Inject(APP_CONFIG) private readonly cfg: AppConfig,
    @Inject(OIDC_CLIENT) private readonly oidc: OidcClient,
    private readonly audit: AuditService,
    private readonly staffAccess: SsoStaffAccessService,
  ) {}

  /** An installation connected to a hub before single sign-on existed gets its hub provider record (off) when the API starts. */
  async onModuleInit(): Promise<void> {
    await this.ensureHub();
  }

  /** Creates the hub provider record from the saved hub connection if it is missing (see `ensureHubProvider`). Never fails the caller. */
  private async ensureHub(): Promise<void> {
    try {
      await ensureHubProvider(this.db);
    } catch (err) {
      this.log.warn(`Could not set up the Voxshift Hub sign-in provider from the hub connection: ${(err as Error).message}`);
    }
  }

  private rows() {
    return platformDb(this.db).selectFrom('sso_providers').selectAll().orderBy('kind', 'desc').orderBy('name').execute();
  }

  private async hubConnected(): Promise<boolean> {
    const r = await platformDb(this.db).selectFrom('app_settings').select(['hub_url', 'hub_token_enc']).executeTakeFirst();
    return !!r?.hub_url && !!r?.hub_token_enc;
  }

  private view(r: Row, count: number, hubConnected: boolean): SsoProviderView {
    return {
      id: r.id,
      kind: r.kind,
      name: r.name,
      issuer: r.issuer,
      clientId: r.client_id,
      secretSet: !!r.client_secret_enc,
      scopes: r.scopes,
      enabled: r.enabled,
      jitCreate: r.jit_create,
      requireMfaClaim: r.require_mfa_claim,
      roleCeiling: r.role_ceiling,
      roleCeilingStaff: r.role_ceiling_staff,
      roleCeilingCustomer: r.role_ceiling_customer,
      defaultRole: r.default_role,
      roleClaim: r.role_claim,
      roleMap: r.role_map ?? {},
      emailDomains: r.email_domains,
      allowLocalPasswords: r.allow_local_passwords,
      staffAccess: r.staff_access,
      lastTestAt: iso(r.last_test_at),
      lastTestOk: r.last_test_ok,
      lastTestDetail: r.last_test_detail,
      redirectUri: `${this.cfg.WEB_ORIGIN.replace(/\/+$/, '')}${OIDC_CALLBACK_PATH}`,
      identityCount: count,
      ...(r.kind === 'hub' ? { hubConnected } : {}),
    };
  }

  async settings(): Promise<SsoSettingsView> {
    await this.ensureHub();
    const [rows, counts, hubConnected] = await Promise.all([
      this.rows(),
      platformDb(this.db).selectFrom('external_identities').select(['provider_id']).select(({ fn }) => fn.countAll<string>().as('n')).groupBy('provider_id').execute(),
      this.hubConnected(),
    ]);
    const byProvider = new Map(counts.map((c) => [c.provider_id, Number(c.n)]));
    return {
      providers: rows.map((r) => this.view(r, byProvider.get(r.id) ?? 0, hubConnected)),
      sessionMaxHours: await ssoSessionMaxHours(this.db),
      notifyAdminSignin: await ssoNotifyAdminSignin(this.db),
      baseUrl: this.cfg.WEB_ORIGIN.replace(/\/+$/, ''),
      localPasswords: await localPasswordsAllowed(this.db),
      emailEnabled: await emailEnabled(this.db, { fresh: true }),
    };
  }

  /** For the login page, no sign-in needed: id, name and kind of each provider that is switched on, and whether the password form is shown. */
  async publicList(): Promise<PublicSsoProviders> {
    await this.ensureHub();
    const rows = await platformDb(this.db).selectFrom('sso_providers').select(['id', 'name', 'kind']).where('enabled', '=', true).orderBy('kind', 'desc').orderBy('name').execute();
    return { providers: rows.map((r) => ({ id: r.id, name: r.name, kind: r.kind })), localPasswords: await localPasswordsAllowed(this.db) };
  }

  /** The hub provider's id, for `?provider=hub`. */
  async hubProviderId(): Promise<string | null> {
    await this.ensureHub();
    return (await platformDb(this.db).selectFrom('sso_providers').select('id').where('kind', '=', 'hub').executeTakeFirst())?.id ?? null;
  }

  private async discoverOrExplain(issuer: string): Promise<void> {
    try {
      this.oidc.forget(issuer);
      await this.oidc.discover(issuer);
    } catch (err) {
      const why = err instanceof OidcError ? err.reason : 'discovery_failed';
      const text: Record<string, string> = {
        discovery_failed: 'did not answer with a valid configuration document',
        issuer_mismatch: 'answered with a different issuer than the one you entered (use the exact "issuer" value from the provider)',
        insecure_endpoint: 'uses an address that is not https',
      };
      throw new BadRequestException(`We could not read ${issuer.replace(/\/+$/, '')}/.well-known/openid-configuration: the provider ${text[why] ?? 'could not be reached'}.`);
    }
  }

  /** Switching local passwords off is only safe while a break-glass administrator can still sign in with one. */
  private async requireBreakGlass(): Promise<void> {
    const r = await platformDb(this.db)
      .selectFrom('users')
      .select('id')
      .where('role', '=', 'SUPER_ADMIN')
      .where('status', '=', 'active')
      .where('break_glass', '=', true)
      .where('password_hash', 'not like', '!%')
      .limit(1)
      .executeTakeFirst();
    if (!r) throw new ConflictException('Switching off local passwords needs at least one active local administrator (break-glass) who can still sign in with a password and authenticator. Create one first.');
  }

  async create(input: CreateSsoProviderInput, actor: AuditActor): Promise<SsoProviderView> {
    await this.discoverOrExplain(input.issuer);
    if (input.allowLocalPasswords === false) await this.requireBreakGlass();
    let id: string;
    try {
      id = (
        await platformDb(this.db)
          .insertInto('sso_providers')
          .values({
            kind: 'oidc',
            name: input.name,
            issuer: input.issuer.replace(/\/+$/, ''),
            client_id: input.clientId,
            client_secret_enc: encryptSecret(input.clientSecret),
            ...(input.scopes ? { scopes: input.scopes } : {}),
            enabled: false,
            ...(input.jitCreate !== undefined ? { jit_create: input.jitCreate } : {}),
            ...(input.requireMfaClaim !== undefined ? { require_mfa_claim: input.requireMfaClaim } : {}),
            ...(input.roleCeiling ? { role_ceiling: input.roleCeiling } : {}),
            ...(input.defaultRole ? { default_role: input.defaultRole } : {}),
            role_claim: input.roleClaim ?? null,
            role_map: JSON.stringify(input.roleMap ?? {}),
            email_domains: input.emailDomains ?? [],
            ...(input.allowLocalPasswords !== undefined ? { allow_local_passwords: input.allowLocalPasswords } : {}),
            created_by: actor.id ?? null,
          })
          .returning('id')
          .executeTakeFirstOrThrow()
      ).id;
    } catch (err) {
      if ((err as { code?: string }).code === '23505') throw new ConflictException('A provider with that name already exists.');
      throw err;
    }
    await this.audit.platform('sso.provider.changed', { actor, targetType: 'sso_provider', targetId: id, detail: { kind: 'oidc', change: 'created', name: input.name, issuer: input.issuer, clientId: input.clientId, enabled: false } });
    return (await this.settings()).providers.find((p) => p.id === id)!;
  }

  async update(id: string, input: UpdateSsoProviderInput, actor: AuditActor & { idp?: string }): Promise<SsoProviderView> {
    const before = await platformDb(this.db).selectFrom('sso_providers').selectAll().where('id', '=', id).executeTakeFirst();
    if (!before) throw new NotFoundException('No such provider.');
    if (before.kind === 'hub' && (input.issuer !== undefined || input.clientId !== undefined || input.clientSecret !== undefined || input.name !== undefined)) {
      throw new BadRequestException('The Voxshift Hub\'s name, address and credentials come from the hub connection (Platform settings > Voxshift hub).');
    }
    if (input.staffAccess !== undefined && before.kind !== 'hub') throw new BadRequestException('Access for Voxshift staff applies to the Voxshift Hub only.');
    // Tightening the rule is open to any administrator. Loosening it (from off or needs-approval towards allowed) is what the rule protects against, so it
    // has to come from an administrator who did not sign in through the hub: otherwise approved staff could switch the approval off for themselves.
    const staffBefore = before.staff_access;
    const staffChanged = input.staffAccess !== undefined && input.staffAccess !== staffBefore;
    if (staffChanged && staffAccessRank(input.staffAccess!) < staffAccessRank(staffBefore)) await this.staffAccess.assertCanDecide(actor);
    if (input.enabled === true && before.kind === 'hub' && !(await this.hubConnected())) {
      throw new ConflictException('Connect this installation to the Voxshift Hub first (Platform settings > Voxshift hub).');
    }
    if (input.issuer !== undefined && input.issuer.replace(/\/+$/, '') !== before.issuer) await this.discoverOrExplain(input.issuer);

    // Only when this change is what takes the password form away (switching the provider on, or switching passwords off on a provider
    // that is on): lowering a ceiling or switching a provider off must never be blocked by it.
    const enabledAfter = input.enabled ?? before.enabled;
    const localAfter = input.allowLocalPasswords ?? before.allow_local_passwords;
    const takesPasswordsAway = enabledAfter && !localAfter && (!before.enabled || before.allow_local_passwords);
    if (takesPasswordsAway) await this.requireBreakGlass();

    const set: Record<string, unknown> = { updated_at: new Date().toISOString() };
    const map: Record<string, [keyof UpdateSsoProviderInput, string]> = {
      name: ['name', 'name'],
      scopes: ['scopes', 'scopes'],
      enabled: ['enabled', 'enabled'],
      jitCreate: ['jitCreate', 'jit_create'],
      requireMfaClaim: ['requireMfaClaim', 'require_mfa_claim'],
      roleCeiling: ['roleCeiling', 'role_ceiling'],
      roleCeilingStaff: ['roleCeilingStaff', 'role_ceiling_staff'],
      roleCeilingCustomer: ['roleCeilingCustomer', 'role_ceiling_customer'],
      defaultRole: ['defaultRole', 'default_role'],
      roleClaim: ['roleClaim', 'role_claim'],
      emailDomains: ['emailDomains', 'email_domains'],
      allowLocalPasswords: ['allowLocalPasswords', 'allow_local_passwords'],
      staffAccess: ['staffAccess', 'staff_access'],
      clientId: ['clientId', 'client_id'],
    };
    const changes: Record<string, { from: unknown; to: unknown }> = {};
    for (const [field, [key, column]] of Object.entries(map)) {
      const value = input[key];
      if (value === undefined) continue;
      const old = (before as unknown as Record<string, unknown>)[column];
      if (JSON.stringify(old) === JSON.stringify(value)) continue;
      set[column] = value;
      changes[field] = { from: old, to: value };
    }
    if (input.issuer !== undefined && input.issuer.replace(/\/+$/, '') !== before.issuer) {
      set.issuer = input.issuer.replace(/\/+$/, '');
      changes.issuer = { from: before.issuer, to: set.issuer };
    }
    if (input.roleMap !== undefined && JSON.stringify(input.roleMap) !== JSON.stringify(before.role_map)) {
      set.role_map = JSON.stringify(input.roleMap);
      changes.roleMap = { from: before.role_map, to: input.roleMap };
    }
    if (input.clientSecret !== undefined) {
      set.client_secret_enc = encryptSecret(input.clientSecret);
      changes.clientSecret = { from: '***', to: '*** (replaced)' };
    }
    try {
      await platformDb(this.db).updateTable('sso_providers').set(set as never).where('id', '=', id).execute();
    } catch (err) {
      if ((err as { code?: string }).code === '23505') throw new ConflictException('A provider with that name already exists.');
      throw err;
    }
    // Switching a provider off, or lowering what it may give, takes effect for people already signed in at their next token refresh (AuthService.refresh).
    if (Object.keys(changes).length > 0) {
      await this.audit.platform('sso.provider.changed', { actor, targetType: 'sso_provider', targetId: id, detail: { kind: before.kind, name: before.name, changes } });
    }
    // A new rule for Voxshift staff takes hold at once: waiting requests and running windows are closed, and staff already signed in under the old rule are signed out.
    if (staffChanged) {
      const effects = await staffAccessModeChanged(this.db, { providerId: id, from: staffBefore, to: input.staffAccess!, actor });
      this.log.log(`Staff access for "${before.name}" changed from ${STAFF_ACCESS_LABELS[staffBefore]} to ${STAFF_ACCESS_LABELS[input.staffAccess!]}: ${effects.closed} request(s) closed, ${effects.signedOut} person(s) signed out.`);
    }
    return (await this.settings()).providers.find((p) => p.id === id)!;
  }

  async remove(id: string, actor: AuditActor): Promise<{ ok: true }> {
    const row = await platformDb(this.db).selectFrom('sso_providers').select(['id', 'kind', 'name']).where('id', '=', id).executeTakeFirst();
    if (!row) throw new NotFoundException('No such provider.');
    if (row.kind === 'hub') throw new BadRequestException('The Voxshift Hub provider follows the hub connection. Switch it off here, or disconnect the hub.');
    // Its people, waiting sign-ins and sessions go with it (people signed in through it are signed out); the user accounts stay.
    await platformDb(this.db).deleteFrom('sso_providers').where('id', '=', id).execute();
    await this.audit.platform('sso.provider.changed', { actor, targetType: 'sso_provider', targetId: id, detail: { kind: row.kind, name: row.name, change: 'deleted' } });
    return { ok: true };
  }

  async setGeneral(input: SsoGeneralSettingsInput, actor: AuditActor): Promise<SsoSettingsView> {
    const values: Record<string, unknown> = {};
    if (input.sessionMaxHours !== undefined) values.sso_session_max_hours = input.sessionMaxHours;
    if (input.notifyAdminSignin !== undefined) values.sso_notify_admin_signin = input.notifyAdminSignin;
    if (Object.keys(values).length > 0) {
      await platformDb(this.db)
        .insertInto('app_settings')
        .values({ id: true, base_url: null, ...values, updated_by: actor.id ?? null } as never)
        .onConflict((oc) => oc.column('id').doUpdateSet({ ...values, updated_by: actor.id ?? null, updated_at: new Date().toISOString() } as never))
        .execute();
      await this.audit.platform('sso.provider.changed', { actor, targetType: 'app_settings', detail: { change: 'general settings', ...input } });
    }
    return this.settings();
  }

  /** What starts "Test sign-in": the address to open, and a two-minute ticket (to be set as a cookie, not put in the address) that proves an administrator asked for it. */
  async testStart(id: string, adminId: string): Promise<{ url: string; ticket: string }> {
    const row = await platformDb(this.db).selectFrom('sso_providers').select('id').where('id', '=', id).executeTakeFirst();
    if (!row) throw new NotFoundException('No such provider.');
    const ticket = signTestTicket(id, adminId, this.cfg.JWT_ACCESS_SECRET);
    return { url: `/api/auth/oidc/login?provider=${id}&returnTo=${encodeURIComponent('/admin/settings/sso')}`, ticket };
  }

  /* ------------------------------- linking people ------------------------------- */

  /** Sign-ins that were refused because a local account with the same email exists, newest first. With a user, the ones for that user's email are marked. */
  async linkRequests(forUserId?: string): Promise<SsoLinkRequestView[]> {
    const userEmail = forUserId ? (await platformDb(this.db).selectFrom('users').select('email').where('id', '=', forUserId).executeTakeFirst())?.email.toLowerCase() : undefined;
    const rows = await platformDb(this.db)
      .selectFrom('sso_link_requests as r')
      .innerJoin('sso_providers as p', 'p.id', 'r.provider_id')
      .select(['r.id', 'r.provider_id', 'p.name as provider_name', 'r.email', 'r.display_name', 'r.account_kind', 'r.last_seen_at'])
      .orderBy('r.last_seen_at', 'desc')
      .limit(200)
      .execute();
    return rows.map((r) => ({
      id: r.id,
      providerId: r.provider_id,
      providerName: r.provider_name,
      email: r.email,
      displayName: r.display_name,
      accountKind: r.account_kind,
      lastSeenAt: new Date(r.last_seen_at).toISOString(),
      ...(userEmail ? { matchesUser: r.email.toLowerCase() === userEmail } : {}),
    }));
  }

  async identitiesOf(userId: string): Promise<SsoIdentityView[]> {
    const rows = await platformDb(this.db)
      .selectFrom('external_identities as i')
      .innerJoin('sso_providers as p', 'p.id', 'i.provider_id')
      .select(['i.id', 'i.provider_id', 'p.name as provider_name', 'i.subject', 'i.email', 'i.last_login_at'])
      .where('i.user_id', '=', userId)
      .orderBy('p.name')
      .execute();
    return rows.map((r) => ({ id: r.id, providerId: r.provider_id, providerName: r.provider_name, subject: r.subject, email: r.email, lastLoginAt: iso(r.last_login_at) }));
  }

  /** Explicitly link a local user to a person at a provider (docs/SSO.md 4.4): the only way an existing local account ever becomes reachable through a provider. */
  async link(userId: string, input: LinkIdentityInput, actor: AuditActor): Promise<SsoIdentityView[]> {
    const user = await platformDb(this.db).selectFrom('users').select(['id', 'email', 'break_glass']).where('id', '=', userId).executeTakeFirst();
    if (!user) throw new NotFoundException('No such user.');
    if (user.break_glass) {
      throw new BadRequestException('This is a break-glass administrator: it signs in here with a password and authenticator, so it is not linked to a provider. Link a different account, or have the person sign in through the provider to get their own.');
    }
    let providerId: string;
    let subject: string;
    let email: string | null;
    let accountKind: string | null = null;
    let requestId: string | null = null;
    if ('requestId' in input) {
      const req = await platformDb(this.db).selectFrom('sso_link_requests').selectAll().where('id', '=', input.requestId).executeTakeFirst();
      if (!req) throw new NotFoundException('That waiting sign-in is no longer there (it may already be linked).');
      ({ provider_id: providerId, subject, email, account_kind: accountKind } = req);
      requestId = req.id;
    } else {
      const p = await platformDb(this.db).selectFrom('sso_providers').select('id').where('id', '=', input.providerId).executeTakeFirst();
      if (!p) throw new NotFoundException('No such provider.');
      providerId = p.id;
      subject = input.subject;
      email = null;
    }
    const taken = await platformDb(this.db).selectFrom('external_identities').select('user_id').where('provider_id', '=', providerId).where('subject', '=', subject).executeTakeFirst();
    if (taken) throw new ConflictException(taken.user_id === userId ? 'That person is already linked to this user.' : 'That person at the provider is already linked to a different user. Remove that link first.');
    await platformDb(this.db).insertInto('external_identities').values({ user_id: userId, provider_id: providerId, subject, email, account_kind: accountKind }).execute();
    if (requestId) await platformDb(this.db).deleteFrom('sso_link_requests').where('id', '=', requestId).execute();
    await platformDb(this.db).deleteFrom('sso_link_requests').where('provider_id', '=', providerId).where('subject', '=', subject).execute();
    await this.audit.platform('sso.user.linked', { actor, targetType: 'user', targetId: userId, detail: { providerId, subject, email, userEmail: user.email, fromWaitingSignIn: !!requestId } });
    return this.identitiesOf(userId);
  }

  async unlink(identityId: string, actor: AuditActor): Promise<{ ok: true }> {
    const i = await platformDb(this.db).selectFrom('external_identities').select(['id', 'user_id', 'provider_id', 'subject']).where('id', '=', identityId).executeTakeFirst();
    if (!i) throw new NotFoundException('No such link.');
    await platformDb(this.db).deleteFrom('external_identities').where('id', '=', identityId).execute();
    // Anyone signed in through that identity is signed out at once.
    await platformDb(this.db).updateTable('auth_sessions').set({ revoked_at: new Date().toISOString() }).where('user_id', '=', i.user_id).where('idp', '=', i.provider_id).where('revoked_at', 'is', null).execute();
    await this.audit.platform('sso.user.unlinked', { actor, targetType: 'user', targetId: i.user_id, detail: { providerId: i.provider_id, subject: i.subject } });
    return { ok: true };
  }
}
