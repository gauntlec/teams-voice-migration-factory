import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { sql } from 'kysely';
import { deviceStatusOverview, FOUND_IN_TEAMS_COMMENT, platformDb, tenantDb } from '@tvmf/db';
import {
  type NumberReportData,
  type NumberReportStatus,
  type OffSiteNumberData,
  type OffSiteNumberReason,
  can,
  customerGoLiveStatus,
  goLiveDate,
  INC_OPEN_STATUSES,
  insightsPeriod,
  MAX_SNAPSHOT_DAYS,
  siteGoLiveStatus,
  snapshotPoint,
  utcDay,
  type ChangeLogData,
  type DeviceAvailabilityData,
  type CustomerMetrics,
  type DeviceMetrics,
  type IncidentMetrics,
  type MetricHistoryPoint,
  type MetricSnapshot,
  type ProgressStageViewKey,
  type Role,
  type ServiceRequestMetrics,
  type SiteMetrics,
} from '@tvmf/shared';
import type { TenantContext } from '../../common/request';
import { InjectDb, type Db } from '../../db/db.module';
import { assertSiteInScope, isSiteScoped } from '../data-collection/site-scope';
import { IncidentReportService } from '../incidents/incident-report.service';
import { ProgressService } from '../progress/progress.service';
import { ServiceRequestsService } from '../service-requests/service-requests.service';

/** The stages a project manager or customer sees as one "Design & deployment" stage. */
const DELIVERY_STAGES: readonly ProgressStageViewKey[] = ['designed', 'validated', 'dry_run', 'deployed'];
const DAY_MS = 86_400_000;
/** Cap on the changes one Change log report reads, so a very busy period can't make it slow. */
const CHANGE_LOG_LIMIT = 5000;
/** The Number management report reads at most this many numbers (a site filter shows a big customer's numbers whole). */
const NUMBER_REPORT_LIMIT = 50000;

/** How many numbers a range holds ("+441000" to "+441099" = 100). */
function rangeSize(a: string, b: string) {
  const x = a.replace(/\D/g, '');
  const y = b.replace(/\D/g, '');
  if (!x || !y) return 1;
  const n = BigInt(y) - BigInt(x) + 1n;
  return n > 0n ? Number(n) : 1;
}

/** Why a range with no site has none: a Discovery sync made it for numbers Teams has in none of the customer's ranges, or a person left it without one. */
function offSiteReason(comments: string | null): OffSiteNumberReason {
  return comments?.startsWith(FOUND_IN_TEAMS_COMMENT.replace(/%$/, '')) ? 'found_in_teams' : 'no_site';
}

/** A number's status and holder, as both number reports show them: Teams's holder when Discovery has seen one, else Site Data's. */
function numberReportRow(r: { e164: string; status: string; holderType: string | null; liveUpn: string | null; liveName: string | null; liveKind: string | null; note: string | null; designUpn: string | null; designName: string | null }) {
  const live = !!r.liveUpn;
  const status: NumberReportStatus = live || r.holderType || r.status === 'assigned' ? 'Assigned' : r.status === 'parked' ? 'Parked' : r.status === 'reserved' ? 'Reserved' : 'Spare';
  return {
    e164: r.e164,
    status,
    upn: live ? r.liveUpn : r.designUpn,
    name: live ? r.liveName : (r.designName ?? (r.holderType === 'analogue' ? r.note : null)),
    holderType: live ? (r.liveKind === 'resource_account' ? 'resource_account' : r.liveKind === 'user' ? (r.holderType === 'cap' ? 'cap' : 'user') : 'other') : r.holderType,
  };
}
const pct = (part: number, whole: number) => (whole === 0 ? null : Math.round((part / whole) * 1000) / 10);

/**
 * Voxshift Insights (docs/INSIGHTS.md): one set of figures for a customer, shared by the Overview home page and the
 * Reports area. It reads what the other modules already store - the home-page progress rules, the incident and service
 * request reports, Monitoring, deployment changes - and adds only the site go-live dates and the daily snapshots.
 */
@Injectable()
export class InsightsService {
  constructor(
    @InjectDb() private readonly db: Db,
    private readonly progress: ProgressService,
    private readonly incidents: IncidentReportService,
    private readonly requests: ServiceRequestsService,
  ) {}

