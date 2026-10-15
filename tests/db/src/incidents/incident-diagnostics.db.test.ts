// Diagnostic runbooks (docs/DIAGNOSTICS.md): they read what Discovery and the design hold, say how old that is,
// keep their results on the incident and its timeline, and are open to assistants only as far as their autonomy allows.
import { beforeAll, describe, expect, it } from 'vitest';
import { platformDb } from '@tvmf/db';
import { createAgentSchema, createIncidentSchema, type AgentAutonomy, type CreateIncidentInput } from '@tvmf/shared';
import { seedCustomer, seedSite, seedUser, useDb, type TestCustomer } from '../helpers';
import { incidentServices } from './services';

const handle = useDb();
let c: TestCustomer;
let s: ReturnType<typeof incidentServices>;
let admin: Awaited<ReturnType<typeof seedUser>>;
let eng: Awaited<ReturnType<typeof seedUser>>;
let cara: Awaited<ReturnType<typeof seedUser>>;
let siteId: string;
let n = 0;

const call = (over: Partial<CreateIncidentInput> = {}) =>
  createIncidentSchema.parse({
    title: 'Sales queue not ringing',
    category: 'queues_aa',
    subcategory: 'queue_not_ringing',
    siteId,
    impact: 'team',
    urgency: 'degraded',
    description: 'Nobody in Sales hears the queue ring.',
    answers: { which: 'Sales queue', expected: 'Agents ring', actual: 'Nothing rings', started: 'Today 09:00' },
    ...over,
  });
const raise = (over: Partial<CreateIncidentInput> = {}) => s.svc.create(c.t, cara, call(over), false);
const titles = (r: { findings: { status: string; title: string }[] }, status: string) => r.findings.filter((f) => f.status === status).map((f) => f.title);

async function object(type: string, key: string, name: string | null, data: Record<string, unknown> = {}) {
  return c.s.insertInto('tenant_objects').values({ object_type: type, object_key: key, display_name: name, data: JSON.stringify(data) } as never).returning('id').executeTakeFirstOrThrow();
}
async function tenantUser(upn: string, over: Record<string, unknown> = {}) {
  const o = await object('user', upn, (over.display_name as string) ?? upn, {});
  await c.s
    .insertInto('tenant_users')
    .values({
      object_id: o.id,
      upn,
      display_name: upn.split('@')[0],
      entra_id: `eid-${upn}`,
      account_type: 'User',
      account_enabled: true,
      enterprise_voice_enabled: true,
      line_uri: null,
      usage_location: 'GB',
      feature_types: ['PhoneSystem'],
      assigned_plans: JSON.stringify([{ Capability: 'MCOEV', CapabilityStatus: 'Enabled' }]),
      policies: JSON.stringify({ OnlineVoiceRoutingPolicy: 'UK-Routing', TeamsCallingPolicy: 'Standard' }),
      ...over,
    } as never)
    .execute();
}
async function discovery(at: string | null = new Date(Date.now() - 86_400_000).toISOString()) {
  if (at) await c.s.insertInto('tenant_discovery_runs').values({ status: 'completed', started_by: admin.id, started_at: at, finished_at: at, scope_types: null } as never).execute();
}

/** An agent allowed on the customer at the given level for read-only checks, and its principal. */
async function bot(diag: 0 | 1 | 2 | 3, extra: AgentAutonomy = {}) {
  const a = await s.agentAdmin.create(admin, createAgentSchema.parse({ name: `Diag-${++n}-${Date.now() % 100000}`, kind: 'diagnostic' }));
  await s.agentAdmin.setPolicy(admin, a.id, c.t.id, { enabled: true, autonomy: { diagnostic_read: diag, internal_note: 3, triage: 3, ...extra } });
  return { id: a.id, name: a.name, p: { agentId: a.id, tokenId: 't', worksOn: ['incidents', 'service_requests'] as ('incidents' | 'service_requests')[], name: a.name, kind: 'diagnostic' as const, scopes: ['read', 'note', 'propose', 'act'] as ('read' | 'note' | 'propose' | 'act')[] } };
}

