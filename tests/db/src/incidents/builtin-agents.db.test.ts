// The assistants Voxshift ships (docs/BUILTIN-AGENTS.md): Triage, Diagnose and Comms work incidents through the
// same agent API as any outside agent, so the customer's policy, the lease, proposals and the kill switches all hold.
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { platformDb } from '@tvmf/db';
import { agentProposalSchema, createIncidentSchema, type AgentAutonomy, type CreateIncidentInput } from '@tvmf/shared';
import { seedCustomer, seedSite, seedUser, useDb, type TestCustomer } from '../helpers';
import { incidentServices } from './services';

const handle = useDb();
let c: TestCustomer;
let s: ReturnType<typeof incidentServices>;
let admin: Awaited<ReturnType<typeof seedUser>>;
let eng: Awaited<ReturnType<typeof seedUser>>;
let cara: Awaited<ReturnType<typeof seedUser>>;
let siteId: string;
const agent: Record<'triage' | 'diagnose' | 'comms', string> = { triage: '', diagnose: '', comms: '' };

const later = () => new Date(Date.now() + 5 * 60_000);
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
const row = (id: string) => c.s.selectFrom('incidents').selectAll().where('id', '=', id).executeTakeFirstOrThrow();
const events = (id: string) => c.s.selectFrom('incident_events').selectAll().where('incident_id', '=', id).orderBy('created_at').execute();
const proposals = (id: string) => c.s.selectFrom('incident_actions').selectAll().where('incident_id', '=', id).orderBy('created_at').execute();
const mine = (id: string, key: keyof typeof agent) => events(id).then((e) => e.filter((x) => x.author_id === agent[key] && (x.kind === 'comment' || x.kind === 'handoff')));
const setLevels = (key: keyof typeof agent, autonomy: AgentAutonomy, enabled = true) => s.agentAdmin.setPolicy(admin, agent[key], c.t.id, { enabled, autonomy });
const tick = () => s.builtin.tick({ tenantId: c.t.id, now: later() });

async function object(type: string, key: string, name: string | null, data: Record<string, unknown> = {}) {
  return c.s.insertInto('tenant_objects').values({ object_type: type, object_key: key, display_name: name, data: JSON.stringify(data) } as never).returning('id').executeTakeFirstOrThrow();
}
async function tenantUser(upn: string, over: Record<string, unknown> = {}) {
  const o = await object('user', upn, upn, {});
  await c.s
    .insertInto('tenant_users')
    .values({ object_id: o.id, upn, display_name: upn.split('@')[0], entra_id: `eid-${upn}`, account_type: 'User', account_enabled: true, enterprise_voice_enabled: true, usage_location: 'GB', feature_types: ['PhoneSystem'], assigned_plans: JSON.stringify([{ Capability: 'MCOEV', CapabilityStatus: 'Enabled' }]), policies: JSON.stringify({ OnlineVoiceRoutingPolicy: 'UK' }), ...over } as never)
    .execute();
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
  for (const key of ['triage', 'diagnose', 'comms'] as const) agent[key] = (await s.agentAdmin.createBuiltin(admin, { key })).id;

  const at = new Date(Date.now() - 86_400_000).toISOString();
  await c.s.insertInto('tenant_discovery_runs').values({ status: 'completed', started_by: admin.id, started_at: at, finished_at: at, scope_types: null } as never).execute();
  await tenantUser('anna@contoso.com');
  await tenantUser('cleo@contoso.com', { account_enabled: false });
  await object('resource_account', 'ra-sales', 'ra-sales@contoso.com', { PhoneNumber: 'tel:+441189000500' });
  await object('call_queue', 'cq-sales', 'Sales queue', { Agents: [{ ObjectId: 'eid-anna@contoso.com' }, { ObjectId: 'eid-cleo@contoso.com' }], ApplicationInstances: ['ra-sales'] });
});

