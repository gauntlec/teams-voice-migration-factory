import { BadRequestException, ConflictException, ForbiddenException, HttpException, Injectable, NotFoundException } from '@nestjs/common';
import { platformDb, tenantDb } from '@tvmf/db';
import {
  AGENT_MAX_FAILURES,
  AGENT_PROPOSAL_FINAL,
  AGENT_PROPOSAL_KINDS,
  agentLabel,
  agentLevel,
  agentMayExecuteApproved,
  agentMayPropose,
  agentParseProposal,
  agentProposalClass,
  agentProposalSummary,
  incReference,
  type AgentActionClass,
  type AgentAutonomy,
  type AgentProposalInput,
  type AgentProposalKind,
  type AgentProposalResultInput,
  type ProposalDecisionInput,
} from '@tvmf/shared';
import { AuditService } from '../../common/audit.service';
import type { AuthedUser, TenantContext } from '../../common/request';
import { InjectDb, type Db } from '../../db/db.module';
import { agentActor } from './agent-actor';
import { AgentEventsService } from './agent-events.service';
import { IncidentClaimsService } from './incident-claims.service';
import { IncidentMajorService } from './incident-major.service';
import { IncidentNotifier } from './incident-notifier';
import { IncidentsService } from './incidents.service';
import { ProblemsService } from './problems.service';

/** A pending proposal per assistant per incident, so one that loops can't bury the page. */
const MAX_OPEN_PER_AGENT = 5;

type Inc = Awaited<ReturnType<IncidentProposalsService['loadIncident']>>;

/**
 * Proposals: an assistant's suggested next step, decided by a person. Approving one the platform can do
 * itself (an update, a status move, a priority change ...) carries it out as the assistant, so the
 * timeline shows who did it and who approved it. Steps only the assistant can do (a diagnostic, a What-If,
 * a change) are marked approved; the assistant does them and reports back. See docs/AGENTS.md.
 */
@Injectable()
export class IncidentProposalsService {
  constructor(
    @InjectDb() private readonly db: Db,
    private readonly audit: AuditService,
    private readonly incidents: IncidentsService,
    private readonly major: IncidentMajorService,
    private readonly problems: ProblemsService,
    private readonly claims: IncidentClaimsService,
    private readonly events: AgentEventsService,
    private readonly notify: IncidentNotifier,
  ) {}

  private async loadIncident(t: TenantContext, id: string) {
    const row = await tenantDb(this.db, t.schema).selectFrom('incidents').selectAll().where('id', '=', id).executeTakeFirst();
    if (!row) throw new NotFoundException('incident not found');
    return row;
  }

  /** An assistant proposes. The caller has already checked its scope and that its level for the class allows suggesting. */
  async create(t: TenantContext, agent: { id: string; name: string }, inc: Inc, input: AgentProposalInput, autonomy: AgentAutonomy) {
    const parsed = agentParseProposal(input.kind, input.params);
    if (!parsed.ok) throw new BadRequestException(parsed.error);
    const actionClass = agentProposalClass(input.kind, parsed.params);
    if (!agentMayPropose(agentLevel(autonomy, actionClass))) {
      throw new ForbiddenException(`Your autonomy for "${actionClass}" on this customer doesn't allow proposing that.`);
    }
    const s = tenantDb(this.db, t.schema);
    const open = await s.selectFrom('incident_actions').select('id').where('incident_id', '=', inc.id).where('agent_id', '=', agent.id).where('state', '=', 'proposed').execute();
    if (open.length >= MAX_OPEN_PER_AGENT) throw new ConflictException(`You already have ${open.length} proposals waiting on this incident. Wait for a decision before proposing more.`);
    const expires = new Date(Date.now() + input.expiresInMinutes * 60_000).toISOString();
    const row = await s
      .insertInto('incident_actions')
      .values({ incident_id: inc.id, agent_id: agent.id, kind: input.kind, action_class: actionClass, params: JSON.stringify(parsed.params), rationale: input.rationale, risk: input.risk, expires_at: expires })
      .returningAll()
      .executeTakeFirstOrThrow();
    const summary = agentProposalSummary(input.kind, parsed.params);
    await s
      .insertInto('incident_events')
      .values({ incident_id: inc.id, kind: 'proposal', body: `${agentLabel(agent.name)} proposes: ${summary}\nWhy: ${input.rationale}`, internal: true, author_id: agent.id, actor_type: 'agent', meta: JSON.stringify({ proposalId: row.id, kind: input.kind, risk: input.risk }) })
      .execute();
    await this.audit.tenant(t.schema, 'incident.proposal_created', { actor: { id: agent.id, email: `agent:${agent.name}` }, targetType: 'incident', targetId: inc.id, detail: { reference: incReference(inc.number), proposalId: row.id, kind: input.kind, risk: input.risk } });
    await this.notify.agentProposal(t, inc, agent.name, `${summary}\nWhy: ${input.rationale}`);
    return { id: row.id, state: row.state, kind: row.kind, action_class: actionClass, expires_at: row.expires_at };
  }