  /**
   * The figures as `role` may see them: Design & Build and Deployment stages fold into one for roles that can't open them,
   * and incidents, service requests and devices are left out where the role can't see them or the customer hasn't
   * switched them on. The go-live status is always worked out from the full stages.
   */
  async metrics(t: TenantContext, role: Role, q: { from?: string; to?: string } = {}, now = new Date()): Promise<CustomerMetrics> {
    const period = insightsPeriod(q, now);
    const fullView = can(role, 'build:read') && can(role, 'deployment:read');
    const s = tenantDb(this.db, t.schema);
    const today = utcDay(now);

    // Full view regardless of the caller, so the go-live rules see every stage; what the caller is shown is cut down below.
    const progress = await this.progress.progress(t, { role: 'SUPER_ADMIN' });
    const siteIds = progress.sites.map((x) => x.id);

    const [dates, built, captured, numbers, ports, changes] = await Promise.all([
      siteIds.length
        ? s
            .selectFrom('discovery_sites')
            .select(['id', sql<string | null>`overview->>'targetGoLive'`.as('target'), sql<string | null>`to_char(first_go_live, 'YYYY-MM-DD')`.as('first')])
            .where('id', 'in', siteIds)
            .execute()
        : [],
      this.countBySite(t, 'build_users', siteIds),
      this.countBySite(t, 'discovery_users', siteIds),
      siteIds.length
        ? s
            .selectFrom('phone_numbers as pn')
            .innerJoin('discovery_number_ranges as r', 'r.id', 'pn.range_id')
            .innerJoin('discovery_sites as ds', 'ds.sitecode', 'r.sitecode')
            .select(['ds.id as site_id', (eb) => eb.fn.countAll<string>().as('n')])
            .where('ds.id', 'in', siteIds)
            .groupBy('ds.id')
            .execute()
        : [],
      siteIds.length
        ? s
            .selectFrom('number_port_requests as p')
            .innerJoin('discovery_number_ranges as r', 'r.id', 'p.range_id')
            .innerJoin('discovery_sites as ds', 'ds.sitecode', 'r.sitecode')
            .select(['p.status as status'])
            .where('ds.id', 'in', siteIds)
            .execute()
        : [],
      this.changes(t, period),
    ]);
    const handsetsOf = await this.handsetsBySite(t, siteIds);
    // The overview's Target go-live field; free text from older sites counts as no date.
    const dateOf = new Map(dates.map((d) => [d.id, { target: goLiveDate(d.target), first: d.first }]));
    const numbersOf = new Map(numbers.map((r) => [r.site_id, Number(r.n)]));

    const siteList: SiteMetrics[] = progress.sites.map((p) => {
      const stage = (k: ProgressStageViewKey) => p.stages.find((x) => x.key === k);
      const live = p.complete || stage('deployed')?.state === 'done';
      const d = dateOf.get(p.id);
      const goLive = siteGoLiveStatus(
        { live, targetGoLive: d?.target ?? null, current: p.current, dryRunDone: stage('dry_run')?.state === 'done', blockers: p.blockers.length },
        today,
      );
      return {
        id: p.id,
        sitecode: p.sitecode,
        name: p.name,
        stage: !fullView && DELIVERY_STAGES.includes(p.current) ? 'delivery' : p.current,
        live,
        inService: p.complete,
        users: built.get(p.id) || captured.get(p.id) || 0,
        numbers: numbersOf.get(p.id) ?? 0,
        targetGoLive: d?.target ?? null,
        firstGoLive: d?.first ?? null,
        goLive,
        blockers: p.blockers.length,
        handsets: handsetsOf.get(p.id) ?? { total: 0, installed: 0 },
      };
    });

    const open = siteList.filter((x) => !x.live && x.targetGoLive).sort((a, b) => a.targetGoLive!.localeCompare(b.targetGoLive!));
    const sitesByStage: Partial<Record<ProgressStageViewKey, number>> = {};
    for (const x of siteList) sitesByStage[x.stage] = (sitesByStage[x.stage] ?? 0) + 1;
    const sum = (f: (x: SiteMetrics) => number) => siteList.reduce((n, x) => n + f(x), 0);

    const out: CustomerMetrics = {
      asOf: now.toISOString(),
      period,
      fullView,
      migration: {
        status: customerGoLiveStatus(siteList),
        sites: siteList.length,
        sitesLive: siteList.filter((x) => x.live).length,
        sitesInService: siteList.filter((x) => x.inService).length,
        sitesByStage,
        users: sum((x) => x.users),
        usersLive: sum((x) => (x.live ? x.users : 0)),
        numbers: sum((x) => x.numbers),
        numbersLive: sum((x) => (x.live ? x.numbers : 0)),
        ports: { requests: ports.length, complete: ports.filter((x) => x.status === 'complete').length },
        handsets: { total: sum((x) => x.handsets?.total ?? 0), installed: sum((x) => x.handsets?.installed ?? 0) },
        nextGoLive: open[0] ? { siteId: open[0].id, sitecode: open[0].sitecode, date: open[0].targetGoLive! } : null,
        programmeEnd: open.length ? open[open.length - 1]!.targetGoLive : null,
        siteList,
      },
      changes,
    };
    if (t.managedServices && can(role, 'inc:read')) out.incidents = await this.incidentMetrics(t, period);
    if (t.managedServices && can(role, 'sr:read')) out.serviceRequests = await this.requestMetrics(t, period);
    if (t.monitoringEnabled && can(role, 'monitoring:read')) {
      const devices = await this.deviceMetrics(t);
      if (devices) out.devices = devices;
    }
    return out;
  }

