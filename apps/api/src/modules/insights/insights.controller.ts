import { Controller, Get, Param, ParseUUIDPipe, Query, Res, UseGuards } from '@nestjs/common';
import type { Response } from 'express';
import {
  insightsHistoryQuerySchema,
  insightsPeriodQuerySchema,
  reportFileName,
  reportQuerySchema,
  type ReportQuery,
  type InsightsHistoryQuery,
  type InsightsPeriodQuery,
} from '@tvmf/shared';
import { CurrentUser, TenantCtx } from '../../auth/auth.decorators';
import type { AuthedUser, TenantContext } from '../../common/request';
import { ZodBody } from '../../common/zod.pipe';
import { RequirePermission } from '../../rbac/require-permission.decorator';
import { TenantGuard } from '../../rbac/tenant.guard';
import { InsightsReportsService } from './insights-reports.service';
import { InsightsService } from './insights.service';
import { renderReportPdf } from './report-pdf';

/**
 * Voxshift Insights (docs/INSIGHTS.md): the figures behind the Overview and Reports. Readable by every role on the
 * customer; what each role sees is cut down in InsightsService.
 */
@Controller('t/:tenantId/insights')
@UseGuards(TenantGuard)
export class InsightsController {
  constructor(
    private readonly svc: InsightsService,
    private readonly reports: InsightsReportsService,
  ) {}

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

  /** The Change log report: changes live runs made in the customer's Teams tenant (deployments or tenant audit readers). */
  @Get('changes')
  @RequirePermission('tenant:read')
  changes(@TenantCtx() t: TenantContext, @CurrentUser() user: AuthedUser, @Query(new ZodBody(insightsPeriodQuerySchema)) q: InsightsPeriodQuery) {
    return this.svc.changeLog(t, user.role, q);
  }

  /** The site's go-live date (its overview's Target go-live) and the date first agreed. */
  @Get('sites/:siteId/go-live')
  @RequirePermission('discovery:read')
  goLive(@TenantCtx() t: TenantContext, @Param('siteId', ParseUUIDPipe) siteId: string) {
    return this.svc.goLive(t, siteId);
  }

  /** Any report as a branded PDF (Reports > the report > Download PDF). The same period query as the Reports page. */
  @Get('reports/:key/pdf')
  @RequirePermission('tenant:read')
  async reportPdf(
    @TenantCtx() t: TenantContext,
    @CurrentUser() user: AuthedUser,
    @Param('key') key: string,
    @Query(new ZodBody(reportQuerySchema)) q: ReportQuery,
    @Res() res: Response,
  ) {
    const doc = await this.reports.build(t, user.role, key, q);
    const pdf = await renderReportPdf(doc, t.name);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${reportFileName(doc, t.name)}.pdf"`);
    res.setHeader('Cache-Control', 'no-store');
    res.send(pdf);
  }
}
