import { ConflictException, Injectable } from '@nestjs/common';
import { sql } from 'kysely';
import { platformDb, tenantDb } from '@tvmf/db';
import { AGENT_CLAIM_MAX_SECONDS, INC_OPEN_STATUSES, agentLabel, incReference } from '@tvmf/shared';
import type { AuthedUser, TenantContext } from '../../common/request';
import { InjectDb, type Db } from '../../db/db.module';
import { actorCols } from './agent-actor';
import { AgentEventsService } from './agent-events.service';
import { IncidentNotifier } from './incident-notifier';

interface ClaimIncident {
  id: string;
  number: number;
  title: string;
  category: string;
  subcategory: string | null;
  priority: import('@tvmf/shared').IncPriority;
  status: import('@tvmf/shared').IncStatus;
  version: number;
  assigned_to: string | null;
  assigned_agent_id: string | null;
  reporter_id: string;
  agent_hold: boolean;
}

/**
 * Claims: whoever works an incident holds a short lease and renews it while they work. A person
 * taking over (or assigning it elsewhere) revokes an agent's claim; a lease that lapses puts the
 * incident back in the queue. An agent can only claim an incident nobody else has: unassigned, or
 * assigned to it, and not taken over by a person. See docs/INCIDENT-MANAGEMENT.md, section 7.
 */
@Injectable()
export class IncidentClaimsService {
  constructor(
    @InjectDb() private readonly db: Db,
    private readonly events: AgentEventsService,
    private readonly notify: IncidentNotifier,
  ) {}

  /** The live claim, if any - an expired lease counts as no claim. */
  async current(t: TenantContext, incidentId: string) {
    const c = await tenantDb(this.db, t.schema).selectFrom('incident_claims').selectAll().where('incident_id', '=', incidentId).where('released_at', 'is', null).where('expires_at', '>', new Date().toISOString()).executeTakeFirst();
    if (!c) return null;
    const a = await platformDb(this.db).selectFrom('agents').select(['id', 'name', 'kind']).where('id', '=', c.agent_id).executeTakeFirst();
    return { ...c, agent_name: a?.name ?? 'Unknown agent', agent_kind: a?.kind ?? 'general' };
  }

  /** Takes (or renews) the lease. */
  async claim(t: TenantContext, agent: { id: string; name: string }, inc: ClaimIncident, ttlSeconds: number, note: string) {
    if (!INC_OPEN_STATUSES.includes(inc.status)) throw new ConflictException('This incident is finished; there is nothing to claim.');
    if (inc.agent_hold) throw new ConflictException('A person has taken this incident over. It has to be handed back before an assistant can work it.');
    if (inc.assigned_to) throw new ConflictException('A person is working this incident. You can add notes and proposals, but not claim it.');
    if (inc.assigned_agent_id && inc.assigned_agent_id !== agent.id) throw new ConflictException('Another assistant is assigned to this incident.');
    const s = tenantDb(this.db, t.schema);
    const now = new Date();
    const expires = new Date(now.getTime() + Math.min(ttlSeconds, AGENT_CLAIM_MAX_SECONDS) * 1000).toISOString();
    const live = await this.current(t, inc.id);
    if (live) {
      if (live.agent_id !== agent.id) throw new ConflictException(`${agentLabel(live.agent_name)} is working this incident until ${live.expires_at}.`);
      const renewed = await s.updateTable('incident_claims').set({ expires_at: expires, ...(note ? { note } : {}) }).where('id', '=', live.id).returning(['id', 'expires_at']).executeTakeFirstOrThrow();
      return { id: renewed.id, expires_at: renewed.expires_at, renewed: true };
    }
    try {
      const claim = await this.db.transaction().execute(async (trx) => {
        const x = tenantDb(trx, t.schema);
        // A lapsed lease no longer blocks the next claimer.
        await x.updateTable('incident_claims').set({ released_at: now.toISOString(), release_reason: 'expired' }).where('incident_id', '=', inc.id).where('released_at', 'is', null).execute();
        const c = await x.insertInto('incident_claims').values({ incident_id: inc.id, agent_id: agent.id, note, expires_at: expires }).returning(['id', 'expires_at']).executeTakeFirstOrThrow();
        await x
          .updateTable('incidents')
          .set({ assigned_agent_id: agent.id, updated_at: now.toISOString(), version: sql`version + 1` })
          .where('id', '=', inc.id)
          .execute();
        await x.insertInto('incident_events').values({ incident_id: inc.id, kind: 'claim_started', body: note || `${agentLabel(agent.name)} started working on this.`, internal: true, author_id: agent.id, actor_type: 'agent' }).execute();
        return c;
      });
      return { id: claim.id, expires_at: claim.expires_at, renewed: false };
    } catch (e) {
      if ((e as { code?: string }).code === '23505') throw new ConflictException('Someone else just claimed this incident.');
      throw e;
    }
  }

