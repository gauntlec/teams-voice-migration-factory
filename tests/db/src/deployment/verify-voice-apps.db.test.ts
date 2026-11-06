// The re-check after a live run covers call queues and auto attendants too: read back from Teams and re-planned, as users are.
// Before, a run that only changed them said "those aren't re-checked automatically", and they kept showing as planned until the next Discovery.
import { readFileSync } from 'node:fs';
import { sql } from 'kysely';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { DeploymentVerification } from '@tvmf/shared';
import { previewSiteChanges } from '@tvmf/db';
import { verifyDeployment } from '../../../../apps/worker/src/deployment-verify';
import type { TeamsExecutor } from '../../../../apps/worker/src/teams/executor';
import { seedConnection, seedCustomer, seedSite, seedUser, useDb, type TestCustomer } from '../helpers';

type Rec = Record<string, unknown>;
const handle = useDb();
let c: TestCustomer;
let engineer: Awaited<ReturnType<typeof seedUser>>;
let connectionId: string;
let siteId: string;
let queue: string;
let attendant: string;
const QUEUE = 'UK-Glasgow-Sales';
const ATTENDANT = 'AA-Glasgow-Main';

// As Get-CsCallQueue returned Glasgow's queue on 6 Nov 2026: enums as numbers. NoAgentApplyTo 1 is AllCalls, and the design says AllCalls.
const liveQueue: Rec = { Identity: 'cq-live-1', Name: QUEUE, RoutingMethod: 2, AgentAlertTime: 20, PresenceBasedRouting: true, ApplicationInstances: [], LanguageId: 'en-GB', OverflowAction: 0, OverflowThreshold: 2, TimeoutAction: 0, TimeoutThreshold: 60, NoAgentAction: 1, NoAgentApplyTo: 1 };

async function seedRun(rows: { object_type: string; object_id: string | null; cmdlet: string; result?: string }[]) {
  const dep = await c.s.insertInto('deployments').values({ connection_id: connectionId, mode: 'execute', status: 'completed', scope: JSON.stringify({ siteId }), summary: JSON.stringify({ applied: rows.length }), created_by: engineer.id, finished_at: new Date().toISOString() } as never).returning('id').executeTakeFirstOrThrow();
  for (const [i, r] of rows.entries()) {
    await c.s.insertInto('deployment_changes').values({ deployment_id: dep.id, seq: i + 1, correlation_id: `${dep.id}:${i}`, operator_user_id: engineer.id, object_type: r.object_type, object_id: r.object_id, cmdlet: r.cmdlet, parameters: JSON.stringify({}), before: JSON.stringify({}), after: JSON.stringify({}), result: r.result ?? 'applied' } as never).execute();
  }
  return dep.id;
}
function exec(answer: (command: string, params: Rec) => Rec[]): TeamsExecutor & { asked: [string, Rec][] } {
  const asked: [string, Rec][] = [];
  return { alive: true, signedIn: true, graphAlive: false, lastUsedAt: Date.now(), asked, query: async (command: string, params: Rec = {}) => (asked.push([command, params]), answer(command, params)) } as never;
}
const verify = (id: string, e: TeamsExecutor) => verifyDeployment(c.s, e, { deploymentId: id, siteId, connectionId, operatorUserId: engineer.id }) as Promise<DeploymentVerification & Rec>;

