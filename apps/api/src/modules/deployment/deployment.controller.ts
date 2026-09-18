import { Body, Controller, ForbiddenException, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import {
  can,
  createDeploymentSchema,
  deploymentPreviewQuerySchema,
  generateDeploymentDocumentSchema,
  listDeploymentsQuerySchema,
  startConnectionSchema,
  type CreateDeploymentInput,
  type DeploymentPreviewQuery,
  type GenerateDeploymentDocumentInput,
  type ListDeploymentsQuery,
} from '@tvmf/shared';
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

  @Get('summary')
  @RequirePermission('deployment:read')
  summary(@TenantCtx() t: TenantContext) {
    return this.svc.siteRollup(t);
  }

  @Get('preview')
  @RequirePermission('deployment:dryrun')
  preview(@TenantCtx() t: TenantContext, @Query(new ZodBody(deploymentPreviewQuerySchema)) query: DeploymentPreviewQuery) {
    return this.svc.previewChanges(t, query);
  }

  @Post('sites/:siteId/generate-document')
  @RequirePermission('deployment:dryrun')
  generateDocument(
    @TenantCtx() t: TenantContext,
    @CurrentUser() user: AuthedUser,
    @Param('siteId') siteId: string,
    @Body(new ZodBody(generateDeploymentDocumentSchema)) body: GenerateDeploymentDocumentInput,
  ) {
    return this.svc.generateChangeDocument(t, user, siteId, body);
  }

  @Post('connections')
  @RequirePermission('deployment:connect')
  startConnection(
    @TenantCtx() t: TenantContext,
    @CurrentUser() user: AuthedUser,
    @Body(new ZodBody(startConnectionSchema)) body: { tenantDomain?: string },
  ) {
    return this.svc.startConnection(t, user, body.tenantDomain);
  }

  /** Non-SUPER_ADMIN engineers only see their own sessions - a connection's user_code/verification_uri lets whoever holds it complete that device-code sign-in as its owner. Same ownership rule as TenantDiscoveryService's own getConnection/listConnections. */
  @Get('connections')
  @RequirePermission('deployment:read')
  async listConnections(@TenantCtx() t: TenantContext, @CurrentUser() user: AuthedUser) {
    const rows = await this.svc.listConnections(t);
    return user.role === 'SUPER_ADMIN' ? rows : rows.filter((r) => r.started_by === user.id);
  }

  @Get('connections/:id')
  @RequirePermission('deployment:read')
  async getConnection(@TenantCtx() t: TenantContext, @CurrentUser() user: AuthedUser, @Param('id') id: string) {
    const row = await this.svc.getConnection(t, id);
    if (row.started_by !== user.id && user.role !== 'SUPER_ADMIN') {
      throw new ForbiddenException('This customer-tenant session belongs to another engineer.');
    }
    return row;
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
  list(@TenantCtx() t: TenantContext, @Query(new ZodBody(listDeploymentsQuerySchema)) query: ListDeploymentsQuery) {
    return this.svc.listDeployments(t, query.siteId);
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
