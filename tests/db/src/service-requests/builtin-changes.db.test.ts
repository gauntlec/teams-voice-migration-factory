// Voxshift Changes: the built-in assistant that carries change and removal requests through to a deployment one person
// approves. It works through the same agent API as any assistant, so every guardrail applies to it too.
import { randomUUID } from 'node:crypto';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { platformDb } from '@tvmf/db';
import { createServiceRequestSchema, type AgentAutonomy } from '@tvmf/shared';
import { SrBuiltinChangesService } from '../../../../apps/api/src/modules/service-requests/sr-builtin-changes.service';
import { incidentServices } from '../incidents/services';
import { useGlobalAgentLock, seedCustomer, seedSite, seedUser, useDb, type TestCustomer } from '../helpers';
import { srServices } from './services';

const handle = useDb();
useGlobalAgentLock(handle);
let c: TestCustomer;
let s: ReturnType<typeof srServices>;
let inc: ReturnType<typeof incidentServices>;
let admin: Awaited<ReturnType<typeof seedUser>>;
let eng: Awaited<ReturnType<typeof seedUser>>;
let cara: Awaited<ReturnType<typeof seedUser>>;
let siteId: string;
let agentId: string;
let n = 0;

const FULL: AgentAutonomy = { triage: 3, internal_note: 3, change_design: 3, change_whatif: 3, change_deploy: 2 };
const later = () => new Date(Date.now() + 5 * 60_000);
const tick = () => inc.builtin.tick({ tenantId: c.t.id, now: later() });
const setLevels = (autonomy: AgentAutonomy, enabled = true) => s.agentAdmin.setPolicy(admin, agentId, c.t.id, { enabled, autonomy });

beforeAll(async () => {
  c = await seedCustomer(handle, { managedServices: true });
  admin = await seedUser(handle, 'SUPER_ADMIN', { displayName: 'Ada Admin' });
  eng = await seedUser(handle, 'ENGINEER', { displayName: 'Eve Engineer' });
  cara = await seedUser(handle, 'CUSTOMER', { displayName: 'Cara Customer' });
  await platformDb(handle.db).insertInto('tenant_memberships').values([eng, cara].map((u) => ({ tenant_id: c.t.id, user_id: u.id })) as never).execute();
  siteId = (await seedSite(c.s, { sitecode: 'RDG01' })).id;
  await c.s.updateTable('discovery_sites').set({ mode: 'operations' } as never).execute();
  s = srServices(handle);
  inc = incidentServices(handle);
  new SrBuiltinChangesService(handle.db, s.agentApi, inc.builtin).onModuleInit();
  agentId = (await s.agentAdmin.createBuiltin(admin, { key: 'changes' })).id;
});

beforeEach(async () => {
  await setLevels(FULL);
  await platformDb(handle.db).updateTable('agents').set({ status: 'active' }).where('id', '=', agentId).execute();
  await platformDb(handle.db).updateTable('tenants').set({ sr_settings: JSON.stringify({}), teams_read_only: false, agents_enabled: true }).where('id', '=', c.t.id).execute();
  // Anything left open from the last test is out of the way.
  await c.s.updateTable('service_requests').set({ status: 'cancelled', cancelled_at: new Date().toISOString() } as never).where('status', 'in', ['new', 'planned', 'built']).execute();
});

async function voicemailRequest(over: { type?: string; details?: Record<string, unknown> } = {}) {
  const upn = `jo${++n}-${randomUUID().slice(0, 4)}@contoso.test`;
  await s.build.createUser(c.t, eng, { site_id: siteId, upn } as never);
  const sr = await s.requests.create(c.t, cara, createServiceRequestSchema.parse({ type: over.type ?? 'change_user', title: `Voicemail off for ${upn}`, siteId, details: over.details ?? { user: { upn, name: 'Jo' }, changes: ['Voicemail'], voicemail: 'Turn off' } }));
  return { sr, upn };
}
const row = (id: string) => c.s.selectFrom('service_requests').selectAll().where('id', '=', id).executeTakeFirstOrThrow();
const actions = (id: string) => c.s.selectFrom('service_request_actions').selectAll().where('request_id', '=', id).orderBy('created_at').execute();
const events = (id: string) => c.s.selectFrom('service_request_events').selectAll().where('request_id', '=', id).orderBy('created_at').execute();
async function session() {
  const id = randomUUID();
  await c.s.insertInto('connections').values({ id, started_by: eng.id, status: 'active', method: 'device_code' } as never).execute();
  return id;
}

