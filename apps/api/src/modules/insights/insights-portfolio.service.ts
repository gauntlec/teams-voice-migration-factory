import { Injectable, Logger } from '@nestjs/common';
import { platformDb } from '@tvmf/db';
import { isGlobalRole, utcDay, type PortfolioData, type PortfolioRow } from '@tvmf/shared';
import type { AuthedUser, TenantContext } from '../../common/request';
import { InjectDb, type Db } from '../../db/db.module';
import { InsightsService } from './insights.service';

/** How many customers are worked out at once, so a large portfolio doesn't swamp the database. */
const PARALLEL = 4;
/** The same person asking again within this long gets the figures already worked out. */
const CACHE_MS = 60_000;
const DAY_MS = 86_400_000;

/**
 * The All customers view and Portfolio report (docs/INSIGHTS.md, step 5): one row per customer the person can open - every
 * active customer for a Super Admin, the customers they are a member of for other staff - each from the same figures as
 * that customer's Overview (InsightsService.metrics), as that person.
 */
@Injectable()
export class InsightsPortfolioService {
  private readonly log = new Logger('InsightsPortfolio');
  private readonly cache = new Map<string, { at: number; data: PortfolioData }>();

  constructor(
    @InjectDb() private readonly db: Db,
    private readonly insights: InsightsService,
  ) {}

  async portfolio(user: AuthedUser, now = new Date()): Promise<PortfolioData> {
    const hit = this.cache.get(user.id);
    if (hit && now.getTime() - hit.at < CACHE_MS) return hit.data;

    const p = platformDb(this.db);
    let q = p
      .selectFrom('tenants as t')
      .leftJoin('msps as m', 'm.id', 't.msp_id')
      .select(['t.id as id', 't.slug as slug', 't.name as name', 't.schema_name as schema', 't.teams_read_only as ro', 't.managed_services_enabled as ms', 't.monitoring_enabled as mon', 'm.name as mspName'])
      .where('t.status', '=', 'active')
      .orderBy('t.name');
    const scopes = new Map<string, string[] | null>();
    if (!isGlobalRole(user.role)) {
      const mine = await p.selectFrom('tenant_memberships').select(['tenant_id', 'site_ids']).where('user_id', '=', user.id).execute();
      for (const m of mine) scopes.set(m.tenant_id, Array.isArray(m.site_ids) && m.site_ids.length ? (m.site_ids as string[]) : null);
      if (!scopes.size) return { asOf: now.toISOString(), rows: [] };
      q = q.where('t.id', 'in', [...scopes.keys()]);
    }
    const tenants = await q.execute();
    const today = utcDay(now);
    const monthAgo = utcDay(new Date(now.getTime() - 30 * DAY_MS));

    const rows: PortfolioRow[] = [];
    for (let i = 0; i < tenants.length; i += PARALLEL) {
      rows.push(
        ...(await Promise.all(
          tenants.slice(i, i + PARALLEL).map(async (r): Promise<PortfolioRow> => {
            const t: TenantContext = {
              id: r.id,
              slug: r.slug,
              name: r.name,
              schema: r.schema,
              siteScope: scopes.get(r.id) ?? null,
              teamsReadOnly: !!r.ro,
              managedServices: !!r.ms,
              monitoringEnabled: !!r.mon,
            };
            try {
              const [m, history] = await Promise.all([this.insights.metrics(t, user.role, {}, now), this.insights.history(t, { from: monthAgo, to: today }, now)]);
              const g = m.migration;
              const base = history.find((h) => h.day < today) ?? null;
              const row: PortfolioRow = {
                tenantId: r.id,
                name: r.name,
                mspName: r.mspName,
                status: g.status,
                mode: g.sites > 0 && g.sitesInService === g.sites ? 'operations' : 'migration',
                sites: g.sites,
                sitesLive: g.sitesLive,
                sitesInService: g.sitesInService,
                users: g.users,
                usersLive: g.usersLive,
                usersLive30dAgo: base ? base.usersLive : null,
                atRisk: g.siteList.filter((x) => x.goLive.status === 'at_risk' || x.goLive.status === 'off_track').length,
                nextGoLive: g.nextGoLive ? { sitecode: g.nextGoLive.sitecode, date: g.nextGoLive.date } : null,
              };
              if (m.incidents) row.incidents = { open: m.incidents.open, openP1: m.incidents.openP1, openP2: m.incidents.openP2, targetsMetPct: m.incidents.targetsMetPct, targetsMeasured: m.incidents.targetsMeasured };
              if (m.serviceRequests) row.openServiceRequests = m.serviceRequests.open;
              return row;
            } catch (e) {
              // One customer that can't be read doesn't hide the rest.
              this.log.warn(`${r.slug}: ${(e as Error).message}`);
              return {
                tenantId: r.id, name: r.name, mspName: r.mspName, status: 'no_sites', mode: 'migration', sites: 0, sitesLive: 0, sitesInService: 0,
                users: 0, usersLive: 0, usersLive30dAgo: null, atRisk: 0, nextGoLive: null, error: 'The figures could not be worked out just now.',
              };
            }
          }),
        )),
      );
    }
    const data = { asOf: now.toISOString(), rows };
    this.cache.set(user.id, { at: now.getTime(), data });
    if (this.cache.size > 500) this.cache.clear();
    return data;
  }
}
