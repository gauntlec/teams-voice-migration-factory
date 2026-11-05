import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Put, UploadedFile, UseGuards, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { handoverCallFlowsSchema, handoverGenerateSchema, handoverIssueSchema, handoverNoteSchema, type HandoverIssueInput } from '@tvmf/shared';
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

  @Post('packs')
  @RequirePermission('handover:generate')
  generate(
    @TenantCtx() t: TenantContext,
    @CurrentUser() user: AuthedUser,
    @Body(new ZodBody(handoverGenerateSchema)) body: HandoverGenerateInput,
  ) {
    return this.handover.generate(t, user, body);
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

  /** The hand-written notes behind the sections with no structured data source. */
  @Get('notes')
  @RequirePermission('handover:read')
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
