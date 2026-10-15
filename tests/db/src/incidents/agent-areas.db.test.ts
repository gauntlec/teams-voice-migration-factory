// Where an assistant works (docs/AGENTS.md): incidents, service requests, or both. The API refuses the other area, the events feed and
// webhooks only carry the areas it works in, /me says what it may do, the admin page keeps only the relevant autonomy, and the
// assistants Voxshift ships are narrowed to their job.
import { randomUUID } from 'node:crypto';
import { ForbiddenException, type ExecutionContext } from '@nestjs/common';
import { beforeAll, describe, expect, it } from 'vitest';
import { platformDb } from '@tvmf/db';
import { agentWorksOnSchema, createAgentSchema, createAgentWebhookSchema, createAgentTokenSchema, createIncidentSchema, type AgentDomain } from '@tvmf/shared';
import type { AppRequest } from '../../../../apps/api/src/common/request';
import { AgentApiController } from '../../../../apps/api/src/modules/incidents/agent-api.controller';
import { SrAgentApiController } from '../../../../apps/api/src/modules/service-requests/sr-agent-api.controller';
import { deliverWebhooks } from '../../../../apps/worker/src/agents';
import { useGlobalAgentLock, seedCustomer, seedSite, seedUser, useDb, type TestCustomer } from '../helpers';
import { incidentServices } from './services';

const handle = useDb();
useGlobalAgentLock(handle);
let c: TestCustomer;
let s: ReturnType<typeof incidentServices>;
let admin: Awaited<ReturnType<typeof seedUser>>;
let cara: Awaited<ReturnType<typeof seedUser>>;
let siteId: string;
let n = 0;

const incidentOnly: AgentDomain[] = ['incidents'];
const requestsOnly: AgentDomain[] = ['service_requests'];

async function bot(name: string, worksOn?: AgentDomain[], autonomy = {}) {
  const a = await s.agentAdmin.create(admin, createAgentSchema.parse({ name: `${name}-${++n}-${Date.now() % 100000}`, kind: 'general', ...(worksOn ? { worksOn } : {}) }));
  await s.agentAdmin.setPolicy(admin, a.id, c.t.id, { enabled: true, autonomy });
  const t = await s.agentAdmin.createToken(admin, a.id, createAgentTokenSchema.parse({ name: 'Runner', scopes: ['read', 'note', 'propose', 'act'] }));
  return { a, token: t.token };
}

/** Runs the real guard against a handler on a controller, the way Nest would. */
async function through(token: string, controller: { prototype: object } & (new (...a: never[]) => unknown), handler: string) {
  const req = { headers: { authorization: `Bearer ${token}` }, method: 'GET', ip: '203.0.113.7' } as unknown as AppRequest;
  const fn = (controller.prototype as Record<string, () => unknown>)[handler]!;
  const ctx = { switchToHttp: () => ({ getRequest: () => req }), getHandler: () => fn, getClass: () => controller } as unknown as ExecutionContext;
  const ok = await s.agentGuard.canActivate(ctx);
  return { ok, req };
}
const refusedCode = async (p: Promise<unknown>) => {
  try {
    await p;
    return null;
  } catch (e) {
    expect(e).toBeInstanceOf(ForbiddenException);
    return ((e as ForbiddenException).getResponse() as { code?: string }).code ?? null;
  }
};

beforeAll(async () => {
  c = await seedCustomer(handle, { managedServices: true });
  admin = await seedUser(handle, 'SUPER_ADMIN', { displayName: 'Ada Admin' });
  cara = await seedUser(handle, 'CUSTOMER', { displayName: 'Cara Customer' });
  await platformDb(handle.db).insertInto('tenant_memberships').values({ tenant_id: c.t.id, user_id: cara.id } as never).execute();
  siteId = (await seedSite(c.s, { sitecode: 'RDG01' })).id;
  await c.s.updateTable('discovery_sites').set({ mode: 'operations' } as never).execute();
  s = incidentServices(handle);
});

