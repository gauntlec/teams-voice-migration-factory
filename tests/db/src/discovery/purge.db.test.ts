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
});
