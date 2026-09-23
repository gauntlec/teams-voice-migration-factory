import { CanActivate, ExecutionContext, HttpException, HttpStatus, Injectable } from '@nestjs/common';
import { RateLimiterRedis } from 'rate-limiter-flexible';
import type { Request } from 'express';
import { InjectRedis, type Redis } from '../queue/queue.module';

/**
 * Redis-backed per-IP throttle on POST /auth/login, on top of (not instead
 * of) the existing per-account lockout in auth.service.ts (platform.users'
 * failed_logins/locked_until - already Postgres-backed, so already safe for
 * multi-instance deploys). That lockout only fires once a specific account
 * has been guessed at; this catches an attacker spraying many different
 * emails from one IP, who'd otherwise never trip any single account's
 * counter. Shares the ioredis connection BullMQ already holds open
 * (queue.module.ts) rather than a second connection.
 */
@Injectable()
export class LoginRateLimitGuard implements CanActivate {
  private readonly limiter: RateLimiterRedis;

  constructor(@InjectRedis() redis: Redis) {
    this.limiter = new RateLimiterRedis({
      storeClient: redis,
      keyPrefix: 'login-rl',
      points: 20,
      duration: 60,
      blockDuration: 60,
    });
  }

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest<Request>();
    try {
      await this.limiter.consume(req.ip ?? 'unknown');
      return true;
    } catch {
      // rate-limiter-flexible rejects (doesn't throw) once a request is
      // blocked - any rejection here means "too many", never a real error.
      throw new HttpException('Too many login attempts - try again in a minute.', HttpStatus.TOO_MANY_REQUESTS);
    }
  }
}
