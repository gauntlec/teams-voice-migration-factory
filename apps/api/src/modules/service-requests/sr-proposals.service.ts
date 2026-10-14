import { createHash } from 'node:crypto';
import { BadRequestException, ConflictException, ForbiddenException, HttpException, Injectable, NotFoundException } from '@nestjs/common';
import { platformDb, tenantDb } from '@tvmf/db';
import {
  AGENT_MAX_FAILURES,
  AGENT_PROPOSAL_FINAL,
  SR_PROPOSAL_KINDS,
  agentLabel,
  agentLevel,
  agentMayExecuteApproved,
  agentMayPropose,
  can,
  srAutomation,
  srPlanText,
  srProposalClass,
  srProposalSummary,
  srReference,
  srWhatIfVerdict,
  type AgentActionClass,
  type AgentAutonomy,
  type AgentProposalResultInput,
  type DeploymentPreviewRow,
  type SrProposalDecisionInput,
  type SrProposalInput,
  type SrProposalKind,
} from '@tvmf/shared';
import { AuditService } from '../../common/audit.service';
import type { AuthedUser, TenantContext } from '../../common/request';
import { InjectDb, type Db } from '../../db/db.module';
import { DeploymentService } from '../deployment/deployment.service';
import { agentActor } from '../incidents/agent-actor';
import { AgentEventsService } from '../incidents/agent-events.service';
import { ServiceRequestsService } from './service-requests.service';
import { SrClaimsService } from './sr-claims.service';

/** Open proposals an assistant may have on one request, so one that loops can't bury the page. */
const MAX_OPEN_PER_AGENT = 5;

/** The fingerprint a person approves: a hash of every command the deploy would run, row by row. */
export function planFingerprint(rows: Pick<DeploymentPreviewRow, 'rowId' | 'objectType' | 'renderedCommands'>[]): string {
  return createHash('sha256').update(srPlanText(rows)).digest('hex');
}

/**
 * Proposals on service requests (the counterpart of the incident ones): an assistant's suggested next step, decided by a
 * person. A reply or a status move is carried out by the platform as the assistant when approved. Applying a request,
 * a What-If or a deploy are steps the assistant takes itself afterwards; a deploy additionally records the plan (a hash
 * of the exact commands) and the approver's own tenant session, so only that plan runs, on that session.
 */
@Injectable()
export class SrProposalsService {
  constructor(
    @InjectDb() private readonly db: Db,
    private readonly audit: AuditService,
    private readonly requests: ServiceRequestsService,
    private readonly claims: SrClaimsService,
    private readonly events: AgentEventsService,
    private readonly deployment: DeploymentService,
  ) {}

  private async loadRequest(t: TenantContext, id: string) {
    const row = await tenantDb(this.db, t.schema).selectFrom('service_requests').selectAll().where('id', '=', id).executeTakeFirst();
    if (!row) throw new NotFoundException('service request not found');
    return row;
  }

  /** The plan as it stands now: rows, the commands, the What-If verdict, and its fingerprint. */
  async plan(t: TenantContext, id: string) {
    const rows = await this.requests.deployPreview(t, id);
    return { rows, verdict: srWhatIfVerdict(rows), fingerprint: planFingerprint(rows), commands: rows.map((r) => ({ rowId: r.rowId, objectType: r.objectType, upn: r.upn, commands: r.renderedCommands })) };
  }

  /** An assistant proposes. The caller has checked its scope and that its level for the class allows suggesting. */
  async create(t: TenantContext, agent: { id: string; name: string }, req: Awaited<ReturnType<SrProposalsService['loadRequest']>>, input: SrProposalInput, autonomy: AgentAutonomy) {
    const parsed = SR_PROPOSAL_KINDS[input.kind].params.safeParse(input.params);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues.map((i) => i.message).join('; '));
    const params = { ...(parsed.data as Record<string, unknown>) };
    const actionClass = srProposalClass(input.kind, params);
    if (!agentMayPropose(agentLevel(autonomy, actionClass))) throw new ForbiddenException(`Your autonomy for "${actionClass}" on this customer doesn't allow proposing that.`);
    const s = tenantDb(this.db, t.schema);
    const open = await s.selectFrom('service_request_actions').select('id').where('request_id', '=', req.id).where('agent_id', '=', agent.id).where('state', '=', 'proposed').execute();
    if (open.length >= MAX_OPEN_PER_AGENT) throw new ConflictException(`You already have ${open.length} proposals waiting on this request. Wait for a decision before proposing more.`);