  /** One point per day with a snapshot, oldest first. A site contact gets their own sites' figures only. */
  async history(t: TenantContext, q: { from?: string; to?: string } = {}, now = new Date()): Promise<MetricHistoryPoint[]> {
    const to = q.to ?? utcDay(now);
    const from = q.from ?? utcDay(new Date(Date.parse(`${to}T00:00:00Z`) - 89 * DAY_MS));
    const rows = await tenantDb(this.db, t.schema)
      .selectFrom('metric_snapshots')
      .select([sql<string>`to_char(day, 'YYYY-MM-DD')`.as('day'), 'data'])
      .where('day', '>=', from)
      .where('day', '<=', to)
      .orderBy('day')
      .execute();
    return rows.map((r) => snapshotPoint(r.day, r.data as MetricSnapshot, isSiteScoped(t) ? t.siteScope : null));
  }

  /**
   * Today's snapshot, taken once (a second call the same UTC day changes nothing), and rows past MAX_SNAPSHOT_DAYS removed.
   * `t` must be the whole customer (no site scope). Returns true when a snapshot was written.
   */
  async takeSnapshot(t: TenantContext, now = new Date()): Promise<boolean> {
    const s = tenantDb(this.db, t.schema);
    const day = utcDay(now);
    const have = await s.selectFrom('metric_snapshots').select('day').where('day', '=', day).executeTakeFirst();
    let wrote = false;
    if (!have) {
      const m = await this.metrics({ ...t, siteScope: null }, 'SUPER_ADMIN', {}, now);
      const data: MetricSnapshot = {
        v: 1,
        sites: m.migration.siteList.map((x) => ({
          id: x.id,
          stage: x.stage,
          live: x.live,
          inService: x.inService,
          users: x.users,
          numbers: x.numbers,
          goLive: x.goLive.status,
          targetGoLive: x.targetGoLive,
        })),
      };
      if (m.incidents) data.incidents = { open: m.incidents.open, openP1: m.incidents.openP1, openP2: m.incidents.openP2 };
      if (m.serviceRequests) data.serviceRequests = { open: m.serviceRequests.open };
      if (m.devices) {
        data.devices = { monitored: m.devices.monitored, down: m.devices.down, availability24hPct: m.devices.availability24hPct };
        // each device's last 24 hours, so a report can average it over any period (step 6d)
        const o = await deviceStatusOverview(s);
        data.deviceUptime = o.devices.map((d) => ({ id: d.kumaId, name: d.name, sitecode: d.sitecode, uptime24h: d.uptime24h }));
      }
      const res = await s
        .insertInto('metric_snapshots')
        .values({ day, data: JSON.stringify(data) as never })
        .onConflict((oc) => oc.column('day').doNothing())
        .executeTakeFirst();
      wrote = Number(res.numInsertedOrUpdatedRows ?? 0) > 0;
    }
    const cutoff = utcDay(new Date(Date.parse(`${day}T00:00:00Z`) - MAX_SNAPSHOT_DAYS * DAY_MS));
    await s.deleteFrom('metric_snapshots').where('day', '<', cutoff).execute();
    return wrote;
  }

