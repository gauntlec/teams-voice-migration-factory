import { Body, Controller, HttpCode, NotFoundException, Post, Headers, UnauthorizedException } from '@nestjs/common';
import { timingSafeEqual } from 'node:crypto';
import { Inject } from '@nestjs/common';
import { Public } from '../../auth/auth.decorators';
import { APP_CONFIG, type AppConfig } from '../../common/config';
import { InboundEmailService } from './inbound-email.service';

/**
 * Where the mail forwarder posts a message addressed to the incidents mailbox (docs/INTAKE.md). Off (404) unless INBOUND_EMAIL_ADDRESS
 * and INBOUND_EMAIL_SECRET are set; the forwarder presents the secret in `x-inbound-secret`.
 */
@Controller('public/inbound-email')
@Public()
export class InboundEmailController {
  constructor(
    private readonly svc: InboundEmailService,
    @Inject(APP_CONFIG) private readonly cfg: AppConfig,
  ) {}

  @Post()
  @HttpCode(200)
  async receive(@Headers('x-inbound-secret') secret: string | undefined, @Body() body: unknown) {
    if (!this.cfg.INBOUND_EMAIL_ADDRESS || !this.cfg.INBOUND_EMAIL_SECRET) throw new NotFoundException();
    const given = Buffer.from(secret ?? '');
    const want = Buffer.from(this.cfg.INBOUND_EMAIL_SECRET);
    if (given.length !== want.length || !timingSafeEqual(given, want)) throw new UnauthorizedException('Wrong inbound secret.');
    return this.svc.handle(body);
  }
}
