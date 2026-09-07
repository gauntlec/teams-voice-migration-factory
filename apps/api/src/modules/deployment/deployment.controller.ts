import { Body, Controller, Get, Param, Post, UseGuards } from '@nestjs/common';
import { can, createDeploymentSchema, startConnectionSchema, type CreateDeploymentInput } from '@tvmf/shared';
import { CurrentUser, TenantCtx } from '../../auth/auth.decorators';
import type { AuthedUser, TenantContext } from '../../common/request';
import { ZodBody } from '../../common/zod.pipe';
import { RequirePermission } from '../../rbac/require-permission.decorator';
import { TenantGuard } from '../../rbac/tenant.guard';
import { DeploymentService } from './deployment.service';

/**
 * Deployment & Audit view. Every change the platform makes to a customer tenant
 * is recorded in `deployment_changes` (GET :id/changes). No customer credentials
 * are stored - the worker runs a live device-code sign-in per connection.
 */
@Controller('t/:tenantId/deployments')
@UseGuards(TenantGuard)
export class DeploymentController {
  constructor(private readonly svc: DeploymentService) {}

  @Post('connections')
  @RequirePermission('deployment:connect')
  startConnection(
    @TenantCtx() t: TenantContext,
    @CurrentUser() user: AuthedUser,
    @Body(new ZodBody(startConnectionSchema)) body: { tenantDomain?: string },
  ) {
    return this.svc.startConnection(t, user, body.tenantDomain);
  }

  @Get('connections')
  @RequirePermission('deployment:read')
  listConnections(@TenantCtx() t: TenantContext) {
    return this.svc.listConnections(t);
  }

  @Get('connections/:id')
  @RequirePermission('deployment:read')
  getConnection(@TenantCtx() t: TenantContext, @Param('id') id: string) {
    return this.svc.getConnection(t, id);
  }

  @Post()
  @RequirePermission('deployment:dryrun')
  create(
    @TenantCtx() t: TenantContext,
    @CurrentUser() user: AuthedUser,
    @Body(new ZodBody(createDeploymentSchema)) body: CreateDeploymentInput,
  ) {
    return this.svc.createDeployment(t, user, body, (p) => can(user.role, p));
  }

  @Get()
  @RequirePermission('deployment:read')
  list(@TenantCtx() t: TenantContext) {
    return this.svc.listDeployments(t);
  }

  @Get(':id')
  @RequirePermission('deployment:read')
  get(@TenantCtx() t: TenantContext, @Param('id') id: string) {
    return this.svc.getDeployment(t, id);
  }

  @Get(':id/changes')
  @RequirePermission('deployment:read')
  changes(@TenantCtx() t: TenantContext, @Param('id') id: string) {
    return this.svc.changes(t, id);
  }

  @Get(':id/scripts')
  @RequirePermission('deployment:read')
  scripts(@TenantCtx() t: TenantContext, @Param('id') id: string) {
    return this.svc.scripts(t, id);
  }
}
