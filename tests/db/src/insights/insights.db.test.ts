// Voxshift Insights (docs/INSIGHTS.md): the shared figures read the right rows, a site's go-live date is its overview's
// Target go-live field (with the date first agreed kept as it moves), and the daily snapshot is taken once a day and read
// back as history.
// The go-live rules themselves are unit-tested in packages/shared/src/insights.test.ts.
import { beforeAll, describe, expect, it } from 'vitest';
import { AuditService } from '../../../../apps/api/src/common/audit.service';
import { BuildService } from '../../../../apps/api/src/modules/build/build.service';
import { BuildValidationService } from '../../../../apps/api/src/modules/build/build-validation.service';
import { DataCollectionService } from '../../../../apps/api/src/modules/data-collection/data-collection.service';
import { IncidentReportService } from '../../../../apps/api/src/modules/incidents/incident-report.service';
import { InsightsService } from '../../../../apps/api/src/modules/insights/insights.service';
import { ProgressService } from '../../../../apps/api/src/modules/progress/progress.service';
import { seedCustomer, seedSite, seedUser, unused, useDb, type TestCustomer } from '../helpers';

const handle = useDb();
let c: TestCustomer;
let insights: InsightsService;
let dc: DataCollectionService;
let engineer: Awaited<ReturnType<typeof seedUser>>;
let lon: string, nyc: string;
const now = new Date('2026-11-05T09:00:00Z');

beforeAll(async () => {
  c = await seedCustomer(handle, { managedServices: true });
  engineer = await seedUser(handle, 'ENGINEER');
  lon = (await seedSite(c.s, { sitecode: 'LON01' })).id;
  nyc = (await seedSite(c.s, { sitecode: 'NYC01' })).id;
  const audit = new AuditService(handle.db);
  const build = new BuildService(handle.db, audit, new BuildValidationService(handle.db), unused('discovery'), unused('documentBuilder'), unused('files'));
  const requests = {
    report: async () => ({ raised: 4, deployed: 3, completedBy: { assistants: 1, people: 2 }, openBacklog: { total: 2 }, medianHoursToDeploy: 20.5, resolutionMetPct: 100 }),
  };
  insights = new InsightsService(handle.db, new ProgressService(handle.db, build), new IncidentReportService(handle.db), requests as never);
  dc = new DataCollectionService(handle.db, audit);

  // LON01: Site Data submitted, 2 users designed on 1 Nov, 3 numbers, live since a clean run on 3 Nov.
  // NYC01: 3 users captured, Site Data not submitted, nothing designed.
  await c.s.updateTable('discovery_sites').set({ review_status: 'submitted' }).where('id', '=', lon).execute();
  await c.s
    .insertInto('build_users')
    .values([{ site_id: lon, upn: 'a@contoso.test', updated_at: '2026-11-01T09:00:00Z' }, { site_id: lon, upn: 'b@contoso.test', updated_at: '2026-11-01T09:00:00Z' }] as never)
    .execute();
  await c.s
    .insertInto('discovery_users')
    .values([{ upn: 'c@contoso.test', site_id: nyc }, { upn: 'd@contoso.test', site_id: nyc }, { upn: 'e@contoso.test', site_id: nyc, handset_model: 'Poly CCX 400', handset_installed_at: '2026-11-04T09:00:00Z' }] as never)
    .execute();
  // a common area phone at LON01, not installed yet: with e@ above, 2 handsets and 1 installed
  await c.s.insertInto('discovery_caps').values({ site_id: lon, display_name: 'Reception', device_model: 'Poly CCX 400' } as never).execute();
  const range = await c.s
    .insertInto('discovery_number_ranges')
    .values({ sitecode: 'LON01', range_start: '+442070000000', range_end: '+442070000002', kind: 'new' } as never)
    .returning('id')
    .executeTakeFirstOrThrow();
  await c.s
    .insertInto('phone_numbers')
    .values(['+442070000000', '+442070000001', '+442070000002'].map((e164) => ({ range_id: range.id, e164 })) as never)
    .execute();
  const run = (mode: string, day: string) => ({ mode, status: 'completed', scope: JSON.stringify({ siteId: lon }), summary: JSON.stringify({ failed: 0 }), created_by: engineer.id, created_at: day });
  const [, live] = await c.s
    .insertInto('deployments')
    .values([run('dry_run', '2026-11-02T09:00:00Z'), run('execute', '2026-11-03T09:00:00Z')] as never)
    .returning('id')
    .execute();
  const change = (seq: number, result: string) => ({ deployment_id: live!.id, seq, at: '2026-11-03T09:05:00Z', correlation_id: 'x', object_type: 'user', cmdlet: 'Set-CsPhoneNumberAssignment', result });
  await c.s.insertInto('deployment_changes').values([change(1, 'applied'), change(2, 'applied'), change(3, 'applied'), change(4, 'failed')] as never).execute();
});

