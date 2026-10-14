import { ConflictException, Injectable } from '@nestjs/common';
import { platformDb, tenantDb } from '@tvmf/db';
import { AGENT_CLAIM_MAX_SECONDS, SR_OPEN_STATUSES, agentLabel, type SrStatus } from '@tvmf/shared';
import type { AuthedUser, TenantContext } from '../../common/request';
import { InjectDb, type Db } from '../../db/db.module';
import { AgentEventsService } from '../incidents/agent-events.service';

export interface ClaimRequest {
  id: string;
  number: number;
  type: string;
  priority: string;
  status: SrStatus;
  assigned_to: string | null;
  assigned_agent_id: string | null;
  agent_hold: boolean;
}

/**
 * Claims on service requests, the same idea as on incidents (docs/AGENTS.md): whoever works a request holds a short
 * lease and renews it while they work. A person taking over revokes an assistant's lease; a lease that lapses puts the
 * request back in the queue.
 */
@Injectable()
export class SrClaimsService {
  constructor(
    @InjectDb() private readonly db: Db,
    private readonly events: AgentEventsService,
  ) {}

  /** The live claim, if any - an expired lease counts as no claim. */
  async current(t: TenantContext, requestId: string) {
    const c = await tenantDb(this.db, t.schema).selectFrom('service_request_claims').selectAll().where('request_id', '=', requestId).where('released_at', 'is', null).where('expires_at', '>', new Date().toISOString()).executeTakeFirst();
    if (!c) return null;
    const a = await platformDb(this.db).selectFrom('agents').select(['id', 'name', 'kind']).where('id', '=', c.agent_id).executeTakeFirst();
    return { ...c, agent_name: a?.name ?? 'Unknown agent', agent_kind: a?.kind ?? 'general' };
  }

  async claim(t: TenantContext, agent: { id: string; name: string }, req: ClaimRequest, ttlSeconds: number, note: string) {
    if (!SR_OPEN_STATUSES.includes(req.status)) throw new ConflictException('This request is finished; there is nothing to claim.');
    if (req.agent_hold) throw new ConflictException('A person has taken this request over. It has to be handed back before an assistant can work it.');
    if (req.assigned_to) throw new ConflictException('A person is working this request. You can add notes and proposals, but not claim it.');
    if (req.assigned_agent_id && req.assigned_agent_id !== agent.id) throw new ConflictException('Another assistant is assigned to this request.');
    const s = tenantDb(this.db, t.schema);
    const now = new Date();
    const expires = new Date(now.getTime() + Math.min(ttlSeconds, AGENT_CLAIM_MAX_SECONDS) * 1000).toISOString();
    const live = await this.current(t, req.id);
    if (live) {
      if (live.agent_id !== agent.id) throw new ConflictException(`${agentLabel(live.agent_name)} is working this request until ${live.expires_at}.`);
      const renewed = await s.updateTable('service_request_claims').set({ expires_at: expires, ...(note ? { note } : {}) }).where('id', '=', live.id).returning(['id', 'expires_at']).executeTakeFirstOrThrow();
      return { id: renewed.id, expires_at: renewed.expires_at, renewed: true };
    }
    try {
      const claim = await this.db.transaction().execute(async (trx) => {
        const x = tenantDb(trx, t.schema);
        await x.updateTable('service_request_claims').set({ released_at: now.toISOString(), release_reason: 'expired' }).where('request_id', '=', req.id).where('released_at', 'is', null).execute();
        const c = await x.insertInto('service_request_claims').values({ request_id: req.id, agent_id: agent.id, note, expires_at: expires }).returning(['id', 'expires_at']).executeTakeFirstOrThrow();
        await x.updateTable('service_requests').set({ assigned_agent_id: agent.id, updated_at: now.toISOString() }).where('id', '=', req.id).execute();
        await x
          .insertInto('service_request_events')
          .values({ request_id: req.id, kind: 'claim_started', body: note || `${agentLabel(agent.name)} started working on this.`, internal: true, author_id: agent.id, actor_type: 'agent' })
          .execute();
        return c;
      });
      return { id: claim.id, expires_at: claim.expires_at, renewed: false };
    } catch (e) {
      if ((e as { code?: string }).code === '23505') throw new ConflictException('Someone else just claimed this request.');
      throw e;
    }
  }

