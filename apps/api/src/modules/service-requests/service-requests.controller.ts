import { Body, Controller, Get, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import {
  can,
  createServiceRequestSchema,
  listServiceRequestsQuerySchema,
  serviceRequestAssignSchema,
  serviceRequestBuildDraftSchema,
  serviceRequestCommentSchema,
  serviceRequestStatusSchema,
  setSiteModeSchema,
  type CreateServiceRequestInput,
  type ListServiceRequestsQuery,
  type ServiceRequestAssignInput,
  type ServiceRequestBuildDraftInput,
  type ServiceRequestCommentInput,
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
