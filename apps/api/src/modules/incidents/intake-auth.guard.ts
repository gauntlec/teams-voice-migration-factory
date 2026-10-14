import { CanActivate, ExecutionContext, ForbiddenException, HttpException, HttpStatus, Injectable, UnauthorizedException } from '@nestjs/common';
import { timingSafeEqual } from 'node:crypto';
import { platformDb } from '@tvmf/db';
import { parseIntakeToken, type IntakeConfig } from '@tvmf/shared';
import { sha256 } from '../../common/crypto';
import type { AppRequest } from '../../common/request';
import { InjectDb, type Db } from '../../db/db.module';
import { ipAllowed } from './agent-auth.guard';

/** Alerts per source per minute: a flapping tool is slowed, not trusted. */
const RATE_PER_MINUTE = 120;
const windows = new Map<string, { start: number; count: number }>();

/**
 * Authenticates a monitoring alert source by its bearer token (vxs_intake_<source id>_<secret>): the secret is checked against its
 * stored hash, the source must be enabled, its customer active with Managed Services on, the source address allowed, and the rate
 * limit not exceeded. Intake routes are @Public() as far as the person-login guard is concerned. The token can only post alerts for
 * its own customer: it reaches nothing else.
 */
@Injectable()
export class IntakeAuthGuard implements CanActivate {
  constructor(@InjectDb() private readonly db: Db) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest<AppRequest>();
    const [scheme, raw] = (req.headers.authorization ?? '').split(' ');
    const parsed = scheme === 'Bearer' && raw ? parseIntakeToken(raw) : null;
    if (!parsed) throw new UnauthorizedException('Send an intake token: Authorization: Bearer vxs_intake_…');
    const p = platformDb(this.db);
    const row = await p
      .selectFrom('intake_sources as s')
      .innerJoin('tenants as t', 't.id', 's.tenant_id')
      .select(['s.id as id', 's.tenant_id as tenant_id', 's.name as name', 's.kind as kind', 's.config as config', 's.secret_hash as secret_hash', 's.ip_allow as ip_allow', 's.enabled as enabled', 't.status as tenant_status', 't.managed_services_enabled as managed'])
      .where('s.id', '=', parsed.sourceId)
      .executeTakeFirst();
    const given = Buffer.from(sha256(parsed.secret), 'hex');
    const stored = Buffer.from(row?.secret_hash ?? '', 'hex');
    if (!row || given.length !== stored.length || !timingSafeEqual(given, stored)) throw new UnauthorizedException('That intake token is not valid.');
    if (!row.enabled) throw new ForbiddenException('This alert source is switched off.');
    if (row.tenant_status !== 'active' || !row.managed) throw new ForbiddenException('Incidents are not switched on for this customer.');
    if (!ipAllowed(req.ip, row.ip_allow)) throw new ForbiddenException('This token cannot be used from this address.');
    const now = Date.now();
    const w = windows.get(row.id);
    if (!w || now - w.start > 60_000) windows.set(row.id, { start: now, count: 1 });
    else if (++w.count > RATE_PER_MINUTE) throw new HttpException('Too many alerts. Slow down.', HttpStatus.TOO_MANY_REQUESTS);
    req.intake = { sourceId: row.id, tenantId: row.tenant_id, name: row.name, kind: row.kind, config: (row.config ?? {}) as IntakeConfig };
    return true;
  }
}