beforeEach(async () => {
  // Every test starts with all three off for this customer, and nothing left open from the last one.
  for (const k of ['triage', 'diagnose', 'comms'] as const) await setLevels(k, {}, false);
  await platformDb(handle.db).updateTable('agents').set({ status: 'active' }).where('builtin_key', 'is not', null).execute();
  await platformDb(handle.db).updateTable('agent_kill_switch').set({ all_disabled: false }).execute();
  await platformDb(handle.db).updateTable('tenants').set({ agents_enabled: true }).where('id', '=', c.t.id).execute();
  await c.s.updateTable('incidents').set({ status: 'cancelled', hold_reason: null, cancelled_at: new Date().toISOString() } as never).where('status', 'in', ['new', 'in_progress', 'on_hold']).execute();
  await c.s.deleteFrom('incident_actions').execute();
});

describe('adding them', () => {
  it('adds each once, with no tokens, and refuses tokens and webhooks for them', async () => {
    const list = await s.agentAdmin.list();
    expect(list.filter((a) => a.builtin_key).map((a) => a.name).sort()).toEqual(['Voxshift Comms', 'Voxshift Diagnose', 'Voxshift Triage']);
    await expect(s.agentAdmin.createBuiltin(admin, { key: 'triage' })).rejects.toThrow(/already been added/);
    await expect(s.agentAdmin.createToken(admin, agent.triage, { name: 'x', scopes: ['read'], expiresInDays: 30, ipAllow: [] } as never)).rejects.toThrow(/runs inside Voxshift/);
    await expect(s.agentAdmin.createWebhook(admin, agent.triage, { url: 'https://example.com/h', kinds: [] } as never)).rejects.toThrow(/runs inside Voxshift/);
  });
});

