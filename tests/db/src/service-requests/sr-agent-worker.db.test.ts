// The worker's side of assistants on service requests: a deployment an assistant started is only "done" once the live
// re-check matches the design; anything else leaves the request Designed & built and tells the team. Plus the housekeeping:
// proposals that expire and leases that lapse.
import { randomUUID } from 'node:crypto';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { platformDb } from '@tvmf/db';
import { createAgentSchema, createServiceRequestSchema, type AgentAutonomy, type DeploymentVerification } from '@tvmf/shared';
import type { EnqueueMailInput } from '../../../../apps/api/src/mail/mail.service';
import { sweepAgents } from '../../../../apps/worker/src/agents';
import { finishAgentDeployment, recordServiceRequestRun } from '../../../../apps/worker/src/service-requests';
import { seedCustomer, seedSite, seedUser, useDb, type TestCustomer } from '../helpers';
import { srServices } from './services';

const handle = useDb();
let c: TestCustomer;
let s: ReturnType<typeof srServices>;
let admin: Awaited<ReturnType<typeof seedUser>>;
let eng: Awaited<ReturnType<typeof seedUser>>;
let cara: Awaited<ReturnType<typeof seedUser>>;
let siteId: string;
let sent: EnqueueMailInput[] = [];
let n = 0;

const FULL: AgentAutonomy = { triage: 3, internal_note: 3, change_design: 3, change_whatif: 3, change_deploy: 2 };
const enqueue = (async (m: EnqueueMailInput) => (sent.push(m), { id: 'm' })) as never;
const clean: DeploymentVerification = { status: 'verified', checkedAt: new Date().toISOString(), discoveryRunId: randomUUID(), checked: 1, matched: 1, differing: [], notChecked: 0, unverifiableSettings: 0 };

beforeAll(async () => {
  c = await seedCustomer(handle, { managedServices: true });
  admin = await seedUser(handle, 'SUPER_ADMIN', { displayName: 'Ada Admin' });
  eng = await seedUser(handle, 'ENGINEER', { displayName: 'Eve Engineer' });
  cara = await seedUser(handle, 'CUSTOMER', { displayName: 'Cara Customer' });
  await platformDb(handle.db).insertInto('tenant_memberships').values([eng, cara].map((u) => ({ tenant_id: c.t.id, user_id: u.id })) as never).execute();
  siteId = (await seedSite(c.s, { sitecode: 'RDG01' })).id;
  await c.s.updateTable('discovery_sites').set({ mode: 'operations' } as never).execute();
  s = srServices(handle);
});
beforeEach(() => {
  sent = [];
});

async function bot() {
  const a = await s.agentAdmin.create(admin, createAgentSchema.parse({ name: `Wbot-${++n}-${Date.now() % 100000}`, kind: 'resolver' }));
  await s.agentAdmin.setPolicy(admin, a.id, c.t.id, { enabled: true, autonomy: FULL });
  return { id: a.id, name: a.name, p: { agentId: a.id, tokenId: 't', name: a.name, kind: 'resolver' as const, scopes: ['read', 'note', 'propose', 'act'] as ('read' | 'note' | 'propose' | 'act')[] } };
}

/** A request an assistant has carried to a started deployment, as a person approved it. */
async function deploying() {
  const b = await bot();
  const upn = `jo${++n}-${randomUUID().slice(0, 4)}@contoso.test`;
  await s.build.createUser(c.t, eng, { site_id: siteId, upn } as never);
  const sr = await s.requests.create(c.t, cara, createServiceRequestSchema.parse({ type: 'change_user', title: `Voicemail off ${upn}`, siteId, details: { user: { upn, name: 'Jo' }, changes: ['Voicemail'], voicemail: 'Turn off' } }));
  await s.agentApi.claim(b.p, c.t.id, sr.id, { ttlSeconds: 600 });
  for (const to of ['planned', 'built'] as const) {
    if (to === 'built') await s.agentApi.apply(b.p, c.t.id, sr.id, {});
    await s.agentApi.status(b.p, c.t.id, sr.id, { to });
  }
  const p = await s.agentApi.propose(b.p, c.t.id, sr.id, { kind: 'external', params: { actionClass: 'change_deploy', title: 'Deploy' }, rationale: 'Clean What-If', risk: 'low', expiresInMinutes: 60 });
  const conn = randomUUID();
  await c.s.insertInto('connections').values({ id: conn, started_by: eng.id, status: 'active', method: 'device_code' } as never).execute();
  await s.proposals.decide(c.t, eng, sr.id, p.id, { decision: 'approve', connectionId: conn });
  const d = await s.agentApi.deploy(b.p, c.t.id, sr.id, { proposalId: p.id });
  return { b, sr, p, deploymentId: d.deploymentId };
}
const run = (x: Awaited<ReturnType<typeof deploying>>, counts = { applied: 1, skipped: 0, failed: 0, whatif: 0 }, errorMessage?: string) =>
  recordServiceRequestRun(handle.db, enqueue, { tenantId: c.t.id, schema: c.t.schema, serviceRequestId: x.sr.id, deploymentId: x.deploymentId, operatorUserId: eng.id, mode: 'execute', counts, errorMessage, agent: { agentId: x.b.id, proposalId: x.p.id } });