beforeAll(async () => {
  c = await seedCustomer(handle, { managedServices: true });
  admin = await seedUser(handle, 'SUPER_ADMIN', { displayName: 'Ada Admin' });
  eng = await seedUser(handle, 'ENGINEER', { displayName: 'Eve Engineer' });
  cara = await seedUser(handle, 'CUSTOMER', { displayName: 'Cara Customer' });
  await platformDb(handle.db).insertInto('tenant_memberships').values([eng, cara].map((u) => ({ tenant_id: c.t.id, user_id: u.id })) as never).execute();
  siteId = (await seedSite(c.s, { sitecode: 'RDG01' })).id;
  await c.s.updateTable('discovery_sites').set({ mode: 'operations' } as never).execute();
  s = incidentServices(handle);

  // A tenant: a working user, a broken one, a queue with one good and one bad agent, routes and an emergency location.
  await discovery();
  await tenantUser('anna@contoso.com', { line_uri: 'tel:+441189000111', display_name: 'Anna Ng' });
  await tenantUser('ben@contoso.com', { enterprise_voice_enabled: false, assigned_plans: JSON.stringify([{ Capability: 'TEAMS1', CapabilityStatus: 'Enabled' }]), display_name: 'Ben Ode' });
  await tenantUser('cleo@contoso.com', { account_enabled: false, line_uri: 'tel:+441189000222', display_name: 'Cleo Ray' });
  await object('phone_number', '+441189000111', '+441189000111', { NumberType: 'DirectRouting', AssignmentStatus: 'UserAssigned', ActivationState: 'Activated', City: 'Reading' });
  await object('resource_account', 'ra-sales', 'ra-sales@contoso.com', { PhoneNumber: 'tel:+441189000500' });
  await object('call_queue', 'cq-sales', 'Sales queue', {
    Agents: [{ ObjectId: 'eid-anna@contoso.com' }, { ObjectId: 'eid-cleo@contoso.com' }],
    ApplicationInstances: ['ra-sales'],
    OverflowActionTarget: { Id: 'eid-gone@contoso.com', Type: 'User' },
    TimeoutActionTarget: { Id: 'eid-anna@contoso.com', Type: 'User' },
  });
  await object('pstn_gateway', 'sbc1.contoso.com', 'sbc1.contoso.com', { Fqdn: 'sbc1.contoso.com', Enabled: true });
  await object('voice_route', 'UK', 'UK', { OnlinePstnGatewayList: ['sbc1.contoso.com', 'sbc9.contoso.com'], OnlinePstnUsages: ['UK'] });
  await object('pstn_usage', 'UK', 'UK', {});
  await object('emergency_location', 'loc1', 'Reading HQ', { CivicAddressId: 'ca1', ValidationStatus: 'Validated' });
  await object('civic_address', 'ca1', 'Reading civic', {});
});

describe('user voice', () => {
  it('finds a healthy user clean and says how old the data is', async () => {
    const r = await s.diagnostics.check(c.t, 'user_voice', 'anna@contoso.com');
    expect(r.status).toBe('ok');
    expect(r.subject).toBe('anna@contoso.com');
    expect(r.dataAsOf).not.toBeNull();
  });
  it('finds a broken user, by name too', async () => {
    const r = await s.diagnostics.check(c.t, 'user_voice', 'Ben');
    expect(r.status).toBe('fail');
    expect(titles(r, 'fail')).toEqual(['Enterprise Voice is off', 'No Teams Phone licence found']);
  });
  it('flags a disabled account and reports a stranger', async () => {
    expect(titles(await s.diagnostics.check(c.t, 'user_voice', 'cleo@contoso.com'), 'fail')).toEqual(['The account is disabled']);
    expect((await s.diagnostics.check(c.t, 'user_voice', 'zed@contoso.com')).findings[0]!.title).toBe('zed@contoso.com is not in the last Discovery');
  });
  it('compares with the design and the number list', async () => {
    await c.s.insertInto('discovery_calling_policies').values({ name: 'Premium' } as never).execute();
    const pol = await c.s.selectFrom('discovery_calling_policies').select('id').where('name', '=', 'Premium').executeTakeFirstOrThrow();
    await c.s.insertInto('discovery_users').values({ upn: 'anna@contoso.com', display_name: 'Anna Ng', site_id: siteId, calling_policy_id: pol.id, requested_number: '+441189000999' } as never).execute();
    const r = await s.diagnostics.check(c.t, 'user_voice', 'anna@contoso.com');
    expect(titles(r, 'warn')).toEqual(['Calling policy differs from the design', 'The number differs from the design']);
    await c.s.deleteFrom('discovery_users').where('upn', '=', 'anna@contoso.com').execute();
  });
  it('needs something to look at', async () => {
    await expect(s.diagnostics.check(c.t, 'user_voice', '')).rejects.toThrow(/Say which/);
  });
});

