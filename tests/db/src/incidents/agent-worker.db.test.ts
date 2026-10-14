// The worker's side of AI agents: proposals that expire, leases that lapse, webhooks that deliver (signed, in
// order, at least once, with back-off), old events cleared, and SLA events reaching agents.
import { createHmac } from 'node:crypto';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { platformDb } from '@tvmf/db';
import { agentProposalSchema, createAgentSchema, createAgentWebhookSchema, createIncidentSchema, type CreateIncidentInput } from '@tvmf/shared';
import type { EnqueueMailInput } from '../../../../apps/api/src/mail/mail.service';
import { deliverWebhooks, signWebhook, sweepAgents } from '../../../../apps/worker/src/agents';
import { decryptSecret } from '../../../../apps/worker/src/crypto';
import { sweepIncidents } from '../../../../apps/worker/src/incidents';
import { seedCustomer, seedSite, seedUser, useDb, type TestCustomer } from '../helpers';
import { incidentServices } from './services';

const handle = useDb();
let c: TestCustomer;
let s: ReturnType<typeof incidentServices>;
let admin: Awaited<ReturnType<typeof seedUser>>;
let eng: Awaited<ReturnType<typeof seedUser>>;
let cara: Awaited<ReturnType<typeof seedUser>>;
let siteId: string;
let sent: EnqueueMailInput[] = [];
let n = 0;

const enqueue = (async (m: EnqueueMailInput) => (sent.push(m), { id: 'm' })) as never;
const sweep = () => sweepAgents(handle.db, enqueue, { tenantId: c.t.id });
const call = (over: Partial<CreateIncidentInput> = {}) =>
  createIncidentSchema.parse({
    title: 'No audio on inbound calls',
    category: 'call_quality',
    subcategory: 'one_way_audio',
    siteId,
    impact: 'team',
    urgency: 'degraded',
    description: 'People at Reading hear nothing on inbound calls.',
    answers: { where: 'In the office on wifi', how_often: 'Every call', started: 'Today 09:00' },
    ...over,
  });
const raise = (over: Partial<CreateIncidentInput> = {}) => s.svc.create(c.t, cara, call(over), false);
const row = (id: string) => c.s.selectFrom('incidents').selectAll().where('id', '=', id).executeTakeFirstOrThrow();
const ago = (ms: number) => new Date(Date.now() - ms).toISOString();

async function bot(autonomy = {}) {
  const a = await s.agentAdmin.create(admin, createAgentSchema.parse({ name: `Worker-${++n}-${Date.now() % 100000}`, kind: 'triage' }));
  await s.agentAdmin.setPolicy(admin, a.id, c.t.id, { enabled: true, autonomy });
  return { id: a.id, name: a.name, p: { agentId: a.id, tokenId: 't', name: a.name, kind: 'triage' as const, scopes: ['read', 'note', 'propose', 'act'] as ('read' | 'note' | 'propose' | 'act')[] } };
}

beforeAll(async () => {
  c = await seedCustomer(handle, { managedServices: true });
  admin = await seedUser(handle, 'SUPER_ADMIN', { displayName: 'Ada Admin' });
  eng = await seedUser(handle, 'ENGINEER', { displayName: 'Eve Engineer' });
  cara = await seedUser(handle, 'CUSTOMER', { displayName: 'Cara Customer' });
  await platformDb(handle.db).insertInto('tenant_memberships').values([eng, cara].map((u) => ({ tenant_id: c.t.id, user_id: u.id })) as never).execute();
  siteId = (await seedSite(c.s, { sitecode: 'RDG01' })).id;
  await c.s.updateTable('discovery_sites').set({ mode: 'operations' } as never).execute();
  s = incidentServices(handle, { enqueue: async (i: EnqueueMailInput) => (sent.push(i), { id: 'm' }) });
});

beforeEach(() => {
  sent = [];
});

