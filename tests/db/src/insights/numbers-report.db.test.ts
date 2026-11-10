// The Number management report's data: every range and number in Site Data with its site and country, each number's
// status, and who has the assigned ones (Teams's holder when Discovery has seen one, else the Site Data holder).
import { beforeAll, describe, expect, it } from 'vitest';
import { AuditService } from '../../../../apps/api/src/common/audit.service';
import { BuildService } from '../../../../apps/api/src/modules/build/build.service';
import { BuildValidationService } from '../../../../apps/api/src/modules/build/build-validation.service';
import { IncidentReportService } from '../../../../apps/api/src/modules/incidents/incident-report.service';
import { InsightsService } from '../../../../apps/api/src/modules/insights/insights.service';
import { ProgressService } from '../../../../apps/api/src/modules/progress/progress.service';
import { seedCustomer, seedNumbers, seedSite, unused, useDb, type TestCustomer } from '../helpers';

const handle = useDb();
let c: TestCustomer;
let insights: InsightsService;
let lon: string;

beforeAll(async () => {
  c = await seedCustomer(handle);
  lon = (await seedSite(c.s, { sitecode: 'LON01' })).id;
  await seedSite(c.s, { sitecode: 'NYC01' });
  await c.s.updateTable('discovery_sites').set({ name: 'London', country: 'GB' }).where('id', '=', lon).execute();
  const audit = new AuditService(handle.db);
  const build = new BuildService(handle.db, audit, new BuildValidationService(handle.db), unused('discovery'), unused('documentBuilder'), unused('files'));
  insights = new InsightsService(handle.db, new ProgressService(handle.db, build), new IncidentReportService(handle.db), unused('requests'));

  const [n0, n1, n2, n3] = await seedNumbers(c.s, 'LON01', ['+442070000200', '+442070000201', '+442070000202', '+442070000203']);
  await seedNumbers(c.s, 'NYC01', ['+12125550100']);
  // n0: Site Data gives it to Jo; n1: Teams has it on Sam; n2 parked; n3 spare
  const jo = await c.s.insertInto('discovery_users').values({ upn: 'jo@contoso.test', display_name: 'Jo Bloggs', site_id: lon } as never).returning('id').executeTakeFirstOrThrow();
  await c.s.updateTable('phone_numbers').set({ holder_type: 'user', holder_id: jo.id, status: 'assigned' }).where('id', '=', n0!.id).execute();
  await c.s.updateTable('phone_numbers').set({ live_holder_upn: 'sam@contoso.test', live_holder_name: 'Sam Smith', live_holder_kind: 'user', live_only: true, status: 'assigned' }).where('id', '=', n1!.id).execute();
  await c.s.updateTable('phone_numbers').set({ status: 'parked', parked_at: '2026-11-01T00:00:00Z' }).where('id', '=', n2!.id).execute();
  void n3;
});

describe('Number management report data', () => {
  it('lists the ranges and numbers, with each number’s status and holder', async () => {
    const d = await insights.numbers(c.t);
    expect(d.ranges.map((r) => [r.sitecode, r.start, r.end, r.size, r.siteName, r.country])).toEqual([
      ['LON01', '+442070000200', '+442070000203', 4, 'London', 'GB'],
      ['NYC01', '+12125550100', '+12125550100', 1, 'NYC01', null],
    ]);
    const byNumber = Object.fromEntries(d.numbers.map((n) => [n.e164, n]));
    expect(byNumber['+442070000200']).toMatchObject({ status: 'Assigned', upn: 'jo@contoso.test', name: 'Jo Bloggs', holderType: 'user', sitecode: 'LON01', country: 'GB' });
    expect(byNumber['+442070000201']).toMatchObject({ status: 'Assigned', upn: 'sam@contoso.test', name: 'Sam Smith', holderType: 'user' });
    expect(byNumber['+442070000202']).toMatchObject({ status: 'Parked', upn: null });
    expect(byNumber['+442070000203']).toMatchObject({ status: 'Spare', upn: null });
    expect(d.truncated).toBe(false);
  });

  it('shows someone limited to sites only their sites’ ranges and numbers', async () => {
    const d = await insights.numbers({ ...c.t, siteScope: [lon] });
    expect(d.ranges.map((r) => r.sitecode)).toEqual(['LON01']);
    expect(d.numbers.every((n) => n.sitecode === 'LON01')).toBe(true);
    expect(d.numbers).toHaveLength(4);
  });
});