describe('choosing where an assistant works', () => {
  it('needs at least one area, is tidied, and defaults to both for old callers', () => {
    expect(agentWorksOnSchema.safeParse([]).success).toBe(false);
    expect(agentWorksOnSchema.parse(['service_requests', 'incidents', 'incidents'])).toEqual(['incidents', 'service_requests']);
    expect(agentWorksOnSchema.safeParse(['tickets']).success).toBe(false);
    expect(createAgentSchema.parse({ name: 'Old caller' }).worksOn).toEqual(['incidents', 'service_requests']);
    expect(createAgentSchema.safeParse({ name: 'Nowhere', worksOn: [] }).success).toBe(false);
  });

  it('can be changed on an outside assistant, but not on a built-in one, which is made for one job', async () => {
    const { a } = await bot('Changeable', incidentOnly);
    expect(a.works_on).toEqual(['incidents']);
    const u = await s.agentAdmin.update(admin, a.id, { worksOn: ['incidents', 'service_requests'] });
    expect(u.works_on).toEqual(['incidents', 'service_requests']);
    const changes = await s.agentAdmin.createBuiltin(admin, { key: 'changes' }).catch(async () => (await platformDb(handle.db).selectFrom('agents').selectAll().where('builtin_key', '=', 'changes').executeTakeFirstOrThrow()));
    expect(changes.works_on).toEqual(['service_requests']);
    await expect(s.agentAdmin.update(admin, changes.id, { worksOn: ['incidents'] })).rejects.toThrow(/built-in/);
    const triage = await s.agentAdmin.createBuiltin(admin, { key: 'triage' }).catch(async () => (await platformDb(handle.db).selectFrom('agents').selectAll().where('builtin_key', '=', 'triage').executeTakeFirstOrThrow()));
    expect(triage.works_on).toEqual(['incidents']);
  });

  it('keeps only the autonomy for the areas it works in', async () => {
    const { a } = await bot('Trim', incidentOnly, { triage: 3, resolve: 3, change_deploy: 2, change_design: 3 });
    const d = await s.agentAdmin.get(a.id);
    expect(d.classes).toEqual(['triage', 'internal_note', 'customer_update', 'diagnostic_read', 'resolve']);
    const pol = await platformDb(handle.db).selectFrom('agent_customer_policy').select('autonomy').where('agent_id', '=', a.id).where('tenant_id', '=', c.t.id).executeTakeFirstOrThrow();
    expect(pol.autonomy).toEqual({ triage: 3, resolve: 3 });
    const sr = await bot('TrimSr', requestsOnly, { triage: 1, resolve: 3, change_deploy: 2 });
    const p2 = await platformDb(handle.db).selectFrom('agent_customer_policy').select('autonomy').where('agent_id', '=', sr.a.id).where('tenant_id', '=', c.t.id).executeTakeFirstOrThrow();
    expect(p2.autonomy).toEqual({ triage: 1, change_deploy: 2 });
  });
});

describe('the API keeps each assistant to its area', () => {
  it('lets an incident assistant use incident routes and refuses service request routes (and the other way round)', async () => {
    const inc = await bot('Inc', incidentOnly);
    const req = await bot('Req', requestsOnly);
    expect((await through(inc.token, AgentApiController, 'list')).ok).toBe(true);
    expect(await refusedCode(through(inc.token, SrAgentApiController, 'list'))).toBe('wrong_area');
    expect(await refusedCode(through(inc.token, SrAgentApiController, 'deploy'))).toBe('wrong_area');
    expect((await through(req.token, SrAgentApiController, 'list')).ok).toBe(true);
    expect(await refusedCode(through(req.token, AgentApiController, 'list'))).toBe('wrong_area');
    expect(await refusedCode(through(req.token, AgentApiController, 'claim'))).toBe('wrong_area');
  });

  it('says which area it is set up for and where to change it', async () => {
    const inc = await bot('Msg', incidentOnly);
    await expect(through(inc.token, SrAgentApiController, 'list')).rejects.toThrow(/set up for incidents only.*service requests.*Administration > Assistants/s);
  });

  it('lets an assistant for both use everything, and every assistant use /me and the events feed', async () => {
    const both = await bot('Both');
    for (const [ctl, h] of [[AgentApiController, 'list'], [SrAgentApiController, 'list'], [SrAgentApiController, 'deploy']] as const) expect((await through(both.token, ctl, h)).ok).toBe(true);
    const inc = await bot('Any1', incidentOnly);
    const req = await bot('Any2', requestsOnly);
    for (const b of [inc, req]) for (const h of ['me', 'feed']) expect((await through(b.token, AgentApiController, h)).ok).toBe(true);
  });

  it('puts a copy of the area on the request the controller sees', async () => {
    const inc = await bot('Principal', incidentOnly);
    expect((await through(inc.token, AgentApiController, 'list')).req.agent?.worksOn).toEqual(['incidents']);
  });
});

