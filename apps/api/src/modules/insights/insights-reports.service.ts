import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { deviceStatusOverview, tenantDb } from '@tvmf/db';
import {
  REPORT_KEYS,
  SR_TYPE_DEFS,
  buildAssistantReport,
  buildChangeLogReport,
  buildDeviceReport,
  buildExecutiveSummary,
  buildIncidentReport,
  buildMigrationReport,
  buildNumberReport,
  buildServiceRequestReport,
  can,
  previousReportPeriod,
  reportAvailableFor,
  reportPeriodQuery,
  reportQueryPeriod,
  utcDay,
  type IncidentReportData,
  type ReportDocument,
  type ReportKey,
  type ReportQuery,
  type Role,
  type ServiceRequestReportData,
} from '@tvmf/shared';
import type { TenantContext } from '../../common/request';
import { InjectDb, type Db } from '../../db/db.module';
import { isSiteScoped, narrowToSite } from '../data-collection/site-scope';
import { IncidentReportService } from '../incidents/incident-report.service';
import { ServiceRequestsService } from '../service-requests/service-requests.service';
import { InsightsAssistantsService } from './insights-assistants.service';
import { InsightsService } from './insights.service';

/**
 * Builds any report on the server (for its PDF now, and scheduled emails next), from the same shared builders and the same
 * data the Reports page reads - so a downloaded PDF says exactly what the page says. See docs/INSIGHTS.md.
 */
@Injectable()
export class InsightsReportsService {
  constructor(
    @InjectDb() private readonly db: Db,
    private readonly insights: InsightsService,
    private readonly incidents: IncidentReportService,
    private readonly requests: ServiceRequestsService,
    private readonly assistants: InsightsAssistantsService,
  ) {}

  async build(t: TenantContext, role: Role, key: string, q: ReportQuery, now = new Date()): Promise<ReportDocument> {
    if (!(REPORT_KEYS as readonly string[]).includes(key)) throw new NotFoundException('No such report.');
    const k = key as ReportKey;
    const allowed = (p: Parameters<typeof can>[1]) => can(role, p);
    if (!reportAvailableFor(k, allowed, { managedServices: t.managedServices, monitoring: !!t.monitoringEnabled })) {
      throw new ForbiddenException('This report isn’t available for this customer, or for your role.');
    }
    const doc = await this.buildFor(narrowToSite(t, q.site), role, k, q, now);
    if (!q.site) return doc;
    const site = await tenantDb(this.db, t.schema).selectFrom('discovery_sites').select(['sitecode', 'name']).where('id', '=', q.site).executeTakeFirst();
    if (!site) throw new NotFoundException('No such site.');
    return { ...doc, site: [site.sitecode, site.name].filter(Boolean).join(' ') };
  }

  private async buildFor(t: TenantContext, role: Role, k: ReportKey, q: ReportQuery, now: Date): Promise<ReportDocument> {
    const today = utcDay(now);
    const { period } = reportQueryPeriod(q, today);
    const prev = previousReportPeriod(period);
    const compare = q.compare !== '0';
    const iso = reportPeriodQuery(period);
    const prevIso = reportPeriodQuery(prev);
    switch (k) {
      case 'executive': {
        const [metrics, previous, history] = await Promise.all([
          this.insights.metrics(t, role, period, now),
          this.insights.metrics(t, role, prev, now),
          this.insights.history(t, { from: prev.from, to: period.to }, now),
        ]);
        return buildExecutiveSummary({ metrics, previous, history, period, comparedWith: prev, today });
      }
      case 'migration': {
        const [metrics, history] = await Promise.all([this.insights.metrics(t, role, {}, now), this.insights.history(t, period, now)]);
        return buildMigrationReport(metrics, history, period);
      }
      case 'incidents': {
        const manage = can(role, 'inc:manage');
        const [cur, before] = await Promise.all([
          this.incidents.report(t, iso.from, iso.to, manage) as Promise<IncidentReportData>,
          compare ? (this.incidents.report(t, prevIso.from, prevIso.to, manage) as Promise<IncidentReportData>) : Promise.resolve(null),
        ]);
        return buildIncidentReport(cur, before, period, prev);
      }
      case 'service-requests': {
        const [cur, before] = await Promise.all([
          this.requests.report(t, iso.from, iso.to) as Promise<ServiceRequestReportData>,
          compare ? (this.requests.report(t, prevIso.from, prevIso.to) as Promise<ServiceRequestReportData>) : Promise.resolve(null),
        ]);
        return buildServiceRequestReport(cur, before, period, (x) => SR_TYPE_DEFS[x].label, prev);
      }
      case 'assistants': {
        const [cur, before] = await Promise.all([this.assistants.activity(t, role, iso), compare ? this.assistants.activity(t, role, prevIso) : Promise.resolve(null)]);
        return buildAssistantReport(cur, before, period, prev);
      }
      case 'numbers':
        return buildNumberReport(await this.insights.numbers(t), today);
      case 'changes':
        return buildChangeLogReport(await this.insights.changeLog(t, role, period, now), period);
      case 'devices': {
        const s = tenantDb(this.db, t.schema);
        let devices = (await deviceStatusOverview(s)).devices;
        if (isSiteScoped(t)) {
          const sites = await s.selectFrom('discovery_sites').select('sitecode').where('id', 'in', t.siteScope).execute();
          const ok = new Set(sites.map((x) => x.sitecode.toLowerCase()));
          devices = devices.filter((d) => d.sitecode !== null && ok.has(d.sitecode.toLowerCase()));
        }
        const [data, before] = await Promise.all([this.insights.deviceAvailability(t, period, now), compare ? this.insights.deviceAvailability(t, prev, now) : Promise.resolve(null)]);
        return buildDeviceReport(devices, today, { period, data, before, comparedWith: prev });
      }
    }
  }
}