  /**
   * Each device's availability over a period (the Device status report, step 6d): the mean of the daily readings of its last
   * 24 hours in the snapshots. A site contact sees only their sites' devices.
   */
  async deviceAvailability(t: TenantContext, q: { from?: string; to?: string } = {}, now = new Date()): Promise<DeviceAvailabilityData> {
    const to = q.to ?? utcDay(now);
    const from = q.from ?? utcDay(new Date(Date.parse(`${to}T00:00:00Z`) - 29 * DAY_MS));
    const s = tenantDb(this.db, t.schema);
    const rows = await s
      .selectFrom('metric_snapshots')
      .select([sql<string>`to_char(day, 'YYYY-MM-DD')`.as('day'), 'data'])
      .where('day', '>=', from)
      .where('day', '<=', to)
      .where(sql<boolean>`data ? 'deviceUptime'`)
      .orderBy('day')
      .execute();
    const first = await s.selectFrom('metric_snapshots').select(sql<string>`to_char(min(day), 'YYYY-MM-DD')`.as('day')).where(sql<boolean>`data ? 'deviceUptime'`).executeTakeFirst();
    let keep: ((sitecode: string | null) => boolean) | null = null;
    if (isSiteScoped(t)) {
      const sites = await s.selectFrom('discovery_sites').select('sitecode').where('id', 'in', t.siteScope).execute();
      const allowed = new Set(sites.map((x) => x.sitecode.toLowerCase()));
      keep = (sc) => sc !== null && allowed.has(sc.toLowerCase());
    }
    const byDevice = new Map<number, { name: string; sitecode: string | null; sum: number; days: number }>();
    let sum = 0;
    let n = 0;
    for (const r of rows) {
      for (const d of (r.data as MetricSnapshot).deviceUptime ?? []) {
        if (keep && !keep(d.sitecode)) continue;
        const e = byDevice.get(d.id) ?? { name: d.name, sitecode: d.sitecode, sum: 0, days: 0 };
        // the newest name and site win
        e.name = d.name;
        e.sitecode = d.sitecode;
        if (d.uptime24h !== null) {
          e.sum += d.uptime24h;
          e.days++;
          sum += d.uptime24h;
          n++;
        }
        byDevice.set(d.id, e);
      }
    }
    const pct = (v: number, k: number) => (k ? Math.round((v / k) * 10000) / 100 : null);
    return {
      from,
      to,
      days: rows.length,
      firstDay: first?.day ?? null,
      devices: [...byDevice.values()].map((e) => ({ name: e.name, sitecode: e.sitecode, availabilityPct: pct(e.sum, e.days), days: e.days })),
      availabilityPct: pct(sum, n),
    };
  }

  /* ------------------------------ change log ------------------------------ */

  /**
   * The Change log report: every change live runs made in the customer's Teams tenant during the period, newest first
   * (deployment_changes is append-only, so this is the record auditors ask for). People who can see deployments or the
   * customer's audit log may read it; a site contact gets their own sites' runs.
   */
  /**
   * The Number management report's data: every number range and number in Site Data with its site and country, and who has each
   * assigned one (Teams's holder when Discovery has seen one, otherwise the Site Data holder). Narrowed to the caller's sites.
   */
  /** The Number management report: the ranges and numbers on the customer's sites (or the one site chosen). */
  async numbers(t: TenantContext): Promise<NumberReportData> {
    const s = tenantDb(this.db, t.schema);
    const codes = isSiteScoped(t) ? (await s.selectFrom('discovery_sites').select('sitecode').where('id', 'in', t.siteScope).execute()).map((x) => x.sitecode) : null;
    if (codes && !codes.length) return { ranges: [], numbers: [], truncated: false };
    // Only ranges on a site: what isn't on one is the "Numbers not on a site" report (bug report "Number Management Report").
    const { ranges, rows, truncated } = await this.numberRows(t, codes ? { sitecodes: codes } : 'on-site');
    return {
      ranges: ranges.map((r) => ({ start: r.start, end: r.end, size: rangeSize(r.start, r.end), kind: r.kind, carrier: r.carrier, sitecode: r.sitecode, siteName: r.siteName, country: r.country })),
      numbers: rows.map((r) => ({ ...numberReportRow(r), sitecode: r.sitecode, siteName: r.siteName, country: r.country })),
      truncated,
    };
  }