describe('number check', () => {
  it('knows a number the tenant has, however it is written', async () => {
    const r = await s.diagnostics.check(c.t, 'number_check', '0118 900 0111'.replace(/^0/, '+44 ').replace(/\s/g, ''));
    expect(titles(r, 'ok')).toContain('In the tenant number list');
    expect(titles(r, 'ok')).toContain('Assigned to a person');
  });
  it('fails a number nobody has, and finds one on a resource account', async () => {
    expect((await s.diagnostics.check(c.t, 'number_check', '+441189000777')).status).toBe('fail');
    const ra = await s.diagnostics.check(c.t, 'number_check', '+441189000500');
    expect(titles(ra, 'ok')).toContain('Held by 1 resource account');
  });
  it('sets the inventory beside the tenant', async () => {
    const range = await c.s.insertInto('discovery_number_ranges').values({ range_start: '+441189000000', range_end: '+441189000999', kind: 'new', carrier: 'Acme' } as never).returning('id').executeTakeFirstOrThrow();
    await c.s.insertInto('phone_numbers').values({ range_id: range.id, e164: '+441189000111', status: 'available' } as never).execute();
    const r = await s.diagnostics.check(c.t, 'number_check', '+441189000111');
    expect(titles(r, 'warn')).toEqual(['Inventory says available but the tenant has it assigned']);
  });
});

describe('queue check', () => {
  it('finds the agents who cannot take calls and the targets that are gone', async () => {
    const r = await s.diagnostics.check(c.t, 'queue_check', 'sales');
    expect(r.subject).toBe('Sales queue');
    expect(titles(r, 'warn')).toEqual(['1 of 2 agents cannot take calls']);
    expect(titles(r, 'fail')).toEqual(['Overflow goes to something that no longer exists']);
    expect(titles(r, 'ok')).toContain('Time-out');
    expect(titles(r, 'ok')).toContain('Resource account with a number');
  });
  it('compares with the design queue by name', async () => {
    await c.s
      .insertInto('build_call_queues')
      .values({ site_id: siteId, name: 'Sales queue', agents: JSON.stringify(['anna@contoso.com', 'dan@contoso.com']), resource_accounts: JSON.stringify([]), overflow: JSON.stringify({}), timeout: JSON.stringify({}), no_agent_action: JSON.stringify({}) } as never)
      .execute();
    const r = await s.diagnostics.check(c.t, 'queue_check', 'Sales queue');
    expect(titles(r, 'warn')).toContain('Agents in the design who are not in the live queue');
    expect(r.findings.find((f) => f.title.startsWith('Agents in the live queue'))!.detail).toBe('cleo@contoso.com');
  });
  it('says so when there is no such queue', async () => {
    expect((await s.diagnostics.check(c.t, 'queue_check', 'Nope')).status).toBe('fail');
  });
});

