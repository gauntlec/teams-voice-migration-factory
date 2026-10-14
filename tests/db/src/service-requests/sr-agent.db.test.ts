// Assistants completing service requests (docs/SERVICE-REQUEST-AGENTS.md): they carry a change request from Planned to a
// queued deployment with ONE human approval, within the autonomy the customer gave, and every guardrail on a live change holds.
import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import { platformDb } from '@tvmf/db';
import { createAgentSchema, createServiceRequestSchema, type AgentAutonomy } from '@tvmf/shared';
import { seedCustomer, seedSite, seedUser, useDb, type TestCustomer } from '../helpers';
import { srServices } from './services';

const handle = useDb();
let c: TestCustomer;
let s: ReturnType<typeof srServices>;
let admin: Awaited<ReturnType<typeof seedUser>>;
let eng: Awaited<ReturnType<typeof seedUser>>;
let eng2: Awaited<ReturnType<typeof seedUser>>;
let cara: Awaited<ReturnType<typeof seedUser>>;
let siteId: string;
let n = 0;

const FULL: AgentAutonomy = { triage: 3, internal_note: 3, customer_update: 2, change_design: 3, change_whatif: 3, change_deploy: 2 };

beforeAll(async () => {
  c = await seedCustomer(handle, { managedServices: true });
  admin = await seedUser(handle, 'SUPER_ADMIN', { displayName: 'Ada Admin' });
  eng = await seedUser(handle, 'ENGINEER', { displayName: 'Eve Engineer' });
  eng2 = await seedUser(handle, 'ENGINEER', { displayName: 'Ed Engineer' });
  cara = await seedUser(handle, 'CUSTOMER', { displayName: 'Cara Customer' });
  await platformDb(handle.db).insertInto('tenant_memberships').values([eng, eng2, cara].map((u) => ({ tenant_id: c.t.id, user_id: u.id })) as never).execute();
  siteId = (await seedSite(c.s, { sitecode: 'RDG01' })).id;
  await c.s.updateTable('discovery_sites').set({ mode: 'operations' } as never).execute();
  s = srServices(handle);
});

/** An assistant allowed on the customer at the given autonomy, and its principal. */
async function bot(autonomy: AgentAutonomy = FULL) {
  const a = await s.agentAdmin.create(admin, createAgentSchema.parse({ name: `SRbot-${++n}-${Date.now() % 100000}`, kind: 'resolver' }));
  await s.agentAdmin.setPolicy(admin, a.id, c.t.id, { enabled: true, autonomy });
  return { id: a.id, name: a.name, p: { agentId: a.id, tokenId: 't', name: a.name, kind: 'resolver' as const, scopes: ['read', 'note', 'propose', 'act'] as ('read' | 'note' | 'propose' | 'act')[] } };
}

/** A person with a Design & Build row, and a request to turn their voicemail off. */
async function voicemailRequest(over: Record<string, unknown> = {}) {
  const upn = `jo${++n}-${randomUUID().slice(0, 4)}@contoso.test`;
  await s.build.createUser(c.t, eng, { site_id: siteId, upn } as never);
  const input = createServiceRequestSchema.parse({ type: 'change_user', title: `Voicemail off for ${upn}`, siteId, details: { user: { upn, name: 'Jo' }, changes: ['Voicemail'], voicemail: 'Turn off', ...over } });
  const sr = await s.requests.create(c.t, cara, input);
  return { sr, upn };
}
/** The request, planned and applied, with the assistant holding it: ready for a What-If and a deploy. */
async function applied(b: Awaited<ReturnType<typeof bot>>) {
  const r = await voicemailRequest();
  await s.agentApi.claim(b.p, c.t.id, r.sr.id, { ttlSeconds: 600 });
  await s.agentApi.status(b.p, c.t.id, r.sr.id, { to: 'planned' });
  await s.agentApi.apply(b.p, c.t.id, r.sr.id, {});
  await s.agentApi.status(b.p, c.t.id, r.sr.id, { to: 'built' });
  return r;
}
async function session(user = eng, status = 'active') {
  const id = randomUUID();
  await c.s.insertInto('connections').values({ id, started_by: user.id, status, method: 'device_code' } as never).execute();
  return id;
}
const row = (id: string) => c.s.selectFrom('service_requests').selectAll().where('id', '=', id).executeTakeFirstOrThrow();
const events = (id: string) => c.s.selectFrom('service_request_events').selectAll().where('request_id', '=', id).orderBy('created_at').execute();
const actions = (id: string) => c.s.selectFrom('service_request_actions').selectAll().where('request_id', '=', id).orderBy('created_at').execute();
const deployProposal = (b: Awaited<ReturnType<typeof bot>>, id: string) =>
  s.agentApi.propose(b.p, c.t.id, id, { kind: 'external', params: { actionClass: 'change_deploy', title: 'Deploy the voicemail change', args: { fingerprint: 'forged' } }, rationale: 'The What-If is clean', risk: 'low', expiresInMinutes: 60 });