describe('Triage', () => {
  it('suggest level: leaves a note and proposes acknowledging, but changes nothing and lets go', async () => {
    await setLevels('triage', { triage: 1, internal_note: 1 });
    const i = await raise();
    expect((await tick()).triage).toBe(1);
    const notes = await mine(i.id, 'triage');
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatchObject({ internal: true, actor_type: 'agent' });
    expect(notes[0]!.body).toContain(`Triage of INC-`);
    expect(notes[0]!.body).toContain('automated assistant');
    expect(await proposals(i.id)).toMatchObject([{ kind: 'status_change', state: 'proposed', params: { to: 'in_progress' } }]);
    expect(await row(i.id)).toMatchObject({ status: 'new', assigned_agent_id: null, acknowledged_at: null });
    expect(await s.claims.current(c.t, i.id)).toBeNull();
    // Once only.
    expect((await tick()).triage).toBe(0);
    expect(await mine(i.id, 'triage')).toHaveLength(1);
  });

  it('act alone: matches a known error, proposes linking it, and acknowledges', async () => {
    await setLevels('triage', { triage: 3, internal_note: 3 });
    const prb = await s.problems.create(c.t, eng, { title: 'Reading queue drops agents', description: '', category: 'queues_aa', subcategory: null, status: 'known_error', rootCause: 'Sync', workaround: 'Re-add the agents', customerNote: '', ownerId: null } as never);
    const i = await raise();
    await tick();
    const note = (await mine(i.id, 'triage'))[0]!;
    expect(note.body).toContain('Workaround: Re-add the agents');
    expect(await proposals(i.id)).toMatchObject([{ kind: 'link_problem', state: 'proposed', params: { problemId: prb.id } }]);
    const r = await row(i.id);
    expect(r.status).toBe('in_progress');
    expect(r.acknowledged_at).not.toBeNull();
    expect(r.assigned_agent_id).toBeNull();
    // A person can approve the link, and it is carried out.
    const [p] = await proposals(i.id);
    await s.proposals.decide(c.t, eng, i.id, p!.id, { decision: 'approve' });
    expect((await row(i.id)).problem_id).toBe(prb.id);
  });

  it('proposes a duplicate for a same-site, same-kind incident raised just before, never closes it itself', async () => {
    await setLevels('triage', { triage: 3, internal_note: 3 });
    const first = await raise();
    const second = await raise({ title: 'Sales queue still silent' });
    await tick();
    const dup = (await proposals(second.id)).find((p) => p.kind === 'status_change' && (p.params as { to?: string }).to === 'duplicate');
    expect(dup).toMatchObject({ state: 'proposed', params: { to: 'duplicate', duplicateOf: first.id }, risk: 'medium' });
    expect((await row(second.id)).status).not.toBe('duplicate');
  });

  it('leaves alone what it should: assigned, too fresh, major, taken over, or held by someone', async () => {
    await setLevels('triage', { triage: 3, internal_note: 3 });
    const assigned = await raise();
    await s.svc.assign(c.t, eng, assigned.id, { userId: eng.id });
    const major = await raise({ title: 'Everything is down' });
    await c.s.updateTable('incidents').set({ major: true, lead_id: eng.id, comms_id: eng.id, major_declared_at: new Date().toISOString() } as never).where('id', '=', major.id).execute();
    const taken = await raise({ title: 'Taken over' });
    await c.s.updateTable('incidents').set({ agent_hold: true } as never).where('id', '=', taken.id).execute();
    const held = await raise({ title: 'Held' });
    const other = await s.agentAdmin.create(admin, { name: `Other-${Date.now() % 100000}`, kind: 'general' } as never);
    await c.s.insertInto('incident_claims').values({ incident_id: held.id, agent_id: other.id, expires_at: new Date(Date.now() + 3_600_000).toISOString() } as never).execute();
    const fresh = await raise({ title: 'Just raised' });
    const stats = await s.builtin.tick({ tenantId: c.t.id, now: new Date() }); // not yet settled
    expect(stats.triage).toBe(0);
    await tick();
    for (const x of [assigned, major, taken, held]) expect(await mine(x.id, 'triage')).toHaveLength(0);
    expect(await mine(fresh.id, 'triage')).toHaveLength(1);
  });

  it('does nothing when it is off: customer policy, customer switch, paused, or the kill switch', async () => {
    await setLevels('triage', { triage: 3, internal_note: 3 }, false);
    const i = await raise();
    expect((await tick()).triage).toBe(0);
    await setLevels('triage', { triage: 3, internal_note: 3 });
    await platformDb(handle.db).updateTable('tenants').set({ agents_enabled: false }).where('id', '=', c.t.id).execute();
    expect((await tick()).triage).toBe(0);
    await platformDb(handle.db).updateTable('tenants').set({ agents_enabled: true }).where('id', '=', c.t.id).execute();
    await platformDb(handle.db).updateTable('agents').set({ status: 'paused' }).where('id', '=', agent.triage).execute();
    expect((await tick()).triage).toBe(0);
    await platformDb(handle.db).updateTable('agents').set({ status: 'active' }).where('id', '=', agent.triage).execute();
    await platformDb(handle.db).updateTable('agent_kill_switch').set({ all_disabled: true }).execute();
    expect((await tick()).triage).toBe(0);
    await platformDb(handle.db).updateTable('agent_kill_switch').set({ all_disabled: false }).execute();
    expect(await mine(i.id, 'triage')).toHaveLength(0);
    expect((await tick()).triage).toBe(1);
  });

  it('observe level does nothing', async () => {
    await setLevels('triage', { triage: 0, internal_note: 0 });
    const i = await raise();
    expect((await tick()).triage).toBe(0);
    expect(await mine(i.id, 'triage')).toHaveLength(0);
  });
});

