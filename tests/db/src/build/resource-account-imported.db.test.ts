// Bug report "Design and Build - Resource Account" (11 Nov 2026): a resource account brought in from Site Data showed as "designed"
// before anyone had looked at it. It is now "imported" (designed_at null) until an engineer edits it or confirms nothing needs changing.
import { beforeAll, describe, expect, it } from 'vitest';
import { AuditService } from '../../../../apps/api/src/common/audit.service';
import { BuildService } from '../../../../apps/api/src/modules/build/build.service';
import { BuildValidationService } from '../../../../apps/api/src/modules/build/build-validation.service';
import { DataCollectionService } from '../../../../apps/api/src/modules/data-collection/data-collection.service';
import { TelephonyService } from '../../../../apps/api/src/modules/data-collection/data-collection.telephony.service';
import { TenantDiscoveryService } from '../../../../apps/api/src/modules/tenant-discovery/tenant-discovery.service';
import { seedCustomer, seedSite, seedUser, unused, useDb } from '../helpers';

const handle = useDb();
let tel: TelephonyService;
let build: BuildService;

beforeAll(() => {
  const audit = new AuditService(handle.db);
  const dc = new DataCollectionService(handle.db, audit);
  tel = new TelephonyService(handle.db, audit, dc);
  const discovery = new TenantDiscoveryService(handle.db, unused('queue'), audit, unused('deployments'), dc, tel);
  build = new BuildService(handle.db, audit, new BuildValidationService(handle.db), discovery, unused('documentBuilder'), unused('files'));
});

describe('a resource account brought in from Site Data', () => {
  it('is imported until it is edited or confirmed; one made by hand is designed from the start', async () => {
    const c = await seedCustomer(handle);
    const engineer = await seedUser(handle, 'ENGINEER');
    const site = (await seedSite(c.s, { sitecode: 'GLA01' })).id;
    for (const [name, upn] of [['Main', 'aa-main@contoso.test'], ['Sales', 'cq-sales@contoso.test'], ['Support', 'cq-support@contoso.test']] as const) {
      await tel.addResourceAccount(c.t, engineer, { site_id: site, name, kind: 'auto_attendant', upn } as never, true);
    }
    await build.populateResourceAccounts(c.t, engineer, site);
    const byName = async (): Promise<Record<string, { id: string; designed_at: string | null }>> => Object.fromEntries((await c.s.selectFrom('build_resource_accounts').select(['id', 'display_name', 'designed_at']).where('site_id', '=', site).execute()).map((r) => [r.display_name, r]));
    let rows = await byName();
    expect(Object.values(rows).every((r) => r.designed_at === null)).toBe(true);

    // edited: designed
    await build.updateResourceAccount(c.t, engineer, rows.Main!.id, { display_name: 'Main Number' } as never);
    // confirmed: designed; the others stay imported
    expect(await build.confirmResourceAccounts(c.t, engineer, site, [rows.Sales!.id])).toEqual({ confirmed: 1 });
    rows = await byName();
    expect([rows['Main Number']!.designed_at, rows.Sales!.designed_at, rows.Support!.designed_at].map((d) => d !== null)).toEqual([true, true, false]);
    // confirm all: just the one left
    expect(await build.confirmResourceAccounts(c.t, engineer, site)).toEqual({ confirmed: 1 });

    const byHand = await build.createResourceAccount(c.t, engineer, { site_id: site, display_name: 'Reception', kind: 'auto_attendant', upn: 'aa-reception@contoso.test' } as never);
    expect(byHand.designed_at).not.toBeNull();
  });
});