  /** The agent must hold a live lease to change a request. */
  async requireHeld(t: TenantContext, requestId: string, agentId: string) {
    const c = await this.current(t, requestId);
    if (!c || c.agent_id !== agentId) {
      throw new ConflictException(c ? `${agentLabel(c.agent_name)} holds this request.` : 'Claim this request before changing it (POST .../claim), and renew the lease while you work.');
    }
    return c;
  }

  async heartbeat(t: TenantContext, requestId: string, agentId: string, ttlSeconds: number) {
    const s = tenantDb(this.db, t.schema);
    const c = await s.selectFrom('service_request_claims').selectAll().where('request_id', '=', requestId).where('agent_id', '=', agentId).where('released_at', 'is', null).executeTakeFirst();
    if (!c || new Date(c.expires_at).getTime() <= Date.now()) throw new ConflictException('Your lease has lapsed. Claim the request again.');
    const expires = new Date(Date.now() + Math.min(ttlSeconds, AGENT_CLAIM_MAX_SECONDS) * 1000).toISOString();
    await s.updateTable('service_request_claims').set({ expires_at: expires }).where('id', '=', c.id).execute();
    return { id: c.id, expires_at: expires };
  }

  /** The agent lets go: the request is nobody's again. */
  async release(t: TenantContext, requestId: string, agentId: string, reason: 'released' | 'handed_off' = 'released') {
    const s = tenantDb(this.db, t.schema);
    const c = await s.updateTable('service_request_claims').set({ released_at: new Date().toISOString(), release_reason: reason }).where('request_id', '=', requestId).where('agent_id', '=', agentId).where('released_at', 'is', null).returning('id').executeTakeFirst();
    await s.updateTable('service_requests').set({ assigned_agent_id: null, updated_at: new Date().toISOString() }).where('id', '=', requestId).where('assigned_agent_id', '=', agentId).execute();
    return !!c;
  }

  /** A person (or an assignment elsewhere) ends an assistant's lease. `hold` is true when a person takes the request over. */
  async revoke(t: TenantContext, req: ClaimRequest, by: AuthedUser, opts: { hold: boolean }) {
    const s = tenantDb(this.db, t.schema);
    const live = await s.selectFrom('service_request_claims').selectAll().where('request_id', '=', req.id).where('released_at', 'is', null).executeTakeFirst();
    const agentId = live?.agent_id ?? req.assigned_agent_id;
    if (live) await s.updateTable('service_request_claims').set({ released_at: new Date().toISOString(), release_reason: 'revoked' }).where('id', '=', live.id).execute();
    if (!agentId) return null;
    const a = await platformDb(this.db).selectFrom('agents').select(['id', 'name']).where('id', '=', agentId).executeTakeFirst();
    await s
      .insertInto('service_request_events')
      .values({ request_id: req.id, kind: 'claim_released', body: `${by.displayName} took over from ${agentLabel(a?.name ?? 'an assistant')}.`, internal: true, author_id: by.id, actor_type: 'user', meta: JSON.stringify({ agentId, hold: opts.hold }) })
      .execute();
    await this.events.emitRequest(t.id, req, 'sr.claim.revoked', { by: by.displayName, hold: opts.hold }, agentId);
    return agentId;
  }

  /** The assistant has stopped (lapsed, or failed twice): the request goes back in the queue. The caller tells the team. */
  async lapse(t: TenantContext, req: ClaimRequest, agent: { id: string; name: string }, why: string) {
    const s = tenantDb(this.db, t.schema);
    await s.updateTable('service_request_claims').set({ released_at: new Date().toISOString(), release_reason: 'expired' }).where('request_id', '=', req.id).where('agent_id', '=', agent.id).where('released_at', 'is', null).execute();
    await s.updateTable('service_requests').set({ assigned_agent_id: null, updated_at: new Date().toISOString() }).where('id', '=', req.id).where('assigned_agent_id', '=', agent.id).execute();
    await s
      .insertInto('service_request_events')
      .values({ request_id: req.id, kind: 'claim_released', body: `${agentLabel(agent.name)} stopped working on this (${why}). It is back in the queue.`, internal: true, author_id: agent.id, actor_type: 'agent', meta: JSON.stringify({ why }) })
      .execute();
    await this.events.emitRequest(t.id, req, 'sr.claim.expired', { why }, agent.id);
  }
}