describe('Diagnose', () => {
  it('act alone: runs the checks, finds the problem and hands over with a packet', async () => {
    await setLevels('diagnose', { triage: 3, internal_note: 3, diagnostic_read: 3 });
    const i = await raise();
    expect((await tick()).diagnose).toBe(1);
    const diags = await c.s.selectFrom('incident_diagnostics').selectAll().where('incident_id', '=', i.id).execute();
    expect(diags.map((d) => d.runbook).sort()).toEqual(['queue_check', 'recent_changes']);
    expect(diags.every((d) => d.actor_type === 'agent' && d.run_by === agent.diagnose)).toBe(true);
    const handoff = (await events(i.id)).find((e) => e.kind === 'handoff')!;
    expect(handoff.internal).toBe(true);
    expect(handoff.body).toContain('Recommendation:');
    expect(handoff.body).toContain('Sales queue');
    expect(await row(i.id)).toMatchObject({ assigned_agent_id: null });
    expect(await s.claims.current(c.t, i.id)).toBeNull();
    expect((await tick()).diagnose).toBe(0);
  });

  it('writes a plain note, without a handoff, when it finds nothing', async () => {
    await setLevels('diagnose', { triage: 3, internal_note: 3, diagnostic_read: 3 });
    const i = await raise({ category: 'devices', subcategory: 'client', title: 'Teams app slow', answers: { started: 'Today 09:00', device: 'Teams desktop app', affected_user: 'The whole team' }, description: 'The Teams app feels slow today.' } as never);
    await tick();
    const ev = await events(i.id);
    expect(ev.some((e) => e.kind === 'handoff')).toBe(false);
    const note = ev.find((e) => e.author_id === agent.diagnose && e.kind === 'comment')!;
    expect(note.body).toContain('Nothing wrong found');
    expect(note.body).toContain('not the live tenant');
  });

  it('act with approval: proposes the checks, runs them once a person approves, and marks them done', async () => {
    await setLevels('diagnose', { triage: 3, internal_note: 3, diagnostic_read: 2 });
    const i = await raise();
    await tick();
    const ps = await proposals(i.id);
    expect(ps).toMatchObject([{ kind: 'external', action_class: 'diagnostic_read', state: 'proposed' }]);
    expect((ps[0]!.params as { args: { runbook: string } }).args.runbook).toBe('queue_check');
    expect(await c.s.selectFrom('incident_diagnostics').selectAll().where('incident_id', '=', i.id).execute()).toHaveLength(0);
    await s.proposals.decide(c.t, eng, i.id, ps[0]!.id, { decision: 'approve' });
    await tick();
    const after = await c.s.selectFrom('incident_actions').select(['state', 'result']).where('id', '=', ps[0]!.id).executeTakeFirstOrThrow();
    expect(after.state).toBe('done');
    expect((await c.s.selectFrom('incident_diagnostics').selectAll().where('incident_id', '=', i.id).execute()).map((d) => d.runbook)).toEqual(['queue_check']);
  });

  it('suggest level: only says which checks are worth running', async () => {
    await setLevels('diagnose', { triage: 1, internal_note: 1, diagnostic_read: 1 });
    const i = await raise();
    await tick();
    expect(await proposals(i.id)).toHaveLength(0);
    expect((await mine(i.id, 'diagnose'))[0]!.body).toContain('Call queue or auto attendant (Sales queue)');
    expect(await c.s.selectFrom('incident_diagnostics').selectAll().where('incident_id', '=', i.id).execute()).toHaveLength(0);
  });
});

