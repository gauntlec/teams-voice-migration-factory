import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { platformDb, tenantDb } from '@tvmf/db';
import { TenantCtx } from '../../auth/auth.decorators';
import type { TenantContext } from '../../common/request';
import { InjectDb, type Db } from '../../db/db.module';
import { RequirePermission } from '../../rbac/require-permission.decorator';
import { TenantGuard } from '../../rbac/tenant.guard';

@Controller()
export class AuditController {
  constructor(@InjectDb() private readonly db: Db) {}

  @Get('t/:tenantId/audit')
  @UseGuards(TenantGuard)
  @RequirePermission('audit:read:tenant')
  tenantLog(@TenantCtx() t: TenantContext, @Query('limit') limit = '200') {
    return tenantDb(this.db, t.schema)
      .selectFrom('audit_log')
      .selectAll()
      .orderBy('at', 'desc')
      .limit(Math.min(Number(limit) || 200, 1000))
      .execute();
  }

  @Get('audit/platform')
  @RequirePermission('audit:read:platform')
  platformLog(@Query('limit') limit = '200') {
    return platformDb(this.db)
      .selectFrom('platform_audit_log')
      .selectAll()
      .orderBy('at', 'desc')
      .limit(Math.min(Number(limit) || 200, 1000))
      .execute();
  }
}
