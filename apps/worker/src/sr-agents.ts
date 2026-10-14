import type { Kysely } from 'kysely';
import { platformDb, tenantDb, type DB } from '@tvmf/db';
import { SR_TYPE_DEFS, agentLabel, srReference, type ServiceRequestActivityContext } from '@tvmf/shared';
import type { MailEnqueuer } from './mail/enqueue';

interface Tenant {
  id: string;
  schema_name: string;
  name: string;
}

/** A feed event about a service request, the same way the API writes one: nothing when no agent may work the customer (and none is targeted). */
export async function emitRequestEvent(db: Kysely<DB>, tenantId: string, sr: { id: string; number: number; type: string; status: string; priority: string }, kind: string, extra: Record<string, unknown> = {}, agentId: string | null = null): Promise<void> {
  if (!agentId) {
    const any = await platformDb(db).selectFrom('agent_customer_policy').select('agent_id').where('tenant_id', '=', tenantId).where('enabled', '=', true).limit(1).executeTakeFirst();
    if (!any) return;
  }
  await platformDb(db)
    .insertInto('agent_events')
    .values({ tenant_id: tenantId, request_id: sr.id, kind, agent_id: agentId, payload: JSON.stringify({ reference: srReference(sr.number), type: sr.type, status: sr.status, priority: sr.priority, ...extra }) })
    .execute();
}

/** The people who action a customer's requests: its engineers and every Super Admin. */
export async function srTeam(db: Kysely<DB>, tenantId: string): Promise<{ id: string; email: string; display_name: string }[]> {
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

/** Emails the team about a request (its assignee, or everyone when nobody has it). */
export async function emailRequestTeam(
  db: Kysely<DB>,
  enqueueMail: MailEnqueuer,
  t: { id: string; name: string },
  sr: { id: string; number: number; type: keyof typeof SR_TYPE_DEFS; title: string; assigned_to?: string | null },
  kind: ServiceRequestActivityContext['kind'],
  author: string | null,
  body: string | null,
): Promise<void> {
  const webOrigin = (process.env.WEB_ORIGIN ?? '').replace(/\/+$/, '');
  const members = await srTeam(db, t.id);
  const to = sr.assigned_to ? members.filter((m) => m.id === sr.assigned_to) : members;
  const context: ServiceRequestActivityContext = { customerName: t.name, reference: srReference(sr.number), title: sr.title, typeLabel: SR_TYPE_DEFS[sr.type].label, kind, author, body, runUrl: `${webOrigin}/service-requests/${sr.id}` };
  for (const m of to) await enqueueMail({ template: 'service_request_activity', to: { email: m.email, name: m.display_name }, context, related: { type: 'service_request', id: sr.id }, tenantId: t.id });
}

/** Proposals nobody decided in time are marked expired (and the assistant is told). */
export async function expireSrProposals(db: Kysely<DB>, t: Tenant): Promise<number> {
  const s = tenantDb(db, t.schema_name);
  const now = new Date().toISOString();
  const expired = await s.updateTable('service_request_actions').set({ state: 'expired', finished_at: now }).where('state', '=', 'proposed').where('expires_at', '<', now).returning(['id', 'request_id', 'agent_id', 'kind']).execute();
  for (const p of expired) {
    const sr = await s.selectFrom('service_requests').select(['id', 'number', 'type', 'status', 'priority']).where('id', '=', p.request_id).executeTakeFirst();
    if (sr) await emitRequestEvent(db, t.id, sr, 'sr.proposal.decided', { proposalId: p.id, proposalKind: p.kind, decision: 'expired', state: 'expired' }, p.agent_id);
  }
  return expired.length;
}

/** A lease that lapsed puts the request back in the queue: the assistant is unassigned and the team is told once. */
export async function lapseSrClaims(db: Kysely<DB>, enqueueMail: MailEnqueuer, t: Tenant): Promise<number> {
  const s = tenantDb(db, t.schema_name);
  const now = new Date().toISOString();
  const lapsed = await s.updateTable('service_request_claims').set({ released_at: now, release_reason: 'expired' }).where('released_at', 'is', null).where('expires_at', '<', now).returning(['request_id', 'agent_id']).execute();
  let count = 0;
  for (const c of lapsed) {
    const sr = await s.selectFrom('service_requests').selectAll().where('id', '=', c.request_id).executeTakeFirst();
    if (!sr || !['new', 'planned', 'built'].includes(sr.status) || sr.assigned_agent_id !== c.agent_id) continue;
    const agent = await platformDb(db).selectFrom('agents').select(['id', 'name']).where('id', '=', c.agent_id).executeTakeFirst();
    const name = agent?.name ?? 'An assistant';
    const back = await s.updateTable('service_requests').set({ assigned_agent_id: null, updated_at: now }).where('id', '=', sr.id).where('assigned_agent_id', '=', c.agent_id).returning(['id', 'number', 'type', 'status', 'priority']).executeTakeFirst();
    if (!back) continue;
    count++;
    await s
      .insertInto('service_request_events')
      .values({ request_id: sr.id, kind: 'claim_released', body: `${agentLabel(name)} stopped working on this (its lease ran out). It is back in the queue.`, internal: true, author_id: c.agent_id, actor_type: 'agent', meta: JSON.stringify({ why: 'lease ran out' }) })
      .execute();
    await emitRequestEvent(db, t.id, back, 'sr.claim.expired', { why: 'lease ran out' }, c.agent_id);
    await emailRequestTeam(db, enqueueMail, t, { ...sr, assigned_to: null }, 'agent_lapsed', agentLabel(name), 'its lease ran out');
  }
  return count;
}
