import { Body, Controller, Get, Param, Post } from '@nestjs/common';
import { createUserSchema, type CreateUserInput } from '@tvmf/shared';
import { CurrentUser } from '../auth/auth.decorators';
import type { AuthedUser } from '../common/request';
import { ZodBody } from '../common/zod.pipe';
import { RequirePermission } from '../rbac/require-permission.decorator';
import { UsersService } from './users.service';

@Controller('users')
export class UsersController {
  constructor(private readonly users: UsersService) {}

  private actor(u: AuthedUser) {
    return { id: u.id, email: u.email, role: u.role };
  }

  @Get()
  @RequirePermission('user:read')
  list(@CurrentUser() user: AuthedUser) {
    return this.users.list({ id: user.id, role: user.role });
  }

  @Get(':id/memberships')
  @RequirePermission('user:read')
  memberships(@Param('id') id: string, @CurrentUser() user: AuthedUser) {
    return this.users.memberships(id, { id: user.id, role: user.role });
  }

  @Post()
  @RequirePermission('user:create')
  create(
    @Body(new ZodBody(createUserSchema)) body: CreateUserInput,
    @CurrentUser() user: AuthedUser,
  ) {
    return this.users.create(body, this.actor(user));
  }

  @Post(':id/disable')
  @RequirePermission('user:disable')
  disable(@Param('id') id: string, @CurrentUser() user: AuthedUser) {
    return this.users.setStatus(id, 'disabled', this.actor(user));
  }

  @Post(':id/enable')
  @RequirePermission('user:update')
  enable(@Param('id') id: string, @CurrentUser() user: AuthedUser) {
    return this.users.setStatus(id, 'active', this.actor(user));
  }

  @Post(':id/reset-mfa')
  @RequirePermission('user:mfa:reset')
  resetMfa(@Param('id') id: string, @CurrentUser() user: AuthedUser) {
    return this.users.resetMfa(id, this.actor(user));
  }
}