describe('Voxshift Changes', () => {
  it('prepares a request completely and proposes the deployment, then deploys it once a person approves', async () => {
    const { sr, upn } = await voicemailRequest();
    expect((await tick()).changes).toBe(1);
    expect(await row(sr.id)).toMatchObject({ status: 'built', assigned_agent_id: null });
    expect(await s.claims.current(c.t, sr.id)).toBeNull();
    const ev = await events(sr.id);
    expect(ev.filter((e) => e.actor_type === 'agent' && e.kind === 'status_changed').map((e) => e.to_status)).toEqual(['planned', 'built']);
    expect(ev.some((e) => e.kind === 'whatif' && e.actor_type === 'agent')).toBe(true);
    const note = ev.find((e) => e.kind === 'comment' && e.internal && e.actor_type === 'agent')!;
    expect(note.body).toContain('Prepared SR-');
    expect(note.body).toContain('turn voicemail off');
    expect(note.body).toContain('only if a person approves it');
    const [p] = await actions(sr.id);
    expect(p).toMatchObject({ kind: 'external', action_class: 'change_deploy', state: 'proposed' });
    expect((p!.params as { args: { commands: { commands: string[] }[] } }).args.commands[0]!.commands).toEqual([`Set-CsOnlineVoicemailUserSettings -Identity '${upn}' -VoicemailEnabled:$false`]);
    // Once only.
    expect((await tick()).changes).toBe(0);
    // Nothing deploys until a person approves, on their own session.
    expect(s.jobs.filter((j) => (j.data.scope as { serviceRequestId?: string }).serviceRequestId === sr.id)).toHaveLength(0);
    await s.proposals.decide(c.t, eng, sr.id, p!.id, { decision: 'approve', connectionId: await session() });
    expect((await tick()).changes).toBe(1);
    const job = s.jobs.find((j) => (j.data.scope as { serviceRequestId?: string }).serviceRequestId === sr.id)!;
    expect(job.data).toMatchObject({ mode: 'execute', operatorUserId: eng.id });
    expect(job.data.scope).toMatchObject({ agentId, proposalId: p!.id });
    expect((await actions(sr.id))[0]).toMatchObject({ state: 'running' });
    expect(await s.claims.current(c.t, sr.id)).toBeNull();
    // Approved and taken: it does not deploy twice.
    expect((await tick()).changes).toBe(0);
  });

  it('leaves requests alone that it should not touch', async () => {
    const hard = await s.requests.create(c.t, cara, createServiceRequestSchema.parse({ type: 'change_user', title: 'Forwarding', siteId, details: { user: { upn: 'sam@contoso.test', name: 'Sam' }, changes: ['Call forwarding'], forward_to: { kind: 'voicemail', label: 'Voicemail' } } }));
    const mine = await voicemailRequest();
    await s.requests.assign(c.t, eng, mine.sr.id, eng.id);
    const held = await voicemailRequest();
    await c.s.updateTable('service_requests').set({ agent_hold: true } as never).where('id', '=', held.sr.id).execute();
    const waiting = await voicemailRequest();
    await c.s.updateTable('service_requests').set({ waiting_since: new Date().toISOString() } as never).where('id', '=', waiting.sr.id).execute();
    const unapproved = await voicemailRequest();
    await c.s.updateTable('service_requests').set({ approval_status: 'pending' } as never).where('id', '=', unapproved.sr.id).execute();
    const fresh = await voicemailRequest();
    expect((await inc.builtin.tick({ tenantId: c.t.id, now: new Date() })).changes).toBe(0); // not yet settled
    await c.s.updateTable('service_requests').set({ created_at: new Date(Date.now() - 120_000).toISOString() } as never).where('id', '=', fresh.sr.id).execute();
    expect((await tick()).changes).toBe(1);
    for (const x of [hard, mine.sr, held.sr, waiting.sr, unapproved.sr]) expect((await row(x.id)).status).toBe(x === mine.sr ? 'new' : 'new');
    expect((await row(fresh.sr.id)).status).toBe('built');
    expect(await actions(hard.id)).toHaveLength(0);
  });

  it('hands over when the What-If has nothing to do, with the reason, and proposes nothing', async () => {
    const { sr, upn } = await voicemailRequest();
    const o = await c.s.insertInto('tenant_objects').values({ object_type: 'user', object_key: upn, display_name: upn, data: JSON.stringify({}) } as never).returning('id').executeTakeFirstOrThrow();
    await c.s.insertInto('tenant_users').values({ object_id: o.id, upn, display_name: upn, entra_id: `eid-${upn}`, account_enabled: true, enterprise_voice_enabled: true, voicemail_enabled: false } as never).execute();
    expect((await tick()).changes).toBe(0);
    const ho = (await events(sr.id)).find((e) => e.kind === 'handoff')!;
    expect(ho.body).toContain('Nothing would change');
    expect(ho.body).toContain('Applied the request to the design');
    expect(await actions(sr.id)).toHaveLength(0);
    expect(await row(sr.id)).toMatchObject({ assigned_agent_id: null, status: 'built' });
    expect((await tick()).changes).toBe(0);
  });

  it('does nothing below "act alone" for the preparation steps, and does not propose a deploy at level 0', async () => {
    const low = await voicemailRequest();
    await setLevels({ ...FULL, change_design: 2 });
    expect((await tick()).changes).toBe(0);
    expect((await row(low.sr.id)).status).toBe('new');
    await setLevels({ ...FULL, change_deploy: 0 });
    expect((await tick()).changes).toBe(1);
    expect(await actions(low.sr.id)).toHaveLength(0);
    const note = (await events(low.sr.id)).find((e) => e.kind === 'comment' && e.actor_type === 'agent')!;
    expect(note.body).toContain('does not allow proposing a deployment');
  });

  it('is off when paused, disabled for the customer, or the kill switch is on', async () => {
    const x = await voicemailRequest();
    await setLevels(FULL, false);
    expect((await tick()).changes).toBe(0);
    await setLevels(FULL);
    await platformDb(handle.db).updateTable('agents').set({ status: 'paused' }).where('id', '=', agentId).execute();
    expect((await tick()).changes).toBe(0);
    await platformDb(handle.db).updateTable('agents').set({ status: 'active' }).where('id', '=', agentId).execute();
    await platformDb(handle.db).updateTable('agent_kill_switch').set({ all_disabled: true }).execute();
    expect((await tick()).changes).toBe(0);
    await platformDb(handle.db).updateTable('agent_kill_switch').set({ all_disabled: false }).execute();
    expect((await row(x.sr.id)).status).toBe('new');
    expect((await tick()).changes).toBe(1);
  });

  it('refuses an approved deploy outside the change window, and hands over instead of waiting', async () => {
    const { sr } = await voicemailRequest();
    await tick();
    const [p] = await actions(sr.id);
    await s.proposals.decide(c.t, eng, sr.id, p!.id, { decision: 'approve', connectionId: await session() });
    await platformDb(handle.db).updateTable('tenants').set({ sr_settings: JSON.stringify({ changeWindow: { days: [], start: '00:00', end: '23:59', timeZone: 'Europe/London' } }) } as never).where('id', '=', c.t.id).execute();
    const jobs = s.jobs.length;
    expect((await tick()).changes).toBe(0);
    expect(s.jobs.length).toBe(jobs);
    const ev = await events(sr.id);
    expect(ev.some((e) => e.kind === 'comment' && /outside this customer's change window/.test(e.body ?? ''))).toBe(true);
    expect(ev.some((e) => e.kind === 'handoff')).toBe(true);
    expect((await actions(sr.id))[0]).toMatchObject({ state: 'failed' });
    expect(await row(sr.id)).toMatchObject({ assigned_agent_id: null, status: 'built' });
  });

  it('is an assistant for service requests only: not offered on incidents, and not asked from an incident', async () => {
    const forIncidents = await inc.svc.assignableAgents(c.t);
    expect(forIncidents.some((a) => a.id === agentId)).toBe(false);
    const forRequests = await s.requests.assignableAgents(c.t);
    expect(forRequests.some((a) => a.id === agentId)).toBe(true);
    await expect(inc.builtin.ask(c.t, eng, randomUUID(), { agentId, question: 'Look at this' })).rejects.toThrow(/works service requests/);
  });
});
