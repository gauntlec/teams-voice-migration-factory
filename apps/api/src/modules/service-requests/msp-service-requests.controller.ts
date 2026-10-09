import { Body, Controller, ForbiddenException, Get, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import {
  mspServiceRequestsQuerySchema,
  serviceRequestAssignSchema,
  serviceRequestCommentSchema,
  type MspServiceRequestsQuery,
  type ServiceRequestAssignInput,
  type ServiceRequestCommentInput,
} from '@tvmf/shared';
import { CurrentUser } from '../../auth/auth.decorators';
import type { AuthedUser } from '../../common/request';
import { ZodBody } from '../../common/zod.pipe';
import { RequirePermission } from '../../rbac/require-permission.decorator';
import { MspServiceRequestsService } from './msp-service-requests.service';

/** MSP service-request admin: one queue across all of an MSP's customers. Not tenant-scoped. */
@Controller('msp/service-requests')
export class MspServiceRequestsController {
  constructor(private readonly svc: MspServiceRequestsService) {}

  @Get()
  @RequirePermission('sr:msp')
  queue(@CurrentUser() user: AuthedUser, @Query(new ZodBody(mspServiceRequestsQuerySchema)) q: MspServiceRequestsQuery) {
    return this.svc.queue(user, q);
  }

  /** Super Admins filter the queue by MSP. */
  @Get('msps')
  @RequirePermission('sr:msp')
  msps(@CurrentUser() user: AuthedUser) {
    if (user.role !== 'SUPER_ADMIN') throw new ForbiddenException('Only Super Admins can choose an MSP.');
    return this.svc.msps();
  }

  /* Acting from the queue - the caller must be on that customer's team (see contextFor). */

  @Get(':tenantId/assignees')
  @RequirePermission('sr:msp', 'sr:manage')
  assignees(@CurrentUser() user: AuthedUser, @Param('tenantId', ParseUUIDPipe) tenantId: string) {
    return this.svc.assignees(user, tenantId);
  }

  @Post(':tenantId/:id/assign')
  @RequirePermission('sr:msp', 'sr:manage')
  assign(
    @CurrentUser() user: AuthedUser,
    @Param('tenantId', ParseUUIDPipe) tenantId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodBody(serviceRequestAssignSchema)) body: ServiceRequestAssignInput,
  ) {
    return this.svc.assign(user, tenantId, id, body.userId);
  }

  @Post(':tenantId/:id/comments')
  @RequirePermission('sr:msp', 'sr:manage')
  comment(
    @CurrentUser() user: AuthedUser,
    @Param('tenantId', ParseUUIDPipe) tenantId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodBody(serviceRequestCommentSchema)) body: ServiceRequestCommentInput,
  ) {
    return this.svc.comment(user, tenantId, id, body);
  }
}