describe('Comms', () => {
  const age = (id: string, minutes: number) => c.s.updateTable('incidents').set({ created_at: new Date(Date.now() - minutes * 60_000).toISOString() } as never).where('id', '=', id).execute();

  it('proposes one plain update on an urgent incident with no update for a while, and waits to be approved', async () => {
    await setLevels('comms', { customer_update: 2 });
    const i = await raise({ impact: 'company', urgency: 'cannot_call' } as never);
    expect((await row(i.id)).priority).toBe('p1');
    await age(i.id, 90);
    expect((await tick()).comms).toBe(1);
    const [p] = await proposals(i.id);
    expect(p).toMatchObject({ kind: 'customer_update', state: 'proposed', risk: 'low' });
    const body = (p!.params as { body: string }).body;
    expect(body).toContain('Sales queue not ringing');
    expect(body).toContain('within 30 minutes');
    // Nothing reached the customer, and it does not pile up.
    expect((await events(i.id)).filter((e) => !e.internal && e.kind === 'comment')).toHaveLength(0);
    expect((await tick()).comms).toBe(0);
    expect(await proposals(i.id)).toHaveLength(1);
    // Approving sends it, as the assistant.
    await s.proposals.decide(c.t, eng, i.id, p!.id, { decision: 'approve' });
    const sent = (await events(i.id)).find((e) => !e.internal && e.kind === 'comment')!;
    expect(sent).toMatchObject({ actor_type: 'agent', author_id: agent.comms });
    expect(sent.body).toBe(body);
  });

  it('leaves alone what is not due: recent, not urgent, major, or on hold for the customer', async () => {
    await setLevels('comms', { customer_update: 2 });
    const fresh = await raise({ impact: 'company', urgency: 'cannot_call' } as never);
    await age(fresh.id, 10);
    const p3 = await raise({ title: 'Low priority', impact: 'individual', urgency: 'feature_broken' } as never);
    await age(p3.id, 5000);
    const major = await raise({ title: 'Major', impact: 'company', urgency: 'cannot_call' } as never);
    await age(major.id, 300);
    await c.s.updateTable('incidents').set({ major: true, lead_id: eng.id, comms_id: eng.id, major_declared_at: new Date().toISOString() } as never).where('id', '=', major.id).execute();
    const waiting = await raise({ title: 'Waiting on you', impact: 'company', urgency: 'cannot_call' } as never);
    await age(waiting.id, 300);
    await c.s.updateTable('incidents').set({ status: 'on_hold', hold_reason: 'customer' } as never).where('id', '=', waiting.id).execute();
    expect((await tick()).comms).toBe(0);
  });

  it('is off for a customer that does not allow customer updates at all', async () => {
    await setLevels('comms', { customer_update: 0 });
    const i = await raise({ impact: 'company', urgency: 'cannot_call' } as never);
    await age(i.id, 300);
    expect((await tick()).comms).toBe(0);
  });
});

describe('releasing an incident through the API', () => {
  it('an assistant that lets go is no longer the assignee', async () => {
    const p = { agentId: agent.triage, tokenId: 't', name: 'Voxshift Triage', kind: 'triage' as const, scopes: ['read', 'note', 'propose', 'act'] as ('read' | 'note' | 'propose' | 'act')[] };
    await setLevels('triage', { triage: 3, internal_note: 3 });
    const i = await raise();
    await s.agentApi.claim(p, c.t.id, i.id, { ttlSeconds: 600 });
    expect((await row(i.id)).assigned_agent_id).toBe(agent.triage);
    await s.agentApi.release(p, c.t.id, i.id);
    expect((await row(i.id)).assigned_agent_id).toBeNull();
    void agentProposalSchema;
  });
});

