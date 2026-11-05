// The All customers view (docs/INSIGHTS.md, step 5): a Super Admin sees every active customer, other staff only the
// customers they are members of, each from that customer's own figures; and a customer that can't be read shows as such
// instead of hiding the rest.
import { beforeAll, describe, expect, it } from 'vitest';
import { platformDb } from '@tvmf/db';
import { AuditService } from '../../../../apps/api/src/common/audit.service';
import { BuildService } from '../../../../apps/api/src/modules/build/build.service';
import { BuildValidationService } from '../../../../apps/api/src/modules/build/build-validation.service';
import { IncidentReportService } from '../../../../apps/api/src/modules/incidents/incident-report.service';
import { InsightsPortfolioService } from '../../../../apps/api/src/modules/insights/insights-portfolio.service';
import { InsightsService } from '../../../../apps/api/src/modules/insights/insights.service';
import { ProgressService } from '../../../../apps/api/src/modules/progress/progress.service';
import { seedCustomer, seedSite, seedUser, unused, useDb, type TestCustomer } from '../helpers';

const handle = useDb();
let a: TestCustomer, b: TestCustomer;
let svc: InsightsPortfolioService;
const now = new Date('2026-11-05T09:00:00Z');

beforeAll(async () => {
  a = await seedCustomer(handle, { name: 'Portfolio Alpha', managedServices: true });
  b = await seedCustomer(handle, { name: 'Portfolio Beta' });
  await seedSite(a.s, { sitecode: 'LON01' });
  await seedSite(a.s, { sitecode: 'NYC01' });
  await seedSite(b.s, { sitecode: 'PAR01' });
  const audit = new AuditService(handle.db);
  const build = new BuildService(handle.db, audit, new BuildValidationService(handle.db), unused('discovery'), unused('documentBuilder'), unused('files'));
  const requests = { report: async () => ({ raised: 0, deployed: 0, completedBy: { assistants: 0, people: 0 }, openBacklog: { total: 0 }, medianHoursToDeploy: null, resolutionMetPct: null }) };
  svc = new InsightsPortfolioService(handle.db, new InsightsService(handle.db, new ProgressService(handle.db, build), new IncidentReportService(handle.db), requests as never));
});

describe('all customers', () => {
  it('shows a Super Admin every customer, and an engineer only theirs', async () => {
    const admin = await seedUser(handle, 'SUPER_ADMIN');
    const all = await svc.portfolio(admin, now);
    const mine = all.rows.filter((r) => r.name.startsWith('Portfolio '));
    expect(mine.map((r) => [r.name, r.sites, r.status])).toEqual([['Portfolio Alpha', 2, 'no_date'], ['Portfolio Beta', 1, 'no_date']]);
    expect(mine[0]!.incidents).toMatchObject({ open: 0, openP1: 0 });
    expect(mine[1]!.incidents).toBeUndefined(); // no Managed Services

    const eng = await seedUser(handle, 'ENGINEER');
    await platformDb(handle.db).insertInto('tenant_memberships').values({ tenant_id: b.t.id, user_id: eng.id } as never).execute();
    expect((await svc.portfolio(eng, now)).rows.map((r) => r.name)).toEqual(['Portfolio Beta']);
    expect((await svc.portfolio(await seedUser(handle, 'ENGINEER'), now)).rows).toEqual([]);
  });

  it('shows a customer whose figures fail as unavailable rather than failing the page', async () => {
    const admin = await seedUser(handle, 'SUPER_ADMIN');
    await platformDb(handle.db).updateTable('tenants').set({ schema_name: 'no_such_schema' }).where('id', '=', b.t.id).execute();
    try {
      const rows = (await svc.portfolio(admin, now)).rows.filter((r) => r.name.startsWith('Portfolio '));
      expect(rows.find((r) => r.name === 'Portfolio Beta')).toMatchObject({ error: expect.stringMatching(/could not be worked out/) });
      expect(rows.find((r) => r.name === 'Portfolio Alpha')!.error).toBeUndefined();
    } finally {
      await platformDb(handle.db).updateTable('tenants').set({ schema_name: b.t.schema }).where('id', '=', b.t.id).execute();
    }
  });
});
