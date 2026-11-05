// Deleting a resource account in Design & Build removes only the Design & Build row (5 Nov 2026, Chris Rae on dev): its
// Site Data row stays, with its auto attendant, so Populate from Site Data brings the account back. Until then, a Site
// Data resource account with no comments - nearly all of them since the voice app split - was deleted with it.
import { beforeAll, describe, expect, it } from 'vitest';
import { AuditService } from '../../../../apps/api/src/common/audit.service';
import { BuildService } from '../../../../apps/api/src/modules/build/build.service';
import { BuildValidationService } from '../../../../apps/api/src/modules/build/build-validation.service';
import { DataCollectionService } from '../../../../apps/api/src/modules/data-collection/data-collection.service';
import { TelephonyService } from '../../../../apps/api/src/modules/data-collection/data-collection.telephony.service';
import { TenantDiscoveryService } from '../../../../apps/api/src/modules/tenant-discovery/tenant-discovery.service';
import { seedCustomer, seedSite, seedUser, unused, useDb, type TestCustomer } from '../helpers';

const handle = useDb();
let c: TestCustomer;
let dc: DataCollectionService;
let tel: TelephonyService;
let build: BuildService;
let engineer: Awaited<ReturnType<typeof seedUser>>;
let site: string;

beforeAll(async () => {
  c = await seedCustomer(handle);
  engineer = await seedUser(handle, 'ENGINEER');
  site = (await seedSite(c.s, { sitecode: 'GLA01' })).id;
  const audit = new AuditService(handle.db);
  dc = new DataCollectionService(handle.db, audit);
  tel = new TelephonyService(handle.db, audit, dc);
  const discovery = new TenantDiscoveryService(handle.db, unused('queue'), audit, unused('deployments'), dc, tel);
  build = new BuildService(handle.db, audit, new BuildValidationService(handle.db), discovery, unused('documentBuilder'), unused('files'));
});

describe('deleting a resource account in Design & Build', () => {
  it('keeps the Site Data row, takes the account off its auto attendant here, and Populate brings it back', async () => {
    const ra = await tel.addResourceAccount(c.t, engineer, { site_id: site, name: 'Main', kind: 'auto_attendant', upn: 'aa-main@contoso.test' } as never, true);
    await dc.addFlow(c.t, engineer, { site_id: site, kind: 'auto_attendant', name: 'Main Number', resource_account_id: ra.id } as never, true);
    await build.populateAll(c.t, engineer, site);
    const bra = await c.s.selectFrom('build_resource_accounts').select('id').where('discovery_resource_account_id', '=', ra.id).executeTakeFirstOrThrow();
    const aa = () => c.s.selectFrom('build_auto_attendants').select('resource_accounts').where('site_id', '=', site).executeTakeFirstOrThrow();
    expect((await aa()).resource_accounts).toEqual([bra.id]);

    expect(await build.deleteResourceAccount(c.t, engineer, bra.id)).toEqual({ ok: true });
    expect(await c.s.selectFrom('build_resource_accounts').select('id').where('id', '=', bra.id).executeTakeFirst()).toBeUndefined();
    expect((await aa()).resource_accounts).toEqual([]);
    // Site Data is untouched: the account, its UPN and its auto attendant
    expect(await c.s.selectFrom('discovery_resource_accounts').select(['name', 'upn', 'voice_app_id']).where('id', '=', ra.id).executeTakeFirst()).toMatchObject({ name: 'Main', upn: 'aa-main@contoso.test', voice_app_id: expect.any(String) });

    await build.populateAll(c.t, engineer, site);
    const back = await c.s.selectFrom('build_resource_accounts').select('id').where('discovery_resource_account_id', '=', ra.id).executeTakeFirstOrThrow();
    expect((await aa()).resource_accounts).toEqual([back.id]);
  });
});
