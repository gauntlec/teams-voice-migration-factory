import { Body, Controller, Delete, Get, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import {
  can,
  startConnectionSchema,
  tenantDiscoverySettingsSchema,
  tenantDiscoveryStartSchema,
  tenantObjectsQuerySchema,
  tenantUserLookupSchema,
  tenantUsersImportSchema,
  type TenantDiscoverySettingsInput,
  type TenantDiscoveryStartInput,
  type TenantObjectsQuery,
  type TenantUserLookupQuery,
  type TenantUsersImportInput,
} from '@tvmf/shared';
import { CurrentUser, TenantCtx } from '../../auth/auth.decorators';
import type { AuthedUser, TenantContext } from '../../common/request';
import { ZodBody } from '../../common/zod.pipe';
import { RequirePermission } from '../../rbac/require-permission.decorator';
import { TenantGuard } from '../../rbac/tenant.guard';
import { TenantDiscoveryService } from './tenant-discovery.service';

/**
 * Discovery - live customer-tenant inventory. SUPER_ADMIN and ENGINEER only
 * (`tenantdiscovery:*`). No customer credentials are stored: the engineer signs
 * in with a device code each time and tokens live only in the worker process.
 */
@Controller('t/:tenantId/tenant-discovery')
@UseGuards(TenantGuard)
export class TenantDiscoveryController {
  constructor(private readonly svc: TenantDiscoveryService) {}

  /* connections (shared with Deployment) */

  @Post('connections')
  @RequirePermission('tenantdiscovery:run')
  startConnection(
    @TenantCtx() t: TenantContext,
    @CurrentUser() user: AuthedUser,
    @Body(new ZodBody(startConnectionSchema)) body: { tenantDomain?: string },
  ) {
    return this.svc.startConnection(t, user, body.tenantDomain);
  }

  @Get('connections')
  @RequirePermission('tenantdiscovery:read')
  listConnections(@TenantCtx() t: TenantContext) {
    return this.svc.listConnections(t);
  }

  @Get('connections/:id')
  @RequirePermission('tenantdiscovery:read')
  getConnection(@TenantCtx() t: TenantContext, @Param('id') id: string) {
    return this.svc.getConnection(t, id);
  }

  /* settings */

  @Get('settings')
  @RequirePermission('tenantdiscovery:read')
  getSettings(@TenantCtx() t: TenantContext) {
    return this.svc.getSettings(t);
  }

  /** Per-customer default for the Teams-licence user filter. */
  @Patch('settings')
  @RequirePermission('tenantdiscovery:run')
  updateSettings(
    @TenantCtx() t: TenantContext,
    @CurrentUser() user: AuthedUser,
    @Body(new ZodBody(tenantDiscoverySettingsSchema)) body: TenantDiscoverySettingsInput,
  ) {
    return this.svc.updateSettings(t, user, body.filterUsers);
  }

  /* runs */

  @Post('runs')
  @RequirePermission('tenantdiscovery:run')
  startRun(
    @TenantCtx() t: TenantContext,
    @CurrentUser() user: AuthedUser,
    @Body(new ZodBody(tenantDiscoveryStartSchema)) body: TenantDiscoveryStartInput,
  ) {
    return this.svc.startRun(t, user, body.connectionId, body.scopeTypes, {
      includeDisabled: body.includeDisabled,
      includeUnlicensed: body.includeUnlicensed,
    });
  }

  @Get('runs')
  @RequirePermission('tenantdiscovery:read')
  listRuns(@TenantCtx() t: TenantContext) {
    return this.svc.listRuns(t);
  }

  @Get('runs/:id')
  @RequirePermission('tenantdiscovery:read')
  getRun(@TenantCtx() t: TenantContext, @Param('id') id: string) {
    return this.svc.getRun(t, id);
  }

  /** What a given run added / changed / removed. */
  @Get('runs/:id/changes')
  @RequirePermission('tenantdiscovery:read')
  listRunChanges(
    @TenantCtx() t: TenantContext,
    @Param('id') id: string,
    @Query(new ZodBody(tenantObjectsQuerySchema)) q: TenantObjectsQuery,
  ) {
    return this.svc.listRunChanges(t, id, q);
  }

  /**
   * Delete every discovered object, projection and run for this customer. Same
   * permission as running a discovery - the data is a re-fetchable snapshot, not
   * authored content. Blocked while a run is in flight.
   */
  @Delete()
  @RequirePermission('tenantdiscovery:run')
  purge(@TenantCtx() t: TenantContext, @CurrentUser() user: AuthedUser) {
    return this.svc.purge(t, user);
  }

  /* inventory */

  @Get('summary')
  @RequirePermission('tenantdiscovery:read')
  summary(@TenantCtx() t: TenantContext) {
    return this.svc.summary(t);
  }

  @Get('objects')
  @RequirePermission('tenantdiscovery:read')
  listObjects(
    @TenantCtx() t: TenantContext,
    @Query(new ZodBody(tenantObjectsQuerySchema)) q: TenantObjectsQuery,
  ) {
    return this.svc.listObjects(t, q);
  }

  @Get('objects/:id')
  @RequirePermission('tenantdiscovery:read')
  getObject(@TenantCtx() t: TenantContext, @Param('id') id: string) {
    return this.svc.getObject(t, id);
  }

  /** Change timeline for one object (before/after per run). */
  @Get('objects/:id/versions')
  @RequirePermission('tenantdiscovery:read')
  listObjectVersions(@TenantCtx() t: TenantContext, @Param('id') id: string) {
    return this.svc.listObjectVersions(t, id);
  }

  @Get('users')
  @RequirePermission('tenantdiscovery:read')
  listUsers(
    @TenantCtx() t: TenantContext,
    @Query(new ZodBody(tenantObjectsQuerySchema)) q: TenantObjectsQuery,
  ) {
    return this.svc.listUsers(t, q);
  }

  /**
   * Exact-UPN lookup for the Data Collection add-user autofill. Anyone who can
   * write Data Collection may call it (they only learn about the UPN they typed).
   */
  @Get('users/lookup')
  @RequirePermission('discovery:write')
  lookupUser(
    @TenantCtx() t: TenantContext,
    @Query(new ZodBody(tenantUserLookupSchema)) q: TenantUserLookupQuery,
  ) {
    return this.svc.lookupUser(t, q.upn);
  }

  @Get('policies')
  @RequirePermission('tenantdiscovery:read')
  listPolicies(
    @TenantCtx() t: TenantContext,
    @Query(new ZodBody(tenantObjectsQuerySchema)) q: TenantObjectsQuery,
  ) {
    return this.svc.listPolicies(t, q);
  }

  /* import into Data Collection */

  @Get('import-users/preview')
  @RequirePermission('tenantdiscovery:read', 'discovery:write')
  importPreview(@TenantCtx() t: TenantContext, @Query('onlyEnterpriseVoice') ev?: string) {
    return this.svc.importPreview(t, ev !== 'false');
  }

  @Post('import-users')
  @RequirePermission('tenantdiscovery:read', 'discovery:write')
  importUsers(
    @TenantCtx() t: TenantContext,
    @CurrentUser() user: AuthedUser,
    @Body(new ZodBody(tenantUsersImportSchema)) body: TenantUsersImportInput,
  ) {
    return this.svc.importUsers(t, user, body, can(user.role, 'discovery:review'));
  }
}