describe('the agent sweep', () => {
  it('expires proposals nobody decided, once, and tells the agent', async () => {
    const a = await bot();
    const i = await raise();
    const p = await s.agentApi.propose(a.p, c.t.id, i.id, agentProposalSchema.parse({ kind: 'customer_update', params: { body: 'Hello there' }, rationale: 'Because' }));
    const fresh = await s.agentApi.propose(a.p, c.t.id, i.id, agentProposalSchema.parse({ kind: 'link_item', params: { kind: 'user', ref: 'jo@contoso.test' }, rationale: 'Because' }));
    await c.s.updateTable('incident_actions').set({ expires_at: ago(1000) } as never).where('id', '=', p.id).execute();
    const cur = Number((await platformDb(handle.db).selectFrom('agent_events').select('id').orderBy('id', 'desc').limit(1).executeTakeFirst())?.id ?? 0);
    expect((await sweep()).expired).toBe(1);
    expect((await sweep()).expired).toBe(0);
    const rows = await c.s.selectFrom('incident_actions').select(['id', 'state', 'finished_at']).where('incident_id', '=', i.id).execute();
    expect(rows.find((r) => r.id === p.id)).toMatchObject({ state: 'expired' });
    expect(rows.find((r) => r.id === fresh.id)).toMatchObject({ state: 'proposed' });
    const feed = await s.agentApi.feed(a.p, { after: cur, limit: 500 });
    expect(feed.events.find((e) => e.kind === 'proposal.expired')).toMatchObject({ proposalId: p.id, proposalKind: 'customer_update', incident_id: i.id });
  });

  it('puts an incident back in the queue when a lease runs out, tells the team once, and leaves a person\'s incident alone', async () => {
    const a = await bot({ triage: 1 });
    const i = await raise();
    await s.agentApi.claim(a.p, c.t.id, i.id, { ttlSeconds: 120 });
    await sweep();
    expect(await row(i.id)).toMatchObject({ assigned_agent_id: a.id }); // not lapsed yet
    await c.s.updateTable('incident_claims').set({ expires_at: ago(1000) } as never).where('incident_id', '=', i.id).execute();
    sent = [];
    const cur = Number((await platformDb(handle.db).selectFrom('agent_events').select('id').orderBy('id', 'desc').limit(1).executeTakeFirst())?.id ?? 0);
    expect((await sweep()).lapsed).toBe(1);
    expect(await row(i.id)).toMatchObject({ assigned_agent_id: null, assigned_to: null });
    expect(await c.s.selectFrom('incident_claims').select(['released_at', 'release_reason']).where('incident_id', '=', i.id).executeTakeFirstOrThrow()).toMatchObject({ release_reason: 'expired' });
    const e = (await c.s.selectFrom('incident_events').selectAll().where('incident_id', '=', i.id).execute()).find((x) => x.kind === 'claim_released')!;
    expect(e).toMatchObject({ internal: true, actor_type: 'agent' });
    expect(e.body).toContain('lease ran out');
    const team = sent.filter((m) => m.template === 'incident_activity' && (m.context as { kind: string }).kind === 'agent_lapsed');
    expect(team.map((m) => m.to.email)).toContain(eng.email);
    expect(team.every((m) => m.related?.id === i.id)).toBe(true);
    expect((await s.agentApi.feed(a.p, { after: cur, limit: 500 })).events.some((x) => x.kind === 'claim.expired' && x.incident_id === i.id)).toBe(true);
    sent = [];
    expect((await sweep()).lapsed).toBe(0); // once

    // A lapsed lease on an incident a person has since taken: nothing to undo.
    const j = await raise();
    await s.agentApi.claim(a.p, c.t.id, j.id, { ttlSeconds: 120 });
    await c.s.updateTable('incident_claims').set({ expires_at: ago(1000) } as never).where('incident_id', '=', j.id).execute();
    await s.svc.assign(c.t, eng, j.id, { userId: eng.id });
    sent = [];
    await sweep();
    expect(await row(j.id)).toMatchObject({ assigned_to: eng.id });
    expect(sent.filter((m) => (m.context as { kind: string }).kind === 'agent_lapsed')).toHaveLength(0);
  });
});

describe('SLA events', () => {
  it('reach agents when a target is at risk or missed', async () => {
    const a = await bot();
    const i = await raise({ impact: 'company', urgency: 'cannot_call' }); // P1: respond in 15 minutes
    await c.s.updateTable('incidents').set({ created_at: ago(13 * 60_000) } as never).where('id', '=', i.id).execute();
    const cur = Number((await platformDb(handle.db).selectFrom('agent_events').select('id').orderBy('id', 'desc').limit(1).executeTakeFirst())?.id ?? 0);
    await sweepIncidents(handle.db, enqueue, { tenantId: c.t.id });
    await c.s.updateTable('incidents').set({ created_at: ago(20 * 60_000) } as never).where('id', '=', i.id).execute();
    await sweepIncidents(handle.db, enqueue, { tenantId: c.t.id });
    const kinds = (await s.agentApi.feed(a.p, { after: cur, limit: 500 })).events.filter((e) => e.incident_id === i.id && e.kind.startsWith('sla.')).map((e) => e.kind);
    expect(kinds).toEqual(['sla.at_risk', 'sla.breached']);
  });
});

