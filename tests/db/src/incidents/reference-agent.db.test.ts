// The reference agent in docs/agents works end to end against the real agent API services: it claims an incident,
// notes it, acknowledges or proposes depending on autonomy, hands over when unsure, and stops cleanly when a person
// takes over. The "HTTP" is a thin router onto the services, so what is tested is the contract the script relies on.
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { platformDb } from '@tvmf/db';
import { createAgentSchema, createIncidentSchema, type AgentAutonomy, type CreateIncidentInput } from '@tvmf/shared';
import type { AgentPrincipal } from '../../../../apps/api/src/common/request';
import { seedCustomer, seedSite, seedUser, useDb, type TestCustomer } from '../helpers';
import { incidentServices } from './services';

const handle = useDb();
let c: TestCustomer;
let s: ReturnType<typeof incidentServices>;
let admin: Awaited<ReturnType<typeof seedUser>>;
let eng: Awaited<ReturnType<typeof seedUser>>;
let cara: Awaited<ReturnType<typeof seedUser>>;
let siteId: string;
let agentLib: { client: (o: unknown) => Record<string, (...a: unknown[]) => Promise<unknown>>; triage: (api: unknown, inc: unknown) => Promise<string[]>; runOnce: (api: unknown) => Promise<Record<string, string[]>> };
let n = 0;

const call = (over: Partial<CreateIncidentInput> = {}) =>
  createIncidentSchema.parse({
    title: 'No audio on inbound calls',
    category: 'call_quality',
    subcategory: 'one_way_audio',
    siteId,
    impact: 'team',
    urgency: 'degraded',
    description: 'People hear nothing on inbound calls.',
    answers: { where: 'In the office on wifi', how_often: 'Every call', started: 'Today 09:00' },
    ...over,
  });

/** An agent allowed on the customer at the given levels, and a `fetch` that speaks the agent API by calling the services. */
async function bot(autonomy: AgentAutonomy) {
  const a = await s.agentAdmin.create(admin, createAgentSchema.parse({ name: `Ref-${++n}-${Date.now() % 100000}`, kind: 'triage' }));
  await s.agentAdmin.setPolicy(admin, a.id, c.t.id, { enabled: true, autonomy });
  const p: AgentPrincipal = { agentId: a.id, tokenId: 't', name: a.name, kind: 'triage', scopes: ['read', 'note', 'propose', 'act'] };
  const fetchImpl = async (url: string, init: { method: string; headers: Record<string, string>; body?: string }) => {
    const path = url.split('/api/agent/v1')[1]!.split('?')[0]!;
    const qs = new URL(url).searchParams;
    const body = init.body ? JSON.parse(init.body) : {};
    const key = init.headers['Idempotency-Key'];
    const m = /^\/incidents\/([^/]+)\/([^/]+)(\/.*)?$/.exec(path);
    try {
      let out: unknown;
      if (path === '/incidents') out = await s.agentApi.list(p, { status: (qs.get('status') as 'open') ?? 'open', assigned: (qs.get('assigned') as 'unassigned') ?? undefined, limit: 50 });
      else if (path === '/events') out = await s.agentApi.feed(p, { after: Number(qs.get('after') ?? 0), limit: 100 });
      else if (m) {
        const [, tenantId, id, rest = ''] = m;
        const { createIncidentSchema: _x, ...shared } = await import('@tvmf/shared');
        void _x;
        if (init.method === 'GET' && rest === '') out = await s.agentApi.get(p, tenantId!, id!);
        else if (rest === '/claim' && init.method === 'POST') out = await s.agentApi.claim(p, tenantId!, id!, shared.agentClaimSchema.parse(body), key);
        else if (rest === '/claim/heartbeat') out = await s.agentApi.heartbeat(p, tenantId!, id!, shared.agentHeartbeatSchema.parse(body));
        else if (rest === '/claim' && init.method === 'DELETE') out = await s.agentApi.release(p, tenantId!, id!);
        else if (rest === '/notes') out = await s.agentApi.note(p, tenantId!, id!, shared.agentNoteSchema.parse(body), key);
        else if (rest === '/status') out = await s.agentApi.status(p, tenantId!, id!, shared.agentStatusSchema.parse(body), key);
        else if (rest === '/proposals') out = await s.agentApi.propose(p, tenantId!, id!, shared.agentProposalSchema.parse(body), key);
        else if (rest === '/handoff') out = await s.agentApi.handoff(p, tenantId!, id!, shared.agentHandoffSchema.parse(body), key);
        else throw new Error(`the test router has no ${init.method} ${rest}`);
      } else throw new Error(`the test router has no ${path}`);
      return new Response(JSON.stringify(JSON.parse(JSON.stringify(out))), { status: 200 });
    } catch (e) {
      const r = (e as { getResponse?: () => unknown; getStatus?: () => number });
      const resp = r.getResponse?.();
      const json = typeof resp === 'string' ? { message: resp } : (resp as object) ?? { message: (e as Error).message };
      return new Response(JSON.stringify(json), { status: r.getStatus?.() ?? 500 });
    }
  };
  const api = agentLib.client({ baseUrl: 'https://voxshift.test', token: 'vxs_agent_test', fetchImpl });
  return { a, p, api };
}

