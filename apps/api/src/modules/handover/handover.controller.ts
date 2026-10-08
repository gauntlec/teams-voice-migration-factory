import { Body, Controller, Get, Param, Post, Put, UseGuards } from '@nestjs/common';
import { handoverGenerateSchema, handoverNoteSchema } from '@tvmf/shared';
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
  list(@TenantCtx() t: TenantContext) {
    return this.handover.list(t);
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

  @Get('packs/:id')
  @RequirePermission('handover:read')
  get(@TenantCtx() t: TenantContext, @Param('id') id: string) {
    return this.handover.get(t, id);
  }

  /** Locks a draft pack as final. */
  @Post('packs/:id/issue')
  @RequirePermission('handover:issue')
  issue(@TenantCtx() t: TenantContext, @CurrentUser() user: AuthedUser, @Param('id') id: string) {
    return this.handover.issue(t, user, id);
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