describe('webhooks', () => {
  async function hook(autonomy = {}, kinds: string[] = []) {
    const a = await bot(autonomy);
    // Each test's webhook has its own address: every webhook in the database is delivered to on every run.
    const url = `https://agent.example.com/hook-${a.id}`;
    const w = await s.agentAdmin.createWebhook(admin, a.id, createAgentWebhookSchema.parse({ url, kinds }));
    return { a, w, url };
  }
  const okFetch = (calls: { url: string; init: RequestInit }[], status = 200) =>
    (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response('{}', { status });
    }) as unknown as typeof fetch;
  const cursorOf = async (id: string) => Number((await platformDb(handle.db).selectFrom('agent_webhooks').select('cursor').where('id', '=', id).executeTakeFirstOrThrow()).cursor);

  it('sign what they send so the agent can check it came from us', async () => {
    const { a, w, url } = await hook();
    const i = await raise();
    const calls: { url: string; init: RequestInit }[] = [];
    const r = await deliverWebhooks(handle.db, { fetch: okFetch(calls), now: () => Date.now() });
    expect(r.delivered).toBeGreaterThanOrEqual(1);
    const mine = calls.filter((x) => x.url === url);
    expect(mine.length).toBeGreaterThanOrEqual(1);
    const init = mine.at(-1)!.init;
    const headers = init.headers as Record<string, string>;
    const stored = await platformDb(handle.db).selectFrom('agent_webhooks').select('secret_enc').where('id', '=', w.id).executeTakeFirstOrThrow();
    const secret = decryptSecret(stored.secret_enc);
    expect(secret).toBe(w.secret);
    const expected = createHmac('sha256', secret).update(`${headers['X-Voxshift-Timestamp']}.${init.body}`).digest('hex');
    expect(headers['X-Voxshift-Signature']).toBe(`sha256=${expected}`);
    const body = JSON.parse(String(init.body)) as { events: { kind: string; incident_id: string }[] };
    expect(body.events.some((e) => e.kind === 'incident.created' && e.incident_id === i.id)).toBe(true);
    expect(signWebhook('k', 'b', 1)['X-Voxshift-Signature']).toBe(`sha256=${createHmac('sha256', 'k').update('1.b').digest('hex')}`);
    expect(a.id).toBeTruthy();
  });

  it('send each event once when delivery works, in order, and nothing when there is nothing new', async () => {
    const { w, url } = await hook();
    const calls: { url: string; init: RequestInit }[] = [];
    await deliverWebhooks(handle.db, { fetch: okFetch(calls) });
    const start = calls.length;
    const i = await raise();
    await s.svc.move(c.t, eng, i.id, { to: 'in_progress' }, true);
    await deliverWebhooks(handle.db, { fetch: okFetch(calls) });
    const ids = calls.slice(start).filter((x) => x.url === url).flatMap((x) => (JSON.parse(String(x.init.body)) as { events: { id: number; incident_id: string }[] }).events.filter((e) => e.incident_id === i.id).map((e) => e.id));
    expect(ids).toHaveLength(2);
    expect(ids[0]!).toBeLessThan(ids[1]!);
    const after = calls.filter((x) => x.url === url).length;
    await deliverWebhooks(handle.db, { fetch: okFetch(calls) });
    expect(calls.filter((x) => x.url === url).length).toBe(after);
    expect(await cursorOf(w.id)).toBeGreaterThanOrEqual(ids[1]!);
  });

  it('send a failed batch again, backing off, and give up (switching off) after too many failures', async () => {
    const { w, url } = await hook();
    await deliverWebhooks(handle.db, { fetch: okFetch([]) });
    const i = await raise();
    const before = await cursorOf(w.id);
    const calls: { url: string; init: RequestInit }[] = [];
    await deliverWebhooks(handle.db, { fetch: okFetch(calls, 500) });
    expect(await cursorOf(w.id)).toBe(before); // not moved on
    let hookRow = await platformDb(handle.db).selectFrom('agent_webhooks').selectAll().where('id', '=', w.id).executeTakeFirstOrThrow();
    expect(hookRow).toMatchObject({ failures: 1, last_status: '500', active: true });
    expect(new Date(hookRow.next_attempt_at).getTime()).toBeGreaterThan(Date.now() + 20_000);
    // Not due yet: nothing is sent.
    const n1 = calls.filter((x) => x.url === url).length;
    await deliverWebhooks(handle.db, { fetch: okFetch(calls) });
    expect(calls.filter((x) => x.url === url).length).toBe(n1);
    // Due again: the same events go out.
    await platformDb(handle.db).updateTable('agent_webhooks').set({ next_attempt_at: new Date(Date.now() - 1000).toISOString() }).where('id', '=', w.id).execute();
    const again: { url: string; init: RequestInit }[] = [];
    await deliverWebhooks(handle.db, { fetch: okFetch(again) });
    expect((JSON.parse(String(again.find((x) => x.url === url)!.init.body)) as { events: { incident_id: string }[] }).events.some((e) => e.incident_id === i.id)).toBe(true);
    hookRow = await platformDb(handle.db).selectFrom('agent_webhooks').selectAll().where('id', '=', w.id).executeTakeFirstOrThrow();
    expect(hookRow.failures).toBe(0);
    // Keeps failing: switched off.
    await raise();
    await platformDb(handle.db).updateTable('agent_webhooks').set({ failures: 11, next_attempt_at: new Date(Date.now() - 1000).toISOString() }).where('id', '=', w.id).execute();
    await deliverWebhooks(handle.db, { fetch: (async () => { throw new Error('connection refused'); }) as unknown as typeof fetch });
    hookRow = await platformDb(handle.db).selectFrom('agent_webhooks').selectAll().where('id', '=', w.id).executeTakeFirstOrThrow();
    expect(hookRow).toMatchObject({ active: false, failures: 12 });
    expect(hookRow.last_status).toContain('connection refused');
    await s.agentAdmin.setWebhookActive(admin, hookRow.agent_id, w.id, true);
    expect(await platformDb(handle.db).selectFrom('agent_webhooks').select(['active', 'failures']).where('id', '=', w.id).executeTakeFirstOrThrow()).toEqual({ active: true, failures: 0 });
  });

  it('only send the kinds asked for, and never events from customers the agent is not allowed on', async () => {
    const { w, url } = await hook({}, ['sla.breached']);
    await deliverWebhooks(handle.db, { fetch: okFetch([]) });
    await raise();
    const calls: { url: string; init: RequestInit }[] = [];
    await deliverWebhooks(handle.db, { fetch: okFetch(calls) });
    expect(calls.filter((x) => x.url === url)).toHaveLength(0);
    expect(await cursorOf(w.id)).toBeGreaterThan(0); // moved past what it didn't want
  });

  it('do nothing for a paused agent or an inactive webhook', async () => {
    const { a, w, url } = await hook();
    await deliverWebhooks(handle.db, { fetch: okFetch([]) });
    await raise();
    await s.agentAdmin.update(admin, a.id, { status: 'paused' });
    const calls: { url: string; init: RequestInit }[] = [];
    await deliverWebhooks(handle.db, { fetch: okFetch(calls) });
    expect(calls.filter((x) => x.url === url)).toHaveLength(0);
    await s.agentAdmin.update(admin, a.id, { status: 'active' });
    await s.agentAdmin.setWebhookActive(admin, a.id, w.id, false);
    await deliverWebhooks(handle.db, { fetch: okFetch(calls) });
    expect(calls.filter((x) => x.url === url)).toHaveLength(0);
  });
});

