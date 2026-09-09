import { Body, Controller, Delete, Get, Param, Patch, Post } from '@nestjs/common';
import {
  featureRequestCreateSchema,
  featureRequestUpdateSchema,
  type FeatureRequestCreateInput,
  type FeatureRequestUpdateInput,
} from '@tvmf/shared';
import { CurrentUser } from '../auth/auth.decorators';
import type { AuthedUser } from '../common/request';
import { ZodBody } from '../common/zod.pipe';
import { RequirePermission } from '../rbac/require-permission.decorator';
import { FeatureRequestsService } from './feature-requests.service';

/**
 * Feature-request board. SUPER_ADMIN / PROJECT_MANAGER / ENGINEER can view and
 * submit (`feature:read` / `feature:create`); only SUPER_ADMIN can move a card
 * or edit its labels (`feature:manage`). Platform-level, not tenant-scoped.
 */
@Controller('feature-requests')
export class FeatureRequestsController {
  constructor(private readonly features: FeatureRequestsService) {}

  private actor(u: AuthedUser) {
    return { id: u.id, email: u.email, role: u.role };
  }

  @Get()
  @RequirePermission('feature:read')
  list() {
    return this.features.list();
  }

  @Post()
  @RequirePermission('feature:create')
  create(
    @Body(new ZodBody(featureRequestCreateSchema)) body: FeatureRequestCreateInput,
    @CurrentUser() user: AuthedUser,
  ) {
    return this.features.create(body, this.actor(user));
  }

  @Patch(':id')
  @RequirePermission('feature:manage')
  update(
    @Param('id') id: string,
    @Body(new ZodBody(featureRequestUpdateSchema)) body: FeatureRequestUpdateInput,
    @CurrentUser() user: AuthedUser,
  ) {
    return this.features.update(id, body, this.actor(user));
  }

  @Delete(':id')
  @RequirePermission('feature:manage')
  remove(@Param('id') id: string, @CurrentUser() user: AuthedUser) {
    return this.features.remove(id, this.actor(user));
  }
}