  /**
   * The Numbers not on a site report: ranges with no site, and their numbers - most of them numbers a Discovery sync found assigned in
   * Teams but in none of the customer's ranges ("Found in Teams" ranges, see number-reconcile.ts). Customer-wide, so not for someone
   * who can only see some sites.
   */
  async numbersOffSite(t: TenantContext): Promise<OffSiteNumberData> {
    if (isSiteScoped(t)) return { ranges: [], numbers: [], truncated: false };
    const { ranges, rows, truncated } = await this.numberRows(t, 'off-site');
    return {
      ranges: ranges.map((r) => ({ start: r.start, end: r.end, size: rangeSize(r.start, r.end), kind: r.kind, carrier: r.carrier, reason: offSiteReason(r.comments) })),
      numbers: rows.map((r) => ({ ...numberReportRow(r), reason: offSiteReason(r.comments) })),
      truncated,
    };
  }

  /** The ranges and numbers for the two number reports: on the given sites, on any site, or on none. */
  private async numberRows(t: TenantContext, which: { sitecodes: string[] } | 'on-site' | 'off-site') {
    const s = tenantDb(this.db, t.schema);
    const cond =
      typeof which === 'object'
        ? sql<boolean>`r.sitecode in (${sql.join(which.sitecodes)})`
        : which === 'on-site'
          ? sql<boolean>`r.sitecode is not null`
          : sql<boolean>`r.sitecode is null`;
    const [ranges, rows] = await Promise.all([
      s
        .selectFrom('discovery_number_ranges as r')
        .leftJoin('discovery_sites as ds', 'ds.sitecode', 'r.sitecode')
        .select(['r.range_start as start', 'r.range_end as end', 'r.kind as kind', 'r.carrier as carrier', 'r.sitecode as sitecode', 'r.comments as comments', 'ds.name as siteName', 'ds.country as country'])
        .where(cond)
        .orderBy('r.sitecode')
        .orderBy('r.range_start')
        .execute(),
      s
        .selectFrom('phone_numbers as pn')
        .innerJoin('discovery_number_ranges as r', 'r.id', 'pn.range_id')
        .leftJoin('discovery_sites as ds', 'ds.sitecode', 'r.sitecode')
        .leftJoin('discovery_users as du', (j) => j.onRef('du.id', '=', 'pn.holder_id').on('pn.holder_type', '=', 'user'))
        .leftJoin('discovery_caps as dc', (j) => j.onRef('dc.id', '=', 'pn.holder_id').on('pn.holder_type', '=', 'cap'))
        .leftJoin('discovery_resource_accounts as dra', (j) => j.onRef('dra.id', '=', 'pn.holder_id').on('pn.holder_type', '=', 'resource_account'))
        .select([
          'pn.e164 as e164',
          'pn.status as status',
          'pn.holder_type as holderType',
          'pn.live_holder_upn as liveUpn',
          'pn.live_holder_name as liveName',
          'pn.live_holder_kind as liveKind',
          'pn.note as note',
          'r.sitecode as sitecode',
          'r.comments as comments',
          'ds.name as siteName',
          'ds.country as country',
          sql<string | null>`coalesce(du.upn, dc.upn, dra.upn)`.as('designUpn'),
          sql<string | null>`coalesce(du.display_name, dc.display_name, dra.name)`.as('designName'),
        ])
        .where(cond)
        .orderBy('pn.e164')
        .limit(NUMBER_REPORT_LIMIT + 1)
        .execute(),
    ]);
    return { ranges, rows: rows.slice(0, NUMBER_REPORT_LIMIT), truncated: rows.length > NUMBER_REPORT_LIMIT };
  }

