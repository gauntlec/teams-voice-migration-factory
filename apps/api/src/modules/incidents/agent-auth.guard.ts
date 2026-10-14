import { CanActivate, ExecutionContext, ForbiddenException, HttpException, HttpStatus, Injectable, UnauthorizedException } from '@nestjs/common';
import { timingSafeEqual } from 'node:crypto';
import { platformDb } from '@tvmf/db';
import { parseAgentToken } from '@tvmf/shared';
import { sha256 } from '../../common/crypto';
import type { AppRequest } from '../../common/request';
import { InjectDb, type Db } from '../../db/db.module';

/** Requests per token per minute. Plenty for an agent working incidents; stops a loop. */
const RATE_PER_MINUTE = 240;
const windows = new Map<string, { start: number; count: number }>();
const SEEN_EVERY_MS = 60_000;
const lastSeenWrite = new Map<string, number>();

/** Is `ip` one of the allowed addresses or IPv4 ranges? An empty list allows any. */
export function ipAllowed(ip: string | undefined, allow: string[]): boolean {
  if (allow.length === 0) return true;
  if (!ip) return false;
  const addr = ip.replace(/^::ffff:/, '');
  const v4 = (s: string) => {
    const p = s.split('.').map(Number);
    return p.length === 4 && p.every((n) => Number.isInteger(n) && n >= 0 && n <= 255) ? ((p[0]! << 24) | (p[1]! << 16) | (p[2]! << 8) | p[3]!) >>> 0 : null;
  };
  for (const entry of allow) {
    const [base, bits] = entry.split('/');
    if (!bits) {
      if (base!.toLowerCase() === addr.toLowerCase()) return true;
      continue;
    }
    const a = v4(addr);
    const b = v4(base!);
    const n = Number(bits);
    if (a === null || b === null || !Number.isInteger(n) || n < 0 || n > 32) continue;
    const mask = n === 0 ? 0 : (0xffffffff << (32 - n)) >>> 0;
    if ((a & mask) >>> 0 === (b & mask) >>> 0) return true;
  }
  return false;
}

/**
 * Authenticates an AI agent by its bearer token (vxs_agent_<id>_<secret>): the secret is checked against its
 * stored hash, and the token must be unrevoked and unexpired, its agent active (a paused agent can read, not write),
 * the kill switch off, the source address allowed, and the rate limit not exceeded. Agent routes are @Public() as
 * far as the person-login guard is concerned and use this one instead. Nothing here can reach a person's endpoints.
 */
@Injectable()
export class AgentAuthGuard implements CanActivate {
  constructor(@InjectDb() private readonly db: Db) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest<AppRequest>();
    const [scheme, raw] = (req.headers.authorization ?? '').split(' ');
    const parsed = scheme === 'Bearer' && raw ? parseAgentToken(raw) : null;
    if (!parsed) throw new UnauthorizedException('Send an agent token: Authorization: Bearer vxs_agent_…');
    const p = platformDb(this.db);
    const row = await p
      .selectFrom('agent_tokens as t')
      .innerJoin('agents as a', 'a.id', 't.agent_id')
      .select(['t.id as token_id', 't.secret_hash as secret_hash', 't.scopes as scopes', 't.ip_allow as ip_allow', 't.expires_at as expires_at', 't.revoked_at as revoked_at', 'a.id as agent_id', 'a.name as name', 'a.kind as kind', 'a.status as status'])
      .where('t.id', '=', parsed.tokenId)
      .executeTakeFirst();
    const given = Buffer.from(sha256(parsed.secret), 'hex');
    const stored = Buffer.from(row?.secret_hash ?? '', 'hex');
    if (!row || given.length !== stored.length || !timingSafeEqual(given, stored)) throw new UnauthorizedException('That agent token is not valid.');
    if (row.revoked_at) throw new UnauthorizedException('That agent token has been revoked.');
    if (row.expires_at && new Date(row.expires_at).getTime() < Date.now()) throw new UnauthorizedException('That agent token has expired.');
    if (row.status === 'disabled') throw new ForbiddenException('This agent is disabled.');
    if (row.status === 'paused' && req.method !== 'GET') throw new ForbiddenException('This agent is paused: it can read, but not change anything.');
    const kill = await p.selectFrom('agent_kill_switch').select(['all_disabled', 'note']).where('id', '=', 1).executeTakeFirst();
    if (kill?.all_disabled) throw new ForbiddenException(`Assistants are switched off${kill.note ? `: ${kill.note}` : '.'}`);
    if (!ipAllowed(req.ip, row.ip_allow)) throw new ForbiddenException('This token cannot be used from this address.');

    const now = Date.now();
    const w = windows.get(row.token_id);
    if (!w || now - w.start > 60_000) windows.set(row.token_id, { start: now, count: 1 });
    else if (++w.count > RATE_PER_MINUTE) throw new HttpException('Too many requests. Slow down.', HttpStatus.TOO_MANY_REQUESTS);

    if (now - (lastSeenWrite.get(row.token_id) ?? 0) > SEEN_EVERY_MS) {
      lastSeenWrite.set(row.token_id, now);
      const at = new Date(now).toISOString();
      void p.updateTable('agent_tokens').set({ last_used_at: at }).where('id', '=', row.token_id).execute().catch(() => undefined);
      void p.updateTable('agents').set({ last_seen_at: at }).where('id', '=', row.agent_id).execute().catch(() => undefined);
    }
    req.agent = { agentId: row.agent_id, tokenId: row.token_id, name: row.name, kind: row.kind, scopes: row.scopes };
    return true;
  }
}
