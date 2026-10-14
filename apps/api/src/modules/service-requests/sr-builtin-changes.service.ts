import { HttpException, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { tenantDb } from '@tvmf/db';
import {
  BUILTIN_BATCH,
  BUILTIN_LEASE_SECONDS,
  BUILTIN_SETTLE_SECONDS,
  agentEffectiveAutonomy,
  srAutomation,
  srIsFollowUp,
  type AgentAutonomy,
} from '@tvmf/shared';
import type { AgentPrincipal } from '../../common/request';
import { InjectDb, type Db } from '../../db/db.module';
import { BuiltinAgentsService } from '../incidents/builtin-agents.service';
import { SrAgentApiService } from './sr-agent-api.service';

const WEEK_MS = 7 * 86_400_000;

/**
 * Voxshift Changes (docs/SERVICE-REQUEST-AGENTS.md): the built-in assistant that carries change and removal requests through. For
 * a request that maps completely onto Design & Build it plans it, applies it, signs the design off and runs the What-If, then
 * proposes the deployment with the exact commands. It deploys only a proposal a person approved, through the same agent API (and
 * so the same guardrails) as any assistant; anything it cannot do cleanly it hands over. It needs "act alone" for triage, applying
 * the design and What-If, and "act with approval" for deploying; below that it does nothing.
 */
@Injectable()
export class SrBuiltinChangesService implements OnModuleInit {
  private readonly log = new Logger('BuiltinChanges');

  constructor(
    @InjectDb() private readonly db: Db,
    private readonly api: SrAgentApiService,
    private readonly builtin: BuiltinAgentsService,
  ) {}

  onModuleInit() {
    this.builtin.register('changes', (p, tenantId, schema, autonomy, now) => this.work(p, tenantId, schema, autonomy, now));
  }

  /** One pass for one customer: deploy what was approved, then prepare what is waiting. Returns how many requests it moved. */
  async work(p: AgentPrincipal, tenantId: string, schema: string, autonomy: AgentAutonomy, now: Date): Promise<number> {
    const levels = agentEffectiveAutonomy(autonomy);
    let done = 0;
    if (levels.change_deploy >= 2) done += await this.deployApproved(p, tenantId, schema);
    if (levels.triage >= 3 && levels.change_design >= 3 && levels.change_whatif >= 3 && levels.internal_note >= 1) done += await this.prepare(p, tenantId, schema, levels.change_deploy, now);
    return done;
  }

  /** Requests nobody has, that it could carry through, and has not already prepared. */
  private async candidates(schema: string, agentId: string, now: Date) {
    const s = tenantDb(this.db, schema);
    const rows = await s
      .selectFrom('service_requests as r')
      .select(['r.id as id', 'r.type as type', 'r.details as details', 'r.status as status', 'r.approval_status as approval_status'])
      .where('r.status', 'in', ['new', 'planned'])
      .where('r.assigned_to', 'is', null)
      .where('r.assigned_agent_id', 'is', null)
      .where('r.agent_hold', '=', false)
      .where('r.waiting_since', 'is', null)
      .where((eb) => eb.or([eb('r.approval_status', 'is', null), eb('r.approval_status', '=', 'approved')]))
      .where('r.created_at', '<=', new Date(now.getTime() - BUILTIN_SETTLE_SECONDS * 1000).toISOString())
      .where('r.created_at', '>=', new Date(now.getTime() - WEEK_MS).toISOString())
      .where((eb) => eb.not(eb.exists(eb.selectFrom('service_request_claims as c').select('c.id').whereRef('c.request_id', '=', 'r.id').where('c.released_at', 'is', null))))
      // Once only: anything it has already proposed on or handed over is not picked up again.
      .where((eb) => eb.not(eb.exists(eb.selectFrom('service_request_actions as a').select('a.id').whereRef('a.request_id', '=', 'r.id').where('a.agent_id', '=', agentId))))
      .where((eb) => eb.not(eb.exists(eb.selectFrom('service_request_events as e').select('e.id').whereRef('e.request_id', '=', 'r.id').where('e.author_id', '=', agentId).where('e.kind', 'in', ['handoff', 'whatif']))))
      .orderBy('r.created_at')
      .limit(BUILTIN_BATCH * 3)
      .execute();
    return rows.filter((r) => srAutomation(r.type, (r.details ?? {}) as Record<string, unknown>, r.status).eligible).slice(0, BUILTIN_BATCH);
  }

  private async prepare(p: AgentPrincipal, tenantId: string, schema: string, deployLevel: number, now: Date): Promise<number> {
    let done = 0;
    for (const { id } of await this.candidates(schema, p.agentId, now)) {
      try {
        await this.api.claim(p, tenantId, id, { ttlSeconds: BUILTIN_LEASE_SECONDS, note: 'Preparing this change' });
      } catch (e) {
        if (e instanceof HttpException && e.getStatus() === 409) continue;
        throw e;
      }
      try {
        if (await this.prepareOne(p, tenantId, id, deployLevel)) done++;
      } finally {
        await this.api.release(p, tenantId, id).catch(() => undefined);
      }
    }
    return done;
  }

  /** Plan, apply, sign off, What-If, propose (or hand over). */
  private async prepareOne(p: AgentPrincipal, tenantId: string, id: string, deployLevel: number): Promise<boolean> {
    const handOver = async (found: string, tried: string[], recommendation: string) => {
      await this.api.handoff(p, tenantId, id, { to: 'queue', summary: { tried, found: [found], recommendation, confidence: 'high', evidence: [] } }).catch(() => undefined);
      return false;
    };
    const tried: string[] = [];
    try {
      const before = await this.api.get(p, tenantId, id);
      const ref = before.request.reference;
      if (before.request.status === 'new') {
        await this.api.status(p, tenantId, id, { to: 'planned' });
        tried.push('Moved it to Planned');
      }
      const applied = await this.api.apply(p, tenantId, id, {});
      tried.push(`Applied the request to the design: ${(applied.result.applied ?? []).join(', ') || 'nothing new'}`);
      // Follow-ups for after the deployment are fine; anything else the apply could not do is for a person.
      const blockers = (applied.result.warnings ?? []).filter((w) => !srIsFollowUp(w));
      if (blockers.length) return handOver(`The design needs a look: ${blockers.join('; ')}`, tried, 'An engineer should finish the design by hand.');
      if (applied.design.builtBlockers.length) return handOver(`The design is not ready to sign off: ${applied.design.builtBlockers.join(' ')}`, tried, 'An engineer should finish the design by hand.');
      await this.api.status(p, tenantId, id, { to: 'built' });
      tried.push('Signed the design off (Designed & built)');
      const w = await this.api.whatIf(p, tenantId, id, {});
      tried.push(w.summary);
      if (!w.verdict.ok) return handOver(w.verdict.reasons.join(' '), tried, 'An engineer should look at why the What-If is not clean before anything is deployed.');
      const a = srAutomation(before.request.type, (before.request.details ?? {}) as Record<string, unknown>, 'built');
      const what = a.applies.length ? a.applies.join(', ') : 'the requested change';
      const commands = w.commands.flatMap((c) => c.commands);
      if (deployLevel >= 1) {
        await this.api.propose(p, tenantId, id, {
          kind: 'external',
          params: { actionClass: 'change_deploy', title: `Deploy ${ref}: ${what}`, detail: `${commands.length} command${commands.length === 1 ? '' : 's'}, no warnings.` },
          rationale: `The design is signed off and the What-If is clean (${w.verdict.calls} change${w.verdict.calls === 1 ? '' : 's'}, no warnings). Approve it onto your own tenant session to deploy exactly these commands.`,
          risk: 'low',
          expiresInMinutes: 24 * 60,
        });
      }
      await this.api.note(p, tenantId, id, {
        body: [
          `Prepared ${ref}: ${what}.`,
          ...tried.map((t) => `- ${t}`),
          deployLevel >= 1 ? 'Proposed the deployment: it runs only if a person approves it (on their own tenant session) and the plan is unchanged.' : 'My autonomy does not allow proposing a deployment, so a person should deploy it.',
          a.followUps.length ? `After it is deployed, a person should: ${a.followUps.join(' ')}` : '',
          'I am an automated assistant working from rules.',
        ]
          .filter(Boolean)
          .join('\n'),
      });
      return true;
    } catch (e) {
      if (e instanceof HttpException && e.getStatus() === 409) {
        const msg = String((e.getResponse() as { message?: unknown })?.message ?? e.message);
        // A person took it over, or someone else holds it: leave it. Anything else: hand over with what happened.
        if (/taken|holds this request|Another assistant/.test(msg)) return false;
        return handOver(`It could not be carried through: ${msg}`, tried, 'An engineer should take it from here.');
      }
      this.log.warn(`preparing ${id}: ${(e as Error).message}`);
      return handOver(`It could not be carried through: ${(e as Error).message}`, tried, 'An engineer should take it from here.');
    }
  }

  /** Proposals a person approved: deploy them, as approved. The platform checks everything again; a refusal goes on the timeline. */
  private async deployApproved(p: AgentPrincipal, tenantId: string, schema: string): Promise<number> {
    const s = tenantDb(this.db, schema);
    const rows = await s.selectFrom('service_request_actions').select(['id', 'request_id']).where('agent_id', '=', p.agentId).where('kind', '=', 'external').where('action_class', '=', 'change_deploy').where('state', '=', 'approved').limit(5).execute();
    let done = 0;
    for (const r of rows) {
      try {
        await this.api.claim(p, tenantId, r.request_id, { ttlSeconds: BUILTIN_LEASE_SECONDS, note: 'Deploying what was approved' });
      } catch {
        continue;
      }
      try {
        await this.api.deploy(p, tenantId, r.request_id, { proposalId: r.id });
        done++;
      } catch (e) {
        const msg = e instanceof HttpException ? String((e.getResponse() as { message?: unknown })?.message ?? e.message) : (e as Error).message;
        await this.api.note(p, tenantId, r.request_id, { body: `I did not deploy what you approved: ${msg}` }).catch(() => undefined);
        await this.api.handoff(p, tenantId, r.request_id, { to: 'queue', summary: { tried: ['Checked the approved deployment against the request as it is now'], found: [msg], recommendation: 'An engineer should decide whether to propose the deployment again.', confidence: 'high', evidence: [] } }).catch(() => undefined);
      } finally {
        // The deployment (and its live re-check) report back on their own: letting go now keeps the lease from lapsing while it runs.
        await this.api.release(p, tenantId, r.request_id).catch(() => undefined);
      }
    }
    return done;
  }
}
