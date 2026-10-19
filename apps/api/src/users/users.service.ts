import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import * as argon2 from 'argon2';
import { sql } from 'kysely';
import { hasUsablePassword, localPasswordsAllowed, platformDb, tenantDb } from '@tvmf/db';
import type { CreateUserInput, Role, UserInvitationContext } from '@tvmf/shared';
import { AuditService } from '../common/audit.service';
import type { AuditActor } from '../common/audit.service';
import { APP_CONFIG, type AppConfig } from '../common/config';
import { resolveMspId } from '../common/msp-resolution.util';
import { InjectDb, type Db } from '../db/db.module';
import { MailService } from '../mail/mail.service';
import { generateTempPassword } from './password.util';
import { encryptSecret } from '../common/crypto';

type UserActor = AuditActor & { role: Role };

const ARGON = { type: argon2.argon2id, memoryCost: 19456, timeCost: 2, parallelism: 1 } as const;

@Injectable()
export class UsersService {
  constructor(
    @InjectDb() private readonly db: Db,
    private readonly audit: AuditService,
    private readonly mail: MailService,
    @Inject(APP_CONFIG) private readonly cfg: AppConfig,
  ) {}

  async list(actor: { id: string; role: Role }, search?: string) {
    let query = platformDb(this.db)
      .selectFrom('users')
      .select(['id', 'email', 'display_name', 'role', 'status', 'totp_enrolled', 'msp_id', 'break_glass', 'created_at'])
      // Whether the account has a local password at all (false for an account that exists only through a single sign-on provider).
      .select(sql<boolean>`password_hash not like '!%'`.as('has_password'))
      .orderBy('created_at', 'desc');
    if (actor.role !== 'SUPER_ADMIN') {
      // Non-admins only see users who belong to a customer they are assigned to.
      query = query.where('id', 'in', (eb) =>
        eb
          .selectFrom('tenant_memberships')
          .select('user_id')
          .where('tenant_id', 'in', (eb2) =>
            eb2
              .selectFrom('tenant_memberships')
              .select('tenant_id')
              .where('user_id', '=', actor.id),
          ),
      );
    }
    if (search) {
      const like = `%${search}%`;
      query = query.where((eb) => eb.or([eb('email', 'ilike', like), eb('display_name', 'ilike', like)]));
    }
    const users = await query.execute();
    if (users.length === 0) return users.map((u) => ({ ...u, tenants: [], ssoProviders: [] as string[] }));

    // Attach each user's customer names for the list view.
    const memberships = await platformDb(this.db)
      .selectFrom('tenant_memberships as m')
      .innerJoin('tenants as t', 't.id', 'm.tenant_id')
      .select(['m.user_id as userId', 't.id as tenantId', 't.name as tenantName'])
      .where(
        'm.user_id',
        'in',
        users.map((u) => u.id),
      )
      .orderBy('t.name')
      .execute();
    const byUser = new Map<string, { id: string; name: string }[]>();
    for (const r of memberships) {
      const arr = byUser.get(r.userId) ?? [];
      arr.push({ id: r.tenantId, name: r.tenantName });
      byUser.set(r.userId, arr);
    }
    // Which single sign-on providers each person can sign in through (Users > Link to provider identity).
    const identities = await platformDb(this.db)
      .selectFrom('external_identities as i')
      .innerJoin('sso_providers as p', 'p.id', 'i.provider_id')
      .select(['i.user_id as userId', 'p.name as providerName'])
      .where('i.user_id', 'in', users.map((u) => u.id))
      .orderBy('p.name')
      .execute();
    const ssoByUser = new Map<string, string[]>();
    for (const r of identities) ssoByUser.set(r.userId, [...(ssoByUser.get(r.userId) ?? []), r.providerName]);
    return users.map((u) => ({ ...u, tenants: byUser.get(u.id) ?? [], ssoProviders: ssoByUser.get(u.id) ?? [] }));
  }