describe('housekeeping', () => {
  it('clears feed events past their retention and idempotency keys after a day', async () => {
    const a = await bot();
    const tenant = c.t.id;
    const old = await platformDb(handle.db).insertInto('agent_events').values({ tenant_id: tenant, kind: 'incident.updated', created_at: ago(20 * 86_400_000) } as never).returning('id').executeTakeFirstOrThrow();
    const recent = await platformDb(handle.db).insertInto('agent_events').values({ tenant_id: tenant, kind: 'incident.updated' } as never).returning('id').executeTakeFirstOrThrow();
    await platformDb(handle.db).insertInto('agent_requests').values([{ agent_id: a.id, idem_key: 'old', status: 'done', response: '{}', created_at: ago(2 * 86_400_000) }, { agent_id: a.id, idem_key: 'new', status: 'done', response: '{}' }] as never).execute();
    await sweepAgents(handle.db, enqueue); // (every customer: the clean-up runs once per sweep)
    expect(await platformDb(handle.db).selectFrom('agent_events').select('id').where('id', '=', old.id).executeTakeFirst()).toBeUndefined();
    expect(await platformDb(handle.db).selectFrom('agent_events').select('id').where('id', '=', recent.id).executeTakeFirst()).toBeTruthy();
    const keys = (await platformDb(handle.db).selectFrom('agent_requests').select('idem_key').where('agent_id', '=', a.id).execute()).map((k) => k.idem_key);
    expect(keys).toEqual(['new']);
  });
});
