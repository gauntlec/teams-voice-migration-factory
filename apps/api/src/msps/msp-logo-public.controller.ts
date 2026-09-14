import { Controller, Get, Param, Res } from '@nestjs/common';
import type { Response } from 'express';
import { Public } from '../auth/auth.decorators';
import { MspsService } from './msps.service';

/**
 * The one genuinely unauthenticated route in MSP branding: same reasoning
 * as tenant-logo-public.controller.ts - a logo has to load via a plain
 * `<img src>` in the app chrome (and potentially in future MSP-branded
 * email) with no auth headers possible. MSP ids are unguessable UUIDs and
 * logos aren't sensitive.
 */
@Controller('public/msps')
export class MspLogoPublicController {
  constructor(private readonly msps: MspsService) {}

  @Get(':mspId/logo')
  @Public()
  async logo(@Param('mspId') mspId: string, @Res() res: Response) {
    const { data, contentType } = await this.msps.readLogoBytes(mspId);
    res.setHeader('Content-Type', contentType);
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    // Same CORP fix as the tenant logo route - see tenant-logo-public.controller.ts.
    res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
    res.send(data);
  }
}