  /** The agent must hold a live lease to change an incident's state. */
  async requireHeld(t: TenantContext, incidentId: string, agentId: string) {
    const c = await this.current(t, incidentId);
    if (!c || c.agent_id !== agentId) {
      throw new ConflictException(c ? `${agentLabel(c.agent_name)} holds this incident.` : 'Claim this incident before changing it (POST .../claim), and renew the lease while you work.');
    }
    return c;
  }

  async heartbeat(t: TenantContext, incidentId: string, agentId: string, ttlSeconds: number) {
    const c = await tenantDb(this.db, t.schema).selectFrom('incident_claims').selectAll().where('incident_id', '=', incidentId).where('agent_id', '=', agentId).where('released_at', 'is', null).executeTakeFirst();
    if (!c || new Date(c.expires_at).getTime() <= Date.now()) throw new ConflictException('Your lease has lapsed. Claim the incident again.');
    const expires = new Date(Date.now() + Math.min(ttlSeconds, AGENT_CLAIM_MAX_SECONDS) * 1000).toISOString();
    await tenantDb(this.db, t.schema).updateTable('incident_claims').set({ expires_at: expires }).where('id', '=', c.id).execute();
    return { id: c.id, expires_at: expires };
  }

  /** The agent lets go (it is finished, or is handing the incident on). */
  async release(t: TenantContext, incidentId: string, agentId: string, reason: 'released' | 'handed_off' = 'released') {
    const s = tenantDb(this.db, t.schema);
    const c = await s.updateTable('incident_claims').set({ released_at: new Date().toISOString(), release_reason: reason }).where('incident_id', '=', incidentId).where('agent_id', '=', agentId).where('released_at', 'is', null).returning('id').executeTakeFirst();
    return !!c;
  }

  /**
   * A person (or an assignment elsewhere) ends an agent's lease. The agent hears of it, and its
   * writes are refused. `hold` is true when a person takes the incident over, which keeps agents
   * from writing until it is handed back.
   */
  async revoke(t: TenantContext, inc: ClaimIncident, by: AuthedUser, opts: { hold: boolean }) {
    const s = tenantDb(this.db, t.schema);
    const live = await s.selectFrom('incident_claims').selectAll().where('incident_id', '=', inc.id).where('released_at', 'is', null).executeTakeFirst();
    const agentId = live?.agent_id ?? inc.assigned_agent_id;
    if (live) await s.updateTable('incident_claims').set({ released_at: new Date().toISOString(), release_reason: 'revoked' }).where('id', '=', live.id).execute();
    if (!agentId) return null;
    const a = await platformDb(this.db).selectFrom('agents').select(['id', 'name']).where('id', '=', agentId).executeTakeFirst();
    await s
      .insertInto('incident_events')
      .values({ incident_id: inc.id, kind: 'claim_released', body: `${by.displayName} took over from ${agentLabel(a?.name ?? 'an assistant')}.`, internal: true, ...actorCols(by), meta: JSON.stringify({ agentId, hold: opts.hold }) })
      .execute();
    await this.events.emit(t.id, inc, 'claim.revoked', { by: by.displayName, hold: opts.hold }, agentId);
    return agentId;
  }

  /**
   * The agent has stopped (its lease lapsed, or it failed twice): the incident goes back to the
   * unassigned queue and the team is told.
   */
  async lapse(t: TenantContext, inc: ClaimIncident, agent: { id: string; name: string }, why: string) {
    const s = tenantDb(this.db, t.schema);
    await s.updateTable('incident_claims').set({ released_at: new Date().toISOString(), release_reason: 'expired' }).where('incident_id', '=', inc.id).where('agent_id', '=', agent.id).where('released_at', 'is', null).execute();
    await s
      .updateTable('incidents')
      .set({ assigned_agent_id: null, updated_at: new Date().toISOString(), version: sql`version + 1` })
      .where('id', '=', inc.id)
      .where('assigned_agent_id', '=', agent.id)
      .execute();
    await s.insertInto('incident_events').values({ incident_id: inc.id, kind: 'claim_released', body: `${agentLabel(agent.name)} stopped working on this (${why}). It is back in the queue.`, internal: true, author_id: agent.id, actor_type: 'agent', meta: JSON.stringify({ agentId: agent.id, lapsed: true }) }).execute();
    await this.events.emit(t.id, inc, 'claim.expired', { why }, agent.id);
    await this.notify.agentLapsed(t, inc, agent.name, why);
  }
}