describe('which requests an assistant can see and take', () => {
  it('lists open requests across its customers, says which it could carry through, and filters', async () => {
    const b = await bot();
    const ok = await voicemailRequest();
    const fwd = createServiceRequestSchema.parse({ type: 'change_user', title: 'Forwarding for Sam', siteId, details: { user: { upn: 'sam@contoso.test', name: 'Sam' }, changes: ['Call forwarding'], forward_to: { kind: 'voicemail', label: 'Voicemail' } } });
    const hard = await s.requests.create(c.t, cara, fwd);
    const all = await s.agentApi.list(b.p, { status: 'open', limit: 50 });
    const mine = all.filter((r) => [ok.sr.id, hard.id].includes(r.id));
    expect(mine.find((r) => r.id === ok.sr.id)).toMatchObject({ automatable: true, assigned: 'nobody', type: 'change_user', tenant_id: c.t.id });
    expect(mine.find((r) => r.id === hard.id)).toMatchObject({ automatable: false });
    const only = await s.agentApi.list(b.p, { status: 'open', automatable: true, limit: 50 });
    expect(only.some((r) => r.id === hard.id)).toBe(false);
    expect(only.some((r) => r.id === ok.sr.id)).toBe(true);
  });

  it('reads a request with its design, whether it can be automated, and its own autonomy', async () => {
    const b = await bot();
    const { sr } = await voicemailRequest();
    const got = await s.agentApi.get(b.p, c.t.id, sr.id);
    expect(got.request).toMatchObject({ id: sr.id, status: 'new' });
    expect(got.automation).toMatchObject({ eligible: true, applies: ['turn voicemail off'] });
    expect(got.autonomy).toMatchObject({ change_design: 3, change_deploy: 2 });
    expect(got.whatIf).toBeNull();
  });

  it('only works customers it is enabled for', async () => {
    const b = await bot();
    await s.agentAdmin.setPolicy(admin, b.id, c.t.id, { enabled: false, autonomy: FULL });
    await expect(s.agentApi.list(b.p, { status: 'open', limit: 5 })).resolves.toEqual([]);
    const { sr } = await voicemailRequest();
    await expect(s.agentApi.get(b.p, c.t.id, sr.id)).rejects.toThrow(/not allowed/);
  });
});

