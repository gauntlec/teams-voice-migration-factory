import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { LoginRateLimitGuard } from '../auth/login-rate-limit.guard';
import { MailModule } from '../mail/mail.module';
import { OidcClient } from './oidc/oidc-client';
import { SsoAdminController } from './sso-admin.controller';
import { SsoAuthController } from './sso-auth.controller';
import { SsoProvidersService } from './sso-providers.service';
import { OIDC_CLIENT, SsoSignInService } from './sso-signin.service';

/** Single sign-on, the installation's side (docs/SSO.md): OpenID Connect relying party, providers, linking. */
@Module({
  imports: [AuthModule, MailModule],
  controllers: [SsoAuthController, SsoAdminController],
  providers: [{ provide: OIDC_CLIENT, useFactory: () => new OidcClient() }, SsoSignInService, SsoProvidersService, LoginRateLimitGuard],
})
export class SsoModule {}
