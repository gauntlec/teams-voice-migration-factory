// AI agents as first-class workers: administering them, their tokens, what the agent API lets them do at each
// autonomy level, claims, proposals that people decide, hand-offs, take-overs and the events feed.
import { BadRequestException, ConflictException, ForbiddenException, HttpException, NotFoundException, UnauthorizedException, type ExecutionContext } from '@nestjs/common';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { platformDb } from '@tvmf/db';
import { parseAgentToken, agentProposalSchema, createAgentSchema, createAgentTokenSchema, createAgentWebhookSchema, createIncidentSchema, type AgentAutonomy, type AgentProposalInput, type CreateIncidentInput } from '@tvmf/shared';
import type { AgentPrincipal, AppRequest } from '../../../../apps/api/src/common/request';
import type { EnqueueMailInput } from '../../../../apps/api/src/mail/mail.service';
import { ipAllowed } from '../../../../apps/api/src/modules/incidents/agent-auth.guard';
import { useGlobalAgentLock, seedCustomer, seedSite, seedUser, useDb, type TestCustomer } from '../helpers';
import { incidentServices } from './services';

const handle = useDb();
useGlobalAgentLock(handle);
let c: TestCustomer;
let other: TestCustomer; // a customer the agents are never allowed on
let s: ReturnType<typeof incidentServices>;
let admin: Awaited<ReturnType<typeof seedUser>>;
let eng: Awaited<ReturnType<typeof seedUser>>;
let eng2: Awaited<ReturnType<typeof seedUser>>;
let cara: Awaited<ReturnType<typeof seedUser>>;
let siteId: string;
let sent: EnqueueMailInput[] = [];
let n = 0;
/** The newest feed event when the test began: the feed is shared by every test, so each looks only past this. */
let cur = 0;
const cursor = async () => Number((await platformDb(handle.db).selectFrom('agent_events').select('id').orderBy('id', 'desc').limit(1).executeTakeFirst())?.id ?? 0);

interface Bot {
  id: string;
  name: string;
  p: AgentPrincipal;
}

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
const mails = (template: string) => sent.filter((m) => m.template === template);
const ctx = (m: EnqueueMailInput) => m.context as Record<string, unknown>;

/** An agent allowed on the customer at the given levels. */
async function bot(name: string, autonomy: AgentAutonomy = {}, scopes: AgentPrincipal['scopes'] = ['read', 'note', 'propose', 'act'], tenant: TestCustomer | null = c): Promise<Bot> {
  const a = await s.agentAdmin.create(admin, createAgentSchema.parse({ name: `${name}-${++n}-${Date.now() % 100000}`, kind: 'triage' }));
  if (tenant) await s.agentAdmin.setPolicy(admin, a.id, tenant.t.id, { enabled: true, autonomy });
  return { id: a.id, name: a.name, p: { agentId: a.id, tokenId: 'test-token', name: a.name, kind: 'triage', scopes } };
}
const events = (id: string) => c.s.selectFrom('incident_events').selectAll().where('incident_id', '=', id).orderBy('created_at').execute();
const proposal = (over: Partial<AgentProposalInput> & { kind: AgentProposalInput['kind'] }) => agentProposalSchema.parse({ params: {}, rationale: 'Because the logs say so', ...over });

beforeAll(async () => {
  c = await seedCustomer(handle, { managedServices: true });
  other = await seedCustomer(handle, { name: 'Elsewhere', managedServices: true });
  admin = await seedUser(handle, 'SUPER_ADMIN', { displayName: 'Ada Admin' });
  eng = await seedUser(handle, 'ENGINEER', { displayName: 'Eve Engineer' });
  eng2 = await seedUser(handle, 'ENGINEER', { displayName: 'Ed Engineer' });
  cara = await seedUser(handle, 'CUSTOMER', { displayName: 'Cara Customer' });
  await platformDb(handle.db).insertInto('tenant_memberships').values([eng, eng2, cara].map((u) => ({ tenant_id: c.t.id, user_id: u.id })) as never).execute();
  siteId = (await seedSite(c.s, { sitecode: 'RDG01' })).id;
  await c.s.updateTable('discovery_sites').set({ mode: 'operations' } as never).execute();
  s = incidentServices(handle, { enqueue: async (i: EnqueueMailInput) => (sent.push(i), { id: 'm' }) });
});

beforeEach(async () => {
  sent = [];
  cur = await cursor();
  await platformDb(handle.db).updateTable('agent_kill_switch').set({ all_disabled: false }).where('id', '=', 1).execute();
  await platformDb(handle.db).updateTable('tenants').set({ agents_enabled: true }).where('id', 'in', [c.t.id, other.t.id]).execute();
});

