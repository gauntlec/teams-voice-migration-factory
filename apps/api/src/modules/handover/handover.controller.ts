import { BadRequestException, Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Put, Query, UploadedFile, UseGuards, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import {
  handoverActionCreateSchema,
  handoverActionPatchSchema,
  handoverCallFlowsSchema,
  handoverGenerateSchema,
  handoverIssueSchema,
  handoverNoteSchema,
  type HandoverActionCreateInput,
  type HandoverActionPatchInput,
  type HandoverIssueInput,
} from '@tvmf/shared';
import { CurrentUser, TenantCtx } from '../../auth/auth.decorators';
import type { AuthedUser, TenantContext } from '../../common/request';
import { ZodBody } from '../../common/zod.pipe';
import { RequirePermission } from '../../rbac/require-permission.decorator';
import { TenantGuard } from '../../rbac/tenant.guard';
import { HandoverService, type HandoverGenerateInput, type HandoverNoteInput } from './handover.service';

/**
 * Service Handover view — generates the handover pack (a branded .docx, see
 * HandoverDocumentService) from the final tenant state.
 */
@Controller('t/:tenantId/handover')
@UseGuards(TenantGuard)
export class HandoverController {
  constructor(private readonly handover: HandoverService) {}

  @Get('packs')
  @RequirePermission('handover:read')
  list(@TenantCtx() t: TenantContext, @CurrentUser() user: AuthedUser) {
    return this.handover.list(t, user);
  }

  /** Every site with its handover status, versions, outstanding actions (staff only) and Provider PMs. */
  @Get('sites')
  @RequirePermission('handover:read')
  sites(@TenantCtx() t: TenantContext, @CurrentUser() user: AuthedUser) {
    return this.handover.sites(t, user);
  }

  @Post('packs')
  @RequirePermission('handover:generate')
  generate(
    @TenantCtx() t: TenantContext,
    @CurrentUser() user: AuthedUser,
    @Body(new ZodBody(handoverGenerateSchema)) body: HandoverGenerateInput,
  ) {
    return this.handover.generate(t, user, body);
  }

  /** Before a pack is generated: the port ranges on its sites that have not been ported yet, for the engineer to confirm. */
  @Post('pre-check')
  @HttpCode(200)
  @RequirePermission('handover:generate')
  preCheck(@TenantCtx() t: TenantContext, @Body(new ZodBody(handoverCallFlowsSchema)) body: { siteIds?: string[] }) {
    return this.handover.unportedRanges(t, body.siteIds).then((unportedRanges) => ({ unportedRanges }));
  }

  /** What Teams has for a pack's auto attendants, as graphs for the browser to draw (a POST: a pack can name many sites). */
  @Post('call-flows')
  @HttpCode(200)
  @RequirePermission('handover:generate')
  callFlows(@TenantCtx() t: TenantContext, @Body(new ZodBody(handoverCallFlowsSchema)) body: { siteIds?: string[] }) {
    return this.handover.callFlowGraphs(t, body.siteIds);
  }

  /** A call flow diagram the browser drew for a pack it is about to generate: a PNG, kept with the pack. */
  @Post('diagrams')
  @RequirePermission('handover:generate')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 25 * 1024 * 1024 } }))
  uploadDiagram(@TenantCtx() t: TenantContext, @CurrentUser() user: AuthedUser, @UploadedFile() file: Express.Multer.File) {
    return this.handover.uploadDiagram(t, user, file);
  }

  @Get('packs/:id')
  @RequirePermission('handover:read')
  get(@TenantCtx() t: TenantContext, @CurrentUser() user: AuthedUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.handover.get(t, user, id);
  }

  /** Locks a draft pack as final. */
  @Post('packs/:id/issue')
  @RequirePermission('handover:issue')
  issue(@TenantCtx() t: TenantContext, @CurrentUser() user: AuthedUser, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodBody(handoverIssueSchema)) body: HandoverIssueInput) {
    return this.handover.issue(t, user, id, body);
  }

  /**
   * Outstanding actions, open first; `siteId` narrows to one site plus the all-sites ones. Staff only: customers see what's
   * outstanding in an issued pack, never the working list (feature request "Service Handover View", 10 Nov 2026).
   */
  @Get('actions')
  @RequirePermission('handover:generate')
  actions(@TenantCtx() t: TenantContext, @Query('siteId') siteId?: string) {
    if (siteId !== undefined && !/^[0-9a-f-]{36}$/i.test(siteId)) throw new BadRequestException('siteId must be a site id');
    return this.handover.listActions(t, siteId);
  }

  @Post('actions')
  @RequirePermission('handover:generate')
  addAction(@TenantCtx() t: TenantContext, @CurrentUser() user: AuthedUser, @Body(new ZodBody(handoverActionCreateSchema)) body: HandoverActionCreateInput) {
    return this.handover.createAction(t, user, body);
  }

  /** Edit an action, or tick it off / open it again. */
  @Patch('actions/:id')
  @RequirePermission('handover:generate')
  updateAction(@TenantCtx() t: TenantContext, @CurrentUser() user: AuthedUser, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodBody(handoverActionPatchSchema)) body: HandoverActionPatchInput) {
    return this.handover.updateAction(t, user, id, body);
  }

  @Delete('actions/:id')
  @RequirePermission('handover:generate')
  deleteAction(@TenantCtx() t: TenantContext, @CurrentUser() user: AuthedUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.handover.deleteAction(t, user, id);
  }

  /** The hand-written notes behind the sections with no structured data source. Staff only, like the actions: drafts in the making. */
  @Get('notes')
  @RequirePermission('handover:generate')
  notes(@TenantCtx() t: TenantContext) {
    return this.handover.listNotes(t);
  }

  /** Saves a section's note for one site (or every site); an empty body clears it. */
  @Put('notes')
  @RequirePermission('handover:generate')
  saveNote(
    @TenantCtx() t: TenantContext,
    @CurrentUser() user: AuthedUser,
    @Body(new ZodBody(handoverNoteSchema)) body: HandoverNoteInput,
  ) {
    return this.handover.saveNote(t, user, body);
  }
}
