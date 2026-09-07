import {
  Body,
  Controller,
  Get,
  Inject,
  Post,
  Req,
  Res,
  UnauthorizedException,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { loginSchema, totpEnrolConfirmSchema } from '@tvmf/shared';
import { APP_CONFIG, type AppConfig } from '../common/config';
import type { AppRequest } from '../common/request';
import { ZodBody } from '../common/zod.pipe';
import { AuthService } from './auth.service';
import { AllowEnrol, CurrentUser, Public } from './auth.decorators';
import type { AuthedUser } from '../common/request';

@Controller('auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    @Inject(APP_CONFIG) private readonly cfg: AppConfig,
  ) {}

  private cookieBase() {
    const base: { httpOnly: true; secure: boolean; sameSite: 'lax'; path: string; domain?: string } = {
      httpOnly: true,
      secure: this.cfg.COOKIE_SECURE,
      sameSite: 'lax',
      path: '/api/auth',
    };
    if (this.cfg.COOKIE_DOMAIN) base.domain = this.cfg.COOKIE_DOMAIN;
    return base;
  }

  private setRefreshCookie(res: Response, value: string, expires: Date) {
    res.cookie(this.cfg.REFRESH_COOKIE, value, { ...this.cookieBase(), expires });
  }

  private clearRefreshCookie(res: Response) {
    const opts: { path: string; domain?: string } = { path: '/api/auth' };
    if (this.cfg.COOKIE_DOMAIN) opts.domain = this.cfg.COOKIE_DOMAIN;
    res.clearCookie(this.cfg.REFRESH_COOKIE, opts);
  }

  private meta(req: Request) {
    return {
      userAgent: req.headers['user-agent'],
      ip: req.ip,
    };
  }

  @Public()
  @Post('login')
  async login(
    @Body(new ZodBody(loginSchema)) body: { email: string; password: string; totp?: string },
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const result = await this.auth.login(body.email, body.password, body.totp, this.meta(req));
    if (result.enrolRequired) {
      return { enrolRequired: true, accessToken: result.accessToken };
    }
    this.setRefreshCookie(res, result.refreshCookieValue, result.refreshExpiresAt);
    return { accessToken: result.accessToken, expiresIn: result.accessExpiresIn };
  }

  @AllowEnrol()
  @Post('totp/start')
  async totpStart(@CurrentUser() user: AuthedUser) {
    return this.auth.beginTotpEnrol(user.id, user.email);
  }

  @AllowEnrol()
  @Post('totp/confirm')
  async totpConfirm(
    @CurrentUser() user: AuthedUser,
    @Body(new ZodBody(totpEnrolConfirmSchema)) body: { totp: string },
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const result = await this.auth.confirmTotpEnrol(
      user.id,
      user.role,
      user.email,
      body.totp,
      this.meta(req),
    );
    this.setRefreshCookie(res, result.refreshCookieValue, result.refreshExpiresAt);
    return { accessToken: result.accessToken, expiresIn: result.accessExpiresIn };
  }

  @Public()
  @Post('refresh')
  async refresh(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const cookie = (req as AppRequest).cookies?.[this.cfg.REFRESH_COOKIE];
    if (!cookie) throw new UnauthorizedException('No session');
    const result = await this.auth.refresh(cookie, this.meta(req));
    this.setRefreshCookie(res, result.refreshCookieValue, result.refreshExpiresAt);
    return { accessToken: result.accessToken, expiresIn: result.accessExpiresIn };
  }

  @Public()
  @Post('logout')
  async logout(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const cookie = (req as AppRequest).cookies?.[this.cfg.REFRESH_COOKIE];
    await this.auth.logout(cookie);
    this.clearRefreshCookie(res);
    return { ok: true };
  }

  @Get('me')
  async me(@CurrentUser() user: AuthedUser) {
    return this.auth.me(user.id);
  }
}
