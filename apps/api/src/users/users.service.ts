import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import * as argon2 from 'argon2';
import { platformDb, tenantDb } from '@tvmf/db';
import type { CreateUserInput, Role, UserInvitationContext } from '@tvmf/shared';
import { AuditService } from '../common/audit.service';
import type { AuditActor } from '../common/audit.service';
import { APP_CONFIG, type AppConfig } from '../common/config';
import { InjectDb, type Db } from '../db/db.module';
import { MailService } from '../mail/mail.service';
import { generateTempPassword } from './password.util';

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

  async list(actor: { id: string; role: Role }) {
    let q = platformDb(this.db)
      .selectFrom('users')
      .select(['id', 'email', 'display_name', 'role', 'status', 'totp_enrolled', 'created_at'])
      .orderBy('created_at', 'desc');
    if (actor.role !== 'SUPER_ADMIN') {
      // Non-admins only see users who belong to a customer they are assigned to.
      q = q.where('id', 'in', (eb) =>
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
    const users = await q.execute();
    if (users.length === 0) return users;

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
    return users.map((u) => ({ ...u, tenants: byUser.get(u.id) ?? [] }));
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

    await this.sendInvitation(user.id, user.email, user.display_name, user.role, tenantIds, tempPassword, actor);

    // tempPassword is surfaced to the admin once (the create dialog) as a
    // fallback for when SMTP is not yet configured. Never audited/logged here.
    return { ...user, tempPassword };
  }

  /** Build the invitation context and enqueue it on the mail queue. */
  private async sendInvitation(
    userId: string,
    email: string,
    displayName: string,
    role: string,
    tenantIds: string[],
    tempPassword: string,
    actor: UserActor,
  ) {
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

    const context: UserInvitationContext = {
      displayName,
      inviterEmail: actor.email ?? 'the platform team',
      role,
      tenantNames,
      tempPassword,
      signInUrl: this.cfg.WEB_ORIGIN,
    };

    await this.mail.enqueue({
      template: 'user_invitation',
      to: { email, name: displayName },
      context: context as unknown as Record<string, unknown>,
      related: { type: 'user', id: userId },
      createdBy: actor.id ?? null,
    });
  }

  /**
   * Issue a fresh temporary password and re-send the invitation. Also acts as an
   * admin "reset & re-invite" when the user never completed first sign-in.
   */
  async resendInvitation(id: string, actor: UserActor) {
    const user = await platformDb(this.db)
      .selectFrom('users')
      .select(['id', 'email', 'display_name', 'role', 'status'])
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
      tempPassword,
      actor,
    );
    return { id: user.id, email: user.email, tempPassword };
  }

  async setStatus(id: string, status: 'active' | 'disabled', actor: AuditActor) {
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