  /** Every customer this user belongs to, with its site scope. Used by the
   *  Users admin view. Non-admins only see the customers they share. */
  async memberships(userId: string, actor: { id: string; role: Role }) {
    let q = platformDb(this.db)
      .selectFrom('tenant_memberships as m')
      .innerJoin('tenants as t', 't.id', 'm.tenant_id')
      .select(['t.id as tenantId', 't.name as tenantName', 't.slug as tenantSlug', 'm.site_ids as siteIds'])
      .where('m.user_id', '=', userId)
      .orderBy('t.name');
    if (actor.role !== 'SUPER_ADMIN') {
      q = q.where('m.tenant_id', 'in', (eb) =>
        eb.selectFrom('tenant_memberships').select('tenant_id').where('user_id', '=', actor.id),
      );
    }
    const rows = await q.execute();
    return rows.map((r) => ({
      tenantId: r.tenantId,
      tenantName: r.tenantName,
      tenantSlug: r.tenantSlug,
      siteIds: Array.isArray(r.siteIds) ? r.siteIds : [],
    }));
  }

  async create(input: CreateUserInput, actor: UserActor) {
    const exists = await platformDb(this.db)
      .selectFrom('users')
      .select('id')
      .where('email', '=', input.email)
      .executeTakeFirst();
    if (exists) throw new BadRequestException('A user with that email already exists');

    const tenantIds = input.tenantIds ?? [];

    // Engineers and project managers may only create CUSTOMER users, and only
    // inside customers they are assigned to.
    if (actor.role === 'ENGINEER' || actor.role === 'PROJECT_MANAGER') {
      if (input.role !== 'CUSTOMER') {
        throw new ForbiddenException('You may only create customer users');
      }
      if (!tenantIds.length) {
        throw new BadRequestException('Pick the customer this user belongs to');
      }
      const own = await platformDb(this.db)
        .selectFrom('tenant_memberships')
        .select('tenant_id')
        .where('user_id', '=', actor.id!)
        .where('tenant_id', 'in', tenantIds)
        .execute();
      const ownSet = new Set(own.map((r) => r.tenant_id));
      if (tenantIds.some((id) => !ownSet.has(id))) {
        throw new ForbiddenException('You can only add users to customers you are assigned to');
      }
    }

    if (input.role === 'CUSTOMER' && tenantIds.length !== 1) {
      throw new BadRequestException('Customer users must belong to exactly one tenant');
    }

    // Site scoping only applies to a customer user (who has exactly one tenant).
    const siteIds = input.role === 'CUSTOMER' ? [...new Set(input.siteIds ?? [])] : [];
    if (siteIds.length) {
      const tenant = await platformDb(this.db)
        .selectFrom('tenants')
        .select('schema_name')
        .where('id', '=', tenantIds[0])
        .executeTakeFirst();
      if (!tenant) throw new BadRequestException('Unknown customer');
      const rows = await tenantDb(this.db, tenant.schema_name)
        .selectFrom('discovery_sites')
        .select('id')
        .where('id', 'in', siteIds)
        .execute();
      const found = new Set(rows.map((r) => r.id));
      const missing = siteIds.filter((id) => !found.has(id));
      if (missing.length) {
        throw new BadRequestException(`Unknown site(s) for this customer: ${missing.join(', ')}`);
      }
    }

    // The system issues a one-time password, emails it, and forces a reset on
    // first sign-in (before MFA enrolment).
    const tempPassword = generateTempPassword();
    const passwordHash = await argon2.hash(tempPassword, ARGON);
    const user = await platformDb(this.db)
      .insertInto('users')
      .values({
        email: input.email,
        password_hash: passwordHash,
        display_name: input.displayName,
        role: input.role,
        must_change_password: true,
        // A Super Admin created here keeps password + authenticator sign-in even if local passwords are switched off (docs/SSO.md 4.6).
        break_glass: input.role === 'SUPER_ADMIN',
        msp_id: input.role === 'ENGINEER' || input.role === 'PROJECT_MANAGER' ? (input.mspId ?? null) : null,
      })
      .returning(['id', 'email', 'display_name', 'role', 'status'])
      .executeTakeFirstOrThrow();

    for (const tenantId of tenantIds) {
      await platformDb(this.db)
        .insertInto('tenant_memberships')
        .values({
          user_id: user.id,
          tenant_id: tenantId,
          added_by: actor.id ?? null,
          site_ids: tenantId === tenantIds[0] ? siteIds : [],
        })
        .onConflict((oc) => oc.doNothing())
        .execute();
    }

    await this.audit.platform('user.created', {
      actor,
      targetType: 'user',
      targetId: user.id,
      detail: { role: user.role, tenantIds, siteIds },
    });

    const mspId = input.role === 'ENGINEER' || input.role === 'PROJECT_MANAGER' ? (input.mspId ?? null) : null;
    await this.sendInvitation(user.id, user.email, user.display_name, user.role, tenantIds, mspId, tempPassword, actor);

    // tempPassword is surfaced to the admin once (the create dialog) as a
    // fallback for when SMTP is not yet configured. Never audited/logged here.
    return { ...user, tempPassword };
  }

