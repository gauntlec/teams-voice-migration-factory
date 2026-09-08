import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { platformDb, provisionTenant, tenantDb, tenantSchemaName } from '@tvmf/db';
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

  /** Sites in a customer, for the admin scope pickers. Admin & engineer only. */
  async sites(tenantId: string, actor: { id?: string; role: Role }) {
    const t = await this.getTenantOrThrow(tenantId);
    if (actor.role !== 'SUPER_ADMIN') await this.assertActorIsMember(tenantId, actor.id!);
    return tenantDb(this.db, t.schema_name)
      .selectFrom('discovery_sites')
      .select(['id', 'sitecode', 'name'])
      .orderBy('sitecode')
      .execute();
  }

  async members(tenantId: string, actor: { id?: string; role: Role }) {
    await this.getTenantOrThrow(tenantId);
    if (actor.role !== 'SUPER_ADMIN') await this.assertActorIsMember(tenantId, actor.id!);
    return platformDb(this.db)
      .selectFrom('tenant_memberships as m')
      .innerJoin('users as u', 'u.id', 'm.user_id')
      .select([
        'u.id as id',
        'u.email as email',
        'u.display_name as displayName',
        'u.role as role',
        'm.created_at as addedAt',
        'm.site_ids as siteIds',
      ])
      .where('m.tenant_id', '=', tenantId)
      .orderBy('u.display_name')
      .execute();
  }

  async addMember(
    tenantId: string,
    userId: string,
    actor: AuditActor & { role: Role },
    siteIds: string[] = [],
  ) {
    const tenant = await this.getTenantOrThrow(tenantId);
    const target = await platformDb(this.db)
      .selectFrom('users')
      .select(['id', 'role'])
      .where('id', '=', userId)
      .executeTakeFirst();
    if (!target) throw new NotFoundException('user not found');

    if (actor.role !== 'SUPER_ADMIN') {
      await this.assertActorIsMember(tenantId, actor.id!);
      if (target.role !== 'CUSTOMER') {
        throw new ForbiddenException('Only super admins can assign staff to a customer');
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

    // Site scoping only applies to customer users.
    const scoped = target.role === 'CUSTOMER' ? siteIds : [];
    if (scoped.length) await this.validateSiteIds(tenant.schema_name, scoped);

    await platformDb(this.db)
      .insertInto('tenant_memberships')
      .values({
        user_id: userId,
        tenant_id: tenantId,
        added_by: actor.id ?? null,
        site_ids: scoped,
      })
      .onConflict((oc) => oc.columns(['user_id', 'tenant_id']).doUpdateSet({ site_ids: scoped }))
      .execute();
    await this.audit.platform('tenant.member_added', {
      actor,
      targetType: 'tenant',
      targetId: tenantId,
      tenantId,
      detail: { userId, siteIds: scoped },
    });
    return { ok: true };
  }

  /** Replace a member's site scope. Empty array = whole customer. */
  async setMemberScope(
    tenantId: string,
    userId: string,
    siteIds: string[],
    actor: AuditActor & { role: Role },
  ) {
    const tenant = await this.getTenantOrThrow(tenantId);
    if (actor.role !== 'SUPER_ADMIN') await this.assertActorIsMember(tenantId, actor.id!);

    const member = await platformDb(this.db)
      .selectFrom('tenant_memberships as m')
      .innerJoin('users as u', 'u.id', 'm.user_id')
      .select(['u.role as role'])
      .where('m.tenant_id', '=', tenantId)
      .where('m.user_id', '=', userId)
      .executeTakeFirst();
    if (!member) throw new NotFoundException('member not found');
    if (member.role !== 'CUSTOMER' && siteIds.length) {
      throw new BadRequestException('Only customer users can be limited to specific sites');
    }
    if (siteIds.length) await this.validateSiteIds(tenant.schema_name, siteIds);

    await platformDb(this.db)
      .updateTable('tenant_memberships')
      .set({ site_ids: siteIds })
      .where('tenant_id', '=', tenantId)
      .where('user_id', '=', userId)
      .execute();
    await this.audit.platform('tenant.member_scope_changed', {
      actor,
      targetType: 'tenant',
      targetId: tenantId,
      tenantId,
      detail: { userId, siteIds },
    });
    return { ok: true };
  }

  /** Every id must be a real site in this customer's schema. */
  private async validateSiteIds(schema: string, siteIds: string[]) {
    const unique = [...new Set(siteIds)];
    const rows = await tenantDb(this.db, schema)
      .selectFrom('discovery_sites')
      .select('id')
      .where('id', 'in', unique)
      .execute();
    const found = new Set(rows.map((r) => r.id));
    const missing = unique.filter((id) => !found.has(id));
    if (missing.length) {
      throw new BadRequestException(`Unknown site(s) for this customer: ${missing.join(', ')}`);
    }
  }

  async removeMember(tenantId: string, userId: string, actor: AuditActor & { role: Role }) {
    await this.getTenantOrThrow(tenantId);
    if (actor.role !== 'SUPER_ADMIN') await this.assertActorIsMember(tenantId, actor.id!);
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
      .select(['id', 'status', 'schema_name'])
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
