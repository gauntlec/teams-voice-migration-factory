// Device availability over a period (docs/INSIGHTS.md step 6d): the daily snapshot keeps each device's last 24 hours, and
// the Device status report averages those readings over its period. A site contact sees only their sites' devices.
import { beforeAll, describe, expect, it } from 'vitest';
import { buildDeviceReport, type MetricSnapshot } from '@tvmf/shared';
import { InsightsService } from '../../../../apps/api/src/modules/insights/insights.service';
import { seedCustomer, seedSite, unused, useDb, type TestCustomer } from '../helpers';

const handle = useDb();
let c: TestCustomer;
let svc: InsightsService;
let lon: string;

const snap = (devices: MetricSnapshot['deviceUptime']): MetricSnapshot => ({ v: 1, sites: [], ...(devices ? { deviceUptime: devices } : {}) });

beforeAll(async () => {
  c = await seedCustomer(handle);
  lon = (await seedSite(c.s, { sitecode: 'LON01' })).id;
  await seedSite(c.s, { sitecode: 'NYC01' });
  svc = new InsightsService(handle.db, unused('progress'), unused('incidents'), unused('requests'));
  await c.s
    .insertInto('metric_snapshots')
    .values([
      // before readings were kept
      { day: '2026-10-30', data: JSON.stringify(snap(undefined)) },
      { day: '2026-10-31', data: JSON.stringify(snap([{ id: 1, name: 'Lobby phone', sitecode: 'LON01', uptime24h: 1 }, { id: 2, name: 'Paging', sitecode: 'NYC01', uptime24h: 0.9 }])) },
      { day: '2026-11-01', data: JSON.stringify(snap([{ id: 1, name: 'Lobby phone', sitecode: 'LON01', uptime24h: 0.98 }, { id: 2, name: 'Paging unit', sitecode: 'NYC01', uptime24h: null }])) },
      { day: '2026-11-02', data: JSON.stringify(snap([{ id: 1, name: 'Lobby phone', sitecode: 'LON01', uptime24h: 0.99 }])) },
    ] as never)
    .execute();
});

describe('device availability over a period', () => {
  it('averages each device’s daily readings, keeps its newest name, and counts the days recorded', async () => {
    const a = await svc.deviceAvailability(c.t, { from: '2026-10-01', to: '2026-11-30' });
    expect(a).toMatchObject({ days: 3, firstDay: '2026-10-31', availabilityPct: 96.75 });
    expect(a.devices).toEqual(
      expect.arrayContaining([
        { name: 'Lobby phone', sitecode: 'LON01', availabilityPct: 99, days: 3 },
        { name: 'Paging unit', sitecode: 'NYC01', availabilityPct: 90, days: 1 },
      ]),
    );
    const doc = buildDeviceReport([], '2026-11-05', { period: { from: '2026-11-01', to: '2026-11-30' }, data: a });
    expect(doc.period).toEqual({ from: '2026-11-01', to: '2026-11-30' });
    const table = doc.sections.find((x) => x.kind === 'table' && x.title === 'Availability over the period');
    // worst first
    expect(table?.kind === 'table' && table.rows.map((r) => r[0])).toEqual(['Paging unit', 'Lobby phone']);
  });

  it('shows a site contact only their sites’ devices, and says when there are no readings yet', async () => {
    const mine = await svc.deviceAvailability({ ...c.t, siteScope: [lon] }, { from: '2026-10-01', to: '2026-11-30' });
    expect(mine.devices.map((d) => d.name)).toEqual(['Lobby phone']);
    expect(mine.availabilityPct).toBe(99);
    const none = await svc.deviceAvailability(c.t, { from: '2026-01-01', to: '2026-01-31' });
    expect(none).toMatchObject({ days: 0, devices: [], availabilityPct: null, firstDay: '2026-10-31' });
  });
});