describe('site go-live dates', () => {
  const setDate = (siteId: string, targetGoLive: string) => dc.updateSiteOverview(c.t, engineer, siteId, { targetGoLive }, true);

  it('reads the overview’s Target go-live, keeping the first agreed date as it moves', async () => {
    expect(await insights.goLive(c.t, nyc)).toMatchObject({ targetGoLive: null, firstGoLive: null });
    await setDate(nyc, '2026-11-19');
    expect(await insights.goLive(c.t, nyc)).toMatchObject({ targetGoLive: '2026-11-19', firstGoLive: '2026-11-19' });
    await setDate(nyc, '2026-12-03');
    expect(await insights.goLive(c.t, nyc)).toMatchObject({ targetGoLive: '2026-12-03', firstGoLive: '2026-11-19' });
    // Saving other overview fields leaves it alone.
    await dc.updateSiteOverview(c.t, engineer, nyc, { notes: 'Carrier port date moved' }, true);
    expect(await insights.goLive(c.t, nyc)).toMatchObject({ targetGoLive: '2026-12-03', firstGoLive: '2026-11-19' });

    // Clearing the date clears the first one too; free text from an older site counts as no date.
    await setDate(lon, '2026-11-01');
    await setDate(lon, '');
    expect(await insights.goLive(c.t, lon)).toMatchObject({ targetGoLive: null, firstGoLive: null });
    await setDate(lon, 'Q4 2026');
    expect(await insights.goLive(c.t, lon)).toMatchObject({ targetGoLive: null, firstGoLive: null });
    await setDate(lon, '2026-11-01');
  });

  it('refuses a site outside a site contact’s sites', async () => {
    await expect(insights.goLive({ ...c.t, siteScope: [lon] }, nyc)).rejects.toThrow();
  });
});

describe('metrics', () => {
  it('adds up the sites, users, numbers, changes and go-live status for an engineer', async () => {
    const m = await insights.metrics(c.t, 'ENGINEER', {}, now);
    expect(m.fullView).toBe(true);
    expect(m.period).toEqual({ from: '2026-10-07T00:00:00.000Z', to: '2026-11-06T00:00:00.000Z' });
    const { siteList, ...migration } = m.migration;
    expect(migration).toEqual({
      status: 'at_risk',
      sites: 2,
      sitesLive: 1,
      sitesInService: 0,
      sitesByStage: { handover: 1, data_collection: 1 },
      users: 5,
      usersLive: 2,
      numbers: 3,
      numbersLive: 3,
      ports: { requests: 0, complete: 0 },
      handsets: { total: 2, installed: 1 },
      nextGoLive: { siteId: nyc, sitecode: 'NYC01', date: '2026-12-03' },
      programmeEnd: '2026-12-03',
    });
    const [l, n] = siteList;
    // LON01's date has passed, but it is live.
    expect(l).toMatchObject({ sitecode: 'LON01', live: true, users: 2, targetGoLive: '2026-11-01', goLive: { status: 'live' }, handsets: { total: 1, installed: 0 } });
    // NYC01: Site Data unfinished 28 days before go-live.
    expect(n).toMatchObject({ sitecode: 'NYC01', live: false, users: 3, firstGoLive: '2026-11-19', goLive: { status: 'at_risk', daysLeft: 28 }, handsets: { total: 1, installed: 1 } });
    expect(m.changes).toEqual({ applied: 3, failed: 1, skipped: 0, firstTimePct: 75 });
    expect(m.incidents).toMatchObject({ raised: 0, open: 0, openP1: 0, targetsMetPct: null });
    expect(m.serviceRequests).toEqual({ raised: 4, completed: 3, completedByAssistants: 1, open: 2, medianHoursToComplete: 20.5, targetsMetPct: 100 });
    expect(m.devices).toBeUndefined();
  });

  it('folds the delivery stages for a project manager, and gives a site contact their own sites only', async () => {
    // NYC01 designed for a moment: an engineer sees "Designed", a project manager "Design & deployment".
    await c.s.updateTable('discovery_sites').set({ review_status: 'submitted' }).where('id', '=', nyc).execute();
    const q = await c.s.insertInto('build_call_queues').values({ site_id: nyc, name: 'Reception' } as never).returning('id').executeTakeFirstOrThrow();
    try {
      expect((await insights.metrics(c.t, 'ENGINEER', {}, now)).migration.sitesByStage).toEqual({ handover: 1, dry_run: 1 });
      const pm = await insights.metrics(c.t, 'PROJECT_MANAGER', {}, now);
      expect(pm.fullView).toBe(false);
      expect(pm.migration.sitesByStage).toEqual({ handover: 1, delivery: 1 });
      expect(pm.migration.siteList[0]!.goLive.status).toBe('live');
    } finally {
      await c.s.deleteFrom('build_call_queues').where('id', '=', q.id).execute();
      await c.s.updateTable('discovery_sites').set({ review_status: 'draft' }).where('id', '=', nyc).execute();
    }

    const contact = await insights.metrics({ ...c.t, siteScope: [nyc] }, 'CUSTOMER', {}, now);
    expect(contact.migration.siteList.map((x) => x.sitecode)).toEqual(['NYC01']);
    expect(contact.changes.applied).toBe(0);
  });
});

