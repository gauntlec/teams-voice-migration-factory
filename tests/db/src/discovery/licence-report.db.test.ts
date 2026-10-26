// Licence and cost report: built from what Discovery stored, counted per Data Collection site.
import { beforeAll, describe, expect, it } from 'vitest';
import { AuditService } from '../../../../apps/api/src/common/audit.service';
import { TenantDiscoveryService } from '../../../../apps/api/src/modules/tenant-discovery/tenant-discovery.service';
import { seedCustomer, seedSite, unused, useDb, type TestCustomer } from '../helpers';

const handle = useDb();
let c: TestCustomer;
let svc: TenantDiscoveryService;
const phone = JSON.stringify([{ Capability: 'MCOEV', CapabilityStatus: 'Enabled' }]);
const raPlan = JSON.stringify([{ Capability: 'MCOEV_VIRTUALUSER', CapabilityStatus: 'Enabled' }]);

async function obj(type: string, key: string, data: Record<string, unknown> = {}) {
  return (await c.s.insertInto('tenant_objects').values({ object_type: type, object_key: key, display_name: key, data: JSON.stringify(data) } as never).returning('id').executeTakeFirstOrThrow()).id;
}
async function account(upn: string, v: Record<string, unknown>) {
  await c.s.insertInto('tenant_users').values({ object_id: await obj('user', upn), upn, display_name: upn, account_type: 'User', account_enabled: true, enterprise_voice_enabled: true, assigned_plans: phone, ...v } as never).execute();
}

beforeAll(async () => {
  c = await seedCustomer(handle);
  svc = new TenantDiscoveryService(handle.db, unused('queue'), new AuditService(handle.db), unused('deployments'), unused('dataCollection'), unused('telephony'));
  const site = await seedSite(c.s, { sitecode: 'LTN01' });
  await account('leaver@contoso.test', { account_enabled: false, line_uri: 'tel:+441582000001' });
  await account('idle@contoso.test', { enterprise_voice_enabled: false });
  await account('ra-main@contoso.test', { account_type: 'ResourceAccount', entra_id: 'ra-1', assigned_plans: raPlan, line_uri: 'tel:+441582000100' });
  await account('ra-spare@contoso.test', { account_type: 'ResourceAccount', entra_id: 'ra-2', assigned_plans: raPlan });
  await obj('auto_attendant', 'aa-1', { ApplicationInstances: ['ra-1'] });
  await obj('phone_number', '+441582000200', { NumberType: 'CallingPlan', PstnAssignmentStatus: 'Unassigned' });
  await c.s.insertInto('discovery_users').values({ site_id: site.id, upn: 'idle@contoso.test' } as never).execute();
});

describe('licenceReport', () => {
  it('finds leavers, idle licences, unattached resource accounts and spare numbers', async () => {
    const { findings } = await svc.licenceReport(c.t);
    const of = (k: string) => findings.find((f) => f.key === k)!;
    expect(of('leaver_phone_licence').items.map((i) => i.upn)).toEqual(['leaver@contoso.test']);
    expect(of('licensed_not_calling').items).toMatchObject([{ upn: 'idle@contoso.test', site: 'LTN01' }]);
    expect(of('licensed_not_calling').bySite).toEqual([{ site: 'LTN01', count: 1 }]);
    expect(of('resource_account_unused').items.map((i) => i.upn)).toEqual(['ra-spare@contoso.test']);
    expect(of('unassigned_numbers').items).toMatchObject([{ name: '+441582000200', detail: 'CallingPlan' }]);
    expect(of('resource_account_no_licence').items).toEqual([]);
  });
});
