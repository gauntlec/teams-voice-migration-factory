import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { platformDb, tenantSchemaName } from '@tvmf/db';
import { isGlobalRole } from '@tvmf/shared';
import type { AppRequest } from '../common/request';
import { InjectDb, type Db } from '../db/db.module';

/**
 * For `/t/:tenantId/*` routes. Confirms the caller may act in this tenant and
 * puts `{ id, slug, name, schema }` on the request. This is the ONLY place a
 * tenant schema is resolved for a request. See docs/SECURITY.md.
 */
@Injectable()
export class TenantGuard implements CanActivate {
  constructor(@InjectDb() private readonly db: Db) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest<AppRequest>();
    const user = req.user;
    if (!user) throw new ForbiddenException('Not authenticated');

    const tenantId = req.params.tenantId;
    if (!tenantId) throw new NotFoundException('tenant not specified');

    const tenant = await platformDb(this.db)
      .selectFrom('tenants')
      .select(['id', 'slug', 'name', 'schema_name', 'status', 'teams_read_only'])
      .where('id', '=', tenantId)
      .executeTakeFirst();
    if (!tenant || tenant.status !== 'active') throw new NotFoundException('tenant not found');

    // null = whole-customer access. A CUSTOMER membership may pin `site_ids`,
    // making the caller a "site contact" limited to those sites.
    let siteScope: string[] | null = null;
    if (!isGlobalRole(user.role)) {
      const member = await platformDb(this.db)
        .selectFrom('tenant_memberships')
        .select(['user_id', 'site_ids'])
        .where('user_id', '=', user.id)
        .where('tenant_id', '=', tenantId)
        .executeTakeFirst();
      if (!member) throw new ForbiddenException('Not a member of this tenant');
      if (Array.isArray(member.site_ids) && member.site_ids.length > 0) {
        siteScope = member.site_ids;
      }
    }

    // schema_name is authoritative; fall back to the deterministic name.
    req.tenant = {
      id: tenant.id,
      slug: tenant.slug,
      name: tenant.name,
      schema: tenant.schema_name || tenantSchemaName(tenant.id),
      siteScope,
      teamsReadOnly: tenant.teams_read_only,
    };
    return true;
  }
}
