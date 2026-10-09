import { Controller, ForbiddenException, Get, Query } from '@nestjs/common';
import { mspServiceRequestsQuerySchema, type MspServiceRequestsQuery } from '@tvmf/shared';
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
}