  async changeLog(t: TenantContext, role: Role, q: { from?: string; to?: string }, now = new Date()): Promise<ChangeLogData> {
    if (!can(role, 'deployment:read') && !can(role, 'audit:read:tenant')) throw new ForbiddenException('The change log is for people who can see deployments or the audit log.');
    const period = insightsPeriod(q, now);
    const s = tenantDb(this.db, t.schema);
    let query = s
      .selectFrom('deployment_changes as c')
      .innerJoin('deployments as d', 'd.id', 'c.deployment_id')
      .select([
        'c.at as at',
        'c.object_type as objectType',
        'c.object_id as objectId',
        'c.cmdlet as cmdlet',
        'c.result as result',
        'c.message as message',
        'c.operator_user_id as operatorId',
        'd.created_by as createdBy',
        'd.id as deploymentId',
        sql<string | null>`d.scope->>'siteId'`.as('siteId'),
      ])
      .where('d.mode', '=', 'execute')
      .where('c.at', '>=', period.from)
      .where('c.at', '<', period.to)
      .orderBy('c.at', 'desc')
      .orderBy('c.seq', 'desc')
      .limit(CHANGE_LOG_LIMIT + 1);
    if (isSiteScoped(t)) query = query.where(sql<string>`d.scope->>'siteId'`, 'in', t.siteScope);
    const rows = await query.execute();
    const shown = rows.slice(0, CHANGE_LOG_LIMIT);
    const siteIds = [...new Set(shown.map((r) => r.siteId).filter((x): x is string => !!x))];
    const userIds = [...new Set(shown.map((r) => r.operatorId ?? r.createdBy).filter((x): x is string => !!x))];
    const [sites, users] = await Promise.all([
      siteIds.length ? s.selectFrom('discovery_sites').select(['id', 'sitecode']).where('id', 'in', siteIds).execute() : [],
      userIds.length ? platformDb(this.db).selectFrom('users').select(['id', 'display_name']).where('id', 'in', userIds).execute() : [],
    ]);
    const sitecode = new Map(sites.map((x) => [x.id, x.sitecode]));
    const name = new Map(users.map((x) => [x.id, x.display_name]));
    return {
      from: period.from,
      to: period.to,
      truncated: rows.length > CHANGE_LOG_LIMIT,
      rows: shown.map((r) => ({
        at: new Date(r.at).toISOString(),
        sitecode: r.siteId ? (sitecode.get(r.siteId) ?? null) : null,
        objectType: r.objectType,
        objectId: r.objectId,
        cmdlet: r.cmdlet,
        result: r.result as ChangeLogData['rows'][number]['result'],
        message: r.message,
        operator: name.get((r.operatorId ?? r.createdBy) as string) ?? null,
        deploymentId: r.deploymentId,
      })),
    };
  }

  /* ------------------------------ go-live dates ------------------------------ */

  /**
   * A site's go-live date: the Target go-live field of its overview (set in Site Data > Overview, which keeps
   * first_go_live up to date - DataCollectionService.updateSiteOverview), and the date first agreed.
   */
  async goLive(t: TenantContext, siteId: string) {
    assertSiteInScope(t, siteId);
    const row = await tenantDb(this.db, t.schema)
      .selectFrom('discovery_sites')
      .select([
        'id',
        sql<string | null>`overview->>'targetGoLive'`.as('target'),
        sql<string | null>`to_char(first_go_live, 'YYYY-MM-DD')`.as('firstGoLive'),
        'go_live_changed_at as changedAt',
      ])
      .where('id', '=', siteId)
      .executeTakeFirst();
    if (!row) throw new NotFoundException('Site not found.');
    const targetGoLive = goLiveDate(row.target);
    return {
      siteId: row.id,
      targetGoLive,
      firstGoLive: targetGoLive ? row.firstGoLive : null,
      changedAt: row.changedAt ? new Date(row.changedAt).toISOString() : null,
    };
  }

  /* ------------------------------ parts ------------------------------ */

  /**
   * Physical handsets per site, as Deployment > Handsets lists them: users who get one (the needsHandset rule in @tvmf/shared:
   * "Requires a physical handset", or a model named) and every common area phone, with how many are ticked installed.
   */
  private async handsetsBySite(t: TenantContext, siteIds: string[]) {
    const out = new Map<string, { total: number; installed: number }>();
    if (siteIds.length === 0) return out;
    const s = tenantDb(this.db, t.schema);
    const [users, caps] = await Promise.all([
      s
        .selectFrom('discovery_users')
        .select(['site_id', (eb) => eb.fn.countAll<string>().as('n'), sql<string>`count(handset_installed_at)`.as('installed')])
        .where('site_id', 'in', siteIds)
        .where(sql<boolean>`(requires_handset or coalesce(btrim(handset_model), '') <> '')`)
        .groupBy('site_id')
        .execute(),
      s
        .selectFrom('discovery_caps')
        .select(['site_id', (eb) => eb.fn.countAll<string>().as('n'), sql<string>`count(handset_installed_at)`.as('installed')])
        .where('site_id', 'in', siteIds)
        .groupBy('site_id')
        .execute(),
    ]);
    for (const r of [...users, ...caps]) {
      const id = r.site_id as string;
      const cur = out.get(id) ?? { total: 0, installed: 0 };
      out.set(id, { total: cur.total + Number(r.n), installed: cur.installed + Number(r.installed) });
    }
    return out;
  }

