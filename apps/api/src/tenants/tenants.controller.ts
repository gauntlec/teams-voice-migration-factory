import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Query, Req, UploadedFile, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import {
  addMembershipSchema,
  createTenantSchema,
  deleteTenantSchema,
  searchQuerySchema,
  updateMembershipSchema,
  updateTenantBrandingSchema,
  setTenantMspSchema,
  updateTenantManagedServicesSchema,
  updateTenantMonitoringSchema,
  updateTenantSandboxSchema,
  updateTenantSchema,
  type CreateTenantInput,
  type DeleteTenantInput,
  type SearchQuery,
  type UpdateTenantBrandingInput,
  type UpdateTenantInput,
  type SetTenantMspInput,
  type UpdateTenantManagedServicesInput,
  type UpdateTenantMonitoringInput,
  type UpdateTenantSandboxInput,
} from '@tvmf/shared';
import { CurrentUser } from '../auth/auth.decorators';
import type { AuthedUser } from '../common/request';
import { ZodBody } from '../common/zod.pipe';
import { RequirePermission } from '../rbac/require-permission.decorator';
import { TenantDeletionService } from './tenant-deletion.service';
import { TenantsService } from './tenants.service';

@Controller('tenants')
export class TenantsController {
  constructor(
    private readonly tenants: TenantsService,
    private readonly deletion: TenantDeletionService,
  ) {}

  private actor(u: AuthedUser) {
    return { id: u.id, email: u.email, role: u.role };
  }

  @Get()
  @RequirePermission('tenant:read')
  list(@CurrentUser() user: AuthedUser, @Query(new ZodBody(searchQuerySchema)) query: SearchQuery) {
    return this.tenants.list(user, query.q);
  }

  /** Customers whose deletion started and did not finish (Super Admin). Declared before the `:tenantId` routes. */
  @Get('pending-deletion')
  @RequirePermission('tenant:delete')
  pendingDeletion() {
    return this.deletion.pending();
  }

  @Post()
  @RequirePermission('tenant:create')
  create(
    @Body(new ZodBody(createTenantSchema)) body: CreateTenantInput,
    @CurrentUser() user: AuthedUser,
  ) {
    return this.tenants.create(body, { id: user.id, email: user.email });
  }

  @Patch(':tenantId')
  @RequirePermission('tenant:update')
  update(
    @Param('tenantId') tenantId: string,
    @Body(new ZodBody(updateTenantSchema)) body: UpdateTenantInput,
    @CurrentUser() user: AuthedUser,
  ) {
    return this.tenants.setTeamsReadOnly(tenantId, body.teamsReadOnly, this.actor(user));
  }

  @Patch(':tenantId/managed-services')
  @RequirePermission('tenant:update')
  setManagedServices(
    @Param('tenantId') tenantId: string,
    @Body(new ZodBody(updateTenantManagedServicesSchema)) body: UpdateTenantManagedServicesInput,
    @CurrentUser() user: AuthedUser,
  ) {
    return this.tenants.setManagedServices(tenantId, body.enabled, this.actor(user));
  }

  @Patch(':tenantId/monitoring')
  @RequirePermission('tenant:update')
  setMonitoring(
    @Param('tenantId') tenantId: string,
    @Body(new ZodBody(updateTenantMonitoringSchema)) body: UpdateTenantMonitoringInput,
    @CurrentUser() user: AuthedUser,
  ) {
    return this.tenants.setMonitoring(tenantId, body.enabled, this.actor(user));
  }

  @Patch(':tenantId/sandbox')
  @RequirePermission('tenant:update')
  setSandbox(
    @Param('tenantId') tenantId: string,
    @Body(new ZodBody(updateTenantSandboxSchema)) body: UpdateTenantSandboxInput,
    @CurrentUser() user: AuthedUser,
  ) {
    return this.tenants.setSandbox(tenantId, body.sandbox, body.sandboxEmail, this.actor(user));
  }

