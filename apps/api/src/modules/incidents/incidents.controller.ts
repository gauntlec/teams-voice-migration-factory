import { Body, Controller, Delete, Get, Param, Post, Put, Query, Res, UploadedFile, UseGuards, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { Response } from 'express';
import {
  INC_ATTACHMENT_MAX_BYTES,
  can,
  createIncidentSchema,
  incidentAssignSchema,
  incidentCommentSchema,
  incidentItemSchema,
  incidentPrioritySchema,
  incidentSettingsSchema,
  incidentStatusSchema,
  incidentWatcherSchema,
  listIncidentsQuerySchema,
  similarIncidentsQuerySchema,
  type CreateIncidentInput,
  type IncidentAssignInput,
  type IncidentCommentInput,
  type IncidentPriorityInput,
  type IncidentSettingsInput,
  type IncidentStatusInput,
  type IncidentWatcherInput,
  type IncItemInput,
  type ListIncidentsQuery,
  type SimilarIncidentsQuery,
} from '@tvmf/shared';
import { CurrentUser, TenantCtx } from '../../auth/auth.decorators';
import type { AuthedUser, TenantContext } from '../../common/request';
import { ZodBody } from '../../common/zod.pipe';
import { RequirePermission } from '../../rbac/require-permission.decorator';
import { TenantGuard } from '../../rbac/tenant.guard';
import { IncidentsService } from './incidents.service';

/**
 * Incident management for one customer. inc:read to see incidents, inc:create to
 * raise and comment, inc:manage (engineers and admins) to triage, assign,
 * change priority and add internal notes. The service also requires Managed
 * Services to be switched on for the customer, and applies site-contact scoping.
 */
@Controller('t/:tenantId/incidents')
@UseGuards(TenantGuard)
export class IncidentsController {
  constructor(private readonly svc: IncidentsService) {}

  @Get()
  @RequirePermission('inc:read')
  list(@TenantCtx() t: TenantContext, @CurrentUser() user: AuthedUser, @Query(new ZodBody(listIncidentsQuerySchema)) q: ListIncidentsQuery) {
    return this.svc.list(t, user, q);
  }

  /** Who an incident can be assigned to. Declared before :id so it isn't read as an id. */
  @Get('assignees')
  @RequirePermission('inc:manage')
  async assignees(@TenantCtx() t: TenantContext) {
    return (await this.svc.staff(t)).map((m) => ({ id: m.id, display_name: m.display_name, role: m.role }));
  }

  /** Open incidents like the one being raised, to follow instead. Declared before :id. */
  @Get('similar')
  @RequirePermission('inc:read')
  similar(@TenantCtx() t: TenantContext, @CurrentUser() user: AuthedUser, @Query(new ZodBody(similarIncidentsQuerySchema)) q: SimilarIncidentsQuery) {
    return this.svc.similar(t, user, q);
  }

  @Get('sites')
  @RequirePermission('inc:read')
  sites(@TenantCtx() t: TenantContext) {
    return this.svc.sites(t);
  }

  /** Targets and the priority matrix - everyone on the customer can read them. */
  @Get('settings')
  @RequirePermission('inc:read')
  settings(@TenantCtx() t: TenantContext) {
    return this.svc.settings(t);
  }

  /** Super Admins only (checked in the service). */
  @Put('settings')
  @RequirePermission('inc:manage')
  updateSettings(@TenantCtx() t: TenantContext, @CurrentUser() user: AuthedUser, @Body(new ZodBody(incidentSettingsSchema)) body: IncidentSettingsInput) {
    return this.svc.updateSettings(t, user, body);
  }

  @Get(':id')
  @RequirePermission('inc:read')
  get(@TenantCtx() t: TenantContext, @CurrentUser() user: AuthedUser, @Param('id') id: string) {
    return this.svc.get(t, id, can(user.role, 'inc:manage'), user.id);
  }

  @Post()
  @RequirePermission('inc:create')
  create(@TenantCtx() t: TenantContext, @CurrentUser() user: AuthedUser, @Body(new ZodBody(createIncidentSchema)) body: CreateIncidentInput) {
    return this.svc.create(t, user, body, can(user.role, 'inc:manage'));
  }

  /** Engineers and admins move an incident on; the reporter may cancel it while New, confirm it fixed, or reopen it. */
  @Post(':id/status')
  @RequirePermission('inc:create')
  move(@TenantCtx() t: TenantContext, @CurrentUser() user: AuthedUser, @Param('id') id: string, @Body(new ZodBody(incidentStatusSchema)) body: IncidentStatusInput) {
    return this.svc.move(t, user, id, body, can(user.role, 'inc:manage'));
  }

  @Post(':id/assign')
  @RequirePermission('inc:manage')
  assign(@TenantCtx() t: TenantContext, @CurrentUser() user: AuthedUser, @Param('id') id: string, @Body(new ZodBody(incidentAssignSchema)) body: IncidentAssignInput) {
    return this.svc.assign(t, user, id, body);
  }

  @Post(':id/priority')
  @RequirePermission('inc:manage')
  priority(@TenantCtx() t: TenantContext, @CurrentUser() user: AuthedUser, @Param('id') id: string, @Body(new ZodBody(incidentPrioritySchema)) body: IncidentPriorityInput) {
    return this.svc.setPriority(t, user, id, body);
  }

  @Post(':id/comments')
  @RequirePermission('inc:create')
  comment(@TenantCtx() t: TenantContext, @CurrentUser() user: AuthedUser, @Param('id') id: string, @Body(new ZodBody(incidentCommentSchema)) body: IncidentCommentInput) {
    return this.svc.comment(t, user, id, body, can(user.role, 'inc:manage'));
  }

  @Post(':id/watchers')
  @RequirePermission('inc:read')
  watch(@TenantCtx() t: TenantContext, @CurrentUser() user: AuthedUser, @Param('id') id: string, @Body(new ZodBody(incidentWatcherSchema)) body: IncidentWatcherInput) {
    return this.svc.watch(t, user, id, body.userId, can(user.role, 'inc:manage'));
  }

  @Delete(':id/watchers')
  @RequirePermission('inc:read')
  unwatch(@TenantCtx() t: TenantContext, @CurrentUser() user: AuthedUser, @Param('id') id: string, @Query('userId') userId?: string) {
    return this.svc.unwatch(t, user, id, userId || undefined, can(user.role, 'inc:manage'));
  }

  @Post(':id/items')
  @RequirePermission('inc:manage')
  addItem(@TenantCtx() t: TenantContext, @CurrentUser() user: AuthedUser, @Param('id') id: string, @Body(new ZodBody(incidentItemSchema)) body: IncItemInput) {
    return this.svc.addItem(t, user, id, body);
  }

  @Delete(':id/items/:itemId')
  @RequirePermission('inc:manage')
  removeItem(@TenantCtx() t: TenantContext, @CurrentUser() user: AuthedUser, @Param('id') id: string, @Param('itemId') itemId: string) {
    return this.svc.removeItem(t, user, id, itemId);
  }

  @Get(':id/attachments')
  @RequirePermission('inc:read')
  attachments(@TenantCtx() t: TenantContext, @Param('id') id: string) {
    return this.svc.attachments(t, id);
  }

  @Post(':id/attachments')
  @RequirePermission('inc:create')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: INC_ATTACHMENT_MAX_BYTES } }))
  attach(@TenantCtx() t: TenantContext, @CurrentUser() user: AuthedUser, @Param('id') id: string, @UploadedFile() file: Express.Multer.File) {
    return this.svc.attach(t, user, id, file);
  }

  @Get(':id/attachments/:fileId')
  @RequirePermission('inc:read')
  async attachment(@TenantCtx() t: TenantContext, @Param('id') id: string, @Param('fileId') fileId: string, @Res() res: Response) {
    const { row, data } = await this.svc.attachment(t, id, fileId);
    res.setHeader('Content-Type', row.contentType);
    res.setHeader('Content-Disposition', `attachment; filename="${row.filename.replace(/"/g, '')}"`);
    res.setHeader('Content-Length', String(row.byteSize));
    res.send(data);
  }
}