const raise = (over: Partial<CreateIncidentInput> = {}) => s.svc.create(c.t, cara, call(over), false);
const inc = (i: { id: string }) => ({ tenant_id: c.t.id, id: i.id, reference: 'x' });
const events = (id: string) => c.s.selectFrom('incident_events').selectAll().where('incident_id', '=', id).orderBy('created_at').execute();

beforeAll(async () => {
  c = await seedCustomer(handle, { managedServices: true });
  admin = await seedUser(handle, 'SUPER_ADMIN');
  eng = await seedUser(handle, 'ENGINEER', { displayName: 'Eve Engineer' });
  cara = await seedUser(handle, 'CUSTOMER', { displayName: 'Cara Customer' });
  await platformDb(handle.db).insertInto('tenant_memberships').values([eng, cara].map((u) => ({ tenant_id: c.t.id, user_id: u.id })) as never).execute();
  siteId = (await seedSite(c.s, { sitecode: 'RDG01' })).id;
  await c.s.updateTable('discovery_sites').set({ mode: 'operations' } as never).execute();
  s = incidentServices(handle);
  agentLib = await import(pathToFileURL(join(__dirname, '../../../../docs/agents/reference-triage-agent.mjs')).href);
});

describe('the reference triage agent', () => {
  it('hands over an incident it cannot help with, after leaving a note and proposing to acknowledge it (suggest level)', async () => {
    const { a, api } = await bot({ triage: 1, internal_note: 1 });
    const i = await raise();
    const done = await agentLib.triage(api, inc(i));
    expect(done).toEqual(['claimed', 'noted', 'proposed-acknowledge', 'handed-off']);
    const ev = await events(i.id);
    expect(ev.find((e) => e.body?.startsWith('Triage of'))).toMatchObject({ internal: true, actor_type: 'agent', author_id: a.id });
    expect(ev.some((e) => e.kind === 'handoff')).toBe(true);
    const staff = await s.svc.get(c.t, i.id, true, eng.id);
    expect(staff.agent!.proposals).toMatchObject([{ kind: 'status_change', state: 'proposed', summary: 'Move the incident to in progress' }]);
    expect((await c.s.selectFrom('incidents').select(['status', 'assigned_agent_id']).where('id', '=', i.id).executeTakeFirstOrThrow())).toEqual({ status: 'new', assigned_agent_id: null });
  });

  it('acknowledges directly at "act alone", and releases the lease when a known error explains the incident', async () => {
    const { api } = await bot({ triage: 3, internal_note: 3 });
    await s.problems.create(c.t, eng, { title: 'Reading wifi drops RTP', description: '', category: 'call_quality', subcategory: null, status: 'known_error', rootCause: 'QoS', workaround: 'Use wired handsets', customerNote: '', ownerId: null } as never);
    const i = await raise();
    const done = await agentLib.triage(api, inc(i));
    expect(done).toEqual(['claimed', 'noted', 'acknowledged', 'released']);
    expect((await c.s.selectFrom('incidents').select('status').where('id', '=', i.id).executeTakeFirstOrThrow()).status).toBe('in_progress');
    expect((await events(i.id)).find((e) => e.body?.startsWith('Triage of'))!.body).toContain('Workaround: Use wired handsets');
    expect(await s.claims.current(c.t, i.id)).toBeNull();
  });

  it('stops without a fight when a person takes the incident over', async () => {
    const { api } = await bot({ triage: 3, internal_note: 3 });
    const i = await raise();
    const origNote = api.note as (...a: unknown[]) => Promise<unknown>;
    api.note = async (...args: unknown[]) => {
      await s.humanAgents.takeOver(c.t, eng, i.id); // the person acts between the agent reading and writing
      return origNote(...args);
    };
    const done = await agentLib.triage(api, inc(i));
    expect(done).toEqual(['claimed', 'stopped (taken_over)']);
    expect((await c.s.selectFrom('incidents').select(['agent_hold', 'assigned_to']).where('id', '=', i.id).executeTakeFirstOrThrow())).toEqual({ agent_hold: true, assigned_to: eng.id });
  });

  it('works a whole queue in one pass, and a second pass finds nothing left', async () => {
    const { api } = await bot({ triage: 3, internal_note: 3 });
    const a1 = await raise();
    const a2 = await raise();
    const first = await agentLib.runOnce(api);
    const mine = Object.entries(first).filter(([ref]) => [a1, a2].some((x) => x.reference === ref));
    expect(mine).toHaveLength(2);
    expect(mine.every(([, steps]) => steps[0] === 'claimed')).toBe(true);
    const second = await agentLib.runOnce(api);
    expect(Object.keys(second).filter((ref) => [a1, a2].some((x) => x.reference === ref))).toEqual([]);
  });
});
