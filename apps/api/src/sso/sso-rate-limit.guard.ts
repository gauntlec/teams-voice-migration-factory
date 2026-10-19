import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { RateLimiterRedis } from 'rate-limiter-flexible';
import type { Request, Response } from 'express';
import { InjectRedis, type Redis } from '../queue/queue.module';

/**
 * Redis-backed per-IP throttle on the browser-facing single sign-on routes (`/auth/oidc/login` and `/auth/oidc/callback`). It has its own
 * bucket, separate from the 20-a-minute password-form throttle (login-rate-limit.guard.ts): a whole office signing in through the
 * provider at nine o'clock shares one address, and neither kind of sign-in should use up the other's allowance.
 *
 * These routes are reached by browser navigation, so a refusal is a redirect to the login page with a plain-language message
 * (`/?sso_error=rate_limited`), never the raw JSON of a 429.
 */
export const SSO_RATE_LIMIT = { points: 60, durationSeconds: 60 } as const;

@Injectable()
export class SsoRateLimitGuard implements CanActivate {
  /** Replaceable in tests. */
  private readonly limiter: { consume(key: string): Promise<unknown> };

  constructor(@InjectRedis() redis: Redis) {
    this.limiter = new RateLimiterRedis({
      storeClient: redis,
      keyPrefix: 'sso-rl',
      points: SSO_RATE_LIMIT.points,
      duration: SSO_RATE_LIMIT.durationSeconds,
      blockDuration: SSO_RATE_LIMIT.durationSeconds,
    });
  }

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const http = ctx.switchToHttp();
    const req = http.getRequest<Request>();
    try {
      await this.limiter.consume(req.ip ?? 'unknown');
      return true;
    } catch {
      // rate-limiter-flexible rejects (doesn't throw) once a request is blocked.
      const res = http.getResponse<Response>();
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('Retry-After', String(SSO_RATE_LIMIT.durationSeconds));
      res.redirect(302, '/?sso_error=rate_limited');
      return false;
    }
  }
}