beforeAll(async () => {
  c = await seedCustomer(handle);
  engineer = await seedUser(handle, 'ENGINEER');
  connectionId = (await seedConnection(c.s, engineer)).id;
  siteId = (await seedSite(c.s, { sitecode: 'GLA01' })).id;
  queue = (await c.s.insertInto('build_call_queues').values({ site_id: siteId, name: QUEUE, routing_method: 'RoundRobin', agent_alert_time: 20, presence_based_routing: true, agents: JSON.stringify([]), resource_accounts: JSON.stringify([]), language_id: 'en-GB', overflow: JSON.stringify({ action: 'DisconnectWithBusy', threshold: 2 }), timeout: JSON.stringify({ action: 'Disconnect', threshold: 60 }), no_agent_action: JSON.stringify({ action: 'Disconnect' }), no_agent_apply_to: 'AllCalls' } as never).returning('id').executeTakeFirstOrThrow()).id;
  attendant = (await c.s.insertInto('build_auto_attendants').values({ site_id: siteId, name: ATTENDANT, language_id: 'en-GB', time_zone_id: 'GMT Standard Time', resource_accounts: JSON.stringify([]), config: {}, holiday_call_flows: JSON.stringify([]), default_call_flow: JSON.stringify({ greetings: [], menu: { options: [{ dtmf: 'Tone1', action: 'TransferCallToTarget', target: { kind: 'call_queue', buildId: queue } }] } }) } as never).returning('id').executeTakeFirstOrThrow()).id;
});
beforeEach(async () => {
  await c.s.updateTable('tenant_objects').set({ removed_at: new Date().toISOString() } as never).where('object_type', 'in', ['call_queue', 'auto_attendant', 'schedule']).execute();
});

