import { createHmac } from 'node:crypto';
import { sql, type Kysely } from 'kysely';
import { platformDb, tenantDb, type DB } from '@tvmf/db';
import {
  AGENT_EVENT_RETENTION_DAYS,
  AGENT_WEBHOOK_MAX_FAILURES,
  AGENT_WEBHOOK_SIGNATURE_HEADER,
  AGENT_WEBHOOK_TIMESTAMP_HEADER,
  INC_PRIORITY_LABELS,
  agentLabel,
  incCategoryLabel,
  incReference,
  type IncidentActivityContext,
} from '@tvmf/shared';
import { decryptSecret } from './crypto';
import type { MailEnqueuer } from './mail/enqueue';
import { expireSrProposals, lapseSrClaims } from './sr-agents';

/**
 * Housekeeping for AI agents, every minute (docs/AGENTS.md):
 * - Proposals nobody decided in time are marked expired (and the agent is told).
 * - A lease that lapsed puts the incident back in the queue: the agent is unassigned, the team is told once.
 * - Old events and idempotency keys are cleared.
 * Each step claims the row first, so two workers never both act. `opts.tenantId` limits it to one customer (tests).
 */
export async function sweepAgents(db: Kysely<DB>, enqueueMail: MailEnqueuer, opts: { tenantId?: string } = {}): Promise<{ expired: number; lapsed: number }> {
  const webOrigin = (process.env.WEB_ORIGIN ?? '').replace(/\/+$/, '');
  let q = platformDb(db).selectFrom('tenants').select(['id', 'schema_name', 'name']).where('managed_services_enabled', '=', true).where('status', '=', 'active');
  if (opts.tenantId) q = q.where('id', '=', opts.tenantId);
  const tenants = await q.execute();
  const total = { expired: 0, lapsed: 0 };
  for (const t of tenants) {
    try {
      total.expired += await expireProposals(db, t);
      total.lapsed += await lapseClaims(db, enqueueMail, t, webOrigin);
      // Service requests: the same two housekeeping jobs.
      total.expired += await expireSrProposals(db, t);
      total.lapsed += await lapseSrClaims(db, enqueueMail, t);
    } catch (e) {
      // eslint-disable-next-line no-console
      console.warn(`[agents] sweep failed for ${t.schema_name}: ${(e as Error).message}`);
    }
  }
  if (!opts.tenantId) {
    const cutoff = new Date(Date.now() - AGENT_EVENT_RETENTION_DAYS * 86_400_000).toISOString();
    await platformDb(db).deleteFrom('agent_events').where('created_at', '<', cutoff).execute();
    await platformDb(db).deleteFrom('agent_requests').where('created_at', '<', new Date(Date.now() - 86_400_000).toISOString()).execute();
  }
  if (total.expired || total.lapsed) {
    // eslint-disable-next-line no-console
    console.log(`agent sweep: ${total.expired} proposal(s) expired, ${total.lapsed} lease(s) lapsed`);
  }
  return total;
}

interface Tenant {
  id: string;
  schema_name: string;
  name: string;
}

/** Writes a feed event, the same way the API does: nothing when no agent may work the customer (and none is targeted). */
async function emit(db: Kysely<DB>, tenantId: string, inc: { id: string; number: number; priority: string; status: string; version: number; category: string }, kind: string, extra: Record<string, unknown>, agentId: string | null) {
  if (!agentId) {
    const any = await platformDb(db).selectFrom('agent_customer_policy').select('agent_id').where('tenant_id', '=', tenantId).where('enabled', '=', true).limit(1).executeTakeFirst();
    if (!any) return;
  }
  await platformDb(db)
    .insertInto('agent_events')
    .values({ tenant_id: tenantId, incident_id: inc.id, kind, agent_id: agentId, payload: JSON.stringify({ reference: incReference(inc.number), priority: inc.priority, status: inc.status, version: inc.version, category: inc.category, ...extra }) })
    .execute();
}

export { emit as emitAgentEvent };

async function expireProposals(db: Kysely<DB>, t: Tenant): Promise<number> {
  const s = tenantDb(db, t.schema_name);
  const now = new Date().toISOString();
  const expired = await s
    .updateTable('incident_actions')
    .set({ state: 'expired', finished_at: now })
    .where('state', '=', 'proposed')
    .where('expires_at', '<', now)
    .returning(['id', 'incident_id', 'agent_id', 'kind'])
    .execute();
  for (const p of expired) {
    const inc = await s.selectFrom('incidents').select(['id', 'number', 'priority', 'status', 'version', 'category']).where('id', '=', p.incident_id).executeTakeFirst();
    if (inc) await emit(db, t.id, inc, 'proposal.expired', { proposalId: p.id, proposalKind: p.kind }, p.agent_id);
  }
  return expired.length;
}

