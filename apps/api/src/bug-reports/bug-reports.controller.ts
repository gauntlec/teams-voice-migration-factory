import { Body, Controller, Delete, Get, Param, Patch, Post } from '@nestjs/common';
import {
  bugReportCreateSchema,
  bugReportUpdateSchema,
  type BugReportCreateInput,
  type BugReportUpdateInput,
} from '@tvmf/shared';
import { CurrentUser } from '../auth/auth.decorators';
import type { AuthedUser } from '../common/request';
import { ZodBody } from '../common/zod.pipe';
import { RequirePermission } from '../rbac/require-permission.decorator';
import { BugReportsService } from './bug-reports.service';

/**
 * Bug-report board. SUPER_ADMIN / PROJECT_MANAGER / ENGINEER can view and
 * submit (`bug:read` / `bug:create`); only SUPER_ADMIN can move a card or
 * edit its labels (`bug:manage`). Platform-level, not tenant-scoped.
 */
@Controller('bug-reports')
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

  @Patch(':id')
  @RequirePermission('bug:manage')
  update(
    @Param('id') id: string,
    @Body(new ZodBody(bugReportUpdateSchema)) body: BugReportUpdateInput,
    @CurrentUser() user: AuthedUser,
  ) {
    return this.bugs.update(id, body, this.actor(user));
  }

  @Delete(':id')
  @RequirePermission('bug:manage')
  remove(@Param('id') id: string, @CurrentUser() user: AuthedUser) {
    return this.bugs.remove(id, this.actor(user));
  }
}