const finish = (x: Awaited<ReturnType<typeof deploying>>, verification: DeploymentVerification | null) =>
  finishAgentDeployment(handle.db, enqueue, { tenantId: c.t.id, schema: c.t.schema, serviceRequestId: x.sr.id, deploymentId: x.deploymentId, agentId: x.b.id, proposalId: x.p.id, operatorUserId: eng.id, verification });
const row = (id: string) => c.s.selectFrom('service_requests').selectAll().where('id', '=', id).executeTakeFirstOrThrow();
const action = (id: string) => c.s.selectFrom('service_request_actions').selectAll().where('id', '=', id).executeTakeFirstOrThrow();
const events = (id: string) => c.s.selectFrom('service_request_events').selectAll().where('request_id', '=', id).orderBy('created_at').execute();

describe('an assistant\'s deployment finishing', () => {
  it('a clean run is not Deployed yet; a clean live re-check then moves it, tells the customer, and credits both', async () => {
    const x = await deploying();
    await run(x);
    expect(await action(x.p.id)).toMatchObject({ state: 'done' });
    expect((await row(x.sr.id)).status).toBe('built');
    expect(sent).toHaveLength(0);
    expect(await finish(x, clean)).toBe('deployed');
    const r = await row(x.sr.id);
    expect(r).toMatchObject({ status: 'deployed', assigned_agent_id: null });
    expect(r.deployed_at).not.toBeNull();
    const moved = (await events(x.sr.id)).find((e) => e.kind === 'status_changed' && e.to_status === 'deployed')!;
    expect(moved).toMatchObject({ actor_type: 'agent', author_id: x.b.id });
    expect(moved.body).toContain('as approved by Eve Engineer');
    expect(moved.body).toContain('matches the design');
    expect(sent.map((m) => m.template)).toEqual(['service_request_status_changed']);
    expect(sent[0]!.to.email).toBe(cara.email);
    expect(sent[0]!.createdBy).toBeNull(); // never from an assistant
    expect(await s.claims.current(c.t, x.sr.id)).toBeNull();
  });

  it('differences found by the re-check leave it Designed & built and tell the team', async () => {
    const x = await deploying();
    await run(x);
    const differing = { ...clean, matched: 0, differing: [{ objectType: 'user' as const, objectId: 'r', upn: 'jo@contoso.test', differences: ['Voicemail is still on'] }] };
    expect(await finish(x, differing)).toBe('needs_check');
    expect((await row(x.sr.id)).status).toBe('built');
    const note = (await events(x.sr.id)).filter((e) => e.kind === 'deployment').pop()!;
    expect(note.body).toContain('needs a person to check it');
    expect(note.body).toContain('Voicemail is still on');
    expect(sent.every((m) => m.template === 'service_request_activity' && (m.context as { kind: string }).kind === 'agent_deploy_check')).toBe(true);
    expect(sent.length).toBeGreaterThan(0);
    expect(await row(x.sr.id)).toMatchObject({ assigned_agent_id: null });
    expect(await s.claims.current(c.t, x.sr.id)).toBeNull();
  });

  it('a re-check that did not run, was skipped, or checked nothing is not "done" either', async () => {
    for (const v of [null, { status: 'skipped', checkedAt: new Date().toISOString(), reason: 'busy' } as DeploymentVerification, { ...clean, checked: 0, matched: 0 }]) {
      const x = await deploying();
      await run(x);
      sent = [];
      expect(await finish(x, v)).toBe('needs_check');
      expect((await row(x.sr.id)).status).toBe('built');
      expect(sent.length).toBeGreaterThan(0);
    }
  });

  it('a run with failed changes fails the proposal, tells the team, and is never marked Deployed', async () => {
    const x = await deploying();
    await run(x, { applied: 0, skipped: 0, failed: 1, whatif: 0 });
    expect(await action(x.p.id)).toMatchObject({ state: 'failed' });
    expect((await action(x.p.id)).error).toContain('failed change');
    expect(await finish(x, clean)).toBe('skipped');
    expect((await row(x.sr.id)).status).toBe('built');
    expect(sent.length).toBeGreaterThan(0);
  });

  it('a run that never finished fails the proposal', async () => {
    const x = await deploying();
    await run(x, { applied: 0, skipped: 0, failed: 0, whatif: 0 }, 'The tenant connection is no longer available');
    expect(await action(x.p.id)).toMatchObject({ state: 'failed' });
    expect((await row(x.sr.id)).status).toBe('built');
  });

  it('tells the incident a request was raised for when its deployment needs checking', async () => {
    const x = await deploying();
    const incident = await c.s
      .insertInto('incidents')
      .values({ title: 'Voicemail', description: 'Voicemail keeps going to the wrong greeting', category: 'users', subcategory: 'voicemail', impact: 'individual', urgency: 'degraded', priority: 'p3', reporter_id: cara.id, details: JSON.stringify({ answers: {}, example_calls: [] }) } as never)
      .returning('id')
      .executeTakeFirstOrThrow();
    await c.s.updateTable('service_requests').set({ incident_id: incident.id } as never).where('id', '=', x.sr.id).execute();
    await run(x);
    await finish(x, null);
    const ev = await c.s.selectFrom('incident_events').selectAll().where('incident_id', '=', incident.id).execute();
    expect(ev[0]).toMatchObject({ internal: true, actor_type: 'agent' });
    expect(ev[0]!.body).toContain('needs a person to check');
  });
});

