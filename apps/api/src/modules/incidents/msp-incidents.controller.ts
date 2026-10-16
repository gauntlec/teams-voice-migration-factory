import { Body, Controller, ForbiddenException, Get, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import {
  incidentAssignSchema,
  incidentCommentSchema,
  incidentStatusSchema,
  mspIncidentsQuerySchema,
  type IncidentAssignInput,
  type IncidentCommentInput,
  type IncidentStatusInput,
  type MspIncidentsQuery,
} from '@tvmf/shared';
import { CurrentUser } from '../../auth/auth.decorators';
import type { AuthedUser } from '../../common/request';
import { ZodBody } from '../../common/zod.pipe';
import { RequirePermission } from '../../rbac/require-permission.decorator';
import { MspIncidentsService } from './msp-incidents.service';
import { RequireFeature } from '../../common/feature.guard';

/** MSP incident console: one queue and one major-incident board across all of an MSP's customers. Not tenant-scoped. */
@Controller('msp/incidents')
@RequireFeature('msp')
export class MspIncidentsController {
  constructor(private readonly svc: MspIncidentsService) {}

  @Get()
  @RequirePermission('inc:msp')
  queue(@CurrentUser() user: AuthedUser, @Query(new ZodBody(mspIncidentsQuerySchema)) q: MspIncidentsQuery) {
    return this.svc.queue(user, q);
  }

  /** Live major incidents. */
  @Get('major')
  @RequirePermission('inc:msp')
  board(@CurrentUser() user: AuthedUser, @Query('mspId') mspId?: string) {
    return this.svc.board(user, { mspId: mspId || undefined });
  }

  /** Super Admins filter by MSP. */
  @Get('msps')
  @RequirePermission('inc:msp')
  msps(@CurrentUser() user: AuthedUser) {
    if (user.role !== 'SUPER_ADMIN') throw new ForbiddenException('Only Super Admins can choose an MSP.');
    return this.svc.msps();
  }

  /* Acting from the console - the caller must be on that customer's team (see contextFor). */

  @Get(':tenantId/assignees')
  @RequirePermission('inc:msp', 'inc:manage')
  assignees(@CurrentUser() user: AuthedUser, @Param('tenantId', ParseUUIDPipe) tenantId: string) {
    return this.svc.assignees(user, tenantId);
  }

  @Post(':tenantId/:id/assign')
  @RequirePermission('inc:msp', 'inc:manage')
  assign(@CurrentUser() user: AuthedUser, @Param('tenantId', ParseUUIDPipe) tenantId: string, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodBody(incidentAssignSchema)) body: IncidentAssignInput) {
    return this.svc.assign(user, tenantId, id, body);
  }

  @Post(':tenantId/:id/comments')
  @RequirePermission('inc:msp', 'inc:manage')
  comment(@CurrentUser() user: AuthedUser, @Param('tenantId', ParseUUIDPipe) tenantId: string, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodBody(incidentCommentSchema)) body: IncidentCommentInput) {
    return this.svc.comment(user, tenantId, id, body);
  }

  @Post(':tenantId/:id/status')
  @RequirePermission('inc:msp', 'inc:manage')
  move(@CurrentUser() user: AuthedUser, @Param('tenantId', ParseUUIDPipe) tenantId: string, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodBody(incidentStatusSchema)) body: IncidentStatusInput) {
    return this.svc.move(user, tenantId, id, body);
  }
}
