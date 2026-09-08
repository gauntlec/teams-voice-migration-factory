import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { platformDb } from '@tvmf/db';
import type { Role } from '@tvmf/shared';
import type { AppRequest } from '../common/request';
import { InjectDb, type Db } from '../db/db.module';
import { ALLOW_ENROL, ALLOW_PWRESET, IS_PUBLIC } from './auth.decorators';
import { TokenService } from './token.service';

@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly tokens: TokenService,
    @InjectDb() private readonly db: Db,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, [
      ctx.getHandler(),
      ctx.getClass(),
    ]);
    if (isPublic) return true;

    const req = ctx.switchToHttp().getRequest<AppRequest>();
    const header = req.headers.authorization ?? '';
    const [scheme, token] = header.split(' ');
    if (scheme !== 'Bearer' || !token) throw new UnauthorizedException('Missing bearer token');

    const payload = this.tokens.verifyAccess(token);

    const user = await platformDb(this.db)
      .selectFrom('users')
      .select(['id', 'email', 'display_name', 'role', 'status', 'totp_enrolled'])
      .where('id', '=', payload.sub)
      .executeTakeFirst();
    if (!user || user.status !== 'active') throw new UnauthorizedException('Account unavailable');

    const enrolOnly = payload.typ === 'enrol';
    const pwresetOnly = payload.typ === 'pwreset';
    const allowEnrol = this.reflector.getAllAndOverride<boolean>(ALLOW_ENROL, [
      ctx.getHandler(),
      ctx.getClass(),
    ]);
    const allowPwReset = this.reflector.getAllAndOverride<boolean>(ALLOW_PWRESET, [
      ctx.getHandler(),
      ctx.getClass(),
    ]);
    if (pwresetOnly && !allowPwReset) {
      throw new ForbiddenException('Set a new password first');
    }
    if (enrolOnly && !allowEnrol) {
      throw new ForbiddenException('Complete MFA enrolment first');
    }
    if (!enrolOnly && !pwresetOnly && !user.totp_enrolled && !allowEnrol) {
      throw new ForbiddenException('MFA enrolment required');
    }

    req.user = {
      id: user.id,
      email: user.email,
      displayName: user.display_name,
      role: user.role as Role,
      totpEnrolled: user.totp_enrolled,
      enrolOnly,
      pwresetOnly,
    };
    return true;
  }
}