  /**
   * Build the invitation context and enqueue it on the mail queue. Also
   * resolves which branding (if any) the email should render: an MSP
   * staff (ENGINEER/PROJECT_MANAGER) recipient gets their MSP's branding
   * (same domain-match/override lookup as the app chrome uses, see
   * resolveMspId), a CUSTOMER with exactly one tenant gets that tenant's -
   * anything ambiguous (zero/many tenants, no MSP match) falls back to
   * default Voxshift branding, same as before this fix.
   */
  private async sendInvitation(
    userId: string,
    email: string,
    displayName: string,
    role: string,
    tenantIds: string[],
    mspId: string | null,
    tempPassword: string,
    actor: UserActor,
  ) {
    const brandingMspId =
      role === 'ENGINEER' || role === 'PROJECT_MANAGER' ? await resolveMspId(this.db, email, mspId) : null;
    const brandingTenantId = !brandingMspId && tenantIds.length === 1 ? tenantIds[0] : null;

    const tenantNames = tenantIds.length
      ? (
          await platformDb(this.db)
            .selectFrom('tenants')
            .select('name')
            .where('id', 'in', tenantIds)
            .orderBy('name')
            .execute()
        ).map((r) => r.name)
      : [];

    // The one-time password is stored encrypted, only so the worker can put it in the email; the worker removes it once the
    // message is handled (apps/worker/src/mail/invitation-secret.ts). The admin sees it once, in the Users screen.
    const { tempPassword: _plain, ...rest }: UserInvitationContext = {
      displayName,
      inviterEmail: actor.email ?? 'the platform team',
      role,
      tenantNames,
      tempPassword,
      signInUrl: this.cfg.WEB_ORIGIN,
    };
    const context = { ...rest, tempPasswordEnc: encryptSecret(tempPassword) };

    await this.mail.enqueue({
      template: 'user_invitation',
      to: { email, name: displayName },
      context: context as unknown as Record<string, unknown>,
      related: { type: 'user', id: userId },
      createdBy: actor.id ?? null,
      tenantId: brandingTenantId,
      mspId: brandingMspId,
    });
  }

  /**
   * Issue a fresh temporary password and re-send the invitation. Also acts as an
   * admin "reset & re-invite" when the user never completed first sign-in.
   */
  async resendInvitation(id: string, actor: UserActor) {
    const user = await platformDb(this.db)
      .selectFrom('users')
      .select(['id', 'email', 'display_name', 'role', 'status', 'msp_id', 'password_hash'])
      .where('id', '=', id)
      .executeTakeFirst();
    if (!user) throw new NotFoundException('user not found');

    if (actor.role === 'ENGINEER' || actor.role === 'PROJECT_MANAGER') {
      if (user.role !== 'CUSTOMER') {
        throw new ForbiddenException('You may only re-invite customer users');
      }
      const shared = await platformDb(this.db)
        .selectFrom('tenant_memberships as mine')
        .innerJoin('tenant_memberships as theirs', 'theirs.tenant_id', 'mine.tenant_id')
        .select('theirs.user_id')
        .where('mine.user_id', '=', actor.id!)
        .where('theirs.user_id', '=', id)
        .executeTakeFirst();
      if (!shared) {
        throw new ForbiddenException('You can only re-invite users in your own customers');
      }
    }

    // An account that exists only through a single sign-on provider has no password to reset. Issuing one would turn it into a local
    // account (and let the person around the provider's MFA and role limits), so the invitation is refused. docs/SSO.md 4.4.
    if (!hasUsablePassword(user.password_hash)) {
      throw new BadRequestException('This person signs in through single sign-on and has no local password, so there is nothing to re-send. They sign in with the "Sign in with ..." button on the login page.');
    }

    const memberships = await platformDb(this.db)
      .selectFrom('tenant_memberships')
      .select('tenant_id')
      .where('user_id', '=', id)
      .execute();
    const tenantIds = memberships.map((m) => m.tenant_id);

    const tempPassword = generateTempPassword();
    const passwordHash = await argon2.hash(tempPassword, ARGON);
    await platformDb(this.db)
      .updateTable('users')
      .set({
        password_hash: passwordHash,
        must_change_password: true,
        updated_at: new Date().toISOString(),
      })
      .where('id', '=', id)
      .execute();
    await platformDb(this.db)
      .updateTable('auth_sessions')
      .set({ revoked_at: new Date().toISOString() })
      .where('user_id', '=', id)
      .where('revoked_at', 'is', null)
      .execute();

    await this.audit.platform('user.invite_resent', {
      actor,
      targetType: 'user',
      targetId: id,
    });

    await this.sendInvitation(
      user.id,
      user.email,
      user.display_name,
      user.role,
      tenantIds,
      user.msp_id,
      tempPassword,
      actor,
    );
    return { id: user.id, email: user.email, tempPassword };
  }

