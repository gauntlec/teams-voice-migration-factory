import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { platformDb, provisionTenant, tenantDb, tenantSchemaName } from '@tvmf/db';
import type { CreateTenantInput, Role, TenantBranding, UpdateTenantBrandingInput } from '@tvmf/shared';
import { AuditService, type AuditActor } from '../common/audit.service';
import { FILE_STORAGE_BACKEND, type FileStorageBackend } from '../modules/files/file-storage.interface';
import { InjectDb, type Db } from '../db/db.module';
import { PG_POOL } from '../db/db.module';
import type { Pool } from 'pg';

/**
 * Allowlisted upload types for a customer logo. Deliberately excludes SVG
 * (script/markup XSS surface) and WebP - classic Outlook desktop (the
 * "Word engine" renderer, still the most common client for this platform's
 * enterprise IT/telecom audience) has no WebP decoder at all, so a WebP logo
 * silently fails to render there while working everywhere else, including
 * in the web app itself and in a quick manual check.
 */
const LOGO_CONTENT_TYPES: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
};

@Injectable()
export class TenantsService {
  constructor(
    @InjectDb() private readonly db: Db,
    @Inject(PG_POOL) private readonly pool: Pool,
    private readonly audit: AuditService,
    @Inject(FILE_STORAGE_BACKEND) private readonly storage: FileStorageBackend,
  ) {}

  async list(user: { id: string; role: Role }) {
    const q = platformDb(this.db)
      .selectFrom('tenants')
      .select(['id', 'slug', 'name', 'primary_domain', 'status', 'teams_read_only', 'branding', 'created_at'])
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

  /**
   * Toggles the per-customer safeguard that blocks every write cmdlet to
   * this customer's live Microsoft Teams tenant - see docs/SECURITY.md.
   * SUPER_ADMIN only (tenant:update, packages/shared/src/rbac.ts).
   */
  async setTeamsReadOnly(tenantId: string, teamsReadOnly: boolean, actor: AuditActor) {
    await this.getTenantOrThrow(tenantId);
    const tenant = await platformDb(this.db)
      .updateTable('tenants')
      .set({ teams_read_only: teamsReadOnly })
      .where('id', '=', tenantId)
      .returning(['id', 'slug', 'name', 'primary_domain', 'status', 'teams_read_only', 'created_at'])
      .executeTakeFirstOrThrow();
    await this.audit.platform('tenant.teams_read_only_changed', {
      actor,
      targetType: 'tenant',
      targetId: tenantId,
      tenantId,
      detail: { teamsReadOnly },
    });
    return tenant;
  }

  /**
   * White-label branding - logo + accent color, editable at any time by
   * whoever can create a customer (tenant:update, same population as
   * tenant:create). null anywhere this is read means "use default Voxshift
   * branding" - see TenantBranding in packages/shared/src/index.ts.
   */
  async updateBranding(tenantId: string, input: UpdateTenantBrandingInput, actor: AuditActor) {
    const t = await this.getTenantOrThrow(tenantId);
    const branding: TenantBranding = { logo: t.branding?.logo ?? null, accentColor: input.accentColor };
    const tenant = await platformDb(this.db)
      .updateTable('tenants')
      .set({ branding })
      .where('id', '=', tenantId)
      .returning(['id', 'slug', 'name', 'primary_domain', 'status', 'teams_read_only', 'branding', 'created_at'])
      .executeTakeFirstOrThrow();
    await this.audit.platform('tenant.branding_updated', {
      actor,
      targetType: 'tenant',
      targetId: tenantId,
      tenantId,
      detail: { accentColor: input.accentColor },
    });
    return tenant;
  }

  async uploadLogo(tenantId: string, file: { buffer: Buffer; mimetype: string } | undefined, actor: AuditActor) {
    if (!file) throw new BadRequestException('No file uploaded');
    const ext = LOGO_CONTENT_TYPES[file.mimetype];
    if (!ext) throw new BadRequestException('Logo must be a PNG, JPEG or WebP image');

    const t = await this.getTenantOrThrow(tenantId);
    const version = (t.branding?.logo?.version ?? 0) + 1;
    const path = `branding/${tenantId}/logo-${version}.${ext}`;
    await this.storage.write(path, file.buffer);
    if (t.branding?.logo) await this.storage.delete(t.branding.logo.path); // old bytes now unreachable - clean up

    const branding: TenantBranding = {
      // Default Voxshift brand color when a logo is uploaded before any
      // color has ever been chosen - keeps `branding` always ramp-buildable.
      accentColor: t.branding?.accentColor ?? '#4657D2',
      logo: { path, contentType: file.mimetype, version },
    };
    const tenant = await platformDb(this.db)
      .updateTable('tenants')
      .set({ branding })
      .where('id', '=', tenantId)
      .returning(['id', 'slug', 'name', 'primary_domain', 'status', 'teams_read_only', 'branding', 'created_at'])
      .executeTakeFirstOrThrow();
    await this.audit.platform('tenant.branding_logo_uploaded', {
      actor,
      targetType: 'tenant',
      targetId: tenantId,
      tenantId,
      detail: { version },
    });
    return tenant;
  }

  async removeLogo(tenantId: string, actor: AuditActor) {
    const t = await this.getTenantOrThrow(tenantId);
    if (t.branding?.logo) await this.storage.delete(t.branding.logo.path);
    const branding: TenantBranding | null = t.branding ? { ...t.branding, logo: null } : null;
    const tenant = await platformDb(this.db)
      .updateTable('tenants')
      .set({ branding })
      .where('id', '=', tenantId)
      .returning(['id', 'slug', 'name', 'primary_domain', 'status', 'teams_read_only', 'branding', 'created_at'])
      .executeTakeFirstOrThrow();
    await this.audit.platform('tenant.branding_logo_removed', { actor, targetType: 'tenant', targetId: tenantId, tenantId });
    return tenant;
  }

  /** Backs the unauthenticated `GET /public/tenants/:id/logo` route - logo bytes are not sensitive. */
  async readLogoBytes(tenantId: string): Promise<{ data: Buffer; contentType: string }> {
    const t = await this.getTenantOrThrow(tenantId);
    if (!t.branding?.logo) throw new NotFoundException('no logo set for this tenant');
    const data = await this.storage.read(t.branding.logo.path);
    return { data, contentType: t.branding.logo.contentType };
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
      .select(['id', 'status', 'schema_name', 'branding'])
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