describe('asking an assistant', () => {
  const ask = (key: keyof typeof agent | string, incidentId: string, question: string) => s.builtin.ask(c.t, eng, incidentId, { agentId: agent[key as keyof typeof agent] ?? key, question });

  it('Diagnose runs what the question names, straight away, and says so on the timeline', async () => {
    await setLevels('diagnose', { triage: 3, internal_note: 3, diagnostic_read: 3 });
    const i = await raise({ category: 'devices', subcategory: 'client', title: 'Teams app slow', answers: { started: 'Today 09:00', device: 'Teams desktop app', affected_user: 'The whole team' }, description: 'The Teams app feels slow today.' } as never);
    const r = await ask('diagnose', i.id, 'Please check anna@contoso.com and cleo@contoso.com');
    expect(r.delivered).toBe('builtin');
    expect(r.message).toMatch(/^Diagnose ran \d checks/);
    const diags = await c.s.selectFrom('incident_diagnostics').select(['runbook', 'subject']).where('incident_id', '=', i.id).execute();
    expect(diags.filter((d) => d.runbook === 'user_voice').map((d) => d.subject).sort()).toEqual(['anna@contoso.com', 'cleo@contoso.com']);
    const asked = (await events(i.id)).find((e) => e.body?.startsWith('Asked Voxshift Diagnose (AI):'))!;
    expect(asked).toMatchObject({ internal: true, actor_type: 'user', author_id: eng.id });
    const feed = await platformDb(handle.db).selectFrom('agent_events').selectAll().where('incident_id', '=', i.id).where('kind', '=', 'incident.assist_requested').execute();
    expect(feed).toHaveLength(1);
    expect(feed[0]).toMatchObject({ agent_id: agent.diagnose, payload: { question: 'Please check anna@contoso.com and cleo@contoso.com', askedBy: 'Eve Engineer' } });
    // It let go afterwards.
    expect(await s.claims.current(c.t, i.id)).toBeNull();
    expect((await row(i.id)).assigned_agent_id).toBeNull();
  });

  it('Triage can be asked again for the same incident, and Comms drafts on request even below urgent', async () => {
    await setLevels('triage', { triage: 1, internal_note: 1 });
    await setLevels('comms', { customer_update: 2 });
    const i = await raise();
    expect((await ask('triage', i.id, 'Take another look')).message).toBe('Triage left its note on the timeline.');
    await ask('triage', i.id, 'And again');
    expect(await mine(i.id, 'triage')).toHaveLength(2);
    expect((await row(i.id)).priority).toMatch(/^p[34]$/);
    expect((await ask('comms', i.id, 'Draft an update')).message).toContain('Comms drafted an update');
    expect((await proposals(i.id)).some((p) => p.kind === 'customer_update' && p.state === 'proposed')).toBe(true);
  });

  it('tells the person plainly when the assistant is not allowed to help', async () => {
    await setLevels('diagnose', { diagnostic_read: 0, internal_note: 0 });
    const i = await raise();
    expect((await ask('diagnose', i.id, 'Check things')).message).toContain('set to observe only for diagnostics');
    await expect(ask('triage', i.id, 'Look')).rejects.toThrow(/not allowed on this customer/); // policy off in beforeEach
    await setLevels('triage', { triage: 3, internal_note: 3 });
    await platformDb(handle.db).updateTable('agents').set({ status: 'paused' }).where('id', '=', agent.triage).execute();
    await expect(ask('triage', i.id, 'Look')).rejects.toThrow(/is paused/);
    await platformDb(handle.db).updateTable('agents').set({ status: 'active' }).where('id', '=', agent.triage).execute();
    await c.s.updateTable('incidents').set({ agent_hold: true } as never).where('id', '=', i.id).execute();
    await expect(ask('triage', i.id, 'Look')).rejects.toThrow(/took this incident over/);
    await c.s.updateTable('incidents').set({ agent_hold: false, status: 'cancelled', hold_reason: null, cancelled_at: new Date().toISOString() } as never).where('id', '=', i.id).execute();
    await expect(ask('triage', i.id, 'Look')).rejects.toThrow(/finished/);
  });

  it('sends the request to an outside agent through its events feed', async () => {
    const other = await s.agentAdmin.create(admin, { name: `Outside-${Date.now() % 100000}`, kind: 'general' } as never);
    await s.agentAdmin.setPolicy(admin, other.id, c.t.id, { enabled: true, autonomy: { internal_note: 1 } });
    const p = { agentId: other.id, tokenId: 't', name: other.name, kind: 'general' as const, scopes: ['read'] as 'read'[] };
    const i = await raise();
    const r = await s.builtin.ask(c.t, eng, i.id, { agentId: other.id, question: 'Is this the carrier again?' });
    expect(r).toEqual({ delivered: 'event', message: `Sent to ${other.name} (AI). It will reply on the timeline.` });
    const feed = await s.agentApi.feed(p, { after: 0, limit: 500 });
    const got = feed.events.find((e: Record<string, unknown>) => e.kind === 'incident.assist_requested' && e.incident_id === i.id);
    expect(got).toMatchObject({ question: 'Is this the carrier again?', askedBy: 'Eve Engineer' });
    // Another assistant does not see it.
    const bystander = { ...p, agentId: agent.triage };
    await setLevels('triage', { triage: 1 });
    expect((await s.agentApi.feed(bystander, { after: 0, limit: 500 })).events.some((e: Record<string, unknown>) => e.kind === 'incident.assist_requested' && e.incident_id === i.id)).toBe(false);
  });
});