describe('housekeeping', () => {
  it('expires proposals nobody decided, and puts a request back in the queue when a lease runs out', async () => {
    const b = await bot();
    const upn = `kay${++n}-${randomUUID().slice(0, 4)}@contoso.test`;
    await s.build.createUser(c.t, eng, { site_id: siteId, upn } as never);
    const sr = await s.requests.create(c.t, cara, createServiceRequestSchema.parse({ type: 'change_user', title: `Voicemail ${upn}`, siteId, details: { user: { upn, name: 'Kay' }, changes: ['Voicemail'], voicemail: 'Turn on' } }));
    await s.agentApi.claim(b.p, c.t.id, sr.id, { ttlSeconds: 600 });
    const p = await s.agentApi.propose(b.p, c.t.id, sr.id, { kind: 'comment', params: { body: 'Hello' }, rationale: 'Say hi', risk: 'low', expiresInMinutes: 60 });
    await c.s.updateTable('service_request_actions').set({ expires_at: new Date(Date.now() - 1000).toISOString() } as never).where('id', '=', p.id).execute();
    await c.s.updateTable('service_request_claims').set({ expires_at: new Date(Date.now() - 1000).toISOString() } as never).where('request_id', '=', sr.id).execute();
    const r = await sweepAgents(handle.db, enqueue, { tenantId: c.t.id });
    expect(r.expired).toBeGreaterThanOrEqual(1);
    expect(r.lapsed).toBeGreaterThanOrEqual(1);
    expect(await action(p.id)).toMatchObject({ state: 'expired' });
    expect(await row(sr.id)).toMatchObject({ assigned_agent_id: null });
    expect((await events(sr.id)).some((e) => e.kind === 'claim_released' && /lease ran out/.test(e.body ?? ''))).toBe(true);
    expect(sent.some((m) => (m.context as { kind?: string }).kind === 'agent_lapsed')).toBe(true);
    // The assistant was told through its feed.
    const feed = await platformDb(handle.db).selectFrom('agent_events').selectAll().where('request_id', '=', sr.id).execute();
    expect(feed.map((e) => e.kind).sort()).toEqual(['sr.claim.expired', 'sr.proposal.decided']);
    // Once only.
    expect((await sweepAgents(handle.db, enqueue, { tenantId: c.t.id })).lapsed).toBe(0);
  });
});
