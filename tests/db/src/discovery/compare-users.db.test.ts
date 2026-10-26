// Compare two discovered users: each policy carries the settings Discovery stored for it, so a different policy explains itself.
import { beforeAll, describe, expect, it } from 'vitest';
import { AuditService } from '../../../../apps/api/src/common/audit.service';
import { TenantDiscoveryService } from '../../../../apps/api/src/modules/tenant-discovery/tenant-discovery.service';
import { seedCustomer, unused, useDb, type TestCustomer } from '../helpers';

const handle = useDb();
let c: TestCustomer;
let svc: TenantDiscoveryService;
const ids: Record<string, string> = {};

async function user(upn: string, routing: string | null) {
  const obj = await c.s.insertInto('tenant_objects').values({ object_type: 'user', object_key: upn, display_name: upn, data: {} } as never).returning('id').executeTakeFirstOrThrow();
  const row = await c.s
    .insertInto('tenant_users')
    .values({ object_id: obj.id, upn, display_name: upn, account_enabled: true, enterprise_voice_enabled: true, policies: JSON.stringify({ OnlineVoiceRoutingPolicy: routing }) } as never)
    .returning('id')
    .executeTakeFirstOrThrow();
  ids[upn] = row.id;
}

async function policy(name: string, usages: string[]) {
  const obj = await c.s.insertInto('tenant_objects').values({ object_type: 'policy', object_key: `OnlineVoiceRoutingPolicy:${name}`, display_name: name, data: {} } as never).returning('id').executeTakeFirstOrThrow();
  await c.s
    .insertInto('tenant_policies')
    .values({ object_id: obj.id, policy_type: 'OnlineVoiceRoutingPolicy', identity: name === 'Global' ? 'Global' : `Tag:${name}`, name, is_global: name === 'Global', data: JSON.stringify({ Identity: name, OnlinePstnUsages: usages }) } as never)
    .execute();
}

beforeAll(async () => {
  c = await seedCustomer(handle);
  svc = new TenantDiscoveryService(handle.db, unused('queue'), new AuditService(handle.db), unused('deployments'), unused('dataCollection'), unused('telephony'));
  await policy('UK-International', ['UK', 'International']);
  await policy('Global', ['UK']);
  await user('anna@contoso.test', 'UK-International');
  await user('ben@contoso.test', null);
});

describe('compareUsers', () => {
  it('lines up the routing policies and shows the usage that differs; no policy means Global', async () => {
    const res = await svc.compareUsers(c.t, ids['anna@contoso.test'], ids['ben@contoso.test']);
    const routing = res.rows.find((r) => r.label === 'OnlineVoiceRoutingPolicy')!;
    expect(routing).toMatchObject({ a: 'UK-International', b: 'Global', differs: true });
    expect(routing.detail).toEqual([{ label: 'OnlinePstnUsages', a: 'UK, International', b: 'UK' }]);
    expect(res.a.upn).toBe('anna@contoso.test');
    expect(res.dataAsOf).toBeNull();
  });

  it('answers 404 for a user that is not in Discovery', async () => {
    await expect(svc.compareUsers(c.t, ids['anna@contoso.test'], '00000000-0000-4000-8000-000000000000')).rejects.toThrow('User not found');
  });
});
