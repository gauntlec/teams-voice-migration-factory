// Populate Shared Calling policies from Teams: the policies Discovery read (tenant_policies) become Design & Build rows on a
// site, matched by name, with the resource account linked when it is in Design & Build on the site. Rows already there are kept
// unless the engineer asks for them to be updated.
import { beforeAll, describe, expect, it } from 'vitest';
import { AuditService } from '../../../../apps/api/src/common/audit.service';
import { BuildService } from '../../../../apps/api/src/modules/build/build.service';
import { BuildValidationService } from '../../../../apps/api/src/modules/build/build-validation.service';
import { seedCustomer, seedSite, seedUser, unused, useDb, type TestCustomer } from '../helpers';

const handle = useDb();
let c: TestCustomer;
let build: BuildService;
let engineer: Awaited<ReturnType<typeof seedUser>>;
let site: string;
let raRow: string;
const RA_OBJECT = '2cd680c7-a5cc-49c7-8ed5-7eb2afb4a187';

async function livePolicy(name: string, data: Record<string, unknown>) {
  const obj = await c.s.insertInto('tenant_objects').values({ object_type: 'policy', object_key: `scp:${name}`, display_name: name, data: {} } as never).returning('id').executeTakeFirstOrThrow();
  await c.s.insertInto('tenant_policies').values({ object_id: obj.id, policy_type: 'TeamsSharedCallingRoutingPolicy', identity: `Tag:${name}`, name, data } as never).execute();
}

beforeAll(async () => {
  c = await seedCustomer(handle);
  engineer = await seedUser(handle, 'ENGINEER');
  site = (await seedSite(c.s, { sitecode: 'SCP01' })).id;
  build = new BuildService(handle.db, new AuditService(handle.db), new BuildValidationService(handle.db), unused('discovery'), unused('documentBuilder'), unused('files'));

  // Teams has Global, Wixom (resource account by object ID, which a synced account has), Camarillo (an account not on this site)
  // and Spare (nobody on the site uses it)
  await livePolicy('Global', { EmergencyNumbers: [] });
  await livePolicy('US-Wixom', { ResourceAccount: RA_OBJECT, EmergencyNumbers: ['12485550100'], Description: 'Wixom shared line' });
  await livePolicy('US-Camarillo', { ResourceAccount: 'ra-elsewhere@contoso.test', EmergencyNumbers: ['18055550100', '18055550101'] });
  await livePolicy('US-Spare', { EmergencyNumbers: [] });
  const obj = await c.s.insertInto('tenant_objects').values({ object_type: 'user', object_key: 'ra-wixom@contoso.test', display_name: 'Wixom RA', data: {} } as never).returning('id').executeTakeFirstOrThrow();
  await c.s.insertInto('tenant_users').values({ object_id: obj.id, upn: 'ra-wixom@contoso.test', display_name: 'Wixom RA', account_type: 'ResourceAccount', entra_id: RA_OBJECT, policies: {} } as never).execute();
  raRow = (await c.s.insertInto('build_resource_accounts').values({ site_id: site, display_name: 'Wixom RA', kind: 'auto_attendant', upn: 'ra-wixom@contoso.test', status: {} } as never).returning('id').executeTakeFirstOrThrow()).id;
  // a designed user on the site has Camarillo; Design & Build already has Camarillo, edited by hand
  await c.s.insertInto('build_users').values({ site_id: site, upn: 'jo@contoso.test', policies: { shared_calling_policy: 'US-Camarillo' }, policy_ids: {}, voicemail: {}, call_forwarding: {}, delegates: '[]', pickup_group: {}, validation: {}, status: {} } as never).execute();
  await c.s.insertInto('build_shared_calling_policies').values({ site_id: site, name: 'us-camarillo', emergency_numbers: JSON.stringify(['999']), description: 'edited by hand' } as never).execute();
});

describe('Populate Shared Calling policies from Teams', () => {
  it('lists the live policies (not Global) with what the site uses and what Design & Build has', async () => {
    const live = await build.liveSharedCallingPolicies(c.t, site);
    expect(live.map((p) => [p.name, p.usedOnSite, p.inDesign, p.resourceAccount, p.resourceAccountRowId])).toEqual([
      ['US-Camarillo', true, true, 'ra-elsewhere@contoso.test', null],
      ['US-Spare', false, false, null, null],
      ['US-Wixom', true, false, 'ra-wixom@contoso.test', raRow],
    ]);
  });

  it('adds the chosen ones once, links the resource account, and keeps a row edited by hand', async () => {
    const r = await build.populateSharedCallingPolicies(c.t, engineer, { site_id: site, names: ['US-Wixom', 'US-Camarillo'] });
    expect(r).toMatchObject({ created: 1, updated: 0, skipped: 1 });
    const rows = (await c.s.selectFrom('build_shared_calling_policies').selectAll().where('site_id', '=', site).execute()).sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()));
    expect(rows.map((x) => [x.name, x.resource_account_id, x.emergency_numbers, x.description])).toEqual([
      ['us-camarillo', null, ['999'], 'edited by hand'],
      ['US-Wixom', raRow, ['12485550100'], 'Wixom shared line'],
    ]);
    // again: no second row
    await build.populateSharedCallingPolicies(c.t, engineer, { site_id: site, names: ['US-Wixom'] });
    expect(await c.s.selectFrom('build_shared_calling_policies').select('id').where('site_id', '=', site).execute()).toHaveLength(2);
  });

  it('updates an existing row only when asked, and warns about a resource account not on the site', async () => {
    const r = await build.populateSharedCallingPolicies(c.t, engineer, { site_id: site, names: ['US-Camarillo', 'Nope'], updateExisting: true });
    expect(r).toMatchObject({ created: 0, updated: 1, skipped: 0 });
    expect(r.warnings).toHaveLength(2);
    expect(r.warnings).toEqual(expect.arrayContaining([
      expect.stringContaining('"Nope" isn\'t a Shared Calling policy'),
      expect.stringContaining('US-Camarillo: its resource account (ra-elsewhere@contoso.test) isn\'t in Design & Build on this site'),
    ]));
    const row = await c.s.selectFrom('build_shared_calling_policies').selectAll().where('site_id', '=', site).where('name', '=', 'us-camarillo').executeTakeFirstOrThrow();
    expect([row.emergency_numbers, row.description]).toEqual([['18055550100', '18055550101'], null]);
  });

  it('refuses a site outside the person’s sites', async () => {
    await expect(build.liveSharedCallingPolicies({ ...c.t, siteScope: ['00000000-0000-4000-8000-000000000000'] }, site)).rejects.toThrow();
  });
});