describe('administering agents', () => {
  it('creates agents with a unique name', async () => {
    const a = await s.agentAdmin.create(admin, createAgentSchema.parse({ name: `Unique-${Date.now()}`, kind: 'resolver', modelLabel: 'Claude via the resolver runbook' }));
    expect(a).toMatchObject({ kind: 'resolver', status: 'active', created_by: admin.id });
    await expect(s.agentAdmin.create(admin, createAgentSchema.parse({ name: a.name.toUpperCase() }))).rejects.toBeInstanceOf(ConflictException);
  });

  it('shows a token once and keeps only a hash of its secret', async () => {
    const a = await bot('Tokens', {}, undefined, null);
    const t = await s.agentAdmin.createToken(admin, a.id, createAgentTokenSchema.parse({ name: 'Runner' }));
    expect(t.token).toMatch(new RegExp(`^vxs_agent_${t.id}_[A-Za-z0-9_-]{43}$`));
    const secret = parseAgentToken(t.token)!.secret;
    const stored = await platformDb(handle.db).selectFrom('agent_tokens').selectAll().where('id', '=', t.id).executeTakeFirstOrThrow();
    expect(stored.secret_hash).not.toContain(secret);
    expect(stored.secret_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(stored.last4).toBe(secret.slice(-4));
    expect(t.hint).toBe(`vxs_agent_…${secret.slice(-4)}`);
    const detail = await s.agentAdmin.get(a.id);
    expect(JSON.stringify(detail)).not.toContain(secret);
    expect(detail.tokens[0]).toMatchObject({ name: 'Runner', hint: t.hint, revoked_at: null });
    expect((await s.agentAdmin.list()).find((x) => x.id === a.id)).toMatchObject({ live_tokens: 1, customers: 0 });
    await s.agentAdmin.revokeToken(admin, a.id, t.id);
    expect((await s.agentAdmin.list()).find((x) => x.id === a.id)!.live_tokens).toBe(0);
    await expect(s.agentAdmin.revokeToken(admin, a.id, t.id)).rejects.toBeInstanceOf(NotFoundException);
  });

  it("sets a customer policy, refuses levels above an action class's cap, and shows what is in force", async () => {
    const a = await bot('Policy', {}, undefined, null);
    await expect(s.agentAdmin.setPolicy(admin, a.id, c.t.id, { enabled: true, autonomy: { customer_update: 3 } })).rejects.toBeInstanceOf(BadRequestException);
    await expect(s.agentAdmin.setPolicy(admin, a.id, c.t.id, { enabled: true, autonomy: { change_deploy: 3 } })).rejects.toBeInstanceOf(BadRequestException);
    const off = await seedCustomer(handle, { managedServices: false });
    await expect(s.agentAdmin.setPolicy(admin, a.id, off.t.id, { enabled: true, autonomy: {} })).rejects.toThrow(/Managed Services/);
    await s.agentAdmin.setPolicy(admin, a.id, c.t.id, { enabled: true, autonomy: { triage: 3, customer_update: 2, change_whatif: 2 } });
    const mine = (await s.agentAdmin.get(a.id)).customers.find((x) => x.tenant_id === c.t.id)!;
    expect(mine).toMatchObject({ allowed: true, enabled: true, autonomy: { triage: 3, customer_update: 2, change_whatif: 2, internal_note: 1, change_deploy: 0 } });
    expect((await s.agentAdmin.get(a.id)).customers.find((x) => x.tenant_id === other.t.id)).toMatchObject({ allowed: false, enabled: false });
    await s.agentAdmin.removePolicy(admin, a.id, c.t.id);
    expect((await s.agentAdmin.get(a.id)).customers.find((x) => x.tenant_id === c.t.id)!.allowed).toBe(false);
  });

  it('adds webhooks with an encrypted secret shown once, and can switch one off', async () => {
    const a = await bot('Hooks', {}, undefined, null);
    const w = await s.agentAdmin.createWebhook(admin, a.id, createAgentWebhookSchema.parse({ url: 'https://agent.example.com/hook', kinds: ['incident.created'] }));
    expect(w.secret).toMatch(/^whsec_[0-9a-f]{64}$/);
    const stored = await platformDb(handle.db).selectFrom('agent_webhooks').selectAll().where('id', '=', w.id).executeTakeFirstOrThrow();
    expect(stored.secret_enc).not.toContain(w.secret);
    expect(stored.active).toBe(true);
    const detail = (await s.agentAdmin.get(a.id)).webhooks[0]!;
    expect(JSON.stringify(detail)).not.toContain('secret');
    await s.agentAdmin.setWebhookActive(admin, a.id, w.id, false);
    expect((await platformDb(handle.db).selectFrom('agent_webhooks').select('active').where('id', '=', w.id).executeTakeFirstOrThrow()).active).toBe(false);
    await s.agentAdmin.removeWebhook(admin, a.id, w.id);
    await expect(s.agentAdmin.removeWebhook(admin, a.id, w.id)).rejects.toBeInstanceOf(NotFoundException);
  });

  it('has a kill switch for everything and one for a customer', async () => {
    expect(await s.agentAdmin.killSwitch()).toMatchObject({ all_disabled: false });
    expect(await s.agentAdmin.setKillSwitch(admin, { allDisabled: true, note: 'Investigating' })).toMatchObject({ all_disabled: true, note: 'Investigating' });
    expect((await s.agentAdmin.setKillSwitch(admin, { allDisabled: false })).all_disabled).toBe(false);
    await s.agentAdmin.setTenantAgents(admin, c.t.id, false);
    expect((await platformDb(handle.db).selectFrom('tenants').select('agents_enabled').where('id', '=', c.t.id).executeTakeFirstOrThrow()).agents_enabled).toBe(false);
    await expect(s.agentAdmin.setTenantAgents(admin, '00000000-0000-4000-8000-000000000000', true)).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe('the token guard', () => {
  const guard = () => s.agentGuard;
  const run = async (token: string | undefined, over: Partial<AppRequest> = {}) => {
    const req = { headers: token === undefined ? {} : { authorization: `Bearer ${token}` }, method: 'GET', ip: '203.0.113.7', ...over } as unknown as AppRequest;
    const ok = await guard().canActivate({ switchToHttp: () => ({ getRequest: () => req }) } as unknown as ExecutionContext);
    return { ok, req };
  };
  async function fresh(scopes: readonly ('read' | 'note' | 'propose' | 'act')[] = ['read', 'note'], extra: Partial<{ ipAllow: string[] }> = {}) {
    const a = await bot('Guard', {}, undefined, null);
    const t = await s.agentAdmin.createToken(admin, a.id, createAgentTokenSchema.parse({ name: 'Runner', scopes: [...scopes], ...extra }));
    return { a, t, token: t.token };
  }

  it('lets a valid token through and says who it is', async () => {
    const { a, token } = await fresh();
    const { ok, req } = await run(token);
    expect(ok).toBe(true);
    expect(req.agent).toMatchObject({ agentId: a.id, name: a.name, scopes: ['read', 'note'] });
  });

  it('refuses a missing, malformed, forged, revoked or expired token', async () => {
    const { a, t, token } = await fresh();
    for (const bad of [undefined, 'nonsense', `${token}x`, token.replace(/.$/, (ch) => (ch === 'A' ? 'B' : 'A'))]) await expect(run(bad)).rejects.toBeInstanceOf(UnauthorizedException);
    await expect(run(token, { headers: { authorization: `Basic ${token}` } as never })).rejects.toBeInstanceOf(UnauthorizedException);
    await platformDb(handle.db).updateTable('agent_tokens').set({ expires_at: new Date(Date.now() - 1000).toISOString() }).where('id', '=', t.id).execute();
    await expect(run(token)).rejects.toThrow(/expired/);
    await platformDb(handle.db).updateTable('agent_tokens').set({ expires_at: null }).where('id', '=', t.id).execute();
    expect((await run(token)).ok).toBe(true);
    await s.agentAdmin.revokeToken(admin, a.id, t.id);
    await expect(run(token)).rejects.toThrow(/revoked/);
  });

  it('refuses a disabled agent, lets a paused one read but not write, and obeys the kill switch', async () => {
    const { a, token } = await fresh();
    await s.agentAdmin.update(admin, a.id, { status: 'paused' });
    expect((await run(token)).ok).toBe(true);
    await expect(run(token, { method: 'POST' })).rejects.toThrow(/paused/);
    await s.agentAdmin.update(admin, a.id, { status: 'disabled' });
    await expect(run(token)).rejects.toBeInstanceOf(ForbiddenException);
    await s.agentAdmin.update(admin, a.id, { status: 'active' });
    expect((await run(token)).ok).toBe(true);
    await s.agentAdmin.setKillSwitch(admin, { allDisabled: true, note: 'Test' });
    await expect(run(token)).rejects.toThrow(/switched off/);
  });

  it('limits a token to its allowed addresses', async () => {
    const { token } = await fresh(['read'], { ipAllow: ['203.0.113.0/24', '198.51.100.9'] });
    expect((await run(token, { ip: '203.0.113.200' })).ok).toBe(true);
    expect((await run(token, { ip: '198.51.100.9' })).ok).toBe(true);
    expect((await run(token, { ip: '::ffff:203.0.113.5' })).ok).toBe(true);
    await expect(run(token, { ip: '192.0.2.1' })).rejects.toBeInstanceOf(ForbiddenException);
    await expect(run(token, { ip: undefined })).rejects.toBeInstanceOf(ForbiddenException);
    expect(ipAllowed('10.1.2.3', [])).toBe(true);
    expect(ipAllowed('10.1.2.3', ['10.0.0.0/8'])).toBe(true);
    expect(ipAllowed('11.1.2.3', ['10.0.0.0/8'])).toBe(false);
    expect(ipAllowed('2001:db8::1', ['2001:db8::1'])).toBe(true);
  });

  it('slows a token that is hammering the API', async () => {
    const { token } = await fresh(['read']);
    let refused: unknown;
    for (let i = 0; i < 260 && !refused; i++) await run(token).catch((e) => (refused = e));
    expect(refused).toBeInstanceOf(HttpException);
    expect((refused as HttpException).getStatus()).toBe(429);
  });
});

describe('reading', () => {
  it('lists incidents on the customers an agent may work, most urgent first, and says who has each', async () => {
    const a = await bot('Reader', {});
    const low = await raise({ impact: 'individual', urgency: 'question' });
    const high = await raise({ impact: 'company', urgency: 'cannot_call' });
    const list = (await s.agentApi.list(a.p, { status: 'open', limit: 50 })).filter((i) => [low.id, high.id].includes(i.id));
    expect(list.map((i) => i.id)).toEqual([high.id, low.id]);
    expect(list[0]).toMatchObject({ tenant_id: c.t.id, tenant_name: 'Contoso', assigned: 'nobody', priority: 'p1', reference: high.reference, taken_over: false });
    expect(list[0]!.next_target.which).toBe('response');
    const none = await bot('Nowhere', {}, undefined, null);
    expect(await s.agentApi.list(none.p, { status: 'open', limit: 50 })).toEqual([]);
    expect((await s.agentApi.list(a.p, { status: 'open', assigned: 'me', limit: 50 })).filter((i) => i.id === low.id)).toEqual([]);
  });

  it('gives an agent the whole picture of one incident, internal notes and its own autonomy included', async () => {
    const a = await bot('Picture', { triage: 3, internal_note: 2 });
    const i = await raise();
    await s.svc.comment(c.t, eng, i.id, { body: 'Checking the SBC logs', internal: true }, true);
    const p = await s.problems.create(c.t, eng, { title: 'Reading wifi drops RTP', description: '', category: 'call_quality', subcategory: null, status: 'known_error', rootCause: 'QoS stripped', workaround: 'Use wired handsets', customerNote: '', ownerId: null } as never);
    expect(p.reference).toMatch(/^PRB-/);
    const twin = await raise();
    const g = await s.agentApi.get(a.p, c.t.id, i.id);
    expect(g.tenant).toEqual({ id: c.t.id, name: 'Contoso' });
    expect(g.incident).toMatchObject({ reference: i.reference, category: 'call_quality', sitecode: 'RDG01', priority: 'p3' });
    expect(g.events.map((e) => e.body).filter(Boolean)).toContain('Checking the SBC logs');
    expect(g.knownErrors.map((k) => k.reference)).toEqual([p.reference]);
    expect(g.knownErrors[0]).toMatchObject({ workaround: 'Use wired handsets' });
    expect(g.similar.map((x) => x.id)).toContain(twin.id);
    expect(g.similar.every((x) => x.id !== i.id)).toBe(true);
    expect(g.autonomy).toMatchObject({ triage: 3, internal_note: 2, customer_update: 1, change_deploy: 0 });
    expect(g.agent).toMatchObject({ hold: false, claim: null, proposals: [] });
  });

  it('refuses an agent anything on a customer it was not allowed on, or when the customer is switched off, or without the scope', async () => {
    const a = await bot('Fenced', {});
    const i = await raise();
    await expect(s.agentApi.get(a.p, other.t.id, i.id)).rejects.toBeInstanceOf(NotFoundException);
    await s.agentAdmin.setPolicy(admin, a.id, other.t.id, { enabled: false, autonomy: {} });
    await expect(s.agentApi.get(a.p, other.t.id, i.id)).rejects.toBeInstanceOf(ForbiddenException);
    await s.agentAdmin.setTenantAgents(admin, c.t.id, false);
    await expect(s.agentApi.get(a.p, c.t.id, i.id)).rejects.toThrow(/switched off for that customer/);
    await s.agentAdmin.setTenantAgents(admin, c.t.id, true);
    const blind = await bot('Blind', {}, ['note']);
    await expect(s.agentApi.get(blind.p, c.t.id, i.id)).rejects.toThrow(/"read" scope/);
  });
});

describe('notes', () => {
  it('are internal, attributed to the agent, and never seen by the customer', async () => {
    const a = await bot('Noter', {});
    const i = await raise();
    sent = []; // (raising it sent the usual "we've got it")
    const r = await s.agentApi.note(a.p, c.t.id, i.id, { body: 'Licence looks fine; the policy is the problem.' });
    expect(r.version).toBeGreaterThan(i.version);
    const e = (await events(i.id)).find((x) => x.body?.startsWith('Licence'))!;
    expect(e).toMatchObject({ internal: true, actor_type: 'agent', author_id: a.id });
    const staff = await s.svc.get(c.t, i.id, true, eng.id);
    expect(staff.events.find((x) => x.id === e.id)!.author_name).toBe(`${a.name} (AI)`);
    const customer = await s.svc.get(c.t, i.id, false, cara.id);
    expect(customer.events.some((x) => x.id === e.id)).toBe(false);
    expect(sent.filter((m) => m.to.email === cara.email)).toHaveLength(0);
  });

  it('need the autonomy to note, and the incident not to be taken over', async () => {
    const mute = await bot('Mute', { internal_note: 0 });
    const i = await raise();
    await expect(s.agentApi.note(mute.p, c.t.id, i.id, { body: 'hello' })).rejects.toBeInstanceOf(ForbiddenException);
    const a = await bot('Locked', { triage: 3 });
    await s.agentApi.claim(a.p, c.t.id, i.id, { ttlSeconds: 600 });
    await s.humanAgents.takeOver(c.t, eng, i.id);
    await expect(s.agentApi.note(a.p, c.t.id, i.id, { body: 'still here' })).rejects.toMatchObject({ response: { code: 'taken_over' } });
  });

  it('are refused from a stale copy, with the current version to read again', async () => {
    const a = await bot('Stale', {});
    const i = await raise();
    await expect(s.agentApi.note(a.p, c.t.id, i.id, { body: 'hi', expectedVersion: i.version + 5 })).rejects.toMatchObject({ response: { code: 'stale', currentVersion: i.version } });
    expect((await s.agentApi.note(a.p, c.t.id, i.id, { body: 'hi', expectedVersion: i.version })).id).toBeTruthy();
  });

  it('happen once for one Idempotency-Key, and can be retried after a failure', async () => {
    const a = await bot('Retry', {});
    const i = await raise();
    const first = await s.agentApi.note(a.p, c.t.id, i.id, { body: 'Once only' }, 'key-1');
    const again = await s.agentApi.note(a.p, c.t.id, i.id, { body: 'Once only' }, 'key-1');
    expect(again).toEqual(first);
    expect((await events(i.id)).filter((e) => e.body === 'Once only')).toHaveLength(1);
    await expect(s.agentApi.note(a.p, c.t.id, i.id, { body: 'Late', expectedVersion: 1 }, 'key-2')).rejects.toBeInstanceOf(ConflictException);
    const ok = await s.agentApi.note(a.p, c.t.id, i.id, { body: 'Late' }, 'key-2');
    expect(ok.id).toBeTruthy(); // the failed attempt did not use up the key
    // Another agent's key is its own.
    const b = await bot('Other', {});
    await s.agentApi.note(b.p, c.t.id, i.id, { body: 'Mine' }, 'key-1');
    expect((await events(i.id)).filter((e) => e.body === 'Mine')).toHaveLength(1);
  });
});

describe('claims', () => {
  it('give an agent the incident for a lease, which it can renew, and let go of', async () => {
    const a = await bot('Claimer', { triage: 1 });
    const i = await raise();
    const claim = await s.agentApi.claim(a.p, c.t.id, i.id, { ttlSeconds: 120, note: 'Triage' });
    expect(claim.renewed).toBe(false);
    expect(await row(i.id)).toMatchObject({ assigned_agent_id: a.id, assigned_to: null });
    expect((await events(i.id)).some((e) => e.kind === 'claim_started' && e.actor_type === 'agent')).toBe(true);
    expect((await s.agentApi.claim(a.p, c.t.id, i.id, { ttlSeconds: 600 })).renewed).toBe(true);
    const beat = await s.agentApi.heartbeat(a.p, c.t.id, i.id, { ttlSeconds: 900 });
    expect(new Date(beat.expires_at).getTime() - Date.now()).toBeGreaterThan(800_000);
    const staff = await s.svc.get(c.t, i.id, true, eng.id);
    expect(staff.agent).toMatchObject({ claim: { agent_name: a.name } });
    expect(staff.incident.assigned_agent_name).toBe(`${a.name} (AI)`);
    expect((await s.svc.get(c.t, i.id, false, cara.id)).incident.assigned_agent_name).toBe('Voxshift assistant');
    expect(await s.agentApi.release(a.p, c.t.id, i.id)).toEqual({ released: true });
    expect(await s.claims.current(c.t, i.id)).toBeNull();
  });

  it('are refused to an observer, for a finished incident, one a person is working, or one another assistant holds', async () => {
    const watcher = await bot('Watcher', { triage: 0 });
    const a = await bot('Holder', { triage: 1 });
    const b = await bot('Rival', { triage: 1 });
    const i = await raise();
    await expect(s.agentApi.claim(watcher.p, c.t.id, i.id, { ttlSeconds: 600 })).rejects.toBeInstanceOf(ForbiddenException);
    await s.agentApi.claim(a.p, c.t.id, i.id, { ttlSeconds: 600 });
    await expect(s.agentApi.claim(b.p, c.t.id, i.id, { ttlSeconds: 600 })).rejects.toBeInstanceOf(ConflictException);
    const mine = await raise();
    await s.svc.assign(c.t, eng, mine.id, { userId: eng.id });
    await expect(s.agentApi.claim(a.p, c.t.id, mine.id, { ttlSeconds: 600 })).rejects.toThrow(/person is working/);
    const done = await raise();
    await s.svc.move(c.t, eng, done.id, { to: 'resolved', note: 'Fixed' }, true);
    await expect(s.agentApi.claim(a.p, c.t.id, done.id, { ttlSeconds: 600 })).rejects.toThrow(/finished/);
  });

  it('lapse: an expired lease no longer blocks a new claimer, and cannot be renewed', async () => {
    const a = await bot('Lapser', { triage: 1 });
    const b = await bot('Taker', { triage: 1 });
    const i = await raise();
    await s.agentApi.claim(a.p, c.t.id, i.id, { ttlSeconds: 120 });
    await c.s.updateTable('incident_claims').set({ expires_at: new Date(Date.now() - 1000).toISOString() } as never).where('incident_id', '=', i.id).execute();
    await expect(s.agentApi.heartbeat(a.p, c.t.id, i.id, { ttlSeconds: 600 })).rejects.toThrow(/lapsed/);
    await c.s.updateTable('incidents').set({ assigned_agent_id: null } as never).where('id', '=', i.id).execute();
    expect((await s.agentApi.claim(b.p, c.t.id, i.id, { ttlSeconds: 600 })).renewed).toBe(false);
    const claims = await c.s.selectFrom('incident_claims').selectAll().where('incident_id', '=', i.id).execute();
    expect(claims.filter((x) => !x.released_at)).toHaveLength(1);
    expect(claims.find((x) => x.agent_id === a.id)!.release_reason).toBe('expired');
  });
});

describe('changing an incident directly', () => {
  it('needs "act alone": below that the agent is told to propose', async () => {
    const a = await bot('Cautious', { triage: 2, resolve: 1 });
    const i = await raise();
    await s.agentApi.claim(a.p, c.t.id, i.id, { ttlSeconds: 600 });
    await expect(s.agentApi.status(a.p, c.t.id, i.id, { to: 'in_progress' })).rejects.toMatchObject({ response: { code: 'propose_instead' } });
    await expect(s.agentApi.priority(a.p, c.t.id, i.id, { priority: 'p2', reason: 'Wider than reported' })).rejects.toBeInstanceOf(ForbiddenException);
    await expect(s.agentApi.linkItem(a.p, c.t.id, i.id, { kind: 'user', ref: 'jo@contoso.test' })).rejects.toBeInstanceOf(ForbiddenException);
    expect((await row(i.id)).status).toBe('new');
  });

  it('needs the agent to hold the lease, then moves the incident as the agent', async () => {
    const a = await bot('Alone', { triage: 3, resolve: 3 });
    const i = await raise();
    await expect(s.agentApi.status(a.p, c.t.id, i.id, { to: 'in_progress' })).rejects.toThrow(/Claim this incident/);
    await s.agentApi.claim(a.p, c.t.id, i.id, { ttlSeconds: 600 });
    sent = [];
    const r = await s.agentApi.status(a.p, c.t.id, i.id, { to: 'in_progress' });
    expect(r.status).toBe('in_progress');
    expect(await row(i.id)).toMatchObject({ assigned_agent_id: a.id, assigned_to: null });
    const e = (await events(i.id)).find((x) => x.kind === 'status_changed')!;
    expect(e).toMatchObject({ actor_type: 'agent', author_id: a.id });
    expect(mails('incident_status_changed').find((m) => m.to.email === cara.email && ctx(m).kind === 'acknowledge')).toBeTruthy();
    expect(sent.every((m) => m.related?.id === i.id)).toBe(true);
    const link = await s.agentApi.linkItem(a.p, c.t.id, i.id, { kind: 'user', ref: 'jo@contoso.test', label: 'Jo Bloggs' });
    expect(link.id).toBeTruthy();
    expect((await s.agentApi.priority(a.p, c.t.id, i.id, { priority: 'p2', reason: 'Wider than reported' })).priority).toBe('p2');
  });

  it('is refused from a stale copy', async () => {
    const a = await bot('StaleActor', { triage: 3 });
    const i = await raise();
    await s.agentApi.claim(a.p, c.t.id, i.id, { ttlSeconds: 600 });
    await expect(s.agentApi.status(a.p, c.t.id, i.id, { to: 'in_progress', expectedVersion: 1 })).rejects.toMatchObject({ response: { code: 'stale' } });
  });

  it('tells the customer it is fixed in the assistant\'s generic name, and lets the lease go', async () => {
    const a = await bot('Fixer', { triage: 3, resolve: 3 });
    const i = await raise();
    await s.agentApi.claim(a.p, c.t.id, i.id, { ttlSeconds: 600 });
    await s.agentApi.status(a.p, c.t.id, i.id, { to: 'in_progress' });
    sent = [];
    await s.agentApi.status(a.p, c.t.id, i.id, { to: 'resolved', note: 'Re-applied the calling policy.' });
    const resolved = mails('incident_resolved').find((m) => m.to.email === cara.email)!;
    expect(ctx(resolved)).toMatchObject({ author: 'Voxshift assistant', note: 'Re-applied the calling policy.' });
    expect(sent.every((m) => !JSON.stringify(m.context).includes(a.name))).toBe(true); // the bot's name never reaches a customer
    expect(sent.every((m) => m.createdBy === null || m.createdBy === undefined)).toBe(true); // an agent is not a user row
    expect(await s.claims.current(c.t, i.id)).toBeNull();
    expect((await s.svc.get(c.t, i.id, false, cara.id)).events.find((e) => e.to_status === 'resolved')!.author_name).toBe('Voxshift assistant');
  });
});

describe('proposals', () => {
  it('are made within an action class the agent may suggest in, and not when it only observes', async () => {
    const a = await bot('Proposer', { customer_update: 1 });
    const watcher = await bot('Observer', { customer_update: 0, triage: 0 });
    const i = await raise();
    const p = await s.agentApi.propose(a.p, c.t.id, i.id, proposal({ kind: 'customer_update', params: { body: 'We have found the cause.' } }));
    expect(p).toMatchObject({ state: 'proposed', kind: 'customer_update', action_class: 'customer_update' });
    await expect(s.agentApi.propose(watcher.p, c.t.id, i.id, proposal({ kind: 'customer_update', params: { body: 'x y z' } }))).rejects.toBeInstanceOf(ForbiddenException);
    const g = await s.agentApi.get(a.p, c.t.id, i.id);
    expect(g.agent!.proposals).toMatchObject([{ id: p.id, state: 'proposed', summary: 'Tell the customer: We have found the cause.' }]);
    expect((await events(i.id)).some((e) => e.kind === 'proposal' && e.internal && e.actor_type === 'agent')).toBe(true);
    expect(mails('incident_activity').find((m) => ctx(m).kind === 'agent_proposal')).toBeTruthy();
    // The customer sees nothing of it.
    expect((await s.svc.get(c.t, i.id, false, cara.id)).events.some((e) => e.kind === 'proposal')).toBe(false);
  });

  it('are limited to five waiting at once per assistant', async () => {
    const a = await bot('Spammer', {});
    const i = await raise();
    for (let k = 0; k < 5; k++) await s.agentApi.propose(a.p, c.t.id, i.id, proposal({ kind: 'link_item', params: { kind: 'user', ref: `u${k}@contoso.test` } }));
    await expect(s.agentApi.propose(a.p, c.t.id, i.id, proposal({ kind: 'link_item', params: { kind: 'user', ref: 'u6@contoso.test' } }))).rejects.toThrow(/already have 5/);
  });

  it('stay with a person even when the customer policy says "act alone" for customer text', async () => {
    const a = await bot('Eager', { customer_update: 3 }).catch(() => null);
    expect(a).toBeNull(); // the policy itself is refused above the cap
    const capped = await bot('Capped', { customer_update: 2 });
    const g = await s.agentApi.get(capped.p, c.t.id, (await raise()).id);
    expect(g.autonomy.customer_update).toBe(2);
  });

  it('when approved are carried out as the assistant, with the approver on the timeline, and the assistant is told', async () => {
    const a = await bot('Writer', { customer_update: 1 });
    const i = await raise();
    const p = await s.agentApi.propose(a.p, c.t.id, i.id, proposal({ kind: 'customer_update', params: { body: 'We have found the cause and are fixing it.' } }));
    sent = [];
    const done = await s.proposals.decide(c.t, eng, i.id, p.id, { decision: 'approve', note: 'Good' });
    expect(done).toMatchObject({ state: 'done', decided_by: eng.id });
    const g = await s.svc.get(c.t, i.id, false, cara.id);
    const posted = g.events.find((e) => e.body === 'We have found the cause and are fixing it.')!;
    expect(posted).toMatchObject({ actor_type: 'agent', internal: false, author_name: 'Voxshift assistant' });
    expect(ctx(mails('incident_message').find((m) => m.to.email === cara.email)!)).toMatchObject({ author: 'Voxshift assistant', kind: 'comment' });
    const staff = await s.svc.get(c.t, i.id, true, eng.id);
    expect(staff.events.find((e) => e.kind === 'proposal_decided')!.body).toContain('Eve Engineer approved');
    const feed = await s.agentApi.feed(a.p, { after: cur, limit: 500 });
    expect(feed.events.find((e) => e.kind === 'proposal.decided' && e.incident_id === i.id)).toMatchObject({ proposalId: p.id, proposalKind: 'customer_update', decision: 'approve', state: 'done' });
  });

  it('when rejected change nothing, and cannot be decided twice or once they have expired', async () => {
    const a = await bot('Rejected', {});
    const i = await raise();
    const p = await s.agentApi.propose(a.p, c.t.id, i.id, proposal({ kind: 'status_change', params: { to: 'on_hold', holdReason: 'carrier' } }));
    const r = await s.proposals.decide(c.t, eng, i.id, p.id, { decision: 'reject', note: 'Not yet' });
    expect(r).toMatchObject({ state: 'rejected', decision_note: 'Not yet' });
    expect((await row(i.id)).status).toBe('new');
    await expect(s.proposals.decide(c.t, eng2, i.id, p.id, { decision: 'approve' })).rejects.toBeInstanceOf(ConflictException);
    const late = await s.agentApi.propose(a.p, c.t.id, i.id, proposal({ kind: 'set_priority', params: { priority: 'p2', reason: 'Wider than reported' } }));
    await c.s.updateTable('incident_actions').set({ expires_at: new Date(Date.now() - 1000).toISOString() } as never).where('id', '=', late.id).execute();
    expect((await s.svc.get(c.t, i.id, true, eng.id)).agent!.proposals.find((x) => x.id === late.id)!.state).toBe('expired');
    await expect(s.proposals.decide(c.t, eng, i.id, late.id, { decision: 'approve' })).rejects.toThrow(/expired/);
    expect((await row(i.id)).priority).toBe('p3');
  });

  it('that fail when carried out say why, and the person sees it', async () => {
    const a = await bot('Failing', {});
    const i = await raise();
    const p = await s.agentApi.propose(a.p, c.t.id, i.id, proposal({ kind: 'status_change', params: { to: 'closed' } })); // can't close a new incident
    const r = await s.proposals.decide(c.t, eng, i.id, p.id, { decision: 'approve' });
    expect(r.state).toBe('failed');
    expect(r.error).toMatch(/can't be moved/);
    expect((await s.svc.get(c.t, i.id, true, eng.id)).events.find((e) => e.kind === 'proposal_decided')!.body).toContain('could not be carried out');
  });

  it('can move an incident, change its priority, assign a person, link an item and declare a major incident, each as the right actor', async () => {
    const a = await bot('Doer', {});
    const i = await raise({ impact: 'company', urgency: 'cannot_call' });
    const approve = async (kind: AgentProposalInput['kind'], params: Record<string, unknown>) => {
      const p = await s.agentApi.propose(a.p, c.t.id, i.id, proposal({ kind, params }));
      return s.proposals.decide(c.t, eng, i.id, p.id, { decision: 'approve' });
    };
    expect((await approve('status_change', { to: 'in_progress' })).state).toBe('done');
    expect((await approve('set_priority', { priority: 'p2', reason: 'Fewer affected than thought' })).state).toBe('done');
    expect((await row(i.id)).priority).toBe('p2');
    expect((await approve('assign_user', { userId: eng2.id })).state).toBe('done');
    expect((await row(i.id)).assigned_to).toBe(eng2.id);
    expect((await approve('link_item', { kind: 'number', ref: '+441189000001' })).state).toBe('done');
    const major = await approve('declare_major', { leadId: eng.id, summary: 'Calls at Reading are failing; we are checking the SBC.' });
    expect(major.state).toBe('done');
    const after = await row(i.id);
    expect(after).toMatchObject({ major: true, lead_id: eng.id, major_declared_by: eng.id }); // declared by the person who approved, not the assistant
    const types = (await events(i.id)).filter((e) => ['status_changed', 'priority_changed'].includes(e.kind)).map((e) => e.actor_type);
    expect(types).toEqual(['agent', 'agent']);
  });

  describe('for the assistant to carry out', () => {
    const ext = { actionClass: 'diagnostic_read', title: 'Check the number assignment' } as const;

    it('are marked approved, and the assistant reports how it went', async () => {
      const a = await bot('Diag', { diagnostic_read: 2 });
      const i = await raise();
      const p = await s.agentApi.propose(a.p, c.t.id, i.id, proposal({ kind: 'external', params: { ...ext } }));
      const r = await s.proposals.decide(c.t, eng, i.id, p.id, { decision: 'approve' });
      expect(r.state).toBe('approved');
      await expect(s.agentApi.proposalResult(a.p, c.t.id, i.id, p.id, { state: 'done', result: { ok: 1 } })).resolves.toMatchObject({ state: 'done', result: { ok: 1 } });
      await expect(s.agentApi.proposalResult(a.p, c.t.id, i.id, p.id, { state: 'done' })).rejects.toThrow(/already done/);
      const mine = await s.agentApi.listProposals(a.p, c.t.id, i.id);
      expect(mine).toMatchObject([{ id: p.id, state: 'done' }]);
    });

    it('cannot be reported on by another agent, before approval, or for steps the platform carries out', async () => {
      const a = await bot('Diag2', { diagnostic_read: 2, customer_update: 1 });
      const b = await bot('Diag3', { diagnostic_read: 2 });
      const i = await raise();
      const p = await s.agentApi.propose(a.p, c.t.id, i.id, proposal({ kind: 'external', params: { ...ext } }));
      await expect(s.agentApi.proposalResult(a.p, c.t.id, i.id, p.id, { state: 'done' })).rejects.toThrow(/not approved/);
      await s.proposals.decide(c.t, eng, i.id, p.id, { decision: 'approve' });
      await expect(s.agentApi.proposalResult(b.p, c.t.id, i.id, p.id, { state: 'done' })).rejects.toBeInstanceOf(NotFoundException);
      const u = await s.agentApi.propose(a.p, c.t.id, i.id, proposal({ kind: 'customer_update', params: { body: 'Hello there' } }));
      await s.proposals.decide(c.t, eng, i.id, u.id, { decision: 'approve' });
      await expect(s.agentApi.proposalResult(a.p, c.t.id, i.id, u.id, { state: 'done' })).rejects.toThrow(/platform carried that one out/);
    });

    it('fail straight away if the assistant is no longer allowed to carry out that kind of step', async () => {
      const a = await bot('Demoted', { diagnostic_read: 2 });
      const i = await raise();
      const p = await s.agentApi.propose(a.p, c.t.id, i.id, proposal({ kind: 'external', params: { ...ext } }));
      await s.agentAdmin.setPolicy(admin, a.id, c.t.id, { enabled: true, autonomy: { diagnostic_read: 1 } });
      const r = await s.proposals.decide(c.t, eng, i.id, p.id, { decision: 'approve' });
      expect(r.state).toBe('failed');
      expect(r.error).toMatch(/below "Act with approval"/);
    });

    it('take an assistant off the incident when two of its steps fail', async () => {
      const a = await bot('Clumsy', { triage: 1, diagnostic_read: 2 });
      const i = await raise();
      await s.agentApi.claim(a.p, c.t.id, i.id, { ttlSeconds: 600 });
      for (let k = 0; k < 2; k++) {
        const p = await s.agentApi.propose(a.p, c.t.id, i.id, proposal({ kind: 'external', params: { ...ext, title: `Attempt number ${k}` } }));
        await s.proposals.decide(c.t, eng, i.id, p.id, { decision: 'approve' });
        sent = [];
        await s.agentApi.proposalResult(a.p, c.t.id, i.id, p.id, { state: 'failed', error: 'The tenant connection was refused.' });
      }
      expect(await row(i.id)).toMatchObject({ assigned_agent_id: null });
      expect(await s.claims.current(c.t, i.id)).toBeNull();
      expect((await events(i.id)).some((e) => e.kind === 'claim_released' && /stopped working/.test(e.body ?? ''))).toBe(true);
      expect(mails('incident_activity').find((m) => ctx(m).kind === 'agent_lapsed')).toBeTruthy();
      expect((await s.agentApi.feed(a.p, { after: cur, limit: 500 })).events.some((e) => e.kind === 'claim.expired' && e.incident_id === i.id)).toBe(true);
    });
  });
});

describe('handing over', () => {
  it('an assistant hands an incident to the team with a structured summary', async () => {
    const a = await bot('Hander', { triage: 1 });
    const i = await raise();
    await s.agentApi.claim(a.p, c.t.id, i.id, { ttlSeconds: 600 });
    sent = [];
    const r = await s.agentApi.handoff(a.p, c.t.id, i.id, {
      to: 'queue',
      summary: { tried: ['Checked the licence', 'Checked the voice routing policy'], found: ['No Phone System licence'], recommendation: 'Assign a Phone System licence to Jo.', confidence: 'high', evidence: [{ label: 'Licence report' }] },
    });
    expect(r).toMatchObject({ handedOff: true, assignedTo: null });
    expect(await row(i.id)).toMatchObject({ assigned_agent_id: null, assigned_to: null });
    expect(await s.claims.current(c.t, i.id)).toBeNull();
    const e = (await events(i.id)).find((x) => x.kind === 'handoff')!;
    expect(e).toMatchObject({ internal: true, actor_type: 'agent' });
    expect(e.body).toContain('Recommendation: Assign a Phone System licence to Jo.');
    expect(e.body).toContain('- No Phone System licence');
    expect((e.meta as { confidence: string }).confidence).toBe('high');
    expect(ctx(mails('incident_activity').find((m) => ctx(m).kind === 'agent_handoff')!).body).toContain('confidence: high');
    expect((await s.svc.get(c.t, i.id, false, cara.id)).events.some((x) => x.kind === 'handoff')).toBe(false);
  });

  it('can name the person it hands to, and must actually be working the incident', async () => {
    const a = await bot('Hander2', { triage: 1 });
    const i = await raise();
    const summary = { tried: [], found: [], recommendation: 'Over to you.', confidence: 'low' as const, evidence: [] };
    await expect(s.agentApi.handoff(a.p, c.t.id, i.id, { to: 'queue', summary })).rejects.toThrow(/not working this incident/);
    await s.agentApi.claim(a.p, c.t.id, i.id, { ttlSeconds: 600 });
    expect((await s.agentApi.handoff(a.p, c.t.id, i.id, { to: 'human', toUserId: eng2.id, summary })).assignedTo).toBe(eng2.id);
    expect(await row(i.id)).toMatchObject({ assigned_to: eng2.id, assigned_agent_id: null });
  });

  it('a person takes over: the lease is revoked, the assistant is told and locked out of writing, and the person has it', async () => {
    const a = await bot('Overruled', { triage: 3 });
    const i = await raise();
    await s.agentApi.claim(a.p, c.t.id, i.id, { ttlSeconds: 600 });
    await s.agentApi.status(a.p, c.t.id, i.id, { to: 'in_progress' });
    const r = await s.humanAgents.takeOver(c.t, eng, i.id);
    expect(r).toMatchObject({ agent_hold: true, assigned_agent_id: null, assigned_to: eng.id });
    expect(await s.claims.current(c.t, i.id)).toBeNull();
    const told = (await s.agentApi.feed(a.p, { after: cur, limit: 500 })).events.find((e) => e.kind === 'claim.revoked' && e.incident_id === i.id);
    expect(told).toMatchObject({ by: 'Eve Engineer', hold: true });
    await expect(s.agentApi.status(a.p, c.t.id, i.id, { to: 'on_hold', holdReason: 'carrier' })).rejects.toMatchObject({ response: { code: 'taken_over' } });
    await expect(s.agentApi.claim(a.p, c.t.id, i.id, { ttlSeconds: 600 })).rejects.toThrow(/taken this incident over/);
    expect((await s.agentApi.get(a.p, c.t.id, i.id)).agent).toMatchObject({ hold: true }); // it can still read
    expect((await events(i.id)).find((e) => e.kind === 'claim_released')!.body).toContain(`took over from ${a.name} (AI)`);
    // The other assistant doesn't hear that one.
    const b = await bot('Bystander', {});
    expect((await s.agentApi.feed(b.p, { after: cur, limit: 500 })).events.some((e) => e.kind === 'claim.revoked')).toBe(false);
  });

  it('can be handed back to an assistant, which lifts the lock', async () => {
    const a = await bot('Returned', { triage: 3 });
    const i = await raise();
    await s.agentApi.claim(a.p, c.t.id, i.id, { ttlSeconds: 600 });
    await s.humanAgents.takeOver(c.t, eng, i.id);
    await s.svc.assign(c.t, eng, i.id, { userId: null });
    const back = await s.humanAgents.handBack(c.t, eng, i.id, a.id);
    expect(back).toMatchObject({ agent_hold: false, assigned_agent_id: a.id, assigned_to: null });
    expect((await s.agentApi.claim(a.p, c.t.id, i.id, { ttlSeconds: 600 })).renewed).toBe(false);
    const told = (await s.agentApi.feed(a.p, { after: cur, limit: 500 })).events.find((e) => e.kind === 'incident.assigned' && e.incident_id === i.id);
    expect(told).toBeTruthy();
  });

  it('only take over where an assistant is working', async () => {
    const i = await raise();
    await expect(s.humanAgents.takeOver(c.t, eng, i.id)).rejects.toThrow(/No assistant/);
  });
});

describe('assigning to an assistant', () => {
  it('works for assistants allowed on the customer, and not for paused ones, off-customer ones or when switched off', async () => {
    const ok = await bot('Assignable', {});
    const paused = await bot('PausedBot', {});
    const stranger = await bot('Stranger', {}, undefined, null);
    await s.agentAdmin.update(admin, paused.id, { status: 'paused' });
    const names = (await s.humanAgents.agents(c.t)).map((x) => x.id);
    expect(names).toContain(ok.id);
    expect(names).not.toContain(paused.id);
    expect(names).not.toContain(stranger.id);
    const i = await raise();
    await expect(s.svc.assign(c.t, eng, i.id, { agentId: paused.id })).rejects.toBeInstanceOf(BadRequestException);
    await expect(s.svc.assign(c.t, eng, i.id, { agentId: stranger.id })).rejects.toBeInstanceOf(BadRequestException);
    const r = await s.svc.assign(c.t, eng, i.id, { agentId: ok.id });
    expect(r).toMatchObject({ assigned_agent_id: ok.id, assigned_to: null });
    expect((await events(i.id)).find((e) => e.kind === 'assigned')!.body).toBe(`${ok.name} (AI)`);
    expect((await s.agentApi.feed(ok.p, { after: cur, limit: 500 })).events.some((e) => e.kind === 'incident.assigned' && e.incident_id === i.id)).toBe(true);
    await s.agentAdmin.setKillSwitch(admin, { allDisabled: true });
    expect(await s.humanAgents.agents(c.t)).toEqual([]);
    await s.agentAdmin.setKillSwitch(admin, { allDisabled: false });
    await s.agentAdmin.setTenantAgents(admin, c.t.id, false);
    expect(await s.humanAgents.agents(c.t)).toEqual([]);
  });

  it('is undone by giving the incident to a person, which stops the assistant', async () => {
    const a = await bot('Displaced', { triage: 3 });
    const i = await raise();
    await s.svc.assign(c.t, eng, i.id, { agentId: a.id });
    await s.agentApi.claim(a.p, c.t.id, i.id, { ttlSeconds: 600 });
    await s.svc.assign(c.t, eng, i.id, { userId: eng2.id });
    expect(await s.claims.current(c.t, i.id)).toBeNull();
    expect(await row(i.id)).toMatchObject({ assigned_to: eng2.id, assigned_agent_id: null });
    expect((await s.agentApi.feed(a.p, { after: cur, limit: 500 })).events.some((e) => e.kind === 'claim.revoked' && e.incident_id === i.id)).toBe(true);
    await expect(s.agentApi.status(a.p, c.t.id, i.id, { to: 'on_hold', holdReason: 'carrier' })).rejects.toThrow(/Claim this incident/);
  });

  it('lets the incident list show and filter what is with an assistant', async () => {
    const a = await bot('Listed', { triage: 1 });
    const i = await raise();
    await s.svc.assign(c.t, eng, i.id, { agentId: a.id });
    const list = await s.svc.list(c.t, eng, { status: 'open', assigned: 'agent', limit: 200 });
    expect(list.find((x) => x.id === i.id)).toMatchObject({ assigned_agent_id: a.id, assigned_agent_name: a.name });
    expect(list.every((x) => x.assigned_agent_id)).toBe(true);
    expect((await s.svc.list(c.t, eng, { status: 'open', assigned: 'none', limit: 200 })).some((x) => x.id === i.id)).toBe(false);
  });
});

describe('the events feed', () => {
  it('tells an agent what happened on the customers it may work, in order, with a cursor', async () => {
    const a = await bot('Feeder', {});
    const before = (await s.agentApi.feed(a.p, { after: cur, limit: 500 })).next;
    const i = await raise();
    await s.svc.move(c.t, eng, i.id, { to: 'in_progress' }, true);
    await s.svc.comment(c.t, cara, i.id, { body: 'It is still happening' }, false);
    const feed = await s.agentApi.feed(a.p, { after: before, limit: 500 });
    const mine = feed.events.filter((e) => e.incident_id === i.id);
    expect(mine.map((e) => e.kind)).toEqual(['incident.created', 'incident.updated', 'incident.message']);
    expect(mine[0]).toMatchObject({ tenant_id: c.t.id, reference: i.reference, priority: 'p3', by: 'customer' });
    expect(mine[1]).toMatchObject({ change: 'status', from: 'new', to: 'in_progress' });
    expect(mine[2]).toMatchObject({ by: 'customer', internal: false });
    expect(feed.next).toBe(feed.events[feed.events.length - 1]!.id);
    const again = await s.agentApi.feed(a.p, { after: feed.next, limit: 500 });
    expect(again.events).toEqual([]);
    expect(again.next).toBe(feed.next);
    const page = await s.agentApi.feed(a.p, { after: before, limit: 1 });
    expect(page.events).toHaveLength(1);
  });

  it('stays within the customers an agent is allowed on, and records nothing when no agent is', async () => {
    const a = await bot('Fenced2', {});
    await s.agentAdmin.setPolicy(admin, a.id, other.t.id, { enabled: false, autonomy: {} });
    const siteOther = (await seedSite(other.s, { sitecode: 'ELS01' })).id;
    await other.s.updateTable('discovery_sites').set({ mode: 'operations' } as never).execute();
    const before = (await s.agentApi.feed(a.p, { after: cur, limit: 500 })).next;
    const ev = await s.svc.create(other.t, cara, call({ siteId: siteOther }), false);
    expect((await s.agentApi.feed(a.p, { after: before, limit: 500 })).events.some((e) => e.incident_id === ev.id)).toBe(false);
    expect(await platformDb(handle.db).selectFrom('agent_events').select('id').where('incident_id', '=', ev.id).execute()).toEqual([]); // no agent may work that customer: nothing recorded
  });
});

describe('the report', () => {
  it('says who fixed the incidents resolved in a period: an assistant alone, a person with its help, or a person alone', async () => {
    const t = await seedCustomer(handle, { managedServices: true });
    const site = (await seedSite(t.s, { sitecode: 'FIX01' })).id;
    await t.s.updateTable('discovery_sites').set({ mode: 'operations' } as never).execute();
    await platformDb(handle.db).insertInto('tenant_memberships').values([{ tenant_id: t.t.id, user_id: eng.id }] as never).execute();
    const a = await s.agentAdmin.create(admin, createAgentSchema.parse({ name: `Fixer-${Date.now()}`, kind: 'resolver' }));
    await s.agentAdmin.setPolicy(admin, a.id, t.t.id, { enabled: true, autonomy: { triage: 3, resolve: 3, internal_note: 3 } });
    const p = { agentId: a.id, tokenId: 't', name: a.name, kind: 'resolver' as const, scopes: ['read', 'note', 'propose', 'act'] as ('read' | 'note' | 'propose' | 'act')[] };
    const mk = () => s.svc.create(t.t, cara, call({ siteId: site }), false);
    const alone = await mk();
    await s.agentApi.claim(p, t.t.id, alone.id, { ttlSeconds: 600 });
    await s.agentApi.status(p, t.t.id, alone.id, { to: 'in_progress' });
    await s.agentApi.status(p, t.t.id, alone.id, { to: 'resolved', note: 'Fixed by the assistant' });
    const helped = await mk();
    await s.agentApi.note(p, t.t.id, helped.id, { body: 'It looks like a licence problem.' });
    await s.svc.move(t.t, eng, helped.id, { to: 'resolved', note: 'Assigned the licence' }, true);
    const human = await mk();
    await s.svc.move(t.t, eng, human.id, { to: 'resolved', note: 'Fixed by a person' }, true);
    const from = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
    const to = new Date(Date.now() + 2 * 86_400_000).toISOString().slice(0, 10);
    const r = await s.reports.report(t.t, from, to, true);
    expect(r.resolved).toBe(3);
    expect(r.fixed_by).toEqual({ agent: 1, person_with_agent: 1, person: 1 });
  });
});
