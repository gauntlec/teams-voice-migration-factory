import { HttpException, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { platformDb, tenantDb } from '@tvmf/db';
import {
  BUILTIN_BATCH,
  BUILTIN_LEASE_SECONDS,
  BUILTIN_SETTLE_SECONDS,
  COMMS_CADENCE_MINUTES,
  DIAG_RUNBOOKS,
  agentEffectiveAutonomy,
  commsDraft,
  commsDue,
  diagnoseOutcome,
  triageAnalysis,
  type AgentAutonomy,
  type BuiltinAgentKey,
  type DiagResult,
  type DiagRunbookKey,
  type IncStatus,
} from '@tvmf/shared';
import type { AgentPrincipal } from '../../common/request';
import { InjectDb, type Db } from '../../db/db.module';
import { AgentApiService } from './agent-api.service';

type Levels = ReturnType<typeof agentEffectiveAutonomy>;
export interface BuiltinStats {
  triage: number;
  diagnose: number;
  comms: number;
  errors: number;
}

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

  constructor(
    @InjectDb() private readonly db: Db,
    private readonly api: AgentApiService,
  ) {}

  onModuleInit() {
    const every = Number(process.env.BUILTIN_AGENTS_INTERVAL_SECONDS ?? 30);
    if (process.env.NODE_ENV === 'test' || process.env.VITEST || !(every > 0)) return;
    this.timer = setInterval(() => void this.tick().catch((e) => this.log.error(`pass failed: ${(e as Error).message}`)), every * 1000);
    this.timer.unref();
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  /** One pass over every customer each built-in assistant is allowed on. */
  async tick(opts: { tenantId?: string; now?: Date } = {}): Promise<BuiltinStats> {
    const stats: BuiltinStats = { triage: 0, diagnose: 0, comms: 0, errors: 0 };
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
            else stats.comms += await this.comms(principal, t.id, t.schema, levels, now);
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
    for (const { id } of await this.candidates(schema, p.agentId, ['new'], now)) {
      try {
        await this.api.claim(p, tenantId, id, { ttlSeconds: BUILTIN_LEASE_SECONDS, note: 'Triage' });
      } catch {
        continue; // someone else got there first
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
        done++;
      } finally {
        await this.api.release(p, tenantId, id).catch(() => undefined);
      }
    }
    return done;
  }

  /* ------------------------------ Diagnose ------------------------------ */

  private async diagnose(p: AgentPrincipal, tenantId: string, schema: string, levels: Levels, now: Date): Promise<number> {
    if (levels.internal_note < 1 || levels.diagnostic_read < 1) return 0;
    let done = 0;
    if (levels.diagnostic_read >= 2 && levels.diagnostic_read < 3) done += await this.runApproved(p, tenantId, schema);
    for (const { id } of await this.candidates(schema, p.agentId, ['new', 'in_progress'], now, { undiagnosed: true })) {
      try {
        await this.api.claim(p, tenantId, id, { ttlSeconds: BUILTIN_LEASE_SECONDS, note: 'Diagnosis' });
      } catch {
        continue;
      }
      try {
        const ctx = await this.api.get(p, tenantId, id);
        const ref = ctx.incident.reference;
        const checks = ctx.suggestedChecks;
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
          const out = diagnoseOutcome(ref, results);
          if (out.hasProblem && results.length) {
            await this.api.handoff(p, tenantId, id, { to: 'queue', summary: { tried: out.tried, found: out.found, recommendation: out.recommendation, confidence: out.confidence, evidence: [] } });
          } else {
            await this.api.note(p, tenantId, id, { body: out.note });
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
              .catch(() => undefined);
          }
          await this.api.note(p, tenantId, id, { body: `Diagnosis of ${ref}: ${wanted.length ? `proposed ${wanted.length} read-only check${wanted.length === 1 ? '' : 's'} for a person to approve. I run them once approved.` : 'no check is worth running from what the incident says.'}` });
        } else {
          await this.api.note(p, tenantId, id, { body: `Diagnosis of ${ref}: checks worth running: ${checks.map((c) => `${DIAG_RUNBOOKS[c.runbook].label}${c.input ? ` (${c.input})` : ''}`).join('; ') || 'none'}. I am set to suggest only, so I have not run them.` });
        }
        done++;
      } finally {
        await this.api.release(p, tenantId, id).catch(() => undefined);
      }
    }
    return done;
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
      try {
        await this.api.propose(p, tenantId, i.id, {
          kind: 'customer_update',
          params: { body: commsDraft({ priority: i.priority, status: i.status, holdReason: i.hold_reason, major: false, createdAt: i.created_at, lastPublicUpdateAt: last, title: i.title, now }) },
          rationale: `No update has gone to the customer for ${Math.round((now.getTime() - new Date(last ?? i.created_at).getTime()) / 60_000)} minutes on a ${i.priority.toUpperCase()} incident (the target is ${cadence}).`,
          risk: 'low',
          expiresInMinutes: Math.max(30, cadence),
        });
        drafted++;
      } catch (e) {
        this.log.debug(`comms ${i.id}: ${(e as Error).message}`);
      }
    }
    return drafted;
  }
}
