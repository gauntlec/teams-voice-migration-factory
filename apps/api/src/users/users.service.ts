import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import * as argon2 from 'argon2';
import { platformDb } from '@tvmf/db';
import type { CreateUserInput } from '@tvmf/shared';
import { AuditService } from '../common/audit.service';
import type { AuditActor } from '../common/audit.service';
import { InjectDb, type Db } from '../db/db.module';

const ARGON = { type: argon2.argon2id, memoryCost: 19456, timeCost: 2, parallelism: 1 } as const;

@Injectable()
export class UsersService {
  constructor(
    @InjectDb() private readonly db: Db,
    private readonly audit: AuditService,
  ) {}

  list() {
    return platformDb(this.db)
      .selectFrom('users')
      .select(['id', 'email', 'display_name', 'role', 'status', 'totp_enrolled', 'created_at'])
      .orderBy('created_at', 'desc')
      .execute();
  }

  async create(input: CreateUserInput, actor: AuditActor) {
    const exists = await platformDb(this.db)
      .selectFrom('users')
      .select('id')
      .where('email', '=', input.email)
      .executeTakeFirst();
    if (exists) throw new BadRequestException('A user with that email already exists');

    if (input.role === 'CUSTOMER' && (input.tenantIds?.length ?? 0) !== 1) {
      throw new BadRequestException('Customer users must belong to exactly one tenant');
    }

    const passwordHash = await argon2.hash(input.password, ARGON);
    const user = await platformDb(this.db)
      .insertInto('users')
      .values({
        email: input.email,
        password_hash: passwordHash,
        display_name: input.displayName,
        role: input.role,
      })
      .returning(['id', 'email', 'display_name', 'role', 'status'])
      .executeTakeFirstOrThrow();

    for (const tenantId of input.tenantIds ?? []) {
      await platformDb(this.db)
        .insertInto('tenant_memberships')
        .values({ user_id: user.id, tenant_id: tenantId, added_by: actor.id ?? null })
        .onConflict((oc) => oc.doNothing())
        .execute();
    }

    await this.audit.platform('user.created', {
      actor,
      targetType: 'user',
      targetId: user.id,
      detail: { role: user.role, tenantIds: input.tenantIds ?? [] },
    });
    return user;
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