async function lapseClaims(db: Kysely<DB>, enqueueMail: MailEnqueuer, t: Tenant, webOrigin: string): Promise<number> {
  const s = tenantDb(db, t.schema_name);
  const now = new Date().toISOString();
  const lapsed = await s
    .updateTable('incident_claims')
    .set({ released_at: now, release_reason: 'expired' })
    .where('released_at', 'is', null)
    .where('expires_at', '<', now)
    .returning(['incident_id', 'agent_id'])
    .execute();
  let count = 0;
  for (const c of lapsed) {
    const inc = await s.selectFrom('incidents').selectAll().where('id', '=', c.incident_id).executeTakeFirst();
    if (!inc) continue;
    const agent = await platformDb(db).selectFrom('agents').select(['id', 'name']).where('id', '=', c.agent_id).executeTakeFirst();
    const name = agent?.name ?? 'An assistant';
    // Still its incident and still open: back to the queue.
    const open = ['new', 'in_progress', 'on_hold', 'restored'].includes(inc.status);
    if (!open || inc.assigned_agent_id !== c.agent_id) continue;
    const back = await s
      .updateTable('incidents')
      .set({ assigned_agent_id: null, updated_at: now, version: sql`version + 1` })
      .where('id', '=', inc.id)
      .where('assigned_agent_id', '=', c.agent_id)
      .returning(['id', 'number', 'priority', 'status', 'version', 'category'])
      .executeTakeFirst();
    if (!back) continue;
    count++;
    await s
      .insertInto('incident_events')
      .values({ incident_id: inc.id, kind: 'claim_released', body: `${agentLabel(name)} stopped working on this (its lease ran out). It is back in the queue.`, internal: true, author_id: c.agent_id, actor_type: 'agent', meta: JSON.stringify({ agentId: c.agent_id, lapsed: true }) })
      .execute();
    await emit(db, t.id, back, 'claim.expired', { why: 'lease ran out' }, c.agent_id);
    // The team: the human assignee if there is one (there isn't - the agent had it), otherwise everyone on the customer.
    const staff = await teamOf(db, t.id);
    const context: IncidentActivityContext = {
      customerName: t.name,
      reference: incReference(inc.number),
      title: inc.title,
      categoryLabel: incCategoryLabel(inc.category, inc.subcategory),
      priorityLabel: INC_PRIORITY_LABELS[inc.priority],
      kind: 'agent_lapsed',
      author: agentLabel(name),
      body: 'its lease ran out',
      runUrl: `${webOrigin}/incidents/${inc.id}`,
    };
    for (const m of staff) {
      await enqueueMail({ template: 'incident_activity', to: { email: m.email, name: m.display_name }, context, related: { type: 'incident', id: inc.id }, tenantId: t.id });
    }
  }
  return count;
}

async function teamOf(db: Kysely<DB>, tenantId: string) {
  const p = platformDb(db);
  const [engineers, admins] = await Promise.all([
    p
      .selectFrom('tenant_memberships as m')
      .innerJoin('users as u', 'u.id', 'm.user_id')
      .select(['u.id as id', 'u.email as email', 'u.display_name as display_name'])
      .where('m.tenant_id', '=', tenantId)
      .where('u.role', '=', 'ENGINEER')
      .where('u.status', '=', 'active')
      .execute(),
    p.selectFrom('users').select(['id', 'email', 'display_name']).where('role', '=', 'SUPER_ADMIN').where('status', '=', 'active').execute(),
  ]);
  const byId = new Map<string, { id: string; email: string; display_name: string }>();
  for (const u of [...engineers, ...admins]) byId.set(u.id, u);
  return [...byId.values()];
}

/* ------------------------------ webhooks ------------------------------ */

/** The body and headers of one delivery: sha256=<hex HMAC-SHA256 of `${timestamp}.${body}` with the webhook's secret>. */
export function signWebhook(secret: string, body: string, timestampSeconds: number) {
  const signature = createHmac('sha256', secret).update(`${timestampSeconds}.${body}`).digest('hex');
  return {
    'Content-Type': 'application/json',
    'User-Agent': 'Voxshift-Agents/1',
    [AGENT_WEBHOOK_TIMESTAMP_HEADER]: String(timestampSeconds),
    [AGENT_WEBHOOK_SIGNATURE_HEADER]: `sha256=${signature}`,
  };
}

