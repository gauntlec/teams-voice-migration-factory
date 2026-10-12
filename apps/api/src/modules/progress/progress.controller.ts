import { Controller, Get, UseGuards } from '@nestjs/common';
import { CurrentUser, TenantCtx } from '../../auth/auth.decorators';
import type { AuthedUser, TenantContext } from '../../common/request';
import { RequirePermission } from '../../rbac/require-permission.decorator';
import { TenantGuard } from '../../rbac/tenant.guard';
import { ProgressService } from './progress.service';

/** The home-page dashboard: where each site is in the migration. */
@Controller('t/:tenantId/progress')
@UseGuards(TenantGuard)
export class ProgressController {
  constructor(private readonly svc: ProgressService) {}

  @Get()
  @RequirePermission('tenant:read')
  progress(@TenantCtx() t: TenantContext, @CurrentUser() user: AuthedUser) {
    return this.svc.progress(t, user);
  }
}
