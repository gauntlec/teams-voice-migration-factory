/**
 * Voxshift Insights (docs/INSIGHTS.md): the figures the Overview home page and the Reports area share, so the two never
 * disagree. InsightsService (apps/api) gathers them; the rules for "on track", "at risk" and "off track" are here, pure,
 * so they are unit-tested. Nothing in this file is entered by hand except a site's target go-live date.
 */
import { z } from 'zod';
import type { ProgressStageViewKey } from './progress';

/* ------------------------------ go-live status ------------------------------ */

/** live = the site is deployed (or in service); no_date = no target go-live date set. */
export const GO_LIVE_STATUSES = ['live', 'on_track', 'at_risk', 'off_track', 'no_date'] as const;
export type GoLiveStatus = (typeof GO_LIVE_STATUSES)[number];

export const GO_LIVE_STATUS_LABELS: Record<GoLiveStatus, string> = {
  live: 'Live',
  on_track: 'On track',
  at_risk: 'At risk',
  off_track: 'Off track',
  no_date: 'No go-live date',
};

/**
 * How close to the go-live date each unfinished step turns a site "at risk". Kept as named numbers so the rule can be
 * explained in one sentence each (docs/INSIGHTS.md, "Go-live status").
 */
export const GO_LIVE_RISK_DAYS = {
  /** Site Data still not finished this close to go-live */
  siteData: 30,
  /** something on the site needs fixing (a blocker) this close to go-live */
  blockers: 14,
  /** no clean dry run yet this close to go-live */
  dryRun: 14,
} as const;

export interface GoLiveInput {
  /** the site is live: its Deployed stage is done, or it is in service */
  live: boolean;
  /** YYYY-MM-DD, or null when none is set */
  targetGoLive: string | null;
  /** the stage being worked on now (progress.current, full view) */
  current: ProgressStageViewKey;
  /** the Dry run stage is done (a clean dry run after the latest design change) */
  dryRunDone: boolean;
  /** how many blockers the site has (progress.blockers) */
  blockers: number;
}

export interface GoLiveResult {
  status: GoLiveStatus;
  /** one plain sentence saying why; null when live or on track */
  reason: string | null;
  /** whole days from today to the target date (negative once it has passed); null without a date */
  daysLeft: number | null;
}

const DAY_MS = 86_400_000;

