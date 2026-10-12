// Home-page progress: each site's migration stage is derived from rows that
// Data Collection, Design & Build, Deployment and Handover already write. These
// check the queries that feed deriveSiteProgress pick the right rows - the
// rules themselves are unit-tested in packages/shared/src/progress.test.ts.
import { beforeAll, describe, expect, it } from 'vitest';
import { AuditService } from '../../../../apps/api/src/common/audit.service';
import { BuildService } from '../../../../apps/api/src/modules/build/build.service';
import { BuildValidationService } from '../../../../apps/api/src/modules/build/build-validation.service';
import { ProgressService } from '../../../../apps/api/src/modules/progress/progress.service';
import { seedCustomer, seedSite, seedUser, unused, useDb, type TestCustomer } from '../helpers';

const handle = useDb();
let c: TestCustomer;
let progress: ProgressService;
let engineer: Awaited<ReturnType<typeof seedUser>>;
let customer: Awaited<ReturnType<typeof seedUser>>;
let lon: string, nyc: string, par: string;

const at = (day: number) => `2026-10-${String(day).padStart(2, '0')}T09:00:00Z`;

beforeAll(async () => {
  c = await seedCustomer(handle, { managedServices: true });
  engineer = await seedUser(handle, 'ENGINEER');
  customer = await seedUser(handle, 'CUSTOMER');
  lon = (await seedSite(c.s, { sitecode: 'LON01' })).id;
  nyc = (await seedSite(c.s, { sitecode: 'NYC01' })).id;
  par = (await seedSite(c.s, { sitecode: 'PAR01' })).id;
  const build = new BuildService(handle.db, new AuditService(handle.db), new BuildValidationService(handle.db), unused('discovery'), unused('documentBuilder'), unused('files'));
  progress = new ProgressService(handle.db, build);

  // the one discovery row is seeded by tenant migration 0001
  await c.s.updateTable('discovery').set({ status: 'submitted' }).execute();
  await c.s
    .insertInto('discovery_users')
    .values([
      { upn: 'a@contoso.test', site_id: lon },
      { upn: 'b@contoso.test', site_id: lon },
      { upn: 'c@contoso.test', site_id: nyc },
    ] as never)
    .execute();

  // LON01: designed 1 Oct, dry run 2 Oct, clean live run 3 Oct, every-site pack issued.
  // NYC01: designed, then changed 5 Oct after its 2 Oct dry run; the live run had failures,
  //        and its user fails validation (not in the synced tenant).
  // PAR01: nothing yet.
  await c.s
    .insertInto('build_users')
    .values([
      { site_id: nyc, upn: 'c@contoso.test', updated_at: at(1) },
    ] as never)
    .execute();
  await c.s
    .insertInto('build_call_queues')
    .values([
      { site_id: lon, name: 'Reception', updated_at: at(1) },
      { site_id: nyc, name: 'Reception', updated_at: at(5) },
    ] as never)
    .execute();
  const run = (siteId: string, mode: 'dry_run' | 'execute', status: string, day: number, failed = 0) => ({
    mode,
    status,
    scope: JSON.stringify({ siteId }),
    summary: JSON.stringify({ failed }),
    created_by: engineer.id,
    created_at: at(day),
  });
  await c.s
    .insertInto('deployments')
    .values([
      run(lon, 'dry_run', 'completed', 2),
      run(lon, 'execute', 'failed', 2),
      run(lon, 'execute', 'completed', 3),
      run(nyc, 'dry_run', 'completed', 2),
      run(nyc, 'execute', 'completed', 6, 3),
      run(nyc, 'dry_run', 'queued', 7),
    ] as never)
    .execute();
  await c.s
    .insertInto('handover_packs')
    .values([
      { version: 1, status: 'issued', generated_by: engineer.id, issued_at: at(4), source: JSON.stringify({ siteIds: [] }) },
      { version: 2, status: 'draft', generated_by: engineer.id, source: JSON.stringify({ siteIds: [nyc] }) },
    ] as never)
    .execute();
  await c.s.updateTable('discovery_sites').set({ mode: 'operations' }).where('id', '=', lon).execute();
  await c.s
    .insertInto('service_requests')
    .values([
      { type: 'other', title: 'New', site_id: lon, requested_by: customer.id },
      { type: 'other', title: 'Done', site_id: lon, requested_by: customer.id, status: 'deployed' },
    ] as never)
    .execute();
});

describe('GET /t/:tenantId/progress', () => {
  it('derives each site’s stage for an engineer, with blockers in plain words', async () => {
    const p = await progress.progress(c.t, engineer);
    expect(p.fullView).toBe(true);
    expect(p.discoveryStatus).toBe('submitted');
    expect(p.sites.map((s) => s.sitecode)).toEqual(['LON01', 'NYC01', 'PAR01']);
    const [l, n, x] = p.sites;

    // The later clean live run wins over the earlier failed one.
    expect(l!.complete).toBe(true);
    expect(l!.blockers).toEqual([]);
    expect(l!.stages.find((s) => s.key === 'handover')?.detail).toBe('v1 issued 4 Oct');

    expect(n!.current).toBe('validated');
    expect(n!.stages.find((s) => s.key === 'designed')?.detail).toBe('2 rows');
    expect(n!.stages.find((s) => s.key === 'dry_run')?.detail).toBe('Dry run in progress');
    expect(n!.stages.find((s) => s.key === 'handover')?.detail).toBe('Draft v2 not issued');
    expect(n!.blockers.map((b) => b.message)).toEqual(
      expect.arrayContaining(['1 row has validation issues', 'Dry run is older than the latest design change', 'Last live run had 3 failures']),
    );

    expect(x!.current).toBe('data_collection');
    expect(x!.blockers).toEqual([{ stage: 'data_collection', message: 'No users, phones or resource accounts captured yet' }]);

    expect(p.openServiceRequests).toBe(1);
    expect(p.lastDiscoverySync).toBeNull();
    expect(p.items.filter((i) => i.attention).map((i) => i.message)).toEqual([
      'Data Collection is submitted and waiting for review',
      'The customer tenant has never been synced in Discovery',
      '1 new service request waiting to be planned',
    ]);
  });

  it('a customer sees one Design & deployment stage, no engineering blockers, and no Discovery sync', async () => {
    const p = await progress.progress(c.t, customer);
    expect(p.fullView).toBe(false);
    expect(p.lastDiscoverySync).toBeUndefined();
    const n = p.sites.find((s) => s.sitecode === 'NYC01')!;
    expect(n.stages.map((s) => s.key)).toEqual(['data_collection', 'delivery', 'handover', 'operations']);
    expect(n.blockers).toEqual([]);
    expect(p.items.every((i) => !i.attention)).toBe(true);
  });

  it('a site contact only sees their own sites', async () => {
    const p = await progress.progress({ ...c.t, siteScope: [nyc] }, customer);
    expect(p.sites.map((s) => s.sitecode)).toEqual(['NYC01']);
    expect(p.openServiceRequests).toBe(0);
  });
});