describe('the re-check after a live run', () => {
  it('reads a call queue back from Teams, and it stops showing as planned', async () => {
    const id = await seedRun([{ object_type: 'call_queue', object_id: queue, cmdlet: 'New-CsCallQueue' }]);
    const e = exec((cmd) => (cmd === 'Get-CsCallQueue' ? [liveQueue, { ...liveQueue, Identity: 'other', Name: `${QUEUE}Overflow` }] : []));
    const v = await verify(id, e);
    expect(e.asked).toEqual([['Get-CsCallQueue', { NameFilter: QUEUE }]]);
    expect(v).toMatchObject({ status: 'verified', checked: 1, notChecked: 0 });
    // only the exact name was kept
    const stored = await c.s.selectFrom('tenant_objects').select(['object_key', 'removed_at']).where('object_type', '=', 'call_queue').where('removed_at', 'is', null).execute();
    expect(stored.map((o) => o.object_key)).toEqual(['cq-live-1']);
    expect(v).toMatchObject({ matched: 1, differing: [] });
    // nothing left to do, so it has dropped off the planned changes
    expect((await previewSiteChanges(c.s, { siteId, sheets: ['call_queues'], rowIds: [queue] } as never)).find((r) => r.rowId === queue)).toBeUndefined();
  });

  it('says so when it is not in Teams, and when Teams can not be read', async () => {
    const missing = await verify(await seedRun([{ object_type: 'call_queue', object_id: queue, cmdlet: 'New-CsCallQueue' }]), exec(() => []));
    expect(missing).toMatchObject({ status: 'verified', checked: 1, matched: 0, differing: [{ objectType: 'call_queue', objectId: queue, upn: QUEUE, differences: ['Not found in Teams when re-checked'] }] });
    const broken = exec(() => {
      throw new Error('Access denied');
    });
    const failed = await verify(await seedRun([{ object_type: 'call_queue', object_id: queue, cmdlet: 'Set-CsCallQueue' }]), broken);
    expect((failed as { differing: { differences: string[] }[] }).differing[0]!.differences[0]).toMatch(/Could not be re-read from Teams: Access denied/);
  });

  it("reads an auto attendant's schedules with it", async () => {
    const liveAa: Rec = { Identity: 'aa-live-1', Name: ATTENDANT, LanguageId: 'en-GB', TimeZoneId: 'GMT Standard Time', ApplicationInstances: [], CallHandlingAssociations: [{ Type: 0, ScheduleId: 'sch-1', CallFlowId: 'cf1' }], DefaultCallFlow: { Id: 'cf0', Greetings: [], Menu: { MenuOptions: [] } }, CallFlows: [] };
    const e = exec((cmd) => (cmd === 'Get-CsAutoAttendant' ? [liveAa] : cmd === 'Get-CsOnlineSchedule' ? [{ Id: 'sch-1', Name: 'Hours' }] : []));
    const v = await verify(await seedRun([{ object_type: 'auto_attendant', object_id: attendant, cmdlet: 'New-CsAutoAttendant' }]), e);
    expect(e.asked).toEqual([['Get-CsAutoAttendant', { NameFilter: ATTENDANT }], ['Get-CsOnlineSchedule', { Id: 'sch-1' }]]);
    // the live menu has no transfer, so it's a real difference, in words
    expect(v).toMatchObject({ status: 'verified', checked: 1, matched: 0, differing: [{ objectType: 'auto_attendant', upn: ATTENDANT }] });
    expect((v as { differing: { differences: string[] }[] }).differing[0]!.differences.join(' ')).toMatch(/Differs from the live auto attendant/);
    expect(await c.s.selectFrom('tenant_objects').select('object_key').where('object_type', '=', 'schedule').where('object_key', '=', 'sch-1').where('removed_at', 'is', null).executeTakeFirst()).toBeTruthy();
  });

  it('corrects saved designs that read NoAgentApplyTo backwards, without counting as an edit', async () => {
    const seedQueue = async (name: string, apply: string, liveValue: number | null) => {
      const row = await c.s.insertInto('build_call_queues').values({ site_id: siteId, name, routing_method: 'RoundRobin', agent_alert_time: 20, presence_based_routing: true, agents: JSON.stringify([]), resource_accounts: JSON.stringify([]), no_agent_apply_to: apply, updated_at: '2026-01-01T00:00:00.000Z' } as never).returning('id').executeTakeFirstOrThrow();
      if (liveValue !== null) await c.s.insertInto('tenant_objects').values({ object_type: 'call_queue', object_key: `key-${name}`, display_name: name, data: JSON.stringify({ Identity: `key-${name}`, Name: name, NoAgentApplyTo: liveValue }) } as never).execute();
      return row.id;
    };
    const imported0 = await seedQueue('imported-0', 'AllCalls', 0); // really NewCalls
    const imported1 = await seedQueue('imported-1', 'NewCalls', 1); // really AllCalls
    const right = await seedQueue('right-already', 'AllCalls', 1);
    const notLive = await seedQueue('not-live', 'NewCalls', null);
    const flow = await c.s.insertInto('discovery_flows').values({ site_id: siteId, kind: 'call_queue', name: 'imported-0', wizard_answers: JSON.stringify({ noAgentsApplyTo: 'AllCalls' }) } as never).returning('id').executeTakeFirstOrThrow();

    const text = readFileSync(new URL('../../../../packages/db/migrations/tenant/0092_no_agent_apply_to_values.sql', import.meta.url), 'utf8').replaceAll('{{SCHEMA}}', c.t.schema);
    await sql.raw(text).execute(handle.db);

    const of = async (id: string) => c.s.selectFrom('build_call_queues').select(['no_agent_apply_to', 'updated_at']).where('id', '=', id).executeTakeFirstOrThrow();
    expect((await of(imported0)).no_agent_apply_to).toBe('NewCalls');
    expect((await of(imported1)).no_agent_apply_to).toBe('AllCalls');
    expect((await of(right)).no_agent_apply_to).toBe('AllCalls');
    expect((await of(notLive)).no_agent_apply_to).toBe('NewCalls');
    expect(new Date((await of(imported0)).updated_at as string).toISOString()).toBe('2026-01-01T00:00:00.000Z');
    const saved = await c.s.selectFrom('discovery_flows').select('wizard_answers').where('id', '=', flow.id).executeTakeFirstOrThrow();
    expect(saved.wizard_answers).toMatchObject({ noAgentsApplyTo: 'NewCalls' });
  });

  it('only leaves Shared Calling policies unchecked', async () => {
    const v = await verify(await seedRun([{ object_type: 'shared_calling_policy', object_id: 'x', cmdlet: 'New-CsTeamsSharedCallingRoutingPolicy' }]), exec(() => []));
    expect(v).toMatchObject({ status: 'skipped', reason: expect.stringMatching(/only changed Shared Calling policies/) });
  });
});
