import { Body, Controller, Delete, Get, Param, Patch, Post, Res, UploadedFile, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { Response } from 'express';
import {
  BUG_ATTACHMENT_MAX_BYTES,
  bugReportCreateSchema,
  can,
  bugReportUpdateSchema,
  type BugReportCreateInput,
  type BugReportUpdateInput,
} from '@tvmf/shared';
import { CurrentUser } from '../auth/auth.decorators';
import type { AuthedUser } from '../common/request';
import { ZodBody } from '../common/zod.pipe';
import { RequirePermission } from '../rbac/require-permission.decorator';
import { BugReportsService } from './bug-reports.service';
import { RequireFeature } from '../common/feature.guard';

/**
 * Bug-report board. SUPER_ADMIN / PROJECT_MANAGER / ENGINEER can view and
 * submit (`bug:read` / `bug:create`); only SUPER_ADMIN can move a card or
 * edit its labels (`bug:manage`). Platform-level, not tenant-scoped.
 */
@Controller('bug-reports')
@RequireFeature('bug_reports')
export class BugReportsController {
  constructor(private readonly bugs: BugReportsService) {}

  private actor(u: AuthedUser) {
    return { id: u.id, email: u.email, role: u.role };
  }

  @Get()
  @RequirePermission('bug:read')
  list() {
    return this.bugs.list();
  }

  @Post()
  @RequirePermission('bug:create')
  create(
    @Body(new ZodBody(bugReportCreateSchema)) body: BugReportCreateInput,
    @CurrentUser() user: AuthedUser,
  ) {
    return this.bugs.create(body, this.actor(user));
  }

  /** An administrator edits anything; the person who reported a bug edits its description while it is still New (see BugReportsService.update). */
  @Patch(':id')
  @RequirePermission('bug:create')
  update(
    @Param('id') id: string,
    @Body(new ZodBody(bugReportUpdateSchema)) body: BugReportUpdateInput,
    @CurrentUser() user: AuthedUser,
  ) {
    return this.bugs.update(id, body, this.actor(user), can(user.role, 'bug:manage'));
  }

  /** An administrator deletes anything; the person who reported a bug withdraws it while it is still New. */
  @Delete(':id')
  @RequirePermission('bug:create')
  remove(@Param('id') id: string, @CurrentUser() user: AuthedUser) {
    return this.bugs.remove(id, this.actor(user), can(user.role, 'bug:manage'));
  }

  @Get(':id/attachments')
  @RequirePermission('bug:read')
  attachments(@Param('id') id: string) {
    return this.bugs.attachments(id);
  }

  /** An administrator, or the person who reported the bug. */
  @Post(':id/attachments')
  @RequirePermission('bug:create')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: BUG_ATTACHMENT_MAX_BYTES } }))
  attach(@Param('id') id: string, @UploadedFile() file: Express.Multer.File, @CurrentUser() user: AuthedUser) {
    return this.bugs.attach(id, file, this.actor(user), can(user.role, 'bug:manage'));
  }

  @Get(':id/attachments/:attachmentId')
  @RequirePermission('bug:read')
  async attachment(@Param('id') id: string, @Param('attachmentId') attachmentId: string, @Res() res: Response) {
    const row = await this.bugs.attachment(id, attachmentId);
    res.setHeader('Content-Type', row.content_type);
    res.setHeader('Content-Disposition', `attachment; filename="${row.filename.replace(/["\r\n]/g, '')}"`);
    res.setHeader('Content-Length', String(row.size));
    res.send(row.content);
  }

  /** An administrator, or whoever attached the file. */
  @Delete(':id/attachments/:attachmentId')
  @RequirePermission('bug:create')
  removeAttachment(@Param('id') id: string, @Param('attachmentId') attachmentId: string, @CurrentUser() user: AuthedUser) {
    return this.bugs.removeAttachment(id, attachmentId, this.actor(user), can(user.role, 'bug:manage'));
  }
}
