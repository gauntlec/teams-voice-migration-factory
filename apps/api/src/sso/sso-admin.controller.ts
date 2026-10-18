import { Body, Controller, Delete, Get, Param, ParseUUIDPipe, Patch, Post, Put, Query } from '@nestjs/common';
import {
  createSsoProviderSchema,
  linkIdentitySchema,
  ssoGeneralSettingsSchema,
  updateSsoProviderSchema,
  type CreateSsoProviderInput,
  type LinkIdentityInput,
  type SsoGeneralSettingsInput,
  type UpdateSsoProviderInput,
} from '@tvmf/shared';
import { CurrentUser } from '../auth/auth.decorators';
import type { AuthedUser } from '../common/request';
import { ZodBody } from '../common/zod.pipe';
import { RequirePermission } from '../rbac/require-permission.decorator';
import { SsoProvidersService } from './sso-providers.service';

/** Administration > Platform settings > Single sign-on (docs/SSO.md 4.5a). Super Admin only (`sso:manage`); every change is audited. */
@Controller('sso')
@RequirePermission('sso:manage')
export class SsoAdminController {
  constructor(private readonly providers: SsoProvidersService) {}

  private actor(u: AuthedUser) {
    return { id: u.id, email: u.email };
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

  /** Returns the address that starts a test sign-in (the browser follows it). */
  @Post('providers/:id/test')
  test(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: AuthedUser) {
    return this.providers.testUrl(id, user.id);
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
