import { Body, Controller, Delete, Get, Param, Post } from '@nestjs/common';
import {
  addMembershipSchema,
  createTenantSchema,
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

  @Get(':tenantId/members')
  @RequirePermission('tenant:read')
  members(@Param('tenantId') tenantId: string) {
    return this.tenants.members(tenantId);
  }

  @Post(':tenantId/members')
  @RequirePermission('tenant:member:manage')
  addMember(
    @Param('tenantId') tenantId: string,
    @Body(new ZodBody(addMembershipSchema)) body: { userId: string },
    @CurrentUser() user: AuthedUser,
  ) {
    return this.tenants.addMember(tenantId, body.userId, {
      id: user.id,
      email: user.email,
      role: user.role,
    });
  }

  @Delete(':tenantId/members/:userId')
  @RequirePermission('tenant:member:manage')
  removeMember(
    @Param('tenantId') tenantId: string,
    @Param('userId') userId: string,
    @CurrentUser() user: AuthedUser,
  ) {
    return this.tenants.removeMember(tenantId, userId, {
      id: user.id,
      email: user.email,
      role: user.role,
    });
  }
}
