import { Body, Controller, Delete, Get, Param, Patch, Post, Res, UploadedFile, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { Response } from 'express';
import {
  FEATURE_ATTACHMENT_MAX_BYTES,
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

  @Get(':id/attachments')
  @RequirePermission('feature:read')
  attachments(@Param('id') id: string) {
    return this.features.attachments(id);
  }

  /** An administrator, or the person who asked for it. */
  @Post(':id/attachments')
  @RequirePermission('feature:create')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: FEATURE_ATTACHMENT_MAX_BYTES } }))
  attach(@Param('id') id: string, @UploadedFile() file: Express.Multer.File, @CurrentUser() user: AuthedUser) {
    return this.features.attach(id, file, this.actor(user), can(user.role, 'feature:manage'));
  }

  @Get(':id/attachments/:attachmentId')
  @RequirePermission('feature:read')
  async attachment(@Param('id') id: string, @Param('attachmentId') attachmentId: string, @Res() res: Response) {
    const row = await this.features.attachment(id, attachmentId);
    res.setHeader('Content-Type', row.content_type);
    res.setHeader('Content-Disposition', `attachment; filename="${row.filename.replace(/["\r\n]/g, '')}"`);
    res.setHeader('Content-Length', String(row.size));
    res.send(row.content);
  }

  /** An administrator, or whoever attached the file. */
  @Delete(':id/attachments/:attachmentId')
  @RequirePermission('feature:create')
  removeAttachment(@Param('id') id: string, @Param('attachmentId') attachmentId: string, @CurrentUser() user: AuthedUser) {
    return this.features.removeAttachment(id, attachmentId, this.actor(user), can(user.role, 'feature:manage'));
  }
}
