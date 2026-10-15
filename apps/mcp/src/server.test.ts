import { describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { AgentApiClient } from './client';
import { createMcpServer } from './server';

const T = '11111111-1111-4111-8111-111111111111';
const I = '22222222-2222-4222-8222-222222222222';

interface Call {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: unknown;
}

/** An MCP client connected to the server, whose "Voxshift" is a recorder with canned answers. */
async function connect(respond: (c: Call) => { status?: number; json: unknown } = () => ({ json: { ok: true } }), worksOn?: ('incidents' | 'service_requests')[]) {
  const calls: Call[] = [];
  const fetchImpl = (async (url: string, init: { method: string; headers: Record<string, string>; body?: string }) => {
    const call: Call = { method: init.method, url, headers: init.headers, body: init.body ? JSON.parse(init.body) : undefined };
    calls.push(call);
    const r = respond(call);
    return new Response(JSON.stringify(r.json), { status: r.status ?? 200 });
  }) as unknown as typeof fetch;
  const server = createMcpServer(new AgentApiClient({ baseUrl: 'https://voxshift.test/', token: 'vxs_agent_test', fetchImpl }), {}, worksOn);
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '1' });
  await Promise.all([server.connect(a), client.connect(b)]);
  const call = (name: string, args: Record<string, unknown> = {}) => client.callTool({ name, arguments: args }) as Promise<{ isError?: boolean; content: { type: string; text: string }[] }>;
  return { client, calls, call };
}
const text = (r: { content: { text: string }[] }) => r.content[0]!.text;