    let fingerprint: string | null = null;
    if (input.kind === 'external') {
      const a = srAutomation(req.type, req.details as Record<string, unknown>, req.status);
      if (!a.eligible) throw new ConflictException(`This request is not one an assistant can carry through: ${a.reasons.join(' ')}`);
      if (actionClass === 'change_design' && req.status !== 'planned') throw new ConflictException('A request has to be Planned before its design is applied.');
      if (actionClass === 'change_whatif' && !['planned', 'built'].includes(req.status)) throw new ConflictException('What-If runs while a request is Planned or Designed & built.');
      if (actionClass === 'change_deploy') {
        if (req.status !== 'built') throw new ConflictException('A request has to be Designed & built before it is deployed.');
        const plan = await this.plan(t, req.id);
        if (!plan.verdict.ok) throw new ConflictException(`The What-If is not clean, so there is nothing to approve: ${plan.verdict.reasons.join(' ')}`);
        fingerprint = plan.fingerprint;
        // What the approver sees is what the server computed, never what the assistant said.
        params.args = { fingerprint, commands: plan.commands, calls: plan.verdict.calls };
      }
    }
    const expires = new Date(Date.now() + input.expiresInMinutes * 60_000).toISOString();
    const row = await s
      .insertInto('service_request_actions')
      .values({ request_id: req.id, agent_id: agent.id, kind: input.kind, action_class: actionClass, params: JSON.stringify(params), rationale: input.rationale, risk: input.risk, expires_at: expires, fingerprint })
      .returningAll()
      .executeTakeFirstOrThrow();
    const summary = srProposalSummary(input.kind, params);
    await s
      .insertInto('service_request_events')
      .values({ request_id: req.id, kind: 'proposal', body: `${agentLabel(agent.name)} proposes: ${summary}\nWhy: ${input.rationale}`, internal: true, author_id: agent.id, actor_type: 'agent', meta: JSON.stringify({ proposalId: row.id, kind: input.kind, actionClass }) })
      .execute();
    await this.audit.tenant(t.schema, 'service_request.proposal_created', { actor: { id: agent.id, email: `agent:${agent.name}` }, targetType: 'service_request', targetId: req.id, detail: { reference: srReference(req.number), proposalId: row.id, kind: input.kind, actionClass } });
    await this.requests.notifyTeam(t, req, 'agent_proposal', agentLabel(agent.name), `${summary}\nWhy: ${input.rationale}`);
    return { id: row.id, state: row.state, kind: row.kind, action_class: actionClass, expires_at: row.expires_at, fingerprint };
  }

  async list(t: TenantContext, requestId: string, agentId?: string) {
    let q = tenantDb(this.db, t.schema).selectFrom('service_request_actions').selectAll().where('request_id', '=', requestId).orderBy('created_at', 'desc').limit(50);
    if (agentId) q = q.where('agent_id', '=', agentId);
    const rows = await q.execute();
    const now = Date.now();
    return rows.map((p) => ({ ...p, summary: srProposalSummary(p.kind as SrProposalKind, p.params), state: p.state === 'proposed' && new Date(p.expires_at).getTime() < now ? ('expired' as const) : p.state }));
  }

  /** A person approves or rejects. */
  async decide(t: TenantContext, user: AuthedUser, requestId: string, proposalId: string, input: SrProposalDecisionInput) {
    const s = tenantDb(this.db, t.schema);
    const req = await this.loadRequest(t, requestId);
    const p = await s.selectFrom('service_request_actions').selectAll().where('id', '=', proposalId).where('request_id', '=', requestId).executeTakeFirst();
    if (!p) throw new NotFoundException('proposal not found');
    if (p.state !== 'proposed') throw new ConflictException(`This proposal has already been ${p.state === 'rejected' ? 'rejected' : p.state === 'expired' ? 'left to expire' : 'decided'}.`);
    const now = new Date().toISOString();
    if (new Date(p.expires_at).getTime() < Date.now()) {
      await s.updateTable('service_request_actions').set({ state: 'expired', finished_at: now }).where('id', '=', p.id).where('state', '=', 'proposed').execute();
      throw new ConflictException('This proposal expired before anyone decided it. Ask the assistant to propose it again if it still applies.');
    }
    const agent = await platformDb(this.db).selectFrom('agents').select(['id', 'name', 'status']).where('id', '=', p.agent_id).executeTakeFirst();
    const agentName = agent?.name ?? 'Assistant';
    const kind = p.kind as SrProposalKind;
    const summary = srProposalSummary(kind, p.params);
    const note = input.note?.trim() || null;

    // A deploy is approved onto a session of the approver's own, against the plan as it stands right now.
    let connectionId: string | null = null;
    if (input.decision === 'approve' && p.action_class === 'change_deploy') {
      if (!can(user.role, 'deployment:execute')) throw new ForbiddenException('Approving a deployment needs permission to deploy.');
      if (!input.connectionId) throw new BadRequestException("Pick the tenant session it will run on: one of your own that is signed in to this customer's Teams tenant.");
      const conn = await this.deployment.getConnection(t, input.connectionId);
      if (conn.started_by !== user.id && user.role !== 'SUPER_ADMIN') throw new ForbiddenException('That session belongs to another engineer. Pick one of your own.');
      if (conn.status !== 'active') throw new ConflictException('That session is not active. Sign in to the customer tenant again, or pick another.');
      const plan = await this.plan(t, requestId).catch(() => null);
      if (!plan || plan.fingerprint !== p.fingerprint || !plan.verdict.ok) {
        const error = 'The plan changed after the assistant proposed it (or is no longer clean), so it was not approved. Ask the assistant to propose it again.';
        await s.updateTable('service_request_actions').set({ state: 'failed', error, finished_at: now }).where('id', '=', p.id).where('state', '=', 'proposed').execute();
        await s.insertInto('service_request_events').values({ request_id: requestId, kind: 'proposal_decided', body: `${agentLabel(agentName)}'s deploy proposal was not approved: ${error}`, internal: true, author_id: user.id, actor_type: 'user', meta: JSON.stringify({ proposalId: p.id, state: 'failed' }) }).execute();
        throw new ConflictException(error);
      }
      connectionId = conn.id;
    }

    // Claim the decision first, so two people clicking at once can't both act.
    const claimed = await s
      .updateTable('service_request_actions')
      .set({ state: input.decision === 'reject' ? 'rejected' : SR_PROPOSAL_KINDS[kind].server ? 'running' : 'approved', decided_by: user.id, decided_at: now, decision_note: note, connection_id: connectionId, ...(input.decision === 'reject' ? { finished_at: now } : {}) })
      .where('id', '=', p.id)
      .where('state', '=', 'proposed')
      .returning('id')
      .executeTakeFirst();
    if (!claimed) throw new ConflictException('Someone else just decided this proposal.');

    const decided = async (state: string, extra: { error?: string } = {}) => {
      await s
        .insertInto('service_request_events')
        .values({
          request_id: requestId,
          kind: 'proposal_decided',
          body: `${user.displayName} ${input.decision === 'reject' ? 'rejected' : 'approved'} ${agentLabel(agentName)}'s proposal: ${summary}${note ? `\n${note}` : ''}${extra.error ? `\nIt could not be carried out: ${extra.error}` : ''}`,
          internal: true,
          author_id: user.id,
          actor_type: 'user',
          meta: JSON.stringify({ proposalId: p.id, state, decision: input.decision }),
        })
        .execute();
      await this.audit.tenant(t.schema, 'service_request.proposal_decided', { actor: { id: user.id, email: user.email }, targetType: 'service_request', targetId: requestId, detail: { reference: srReference(req.number), proposalId: p.id, kind, decision: input.decision, state, connectionId } });
      await this.events.emitRequest(t.id, await this.loadRequest(t, requestId), 'sr.proposal.decided', { proposalId: p.id, proposalKind: kind, decision: input.decision, state, note }, p.agent_id);
    };

    if (input.decision === 'reject') {
      await decided('rejected');
      return this.get(t, p.id);
    }
    if (!SR_PROPOSAL_KINDS[kind].server) {
      const policy = await platformDb(this.db).selectFrom('agent_customer_policy').select(['enabled', 'autonomy']).where('agent_id', '=', p.agent_id).where('tenant_id', '=', t.id).executeTakeFirst();
      const level = agentLevel(policy?.autonomy, p.action_class as AgentActionClass);
      if (!policy?.enabled || !agentMayExecuteApproved(level)) {
        const error = `${agentLabel(agentName)} is not allowed to carry out this kind of step on this customer (its autonomy for "${p.action_class}" is below "Act with approval").`;
        await s.updateTable('service_request_actions').set({ state: 'failed', error, finished_at: now }).where('id', '=', p.id).execute();
        await decided('failed', { error });
        return this.get(t, p.id);
      }
      await decided('approved');
      return this.get(t, p.id);
    }
    try {
      const result = await this.execute(t, kind, p.params, req.id, agent ? { id: agent.id, name: agent.name } : { id: p.agent_id, name: agentName });
      await s.updateTable('service_request_actions').set({ state: 'done', result: JSON.stringify(result), finished_at: new Date().toISOString() }).where('id', '=', p.id).execute();
      await decided('done');
    } catch (e) {
      const error = e instanceof HttpException ? String((e.getResponse() as { message?: unknown })?.message ?? e.message) : (e as Error).message;
      await s.updateTable('service_request_actions').set({ state: 'failed', error, finished_at: new Date().toISOString() }).where('id', '=', p.id).execute();
      await decided('failed', { error });
    }
    return this.get(t, p.id);
  }

  private async get(t: TenantContext, id: string) {
    const p = await tenantDb(this.db, t.schema).selectFrom('service_request_actions').selectAll().where('id', '=', id).executeTakeFirstOrThrow();
    return { ...p, summary: srProposalSummary(p.kind as SrProposalKind, p.params) };
  }

  /** Does what an approved reply or status move says, as the assistant (the approver is on the timeline). */
  private async execute(t: TenantContext, kind: SrProposalKind, params: Record<string, unknown>, requestId: string, agent: { id: string; name: string }): Promise<Record<string, unknown>> {
    const actor = agentActor(agent);
    switch (kind) {
      case 'comment':
        await this.requests.comment(t, actor, requestId, { body: String(params.body) }, true);
        return { posted: true };
      case 'status': {
        const r = await this.requests.move(t, actor, requestId, { to: params.to as never, note: params.note as string | undefined }, true);
        return { status: r.status };
      }
      case 'external':
        throw new BadRequestException('That step is carried out by the assistant, not the platform.');
    }
  }

  /** The assistant reports on a step it carried out after approval. A deploy's outcome is recorded by the platform, not claimed by the assistant. */
  async reportResult(t: TenantContext, agent: { id: string; name: string }, autonomy: AgentAutonomy, requestId: string, proposalId: string, input: AgentProposalResultInput) {
    const s = tenantDb(this.db, t.schema);
    const p = await s.selectFrom('service_request_actions').selectAll().where('id', '=', proposalId).where('request_id', '=', requestId).executeTakeFirst();
    if (!p || p.agent_id !== agent.id) throw new NotFoundException('proposal not found');
    if (SR_PROPOSAL_KINDS[p.kind as SrProposalKind].server) throw new BadRequestException('The platform carried that one out; there is nothing to report.');
    if (p.action_class === 'change_deploy') throw new BadRequestException('A deployment reports its own outcome. Read the request to see how it went.');
    if (AGENT_PROPOSAL_FINAL.includes(p.state)) throw new ConflictException(`This proposal is already ${p.state}.`);
    if (p.state === 'proposed') throw new ConflictException('A person has not approved this yet.');
    if (!agentMayExecuteApproved(agentLevel(autonomy, p.action_class as AgentActionClass))) throw new ForbiddenException('Your autonomy no longer allows carrying this out.');
    if (input.state === 'running' && p.state === 'running') return this.get(t, p.id);
    const now = new Date().toISOString();
    await s
      .updateTable('service_request_actions')
      .set({ state: input.state, ...(input.result ? { result: JSON.stringify(input.result) } : {}), error: input.state === 'failed' ? (input.error ?? 'It failed.') : null, ...(input.state === 'running' ? {} : { finished_at: now }) })
      .where('id', '=', p.id)
      .execute();
    const req = await this.loadRequest(t, requestId);
    await s
      .insertInto('service_request_events')
      .values({ request_id: requestId, kind: 'proposal_decided', body: `${agentLabel(agent.name)} reports: ${srProposalSummary(p.kind as SrProposalKind, p.params)} - ${input.state}${input.error ? `: ${input.error}` : ''}`, internal: true, author_id: agent.id, actor_type: 'agent', meta: JSON.stringify({ proposalId: p.id, state: input.state }) })
      .execute();
    if (input.state === 'failed') {
      const failed = await s.selectFrom('service_request_actions').select('id').where('request_id', '=', requestId).where('agent_id', '=', agent.id).where('state', '=', 'failed').where('finished_at', '>', new Date(Date.now() - 24 * 3_600_000).toISOString()).execute();
      if (failed.length >= AGENT_MAX_FAILURES) {
        await this.claims.lapse(t, req, agent, `${failed.length} steps failed`);
        await this.requests.notifyTeam(t, req, 'agent_lapsed', agentLabel(agent.name), `${failed.length} steps failed, so it stopped.`);
      }
    }
    return this.get(t, p.id);
  }
}
