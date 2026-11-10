// "Delete discovered data" (TenantDiscoveryService.purge) must work however the customer's design refers to discovered data. A calling-policy
// mapping (calling_policy_site_map) points at a discovered policy with ON DELETE RESTRICT, so the purge has to remove those mappings first.
import { beforeAll, describe, expect, it } from 'vitest';
import { AuditService } from '../../../../apps/api/src/common/audit.service';
import { TenantDiscoveryService } from '../../../../apps/api/src/modules/tenant-discovery/tenant-discovery.service';
import { seedCustomer, seedUser, unused, useDb, type TestCustomer } from '../helpers';

const handle = useDb();
let c: TestCustomer;

beforeAll(async () => {
  c = await seedCustomer(handle);
});

describe('TenantDiscoveryService.purge', () => {
  it('deletes the discovered data even when a calling-policy mapping points at a discovered policy', async () => {
    const admin = await seedUser(handle, 'SUPER_ADMIN');
    const obj = await c.s
      .insertInto('tenant_objects')
      .values({ object_type: 'TeamsCallingPolicy', object_key: 'Tag:Sales', display_name: 'Sales', data: {} } as never)
      .returning('id')
      .executeTakeFirstOrThrow();
    const policy = await c.s
      .insertInto('tenant_policies')
      .values({ object_id: obj.id, policy_type: 'TeamsCallingPolicy', identity: 'Tag:Sales', name: 'Sales', data: {} } as never)
      .returning('id')
      .executeTakeFirstOrThrow();
    const site = await c.s.insertInto('discovery_sites').values({ sitecode: 'HQ', name: 'HQ' } as never).returning('id').executeTakeFirstOrThrow();
    const cp = await c.s.insertInto('discovery_calling_policies').values({ name: 'Standard' } as never).returning('id').executeTakeFirstOrThrow();
    await c.s
      .insertInto('calling_policy_site_map')
      .values({ site_id: site.id, discovery_calling_policy_id: cp.id, tenant_policy_id: policy.id } as never)
      .execute();

    const svc = new TenantDiscoveryService(handle.db, unused('queue'), new AuditService(handle.db), unused('deployments'), unused('dataCollection'), unused('telephony'));
    const result = await svc.purge(c.t, admin);

    expect(result.objects).toBe(1);
    expect(result.callingPolicyMappingsRemoved).toBe(1);
    expect(await c.s.selectFrom('tenant_objects').select('id').execute()).toHaveLength(0);
    expect(await c.s.selectFrom('tenant_policies').select('id').execute()).toHaveLength(0);
    // the site and the calling policy are the customer's own design data and stay; only the mapping to a discovered policy goes
    expect(await c.s.selectFrom('discovery_sites').select('id').where('id', '=', site.id).execute()).toHaveLength(1);
    expect(await c.s.selectFrom('discovery_calling_policies').select('id').where('id', '=', cp.id).execute()).toHaveLength(1);
    expect(await c.s.selectFrom('calling_policy_site_map').select('id').execute()).toHaveLength(0);
  });

  it('also removes what the syncs wrote into the number inventory, keeping Site Data numbers', async () => {
    const admin = await seedUser(handle, 'SUPER_ADMIN');
    const s = c.s;
    const site = await s.insertInto('discovery_sites').values({ sitecode: 'NUM1', name: 'Numbers' } as never).returning('id').executeTakeFirstOrThrow();
    // a range typed in Site Data, with a number Teams had on someone and one reserved
    const own = await s.insertInto('discovery_number_ranges').values({ range_start: '+441000000001', range_end: '+441000000002', kind: 'new', sitecode: 'NUM1' } as never).returning('id').executeTakeFirstOrThrow();
    await s.insertInto('phone_numbers').values([
      { range_id: own.id, e164: '+441000000001', status: 'assigned', live_only: true, live_status: 'Assigned', live_holder_kind: 'user', live_holder_upn: 'someone@other.test', live_holder_name: 'Someone' },
      { range_id: own.id, e164: '+441000000002', status: 'reserved', live_status: 'Assigned', live_holder_upn: 'else@other.test', conflict: 'Live in Teams on else' },
    ] as never).execute();
    // a "Found in Teams" range a sync made: one plain number, and one a person has since parked
    const found = await s.insertInto('discovery_number_ranges').values({ range_start: '+442000000001', range_end: '+442000000003', kind: 'retain', sitecode: null, comments: 'Found in Teams by Discovery: assigned there, but in none of our ranges.' } as never).returning('id').executeTakeFirstOrThrow();
    await s.insertInto('phone_numbers').values([
      { range_id: found.id, e164: '+442000000001', status: 'assigned', live_only: true, live_status: 'Assigned', live_holder_upn: 'a@other.test' },
      { range_id: found.id, e164: '+442000000003', status: 'parked', live_status: 'Assigned', live_holder_upn: 'b@other.test' },
    ] as never).execute();
    const empty = await s.insertInto('discovery_number_ranges').values({ range_start: '+443000000001', range_end: '+443000000001', kind: 'retain', sitecode: null, comments: 'Found in Teams by Discovery: assigned there, but in none of our ranges.' } as never).returning('id').executeTakeFirstOrThrow();
    await s.insertInto('phone_numbers').values({ range_id: empty.id, e164: '+443000000001', status: 'assigned', live_only: true, live_status: 'Assigned', live_holder_upn: 'c@other.test' } as never).execute();
    await s.insertInto('deployment_drift').values({ site_id: site.id, drifted: 2, rows: JSON.stringify([]) } as never).execute();

    const svc = new TenantDiscoveryService(handle.db, unused('queue'), new AuditService(handle.db), unused('deployments'), unused('dataCollection'), unused('telephony'));
    const result = await svc.purge(c.t, admin);
    expect(result).toMatchObject({ numbersRemoved: 2, rangesRemoved: 1 });

    const numbers = await s.selectFrom('phone_numbers').select(['e164', 'status', 'live_only', 'live_holder_upn', 'conflict']).orderBy('e164').execute();
    expect(numbers).toEqual([
      { e164: '+441000000001', status: 'available', live_only: false, live_holder_upn: null, conflict: null },
      { e164: '+441000000002', status: 'reserved', live_only: false, live_holder_upn: null, conflict: null },
      { e164: '+442000000003', status: 'parked', live_only: false, live_holder_upn: null, conflict: null },
    ]);
    // the Site Data range stays, the found range with a parked number stays, the emptied one goes
    expect((await s.selectFrom('discovery_number_ranges').select('id').execute()).map((r) => r.id).sort()).toEqual([own.id, found.id].sort());
    expect(await s.selectFrom('deployment_drift').select('site_id').execute()).toHaveLength(0);
  });
});
