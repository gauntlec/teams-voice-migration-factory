// Design & Build bulk delete (bug report "No Bulk delete in Design and Build"): the ticked rows, or every row of a kind on one
// site, each removed exactly as a single delete would remove it, and nothing removed when one row cannot go.
import { beforeAll, describe, expect, it } from 'vitest';
import { AuditService } from '../../../../apps/api/src/common/audit.service';
import { BuildService } from '../../../../apps/api/src/modules/build/build.service';
import { BuildValidationService } from '../../../../apps/api/src/modules/build/build-validation.service';
import { DataCollectionService } from '../../../../apps/api/src/modules/data-collection/data-collection.service';
import { TelephonyService } from '../../../../apps/api/src/modules/data-collection/data-collection.telephony.service';
import { TenantDiscoveryService } from '../../../../apps/api/src/modules/tenant-discovery/tenant-discovery.service';
import { seedCustomer, seedNumbers, seedSite, seedUser, unused, useDb, type TestCustomer } from '../helpers';

const handle = useDb();
let c: TestCustomer;
let build: BuildService;
let engineer: Awaited<ReturnType<typeof seedUser>>;
let siteA: string;
let siteB: string;

beforeAll(async () => {
  c = await seedCustomer(handle);
  engineer = await seedUser(handle, 'ENGINEER');
  siteA = (await seedSite(c.s, { sitecode: 'BDA01' })).id;
  siteB = (await seedSite(c.s, { sitecode: 'BDB01' })).id;
  const audit = new AuditService(handle.db);
  const dc = new DataCollectionService(handle.db, audit);
  const discovery = new TenantDiscoveryService(handle.db, unused('queue'), audit, unused('deployments'), dc, new TelephonyService(handle.db, audit, dc));
  build = new BuildService(handle.db, audit, new BuildValidationService(handle.db), discovery, unused('documentBuilder'), unused('files'));
});

const user = (site: string, upn: string) =>
  c.s.insertInto('build_users').values({ site_id: site, upn } as never).returning('id').executeTakeFirstOrThrow().then((r) => r.id);
const upns = async (site: string) => (await c.s.selectFrom('build_users').select('upn').where('site_id', '=', site).orderBy('upn').execute()).map((r) => r.upn);

describe('Design & Build bulk delete', () => {
  it('deletes the ticked users and frees their numbers', async () => {
    const [n] = await seedNumbers(c.s, 'BDA01', ['+442070000901']);
    const a = await user(siteA, 'a@contoso.test');
    const b = await user(siteA, 'b@contoso.test');
    await user(siteA, 'keep@contoso.test');
    await c.s.updateTable('phone_numbers').set({ status: 'assigned', holder_type: 'user', holder_id: a }).where('id', '=', n!.id).execute();
    expect(await build.bulkDelete(c.t, engineer, 'users', { ids: [a, b] })).toEqual({ deleted: 2 });
    expect(await upns(siteA)).toEqual(['keep@contoso.test']);
    const num = await c.s.selectFrom('phone_numbers').select(['status', 'holder_id']).where('id', '=', n!.id).executeTakeFirstOrThrow();
    expect(num).toEqual({ status: 'available', holder_id: null });
  });

  it('deletes every row of a kind on one site only', async () => {
    await user(siteB, 'other@contoso.test');
    await build.bulkDelete(c.t, engineer, 'users', { site_id: siteA, all: true });
    expect(await upns(siteA)).toEqual([]);
    expect(await upns(siteB)).toEqual(['other@contoso.test']);
  });

  it('takes deleted resource accounts off their call queues', async () => {
    const ra = (await c.s.insertInto('build_resource_accounts').values({ site_id: siteA, upn: 'ra-cq@contoso.test', display_name: 'RA CQ', kind: 'call_queue' } as never).returning('id').executeTakeFirstOrThrow()).id;
    const cq = (await c.s.insertInto('build_call_queues').values({ site_id: siteA, name: 'Sales', resource_accounts: JSON.stringify([ra]) } as never).returning('id').executeTakeFirstOrThrow()).id;
    await build.bulkDelete(c.t, engineer, 'resource-accounts', { ids: [ra] });
    const row = await c.s.selectFrom('build_call_queues').select('resource_accounts').where('id', '=', cq).executeTakeFirstOrThrow();
    expect(row.resource_accounts).toEqual([]);
  });

  it('removes nothing when a row is not found', async () => {
    const a = await user(siteA, 'stay@contoso.test');
    await expect(build.bulkDelete(c.t, engineer, 'users', { ids: [a, '00000000-0000-4000-8000-000000000000'] })).rejects.toThrow(/not found/);
    expect(await upns(siteA)).toEqual(['stay@contoso.test']);
  });
});
