import { Controller, Get, UseGuards } from '@nestjs/common';
import { TenantCtx } from '../../auth/auth.decorators';
import type { TenantContext } from '../../common/request';
import { RequirePermission } from '../../rbac/require-permission.decorator';
import { TenantGuard } from '../../rbac/tenant.guard';
import { DocumentBrandingService } from './document-branding.service';

/** The branding documents for this customer carry - the web uses it for the PDFs it draws itself (the call flow diagram). */
@Controller('t/:tenantId/document-branding')
@UseGuards(TenantGuard)
export class DocumentBrandingController {
  constructor(private readonly svc: DocumentBrandingService) {}

  @Get()
  @RequirePermission('tenant:read')
  view(@TenantCtx() t: TenantContext) {
    return this.svc.view(t.id);
  }
}