  /**
   * While a single sign-on provider has switched local passwords off, the break-glass administrators are the only way back in if the
   * provider fails (docs/SSO.md 4.6). Refuse to remove or disable the last one then.
   */
  private async protectLastBreakGlass(id: string, what: string): Promise<void> {
    const target = await platformDb(this.db).selectFrom('users').select('break_glass').where('id', '=', id).executeTakeFirst();
    if (!target?.break_glass || (await localPasswordsAllowed(this.db))) return;
    const others = await platformDb(this.db)
      .selectFrom('users')
      .select('id')
      .where('break_glass', '=', true)
      .where('role', '=', 'SUPER_ADMIN')
      .where('status', '=', 'active')
      .where('id', '!=', id)
      .limit(1)
      .executeTakeFirst();
    if (!others) {
      throw new BadRequestException(`You cannot ${what} the last local (break-glass) administrator while single sign-on has local passwords switched off. Create another local administrator first, or switch local passwords back on.`);
    }
  }

  /**
   * Make a local Super Admin a break-glass administrator, or take that away (docs/SSO.md 4.6). Break-glass is set automatically when a Super
   * Admin is created here; this is the deliberate way to give it to (or remove it from) an account that became Super Admin some other way,
   * e.g. a local account that was promoted. An account that exists only through a provider (no password) or that is linked to a provider
   * cannot be break-glass: break-glass means "signs in here with a password and authenticator, whatever the provider says".
   */
  async setBreakGlass(id: string, enabled: boolean, actor: AuditActor) {
    const user = await platformDb(this.db).selectFrom('users').select(['id', 'email', 'role', 'status', 'break_glass', 'password_hash']).where('id', '=', id).executeTakeFirst();
    if (!user) throw new NotFoundException('user not found');
    if (user.break_glass === enabled) return { id, break_glass: enabled };
    if (enabled) {
      if (user.role !== 'SUPER_ADMIN') throw new BadRequestException('Only a Super Admin can be a break-glass administrator.');
      if (!hasUsablePassword(user.password_hash)) {
        throw new BadRequestException('This account has no local password (it exists only through a single sign-on provider), so it cannot be a break-glass administrator. Create a separate local administrator instead.');
      }
      const linked = await platformDb(this.db).selectFrom('external_identities').select('id').where('user_id', '=', id).limit(1).executeTakeFirst();
      if (linked) {
        throw new BadRequestException('This account is linked to a single sign-on provider. A break-glass administrator signs in only with a password and authenticator, so remove the link first (Link to provider identity), or create a separate local administrator.');
      }
    } else {
      await this.protectLastBreakGlass(id, 'remove break-glass from');
    }
    await platformDb(this.db).updateTable('users').set({ break_glass: enabled, updated_at: new Date().toISOString() }).where('id', '=', id).execute();
    await this.audit.platform('user.break_glass_changed', { actor, targetType: 'user', targetId: id, detail: { breakGlass: enabled, email: user.email } });
    return { id, break_glass: enabled };
  }

