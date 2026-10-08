import { Body, Controller, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import {
  can,
  createServiceRequestSchema,
  listServiceRequestsQuerySchema,
  serviceRequestAssignSchema,
  serviceRequestCommentSchema,
  serviceRequestStatusSchema,
  type CreateServiceRequestInput,
  type ListServiceRequestsQuery,
  type ServiceRequestAssignInput,
  type ServiceRequestCommentInput,
  type ServiceRequestStatusInput,
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