  async list(t: TenantContext, incidentId: string, agentId?: string) {
    let q = tenantDb(this.db, t.schema).selectFrom('incident_actions').selectAll().where('incident_id', '=', incidentId).orderBy('created_at', 'desc').limit(50);
    if (agentId) q = q.where('agent_id', '=', agentId);
    const rows = await q.execute();
    const now = Date.now();
    return rows.map((p) => ({ ...p, summary: agentProposalSummary(p.kind as AgentProposalKind, p.params), state: p.state === 'proposed' && new Date(p.expires_at).getTime() < now ? ('expired' as const) : p.state }));
  }

  /** A person approves or rejects. */
  async decide(t: TenantContext, user: AuthedUser, incidentId: string, proposalId: string, input: ProposalDecisionInput) {
    const s = tenantDb(this.db, t.schema);
    const inc = await this.loadIncident(t, incidentId);
    const p = await s.selectFrom('incident_actions').selectAll().where('id', '=', proposalId).where('incident_id', '=', incidentId).executeTakeFirst();
    if (!p) throw new NotFoundException('proposal not found');
    if (p.state !== 'proposed') throw new ConflictException(`This proposal has already been ${p.state === 'rejected' ? 'rejected' : p.state === 'expired' ? 'left to expire' : 'decided'}.`);
    const now = new Date().toISOString();
    if (new Date(p.expires_at).getTime() < Date.now()) {
      await s.updateTable('incident_actions').set({ state: 'expired', finished_at: now }).where('id', '=', p.id).where('state', '=', 'proposed').execute();
      throw new ConflictException('This proposal expired before anyone decided it. Ask the assistant to propose it again if it still applies.');
    }
    const agent = await platformDb(this.db).selectFrom('agents').select(['id', 'name', 'status']).where('id', '=', p.agent_id).executeTakeFirst();
    const agentName = agent?.name ?? 'Assistant';
    const kind = p.kind as AgentProposalKind;
    const summary = agentProposalSummary(kind, p.params);
    const note = input.note?.trim() || null;

    // Claim the decision first, so two people clicking at once can't both act.
    const claimed = await s
      .updateTable('incident_actions')
      .set({ state: input.decision === 'reject' ? 'rejected' : AGENT_PROPOSAL_KINDS[kind].server ? 'running' : 'approved', decided_by: user.id, decided_at: now, decision_note: note, ...(input.decision === 'reject' ? { finished_at: now } : {}) })
      .where('id', '=', p.id)
      .where('state', '=', 'proposed')
      .returning('id')
      .executeTakeFirst();
    if (!claimed) throw new ConflictException('Someone else just decided this proposal.');

    const decided = async (state: string, extra: Record<string, unknown> = {}) => {
      await s
        .insertInto('incident_events')
        .values({ incident_id: incidentId, kind: 'proposal_decided', body: `${user.displayName} ${input.decision === 'reject' ? 'rejected' : 'approved'} ${agentLabel(agentName)}'s proposal: ${summary}${note ? `\n${note}` : ''}${extra.error ? `\nIt could not be carried out: ${extra.error}` : ''}`, internal: true, author_id: user.id, actor_type: 'user', meta: JSON.stringify({ proposalId: p.id, state }) })
        .execute();
      await this.audit.tenant(t.schema, 'incident.proposal_decided', { actor: { id: user.id, email: user.email }, targetType: 'incident', targetId: incidentId, detail: { reference: incReference(inc.number), proposalId: p.id, kind, decision: input.decision, state, ...(extra.error ? { error: extra.error } : {}) } });
      const fresh = await this.loadIncident(t, incidentId);
      await this.events.emit(t.id, fresh, 'proposal.decided', { proposalId: p.id, proposalKind: kind, decision: input.decision, state, note }, p.agent_id);
    };

    if (input.decision === 'reject') {
      await decided('rejected');
      return this.get(t, p.id);
    }
    if (!AGENT_PROPOSAL_KINDS[kind].server) {
      // The assistant does this one itself: it may only if its autonomy for the class still allows carrying out approved steps.
      const policy = await platformDb(this.db).selectFrom('agent_customer_policy').select(['enabled', 'autonomy']).where('agent_id', '=', p.agent_id).where('tenant_id', '=', t.id).executeTakeFirst();
      const level = agentLevel(policy?.autonomy, p.action_class as AgentActionClass);
      if (!policy?.enabled || !agentMayExecuteApproved(level)) {
        const error = `${agentLabel(agentName)} is not allowed to carry out this kind of step on this customer (its autonomy for "${p.action_class}" is below "Act with approval").`;
        await s.updateTable('incident_actions').set({ state: 'failed', error, finished_at: now }).where('id', '=', p.id).execute();
        await decided('failed', { error });
        return this.get(t, p.id);
      }
      await decided('approved');
      return this.get(t, p.id);
    }
    // The platform carries it out, as the assistant (the approver is on the timeline).
    try {
      const result = await this.execute(t, user, kind, p.params, inc, agent ? { id: agent.id, name: agent.name } : { id: p.agent_id, name: agentName });
      await s.updateTable('incident_actions').set({ state: 'done', result: JSON.stringify(result), finished_at: new Date().toISOString() }).where('id', '=', p.id).execute();
      await decided('done');
    } catch (e) {
      const error = e instanceof HttpException ? String((e.getResponse() as { message?: unknown })?.message ?? e.message) : (e as Error).message;
      await s.updateTable('incident_actions').set({ state: 'failed', error, finished_at: new Date().toISOString() }).where('id', '=', p.id).execute();
      await decided('failed', { error });
    }
    return this.get(t, p.id);
  }

