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

    // A session that came through a single sign-on provider is only as good as the person's identity there. If the link has been removed, or the hub told
    // this installation to end the sign-ins that began before a moment (docs/SSO.md 4.7), the access token stops working now, not at its next refresh.
    if (payload.idp) {
      const identity = await platformDb(this.db)
        .selectFrom('external_identities')
        .select('revoked_before')
        .where('user_id', '=', user.id)
        .where('provider_id', '=', payload.idp)
        .executeTakeFirst();
      // `iat` is whole seconds. A token issued in the very second of the cut-off is ended too: signing in again costs a moment, letting an ended session run for 15 minutes does not.
      const olderThanCutoff = !!identity?.revoked_before && (payload.iat ?? 0) * 1000 <= new Date(identity.revoked_before).getTime();
      if (!identity || olderThanCutoff) throw new UnauthorizedException('You have been signed out. Sign in again.');
    }

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
    // A session that came through a single sign-on provider has no local authenticator: the provider did the multi-factor step.
    const federated = !!payload.idp;
    if (!enrolOnly && !pwresetOnly && !federated && !user.totp_enrolled && !allowEnrol) {
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
      ...(federated ? { idp: payload.idp } : {}),
    };
    return true;
  }
}