  async setStatus(id: string, status: 'active' | 'disabled', actor: AuditActor) {
    if (status === 'disabled') await this.protectLastBreakGlass(id, 'disable');
    const updated = await platformDb(this.db)
      .updateTable('users')
      .set({ status, updated_at: new Date().toISOString() })
      .where('id', '=', id)
      .returning(['id', 'status'])
      .executeTakeFirst();
    if (!updated) throw new NotFoundException('user not found');
    if (status === 'disabled') {
      await platformDb(this.db)
        .updateTable('auth_sessions')
        .set({ revoked_at: new Date().toISOString() })
        .where('user_id', '=', id)
        .where('revoked_at', 'is', null)
        .execute();
    }
    await this.audit.platform('user.status_changed', {
      actor,
      targetType: 'user',
      targetId: id,
      detail: { status },
    });
    return updated;
  }

  /**
   * Permanently delete an account. SUPER_ADMIN only (enforced by the permission
   * guard). Cascades remove the user's memberships, TOTP secret and sessions;
   * `email_messages.created_by` is nulled. Refuses to delete the caller or the
   * last active super admin so nobody can lock everyone out.
   */
  async delete(id: string, actor: UserActor) {
    if (id === actor.id) {
      throw new BadRequestException('You cannot delete your own account');
    }
    const user = await platformDb(this.db)
      .selectFrom('users')
      .select(['id', 'email', 'role'])
      .where('id', '=', id)
      .executeTakeFirst();
    if (!user) throw new NotFoundException('user not found');
    await this.protectLastBreakGlass(id, 'delete');

    if (user.role === 'SUPER_ADMIN') {
      const others = await platformDb(this.db)
        .selectFrom('users')
        .select(({ fn }) => fn.countAll<string>().as('n'))
        .where('role', '=', 'SUPER_ADMIN')
        .where('status', '=', 'active')
        .where('id', '!=', id)
        .executeTakeFirstOrThrow();
      if (Number(others.n) === 0) {
        throw new BadRequestException('Cannot delete the last active super admin');
      }
    }

    // `platform.invitations.invited_by` is NOT NULL with no ON DELETE action, so
    // clear any (legacy) rows this user raised before removing the account.
    await platformDb(this.db).deleteFrom('invitations').where('invited_by', '=', id).execute();
    await platformDb(this.db).deleteFrom('users').where('id', '=', id).execute();

    await this.audit.platform('user.deleted', {
      actor,
      targetType: 'user',
      targetId: id,
      detail: { email: user.email, role: user.role },
    });
    return { ok: true };
  }

  /**
   * The explicit per-user MSP-branding fallback (used only when the user's
   * email domain doesn't match any MSP's domain list - see
   * auth.service.ts's resolveMspBranding). SUPER_ADMIN only.
   */
  async setMspOverride(id: string, mspId: string | null, actor: AuditActor) {
    const updated = await platformDb(this.db)
      .updateTable('users')
      .set({ msp_id: mspId, updated_at: new Date().toISOString() })
      .where('id', '=', id)
      .returning(['id', 'msp_id'])
      .executeTakeFirst();
    if (!updated) throw new NotFoundException('user not found');
    await this.audit.platform('user.msp_override_changed', {
      actor,
      targetType: 'user',
      targetId: id,
      detail: { mspId },
    });
    return updated;
  }

  async resetMfa(id: string, actor: AuditActor) {
    await platformDb(this.db).deleteFrom('totp_secrets').where('user_id', '=', id).execute();
    await platformDb(this.db)
      .updateTable('users')
      .set({ totp_enrolled: false, updated_at: new Date().toISOString() })
      .where('id', '=', id)
      .execute();
    await platformDb(this.db)
      .updateTable('auth_sessions')
      .set({ revoked_at: new Date().toISOString() })
      .where('user_id', '=', id)
      .where('revoked_at', 'is', null)
      .execute();
    await this.audit.platform('user.mfa_reset', { actor, targetType: 'user', targetId: id });
    return { ok: true };
  }
}
