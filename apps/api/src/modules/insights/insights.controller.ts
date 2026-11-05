import { Body, Controller, Get, Param, ParseUUIDPipe, Put, Query, UseGuards } from '@nestjs/common';
import {
  insightsHistoryQuerySchema,
  insightsPeriodQuerySchema,
  siteGoLiveSchema,
  type InsightsHistoryQuery,
  type InsightsPeriodQuery,
  type SiteGoLiveInput,
} from '@tvmf/shared';
import { CurrentUser, TenantCtx } from '../../auth/auth.decorators';
import type { AuthedUser, TenantContext } from '../../common/request';
import { ZodBody } from '../../common/zod.pipe';
import { RequirePermission } from '../../rbac/require-permission.decorator';
import { TenantGuard } from '../../rbac/tenant.guard';
import { InsightsService } from './insights.service';

/**
 * Voxshift Insights (docs/INSIGHTS.md): the figures behind the Overview and Reports. Readable by every role on the
 * customer; what each role sees is cut down in InsightsService.
 */
@Controller('t/:tenantId/insights')
@UseGuards(TenantGuard)
export class InsightsController {
  constructor(private readonly svc: InsightsService) {}

  @Get('metrics')
  @RequirePermission('tenant:read')
  metrics(@TenantCtx() t: TenantContext, @CurrentUser() user: AuthedUser, @Query(new ZodBody(insightsPeriodQuerySchema)) q: InsightsPeriodQuery) {
    return this.svc.metrics(t, user.role, q);
  }

  @Get('history')
  @RequirePermission('tenant:read')
  history(@TenantCtx() t: TenantContext, @Query(new ZodBody(insightsHistoryQuerySchema)) q: InsightsHistoryQuery) {
    return this.svc.history(t, q);
  }

  @Get('sites/:siteId/go-live')
  @RequirePermission('discovery:read')
  goLive(@TenantCtx() t: TenantContext, @Param('siteId', ParseUUIDPipe) siteId: string) {
    return this.svc.goLive(t, siteId);
  }

  /** Project managers, engineers and admins set the date; customers see it. */
  @Put('sites/:siteId/go-live')
  @RequirePermission('discovery:sites:manage')
  setGoLive(
    @TenantCtx() t: TenantContext,
    @CurrentUser() user: AuthedUser,
    @Param('siteId', ParseUUIDPipe) siteId: string,
    @Body(new ZodBody(siteGoLiveSchema)) body: SiteGoLiveInput,
  ) {
    return this.svc.setGoLive(t, user, siteId, body);
  }
}