describe('the tools', () => {
  it('offers every operation of the agent API, with read-only ones marked', async () => {
    const { client } = await connect();
    const tools = (await client.listTools()).tools;
    expect(tools.map((t) => t.name).sort()).toEqual(
      [
        'whoami', 'add_internal_note', 'change_status', 'claim_incident', 'get_events', 'get_incident', 'hand_off', 'link_item', 'list_diagnostics', 'list_incidents', 'list_proposals', 'list_runbooks', 'propose_action', 'release_incident', 'renew_claim', 'report_proposal_result', 'run_diagnostic', 'set_priority',
        'add_request_note', 'apply_request', 'claim_request', 'deploy_request', 'get_service_request', 'hand_off_request', 'list_request_proposals', 'list_service_requests', 'move_request', 'propose_request_action', 'release_request', 'renew_request_claim', 'report_request_proposal_result', 'what_if_request',
      ].sort(),
    );
    const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
    expect(byName.get_incident!.annotations?.readOnlyHint).toBe(true);
    expect(byName.add_internal_note!.annotations?.readOnlyHint).toBe(false);
    expect(byName.run_diagnostic!.description).toContain('read-only');
    // The model is told how to describe proposals.
    expect(byName.propose_action!.description).toContain('customer_update');
  });

  it('offers an assistant only the tools for the areas it works in', async () => {
    const names = async (worksOn: ('incidents' | 'service_requests')[]) => (await (await connect(undefined, worksOn)).client.listTools()).tools.map((t) => t.name);
    const inc = await names(['incidents']);
    const req = await names(['service_requests']);
    // Everyone gets whoami and the events feed.
    for (const shared of ['whoami', 'get_events']) {
      expect(inc).toContain(shared);
      expect(req).toContain(shared);
    }
    expect(inc).toContain('claim_incident');
    expect(inc).not.toContain('deploy_request');
    expect(inc.some((n) => n.includes('request'))).toBe(false);
    expect(req).toContain('deploy_request');
    expect(req).not.toContain('claim_incident');
    expect(req).not.toContain('run_diagnostic');
    // Prompts follow the area too.
    const prompts = async (worksOn: ('incidents' | 'service_requests')[]) => (await (await connect(undefined, worksOn)).client.listPrompts()).prompts.map((p) => p.name);
    expect(await prompts(['incidents'])).toEqual(['work_incident']);
    expect(await prompts(['service_requests'])).toEqual(['work_service_request']);
    expect((await names(['incidents', 'service_requests'])).length).toBe(inc.length + req.length - 2);
  });

  it('whoami asks the API who this assistant is, and a wrong_area refusal says what to do', async () => {
    const me = { name: 'Triage bot', worksOn: ['incidents'], scopes: ['read', 'note'], customers: [] };
    const { call, calls } = await connect(() => ({ json: me }));
    expect(JSON.parse(text(await call('whoami')))).toEqual(me);
    expect(calls[0]).toMatchObject({ method: 'GET', url: 'https://voxshift.test/api/agent/v1/me' });
    const refused = await (await connect(() => ({ status: 403, json: { message: 'This assistant is set up for incidents only.', code: 'wrong_area' } }))).call('list_service_requests');
    expect(refused.isError).toBe(true);
    expect(text(refused)).toContain('wrong_area');
    expect(text(refused)).toContain('whoami');
  });

  it('list_runbooks needs no network and names all six checks', async () => {
    const { call, calls } = await connect();
    const r = JSON.parse(text(await call('list_runbooks')));
    expect(r.map((x: { key: string }) => x.key).sort()).toEqual(['emergency_check', 'number_check', 'queue_check', 'recent_changes', 'routing_check', 'user_voice']);
    expect(calls).toHaveLength(0);
  });

  it('reads with the token, and builds the queue query', async () => {
    const { call, calls } = await connect(() => ({ json: [{ id: I, reference: 'INC-0001' }] }));
    const r = await call('list_incidents', { assigned: 'unassigned', limit: 10 });
    expect(JSON.parse(text(r))).toEqual([{ id: I, reference: 'INC-0001' }]);
    expect(calls[0]).toMatchObject({ method: 'GET', url: 'https://voxshift.test/api/agent/v1/incidents?status=open&assigned=unassigned&limit=10' });
    expect(calls[0]!.headers.Authorization).toBe('Bearer vxs_agent_test');
    await call('get_incident', { tenantId: T, incidentId: I });
    expect(calls[1]!.url).toBe(`https://voxshift.test/api/agent/v1/incidents/${T}/${I}`);
  });

  it('writes with an Idempotency-Key: the one given, or a fresh one', async () => {
    const { call, calls } = await connect();
    await call('add_internal_note', { tenantId: T, incidentId: I, body: 'Checked the queue', expectedVersion: 3, idempotencyKey: 'note-1' });
    expect(calls[0]).toMatchObject({ method: 'POST', url: `https://voxshift.test/api/agent/v1/incidents/${T}/${I}/notes`, body: { body: 'Checked the queue', expectedVersion: 3 } });
    expect(calls[0]!.headers['Idempotency-Key']).toBe('note-1');
    await call('claim_incident', { tenantId: T, incidentId: I, note: 'Triage' });
    expect(calls[1]!.headers['Idempotency-Key']).toMatch(/^[0-9a-f-]{36}$/);
    expect(calls[1]!.body).toEqual({ note: 'Triage' });
  });

  it('carries diagnostics, proposals and hand-offs through to the right endpoints', async () => {
    const { call, calls } = await connect();
    await call('run_diagnostic', { tenantId: T, incidentId: I, runbook: 'queue_check', input: 'Sales queue' });
    await call('propose_action', { tenantId: T, incidentId: I, kind: 'customer_update', params: { body: 'We are on it.' }, rationale: 'No update for an hour' });
    await call('hand_off', { tenantId: T, incidentId: I, summary: { recommendation: 'Look at the SBC', confidence: 'low' } });
    await call('report_proposal_result', { tenantId: T, incidentId: I, proposalId: '33333333-3333-4333-8333-333333333333', state: 'done' });
    await call('release_incident', { tenantId: T, incidentId: I });
    expect(calls.map((c) => `${c.method} ${c.url.replace('https://voxshift.test/api/agent/v1', '').replace(T, 'T').replace(I, 'I')}`)).toEqual([
      'POST /incidents/T/I/diagnostics',
      'POST /incidents/T/I/proposals',
      'POST /incidents/T/I/handoff',
      'POST /incidents/T/I/proposals/33333333-3333-4333-8333-333333333333/result',
      'DELETE /incidents/T/I/claim',
    ]);
    expect(calls[1]!.body).toMatchObject({ kind: 'customer_update', risk: 'low' });
    expect(calls[2]!.body).toMatchObject({ to: 'queue', summary: { tried: [], found: [], evidence: [], confidence: 'low' } });
  });

  it('turns a refusal into advice the model can act on', async () => {
    const { call } = await connect(() => ({ status: 403, json: { message: 'Your autonomy is 1', code: 'propose_instead' } }));
    const r = await call('change_status', { tenantId: T, incidentId: I, to: 'in_progress' });
    expect(r.isError).toBe(true);
    expect(text(r)).toContain('[propose_instead]');
    expect(text(r)).toContain('Use propose_action instead');
    const taken = await (await connect(() => ({ status: 409, json: { message: 'A person has taken this over', code: 'taken_over' } }))).call('add_internal_note', { tenantId: T, incidentId: I, body: 'x' });
    expect(text(taken)).toContain('Stop changing it');
    const stale = await (await connect(() => ({ status: 409, json: { message: 'moved', code: 'stale' } }))).call('add_internal_note', { tenantId: T, incidentId: I, body: 'x' });
    expect(text(stale)).toContain('get_incident again');
    const bad = await (await connect(() => ({ status: 401, json: { message: 'Unauthorized' } }))).call('get_events', { after: 0 });
    expect(text(bad)).toContain('token is wrong, expired or revoked');
  });

  it('says so when Voxshift cannot be reached', async () => {
    const server = createMcpServer(new AgentApiClient({ baseUrl: 'https://x.test', token: 't', fetchImpl: (async () => { throw new Error('connect ECONNREFUSED'); }) as unknown as typeof fetch }));
    const [a, b] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'test', version: '1' });
    await Promise.all([server.connect(a), client.connect(b)]);
    const r = (await client.callTool({ name: 'get_events', arguments: { after: 0 } })) as { isError?: boolean; content: { text: string }[] };
    expect(r.isError).toBe(true);
    expect(text(r)).toContain('Could not reach Voxshift: connect ECONNREFUSED');
  });

  it('refuses input the API would refuse, before it is sent', async () => {
    const { client, calls } = await connect();
    const r = (await client.callTool({ name: 'run_diagnostic', arguments: { tenantId: T, incidentId: I, runbook: 'rm_rf' } }).catch((e) => ({ isError: true, content: [{ text: String(e) }] }))) as { isError?: boolean };
    expect(r.isError).toBe(true);
    const r2 = (await client.callTool({ name: 'get_incident', arguments: { tenantId: 'nope', incidentId: I } }).catch((e) => ({ isError: true, content: [{ text: String(e) }] }))) as { isError?: boolean };
    expect(r2.isError).toBe(true);
    expect(calls).toHaveLength(0);
  });

  it('has a prompt that walks an assistant through an incident safely', async () => {
    const { client } = await connect();
    expect((await client.listPrompts()).prompts.map((p) => p.name).sort()).toEqual(['work_incident', 'work_service_request']);
    const p = await client.getPrompt({ name: 'work_incident', arguments: { tenantId: T, incidentId: I } });
    const body = (p.messages[0]!.content as { text: string }).text;
    expect(body).toContain(I);
    expect(body).toContain('claim_incident');
    expect(body).toContain('Never tell the customer anything yourself');
  });

  it('works service requests through the service request endpoints, and tells the model a deploy is only ever approved', async () => {
    const R = '44444444-4444-4444-8444-444444444444';
    const { client, call, calls } = await connect(() => ({ json: { ok: true } }));
    await call('list_service_requests', { automatable: true, assigned: 'unassigned' });
    await call('get_service_request', { tenantId: T, requestId: R });
    await call('apply_request', { tenantId: T, requestId: R });
    await call('what_if_request', { tenantId: T, requestId: R, idempotencyKey: 'w1' });
    await call('move_request', { tenantId: T, requestId: R, to: 'built' });
    await call('propose_request_action', { tenantId: T, requestId: R, kind: 'external', params: { actionClass: 'change_deploy', title: 'Deploy SR-7' }, rationale: 'Clean What-If' });
    await call('deploy_request', { tenantId: T, requestId: R, proposalId: '55555555-5555-4555-8555-555555555555' });
    await call('hand_off_request', { tenantId: T, requestId: R, summary: { recommendation: 'Needs forwarding set up', confidence: 'high' } });
    await call('release_request', { tenantId: T, requestId: R });
    const base = 'https://voxshift.test/api/agent/v1/service-requests';
    expect(calls.map((c) => `${c.method} ${c.url.replace(base, '').replace(T, 'T').replace(R, 'R')}`)).toEqual([
      'GET ?status=open&assigned=unassigned&automatable=true',
      'GET /T/R',
      'POST /T/R/apply',
      'POST /T/R/what-if',
      'POST /T/R/status',
      'POST /T/R/proposals',
      'POST /T/R/deploy',
      'POST /T/R/handoff',
      'DELETE /T/R/claim',
    ]);
    expect(calls[3]!.headers['Idempotency-Key']).toBe('w1');
    expect(calls[6]!.body).toEqual({ proposalId: '55555555-5555-4555-8555-555555555555' });
    const deploy = (await client.listTools()).tools.find((t) => t.name === 'deploy_request')!;
    expect(deploy.description).toContain('ONLY as a person approved it');
    expect(deploy.annotations?.destructiveHint).toBe(true);
    // A deploy needs a proposal.
    const bad = (await client.callTool({ name: 'deploy_request', arguments: { tenantId: T, requestId: R } }).catch((e) => ({ isError: true, content: [{ text: String(e) }] }))) as { isError?: boolean };
    expect(bad.isError).toBe(true);
    const p = await client.getPrompt({ name: 'work_service_request', arguments: { tenantId: T, requestId: R } });
    const body = (p.messages[0]!.content as { text: string }).text;
    expect(body).toContain('automation.eligible');
    expect(body).toContain('Do not look for ways around that');
  });
});