  private async get(t: TenantContext, id: string) {
    const p = await tenantDb(this.db, t.schema).selectFrom('incident_actions').selectAll().where('id', '=', id).executeTakeFirstOrThrow();
    return { ...p, summary: agentProposalSummary(p.kind as AgentProposalKind, p.params) };
  }

  /** Does what an approved proposal says. The assistant is the actor, except for the things only a person may do. */
  private async execute(t: TenantContext, approver: AuthedUser, kind: AgentProposalKind, params: Record<string, unknown>, inc: Inc, agent: { id: string; name: string }): Promise<Record<string, unknown>> {
    const actor = agentActor(agent);
    const id = inc.id;
    switch (kind) {
      case 'customer_update':
        await this.incidents.comment(t, actor, id, { body: String(params.body) }, true);
        return { posted: true };
      case 'ask_customer':
        await this.incidents.comment(t, actor, id, { body: String(params.body), waitForReply: true }, true);
        return { asked: true };
      case 'status_change': {
        const r = await this.incidents.move(t, actor, id, { to: params.to as never, note: params.note as string | undefined, holdReason: params.holdReason as never, duplicateOf: params.duplicateOf as string | undefined }, true);
        return { status: r.status };
      }
      case 'set_priority': {
        const r = await this.incidents.setPriority(t, actor, id, { priority: params.priority as never, reason: String(params.reason) });
        return { priority: r.priority };
      }
      case 'assign_user':
        await this.incidents.assign(t, actor, id, { userId: String(params.userId) });
        return { assigned: params.userId };
      case 'declare_major':
        // Only a person declares a major incident: the approver does it.
        await this.major.declare(t, approver, id, { leadId: String(params.leadId), commsId: params.commsId as string | undefined, intervalMinutes: params.intervalMinutes as number | undefined, summary: String(params.summary) });
        return { declared: true };
      case 'link_problem':
        await this.problems.link(t, approver, id, { problemId: String(params.problemId) });
        return { linked: true };
      case 'link_item':
        await this.incidents.addItem(t, actor, id, { kind: params.kind as never, ref: String(params.ref), label: params.label as string | undefined });
        return { linked: true };
      case 'external':
        throw new BadRequestException('That step is carried out by the assistant, not the platform.');
    }
  }

