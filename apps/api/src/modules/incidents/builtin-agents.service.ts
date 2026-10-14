import { BadRequestException, HttpException, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { platformDb, tenantDb } from '@tvmf/db';
import {
  BUILTIN_BATCH,
  BUILTIN_LEASE_SECONDS,
  BUILTIN_SETTLE_SECONDS,
  COMMS_CADENCE_MINUTES,
  DIAG_RUNBOOKS,
  INC_LIVE_STATUSES,
  agentEffectiveAutonomy,
  agentLabel,
  diagSuggest,
  commsDraft,
  commsDue,
  diagnoseOutcome,
  triageAnalysis,
  type AgentAutonomy,
  type AskAssistantInput,
  type BuiltinAgentKey,
  type DiagResult,
  type DiagRunbookKey,
  type IncStatus,
} from '@tvmf/shared';
import type { AgentPrincipal, AuthedUser, TenantContext } from '../../common/request';
import { InjectDb, type Db } from '../../db/db.module';
import { actorCols } from './agent-actor';
import { AgentApiService } from './agent-api.service';
import { AgentEventsService } from './agent-events.service';

type Levels = ReturnType<typeof agentEffectiveAutonomy>;
export interface BuiltinStats {
  triage: number;
  diagnose: number;
  comms: number;
  changes: number;
  errors: number;
}

/** A built-in assistant whose work lives outside this module (Voxshift Changes works service requests). */
export type BuiltinRoutine = (p: AgentPrincipal, tenantId: string, schema: string, autonomy: AgentAutonomy, now: Date) => Promise<number>;

const WEEK_MS = 7 * 86_400_000;

/**
 * Runs the assistants Voxshift ships (Triage, Diagnose, Comms; docs/BUILTIN-AGENTS.md). Each is a normal agent: a row
 * in `platform.agents` that a Super Admin adds and enables per customer, with its own autonomy policy. They do their
 * work through the same agent API as any outside agent (`AgentApiService`), so the same rules hold for them: the
 * customer's policy, a held lease for anything that changes the incident, proposals for what they may not do alone,
 * and everything on the timeline as "(AI)". A pass runs every 30 seconds (BUILTIN_AGENTS_INTERVAL_SECONDS, 0 = off).
 */
@Injectable()
export class BuiltinAgentsService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger('BuiltinAgents');
  private timer?: NodeJS.Timeout;
  private running = false;
  private readonly routines = new Map<string, BuiltinRoutine>();

  constructor(
    @InjectDb() private readonly db: Db,
    private readonly api: AgentApiService,
    private readonly events: AgentEventsService,
  ) {}

  onModuleInit() {
    const every = Number(process.env.BUILTIN_AGENTS_INTERVAL_SECONDS ?? 30);
    if (process.env.NODE_ENV === 'test' || process.env.VITEST || !(every > 0)) return;
    this.timer = setInterval(() => void this.tick().catch((e) => this.log.error(`pass failed: ${(e as Error).message}`)), every * 1000);
    this.timer.unref();
  }

  /** Lets another module supply the work of a built-in assistant. */
  register(key: BuiltinAgentKey, routine: BuiltinRoutine) {
    this.routines.set(key, routine);
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  /** One pass over every customer each built-in assistant is allowed on. */
  async tick(opts: { tenantId?: string; now?: Date } = {}): Promise<BuiltinStats> {
    const stats: BuiltinStats = { triage: 0, diagnose: 0, comms: 0, changes: 0, errors: 0 };
    if (this.running) return stats;
    this.running = true;
    try {
      const p = platformDb(this.db);
      const kill = await p.selectFrom('agent_kill_switch').select('all_disabled').where('id', '=', 1).executeTakeFirst();
      if (kill?.all_disabled) return stats;
      const agents = await p.selectFrom('agents').select(['id', 'name', 'kind', 'builtin_key']).where('builtin_key', 'is not', null).where('status', '=', 'active').execute();
      for (const a of agents) {
        let q = p
          .selectFrom('agent_customer_policy as cp')
          .innerJoin('tenants as t', 't.id', 'cp.tenant_id')
          .select(['t.id as id', 't.schema_name as schema', 'cp.autonomy as autonomy'])
          .where('cp.agent_id', '=', a.id)
          .where('cp.enabled', '=', true)
          .where('t.status', '=', 'active')
          .where('t.managed_services_enabled', '=', true)
          .where('t.agents_enabled', '=', true);
        if (opts.tenantId) q = q.where('t.id', '=', opts.tenantId);
        const tenants = await q.execute();
        const principal: AgentPrincipal = { agentId: a.id, tokenId: 'builtin', name: a.name, kind: a.kind, scopes: ['read', 'note', 'propose', 'act'] };
        for (const t of tenants) {
          const levels = agentEffectiveAutonomy((t.autonomy ?? {}) as AgentAutonomy);
          const key = a.builtin_key as BuiltinAgentKey;
          try {
            const now = opts.now ?? new Date();
            if (key === 'triage') stats.triage += await this.triage(principal, t.id, t.schema, levels, now);
            else if (key === 'diagnose') stats.diagnose += await this.diagnose(principal, t.id, t.schema, levels, now);
            else if (key === 'comms') stats.comms += await this.comms(principal, t.id, t.schema, levels, now);
            else stats.changes += (await this.routines.get(key)?.(principal, t.id, t.schema, (t.autonomy ?? {}) as AgentAutonomy, now)) ?? 0;
          } catch (e) {
            stats.errors++;
            this.log.warn(`${a.name} on ${t.id}: ${(e as Error).message}`);
          }
        }
        if (tenants.length) await p.updateTable('agents').set({ last_seen_at: new Date().toISOString() }).where('id', '=', a.id).execute();
      }
    } finally {
      this.running = false;
    }
    return stats;
  }

  /* ------------------------------ finding work ------------------------------ */

  /** New-ish incidents nobody has, that this assistant has not already written on. */
  private async candidates(schema: string, agentId: string, statuses: IncStatus[], now: Date, opts: { undiagnosed?: boolean } = {}) {
    const s = tenantDb(this.db, schema);
    let q = s
      .selectFrom('incidents as i')
      .select(['i.id as id'])
      .where('i.status', 'in', statuses)
      .where('i.assigned_to', 'is', null)
      .where('i.assigned_agent_id', 'is', null)
      .where('i.agent_hold', '=', false)
      .where('i.major', '=', false)
      .where('i.created_at', '<=', new Date(now.getTime() - BUILTIN_SETTLE_SECONDS * 1000).toISOString())
      .where('i.created_at', '>=', new Date(now.getTime() - WEEK_MS).toISOString())
      .where((eb) => eb.not(eb.exists(eb.selectFrom('incident_claims as c').select('c.id').whereRef('c.incident_id', '=', 'i.id').where('c.released_at', 'is', null))))
      .where((eb) => eb.not(eb.exists(eb.selectFrom('incident_events as e').select('e.id').whereRef('e.incident_id', '=', 'i.id').where('e.author_id', '=', agentId).where('e.kind', 'in', ['comment', 'handoff']))));
    if (opts.undiagnosed) q = q.where((eb) => eb.not(eb.exists(eb.selectFrom('incident_diagnostics as d').select('d.id').whereRef('d.incident_id', '=', 'i.id'))));
    return q.orderBy('i.priority').orderBy('i.created_at').limit(BUILTIN_BATCH).execute();
  }

  /* ------------------------------ Triage ------------------------------ */

  private async triage(p: AgentPrincipal, tenantId: string, schema: string, levels: Levels, now: Date): Promise<number> {
    if (levels.internal_note < 1 || levels.triage < 1) return 0;
    let done = 0;
    for (const { id } of await this.candidates(schema, p.agentId, ['new'], now)) if (await this.triageOne(p, tenantId, id, levels, now)) done++;
    return done;
  }

  /** Triage one incident: take the lease, note, propose, acknowledge or propose it, let go. False if someone else had it. */
  private async triageOne(p: AgentPrincipal, tenantId: string, id: string, levels: Levels, now: Date): Promise<boolean> {
    try {
      await this.api.claim(p, tenantId, id, { ttlSeconds: BUILTIN_LEASE_SECONDS, note: 'Triage' });
    } catch (e) {
      if (e instanceof HttpException && e.getStatus() === 409) return false; // someone else got there first
      throw e;
    }
    try {
      const ctx = await this.api.get(p, tenantId, id);
      const inc = ctx.incident;
      const out = triageAnalysis({
        incident: { reference: inc.reference, title: inc.title, priority: inc.priority, status: inc.status, category: inc.category, sitecode: inc.sitecode, created_at: inc.created_at, problem_id: ctx.problem?.id ?? null, major: inc.major },
        knownErrors: ctx.knownErrors.map((k) => ({ id: k.id, reference: k.reference, title: k.title, workaround: 'workaround' in k ? (k.workaround ?? '') : '' })),
        similar: ctx.similar,
        now,
      });
      await this.api.note(p, tenantId, id, { body: out.note });
      for (const pr of out.proposals) {
        await this.api.propose(p, tenantId, id, { kind: pr.kind, params: pr.params, rationale: pr.rationale, risk: pr.risk, expiresInMinutes: 480 }).catch(() => undefined);
      }
      if (inc.status === 'new' && !inc.major) {
        if (levels.triage >= 3) await this.api.status(p, tenantId, id, { to: 'in_progress' }).catch(() => undefined);
        else await this.api.propose(p, tenantId, id, { kind: 'status_change', params: { to: 'in_progress' }, rationale: 'Triage is done and an engineer should pick this up.', risk: 'low', expiresInMinutes: 480 }).catch(() => undefined);
      }
      return true;
    } finally {
      await this.api.release(p, tenantId, id).catch(() => undefined);
    }
  }

  /* ------------------------------ Diagnose ------------------------------ */

  private async diagnose(p: AgentPrincipal, tenantId: string, schema: string, levels: Levels, now: Date): Promise<number> {
    if (levels.internal_note < 1 || levels.diagnostic_read < 1) return 0;
    let done = 0;
    if (levels.diagnostic_read >= 2 && levels.diagnostic_read < 3) done += await this.runApproved(p, tenantId, schema);
    for (const { id } of await this.candidates(schema, p.agentId, ['new', 'in_progress'], now, { undiagnosed: true })) if (await this.diagnoseOne(p, tenantId, id, levels)) done++;
    return done;
  }

  /**
   * Diagnose one incident by what its autonomy allows. `question` is a person's request ("check anna@contoso.com"):
   * emails and numbers in it become checks too. Returns what it did, or null if someone else had the incident.
   */
  private async diagnoseOne(p: AgentPrincipal, tenantId: string, id: string, levels: Levels, question?: string): Promise<{ ran: number; proposed: number; handedOff: boolean } | null> {
    try {
      await this.api.claim(p, tenantId, id, { ttlSeconds: BUILTIN_LEASE_SECONDS, note: 'Diagnosis' });
    } catch (e) {
      if (e instanceof HttpException && e.getStatus() === 409) return null;
      throw e;
    }
    try {
      const ctx = await this.api.get(p, tenantId, id);
      const ref = ctx.incident.reference;
      const fromQuestion = question ? diagSuggest({ category: ctx.incident.category, items: [], answers: { numbers: question }, description: question }).filter((x) => x.runbook !== 'recent_changes' && x.input) : [];
      const seen = new Set<string>();
      const checks = [...fromQuestion, ...ctx.suggestedChecks].filter((c) => !seen.has(`${c.runbook}|${c.input.toLowerCase()}`) && (seen.add(`${c.runbook}|${c.input.toLowerCase()}`), true));
      const out = { ran: 0, proposed: 0, handedOff: false };
      if (levels.diagnostic_read >= 3) {
        const results: DiagResult[] = [];
        for (const c of checks.slice(0, 5)) {
          try {
            results.push(await this.api.diagnostic(p, tenantId, id, { runbook: c.runbook, input: c.input || undefined }));
          } catch (e) {
            // A check that cannot run (no such queue named) is not a finding; the rest still matter.
            if (e instanceof HttpException && e.getStatus() === 409) throw e; // taken over or lease lost: stop
          }
        }
        out.ran = results.length;
        const o = diagnoseOutcome(ref, results);
        if (o.hasProblem && results.length) {
          await this.api.handoff(p, tenantId, id, { to: 'queue', summary: { tried: o.tried, found: o.found, recommendation: o.recommendation, confidence: o.confidence, evidence: [] } });
          out.handedOff = true;
        } else {
          await this.api.note(p, tenantId, id, { body: o.note });
        }
      } else if (levels.diagnostic_read === 2) {
        const wanted = checks.filter((c) => c.runbook !== 'recent_changes').slice(0, 2);
        for (const c of wanted) {
          await this.api
            .propose(p, tenantId, id, {
              kind: 'external',
              params: { actionClass: 'diagnostic_read', title: `Run: ${DIAG_RUNBOOKS[c.runbook].label}${c.input ? `: ${c.input}` : ''}`, detail: c.why, args: { runbook: c.runbook, input: c.input } },
              rationale: c.why,
              risk: 'low',
              expiresInMinutes: 480,
            })
            .then(() => out.proposed++)
            .catch(() => undefined);
        }
        await this.api.note(p, tenantId, id, { body: `Diagnosis of ${ref}: ${wanted.length ? `proposed ${wanted.length} read-only check${wanted.length === 1 ? '' : 's'} for a person to approve. I run them once approved.` : 'no check is worth running from what the incident says.'}` });
      } else {
        await this.api.note(p, tenantId, id, { body: `Diagnosis of ${ref}: checks worth running: ${checks.map((c) => `${DIAG_RUNBOOKS[c.runbook].label}${c.input ? ` (${c.input})` : ''}`).join('; ') || 'none'}. I am set to suggest only, so I have not run them.` });
      }
      return out;
    } finally {
      await this.api.release(p, tenantId, id).catch(() => undefined);
    }
  }

  /** Checks a person approved: run them (this is what "act with approval" means), which marks each proposal done. */
  private async runApproved(p: AgentPrincipal, tenantId: string, schema: string): Promise<number> {
    const s = tenantDb(this.db, schema);
    const rows = await s.selectFrom('incident_actions').select(['id', 'incident_id', 'params']).where('agent_id', '=', p.agentId).where('kind', '=', 'external').where('action_class', '=', 'diagnostic_read').where('state', '=', 'approved').limit(10).execute();
    let done = 0;
    for (const r of rows) {
      const args = ((r.params as Record<string, unknown>).args ?? {}) as { runbook?: string; input?: string };
      if (!args.runbook || !(args.runbook in DIAG_RUNBOOKS)) continue;
      try {
        await this.api.claim(p, tenantId, r.incident_id, { ttlSeconds: BUILTIN_LEASE_SECONDS, note: 'Running an approved check' });
        try {
          await this.api.diagnostic(p, tenantId, r.incident_id, { runbook: args.runbook as DiagRunbookKey, input: args.input || undefined, proposalId: r.id });
          done++;
        } finally {
          await this.api.release(p, tenantId, r.incident_id).catch(() => undefined);
        }
      } catch (e) {
        this.log.warn(`approved check ${r.id}: ${(e as Error).message}`);
      }
    }
    return done;
  }

  /* ------------------------------ Comms ------------------------------ */

  /** On P1 and P2 incidents with no update for a while, proposes one for a person to approve. */
  private async comms(p: AgentPrincipal, tenantId: string, schema: string, levels: Levels, now: Date): Promise<number> {
    if (levels.customer_update < 1) return 0;
    const s = tenantDb(this.db, schema);
    const incidents = await s
      .selectFrom('incidents')
      .select(['id', 'title', 'priority', 'status', 'hold_reason', 'major', 'created_at', 'reporter_id'])
      .where('priority', 'in', ['p1', 'p2'])
      .where('status', 'in', ['new', 'in_progress', 'on_hold'])
      .where('major', '=', false)
      .where('agent_hold', '=', false)
      .execute();
    if (!incidents.length) return 0;
    const ids = incidents.map((i) => i.id);
    const [events, mine] = await Promise.all([
      s.selectFrom('incident_events').select(['incident_id', 'author_id', 'created_at']).where('incident_id', 'in', ids).where('internal', '=', false).where('kind', 'in', ['comment', 'waiting', 'status_changed']).orderBy('created_at', 'desc').execute(),
      s.selectFrom('incident_actions').select(['incident_id', 'created_at']).where('agent_id', '=', p.agentId).where('kind', '=', 'customer_update').where('incident_id', 'in', ids).orderBy('created_at', 'desc').execute(),
    ]);
    let drafted = 0;
    for (const i of incidents) {
      const last = events.find((e) => e.incident_id === i.id && e.author_id !== i.reporter_id)?.created_at ?? null;
      const cadence = COMMS_CADENCE_MINUTES[i.priority] ?? 120;
      const lastDraft = mine.find((m) => m.incident_id === i.id)?.created_at;
      if (lastDraft && now.getTime() - new Date(lastDraft).getTime() < cadence * 60_000) continue;
      if (!commsDue({ priority: i.priority, status: i.status, holdReason: i.hold_reason, major: i.major, createdAt: i.created_at, lastPublicUpdateAt: last, title: i.title, now })) continue;
      if (await this.draftUpdate(p, tenantId, i, last, now).catch((e) => (this.log.debug(`comms ${i.id}: ${(e as Error).message}`), false))) drafted++;
    }
    return drafted;
  }

  /** Proposes one templated update for a person to approve. */
  private async draftUpdate(p: AgentPrincipal, tenantId: string, i: { id: string; title: string; priority: 'p1' | 'p2' | 'p3' | 'p4'; status: IncStatus; hold_reason: Parameters<typeof commsDraft>[0]['holdReason']; created_at: string }, last: string | null, now: Date): Promise<boolean> {
    const cadence = COMMS_CADENCE_MINUTES[i.priority] ?? 120;
    await this.api.propose(p, tenantId, i.id, {
      kind: 'customer_update',
      params: { body: commsDraft({ priority: i.priority, status: i.status, holdReason: i.hold_reason, major: false, createdAt: i.created_at, lastPublicUpdateAt: last, title: i.title, now }) },
      rationale: `No update has gone to the customer for ${Math.round((now.getTime() - new Date(last ?? i.created_at).getTime()) / 60_000)} minutes (the target for ${i.priority.toUpperCase()} is ${cadence}).`,
      risk: 'low',
      expiresInMinutes: Math.max(30, cadence),
    });
    return true;
  }

  /* ------------------------------ Ask the assistant ------------------------------ */

  /**
   * A person asks an assistant to look at an incident now. It goes on the timeline (internal) and to the assistant as an
   * `incident.assist_requested` event, so an outside agent picks it up from its feed or webhook. A built-in assistant
   * does its job straight away, within its autonomy for this customer.
   */
  async ask(t: TenantContext, user: AuthedUser, incidentId: string, input: AskAssistantInput): Promise<{ delivered: 'builtin' | 'event'; message: string }> {
    const p = platformDb(this.db);
    const agent = await p.selectFrom('agents').select(['id', 'name', 'kind', 'status', 'builtin_key']).where('id', '=', input.agentId).executeTakeFirst();
    if (!agent) throw new BadRequestException('That assistant does not exist.');
    if (agent.builtin_key === 'changes') throw new BadRequestException('Voxshift Changes works service requests. Assign a request to it from the request page.');
    const kill = await p.selectFrom('agent_kill_switch').select('all_disabled').where('id', '=', 1).executeTakeFirst();
    if (kill?.all_disabled) throw new BadRequestException('All assistants are switched off.');
    if (agent.status !== 'active') throw new BadRequestException(`${agentLabel(agent.name)} is ${agent.status}.`);
    const policy = await p
      .selectFrom('agent_customer_policy as cp')
      .innerJoin('tenants as tn', 'tn.id', 'cp.tenant_id')
      .select(['cp.autonomy as autonomy'])
      .where('cp.agent_id', '=', agent.id)
      .where('cp.tenant_id', '=', t.id)
      .where('cp.enabled', '=', true)
      .where('tn.agents_enabled', '=', true)
      .executeTakeFirst();
    if (!policy) throw new BadRequestException(`${agentLabel(agent.name)} is not allowed on this customer.`);
    const s = tenantDb(this.db, t.schema);
    const row = await s.selectFrom('incidents').selectAll().where('id', '=', incidentId).executeTakeFirst();
    if (!row) throw new BadRequestException('That incident does not exist.');
    if (!INC_LIVE_STATUSES.includes(row.status)) throw new BadRequestException('This incident is finished.');
    if (row.agent_hold) throw new BadRequestException('You took this incident over. Hand it back to an assistant before asking one to work on it.');

    await s.insertInto('incident_events').values({ incident_id: incidentId, kind: 'comment', body: `Asked ${agentLabel(agent.name)}: ${input.question}`, internal: true, ...actorCols(user) }).execute();
    await this.events.emit(t.id, row, 'incident.assist_requested', { question: input.question, askedBy: user.displayName }, agent.id);

    if (!agent.builtin_key) return { delivered: 'event', message: `Sent to ${agentLabel(agent.name)}. It will reply on the timeline.` };
    const principal: AgentPrincipal = { agentId: agent.id, tokenId: 'builtin', name: agent.name, kind: agent.kind, scopes: ['read', 'note', 'propose', 'act'] };
    const levels = agentEffectiveAutonomy((policy.autonomy ?? {}) as AgentAutonomy);
    const now = new Date();
    const blocked = (what: string) => ({ delivered: 'builtin' as const, message: `${agentLabel(agent.name)} is set to observe only for ${what} on this customer, so it cannot help yet. Change that on Administration → Assistants.` });
    try {
      if (agent.builtin_key === 'triage') {
        if (levels.internal_note < 1 || levels.triage < 1) return blocked('triage');
        const did = await this.triageOne(principal, t.id, incidentId, levels, now);
        return { delivered: 'builtin', message: did ? 'Triage left its note on the timeline.' : 'Someone else is working this incident right now.' };
      }
      if (agent.builtin_key === 'diagnose') {
        if (levels.internal_note < 1 || levels.diagnostic_read < 1) return blocked('diagnostics');
        const r = await this.diagnoseOne(principal, t.id, incidentId, levels, input.question);
        if (!r) return { delivered: 'builtin', message: 'Someone else is working this incident right now.' };
        return {
          delivered: 'builtin',
          message: r.ran ? `Diagnose ran ${r.ran} check${r.ran === 1 ? '' : 's'}${r.handedOff ? ' and handed over what it found' : ' and left a note'}. See Checks.` : r.proposed ? `Diagnose proposed ${r.proposed} check${r.proposed === 1 ? '' : 's'} for you to approve (see the Assistant card).` : 'Diagnose left a note on the checks worth running.',
        };
      }
      if (levels.customer_update < 1) return blocked('customer updates');
      const last = (await s.selectFrom('incident_events').select(['created_at', 'author_id']).where('incident_id', '=', incidentId).where('internal', '=', false).where('kind', 'in', ['comment', 'waiting', 'status_changed']).orderBy('created_at', 'desc').execute()).find((e) => e.author_id !== row.reporter_id)?.created_at ?? null;
      await this.draftUpdate(principal, t.id, row, last, now);
      return { delivered: 'builtin', message: 'Comms drafted an update for you to approve (see the Assistant card).' };
    } catch (e) {
      if (e instanceof HttpException) throw new BadRequestException(typeof e.getResponse() === 'string' ? e.getResponse() : ((e.getResponse() as { message?: string }).message ?? e.message));
      throw e;
    }
  }
}