  private async countBySite(t: TenantContext, table: 'build_users' | 'discovery_users', siteIds: string[]) {
    if (siteIds.length === 0) return new Map<string, number>();
    const rows = await tenantDb(this.db, t.schema)
      .selectFrom(table)
      .select(['site_id', (eb) => eb.fn.countAll<string>().as('n')])
      .where('site_id', 'in', siteIds)
      .groupBy('site_id')
      .execute();
    return new Map(rows.map((r) => [r.site_id as string, Number(r.n)]));
  }

  /** Changes made in the customer's Teams tenant by live runs during the period (a site contact: their sites' runs). */
  private async changes(t: TenantContext, period: { from: string; to: string }) {
    let q = tenantDb(this.db, t.schema)
      .selectFrom('deployment_changes as c')
      .innerJoin('deployments as d', 'd.id', 'c.deployment_id')
      .select(['c.result as result', (eb) => eb.fn.countAll<string>().as('n')])
      .where('d.mode', '=', 'execute')
      .where('c.at', '>=', period.from)
      .where('c.at', '<', period.to)
      .groupBy('c.result');
    if (isSiteScoped(t)) q = q.where(sql<string>`d.scope->>'siteId'`, 'in', t.siteScope);
    const rows = await q.execute();
    const n = (r: string) => Number(rows.find((x) => x.result === r)?.n ?? 0);
    const applied = n('applied');
    const failed = n('failed');
    return { applied, failed, skipped: n('skipped'), firstTimePct: pct(applied, applied + failed) };
  }

  private async incidentMetrics(t: TenantContext, period: { from: string; to: string }): Promise<IncidentMetrics> {
    const r = await this.incidents.report(t, period.from, period.to, false);
    let openQ = tenantDb(this.db, t.schema)
      .selectFrom('incidents')
      .select(['priority', (eb) => eb.fn.countAll<string>().as('n')])
      .where('status', 'in', [...INC_OPEN_STATUSES])
      .groupBy('priority');
    if (isSiteScoped(t)) openQ = openQ.where('site_id', 'in', t.siteScope);
    const open = await openQ.execute();
    const byPriority = (p: string) => Number(open.find((x) => x.priority === p)?.n ?? 0);
    const met = r.on_time.response.met + r.on_time.restoration.met;
    const measured = met + r.on_time.response.missed + r.on_time.restoration.missed;
    return {
      raised: r.raised,
      resolved: r.resolved,
      open: open.reduce((sum, x) => sum + Number(x.n), 0),
      openP1: byPriority('p1'),
      openP2: byPriority('p2'),
      targetsMetPct: pct(met, measured),
      targetsMeasured: measured,
      medianMinutesToAcknowledge: r.median_minutes_to_acknowledge,
      medianHoursToRestore: r.median_hours_to_restore,
    };
  }

  private async requestMetrics(t: TenantContext, period: { from: string; to: string }): Promise<ServiceRequestMetrics> {
    const r = await this.requests.report(t, period.from, period.to);
    return {
      raised: r.raised,
      completed: r.deployed,
      completedByAssistants: r.completedBy.assistants,
      open: r.openBacklog.total,
      medianHoursToComplete: r.medianHoursToDeploy,
      targetsMetPct: r.resolutionMetPct,
    };
  }

  /** null while Monitoring is not set up for the customer. */
  private async deviceMetrics(t: TenantContext): Promise<DeviceMetrics | null> {
    const s = tenantDb(this.db, t.schema);
    const o = await deviceStatusOverview(s);
    if (!o.settings.enabled) return null;
    let devices = o.devices;
    if (isSiteScoped(t)) {
      const sites = await s.selectFrom('discovery_sites').select('sitecode').where('id', 'in', t.siteScope).execute();
      const allowed = new Set(sites.map((x) => x.sitecode.toLowerCase()));
      devices = devices.filter((d) => d.sitecode !== null && allowed.has(d.sitecode.toLowerCase()));
    }
    const uptimes = devices.map((d) => d.uptime24h).filter((u): u is number => u !== null);
    return {
      monitored: devices.length,
      down: devices.filter((d) => d.state === 'down').length,
      availability24hPct: uptimes.length ? Math.round((uptimes.reduce((a, b) => a + b, 0) / uptimes.length) * 10000) / 100 : null,
    };
  }
}