/** After this many events in one POST the rest wait for the next delivery. */
const BATCH = 50;
const TIMEOUT_MS = 10_000;

/**
 * Pushes new events to each active webhook: at least once (a failed or unacknowledged batch is sent again),
 * in order, with the same events an agent would poll for. A webhook that keeps failing backs off and, after
 * AGENT_WEBHOOK_MAX_FAILURES in a row, is switched off (a Super Admin can switch it back on).
 */
export async function deliverWebhooks(db: Kysely<DB>, deps: { fetch?: typeof fetch; now?: () => number } = {}): Promise<{ delivered: number; failed: number }> {
  const doFetch = deps.fetch ?? fetch;
  const now = deps.now ?? Date.now;
  const p = platformDb(db);
  const due = await p
    .selectFrom('agent_webhooks as w')
    .innerJoin('agents as a', 'a.id', 'w.agent_id')
    .select(['w.id as id', 'w.agent_id as agent_id', 'w.url as url', 'w.secret_enc as secret_enc', 'w.kinds as kinds', 'w.cursor as cursor', 'w.failures as failures'])
    .where('w.active', '=', true)
    .where('w.next_attempt_at', '<=', new Date(now()).toISOString())
    .where('a.status', '=', 'active')
    .execute();
  const out = { delivered: 0, failed: 0 };
  for (const w of due) {
    const rows = await p
      .selectFrom('agent_events as e')
      .innerJoin('agent_customer_policy as cp', (j) => j.onRef('cp.tenant_id', '=', 'e.tenant_id').on('cp.agent_id', '=', w.agent_id).on('cp.enabled', '=', true))
      .innerJoin('tenants as t', 't.id', 'e.tenant_id')
      .select(['e.id as id', 'e.tenant_id as tenant_id', 'e.incident_id as incident_id', 'e.kind as kind', 'e.payload as payload', 'e.created_at as created_at'])
      .where('t.agents_enabled', '=', true)
      .where('e.id', '>', String(w.cursor) as never)
      .where((eb) => eb.or([eb('e.agent_id', 'is', null), eb('e.agent_id', '=', w.agent_id)]))
      .$if(w.kinds.length > 0, (qb) => qb.where('e.kind', 'in', w.kinds))
      .orderBy('e.id')
      .limit(BATCH)
      .execute();
    // The cursor moves past everything we looked at, so events this webhook doesn't want aren't re-read forever.
    const upTo = rows.length ? rows[rows.length - 1]!.id : null;
    if (!rows.length) {
      const head = await p.selectFrom('agent_events').select('id').orderBy('id', 'desc').limit(1).executeTakeFirst();
      if (head && Number(head.id) > Number(w.cursor) && w.kinds.length > 0) await p.updateTable('agent_webhooks').set({ cursor: head.id }).where('id', '=', w.id).execute();
      continue;
    }
    const body = JSON.stringify({ events: rows.map((r) => ({ ...(r.payload as Record<string, unknown>), id: Number(r.id), tenant_id: r.tenant_id, incident_id: r.incident_id, kind: r.kind, created_at: r.created_at })) });
    let status = 'error';
    let ok = false;
    try {
      const secret = decryptSecret(w.secret_enc);
      const res = await doFetch(w.url, { method: 'POST', headers: signWebhook(secret, body, Math.floor(now() / 1000)), body, signal: AbortSignal.timeout(TIMEOUT_MS) });
      status = String(res.status);
      ok = res.ok;
    } catch (e) {
      status = `error: ${(e as Error).message}`.slice(0, 200);
    }
    if (ok) {
      out.delivered++;
      await p.updateTable('agent_webhooks').set({ cursor: upTo!, failures: 0, last_status: status, last_delivery_at: new Date(now()).toISOString(), next_attempt_at: new Date(now()).toISOString() }).where('id', '=', w.id).execute();
    } else {
      out.failed++;
      const failures = w.failures + 1;
      const backoff = Math.min(15 * 2 ** failures, 3600) * 1000;
      await p
        .updateTable('agent_webhooks')
        .set({ failures, last_status: status, next_attempt_at: new Date(now() + backoff).toISOString(), ...(failures >= AGENT_WEBHOOK_MAX_FAILURES ? { active: false } : {}) })
        .where('id', '=', w.id)
        .execute();
    }
  }
  return out;
}
