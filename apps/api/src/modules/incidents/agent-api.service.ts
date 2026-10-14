import { ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { platformDb, tenantDb, tenantSchemaName } from '@tvmf/db';
import {
  INC_LIVE_STATUSES,
  INC_OPEN_STATUSES,
  agentEffectiveAutonomy,
  agentLabel,
  agentLevel,
  agentMayExecuteApproved,
  agentMayActDirectly,
  agentMayNote,
  agentProposalClass,
  incCategoryLabel,
  incNextClock,
  incReference,
  incSlaFor,
  type AgentActionClass,
  type AgentAutonomy,
  type AgentClaimInput,
  type AgentDiagnosticInput,
  type AgentEventsQuery,
  type AgentHandoffInput,
  type AgentHeartbeatInput,
  type AgentIncidentsQuery,
  type AgentLinkItemInput,
  type AgentNoteInput,
  type AgentPriorityInput,
  type AgentProposalInput,
  type AgentProposalResultInput,
  type AgentScope,
  type AgentStatusInput,
  type IncSettings,
  type IncStatus,
} from '@tvmf/shared';
import type { AgentPrincipal, TenantContext } from '../../common/request';
import { InjectDb, type Db } from '../../db/db.module';
import { agentActor } from './agent-actor';
import { AgentEventsService } from './agent-events.service';
import { IncidentProposalsService } from './agent-proposals.service';
import { IncidentClaimsService } from './incident-claims.service';
import { IncidentDiagnosticsService } from './incident-diagnostics.service';
import { IncidentKnowledgeService } from './incident-knowledge.service';
import { IncidentNotifier } from './incident-notifier';
import { IncidentsService } from './incidents.service';
import { ProblemsService } from './problems.service';

/** The name and id the incident services want for an agent. */
const ref = (a: AgentPrincipal) => ({ id: a.agentId, name: a.name });

const FINISHED: readonly IncStatus[] = ['resolved', 'closed', 'cancelled', 'duplicate'];

/**
 * What an AI agent can do (docs/AGENTS.md). Every call is checked against the token's scope, the customer
 * policy (the customer must allow the agent, and the action class's autonomy level must allow the call), and
 * the incident: a person who took it over locks the agent out of writing, a state-changing call needs the
 * agent's lease on the incident, and a stale `expectedVersion` is refused. Writes with an Idempotency-Key
 * happen once. Direct changes need "act alone"; below that an agent proposes and a person decides.
 */
@Injectable()
export class AgentApiService {
  constructor(
    @InjectDb() private readonly db: Db,
    private readonly incidents: IncidentsService,
    private readonly claims: IncidentClaimsService,
    private readonly proposals: IncidentProposalsService,
    private readonly events: AgentEventsService,
    private readonly problems: ProblemsService,
    private readonly notify: IncidentNotifier,
    private readonly diagnostics: IncidentDiagnosticsService,
    private readonly knowledge: IncidentKnowledgeService,
  ) {}

  /* ------------------------------ checks ------------------------------ */

  private scope(agent: AgentPrincipal, s: AgentScope) {
    if (!agent.scopes.includes(s)) throw new ForbiddenException(`This token can't do that (it needs the "${s}" scope).`);
  }

  /** The customer, if this agent is allowed on it. */
  private async tenantFor(agent: AgentPrincipal, tenantId: string): Promise<{ t: TenantContext; autonomy: AgentAutonomy }> {
    const p = platformDb(this.db);
    const row = await p
      .selectFrom('tenants as t')
      .leftJoin('agent_customer_policy as cp', (j) => j.onRef('cp.tenant_id', '=', 't.id').on('cp.agent_id', '=', agent.agentId))
      .select(['t.id as id', 't.slug as slug', 't.name as name', 't.schema_name as schema_name', 't.status as status', 't.teams_read_only as teams_read_only', 't.managed_services_enabled as managed', 't.agents_enabled as agents_enabled', 'cp.enabled as enabled', 'cp.autonomy as autonomy'])
      .where('t.id', '=', tenantId)
      .executeTakeFirst();
    if (!row || row.status !== 'active' || row.enabled === null || !row.managed) throw new NotFoundException('customer not found');
    if (!row.enabled) throw new ForbiddenException('This agent is not allowed on that customer.');
    if (!row.agents_enabled) throw new ForbiddenException('Assistants are switched off for that customer.');
    return {
      t: { id: row.id, slug: row.slug, name: row.name, schema: row.schema_name || tenantSchemaName(row.id), siteScope: null, teamsReadOnly: row.teams_read_only, managedServices: true },
      autonomy: (row.autonomy ?? {}) as AgentAutonomy,
    };
  }

  private async load(t: TenantContext, id: string) {
    const row = await tenantDb(this.db, t.schema).selectFrom('incidents').selectAll().where('id', '=', id).executeTakeFirst();
    if (!row) throw new NotFoundException('incident not found');
    return row;
  }

  private writable(row: { agent_hold: boolean; status: IncStatus }) {
    if (row.agent_hold) throw new ConflictException({ message: 'A person has taken this incident over. You can read it, but not change it, until it is handed back.', code: 'taken_over' });
  }

  private version(row: { version: number }, expected: number | undefined) {
    if (expected !== undefined && expected !== row.version) throw new ConflictException({ message: 'The incident has changed since you read it. Read it again and decide again.', code: 'stale', currentVersion: row.version });
  }

  /** Direct changes need "act alone" for the action class; otherwise the call tells the agent to propose instead. */
  private direct(autonomy: AgentAutonomy, cls: AgentActionClass) {
    const level = agentLevel(autonomy, cls);
    if (!agentMayActDirectly(level)) {
      throw new ForbiddenException({ message: `Your autonomy for "${cls}" on this customer is ${level}, below "act alone" (3). Propose it instead (POST .../proposals) and a person will decide.`, code: 'propose_instead' });
    }
  }

  /** The same Idempotency-Key from the same agent does the thing once and returns the same answer. */
  private async once<T>(agentId: string, key: string | undefined, fn: () => Promise<T>): Promise<T> {
    if (!key) return fn();
    const p = platformDb(this.db);
    const inserted = await p.insertInto('agent_requests').values({ agent_id: agentId, idem_key: key.slice(0, 200) }).onConflict((oc) => oc.columns(['agent_id', 'idem_key']).doNothing()).returning('idem_key').executeTakeFirst();
    if (!inserted) {
      const prior = await p.selectFrom('agent_requests').select(['status', 'response']).where('agent_id', '=', agentId).where('idem_key', '=', key.slice(0, 200)).executeTakeFirst();
      if (prior?.status === 'done') return prior.response as T;
      throw new ConflictException({ message: 'A request with this Idempotency-Key is still running.', code: 'in_flight' });
    }
    try {
      const result = await fn();
      await p.updateTable('agent_requests').set({ status: 'done', response: JSON.stringify(result ?? {}) }).where('agent_id', '=', agentId).where('idem_key', '=', key.slice(0, 200)).execute();
      return result;
    } catch (e) {
      // A failed attempt can be retried with the same key.
      await p.deleteFrom('agent_requests').where('agent_id', '=', agentId).where('idem_key', '=', key.slice(0, 200)).execute();
      throw e;
    }
  }

  /* ------------------------------ reading ------------------------------ */

  /** Incidents across the customers this agent may work, most urgent first. */
  async list(agent: AgentPrincipal, q: AgentIncidentsQuery) {
    this.scope(agent, 'read');
    const p = platformDb(this.db);
    let tq = p
      .selectFrom('tenants as t')
      .innerJoin('agent_customer_policy as cp', (j) => j.onRef('cp.tenant_id', '=', 't.id').on('cp.agent_id', '=', agent.agentId).on('cp.enabled', '=', true))
      .select(['t.id as id', 't.name as name', 't.schema_name as schema', 't.inc_settings as inc_settings'])
      .where('t.status', '=', 'active')
      .where('t.managed_services_enabled', '=', true)
      .where('t.agents_enabled', '=', true);
    if (q.tenantId) tq = tq.where('t.id', '=', q.tenantId);
    const tenants = await tq.execute();
    const now = Date.now();
    const all = await Promise.all(
      tenants.map(async (t) => {
        let iq = tenantDb(this.db, t.schema)
          .selectFrom('incidents as i')
          .leftJoin('discovery_sites as ds', 'ds.id', 'i.site_id')
          .select([
            'i.id as id', 'i.number as number', 'i.title as title', 'i.category as category', 'i.subcategory as subcategory', 'i.priority as priority', 'i.status as status', 'i.hold_reason as hold_reason',
            'ds.sitecode as sitecode', 'i.assigned_to as assigned_to', 'i.assigned_agent_id as assigned_agent_id', 'i.agent_hold as agent_hold', 'i.version as version', 'i.major as major', 'i.major_ended_at as major_ended_at',
            'i.created_at as created_at', 'i.updated_at as updated_at', 'i.acknowledged_at as acknowledged_at', 'i.restored_at as restored_at', 'i.resolved_at as resolved_at', 'i.reopened_at as reopened_at',
            'i.paused_since as paused_since', 'i.paused_seconds as paused_seconds', 'i.pause_log as pause_log',
          ])
          .orderBy('i.created_at')
          .limit(q.limit);
        if (q.status === 'open') iq = iq.where('i.status', 'in', [...INC_LIVE_STATUSES]);
        else if (q.status !== 'all') iq = iq.where('i.status', '=', q.status as IncStatus);
        if (q.assigned === 'me') iq = iq.where('i.assigned_agent_id', '=', agent.agentId);
        if (q.assigned === 'unassigned') iq = iq.where('i.assigned_to', 'is', null).where('i.assigned_agent_id', 'is', null);
        const rows = await iq.execute();
        const settings = (t.inc_settings ?? {}) as IncSettings;
        return rows.map((r) => ({
          tenant_id: t.id,
          tenant_name: t.name,
          id: r.id,
          reference: incReference(r.number),
          title: r.title,
          category: r.category,
          category_label: incCategoryLabel(r.category, r.subcategory),
          priority: r.priority,
          status: r.status,
          hold_reason: r.hold_reason,
          sitecode: r.sitecode,
          assigned: r.assigned_agent_id === agent.agentId ? 'me' : r.assigned_agent_id ? 'another_assistant' : r.assigned_to ? 'person' : 'nobody',
          taken_over: r.agent_hold,
          major: r.major && !r.major_ended_at,
          version: r.version,
          next_target: incNextClock(incSlaFor(r, settings, now)),
          created_at: r.created_at,
          updated_at: r.updated_at,
        }));
      }),
    );
    const rank = { p1: 0, p2: 1, p3: 2, p4: 3 } as const;
    return all.flat().sort((a, b) => rank[a.priority] - rank[b.priority] || String(a.created_at).localeCompare(String(b.created_at))).slice(0, q.limit);
  }

  /** Everything an agent needs to work an incident: the record, its full timeline (internal notes too), known errors, similar incidents, the claim, proposals and its own autonomy. */
  async get(agent: AgentPrincipal, tenantId: string, id: string) {
    this.scope(agent, 'read');
    const { t, autonomy } = await this.tenantFor(agent, tenantId);
    const base = await this.incidents.get(t, id, true, agent.agentId);
    const inc = base.incident;
    const [known, similar] = await Promise.all([
      this.problems.knownErrors(t, { category: inc.category, subcategory: inc.subcategory ?? undefined }, true),
      tenantDb(this.db, t.schema)
        .selectFrom('incidents as i')
        .leftJoin('discovery_sites as ds', 'ds.id', 'i.site_id')
        .select(['i.id as id', 'i.number as number', 'i.title as title', 'i.status as status', 'i.priority as priority', 'i.created_at as created_at', 'ds.sitecode as sitecode'])
        .where('i.category', '=', inc.category)
        .where('i.id', '!=', id)
        .where('i.status', 'in', [...INC_OPEN_STATUSES])
        .where((eb) => (inc.site_id ? eb.or([eb('i.site_id', '=', inc.site_id), eb('i.site_id', 'is', null)]) : eb.val(true)))
        .orderBy('i.number', 'desc')
        .limit(5)
        .execute(),
    ]);
    return {
      tenant: { id: t.id, name: t.name },
      ...base,
      knownErrors: known,
      diagnostics: await this.diagnostics.list(t, id, 10),
      suggestedChecks: await this.diagnostics.suggest(t, id),
      knowledge: await this.knowledge.matchIncident(t, id, 3),
      similar: similar.map((s) => ({ ...s, reference: incReference(s.number) })),
      autonomy: agentEffectiveAutonomy(autonomy),
    };
  }

  async feed(agent: AgentPrincipal, q: AgentEventsQuery) {
    this.scope(agent, 'read');
    return this.events.list(agent.agentId, q.after, q.limit);
  }

  /* ------------------------------ working an incident ------------------------------ */

  async claim(agent: AgentPrincipal, tenantId: string, id: string, input: AgentClaimInput, key?: string) {
    this.scope(agent, 'note');
    const { t, autonomy } = await this.tenantFor(agent, tenantId);
    if (agentLevel(autonomy, 'triage') < 1) throw new ForbiddenException('Your autonomy for "triage" on this customer is "observe", so you cannot take an incident on.');
    return this.once(agent.agentId, key, async () => {
      const row = await this.load(t, id);
      return this.claims.claim(t, ref(agent), row, input.ttlSeconds, input.note ?? '');
    });
  }

  async heartbeat(agent: AgentPrincipal, tenantId: string, id: string, input: AgentHeartbeatInput) {
    this.scope(agent, 'note');
    const { t } = await this.tenantFor(agent, tenantId);
    return this.claims.heartbeat(t, id, agent.agentId, input.ttlSeconds);
  }

  async release(agent: AgentPrincipal, tenantId: string, id: string) {
    this.scope(agent, 'note');
    const { t } = await this.tenantFor(agent, tenantId);
    const released = await this.claims.release(t, id, agent.agentId);
    // Letting go means the incident is nobody's again, not an assistant's that is no longer working it.
    const row = await tenantDb(this.db, t.schema).selectFrom('incidents').select(['id', 'version', 'assigned_agent_id']).where('id', '=', id).executeTakeFirst();
    if (row?.assigned_agent_id === agent.agentId) {
      await tenantDb(this.db, t.schema).updateTable('incidents').set({ assigned_agent_id: null, updated_at: new Date().toISOString(), version: row.version + 1 }).where('id', '=', id).where('assigned_agent_id', '=', agent.agentId).execute();
      await this.events.emit(t.id, await this.load(t, id), 'incident.updated', { change: 'released', by: 'agent' });
    }
    return { released };
  }

  async note(agent: AgentPrincipal, tenantId: string, id: string, input: AgentNoteInput, key?: string) {
    this.scope(agent, 'note');
    const { t, autonomy } = await this.tenantFor(agent, tenantId);
    if (!agentMayNote(agentLevel(autonomy, 'internal_note'))) throw new ForbiddenException('Your autonomy for "internal_note" on this customer is "observe".');
    return this.once(agent.agentId, key, async () => {
      const row = await this.load(t, id);
      this.writable(row);
      this.version(row, input.expectedVersion);
      const e = await this.incidents.comment(t, agentActor(ref(agent)), id, { body: input.body, internal: true }, true);
      return { id: e.id, version: row.version + 1 };
    });
  }

  /** Acknowledge, hold, restore, resolve ...: "act alone" and the agent's lease needed. */
  async status(agent: AgentPrincipal, tenantId: string, id: string, input: AgentStatusInput, key?: string) {
    this.scope(agent, 'act');
    const { t, autonomy } = await this.tenantFor(agent, tenantId);
    this.direct(autonomy, agentProposalClass('status_change', { to: input.to }));
    return this.once(agent.agentId, key, async () => {
      const row = await this.load(t, id);
      this.writable(row);
      this.version(row, input.expectedVersion);
      await this.claims.requireHeld(t, id, agent.agentId);
      const r = await this.incidents.move(t, agentActor(ref(agent)), id, { to: input.to, note: input.note, holdReason: input.holdReason, duplicateOf: input.duplicateOf }, true);
      // Finished: the lease is no longer needed.
      if (FINISHED.includes(r.status)) await this.claims.release(t, id, agent.agentId);
      return { status: r.status, version: r.version };
    });
  }

  async priority(agent: AgentPrincipal, tenantId: string, id: string, input: AgentPriorityInput, key?: string) {
    this.scope(agent, 'act');
    const { t, autonomy } = await this.tenantFor(agent, tenantId);
    this.direct(autonomy, 'triage');
    return this.once(agent.agentId, key, async () => {
      const row = await this.load(t, id);
      this.writable(row);
      this.version(row, input.expectedVersion);
      await this.claims.requireHeld(t, id, agent.agentId);
      const r = await this.incidents.setPriority(t, agentActor(ref(agent)), id, { priority: input.priority, reason: input.reason });
      return { priority: r.priority, version: r.version };
    });
  }

  async linkItem(agent: AgentPrincipal, tenantId: string, id: string, input: AgentLinkItemInput, key?: string) {
    this.scope(agent, 'act');
    const { t, autonomy } = await this.tenantFor(agent, tenantId);
    this.direct(autonomy, 'triage');
    return this.once(agent.agentId, key, async () => {
      const row = await this.load(t, id);
      this.writable(row);
      await this.claims.requireHeld(t, id, agent.agentId);
      const item = await this.incidents.addItem(t, agentActor(ref(agent)), id, input);
      return { id: item.id };
    });
  }

  /**
   * A read-only check (docs/DIAGNOSTICS.md). At "act alone" an agent just runs it; below that, the check has to be a
   * step a person approved (an `external` proposal of the diagnostics class), named by `proposalId`. Either way the
   * agent holds the incident, and the result goes on the timeline.
   */
  async diagnostic(agent: AgentPrincipal, tenantId: string, id: string, input: AgentDiagnosticInput, key?: string) {
    this.scope(agent, 'note');
    const { t, autonomy } = await this.tenantFor(agent, tenantId);
    const level = agentLevel(autonomy, 'diagnostic_read');
    if (level < 1) throw new ForbiddenException('Your autonomy for "diagnostic_read" on this customer is "observe".');
    if (!agentMayActDirectly(level) && !(input.proposalId && agentMayExecuteApproved(level))) {
      throw new ForbiddenException({ message: `Your autonomy for "diagnostic_read" on this customer is ${level}, below "act alone" (3). Propose the check as an "external" step (actionClass "diagnostic_read") and run it once a person approves it, naming the proposal in "proposalId".`, code: 'propose_instead' });
    }
    return this.once(agent.agentId, key, async () => {
      const row = await this.load(t, id);
      this.writable(row);
      await this.claims.requireHeld(t, id, agent.agentId);
      if (input.proposalId && !agentMayActDirectly(level)) {
        const p = await tenantDb(this.db, t.schema).selectFrom('incident_actions').select(['agent_id', 'kind', 'action_class', 'state']).where('id', '=', input.proposalId).where('incident_id', '=', id).executeTakeFirst();
        if (!p || p.agent_id !== agent.agentId || p.kind !== 'external' || p.action_class !== 'diagnostic_read') throw new NotFoundException('proposal not found');
        if (p.state !== 'approved' && p.state !== 'running') throw new ConflictException(p.state === 'proposed' ? 'A person has not approved this yet.' : `This proposal is already ${p.state}.`);
      }
      const r = await this.diagnostics.run(t, agentActor(ref(agent)), id, { runbook: input.runbook, input: input.input }, { proposalId: input.proposalId });
      if (input.proposalId) await this.proposals.reportResult(t, ref(agent), autonomy, id, input.proposalId, { state: 'done', result: { diagnosticId: r.id, status: r.status, summary: r.summary } }).catch(() => undefined);
      return r;
    });
  }

  async listDiagnostics(agent: AgentPrincipal, tenantId: string, id: string) {
    this.scope(agent, 'read');
    const { t } = await this.tenantFor(agent, tenantId);
    await this.load(t, id);
    return { results: await this.diagnostics.list(t, id), suggestions: await this.diagnostics.suggest(t, id) };
  }

  /* ------------------------------ proposals and handoff ------------------------------ */

  async propose(agent: AgentPrincipal, tenantId: string, id: string, input: AgentProposalInput, key?: string) {
    this.scope(agent, 'propose');
    const { t, autonomy } = await this.tenantFor(agent, tenantId);
    return this.once(agent.agentId, key, async () => {
      const row = await this.load(t, id);
      this.writable(row);
      if (!INC_LIVE_STATUSES.includes(row.status)) throw new ConflictException('This incident is finished.');
      return this.proposals.create(t, ref(agent), row, input, autonomy);
    });
  }

  async listProposals(agent: AgentPrincipal, tenantId: string, id: string) {
    this.scope(agent, 'read');
    const { t } = await this.tenantFor(agent, tenantId);
    await this.load(t, id);
    return this.proposals.list(t, id, agent.agentId);
  }

  async proposalResult(agent: AgentPrincipal, tenantId: string, id: string, proposalId: string, input: AgentProposalResultInput) {
    this.scope(agent, 'propose');
    const { t, autonomy } = await this.tenantFor(agent, tenantId);
    return this.proposals.reportResult(t, ref(agent), autonomy, id, proposalId, input);
  }

  /** The agent hands the incident to the team with a structured summary: its lease is released and it goes back to the queue (or to a named person). */
  async handoff(agent: AgentPrincipal, tenantId: string, id: string, input: AgentHandoffInput, key?: string) {
    this.scope(agent, 'note');
    const { t } = await this.tenantFor(agent, tenantId);
    return this.once(agent.agentId, key, async () => {
      const row = await this.load(t, id);
      this.version(row, input.expectedVersion);
      const live = await this.claims.current(t, id);
      if (row.assigned_agent_id !== agent.agentId && live?.agent_id !== agent.agentId) throw new ConflictException('You are not working this incident, so there is nothing to hand off. Add a note instead.');
      const sm = input.summary;
      const text = [
        `Handoff from ${agentLabel(agent.name)}`,
        sm.tried.length ? `Tried:\n${sm.tried.map((x) => `- ${x}`).join('\n')}` : '',
        sm.found.length ? `Found:\n${sm.found.map((x) => `- ${x}`).join('\n')}` : '',
        `Recommendation: ${sm.recommendation}`,
        `Confidence: ${sm.confidence}`,
        sm.evidence.length ? `Evidence:\n${sm.evidence.map((x) => `- ${x.label}${x.url ? ` ${x.url}` : ''}`).join('\n')}` : '',
      ]
        .filter(Boolean)
        .join('\n\n');
      const s = tenantDb(this.db, t.schema);
      await s.insertInto('incident_events').values({ incident_id: id, kind: 'handoff', body: text, internal: true, author_id: agent.agentId, actor_type: 'agent', meta: JSON.stringify(sm) }).execute();
      await this.claims.release(t, id, agent.agentId, 'handed_off');
      if (input.toUserId) {
        await this.incidents.assign(t, agentActor(ref(agent)), id, { userId: input.toUserId });
      } else {
        await s.updateTable('incidents').set({ assigned_agent_id: null, updated_at: new Date().toISOString(), version: row.version + 1 }).where('id', '=', id).where('assigned_agent_id', '=', agent.agentId).execute();
      }
      const fresh = await this.load(t, id);
      await this.events.emit(t.id, fresh, 'incident.updated', { change: 'handoff', by: 'agent' });
      await this.notify.agentHandoff(t, fresh, agent.name, `${sm.recommendation} (confidence: ${sm.confidence})`);
      return { handedOff: true, version: fresh.version, assignedTo: input.toUserId ?? null };
    });
  }
}
