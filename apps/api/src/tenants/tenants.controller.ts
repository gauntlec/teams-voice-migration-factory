import { Body, Controller, Delete, Get, Param, Patch, Post, UploadedFile, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import {
  addMembershipSchema,
  createTenantSchema,
  updateMembershipSchema,
  updateTenantBrandingSchema,
  updateTenantSchema,
  type CreateTenantInput,
  type UpdateTenantBrandingInput,
  type UpdateTenantInput,
} from '@tvmf/shared';
import { CurrentUser } from '../auth/auth.decorators';
import type { AuthedUser } from '../common/request';
import { ZodBody } from '../common/zod.pipe';
import { RequirePermission } from '../rbac/require-permission.decorator';
import { TenantsService } from './tenants.service';

@Controller('tenants')
export class TenantsController {
  constructor(private readonly tenants: TenantsService) {}

  private actor(u: AuthedUser) {
    return { id: u.id, email: u.email, role: u.role };
  }

  @Get()
  @RequirePermission('tenant:read')
  list(@CurrentUser() user: AuthedUser) {
    return this.tenants.list(user);
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
}
