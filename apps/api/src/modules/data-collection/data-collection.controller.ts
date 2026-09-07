import { Body, Controller, Get, Post, Put, UseGuards } from '@nestjs/common';
import { tenantDb } from '@tvmf/db';
import { CurrentUser, TenantCtx } from '../../auth/auth.decorators';
import { AuditService } from '../../common/audit.service';
import type { AuthedUser, TenantContext } from '../../common/request';
import { InjectDb, type Db } from '../../db/db.module';
import { RequirePermission } from '../../rbac/require-permission.decorator';
import { TenantGuard } from '../../rbac/tenant.guard';

/**
 * Data Collection view — replaces the customer-filled discovery workbook.
 * Scaffold: the discovery header record + sites. The full form set is a
 * follow-up (see docs/DATA-MODEL.md "Data Collection").
 */
@Controller('t/:tenantId/discovery')
@UseGuards(TenantGuard)
export class DataCollectionController {
  constructor(
    @InjectDb() private readonly db: Db,
    private readonly audit: AuditService,
  ) {}

  @Get()
  @RequirePermission('discovery:read')
  async get(@TenantCtx() t: TenantContext) {
    const scoped = tenantDb(this.db, t.schema);
    const [discovery, sites, ranges, network] = await Promise.all([
      scoped.selectFrom('discovery').selectAll().executeTakeFirst(),
      scoped.selectFrom('discovery_sites').selectAll().orderBy('name').execute(),
      scoped.selectFrom('discovery_number_ranges').selectAll().orderBy('range_start').execute(),
      scoped.selectFrom('discovery_network').selectAll().execute(),
    ]);
    return { discovery, sites, ranges, network };
  }

  @Put('general')
  @RequirePermission('discovery:write')
  async putGeneral(
    @TenantCtx() t: TenantContext,
    @CurrentUser() user: AuthedUser,
    @Body() body: Record<string, unknown>,
  ) {
    const row = await tenantDb(this.db, t.schema)
      .updateTable('discovery')
      .set({ general: body ?? {}, updated_at: new Date().toISOString() })
      .returning(['id', 'general', 'status'])
      .executeTakeFirst();
    await this.audit.tenant(t.schema, 'discovery.general_updated', {
      actor: { id: user.id, email: user.email },
    });
    return row;
  }

  @Post('sites')
  @RequirePermission('discovery:write')
  async addSite(
    @TenantCtx() t: TenantContext,
    @CurrentUser() user: AuthedUser,
    @Body() body: { site_code?: string; name?: string; address?: string; country?: string; region?: string },
  ) {
    const site = await tenantDb(this.db, t.schema)
      .insertInto('discovery_sites')
      .values({
        site_code: body.site_code ?? null,
        name: body.name ?? null,
        address: body.address ?? null,
        country: body.country ?? null,
        region: body.region ?? null,
        paging: {},
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    await this.audit.tenant(t.schema, 'discovery.site_added', {
      actor: { id: user.id, email: user.email },
      targetType: 'discovery_site',
      targetId: site.id,
    });
    return site;
  }

  @Post('submit')
  @RequirePermission('discovery:write')
  async submit(@TenantCtx() t: TenantContext, @CurrentUser() user: AuthedUser) {
    const row = await tenantDb(this.db, t.schema)
      .updateTable('discovery')
      .set({ status: 'submitted', submitted_by: user.id, submitted_at: new Date().toISOString() })
      .returning(['id', 'status', 'submitted_at'])
      .executeTakeFirst();
    await this.audit.tenant(t.schema, 'discovery.submitted', {
      actor: { id: user.id, email: user.email },
    });
    await this.audit.platform('discovery.submitted', {
      actor: { id: user.id, email: user.email },
      tenantId: t.id,
    });
    return row;
  }
}
