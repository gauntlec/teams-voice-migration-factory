import { SetMetadata, createParamDecorator, type ExecutionContext } from '@nestjs/common';
import type { AppRequest, AuthedUser, TenantContext } from '../common/request';

export const IS_PUBLIC = 'auth:public';
/** Route needs no authentication at all. */
export const Public = () => SetMetadata(IS_PUBLIC, true);

export const ALLOW_ENROL = 'auth:allowEnrol';
/** Route is reachable with a limited "enrol TOTP" token (and normal tokens). */
export const AllowEnrol = () => SetMetadata(ALLOW_ENROL, true);

export const CurrentUser = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): AuthedUser => {
    const req = ctx.switchToHttp().getRequest<AppRequest>();
    if (!req.user) throw new Error('CurrentUser used on a route without JwtAuthGuard');
    return req.user;
  },
);

export const TenantCtx = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): TenantContext => {
    const req = ctx.switchToHttp().getRequest<AppRequest>();
    if (!req.tenant) throw new Error('TenantCtx used on a route without TenantGuard');
    return req.tenant;
  },
);
