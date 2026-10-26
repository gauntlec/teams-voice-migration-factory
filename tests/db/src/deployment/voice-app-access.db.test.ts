// Authorised users, hidden ones and the dial-by-name extension read from the design columns (migration 0068) by the preview.
import { beforeAll, describe, expect, it } from 'vitest';
import { previewSiteChanges } from '@tvmf/db';
import { seedCustomer, seedSite, useDb, type TestCustomer } from '../helpers';

const handle = useDb();
let c: TestCustomer;
let siteId: string;
const ANN = '11111111-1111-4111-8111-111111111111';

async function person(upn: string, entraId: string) {
  const obj = await c.s.insertInto('tenant_objects').values({ object_type: 'user', object_key: upn, display_name: upn, data: {} } as never).returning('id').executeTakeFirstOrThrow();
  await c.s.insertInto('tenant_users').values({ object_id: obj.id, upn, entra_id: entraId, account_enabled: true, enterprise_voice_enabled: true } as never).execute();
}

const queueLive = (extra: Record<string, unknown>) =>
  JSON.stringify({ Identity: 'q1', Name: 'Sales', RoutingMethod: 'RoundRobin', AgentAlertTime: 20, PresenceBasedRouting: true, Agents: [], ...extra });

beforeAll(async () => {
  c = await seedCustomer(handle);
  siteId = (await seedSite(c.s)).id;
  await person('ann@contoso.test', ANN);
  await c.s.insertInto('tenant_objects').values({ object_type: 'call_queue', object_key: 'q1', display_name: 'Sales', data: queueLive({ AuthorizedUsers: [ANN] }) } as never).execute();
  await c.s
    .insertInto('build_call_queues')
    .values({ site_id: siteId, name: 'Sales', routing_method: 'RoundRobin', agent_alert_time: 20, presence_based_routing: true, agents: '[]', resource_accounts: '[]', overflow: '{}', timeout: '{}', no_agent_action: '{}' } as never)
    .execute();
});

const plan = async () => (await previewSiteChanges(c.s, { siteId, sheets: ['call_queues'] })).flatMap((r) => r.calls);

describe('call queue access settings from the design', () => {
  it('leaves Teams alone while unmanaged (null)', async () => {
    expect(await plan()).toEqual([]);
  });
  it('matches the same people, and hides one when asked', async () => {
    await c.s.updateTable('build_call_queues').set({ authorized_users: JSON.stringify(['ann@contoso.test']) } as never).execute();
    expect(await plan()).toEqual([]);
    await c.s.updateTable('build_call_queues').set({ hide_authorized_users: JSON.stringify(['ann@contoso.test']) } as never).execute();
    const [call] = await plan();
    expect(call).toMatchObject({ cmdlet: 'Set-CsCallQueue', parameters: { AuthorizedUsers: [ANN], HideAuthorizedUsers: [ANN] } });
  });
});
