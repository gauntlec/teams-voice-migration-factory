import { Body, Controller, Delete, ForbiddenException, Get, HttpCode, Param, ParseUUIDPipe, Post, Put, Query, Res, UseGuards } from '@nestjs/common';
import type { Response } from 'express';
import {
  insightsPeriod,
  insightsHistoryQuerySchema,
  insightsPeriodQuerySchema,
  reportFileName,
  reportQuerySchema,
  reportScheduleSchema,
  type ReportScheduleInput,
  type ReportQuery,
  type InsightsHistoryQuery,
  type InsightsPeriodQuery,
} from '@tvmf/shared';
import { CurrentUser, TenantCtx } from '../../auth/auth.decorators';
import type { AuthedUser, TenantContext } from '../../common/request';
import { ZodBody } from '../../common/zod.pipe';
import { RequirePermission } from '../../rbac/require-permission.decorator';
import { TenantGuard } from '../../rbac/tenant.guard';
import { DocumentBrandingService } from '../branding/document-branding.service';
import { narrowToSite } from '../data-collection/site-scope';
import { InsightsAssistantsService } from './insights-assistants.service';
import { InsightsReportsService } from './insights-reports.service';
import { InsightsScheduleService } from './insights-schedule.service';
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
    private readonly schedules: InsightsScheduleService,
    private readonly branding: DocumentBrandingService,
    private readonly assistants: InsightsAssistantsService,
  ) {}

  @Get('metrics')
  @RequirePermission('tenant:read')
  metrics(@TenantCtx() t: TenantContext, @CurrentUser() user: AuthedUser, @Query(new ZodBody(insightsPeriodQuerySchema)) q: InsightsPeriodQuery) {
    return this.svc.metrics(narrowToSite(t, q.site), user.role, q);
  }

  @Get('history')
  @RequirePermission('tenant:read')
  history(@TenantCtx() t: TenantContext, @Query(new ZodBody(insightsHistoryQuerySchema)) q: InsightsHistoryQuery) {
    return this.svc.history(narrowToSite(t, q.site), q);
  }

  /** The Change log report: changes live runs made in the customer's Teams tenant (deployments or tenant audit readers). */
  @Get('changes')
  @RequirePermission('tenant:read')
  changes(@TenantCtx() t: TenantContext, @CurrentUser() user: AuthedUser, @Query(new ZodBody(insightsPeriodQuerySchema)) q: InsightsPeriodQuery) {
    return this.svc.changeLog(narrowToSite(t, q.site), user.role, q);
  }

  /** The Number management report: every range and number in Site Data, and who has the assigned ones. */
  @Get('numbers')
  @RequirePermission('discovery:read')
  numbers(@TenantCtx() t: TenantContext, @Query(new ZodBody(insightsPeriodQuerySchema)) q: InsightsPeriodQuery) {
    return this.svc.numbers(narrowToSite(t, q.site));
  }

  /** The Assistant activity report: what the AI assistants did in the period (Managed Services, inc:read or sr:read). */
  @Get('assistants')
  @RequirePermission('tenant:read')
  assistantActivity(@TenantCtx() t: TenantContext, @CurrentUser() user: AuthedUser, @Query(new ZodBody(insightsPeriodQuerySchema)) q: InsightsPeriodQuery) {
    return this.assistants.activity(narrowToSite(t, q.site), user.role, insightsPeriod(q));
  }

  /** The Device status report's period figures (step 6d): each device's availability, from the daily readings. */
  @Get('devices/availability')
  @RequirePermission('monitoring:read')
  deviceAvailability(@TenantCtx() t: TenantContext, @Query(new ZodBody(insightsHistoryQuerySchema)) q: InsightsHistoryQuery) {
    if (!t.monitoringEnabled) throw new ForbiddenException('Monitoring is not switched on for this customer.');
    return this.svc.deviceAvailability(narrowToSite(t, q.site), q);
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
    const pdf = await renderReportPdf(doc, t.name, new Date(), await this.branding.forDocuments(t.id));
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${reportFileName(doc, t.name)}.pdf"`);
    res.setHeader('Cache-Control', 'no-store');
    res.send(pdf);
  }

  /* Scheduled reports (step 4b): staff set them up; everyone on the customer can see who gets what. */

  @Get('schedules')
  @RequirePermission('reports:schedule')
  listSchedules(@TenantCtx() t: TenantContext) {
    return this.schedules.list(t);
  }

  /** Reports › Sent: every scheduled report emailed for this customer, newest first. */
  @Get('schedules/sent')
  @RequirePermission('reports:schedule')
  sentReports(@TenantCtx() t: TenantContext) {
    return this.schedules.sent(t);
  }

  /** The PDF a sent copy carried, while it is kept (90 days). */
  @Get('schedules/sent/:messageId/pdf')
  @RequirePermission('reports:schedule')
  async sentReportPdf(@TenantCtx() t: TenantContext, @Param('messageId', ParseUUIDPipe) messageId: string, @Res() res: Response) {
    const { filename, content } = await this.schedules.sentPdf(t, messageId);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${filename.replace(/["\\\r\n]/g, '')}"`);
    res.setHeader('Cache-Control', 'no-store');
    res.send(content);
  }

  /** Who a report can be sent to: people who can open this customer. */
  @Get('schedules/recipients')
  @RequirePermission('reports:schedule')
  scheduleRecipients(@TenantCtx() t: TenantContext) {
    return this.schedules.candidates(t);
  }

  @Post('schedules')
  @RequirePermission('reports:schedule')
  createSchedule(@TenantCtx() t: TenantContext, @CurrentUser() user: AuthedUser, @Body(new ZodBody(reportScheduleSchema)) body: ReportScheduleInput) {
    return this.schedules.create(t, user, body);
  }

  @Put('schedules/:id')
  @RequirePermission('reports:schedule')
  updateSchedule(
    @TenantCtx() t: TenantContext,
    @CurrentUser() user: AuthedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodBody(reportScheduleSchema)) body: ReportScheduleInput,
  ) {
    return this.schedules.update(t, user, id, body);
  }

  @Delete('schedules/:id')
  @HttpCode(204)
  @RequirePermission('reports:schedule')
  async deleteSchedule(@TenantCtx() t: TenantContext, @CurrentUser() user: AuthedUser, @Param('id', ParseUUIDPipe) id: string) {
    await this.schedules.remove(t, user, id);
  }

  /** Send it now, for the period it would cover now (last month or last quarter). */
  @Post('schedules/:id/send-now')
  @RequirePermission('reports:schedule')
  sendScheduleNow(@TenantCtx() t: TenantContext, @CurrentUser() user: AuthedUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.schedules.sendNow(t, user, id);
  }
}
