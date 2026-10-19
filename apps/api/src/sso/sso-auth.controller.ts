import { Controller, Get, Inject, Logger, Query, Req, Res, UseGuards } from '@nestjs/common';
import type { Request, Response } from 'express';
import { z } from 'zod';
import type { AppRequest } from '../common/request';
import { type PublicSsoProviders, safeReturnTo } from '@tvmf/shared';
import { APP_CONFIG, type AppConfig } from '../common/config';
import { Public } from '../auth/auth.decorators';
import { oidcCookieOptions, readTestTicket, STATE_COOKIE, STATE_TTL_SECONDS, TEST_COOKIE } from './oidc/state-cookie';
import { SsoRateLimitGuard } from './sso-rate-limit.guard';
import { SsoProvidersService } from './sso-providers.service';
import { SsoSignInService } from './sso-signin.service';

const loginQuery = z.object({
  provider: z.string().trim().min(1).max(64),
  returnTo: z.string().max(600).optional(),
});

const callbackQuery = z.object({
  code: z.string().max(4000).optional(),
  state: z.string().max(600).optional(),
  error: z.string().max(200).optional(),
});

/**
 * The browser-facing half of single sign-on (docs/SSO.md 4.2): the list for the login page, the redirect to the provider, and the
 * callback. Everything here is public (the person is not signed in yet); the state cookie and PKCE tie the answer to the browser that asked.
 * Failures send the browser back to the app with a short code the login page turns into plain words; the reason goes to the audit log.
 */
@Controller('auth')
export class SsoAuthController {
  private readonly log = new Logger(SsoAuthController.name);

  constructor(
    private readonly signIn: SsoSignInService,
    private readonly providers: SsoProvidersService,
    @Inject(APP_CONFIG) private readonly cfg: AppConfig,
  ) {}

  private cookieOptions(path: string) {
    return oidcCookieOptions(this.cfg, path);
  }

  private noStore(res: Response) {
    res.setHeader('Cache-Control', 'no-store');
  }

  private clearState(res: Response) {
    res.clearCookie(STATE_COOKIE, this.cookieOptions('/api/auth/oidc'));
  }

  /** An unexpected error is never shown as raw JSON to someone who navigated here: it is logged and the person gets the plain message on the login page. */
  private crashed(res: Response, where: string, err: unknown) {
    this.log.error(`Single sign-on ${where} failed: ${(err as Error)?.stack ?? String(err)}`);
    if (res.headersSent) return;
    this.fail(res, 'failed');
  }

  private fail(res: Response, error: string) {
    this.clearState(res);
    this.noStore(res);
    res.redirect(302, `/?sso_error=${encodeURIComponent(error)}`);
  }

  /** For the login page: the providers that are switched on (id, name, kind) and whether the password form is shown. */
  @Public()
  @Get('providers')
  list(@Res({ passthrough: true }) res: Response): Promise<PublicSsoProviders> {
    this.noStore(res);
    return this.providers.publicList();
  }

  @Public()
  @UseGuards(SsoRateLimitGuard)
  @Get('oidc/login')
  async login(@Query() raw: Record<string, unknown>, @Req() req: Request, @Res() res: Response) {
    try {
      const q = loginQuery.safeParse(raw);
      if (!q.success) return this.fail(res, 'failed');
      const providerId = q.data.provider === 'hub' ? await this.providers.hubProviderId() : /^[0-9a-f-]{36}$/i.test(q.data.provider) ? q.data.provider : null;
      if (!providerId) return this.fail(res, 'provider_off');

      // "Test sign-in" leaves a short ticket in a cookie (never in the address); it is used once. Without a valid one for this provider this is an ordinary sign-in.
      let testBy: string | undefined;
      const ticket = (req as AppRequest).cookies?.[TEST_COOKIE];
      if (ticket) {
        res.clearCookie(TEST_COOKIE, this.cookieOptions('/api/auth/oidc'));
        const t = readTestTicket(ticket, this.cfg.JWT_ACCESS_SECRET);
        if (t && t.providerId === providerId) testBy = t.adminId;
      }

      const begun = await this.signIn.begin({
        providerId,
        returnTo: safeReturnTo(q.data.returnTo),
        requestHost: req.hostname,
        testBy,
        meta: { ip: req.ip, userAgent: req.headers['user-agent'] },
      });
      if (!begun.ok) return this.fail(res, begun.error);
      this.noStore(res);
      res.cookie(STATE_COOKIE, begun.stateCookie, { ...this.cookieOptions('/api/auth/oidc'), maxAge: STATE_TTL_SECONDS * 1000 });
      res.redirect(302, begun.redirectUrl);
    } catch (err) {
      this.crashed(res, 'start', err);
    }
  }

  @Public()
  @UseGuards(SsoRateLimitGuard)
  @Get('oidc/callback')
  async callback(@Query() raw: Record<string, unknown>, @Req() req: Request, @Res() res: Response) {
    try {
      const q = callbackQuery.safeParse(raw);
      const result = await this.signIn.complete({
        code: q.success ? q.data.code : undefined,
        state: q.success ? q.data.state : undefined,
        error: q.success ? q.data.error : 'malformed',
        stateCookie: (req as AppRequest).cookies?.[STATE_COOKIE],
        meta: { ip: req.ip, userAgent: req.headers['user-agent'] },
      });
      this.clearState(res);
      this.noStore(res);
      if (result.kind === 'tested') return res.redirect(302, `/admin/settings/sso?tested=${result.providerId}`);
      if (result.kind === 'refused') {
        if (result.testProviderId) return res.redirect(302, `/admin/settings/sso?tested=${result.testProviderId}`);
        return res.redirect(302, `/?sso_error=${encodeURIComponent(result.error)}`);
      }
      // The same rotating refresh cookie a password sign-in sets; the app then asks for its access token with it, as it does on any page load.
      res.cookie(this.cfg.REFRESH_COOKIE, result.refreshCookieValue, { ...this.cookieOptions('/api/auth'), expires: result.refreshExpiresAt });
      res.redirect(302, result.redirectTo);
    } catch (err) {
      this.crashed(res, 'callback', err);
    }
  }
}