describe('/me', () => {
  it('says who the assistant is, where it works, and the levels that apply, for the customers it is allowed on', async () => {
    const inc = await bot('MeInc', incidentOnly, { triage: 2, diagnostic_read: 3 });
    const principal = (await through(inc.token, AgentApiController, 'me')).req.agent!;
    const me = await s.agentApi.me(principal);
    expect(me).toMatchObject({ name: inc.a.name, worksOn: ['incidents'], scopes: ['read', 'note', 'propose', 'act'] });
    expect(me.customers).toHaveLength(1);
    const mine = me.customers[0]!;
    expect(mine).toMatchObject({ tenantId: c.t.id, name: c.t.name });
    expect(Object.keys(mine.autonomy).sort()).toEqual(['customer_update', 'diagnostic_read', 'internal_note', 'resolve', 'triage']);
    expect(mine.autonomy).toMatchObject({ triage: 2, diagnostic_read: 3 });

    const req = await bot('MeReq', requestsOnly, { change_design: 3 });
    const m2 = await s.agentApi.me((await through(req.token, SrAgentApiController, 'list')).req.agent!);
    expect(Object.keys(m2.customers[0]!.autonomy).sort()).toEqual(['change_deploy', 'change_design', 'change_whatif', 'customer_update', 'internal_note', 'triage']);
    expect(m2.customers[0]!.autonomy.change_design).toBe(3);

    // A customer it was switched off for, or where assistants are off, is not listed.
    await s.agentAdmin.setPolicy(admin, req.a.id, c.t.id, { enabled: false, autonomy: {} });
    expect((await s.agentApi.me((await through(req.token, SrAgentApiController, 'list')).req.agent!)).customers).toEqual([]);
  });
});

describe('the events feed and webhooks', () => {
  const requestRow = () => ({ id: randomUUID(), number: 7, type: 'change_user', status: 'new', priority: 'normal' });

  it('carry only the area the assistant works in', async () => {
    const inc = await bot('FeedInc', incidentOnly);
    const req = await bot('FeedReq', requestsOnly);
    const both = await bot('FeedBoth');
    const after = Number((await platformDb(handle.db).selectFrom('agent_events').select('id').orderBy('id', 'desc').limit(1).executeTakeFirst())?.id ?? 0);
    const i = await s.svc.create(c.t, cara, createIncidentSchema.parse({ title: 'No audio on calls', category: 'call_quality', subcategory: 'one_way_audio', siteId, impact: 'team', urgency: 'degraded', description: 'People hear nothing on inbound calls.', answers: { where: 'In the office on wifi', how_often: 'Every call', started: 'Today 09:00' } }), false);
    const r = requestRow();
    await s.events.emitRequest(c.t.id, r, 'sr.created');
    const kinds = async (id: string, worksOn: AgentDomain[]) => (await s.events.list(id, after, 100, worksOn)).events.map((e) => (e.incident_id === i.id ? 'incident' : e.request_id === r.id ? 'request' : 'other'));
    expect(await kinds(inc.a.id, incidentOnly)).toEqual(['incident']);
    expect(await kinds(req.a.id, requestsOnly)).toEqual(['request']);
    expect((await kinds(both.a.id, ['incidents', 'service_requests'])).sort()).toEqual(['incident', 'request']);
  });

  it('only deliver that area to a webhook, and include the request id', async () => {
    const inc = await bot('HookInc', incidentOnly);
    const req = await bot('HookReq', requestsOnly);
    const urls: Record<string, string> = {};
    for (const [key, b] of [['inc', inc], ['req', req]] as const) {
      urls[key] = `https://hooks.test/${key}-${randomUUID()}`;
      await s.agentAdmin.createWebhook(admin, b.a.id, createAgentWebhookSchema.parse({ url: urls[key], kinds: [] }));
    }
    const calls: { url: string; body: string }[] = [];
    const okFetch = (async (url: string, init: { body: string }) => (calls.push({ url, body: init.body }), new Response('ok', { status: 200 }))) as unknown as typeof fetch;
    await deliverWebhooks(handle.db, { fetch: okFetch }); // moves each cursor to the present
    calls.length = 0;
    const r = requestRow();
    const i = await s.svc.create(c.t, cara, createIncidentSchema.parse({ title: 'Choppy audio at Reading', category: 'call_quality', subcategory: 'choppy_audio', siteId, impact: 'team', urgency: 'degraded', description: 'People hear robotic audio on calls.', answers: { where: 'In the office on wifi', how_often: 'Every call', started: 'Today 09:00' } }), false);
    await s.events.emitRequest(c.t.id, r, 'sr.created');
    await deliverWebhooks(handle.db, { fetch: okFetch });
    const events = (url: string) => calls.filter((x) => x.url === url).flatMap((x) => (JSON.parse(x.body) as { events: { incident_id: string | null; request_id: string | null }[] }).events);
    expect(events(urls.inc!).map((e) => e.incident_id)).toContain(i.id);
    expect(events(urls.inc!).every((e) => !e.request_id)).toBe(true);
    expect(events(urls.req!).map((e) => e.request_id)).toEqual([r.id]);
    expect(events(urls.req!).every((e) => !e.incident_id)).toBe(true);
  });
});
