import { BadRequestException, Body, Controller, Delete, Get, Param, Patch, Post, Put, Query, UseGuards } from '@nestjs/common';
import {
  can,
  createServiceRequestSchema,
  listServiceRequestsQuerySchema,
  serviceRequestAssignSchema,
  serviceRequestBuildDraftSchema,
  serviceRequestCommentSchema,
  serviceRequestDeploySchema,
  serviceRequestSettingsSchema,
  serviceRequestReportQuerySchema,
  serviceRequestStatusSchema,
  setSiteModeSchema,
  SR_ITEM_KINDS,
  type SrItemKind,
  type CreateServiceRequestInput,
  type ListServiceRequestsQuery,
  type ServiceRequestAssignInput,
  type ServiceRequestBuildDraftInput,
  type ServiceRequestCommentInput,
  type ServiceRequestDeployInput,
  type ServiceRequestSettingsInput,
  type ServiceRequestReportQuery,
  type ServiceRequestStatusInput,
  type SetSiteModeInput,
} from '@tvmf/shared';
import { CurrentUser, TenantCtx } from '../../auth/auth.decorators';
import type { AuthedUser, TenantContext } from '../../common/request';
import { ZodBody } from '../../common/zod.pipe';
import { RequirePermission } from '../../rbac/require-permission.decorator';
import { TenantGuard } from '../../rbac/tenant.guard';
import { ServiceRequestsService } from './service-requests.service';

/**
 * Managed Services - service requests for one customer. sr:read to see them,
 * sr:create to raise and comment, sr:manage (engineers and admins) to move,
 * assign and add internal notes. The service also requires Managed Services
 * to be switched on for the customer, and applies site-contact scoping.
 */
@Controller('t/:tenantId/service-requests')
@UseGuards(TenantGuard)
export class ServiceRequestsController {
  constructor(private readonly svc: ServiceRequestsService) {}

  @Get()
  @RequirePermission('sr:read')
  list(@TenantCtx() t: TenantContext, @Query(new ZodBody(listServiceRequestsQuerySchema)) q: ListServiceRequestsQuery) {
    return this.svc.list(t, q);
  }

  /** Who a request can be assigned to. Declared before :id so it isn't read as an id. */
  @Get('assignees')
  @RequirePermission('sr:manage')
  async assignees(@TenantCtx() t: TenantContext) {
    return (await this.svc.staff(t)).map((m) => ({ id: m.id, display_name: m.display_name, role: m.role }));
  }

  /** Sites and whether each takes requests (operations) or not yet (project). */
  @Get('sites')
  @RequirePermission('sr:read')
  sites(@TenantCtx() t: TenantContext) {
    return this.svc.sites(t);
  }

  @Patch('sites/:siteId/mode')
  @RequirePermission('sr:manage')
  setSiteMode(
    @TenantCtx() t: TenantContext,
    @CurrentUser() user: AuthedUser,
    @Param('siteId') siteId: string,
    @Body(new ZodBody(setSiteModeSchema)) body: SetSiteModeInput,
  ) {
    return this.svc.setSiteMode(t, user, siteId, body.mode);
  }

  /** What the request form can offer for a site: free numbers, ranges, queues, auto attendants, phone models. */
  /** Targets, approvals and change window - everyone on the customer can read them. */
  @Get('settings')
  @RequirePermission('sr:read')
  settings(@TenantCtx() t: TenantContext) {
    return this.svc.settings(t);
  }

  /** Super Admins only (checked in the service). */
  @Put('settings')
  @RequirePermission('sr:manage')
  updateSettings(
    @TenantCtx() t: TenantContext,
    @CurrentUser() user: AuthedUser,
    @Body(new ZodBody(serviceRequestSettingsSchema)) body: ServiceRequestSettingsInput,
  ) {
    return this.svc.updateSettings(t, user, body);
  }

  @Get('customer-users')
  @RequirePermission('sr:manage')
  customerUsers(@TenantCtx() t: TenantContext) {
    return this.svc.customerUsers(t);
  }

  @Get('report')
  @RequirePermission('sr:read')
  report(@TenantCtx() t: TenantContext, @Query(new ZodBody(serviceRequestReportQuerySchema)) q: ServiceRequestReportQuery) {
    return this.svc.report(t, q.from, q.to);
  }

  @Get('options')
  @RequirePermission('sr:create')
  options(@TenantCtx() t: TenantContext, @Query('siteId') siteId?: string) {
    return this.svc.options(t, siteId || undefined);
  }

  /** Directory search for the person pickers. */
  @Get('people')
  @RequirePermission('sr:create')
  people(@TenantCtx() t: TenantContext, @Query('q') q?: string) {
    return this.svc.people(t, String(q ?? ''));
  }

