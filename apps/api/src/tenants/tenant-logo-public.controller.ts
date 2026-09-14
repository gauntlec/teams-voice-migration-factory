import { Controller, Get, Param, Res } from '@nestjs/common';
import type { Response } from 'express';
import { Public } from '../auth/auth.decorators';
import { TenantsService } from './tenants.service';

/**
 * The one genuinely unauthenticated route in the branding feature: a logo
 * has to load via a plain `<img src>` in an email client (no auth headers
 * possible) and, potentially, before a user is signed in. Tenant ids are
 * unguessable UUIDs and logos aren't sensitive, so exposing them without
 * auth is an accepted, low-risk tradeoff - see the branding plan.
 */
@Controller('public/tenants')
export class TenantLogoPublicController {
  constructor(private readonly tenants: TenantsService) {}

  @Get(':tenantId/logo')
  @Public()
  async logo(@Param('tenantId') tenantId: string, @Res() res: Response) {
    const { data, contentType } = await this.tenants.readLogoBytes(tenantId);
    res.setHeader('Content-Type', contentType);
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    res.send(data);
  }
}
