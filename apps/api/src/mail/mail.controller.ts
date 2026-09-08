import { Controller, Get, Param, Post, Query } from '@nestjs/common';
import { RequirePermission } from '../rbac/require-permission.decorator';
import { MailService } from './mail.service';

/**
 * Platform email log - queued/sent/failed messages plus the current SMTP
 * relay configuration. SUPER_ADMIN only (shares `audit:read:platform` with the
 * platform audit log it sits next to). Never returns `context`, which can hold
 * an invitation's temporary password.
 */
@Controller('email-messages')
export class MailController {
  constructor(private readonly mail: MailService) {}

  @Get()
  @RequirePermission('audit:read:platform')
  async list(@Query('limit') limit = '250') {
    return {
      smtp: {
        configured: !!process.env.SMTP_HOST,
        host: process.env.SMTP_HOST ?? null,
        port: Number(process.env.SMTP_PORT ?? 587),
        from: process.env.MAIL_FROM ?? 'no-reply@voxshift.io',
        // true only tells the operator whether a password is present, never its value
        hasCredentials: !!process.env.SMTP_USER,
      },
      items: await this.mail.list(Number(limit) || 250),
    };
  }

  @Post(':id/resend')
  @RequirePermission('audit:read:platform')
  resend(@Param('id') id: string) {
    return this.mail.resend(id);
  }
}
