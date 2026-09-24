import { Body, Controller, Get, Param, Post, UseGuards } from '@nestjs/common';
import { CurrentUser, TenantCtx } from '../../auth/auth.decorators';
import type { AuthedUser, TenantContext } from '../../common/request';
import { RequirePermission } from '../../rbac/require-permission.decorator';
import { TenantGuard } from '../../rbac/tenant.guard';
import { HandoverService } from './handover.service';

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
  generate(@TenantCtx() t: TenantContext, @CurrentUser() user: AuthedUser, @Body() body: { notes?: string }) {
    return this.handover.generate(t, user, body);
  }

  @Get('packs/:id')
  @RequirePermission('handover:read')
  get(@TenantCtx() t: TenantContext, @Param('id') id: string) {
    return this.handover.get(t, id);
  }
}
