import { Body, Controller, Delete, Get, Param, Patch, Post } from '@nestjs/common';
import {
  addMembershipSchema,
  createTenantSchema,
  updateMembershipSchema,
  type CreateTenantInput,
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
