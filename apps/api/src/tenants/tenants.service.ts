import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { platformDb, provisionTenant, tenantSchemaName } from '@tvmf/db';
import type { CreateTenantInput, Role } from '@tvmf/shared';
import { AuditService, type AuditActor } from '../common/audit.service';
import { InjectDb, type Db } from '../db/db.module';
import { PG_POOL } from '../db/db.module';
import type { Pool } from 'pg';

@Injectable()
export class TenantsService {
  constructor(
    @InjectDb() private readonly db: Db,
    @Inject(PG_POOL) private readonly pool: Pool,
    private readonly audit: AuditService,
  ) {}

  async list(user: { id: string; role: Role }) {
    const q = platformDb(this.db)
      .selectFrom('tenants')
      .select(['id', 'slug', 'name', 'primary_domain', 'status', 'created_at'])
      .orderBy('name');
    if (user.role === 'SUPER_ADMIN') return q.execute();
    return q
      .where('id', 'in', (eb) =>
        eb
          .selectFrom('tenant_memberships')
          .select('tenant_id')
          .where('user_id', '=', user.id),
      )
      .where('status', '=', 'active')
      .execute();
  }

  async create(input: CreateTenantInput, actor: AuditActor) {
    const dup = await platformDb(this.db)
      .selectFrom('tenants')
      .select('id')
      .where('slug', '=', input.slug)
      .executeTakeFirst();
    if (dup) throw new BadRequestException('That slug is already taken');

    const id = randomUUID();
    const schema = tenantSchemaName(id);

    const tenant = await platformDb(this.db)
      .insertInto('tenants')
      .values({
        id,
        slug: input.slug,
        name: input.name,
        schema_name: schema,
        primary_domain: input.primaryDomain ?? null,
        created_by: actor.id ?? null,
      })
      .returning(['id', 'slug', 'name', 'schema_name', 'status', 'created_at'])
      .executeTakeFirstOrThrow();

    // Provision the isolated schema for this customer.
    await provisionTenant(this.pool, schema);

    await this.audit.platform('tenant.created', {
      actor,
      targetType: 'tenant',
      targetId: id,
      tenantId: id,
      detail: { slug: input.slug, schema },
    });
    return tenant;
  }

  async members(tenantId: string) {
    await this.getTenantOrThrow(tenantId);
    return platformDb(this.db)
      .selectFrom('tenant_memberships as m')
      .innerJoin('users as u', 'u.id', 'm.user_id')
      .select(['u.id as id', 'u.email as email', 'u.display_name as displayName', 'u.role as role', 'm.created_at as addedAt'])
      .where('m.tenant_id', '=', tenantId)
      .orderBy('u.display_name')
      .execute();
  }

  async addMember(
    tenantId: string,
    userId: string,
    actor: AuditActor & { role: Role },
  ) {
    await this.getTenantOrThrow(tenantId);
    const target = await platformDb(this.db)
      .selectFrom('users')
      .select(['id', 'role'])
      .where('id', '=', userId)
      .executeTakeFirst();
    if (!target) throw new NotFoundException('user not found');

    if (actor.role === 'ENGINEER') {
      await this.assertActorIsMember(tenantId, actor.id!);
      if (target.role !== 'CUSTOMER') {
        throw new ForbiddenException('Engineers may only add customer users to a tenant');
      }
    }
    if (target.role === 'SUPER_ADMIN') {
      throw new BadRequestException('Super admins are not scoped to tenants');
    }
    if (target.role === 'CUSTOMER') {
      const existing = await platformDb(this.db)
        .selectFrom('tenant_memberships')
        .select('tenant_id')
        .where('user_id', '=', userId)
        .executeTakeFirst();
      if (existing && existing.tenant_id !== tenantId) {
        throw new BadRequestException('Customer users may belong to only one tenant');
      }
    }

    await platformDb(this.db)
      .insertInto('tenant_memberships')
      .values({ user_id: userId, tenant_id: tenantId, added_by: actor.id ?? null })
      .onConflict((oc) => oc.doNothing())
      .execute();
    await this.audit.platform('tenant.member_added', {
      actor,
      targetType: 'tenant',
      targetId: tenantId,
      tenantId,
      detail: { userId },
    });
    return { ok: true };
  }

  async removeMember(tenantId: string, userId: string, actor: AuditActor & { role: Role }) {
    await this.getTenantOrThrow(tenantId);
    if (actor.role === 'ENGINEER') await this.assertActorIsMember(tenantId, actor.id!);
    await platformDb(this.db)
      .deleteFrom('tenant_memberships')
      .where('tenant_id', '=', tenantId)
      .where('user_id', '=', userId)
      .execute();
    await this.audit.platform('tenant.member_removed', {
      actor,
      targetType: 'tenant',
      targetId: tenantId,
      tenantId,
      detail: { userId },
    });
    return { ok: true };
  }

  private async getTenantOrThrow(tenantId: string) {
    const t = await platformDb(this.db)
      .selectFrom('tenants')
      .select(['id', 'status'])
      .where('id', '=', tenantId)
      .executeTakeFirst();
    if (!t) throw new NotFoundException('tenant not found');
    return t;
  }

  private async assertActorIsMember(tenantId: string, userId: string) {
    const m = await platformDb(this.db)
      .selectFrom('tenant_memberships')
      .select('user_id')
      .where('tenant_id', '=', tenantId)
      .where('user_id', '=', userId)
      .executeTakeFirst();
    if (!m) throw new ForbiddenException('Not a member of this tenant');
  }
}