  @Get(':id')
  @RequirePermission('sr:read')
  get(@TenantCtx() t: TenantContext, @CurrentUser() user: AuthedUser, @Param('id') id: string) {
    return this.svc.get(t, id, can(user.role, 'sr:manage'));
  }

  @Post()
  @RequirePermission('sr:create')
  create(@TenantCtx() t: TenantContext, @CurrentUser() user: AuthedUser, @Body(new ZodBody(createServiceRequestSchema)) body: CreateServiceRequestInput) {
    return this.svc.create(t, user, body);
  }

  /** Engineers and admins move a request on; the requester may cancel it while it is New. */
  @Post(':id/status')
  @RequirePermission('sr:create')
  move(
    @TenantCtx() t: TenantContext,
    @CurrentUser() user: AuthedUser,
    @Param('id') id: string,
    @Body(new ZodBody(serviceRequestStatusSchema)) body: ServiceRequestStatusInput,
  ) {
    return this.svc.move(t, user, id, body, can(user.role, 'sr:manage'));
  }

  /** The team stops waiting on the customer without a reply. */
  @Post(':id/resume')
  @RequirePermission('sr:manage')
  resume(@TenantCtx() t: TenantContext, @CurrentUser() user: AuthedUser, @Param('id') id: string) {
    return this.svc.stopWaitingOnCustomer(t, user, id);
  }

  @Post(':id/assign')
  @RequirePermission('sr:manage')
  assign(
    @TenantCtx() t: TenantContext,
    @CurrentUser() user: AuthedUser,
    @Param('id') id: string,
    @Body(new ZodBody(serviceRequestAssignSchema)) body: ServiceRequestAssignInput,
  ) {
    return this.svc.assign(t, user, id, body.userId);
  }

  /** "Create in Design & Build": the draft row(s) the request asks for. Engineers and admins, New or Planned requests only. */
  @Post(':id/build-draft')
  @RequirePermission('sr:manage')
  buildDraft(
    @TenantCtx() t: TenantContext,
    @CurrentUser() user: AuthedUser,
    @Param('id') id: string,
    @Body(new ZodBody(serviceRequestBuildDraftSchema)) body: ServiceRequestBuildDraftInput,
  ) {
    return this.svc.draftInBuild(t, user, id, body);
  }

  /* Design and deploy inside the request - see service-request-design.ts. */

  /** The Design tab's linked rows and whether the request can be marked designed & built. */
  @Get(':id/design')
  @RequirePermission('sr:manage', 'build:read')
  design(@TenantCtx() t: TenantContext, @Param('id') id: string) {
    return this.svc.design(t, id);
  }

  /** Takes a row off the request (the row stays in Design & Build). Planned requests only. */
  @Delete(':id/items/:kind/:rowId')
  @RequirePermission('sr:manage', 'build:write')
  unlinkItem(
    @TenantCtx() t: TenantContext,
    @CurrentUser() user: AuthedUser,
    @Param('id') id: string,
    @Param('kind') kind: string,
    @Param('rowId') rowId: string,
  ) {
    if (!SR_ITEM_KINDS.includes(kind as SrItemKind)) throw new BadRequestException('Unknown row type.');
    return this.svc.unlinkItem(t, user, id, kind as SrItemKind, rowId);
  }

  /** What What-If / Deploy would change for this request's rows. */
  @Get(':id/deploy-preview')
  @RequirePermission('sr:manage', 'deployment:dryrun')
  deployPreview(@TenantCtx() t: TenantContext, @Param('id') id: string) {
    return this.svc.deployPreview(t, id);
  }

  /** What-If (dry run) or Deploy just this request's rows. A live run also needs deployment:execute (checked by the deployment service). */
  @Post(':id/deploy')
  @RequirePermission('sr:manage', 'deployment:dryrun')
  deploy(
    @TenantCtx() t: TenantContext,
    @CurrentUser() user: AuthedUser,
    @Param('id') id: string,
    @Body(new ZodBody(serviceRequestDeploySchema)) body: ServiceRequestDeployInput,
  ) {
    return this.svc.deploy(t, user, id, body);
  }

  @Get(':id/runs')
  @RequirePermission('sr:manage', 'deployment:read')
  runs(@TenantCtx() t: TenantContext, @Param('id') id: string) {
    return this.svc.runs(t, id);
  }

  @Post(':id/comments')
  @RequirePermission('sr:create')
  comment(
    @TenantCtx() t: TenantContext,
    @CurrentUser() user: AuthedUser,
    @Param('id') id: string,
    @Body(new ZodBody(serviceRequestCommentSchema)) body: ServiceRequestCommentInput,
  ) {
    return this.svc.comment(t, user, id, body, can(user.role, 'sr:manage'));
  }
}
