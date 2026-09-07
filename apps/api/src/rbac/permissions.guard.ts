import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { can, type Permission } from '@tvmf/shared';
import type { AppRequest } from '../common/request';
import { REQUIRE_PERMISSION } from './require-permission.decorator';

@Injectable()
export class PermissionsGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(ctx: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<Permission[]>(REQUIRE_PERMISSION, [
      ctx.getHandler(),
      ctx.getClass(),
    ]);
    if (!required || required.length === 0) return true;

    const req = ctx.switchToHttp().getRequest<AppRequest>();
    const user = req.user;
    if (!user) throw new ForbiddenException('Not authenticated');

    const missing = required.filter((p) => !can(user.role, p));
    if (missing.length > 0) {
      throw new ForbiddenException(`Missing permission: ${missing.join(', ')}`);
    }
    return true;
  }
}
