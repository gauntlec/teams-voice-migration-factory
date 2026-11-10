import { Body, Controller, Delete, Get, Param, Patch, Post } from '@nestjs/common';
import {
  featureRequestCreateSchema,
  can,
  featureRequestUpdateSchema,
  type FeatureRequestCreateInput,
  type FeatureRequestUpdateInput,
} from '@tvmf/shared';
import { CurrentUser } from '../auth/auth.decorators';
import type { AuthedUser } from '../common/request';
import { ZodBody } from '../common/zod.pipe';
import { RequirePermission } from '../rbac/require-permission.decorator';
import { FeatureRequestsService } from './feature-requests.service';
import { RequireFeature } from '../common/feature.guard';

/**
 * Feature-request board. SUPER_ADMIN / PROJECT_MANAGER / ENGINEER can view and
 * submit (`feature:read` / `feature:create`), and change or withdraw their own
 * request while it is New; only SUPER_ADMIN can move a card, change anyone
 * else's, or write the decision (`feature:manage`). Platform-level, not tenant-scoped.
 */
@Controller('feature-requests')
@RequireFeature('feature_requests')
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

  /** An administrator edits anything; the person who asked for a feature edits the request while it is still New. */
  @Patch(':id')
  @RequirePermission('feature:create')
  update(
    @Param('id') id: string,
    @Body(new ZodBody(featureRequestUpdateSchema)) body: FeatureRequestUpdateInput,
    @CurrentUser() user: AuthedUser,
  ) {
    return this.features.update(id, body, this.actor(user), can(user.role, 'feature:manage'));
  }

  /** An administrator deletes anything; the person who asked withdraws their own request while it is still New. */
  @Delete(':id')
  @RequirePermission('feature:create')
  remove(@Param('id') id: string, @CurrentUser() user: AuthedUser) {
    return this.features.remove(id, this.actor(user), can(user.role, 'feature:manage'));
  }
}