/** Whole days from `today` to `date`, both YYYY-MM-DD (UTC calendar days). */
export function daysBetween(today: string, date: string): number {
  return Math.round((Date.parse(`${date}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / DAY_MS);
}

/** Today's UTC date as YYYY-MM-DD. */
export function utcDay(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}

/** "12 Nov 2026" for a YYYY-MM-DD date. */
export function goLiveDateLabel(date: string): string {
  const d = new Date(`${date}T00:00:00Z`);
  return Number.isNaN(d.getTime()) ? date : d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
}

const inDays = (n: number) => (n === 0 ? 'today' : n === 1 ? 'tomorrow' : `in ${n} days`);

/**
 * A site's go-live status, worked out from its target date and where it is now. A site is off track once its date has
 * passed and it is not live; at risk when an unfinished step is close to the date (GO_LIVE_RISK_DAYS); otherwise on track.
 */
export function siteGoLiveStatus(input: GoLiveInput, today: string): GoLiveResult {
  if (input.live) return { status: 'live', reason: null, daysLeft: input.targetGoLive ? daysBetween(today, input.targetGoLive) : null };
  if (!input.targetGoLive) return { status: 'no_date', reason: null, daysLeft: null };
  const days = daysBetween(today, input.targetGoLive);
  if (days < 0) {
    return { status: 'off_track', reason: `The go-live date (${goLiveDateLabel(input.targetGoLive)}) has passed and the site is not live`, daysLeft: days };
  }
  if (input.current === 'data_collection' && days <= GO_LIVE_RISK_DAYS.siteData) {
    return { status: 'at_risk', reason: `Site Data is not finished and go-live is ${inDays(days)}`, daysLeft: days };
  }
  if (input.blockers > 0 && days <= GO_LIVE_RISK_DAYS.blockers) {
    return { status: 'at_risk', reason: `${input.blockers} ${input.blockers === 1 ? 'thing needs' : 'things need'} fixing and go-live is ${inDays(days)}`, daysLeft: days };
  }
  if (!input.dryRunDone && days <= GO_LIVE_RISK_DAYS.dryRun) {
    return { status: 'at_risk', reason: `There is no clean dry run yet and go-live is ${inDays(days)}`, daysLeft: days };
  }
  return { status: 'on_track', reason: null, daysLeft: days };
}

/** The customer's overall status: complete once every site is live, otherwise the worst status among its unfinished, dated sites. */
export type CustomerGoLiveStatus = 'complete' | 'on_track' | 'at_risk' | 'off_track' | 'no_date' | 'no_sites';

export const CUSTOMER_GO_LIVE_STATUS_LABELS: Record<CustomerGoLiveStatus, string> = {
  complete: 'All sites live',
  on_track: 'On track',
  at_risk: 'At risk',
  off_track: 'Off track',
  no_date: 'No go-live dates',
  no_sites: 'No sites yet',
};

export function customerGoLiveStatus(sites: { goLive: { status: GoLiveStatus } }[]): CustomerGoLiveStatus {
  if (sites.length === 0) return 'no_sites';
  const open = sites.filter((x) => x.goLive.status !== 'live');
  if (open.length === 0) return 'complete';
  const has = (s: GoLiveStatus) => open.some((x) => x.goLive.status === s);
  if (has('off_track')) return 'off_track';
  if (has('at_risk')) return 'at_risk';
  if (has('on_track')) return 'on_track';
  return 'no_date';
}

/* ------------------------------ the figures ------------------------------ */

export interface SiteMetrics {
  id: string;
  sitecode: string;
  name: string | null;
  /** where the site is now (progress.current); 'delivery' for people who can't see Design & Build or Deployment */
  stage: ProgressStageViewKey;
  /** deployed cleanly, or in service */
  live: boolean;
  /** in service (operations mode) */
  inService: boolean;
  /** users in scope: in Design & Build, or in Site Data while nothing is designed yet */
  users: number;
  /** phone numbers in the site's number ranges */
  numbers: number;
  /** YYYY-MM-DD, from the site overview's Target go-live field */
  targetGoLive: string | null;
  /** the date first agreed (YYYY-MM-DD), kept when the target moves */
  firstGoLive: string | null;
  goLive: GoLiveResult;
  blockers: number;
}

export interface MigrationMetrics {
  status: CustomerGoLiveStatus;
  sites: number;
  sitesLive: number;
  sitesInService: number;
  /** how many sites are at each stage now */
  sitesByStage: Partial<Record<ProgressStageViewKey, number>>;
  users: number;
  usersLive: number;
  numbers: number;
  numbersLive: number;
  /** number port requests: all, and those complete */
  ports: { requests: number; complete: number };
  /** the earliest target date among sites not yet live */
  nextGoLive: { siteId: string; sitecode: string; date: string } | null;
  /** the latest target date among sites not yet live */
  programmeEnd: string | null;
  siteList: SiteMetrics[];
}

/** Changes Voxshift made in the customer's Teams tenant during the period (live runs only). */
export interface ChangeMetrics {
  applied: number;
  failed: number;
  skipped: number;
  /** applied / (applied + failed), as a percentage; null when there were none */
  firstTimePct: number | null;
}

export interface IncidentMetrics {
  raised: number;
  resolved: number;
  open: number;
  openP1: number;
  openP2: number;
  /** response and restoration targets met, among incidents raised in the period, as a percentage; null when none were measured */
  targetsMetPct: number | null;
  targetsMeasured: number;
  medianMinutesToAcknowledge: number | null;
  medianHoursToRestore: number | null;
}

export interface ServiceRequestMetrics {
  raised: number;
  completed: number;
  completedByAssistants: number;
  open: number;
  medianHoursToComplete: number | null;
  /** completion targets met, as a percentage; null when none were measured */
  targetsMetPct: number | null;
}

export interface DeviceMetrics {
  monitored: number;
  down: number;
  /** mean 24-hour availability across monitored devices, as a percentage; null when Monitoring has no figure yet */
  availability24hPct: number | null;
}

/** GET /t/:tenantId/insights/metrics */
export interface CustomerMetrics {
  /** when the figures were worked out (ISO) */
  asOf: string;
  /** the period the period figures cover (ISO, to is exclusive) */
  period: { from: string; to: string };
  /** the caller sees Designed / Validated / Dry run / Deployed rather than one 'delivery' stage */
  fullView: boolean;
  migration: MigrationMetrics;
  changes: ChangeMetrics;
  /** omitted when Managed Services is off or the caller can't see incidents */
  incidents?: IncidentMetrics;
  /** omitted when Managed Services is off or the caller can't see service requests */
  serviceRequests?: ServiceRequestMetrics;
  /** omitted when Monitoring is off for the customer or the caller can't see it */
  devices?: DeviceMetrics;
}

/* ------------------------------ daily snapshots ------------------------------ */

/** One site in a day's snapshot - enough to redraw progress for any set of sites. */
export interface SnapshotSite {
  id: string;
  stage: ProgressStageViewKey;
  live: boolean;
  inService: boolean;
  users: number;
  numbers: number;
  goLive: GoLiveStatus;
  targetGoLive: string | null;
}

/** metric_snapshots.data: the customer's figures once a day (full view), kept MAX_SNAPSHOT_DAYS. */
export interface MetricSnapshot {
  /** bump when the shape changes, so old rows can be read correctly */
  v: 1;
  sites: SnapshotSite[];
  incidents?: { open: number; openP1: number; openP2: number };
  serviceRequests?: { open: number };
  devices?: { monitored: number; down: number; availability24hPct: number | null };
}

export const MAX_SNAPSHOT_DAYS = 730;

/** GET /t/:tenantId/insights/history: one point per day a snapshot was taken. */
export interface MetricHistoryPoint {
  day: string;
  sites: number;
  sitesLive: number;
  sitesInService: number;
  users: number;
  usersLive: number;
  numbers: number;
  numbersLive: number;
  /** customer-wide figures; left out for a site contact, who sees only their own sites */
  openIncidents?: number;
  openServiceRequests?: number;
  devicesDown?: number;
}

/** A day's totals over its sites; `siteIds` limits them to some sites (a site contact). */
export function snapshotPoint(day: string, snap: MetricSnapshot, siteIds: string[] | null = null): MetricHistoryPoint {
  const keep = siteIds ? new Set(siteIds) : null;
  const sites = keep ? snap.sites.filter((x) => keep.has(x.id)) : snap.sites;
  const sum = (f: (x: SnapshotSite) => number) => sites.reduce((n, x) => n + f(x), 0);
  const point: MetricHistoryPoint = {
    day,
    sites: sites.length,
    sitesLive: sites.filter((x) => x.live).length,
    sitesInService: sites.filter((x) => x.inService).length,
    users: sum((x) => x.users),
    usersLive: sum((x) => (x.live ? x.users : 0)),
    numbers: sum((x) => x.numbers),
    numbersLive: sum((x) => (x.live ? x.numbers : 0)),
  };
  if (!keep) {
    if (snap.incidents) point.openIncidents = snap.incidents.open;
    if (snap.serviceRequests) point.openServiceRequests = snap.serviceRequests.open;
    if (snap.devices) point.devicesDown = snap.devices.down;
  }
  return point;
}

/* ------------------------------ inputs ------------------------------ */

const ymd = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'use YYYY-MM-DD');

/** ?from=&to= for the period figures; both optional (the last 30 days), at most 400 days apart. */
export const insightsPeriodQuerySchema = z
  .object({ from: ymd.optional(), to: ymd.optional() })
  .strict()
  .refine((q) => !q.from || !q.to || q.from <= q.to, { message: 'from must not be after to' })
  .refine((q) => !q.from || !q.to || daysBetween(q.from, q.to) <= 400, { message: 'choose a period of 400 days or less' });
export type InsightsPeriodQuery = z.infer<typeof insightsPeriodQuerySchema>;

/** ?from=&to= for history; both optional (the last 90 days), at most MAX_SNAPSHOT_DAYS apart. */
export const insightsHistoryQuerySchema = z
  .object({ from: ymd.optional(), to: ymd.optional() })
  .strict()
  .refine((q) => !q.from || !q.to || q.from <= q.to, { message: 'from must not be after to' });
export type InsightsHistoryQuery = z.infer<typeof insightsHistoryQuerySchema>;

/**
 * A site's go-live date from its overview's "Target go-live" field (DiscoverySiteOverview.targetGoLive): YYYY-MM-DD when it
 * holds a real date, otherwise null. Older sites may hold free text ("Q3 2026"), which counts as no date.
 */
export function goLiveDate(value: unknown): string | null {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const d = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value ? value : null;
}

/**
 * The period for ?from=&to= (both YYYY-MM-DD, `to` inclusive): defaults to the 30 days up to and including today.
 * Returns ISO instants with `to` exclusive, as the report services take them.
 */
export function insightsPeriod(q: { from?: string; to?: string }, now: Date = new Date()): { from: string; to: string } {
  const toDay = q.to ?? utcDay(now);
  const fromDay = q.from ?? utcDay(new Date(Date.parse(`${toDay}T00:00:00Z`) - 29 * DAY_MS));
  return { from: `${fromDay}T00:00:00.000Z`, to: new Date(Date.parse(`${toDay}T00:00:00Z`) + DAY_MS).toISOString() };
}

/* ------------------------------ the Overview ------------------------------ */

const fmt = (n: number) => n.toLocaleString('en-GB');
const plural = (n: number, one: string, many = `${one}s`) => `${fmt(n)} ${n === 1 ? one : many}`;

export interface OverviewHeadline {
  /** the one line in the brand panel, e.g. "9 of 14 sites live, on track for 4 Mar 2027" */
  title: string;
  /** two or three short sentences under it */
  sentences: string[];
}

/**
 * The Overview's headline, written from the figures by fixed sentences (never generated text), so it is always exactly
 * what the numbers say.
 */
export function overviewHeadline(m: Pick<CustomerMetrics, 'migration'>): OverviewHeadline {
  const g = m.migration;
  if (g.sites === 0) return { title: 'No sites yet', sentences: ['Add the customer’s sites in Site Data to start tracking the migration.'] };
  const usersLine = g.users > 0 ? `${fmt(g.usersLive)} of ${plural(g.users, 'user')} ${g.usersLive === 1 && g.users === 1 ? 'is' : 'are'} live on Teams Phone.` : null;
  if (g.status === 'complete') {
    const left = g.sites - g.sitesInService;
    return {
      title: g.sites === 1 ? 'The site is live' : `All ${g.sites} sites are live`,
      sentences: [usersLine, left > 0 ? `${plural(left, 'site')} still to hand over to service.` : 'Every site is in service.'].filter((x): x is string => !!x),
    };
  }
  const risky = g.siteList.filter((x) => x.goLive.status === 'off_track' || x.goLive.status === 'at_risk');
  const off = risky.filter((x) => x.goLive.status === 'off_track').length;
  const suffix =
    g.status === 'on_track' && g.programmeEnd
      ? `, on track for ${goLiveDateLabel(g.programmeEnd)}`
      : g.status === 'off_track'
        ? `, ${off} off track`
        : g.status === 'at_risk'
          ? `, ${risky.length} at risk`
          : '';
  const sentences: string[] = [];
  if (usersLine) sentences.push(usersLine);
  if (g.nextGoLive) sentences.push(`The next go-live is ${g.nextGoLive.sitecode} on ${goLiveDateLabel(g.nextGoLive.date)}.`);
  const worst = risky.sort((a, b) => (a.goLive.status === b.goLive.status ? 0 : a.goLive.status === 'off_track' ? -1 : 1))[0];
  if (worst?.goLive.reason) sentences.push(`${worst.sitecode}: ${worst.goLive.reason}.`);
  const undated = g.siteList.filter((x) => x.goLive.status === 'no_date').length;
  if (undated > 0 && sentences.length < 3) sentences.push(`${plural(undated, 'site')} ${undated === 1 ? 'has' : 'have'} no go-live date yet.`);
  return { title: `${g.sitesLive} of ${plural(g.sites, 'site')} live${suffix}`, sentences };
}

/**
 * The planned number of users live on each of `days` (YYYY-MM-DD, ascending): a site's users count from its target
 * go-live date; a live site with no date counts from the start.
 */
export function goLivePlan(sites: Pick<SiteMetrics, 'users' | 'live' | 'targetGoLive'>[], days: string[]): number[] {
  return days.map((d) => sites.reduce((n, x) => n + ((x.targetGoLive ? x.targetGoLive <= d : x.live) ? x.users : 0), 0));
}