  @Patch(':tenantId/msp')
  @RequirePermission('tenant:update')
  setMsp(
    @Param('tenantId') tenantId: string,
    @Body(new ZodBody(setTenantMspSchema)) body: SetTenantMspInput,
    @CurrentUser() user: AuthedUser,
  ) {
    return this.tenants.setMsp(tenantId, body.mspId, this.actor(user));
  }

  @Patch(':tenantId/branding')
  @RequirePermission('tenant:update')
  updateBranding(
    @Param('tenantId') tenantId: string,
    @Body(new ZodBody(updateTenantBrandingSchema)) body: UpdateTenantBrandingInput,
    @CurrentUser() user: AuthedUser,
  ) {
    return this.tenants.updateBranding(tenantId, body, this.actor(user));
  }

  @Post(':tenantId/branding/logo')
  @RequirePermission('tenant:update')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 2 * 1024 * 1024 } }))
  uploadLogo(
    @Param('tenantId') tenantId: string,
    @UploadedFile() file: Express.Multer.File,
    @CurrentUser() user: AuthedUser,
  ) {
    return this.tenants.uploadLogo(tenantId, file, this.actor(user));
  }

  @Delete(':tenantId/branding/logo')
  @RequirePermission('tenant:update')
  removeLogo(@Param('tenantId') tenantId: string, @CurrentUser() user: AuthedUser) {
    return this.tenants.removeLogo(tenantId, this.actor(user));
  }

  @Get(':tenantId/sites')
  @RequirePermission('tenant:member:manage')
  sites(@Param('tenantId') tenantId: string, @CurrentUser() user: AuthedUser) {
    return this.tenants.sites(tenantId, { id: user.id, role: user.role });
  }

  @Get(':tenantId/members')
  @RequirePermission('tenant:member:manage')
  members(@Param('tenantId') tenantId: string, @CurrentUser() user: AuthedUser) {
    return this.tenants.members(tenantId, { id: user.id, role: user.role });
  }

  @Post(':tenantId/members')
  @RequirePermission('tenant:member:manage')
  addMember(
    @Param('tenantId') tenantId: string,
    @Body(new ZodBody(addMembershipSchema)) body: { userId: string; siteIds?: string[] },
    @CurrentUser() user: AuthedUser,
  ) {
    return this.tenants.addMember(tenantId, body.userId, this.actor(user), body.siteIds ?? []);
  }

  @Patch(':tenantId/members/:userId')
  @RequirePermission('tenant:member:manage')
  setMemberScope(
    @Param('tenantId') tenantId: string,
    @Param('userId') userId: string,
    @Body(new ZodBody(updateMembershipSchema)) body: { siteIds: string[] },
    @CurrentUser() user: AuthedUser,
  ) {
    return this.tenants.setMemberScope(tenantId, userId, body.siteIds, this.actor(user));
  }

  @Delete(':tenantId/members/:userId')
  @RequirePermission('tenant:member:manage')
  removeMember(
    @Param('tenantId') tenantId: string,
    @Param('userId') userId: string,
    @CurrentUser() user: AuthedUser,
  ) {
    return this.tenants.removeMember(tenantId, userId, this.actor(user));
  }

  /** What deleting this customer would remove, in numbers, and whether anything stops it now. Changes nothing. */
  @Get(':tenantId/deletion-summary')
  @RequirePermission('tenant:delete')
  deletionSummary(@Param('tenantId') tenantId: string) {
    return this.deletion.summary(tenantId);
  }

  /**
   * Deletes the customer and all of its data for good (docs/SECURITY.md "Deleting a customer"). Needs the typed name and a fresh
   * authenticator code. Can be sent again to finish a deletion that stopped part way.
   */
  @Post(':tenantId/delete')
  @HttpCode(200)
  @RequirePermission('tenant:delete')
  deleteTenant(
    @Param('tenantId') tenantId: string,
    @Body(new ZodBody(deleteTenantSchema)) body: DeleteTenantInput,
    @CurrentUser() user: AuthedUser,
    @Req() req: { ip?: string },
  ) {
    return this.deletion.delete(tenantId, body, { id: user.id, email: user.email, ip: req.ip });
  }
}