describe('daily snapshots', () => {
  it('takes one snapshot a day and reads it back as history', async () => {
    expect(await insights.takeSnapshot(c.t, now)).toBe(true);
    expect(await insights.takeSnapshot(c.t, new Date('2026-11-05T22:00:00Z'))).toBe(false);
    expect(await insights.takeSnapshot(c.t, new Date('2026-11-06T00:30:00Z'))).toBe(true);
    const h = await insights.history(c.t, { from: '2026-11-01', to: '2026-11-06' });
    expect(h.map((p) => p.day)).toEqual(['2026-11-05', '2026-11-06']);
    expect(h[0]).toEqual({ day: '2026-11-05', sites: 2, sitesLive: 1, sitesInService: 0, users: 5, usersLive: 2, numbers: 3, numbersLive: 3, openIncidents: 0, openServiceRequests: 2 });

    const mine = await insights.history({ ...c.t, siteScope: [nyc] }, { from: '2026-11-05', to: '2026-11-05' });
    expect(mine).toEqual([{ day: '2026-11-05', sites: 1, sitesLive: 0, sitesInService: 0, users: 3, usersLive: 0, numbers: 0, numbersLive: 0 }]);
  });

  it('removes snapshots older than two years', async () => {
    await c.s.insertInto('metric_snapshots').values({ day: '2024-11-01', data: JSON.stringify({ v: 1, sites: [] }) as never }).execute();
    await insights.takeSnapshot(c.t, new Date('2026-11-06T05:00:00Z'));
    const old = await c.s.selectFrom('metric_snapshots').select('day').where('day', '<', '2025-01-01').execute();
    expect(old).toEqual([]);
  });
});

describe('change log', () => {
  it('lists the live runs’ changes in the period, newest first, with the site and who ran them', async () => {
    const log = await insights.changeLog(c.t, 'PROJECT_MANAGER', { from: '2026-11-01', to: '2026-11-05' }, now);
    expect(log.truncated).toBe(false);
    expect(log.rows.map((r) => r.result)).toEqual(['failed', 'applied', 'applied', 'applied']);
    expect(log.rows[0]).toMatchObject({ sitecode: 'LON01', objectType: 'user', cmdlet: 'Set-CsPhoneNumberAssignment', operator: 'ENGINEER' });
    expect((await insights.changeLog(c.t, 'ENGINEER', { from: '2026-10-01', to: '2026-10-31' }, now)).rows).toEqual([]);
    expect((await insights.changeLog({ ...c.t, siteScope: [nyc] }, 'CUSTOMER', { from: '2026-11-01', to: '2026-11-05' }, now)).rows).toEqual([]);
  });
});