describe('routing, emergency and recent changes', () => {
  it('finds the route that lists a missing gateway', async () => {
    const r = await s.diagnostics.check(c.t, 'routing_check', '');
    expect(titles(r, 'warn')).toEqual(['Route "UK" lists a gateway that is missing or disabled']);
    expect(titles(r, 'ok')).toContain('1 gateway, all enabled');
  });
  it('checks the emergency setup', async () => {
    const r = await s.diagnostics.check(c.t, 'emergency_check', '');
    expect(r.status).toBe('ok');
    expect(titles(r, 'ok')).toEqual(['1 emergency location']);
  });
  it('lists what changed and what failed', async () => {
    const o = await object('call_queue', 'cq-new', 'Support queue', {});
    await c.s.insertInto('tenant_object_versions').values({ object_id: o.id, object_type: 'call_queue', object_key: 'cq-new', display_name: 'Support queue', change_kind: 'removed', changed_fields: [] } as never).execute();
    const d = await c.s.insertInto('deployments').values({ mode: 'execute', scope: JSON.stringify({}), status: 'completed', created_by: admin.id, summary: JSON.stringify({}) } as never).returning('id').executeTakeFirstOrThrow();
    await c.s.insertInto('deployment_changes').values({ deployment_id: d.id, seq: 1, correlation_id: 'c1', object_type: 'call_queue', cmdlet: 'Set-CsCallQueue', parameters: JSON.stringify({}), before: JSON.stringify({}), after: JSON.stringify({}), result: 'failed' } as never).execute();
    const r = await s.diagnostics.check(c.t, 'recent_changes', '');
    expect(titles(r, 'fail')).toEqual(['1 deployment with failures']);
    expect(titles(r, 'warn')).toEqual(['1 object removed from the tenant']);
  });
});

describe('on an incident', () => {
  it('stores the result, notes it on the timeline for staff only, and lists it with who ran it', async () => {
    const i = await raise();
    const r = await s.diagnostics.run(c.t, eng, i.id, { runbook: 'queue_check', input: 'Sales queue' });
    expect(r.id).toBeTruthy();
    const list = await s.diagnostics.list(c.t, i.id);
    expect(list).toMatchObject([{ runbook: 'queue_check', subject: 'Sales queue', status: 'fail', actor_type: 'user', run_by_name: 'Eve Engineer' }]);
    const ev = await c.s.selectFrom('incident_events').selectAll().where('incident_id', '=', i.id).where('kind', '=', 'diagnostic').execute();
    expect(ev).toHaveLength(1);
    expect(ev[0]).toMatchObject({ internal: true, actor_type: 'user', author_id: eng.id });
    expect(ev[0]!.body).toMatch(/^Call queue or auto attendant: Sales queue: 1 problem/);
    // The customer never sees it.
    const view = await s.svc.get(c.t, i.id, false, cara.id);
    expect(view.events.some((e: { kind: string }) => e.kind === 'diagnostic')).toBe(false);
  });
  it('does not touch the incident itself (no new version, so nobody is made stale)', async () => {
    const i = await raise();
    const before = await c.s.selectFrom('incidents').select('version').where('id', '=', i.id).executeTakeFirstOrThrow();
    await s.diagnostics.run(c.t, eng, i.id, { runbook: 'routing_check' });
    expect((await c.s.selectFrom('incidents').select('version').where('id', '=', i.id).executeTakeFirstOrThrow()).version).toBe(before.version);
  });
  it('suggests the checks the category and the answers point at', async () => {
    const i = await raise();
    const sug = await s.diagnostics.suggest(c.t, i.id);
    expect(sug.map((x) => `${x.runbook}:${x.input}`)).toEqual(['queue_check:Sales queue', 'recent_changes:']);
    await s.svc.addItem(c.t, eng, i.id, { kind: 'user', ref: 'anna@contoso.com' });
    expect((await s.diagnostics.suggest(c.t, i.id)).map((x) => x.runbook)).toEqual(['queue_check', 'user_voice', 'recent_changes']);
  });
  it('is refused for an incident that does not exist', async () => {
    await expect(s.diagnostics.run(c.t, eng, '00000000-0000-4000-8000-000000000000', { runbook: 'routing_check' })).rejects.toThrow(/not found/);
  });
});

