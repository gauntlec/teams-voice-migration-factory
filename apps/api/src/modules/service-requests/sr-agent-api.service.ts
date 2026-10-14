import { ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { platformDb, tenantDb, tenantSchemaName } from '@tvmf/db';
import {
  SR_OPEN_STATUSES,
  SR_TYPE_DEFS,
  agentEffectiveAutonomy,
  agentLabel,
  agentLevel,
  agentMayActDirectly,
  agentMayExecuteApproved,
  agentMayNote,
  can,
  srAutomation,
  srChangeWindowText,
  srInChangeWindow,
  srReference,
  type AgentActionClass,
  type AgentAutonomy,
  type AgentClaimInput,
  type AgentHandoffInput,
  type AgentHeartbeatInput,
  type AgentProposalResultInput,
  type AgentScope,
  type SrAgentListInput,
  type SrAgentNoteInput,
  type SrAgentStatusInput,
  type SrAgentStepInput,
  type SrProposalInput,
  type SrStatus,
} from '@tvmf/shared';
import { AuditService } from '../../common/audit.service';
import type { AgentPrincipal, AuthedUser, TenantContext } from '../../common/request';
import { InjectDb, type Db } from '../../db/db.module';
import { DeploymentService } from '../deployment/deployment.service';
import { agentActor } from '../incidents/agent-actor';
import { AgentEventsService } from '../incidents/agent-events.service';
import { ServiceRequestsService } from './service-requests.service';
import { SrClaimsService } from './sr-claims.service';
import { SrProposalsService } from './sr-proposals.service';

const ref = (a: AgentPrincipal) => ({ id: a.agentId, name: a.name });

/**
 * What an AI agent can do on service requests (docs/SERVICE-REQUEST-AGENTS.md). The same rules as incidents - token scope,
 * the customer's policy and the agent's autonomy per action class, a held lease for anything that changes the request, a
 * person who took it over locks the agent out, idempotent writes - plus the ones that keep a change to a live tenant safe:
 * only requests with an automation profile, a clean What-If, and a deploy only as a person approved it, on that person's own
 * tenant session, command for command.
 */
@Injectable()
export class SrAgentApiService {
  constructor(
    @InjectDb() private readonly db: Db,
    private readonly audit: AuditService,
    private readonly requests: ServiceRequestsService,
    private readonly claims: SrClaimsService,
    private readonly proposals: SrProposalsService,
    private readonly events: AgentEventsService,
    private readonly deployment: DeploymentService,
  ) {}

  /* ------------------------------ checks ------------------------------ */

  private scope(agent: AgentPrincipal, s: AgentScope) {
    if (!agent.scopes.includes(s)) throw new ForbiddenException(`This token can't do that (it needs the "${s}" scope).`);
  }

  private async tenantFor(agent: AgentPrincipal, tenantId: string): Promise<{ t: TenantContext; autonomy: AgentAutonomy }> {
    const row = await platformDb(this.db)
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
    const row = await tenantDb(this.db, t.schema).selectFrom('service_requests').selectAll().where('id', '=', id).executeTakeFirst();
    if (!row) throw new NotFoundException('service request not found');
    return row;
  }

  private writable(row: { agent_hold: boolean }) {
    if (row.agent_hold) throw new ConflictException({ message: 'A person has taken this request over. You can read it, but not change it, until it is handed back.', code: 'taken_over' });
  }

  /** Direct changes need "act alone" for the action class; otherwise the call tells the agent to propose instead. */
  private direct(autonomy: AgentAutonomy, cls: AgentActionClass) {
    const level = agentLevel(autonomy, cls);
    if (!agentMayActDirectly(level)) {
      throw new ForbiddenException({ message: `Your autonomy for "${cls}" on this customer is ${level}, below "act alone" (3). Propose it instead (POST .../proposals) and a person will decide.`, code: 'propose_instead' });
    }
  }

  /**
   * A step an assistant takes: directly at "act alone", or (below that, at "act with approval") only as a step a person
   * approved, named in `proposalId`. Returns the approved proposal when that is how it is allowed.
   */
  private async permit(t: TenantContext, agent: AgentPrincipal, autonomy: AgentAutonomy, requestId: string, cls: 'change_design' | 'change_whatif', proposalId?: string) {
    const level = agentLevel(autonomy, cls);
    if (agentMayActDirectly(level)) return null;
    if (level >= 2 && proposalId) {
      const p = await tenantDb(this.db, t.schema).selectFrom('service_request_actions').selectAll().where('id', '=', proposalId).where('request_id', '=', requestId).executeTakeFirst();
      if (!p || p.agent_id !== agent.agentId || p.kind !== 'external' || p.action_class !== cls) throw new NotFoundException('proposal not found');
      if (p.state !== 'approved' && p.state !== 'running') throw new ConflictException(p.state === 'proposed' ? 'A person has not approved this yet.' : `This proposal is already ${p.state}.`);
      return p;
    }
    throw new ForbiddenException({
      message: `Your autonomy for "${cls}" on this customer is ${level}, below "act alone" (3). Propose it as an "external" step (actionClass "${cls}") and, once a person approves it, take it with "proposalId".`,
      code: 'propose_instead',
    });
  }

  private async once<T>(agentId: string, key: string | undefined, fn: () => Promise<T>): Promise<T> {
    if (!key) return fn();
    const p = platformDb(this.db);
    const k = key.slice(0, 200);
    const inserted = await p.insertInto('agent_requests').values({ agent_id: agentId, idem_key: k }).onConflict((oc) => oc.columns(['agent_id', 'idem_key']).doNothing()).returning('idem_key').executeTakeFirst();
    if (!inserted) {
      const prior = await p.selectFrom('agent_requests').select(['status', 'response']).where('agent_id', '=', agentId).where('idem_key', '=', k).executeTakeFirst();
      if (prior?.status === 'done') return prior.response as T;
      throw new ConflictException({ message: 'A request with this Idempotency-Key is still running.', code: 'in_flight' });
    }
    try {
      const result = await fn();
      await p.updateTable('agent_requests').set({ status: 'done', response: JSON.stringify(result ?? {}) }).where('agent_id', '=', agentId).where('idem_key', '=', k).execute();
      return result;
    } catch (e) {
      await p.deleteFrom('agent_requests').where('agent_id', '=', agentId).where('idem_key', '=', k).execute();
      throw e;
    }
  }

  /** What a step on this request needs first: an automation profile, and the request still open. */
  private eligible(row: { type: keyof typeof SR_TYPE_DEFS; details: unknown; status: SrStatus }) {
    const a = srAutomation(row.type, (row.details ?? {}) as Record<string, unknown>, row.status);
    if (!a.eligible) throw new ConflictException({ message: `An assistant can't carry this request through: ${a.reasons.join(' ')}`, code: 'not_automatable', reasons: a.reasons });
    return a;
  }

  /* ------------------------------ reading ------------------------------ */

  /** Service requests across the customers this agent may work. */
  async list(agent: AgentPrincipal, q: SrAgentListInput) {
    this.scope(agent, 'read');
    const p = platformDb(this.db);
    let tq = p
      .selectFrom('tenants as t')
      .innerJoin('agent_customer_policy as cp', (j) => j.onRef('cp.tenant_id', '=', 't.id').on('cp.agent_id', '=', agent.agentId).on('cp.enabled', '=', true))
      .select(['t.id as id', 't.name as name', 't.schema_name as schema'])
      .where('t.status', '=', 'active')
      .where('t.managed_services_enabled', '=', true)
      .where('t.agents_enabled', '=', true);
    if (q.tenantId) tq = tq.where('t.id', '=', q.tenantId);
    const tenants = await tq.execute();
    const all = await Promise.all(
      tenants.map(async (t) => {
        let rq = tenantDb(this.db, t.schema)
          .selectFrom('service_requests as r')
          .leftJoin('discovery_sites as ds', 'ds.id', 'r.site_id')
          .select(['r.id as id', 'r.number as number', 'r.type as type', 'r.title as title', 'r.priority as priority', 'r.status as status', 'r.details as details', 'ds.sitecode as sitecode', 'r.assigned_to as assigned_to', 'r.assigned_agent_id as assigned_agent_id', 'r.agent_hold as agent_hold', 'r.approval_status as approval_status', 'r.waiting_since as waiting_since', 'r.created_at as created_at', 'r.updated_at as updated_at'])
          .orderBy('r.created_at');
        if (q.status === 'open') rq = rq.where('r.status', 'in', [...SR_OPEN_STATUSES]);
        else if (q.status !== 'all') rq = rq.where('r.status', '=', q.status as SrStatus);
        if (q.type) rq = rq.where('r.type', '=', q.type as never);
        if (q.assigned === 'me') rq = rq.where('r.assigned_agent_id', '=', agent.agentId);
        if (q.assigned === 'unassigned') rq = rq.where('r.assigned_to', 'is', null).where('r.assigned_agent_id', 'is', null);
        const rows = await rq.execute();
        return rows.map((r) => {
          const a = srAutomation(r.type, (r.details ?? {}) as Record<string, unknown>, r.status);
          return {
            tenant_id: t.id,
            tenant_name: t.name,
            id: r.id,
            reference: srReference(r.number),
            type: r.type,
            type_label: SR_TYPE_DEFS[r.type].label,
            title: r.title,
            priority: r.priority,
            status: r.status,
            sitecode: r.sitecode,
            assigned: r.assigned_agent_id === agent.agentId ? 'me' : r.assigned_agent_id ? 'another_assistant' : r.assigned_to ? 'person' : 'nobody',
            taken_over: r.agent_hold,
            approval_status: r.approval_status,
            waiting_on_customer: !!r.waiting_since,
            automatable: a.eligible,
            created_at: r.created_at,
            updated_at: r.updated_at,
          };
        });
      }),
    );
    const rank = { urgent: 0, high: 1, normal: 2, low: 3 } as const;
    return all
      .flat()
      .filter((r) => !q.automatable || r.automatable)
      .sort((a, b) => rank[a.priority] - rank[b.priority] || String(a.created_at).localeCompare(String(b.created_at)))
      .slice(0, q.limit);
  }

  /** Everything needed to work a request: the record and timeline, the design so far, whether it can be automated and what it would do, the current What-If, the claim, proposals and the agent's autonomy. */
  async get(agent: AgentPrincipal, tenantId: string, id: string) {
    this.scope(agent, 'read');
    const { t, autonomy } = await this.tenantFor(agent, tenantId);
    const base = await this.requests.get(t, id, true);
    const row = base.request;
    const design = await this.requests.design(t, id).catch(() => null);
    const automation = srAutomation(row.type, (row.details ?? {}) as Record<string, unknown>, row.status);
    const plan = automation.eligible && ['planned', 'built'].includes(row.status) && design && design.deployableCount > 0 ? await this.proposals.plan(t, id).catch(() => null) : null;
    return {
      tenant: { id: t.id, name: t.name },
      ...base,
      design,
      automation,
      whatIf: plan ? { verdict: plan.verdict, fingerprint: plan.fingerprint, commands: plan.commands } : null,
      runs: await this.requests.runs(t, id).catch(() => []),
      proposals: await this.proposals.list(t, id, agent.agentId),
      autonomy: agentEffectiveAutonomy(autonomy),
    };
  }

  /* ------------------------------ working a request ------------------------------ */

  async claim(agent: AgentPrincipal, tenantId: string, id: string, input: AgentClaimInput, key?: string) {
    this.scope(agent, 'note');
    const { t, autonomy } = await this.tenantFor(agent, tenantId);
    if (agentLevel(autonomy, 'triage') < 1) throw new ForbiddenException('Your autonomy for "triage" on this customer is "observe", so you cannot take a request on.');
    return this.once(agent.agentId, key, async () => this.claims.claim(t, ref(agent), await this.load(t, id), input.ttlSeconds, input.note ?? ''));
  }

  async heartbeat(agent: AgentPrincipal, tenantId: string, id: string, input: AgentHeartbeatInput) {
    this.scope(agent, 'note');
    const { t } = await this.tenantFor(agent, tenantId);
    return this.claims.heartbeat(t, id, agent.agentId, input.ttlSeconds);
  }

  async release(agent: AgentPrincipal, tenantId: string, id: string) {
    this.scope(agent, 'note');
    const { t } = await this.tenantFor(agent, tenantId);
    return { released: await this.claims.release(t, id, agent.agentId) };
  }

  async note(agent: AgentPrincipal, tenantId: string, id: string, input: SrAgentNoteInput, key?: string) {
    this.scope(agent, 'note');
    const { t, autonomy } = await this.tenantFor(agent, tenantId);
    if (!agentMayNote(agentLevel(autonomy, 'internal_note'))) throw new ForbiddenException('Your autonomy for "internal_note" on this customer is "observe".');
    return this.once(agent.agentId, key, async () => {
      this.writable(await this.load(t, id));
      const e = await this.requests.comment(t, agentActor(ref(agent)), id, { body: input.body, internal: true }, true);
      return { id: e.id };
    });
  }

  /** Planned (triage) or Designed & built (change_design): "act alone" and the lease needed, and only on a request it can carry through. */
  async status(agent: AgentPrincipal, tenantId: string, id: string, input: SrAgentStatusInput, key?: string) {
    this.scope(agent, 'act');
    const { t, autonomy } = await this.tenantFor(agent, tenantId);
    this.direct(autonomy, input.to === 'built' ? 'change_design' : 'triage');
    return this.once(agent.agentId, key, async () => {
      const row = await this.load(t, id);
      this.writable(row);
      this.eligible(row);
      await this.claims.requireHeld(t, id, agent.agentId);
      const r = await this.requests.move(t, agentActor(ref(agent)), id, { to: input.to, note: input.note }, true);
      return { status: r.status };
    });
  }

  /** "Apply the request": the same mapping an engineer's button uses, onto Design & Build rows linked to the request. */
  async apply(agent: AgentPrincipal, tenantId: string, id: string, input: SrAgentStepInput, key?: string) {
    this.scope(agent, 'act');
    const { t, autonomy } = await this.tenantFor(agent, tenantId);
    const approved = await this.permit(t, agent, autonomy, id, 'change_design', input.proposalId);
    return this.once(agent.agentId, key, async () => {
      const row = await this.load(t, id);
      this.writable(row);
      this.eligible(row);
      await this.claims.requireHeld(t, id, agent.agentId);
      if (row.status !== 'planned') throw new ConflictException('A request has to be Planned before its design is applied.');
      const result = await this.requests.draftInBuild(t, agentActor(ref(agent)), id, {} as never);
      if (approved) await this.finishProposal(t, approved.id, 'done', { applied: true });
      return { result, design: await this.requests.design(t, id) };
    });
  }

  /** What-If: the exact commands a deploy would run, and whether that is clean. Recorded on the request. */
  async whatIf(agent: AgentPrincipal, tenantId: string, id: string, input: SrAgentStepInput, key?: string) {
    this.scope(agent, 'act');
    const { t, autonomy } = await this.tenantFor(agent, tenantId);
    const approved = await this.permit(t, agent, autonomy, id, 'change_whatif', input.proposalId);
    return this.once(agent.agentId, key, async () => {
      const row = await this.load(t, id);
      this.writable(row);
      this.eligible(row);
      if (!['planned', 'built'].includes(row.status)) throw new ConflictException('What-If runs while a request is Planned or Designed & built.');
      await this.claims.requireHeld(t, id, agent.agentId);
      const plan = await this.proposals.plan(t, id);
      const summary = plan.verdict.ok ? `What-If is clean: ${plan.verdict.calls} change${plan.verdict.calls === 1 ? '' : 's'} on ${plan.verdict.rows} row${plan.verdict.rows === 1 ? '' : 's'}.` : `What-If is not clean: ${plan.verdict.reasons.join(' ')}`;
      await tenantDb(this.db, t.schema)
        .insertInto('service_request_events')
        .values({ request_id: id, kind: 'whatif', body: summary, internal: true, author_id: agent.agentId, actor_type: 'agent', meta: JSON.stringify({ fingerprint: plan.fingerprint, ok: plan.verdict.ok, calls: plan.verdict.calls, rows: plan.verdict.rows, warnings: plan.verdict.warnings }) })
        .execute();
      if (approved) await this.finishProposal(t, approved.id, 'done', { ok: plan.verdict.ok, fingerprint: plan.fingerprint });
      return { ...plan, summary };
    });
  }

  /**
   * Deploy: only as a person approved it. The approved proposal names the plan (a hash of every command) and the approver's
   * own tenant session; both are re-checked now, along with everything that keeps a live change safe.
   */
  async deploy(agent: AgentPrincipal, tenantId: string, id: string, input: SrAgentStepInput, key?: string) {
    this.scope(agent, 'act');
    const { t, autonomy } = await this.tenantFor(agent, tenantId);
    const level = agentLevel(autonomy, 'change_deploy');
    if (!input.proposalId) throw new ForbiddenException({ message: 'A deployment only runs as a person approved it. Propose it (an "external" step, actionClass "change_deploy"), and once approved take it with "proposalId".', code: 'propose_instead' });
    if (!agentMayExecuteApproved(level)) throw new ForbiddenException({ message: `Your autonomy for "change_deploy" on this customer is ${level}, below "act with approval" (2), so you cannot carry out an approved deployment.`, code: 'propose_instead' });
    return this.once(agent.agentId, key, async () => {
      const s = tenantDb(this.db, t.schema);
      const row = await this.load(t, id);
      this.writable(row);
      this.eligible(row);
      await this.claims.requireHeld(t, id, agent.agentId);
      const p = await s.selectFrom('service_request_actions').selectAll().where('id', '=', input.proposalId!).where('request_id', '=', id).executeTakeFirst();
      if (!p || p.agent_id !== agent.agentId || p.kind !== 'external' || p.action_class !== 'change_deploy') throw new NotFoundException('proposal not found');
      if (p.state !== 'approved') throw new ConflictException(p.state === 'proposed' ? 'A person has not approved this yet.' : p.state === 'running' ? 'This deployment has already started.' : `This proposal is already ${p.state}.`);
      const refuse = async (message: string, code: string) => {
        await this.finishProposal(t, p.id, 'failed', undefined, message);
        throw new ConflictException({ message, code });
      };
      if (row.status !== 'built') await refuse('A request has to be Designed & built before it is deployed.', 'not_built');
      if (row.approval_status === 'pending' || row.approval_status === 'rejected') await refuse("The customer's approval is not given.", 'not_approved');
      const settings = await this.requests.settings(t);
      const window = settings.changeWindow ?? null;
      if (!srInChangeWindow(window)) await refuse(`It is outside this customer's change window (${srChangeWindowText(window!)}). An assistant never deploys outside it: a person decides.`, 'outside_window');
      const plan = await this.proposals.plan(t, id).catch(() => null);
      if (!plan || !plan.verdict.ok) await refuse(`The What-If is not clean: ${plan ? plan.verdict.reasons.join(' ') : 'it could not be run.'}`, 'whatif_not_clean');
      if (plan!.fingerprint !== p.fingerprint) await refuse('The plan has changed since it was approved. Propose it again so a person can approve the new commands.', 'plan_changed');
      if (!p.connection_id || !p.decided_by) await refuse('The approval did not name a tenant session.', 'no_session');

      const approver = await this.approver(p.decided_by!);
      if (!approver) await refuse('The person who approved this is no longer active.', 'approver_gone');
      const scope = await this.requests.deployScopeFor(t, id);
      await s.updateTable('service_request_actions').set({ state: 'running' }).where('id', '=', p.id).execute();
      let dep;
      try {
        // Runs as the approver on their own session (the worker and the audit log show who authorised it); the run is tagged with the assistant and the proposal.
        dep = await this.deployment.createDeployment(t, approver!, { connectionId: p.connection_id!, mode: 'execute', scope }, (perm) => can(approver!.role, perm), { serviceRequestId: id, agentId: agent.agentId, proposalId: p.id });
      } catch (e) {
        await this.finishProposal(t, p.id, 'failed', undefined, (e as Error).message);
        throw e;
      }
      await s.updateTable('service_request_actions').set({ result: JSON.stringify({ deploymentId: dep.id }) }).where('id', '=', p.id).execute();
      await s
        .insertInto('service_request_events')
        .values({ request_id: id, kind: 'deployment', body: `${agentLabel(agent.name)} started the deployment ${approver!.displayName} approved, on ${approver!.displayName}'s session.`, internal: true, deployment_id: dep.id, author_id: agent.agentId, actor_type: 'agent' })
        .execute();
      await this.audit.tenant(t.schema, 'service_request.agent_deploy', { actor: { id: agent.agentId, email: `agent:${agent.name}` }, targetType: 'service_request', targetId: id, detail: { reference: srReference(row.number), deploymentId: dep.id, proposalId: p.id, approvedBy: approver!.id } });
      return { deploymentId: dep.id, status: dep.status, note: 'Queued. The result (and the live re-check) is on the request; read it to see how it went.' };
    });
  }

  private async approver(userId: string): Promise<AuthedUser | null> {
    const u = await platformDb(this.db).selectFrom('users').select(['id', 'email', 'display_name', 'role', 'status']).where('id', '=', userId).executeTakeFirst();
    if (!u || u.status !== 'active') return null;
    return { id: u.id, email: u.email, displayName: u.display_name, role: u.role, totpEnrolled: true, enrolOnly: false, pwresetOnly: false };
  }

  private async finishProposal(t: TenantContext, id: string, state: 'done' | 'failed', result?: Record<string, unknown>, error?: string) {
    await tenantDb(this.db, t.schema)
      .updateTable('service_request_actions')
      .set({ state, finished_at: new Date().toISOString(), ...(result ? { result: JSON.stringify(result) } : {}), ...(error ? { error } : {}) })
      .where('id', '=', id)
      .execute();
  }

  /* ------------------------------ proposals and handoff ------------------------------ */

  async propose(agent: AgentPrincipal, tenantId: string, id: string, input: SrProposalInput, key?: string) {
    this.scope(agent, 'propose');
    const { t, autonomy } = await this.tenantFor(agent, tenantId);
    return this.once(agent.agentId, key, async () => {
      const row = await this.load(t, id);
      this.writable(row);
      if (!SR_OPEN_STATUSES.includes(row.status)) throw new ConflictException('This request is finished.');
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

  /** The agent hands the request to the team with a structured summary: its lease is released and it goes back to the queue (or to a named person). */
  async handoff(agent: AgentPrincipal, tenantId: string, id: string, input: AgentHandoffInput, key?: string) {
    this.scope(agent, 'note');
    const { t } = await this.tenantFor(agent, tenantId);
    return this.once(agent.agentId, key, async () => {
      const row = await this.load(t, id);
      const live = await this.claims.current(t, id);
      if (row.assigned_agent_id !== agent.agentId && live?.agent_id !== agent.agentId) throw new ConflictException('You are not working this request, so there is nothing to hand off. Add a note instead.');
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
      await tenantDb(this.db, t.schema).insertInto('service_request_events').values({ request_id: id, kind: 'handoff', body: text, internal: true, author_id: agent.agentId, actor_type: 'agent', meta: JSON.stringify(sm) }).execute();
      await this.claims.release(t, id, agent.agentId, 'handed_off');
      if (input.toUserId) await this.requests.assign(t, agentActor(ref(agent)), id, input.toUserId);
      const fresh = await this.load(t, id);
      await this.events.emitRequest(t.id, fresh, 'sr.updated', { change: 'handoff', by: 'agent' });
      await this.requests.notifyTeam(t, fresh, 'agent_handoff', agentLabel(agent.name), `${sm.recommendation} (confidence: ${sm.confidence})`);
      return { handedOff: true, assignedTo: input.toUserId ?? null };
    });
  }
}