  /** The assistant reports on a step it carried out after approval. */
  async reportResult(t: TenantContext, agent: { id: string; name: string }, autonomy: AgentAutonomy, incidentId: string, proposalId: string, input: AgentProposalResultInput) {
    const s = tenantDb(this.db, t.schema);
    const p = await s.selectFrom('incident_actions').selectAll().where('id', '=', proposalId).where('incident_id', '=', incidentId).executeTakeFirst();
    if (!p || p.agent_id !== agent.id) throw new NotFoundException('proposal not found');
    if (AGENT_PROPOSAL_KINDS[p.kind as AgentProposalKind].server) throw new BadRequestException('The platform carried that one out; there is nothing to report.');
    if (AGENT_PROPOSAL_FINAL.includes(p.state)) throw new ConflictException(`This proposal is already ${p.state}.`);
    if (p.state === 'proposed') throw new ConflictException('A person has not approved this yet.');
    if (!agentMayExecuteApproved(agentLevel(autonomy, p.action_class as AgentActionClass))) throw new ForbiddenException('Your autonomy no longer allows carrying this out.');
    if (input.state === 'running' && p.state === 'running') return this.get(t, p.id);
    const now = new Date().toISOString();
    await s
      .updateTable('incident_actions')
      .set({ state: input.state, ...(input.result ? { result: JSON.stringify(input.result) } : {}), error: input.state === 'failed' ? (input.error ?? 'It failed.') : null, ...(input.state === 'running' ? {} : { finished_at: now }) })
      .where('id', '=', p.id)
      .execute();
    const inc = await this.loadIncident(t, incidentId);
    await s
      .insertInto('incident_events')
      .values({ incident_id: incidentId, kind: 'proposal_decided', body: `${agentLabel(agent.name)} reports: ${agentProposalSummary(p.kind as AgentProposalKind, p.params)} - ${input.state}${input.error ? `: ${input.error}` : ''}`, internal: true, author_id: agent.id, actor_type: 'agent', meta: JSON.stringify({ proposalId: p.id, state: input.state }) })
      .execute();
    if (input.state === 'failed') {
      const failed = await s.selectFrom('incident_actions').select('id').where('incident_id', '=', incidentId).where('agent_id', '=', agent.id).where('state', '=', 'failed').where('finished_at', '>', new Date(Date.now() - 24 * 3_600_000).toISOString()).execute();
      if (failed.length >= AGENT_MAX_FAILURES) await this.claims.lapse(t, inc, agent, `${failed.length} steps failed`);
    }
    return this.get(t, p.id);
  }
}