describe('carrying a change request through, at "act alone" for the design', () => {
  it('claims, plans, applies, signs off the design and runs a clean What-If; the customer sees none of it as an assistant', async () => {
    const b = await bot();
    const { sr, upn } = await voicemailRequest();
    await expect(s.agentApi.apply(b.p, c.t.id, sr.id, {})).rejects.toThrow(/lease|claim|holding/i);
    await s.agentApi.claim(b.p, c.t.id, sr.id, { ttlSeconds: 600, note: 'Taking this' });
    expect(await row(sr.id)).toMatchObject({ assigned_agent_id: b.id });
    await s.agentApi.status(b.p, c.t.id, sr.id, { to: 'planned' });
    expect((await row(sr.id)).status).toBe('planned');
    const applied = await s.agentApi.apply(b.p, c.t.id, sr.id, {});
    expect(applied.result.applied).toEqual(['voicemail off']);
    expect(applied.design.builtBlockers).toEqual([]);
    expect((await c.s.selectFrom('build_users').select('voicemail').where(({ eb }) => eb(eb.fn('lower', ['upn']), '=', upn)).executeTakeFirstOrThrow()).voicemail).toMatchObject({ enabled: false });
    await s.agentApi.status(b.p, c.t.id, sr.id, { to: 'built' });
    expect((await row(sr.id)).status).toBe('built');
    const w = await s.agentApi.whatIf(b.p, c.t.id, sr.id, {});
    expect(w.verdict).toMatchObject({ ok: true, calls: 1, rows: 1, warnings: [] });
    expect(w.commands[0]!.commands).toEqual([`Set-CsOnlineVoicemailUserSettings -Identity '${upn}' -VoicemailEnabled:$false`]);
    expect(w.fingerprint).toMatch(/^[0-9a-f]{64}$/);
    // On the timeline as the assistant; to the customer it is "Voxshift assistant", and internal entries stay internal.
    const staff = await s.requests.get(c.t, sr.id, true);
    expect(staff.events.filter((e) => e.actor_type === 'agent').every((e) => e.author_name === `${b.name} (AI)`)).toBe(true);
    expect(staff.events.some((e) => e.kind === 'whatif')).toBe(true);
    const customer = await s.requests.get(c.t, sr.id, false, cara.id);
    expect(customer.events.every((e) => !e.internal)).toBe(true);
    expect(customer.events.filter((e) => e.actor_type === 'agent').every((e) => e.author_name === 'Voxshift assistant')).toBe(true);
    expect(customer.request.assigned_agent_name).toBe('Voxshift assistant');
    expect(customer).not.toHaveProperty('agent');
  });

  it('will not carry through a request a person has to decide', async () => {
    const b = await bot();
    const fwd = await s.requests.create(c.t, cara, createServiceRequestSchema.parse({ type: 'change_user', title: 'Forwarding', siteId, details: { user: { upn: 'sam@contoso.test', name: 'Sam' }, changes: ['Call forwarding'], forward_to: { kind: 'voicemail', label: 'Voicemail' } } }));
    await s.agentApi.claim(b.p, c.t.id, fwd.id, { ttlSeconds: 600 });
    await expect(s.agentApi.status(b.p, c.t.id, fwd.id, { to: 'planned' })).rejects.toMatchObject({ response: { code: 'not_automatable' } });
    await expect(s.agentApi.apply(b.p, c.t.id, fwd.id, {})).rejects.toMatchObject({ response: { code: 'not_automatable' } });
    // It can still annotate and hand over.
    await s.agentApi.note(b.p, c.t.id, fwd.id, { body: 'Forwarding needs a person to set it up.' });
    await s.agentApi.handoff(b.p, c.t.id, fwd.id, { to: 'queue', summary: { tried: ['Read it'], found: ['Needs a decision'], recommendation: 'An engineer should set up forwarding.', confidence: 'high', evidence: [] } });
    expect(await row(fwd.id)).toMatchObject({ assigned_agent_id: null });
    expect((await events(fwd.id)).some((e) => e.kind === 'handoff')).toBe(true);
    expect(await s.claims.current(c.t, fwd.id)).toBeNull();
  });

  it('suggest level: has to propose the design step, and may take it once approved at "act with approval"', async () => {
    const b = await bot({ ...FULL, change_design: 2, triage: 3 });
    const { sr } = await voicemailRequest();
    await s.agentApi.claim(b.p, c.t.id, sr.id, { ttlSeconds: 600 });
    await s.agentApi.status(b.p, c.t.id, sr.id, { to: 'planned' });
    await expect(s.agentApi.apply(b.p, c.t.id, sr.id, {})).rejects.toMatchObject({ response: { code: 'propose_instead' } });
    const p = await s.agentApi.propose(b.p, c.t.id, sr.id, { kind: 'external', params: { actionClass: 'change_design', title: 'Apply the request' }, rationale: 'Maps cleanly', risk: 'low', expiresInMinutes: 60 });
    await expect(s.agentApi.apply(b.p, c.t.id, sr.id, { proposalId: p.id })).rejects.toThrow(/not approved/);
    await s.proposals.decide(c.t, eng, sr.id, p.id, { decision: 'approve' });
    const r = await s.agentApi.apply(b.p, c.t.id, sr.id, { proposalId: p.id });
    expect(r.result.applied).toEqual(['voicemail off']);
    expect((await actions(sr.id))[0]).toMatchObject({ state: 'done' });
    // Moving to "built" is direct only, so below "act alone" it is a proposal too.
    await expect(s.agentApi.status(b.p, c.t.id, sr.id, { to: 'built' })).rejects.toMatchObject({ response: { code: 'propose_instead' } });
  });
});

