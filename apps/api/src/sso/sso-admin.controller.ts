import { Body, Controller, Delete, Get, Inject, Param, ParseUUIDPipe, Patch, Post, Put, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import {
  approveStaffAccessSchema,
  denyStaffAccessSchema,
  createSsoProviderSchema,
  linkIdentitySchema,
  ssoGeneralSettingsSchema,
  updateSsoProviderSchema,
  type ApproveStaffAccessInput,
  type DenyStaffAccessInput,
  type CreateSsoProviderInput,
  type LinkIdentityInput,
  type SsoGeneralSettingsInput,
  type UpdateSsoProviderInput,
} from '@tvmf/shared';
import { CurrentUser } from '../auth/auth.decorators';
import { APP_CONFIG, type AppConfig } from '../common/config';
import type { AuthedUser } from '../common/request';
import { ZodBody } from '../common/zod.pipe';
import { RequirePermission } from '../rbac/require-permission.decorator';
import { oidcCookieOptions, TEST_COOKIE, TEST_TICKET_TTL_SECONDS } from './oidc/state-cookie';
import { SsoProvidersService } from './sso-providers.service';
import { SsoStaffAccessService } from './sso-staff-access.service';

/** Administration > Platform settings > Single sign-on (docs/SSO.md 4.5a). Super Admin only (`sso:manage`); every change is audited. */
@Controller('sso')
@RequirePermission('sso:manage')
export class SsoAdminController {
  constructor(
    private readonly providers: SsoProvidersService,
    private readonly staffAccess: SsoStaffAccessService,
    @Inject(APP_CONFIG) private readonly cfg: AppConfig,
  ) {}

  private actor(u: AuthedUser) {
    return { id: u.id, email: u.email, ...(u.idp ? { idp: u.idp } : {}) };
  }

  @Get('settings')
  settings() {
    return this.providers.settings();
  }

  @Put('general')
  general(@Body(new ZodBody(ssoGeneralSettingsSchema)) body: SsoGeneralSettingsInput, @CurrentUser() user: AuthedUser) {
    return this.providers.setGeneral(body, this.actor(user));
  }

  @Post('providers')
  create(@Body(new ZodBody(createSsoProviderSchema)) body: CreateSsoProviderInput, @CurrentUser() user: AuthedUser) {
    return this.providers.create(body, this.actor(user));
  }

  @Patch('providers/:id')
  update(@Param('id', ParseUUIDPipe) id: string, @Body(new ZodBody(updateSsoProviderSchema)) body: UpdateSsoProviderInput, @CurrentUser() user: AuthedUser) {
    return this.providers.update(id, body, this.actor(user));
  }

  @Delete('providers/:id')
  remove(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: AuthedUser) {
    return this.providers.remove(id, this.actor(user));
  }

  /** Returns the address that starts a test sign-in (the browser follows it). The proof that an administrator asked for it goes in a two-minute HttpOnly cookie, not in the address. */
  @Post('providers/:id/test')
  async test(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: AuthedUser, @Res({ passthrough: true }) res: Response) {
    const { url, ticket } = await this.providers.testStart(id, user.id);
    res.cookie(TEST_COOKIE, ticket, { ...oidcCookieOptions(this.cfg, '/api/auth/oidc'), maxAge: TEST_TICKET_TTL_SECONDS * 1000 });
    res.setHeader('Cache-Control', 'no-store');
    return { url };
  }

  /** Voxshift staff sign-ins waiting for approval, the windows running now, and the latest finished ones (docs/SSO.md 4.3a). */
  @Get('access')
  access() {
    return this.staffAccess.overview();
  }

  @Post('access/:id/approve')
  approve(@Param('id', ParseUUIDPipe) id: string, @Body(new ZodBody(approveStaffAccessSchema)) body: ApproveStaffAccessInput, @CurrentUser() user: AuthedUser) {
    return this.staffAccess.approve(id, body.hours, this.actor(user));
  }

  @Post('access/:id/deny')
  deny(@Param('id', ParseUUIDPipe) id: string, @Body(new ZodBody(denyStaffAccessSchema)) body: DenyStaffAccessInput, @CurrentUser() user: AuthedUser) {
    return this.staffAccess.deny(id, body.note, this.actor(user));
  }

  /** End a running window now. */
  @Post('access/:id/end')
  end(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: AuthedUser) {
    return this.staffAccess.end(id, this.actor(user));
  }

  @Get('link-requests')
  linkRequests(@Query('userId') userId?: string) {
    return this.providers.linkRequests(userId && /^[0-9a-f-]{36}$/i.test(userId) ? userId : undefined);
  }

  @Get('users/:userId/identities')
  identities(@Param('userId', ParseUUIDPipe) userId: string) {
    return this.providers.identitiesOf(userId);
  }

  @Post('users/:userId/identities')
  link(@Param('userId', ParseUUIDPipe) userId: string, @Body(new ZodBody(linkIdentitySchema)) body: LinkIdentityInput, @CurrentUser() user: AuthedUser) {
    return this.providers.link(userId, body, this.actor(user));
  }

  @Delete('identities/:id')
  unlink(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: AuthedUser) {
    return this.providers.unlink(id, this.actor(user));
  }
}