describe('assistants', () => {
  it('act alone: runs a check on an incident it holds, and sees the result in its view of the incident', async () => {
    const b = await bot(3);
    const i = await raise();
    await expect(s.agentApi.diagnostic(b.p, c.t.id, i.id, { runbook: 'routing_check' })).rejects.toThrow(/lease|claim|holding/i);
    await s.agentApi.claim(b.p, c.t.id, i.id, { ttlSeconds: 600 });
    const r = await s.agentApi.diagnostic(b.p, c.t.id, i.id, { runbook: 'queue_check', input: 'Sales queue' });
    expect(r.actor_type).toBe('agent');
    expect(r.run_by_name).toMatch(/\(AI\)$/);
    const got = await s.agentApi.get(b.p, c.t.id, i.id);
    expect(got.diagnostics).toMatchObject([{ runbook: 'queue_check', status: 'fail' }]);
    expect(got.suggestedChecks.map((x: { runbook: string }) => x.runbook)).toContain('queue_check');
    expect((await s.agentApi.listDiagnostics(b.p, c.t.id, i.id)).results).toHaveLength(1);
  });
  it('suggest level: has to propose the check, and may run it once a person approves', async () => {
    const b = await bot(1);
    const i = await raise();
    await s.agentApi.claim(b.p, c.t.id, i.id, { ttlSeconds: 600 });
    await expect(s.agentApi.diagnostic(b.p, c.t.id, i.id, { runbook: 'routing_check' })).rejects.toMatchObject({ response: { code: 'propose_instead' } });
    // Level 1 cannot run an approved one either: only "act with approval" carries steps out.
    const p = await s.agentApi.propose(b.p, c.t.id, i.id, { kind: 'external', params: { actionClass: 'diagnostic_read', title: 'Check routes' }, rationale: 'Routes are the first thing to rule out', risk: 'low', expiresInMinutes: 60 });
    await s.proposals.decide(c.t, eng, i.id, p.id, { decision: 'approve' });
    await expect(s.agentApi.diagnostic(b.p, c.t.id, i.id, { runbook: 'routing_check', proposalId: p.id })).rejects.toMatchObject({ response: { code: 'propose_instead' } });
  });
  it('act with approval: runs the approved check, which marks the proposal done', async () => {
    const b = await bot(2);
    const i = await raise();
    await s.agentApi.claim(b.p, c.t.id, i.id, { ttlSeconds: 600 });
    const p = await s.agentApi.propose(b.p, c.t.id, i.id, { kind: 'external', params: { actionClass: 'diagnostic_read', title: 'Check the queue' }, rationale: 'Look at the queue', risk: 'low', expiresInMinutes: 60 });
    await expect(s.agentApi.diagnostic(b.p, c.t.id, i.id, { runbook: 'queue_check', input: 'Sales queue', proposalId: p.id })).rejects.toThrow(/not approved/);
    await s.proposals.decide(c.t, eng, i.id, p.id, { decision: 'approve' });
    const r = await s.agentApi.diagnostic(b.p, c.t.id, i.id, { runbook: 'queue_check', input: 'Sales queue', proposalId: p.id });
    expect(r.status).toBe('fail');
    const after = await c.s.selectFrom('incident_actions').select(['state', 'result']).where('id', '=', p.id).executeTakeFirstOrThrow();
    expect(after.state).toBe('done');
    expect(after.result).toMatchObject({ diagnosticId: r.id, status: 'fail' });
    // Someone else's proposal, or a different kind of step, does not open the door.
    await expect(s.agentApi.diagnostic(b.p, c.t.id, i.id, { runbook: 'routing_check', proposalId: p.id })).rejects.toThrow();
  });
  it('observe level cannot; a person who took over locks the assistant out', async () => {
    const b0 = await bot(0);
    const i = await raise();
    await expect(s.agentApi.diagnostic(b0.p, c.t.id, i.id, { runbook: 'routing_check' })).rejects.toThrow(/observe/);
    const b3 = await bot(3);
    await s.agentApi.claim(b3.p, c.t.id, i.id, { ttlSeconds: 600 });
    await s.humanAgents.takeOver(c.t, eng, i.id);
    await expect(s.agentApi.diagnostic(b3.p, c.t.id, i.id, { runbook: 'routing_check' })).rejects.toMatchObject({ response: { code: 'taken_over' } });
  });
});