describe('deploying: one approval, on the approver\'s own session, command for command', () => {
  it('runs exactly what a person approved, as the approver, and queues it tagged with the assistant', async () => {
    const b = await bot();
    const { sr } = await applied(b);
    const p = await deployProposal(b, sr.id);
    // The plan on the proposal is what the server computed, not what the assistant sent.
    const stored = (await actions(sr.id)).find((a) => a.id === p.id)!;
    expect((stored.params as { args: { fingerprint: string } }).args.fingerprint).toBe(p.fingerprint);
    expect(p.fingerprint).not.toBe('forged');
    await expect(s.agentApi.deploy(b.p, c.t.id, sr.id, { proposalId: p.id })).rejects.toThrow(/not approved/);
    await expect(s.proposals.decide(c.t, eng, sr.id, p.id, { decision: 'approve' })).rejects.toThrow(/tenant session/);
    await expect(s.proposals.decide(c.t, eng, sr.id, p.id, { decision: 'approve', connectionId: await session(eng2) })).rejects.toThrow(/another engineer/);
    await expect(s.proposals.decide(c.t, eng, sr.id, p.id, { decision: 'approve', connectionId: await session(eng, 'closed') })).rejects.toThrow(/not active/);
    const conn = await session(eng);
    await s.proposals.decide(c.t, eng, sr.id, p.id, { decision: 'approve', connectionId: conn, note: 'Fine by me' });
    const before = s.jobs.length;
    const r = await s.agentApi.deploy(b.p, c.t.id, sr.id, { proposalId: p.id });
    expect(r.status).toBe('queued');
    expect(s.jobs.length).toBe(before + 1);
    const job = s.jobs[s.jobs.length - 1]!;
    expect(job).toMatchObject({ name: 'deployment.run', data: { mode: 'execute', connectionId: conn, operatorUserId: eng.id, deploymentId: r.deploymentId } });
    expect(job.data.scope).toMatchObject({ serviceRequestId: sr.id, agentId: b.id, proposalId: p.id });
    expect((await c.s.selectFrom('deployments').selectAll().where('id', '=', r.deploymentId).executeTakeFirstOrThrow())).toMatchObject({ mode: 'execute', status: 'queued', created_by: eng.id });
    expect(await actions(sr.id).then((a) => a.find((x) => x.id === p.id))).toMatchObject({ state: 'running', connection_id: conn, decided_by: eng.id });
    // It cannot be taken twice.
    await expect(s.agentApi.deploy(b.p, c.t.id, sr.id, { proposalId: p.id })).rejects.toThrow(/already started/);
    const ev = await events(sr.id);
    expect(ev.some((e) => e.kind === 'deployment' && /started the deployment Eve Engineer approved/.test(e.body ?? ''))).toBe(true);
  });

  it('never deploys without an approval, or below "act with approval"', async () => {
    const b = await bot();
    const { sr } = await applied(b);
    await expect(s.agentApi.deploy(b.p, c.t.id, sr.id, {})).rejects.toMatchObject({ response: { code: 'propose_instead' } });
    const low = await bot({ ...FULL, change_deploy: 1 });
    await expect(s.agentApi.deploy(low.p, c.t.id, sr.id, { proposalId: randomUUID() })).rejects.toMatchObject({ response: { code: 'propose_instead' } });
    // A deploy is capped at "act with approval": the policy cannot even be set higher.
    await expect(bot({ ...FULL, change_deploy: 3 })).rejects.toThrow(/can't go above level 2/);
  });

  it('refuses a proposal when the request is not ready, or when there is nothing left to change', async () => {
    const b = await bot();
    const { sr, upn } = await voicemailRequest();
    await s.agentApi.claim(b.p, c.t.id, sr.id, { ttlSeconds: 600 });
    await expect(deployProposal(b, sr.id)).rejects.toThrow(/Designed & built/);
    await s.agentApi.status(b.p, c.t.id, sr.id, { to: 'planned' });
    await s.agentApi.apply(b.p, c.t.id, sr.id, {});
    await s.agentApi.status(b.p, c.t.id, sr.id, { to: 'built' });
    // The tenant already has voicemail off for this person: the What-If has nothing to do, so there is nothing to approve.
    const o = await c.s.insertInto('tenant_objects').values({ object_type: 'user', object_key: upn, display_name: upn, data: JSON.stringify({}) } as never).returning('id').executeTakeFirstOrThrow();
    await c.s.insertInto('tenant_users').values({ object_id: o.id, upn, display_name: upn, entra_id: `eid-${upn}`, account_enabled: true, enterprise_voice_enabled: true, voicemail_enabled: false } as never).execute();
    const w = await s.agentApi.whatIf(b.p, c.t.id, sr.id, {});
    expect(w.verdict.ok).toBe(false);
    expect(w.summary).toContain('What-If is not clean');
    await expect(deployProposal(b, sr.id)).rejects.toThrow(/What-If is not clean|Nothing would change/);
  });

  it('refuses at deploy time if the plan changed after the approval, and marks the proposal failed', async () => {
    const b = await bot();
    const { sr, upn } = await applied(b);
    const p = await deployProposal(b, sr.id);
    await s.proposals.decide(c.t, eng, sr.id, p.id, { decision: 'approve', connectionId: await session(eng) });
    // Someone edits the design after the approval (the request is "built", but a person can still change the row directly).
    await c.s.updateTable('build_users').set({ voicemail: JSON.stringify({ enabled: true }) } as never).where(({ eb }) => eb(eb.fn('lower', ['upn']), '=', upn)).execute();
    const jobs = s.jobs.length;
    await expect(s.agentApi.deploy(b.p, c.t.id, sr.id, { proposalId: p.id })).rejects.toMatchObject({ response: { code: 'plan_changed' } });
    expect(s.jobs.length).toBe(jobs);
    expect((await actions(sr.id)).find((a) => a.id === p.id)).toMatchObject({ state: 'failed' });
  });

  it('refuses to approve a plan that changed since it was proposed', async () => {
    const b = await bot();
    const { sr, upn } = await applied(b);
    const p = await deployProposal(b, sr.id);
    await c.s.updateTable('build_users').set({ voicemail: JSON.stringify({ enabled: true }) } as never).where(({ eb }) => eb(eb.fn('lower', ['upn']), '=', upn)).execute();
    await expect(s.proposals.decide(c.t, eng, sr.id, p.id, { decision: 'approve', connectionId: await session(eng) })).rejects.toThrow(/plan changed/);
    expect((await actions(sr.id)).find((a) => a.id === p.id)).toMatchObject({ state: 'failed' });
  });

  it('never deploys outside the customer\'s change window, and never past a read-only tenant or pending approval', async () => {
    const b = await bot();
    const { sr } = await applied(b);
    const p = await deployProposal(b, sr.id);
    await s.proposals.decide(c.t, eng, sr.id, p.id, { decision: 'approve', connectionId: await session(eng) });
    const never = { days: [] as number[], start: '00:00', end: '23:59', timeZone: 'Europe/London' };
    await platformDb(handle.db).updateTable('tenants').set({ sr_settings: JSON.stringify({ changeWindow: never }) } as never).where('id', '=', c.t.id).execute();
    const jobs = s.jobs.length;
    await expect(s.agentApi.deploy(b.p, c.t.id, sr.id, { proposalId: p.id })).rejects.toMatchObject({ response: { code: 'outside_window' } });
    await platformDb(handle.db).updateTable('tenants').set({ sr_settings: JSON.stringify({}) } as never).where('id', '=', c.t.id).execute();
    expect(s.jobs.length).toBe(jobs);

    const b2 = await bot();
    const second = await applied(b2);
    const p2 = await deployProposal(b2, second.sr.id);
    await s.proposals.decide(c.t, eng, second.sr.id, p2.id, { decision: 'approve', connectionId: await session(eng) });
    await c.s.updateTable('service_requests').set({ approval_status: 'pending' } as never).where('id', '=', second.sr.id).execute();
    await expect(s.agentApi.deploy(b2.p, c.t.id, second.sr.id, { proposalId: p2.id })).rejects.toMatchObject({ response: { code: 'not_approved' } });

    // A read-only tenant is refused by the normal deployment path, and the proposal is failed.
    const b3 = await bot();
    const third = await applied(b3);
    const p3 = await deployProposal(b3, third.sr.id);
    await s.proposals.decide(c.t, eng, third.sr.id, p3.id, { decision: 'approve', connectionId: await session(eng) });
    await platformDb(handle.db).updateTable('tenants').set({ teams_read_only: true }).where('id', '=', c.t.id).execute();
    await expect(s.agentApi.deploy(b3.p, { ...c.t, teamsReadOnly: true }.id, third.sr.id, { proposalId: p3.id })).rejects.toThrow(/read-only/);
    await platformDb(handle.db).updateTable('tenants').set({ teams_read_only: false }).where('id', '=', c.t.id).execute();
    expect((await actions(third.sr.id)).find((a) => a.id === p3.id)).toMatchObject({ state: 'failed' });
  });

  it('a rejected proposal stops there; an expired one cannot be approved', async () => {
    const b = await bot();
    const { sr } = await applied(b);
    const p = await deployProposal(b, sr.id);
    await s.proposals.decide(c.t, eng, sr.id, p.id, { decision: 'reject', note: 'Not today' });
    await expect(s.agentApi.deploy(b.p, c.t.id, sr.id, { proposalId: p.id })).rejects.toThrow(/already rejected/);
    const q = await deployProposal(b, sr.id);
    await c.s.updateTable('service_request_actions').set({ expires_at: new Date(Date.now() - 1000).toISOString() } as never).where('id', '=', q.id).execute();
    await expect(s.proposals.decide(c.t, eng, sr.id, q.id, { decision: 'approve', connectionId: await session(eng) })).rejects.toThrow(/expired/);
  });

  it('needs an approver who may deploy, and a person who took the request over locks the assistant out', async () => {
    const b = await bot();
    const { sr } = await applied(b);
    const p = await deployProposal(b, sr.id);
    const customer = await seedUser(handle, 'CUSTOMER');
    await expect(s.proposals.decide(c.t, customer, sr.id, p.id, { decision: 'approve', connectionId: await session(eng) })).rejects.toThrow(/permission to deploy/);
    await s.proposals.decide(c.t, eng, sr.id, p.id, { decision: 'approve', connectionId: await session(eng) });
    await s.humanAgents.takeOver(c.t, eng, sr.id);
    await expect(s.agentApi.deploy(b.p, c.t.id, sr.id, { proposalId: p.id })).rejects.toMatchObject({ response: { code: 'taken_over' } });
    await expect(s.agentApi.note(b.p, c.t.id, sr.id, { body: 'x' })).rejects.toMatchObject({ response: { code: 'taken_over' } });
    expect(await row(sr.id)).toMatchObject({ agent_hold: true, assigned_agent_id: null, assigned_to: eng.id });
    // The person hands it back and the assistant can work again.
    await s.humanAgents.handBack(c.t, eng, sr.id, b.id);
    expect(await row(sr.id)).toMatchObject({ agent_hold: false, assigned_agent_id: b.id, assigned_to: null });
  });
});

describe('proposals that the platform carries out, and assignment', () => {
  it('a reply to the customer is only sent after approval, as the assistant', async () => {
    const b = await bot();
    const { sr } = await voicemailRequest();
    const p = await s.agentApi.propose(b.p, c.t.id, sr.id, { kind: 'comment', params: { body: 'We have your request and will apply it shortly.' }, rationale: 'Acknowledge', risk: 'low', expiresInMinutes: 60 });
    expect((await events(sr.id)).some((e) => e.kind === 'comment' && !e.internal)).toBe(false);
    await s.proposals.decide(c.t, eng, sr.id, p.id, { decision: 'approve' });
    const sent = (await events(sr.id)).find((e) => e.kind === 'comment' && !e.internal)!;
    expect(sent).toMatchObject({ actor_type: 'agent', author_id: b.id, body: 'We have your request and will apply it shortly.' });
  });

  it('an assistant cannot decline, cancel or send back: those are not proposals', async () => {
    const b = await bot();
    const { sr } = await voicemailRequest();
    await expect(s.agentApi.propose(b.p, c.t.id, sr.id, { kind: 'decline', params: {}, rationale: 'no' } as never)).rejects.toThrow();
    await s.agentApi.claim(b.p, c.t.id, sr.id, { ttlSeconds: 600 });
    await expect(s.agentApi.status(b.p, c.t.id, sr.id, { to: 'declined' } as never)).rejects.toThrow();
  });

  it('can be assigned to an assistant, and a person taking it over ends the lease', async () => {
    const b = await bot();
    const { sr } = await voicemailRequest();
    await s.requests.assign(c.t, eng, sr.id, null, b.id);
    expect(await row(sr.id)).toMatchObject({ assigned_agent_id: b.id, assigned_to: null });
    await s.agentApi.claim(b.p, c.t.id, sr.id, { ttlSeconds: 600 });
    await s.requests.assign(c.t, eng, sr.id, eng.id);
    expect(await row(sr.id)).toMatchObject({ assigned_agent_id: null, assigned_to: eng.id });
    expect(await s.claims.current(c.t, sr.id)).toBeNull();
    await expect(s.requests.assign(c.t, eng, sr.id, null, randomUUID())).rejects.toThrow(/not available/);
    const list = await s.requests.list(c.t, { status: 'all' } as never, true);
    expect(list.find((r) => r.id === sr.id)).toMatchObject({ assigned_to: eng.id });
  });

  it('releasing lets go of the claim and clears the assignee', async () => {
    const b = await bot();
    const { sr } = await voicemailRequest();
    await s.agentApi.claim(b.p, c.t.id, sr.id, { ttlSeconds: 600 });
    expect(await s.agentApi.release(b.p, c.t.id, sr.id)).toEqual({ released: true });
    expect(await row(sr.id)).toMatchObject({ assigned_agent_id: null });
  });

  it('only one assistant holds a request at a time', async () => {
    const a1 = await bot();
    const a2 = await bot();
    const { sr } = await voicemailRequest();
    await s.agentApi.claim(a1.p, c.t.id, sr.id, { ttlSeconds: 600 });
    await expect(s.agentApi.claim(a2.p, c.t.id, sr.id, { ttlSeconds: 600 })).rejects.toThrow(/Another assistant|working this request/);
  });
});
