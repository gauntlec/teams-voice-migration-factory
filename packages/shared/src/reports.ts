/**
 * Voxshift Insights, step 3 (docs/INSIGHTS.md): the Reports area. Every report is built here, pure, as a list of sections
 * (headline figures with the previous period beside them, tables, notes). The Reports page draws any report from its
 * sections, and the same sections become the Excel and CSV exports (and, in step 4, the PDF), so what is on screen and
 * what is exported can't drift apart.
 */
import { z } from 'zod';
import { goLiveDateLabel, overviewHeadline, utcDay, GO_LIVE_STATUS_LABELS, type CustomerMetrics, type MetricHistoryPoint } from './insights';
import type { Permission } from './rbac';
import { INC_PRIORITY_LABELS, type IncPriority } from './incidents';
import { PROGRESS_STAGE_LABELS } from './progress';
import { SR_TYPES, type SrType } from './service-requests';
import type { DeviceRow } from './device-status';

/* ------------------------------ periods ------------------------------ */

export const REPORT_PERIOD_PRESETS = ['last_30_days', 'this_month', 'last_month', 'this_quarter', 'last_quarter', 'last_12_months'] as const;
export type ReportPeriodPreset = (typeof REPORT_PERIOD_PRESETS)[number];

export const REPORT_PERIOD_LABELS: Record<ReportPeriodPreset | 'custom', string> = {
  last_30_days: 'Last 30 days',
  this_month: 'This month',
  last_month: 'Last month',
  this_quarter: 'This quarter',
  last_quarter: 'Last quarter',
  last_12_months: 'Last 12 months',
  custom: 'Custom dates',
};

/** A period of whole UTC days, both ends included (YYYY-MM-DD). */
export interface ReportPeriod {
  from: string;
  to: string;
}

const DAY_MS = 86_400_000;
const addDays = (day: string, n: number) => utcDay(new Date(Date.parse(`${day}T00:00:00Z`) + n * DAY_MS));
const firstOfMonth = (y: number, m: number) => utcDay(new Date(Date.UTC(y, m, 1)));

/** The days a preset covers on `today`. Periods that are still running end today. */
export function reportPresetPeriod(preset: ReportPeriodPreset, today: string): ReportPeriod {
  const d = new Date(`${today}T00:00:00Z`);
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth();
  const q = Math.floor(m / 3) * 3;
  switch (preset) {
    case 'last_30_days':
      return { from: addDays(today, -29), to: today };
    case 'this_month':
      return { from: firstOfMonth(y, m), to: today };
    case 'last_month':
      return { from: firstOfMonth(y, m - 1), to: addDays(firstOfMonth(y, m), -1) };
    case 'this_quarter':
      return { from: firstOfMonth(y, q), to: today };
    case 'last_quarter':
      return { from: firstOfMonth(y, q - 3), to: addDays(firstOfMonth(y, q), -1) };
    case 'last_12_months':
      return { from: firstOfMonth(y, m - 11), to: today };
  }
}

/**
 * The period to compare with: the same number of days just before. A whole calendar month or quarter compares with the
 * whole one before it, so "Last month" (October) compares with September rather than 31 days ending 30 September.
 */
export function previousReportPeriod(p: ReportPeriod): ReportPeriod {
  const from = new Date(`${p.from}T00:00:00Z`);
  const next = new Date(`${addDays(p.to, 1)}T00:00:00Z`);
  const wholeMonths = from.getUTCDate() === 1 && next.getUTCDate() === 1;
  if (wholeMonths) {
    const months = (next.getUTCFullYear() - from.getUTCFullYear()) * 12 + next.getUTCMonth() - from.getUTCMonth();
    return { from: firstOfMonth(from.getUTCFullYear(), from.getUTCMonth() - months), to: addDays(p.from, -1) };
  }
  const days = Math.round((Date.parse(`${p.to}T00:00:00Z`) - Date.parse(`${p.from}T00:00:00Z`)) / DAY_MS) + 1;
  return { from: addDays(p.from, -days), to: addDays(p.from, -1) };
}

/** "1 Aug – 31 Oct 2026" */
export function reportPeriodLabel(p: ReportPeriod): string {
  if (p.from === p.to) return goLiveDateLabel(p.from);
  const sameYear = p.from.slice(0, 4) === p.to.slice(0, 4);
  const from = goLiveDateLabel(p.from);
  return `${sameYear ? from.replace(/ \d{4}$/, '') : from} – ${goLiveDateLabel(p.to)}`;
}

/** ISO instants for the report endpoints, which take `to` as exclusive. */
export function reportPeriodQuery(p: ReportPeriod): { from: string; to: string } {
  return { from: `${p.from}T00:00:00.000Z`, to: `${addDays(p.to, 1)}T00:00:00.000Z` };
}

const ymd = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'use YYYY-MM-DD');

/** ?period=last_month, or ?from=&to= (custom dates, both included); ?compare=0 turns the comparison off. The Reports page keeps these in its address. */
export const reportQuerySchema = z
  .object({ period: z.enum(REPORT_PERIOD_PRESETS).optional(), from: ymd.optional(), to: ymd.optional(), compare: z.enum(['0', '1']).optional(), site: z.guid().optional() })
  .strict()
  .refine((q) => !q.from || !q.to || q.from <= q.to, { message: 'from must not be after to' });
export type ReportQuery = z.infer<typeof reportQuerySchema>;

/** The period a report query asks for: custom dates when both are given, otherwise the preset (last 30 days by default). */
export function reportQueryPeriod(q: { period?: string | null; from?: string | null; to?: string | null }, today: string): { period: ReportPeriod; preset: ReportPeriodPreset | 'custom' } {
  const valid = (d: string | null | undefined): d is string => !!d && /^\d{4}-\d{2}-\d{2}$/.test(d);
  if (valid(q.from) && valid(q.to) && q.from <= q.to) return { period: { from: q.from, to: q.to }, preset: 'custom' };
  const preset = (REPORT_PERIOD_PRESETS as readonly string[]).includes(q.period ?? '') ? (q.period as ReportPeriodPreset) : 'last_30_days';
  return { period: reportPresetPeriod(preset, today), preset };
}

/* ------------------------------ the section model ------------------------------ */

/** Which way is good for a figure: up, down, or neither (a count that is just a count). */
export type Better = 'up' | 'down' | null;

export interface ReportFigure {
  label: string;
  value: number | null;
  /** the same figure for the comparison period; undefined when there is none */
  previous?: number | null;
  unit?: '%' | 'h' | 'min' | 'days';
  better: Better;
  /** a short line under the figure */
  note?: string;
}

export type ReportCell = string | number | null;

export type ReportSection =
  /** the report's opening: a short title line and plain sentences written from the figures */
  | { kind: 'headline'; title: string; sentences: string[] }
  | { kind: 'figures'; title: string; figures: ReportFigure[] }
  | { kind: 'table'; title: string; columns: string[]; rows: ReportCell[][]; empty?: string; note?: string; numeric?: number[] }
  | { kind: 'note'; text: string };

export interface ReportDocument {
  /** a customer report, or the Portfolio report across customers (step 5) */
  key: ReportKey | 'portfolio';
  title: string;
  /** one line under the title */
  summary: string;
  period: ReportPeriod;
  comparedWith?: ReportPeriod;
  /** cut to one site (the Reports page's site filter, step 6c): "LON01 London" */
  site?: string;
  sections: ReportSection[];
}

export const REPORT_KEYS = ['executive', 'migration', 'incidents', 'service-requests', 'assistants', 'changes', 'devices'] as const;
export type ReportKey = (typeof REPORT_KEYS)[number];

/** The catalogue: what each report is for, in plain words. */
export const REPORT_GROUPS = ['Executive', 'Migration', 'Service'] as const;
export const REPORT_CATALOGUE: Record<ReportKey, { title: string; group: (typeof REPORT_GROUPS)[number]; description: string; period: boolean }> = {
  executive: {
    title: 'Executive summary',
    group: 'Executive',
    description: 'One page for a monthly or quarterly review: progress against plan, service levels, risks and the next go-lives, in plain sentences.',
    period: true,
  },
  migration: { title: 'Migration progress', group: 'Migration', description: 'Sites by stage, users and numbers live, each site’s go-live date and status, and the figures day by day.', period: true },
  changes: { title: 'Change log', group: 'Migration', description: 'Every change Voxshift made in the customer’s Teams tenant, and whether it applied. For auditors and change boards.', period: true },
  incidents: { title: 'Incidents and service levels', group: 'Service', description: 'Raised and resolved, time to acknowledge and restore, targets met, where incidents come from, and the open backlog.', period: true },
  'service-requests': { title: 'Service requests', group: 'Service', description: 'Requests by type, time to complete, targets met, the open backlog, and how many an assistant completed.', period: true },
  assistants: {
    title: 'Assistant activity',
    group: 'Service',
    description: 'What the AI assistants did: incidents and service requests worked, the steps they proposed and how people decided them, and what they finished on their own.',
    period: true,
  },
  devices: { title: 'Device status', group: 'Service', description: 'Every monitored phone, gateway and paging unit: whether it is up now, and its availability over the period.', period: true },
};

/**
 * Whether a report can be opened for a customer by someone with these permissions: the same rules as the data behind it,
 * so a report is never offered and then refused. The api checks it too before making a PDF.
 */
export function reportAvailableFor(key: ReportKey, can: (p: Permission) => boolean, tenant: { managedServices: boolean; monitoring: boolean }): boolean {
  switch (key) {
    case 'executive':
    case 'migration':
      return true;
    case 'changes':
      return can('deployment:read') || can('audit:read:tenant');
    case 'incidents':
      return tenant.managedServices && can('inc:read');
    case 'service-requests':
      return tenant.managedServices && can('sr:read');
    case 'assistants':
      return tenant.managedServices && (can('inc:read') || can('sr:read'));
    case 'devices':
      return tenant.monitoring && can('monitoring:read');
  }
}

/** The change from previous to value, as a figure shows it ("▲ 2.5 pts", "▼ 3"), with whether that is good. */
export function figureChange(f: ReportFigure): { text: string; good: boolean | null } | null {
  if (f.previous === undefined || f.previous === null || f.value === null) return null;
  const diff = Math.round((f.value - f.previous) * 10) / 10;
  if (diff === 0) return { text: 'No change', good: null };
  const unit = f.unit === '%' ? ' pts' : f.unit ? ` ${f.unit}` : '';
  return { text: `${diff > 0 ? '▲' : '▼'} ${Math.abs(diff).toLocaleString('en-GB')}${unit}`, good: f.better === null ? null : (diff > 0) === (f.better === 'up') };
}

/** How a figure's value is written: "97.8%", "2.1 h", "1,240", "–". */
export function figureText(value: number | null, unit?: ReportFigure['unit']): string {
  if (value === null) return '–';
  const n = value.toLocaleString('en-GB', { maximumFractionDigits: 1 });
  return unit === '%' ? `${n}%` : unit ? `${n} ${unit}` : n;
}

/* ------------------------------ the data each report reads ------------------------------ */

/** GET /t/:tenantId/incidents/report (IncidentReportService.report). */
export interface IncidentReportData {
  from: string;
  to: string;
  raised: number;
  resolved: number;
  fixed_by?: { agent: number; person_with_agent: number; person: number };
  reopened: number;
  major: number;
  by_priority: { priority: IncPriority; count: number }[];
  by_category: { category: string; label: string; count: number }[];
  by_site: { site: string; count: number }[];
  median_minutes_to_acknowledge: number | null;
  median_hours_to_restore: number | null;
  median_hours_to_resolve: number | null;
  on_time: Record<'response' | 'restoration' | 'resolution', { met: number; missed: number; percent: number | null }>;
  backlog: { under1d: number; d1to3: number; d3to7: number; over7d: number };
  repeats: { category: string; category_label: string; sitecode: string | null; count: number; references: string[] }[];
  problems?: { id: string; reference: string; title: string; count: number }[];
  truncated: boolean;
}

/** GET /t/:tenantId/service-requests/report (ServiceRequestsService.report). */
export interface ServiceRequestReportData {
  from: string;
  to: string;
  raised: number;
  completedBy?: { assistants: number; people: number };
  deployed: number;
  byType: Record<string, number>;
  byStatus: Record<string, number>;
  medianHoursToDeploy: number | null;
  responseMetPct: number | null;
  resolutionMetPct: number | null;
  responseMeasured: number;
  resolutionMeasured: number;
  openBacklog: { total: number; under1d: number; d1to3: number; d3to7: number; over7d: number };
}

/** One assistant's work in a period (AssistantActivityData). */
export interface AssistantActivityRow {
  agentId: string;
  name: string;
  /** one Voxshift runs itself (Triage, Diagnose, Comms, Changes), not one the MSP connected */
  builtin: boolean;
  /** incidents and service requests it took on (claimed) in the period */
  incidentsWorked: number;
  requestsWorked: number;
  /** steps it put to a person in the period, and how they stand now */
  proposed: number;
  approved: number;
  rejected: number;
  expired: number;
  waiting: number;
  /** work it handed to a person, and work a person took back from it (took over or reassigned) */
  handedOff: number;
  takenBack: number;
  /** incidents it resolved itself, and service requests it completed (the verified deployment) */
  resolved: number;
  completed: number;
}

/** GET /t/:tenantId/insights/assistants: what the AI assistants did for the customer in a period. */
export interface AssistantActivityData {
  from: string;
  to: string;
  /** which parts the person can see (inc:read, sr:read) */
  incidents: boolean;
  serviceRequests: boolean;
  /** distinct items, so two assistants on one incident count it once */
  incidentsWorked: number;
  requestsWorked: number;
  assistants: AssistantActivityRow[];
  proposals: { area: 'incident' | 'service_request'; kind: string; label: string; proposed: number; approved: number; rejected: number; expired: number; waiting: number }[];
  /** from a step being proposed to a person deciding it */
  medianMinutesToDecide: number | null;
}

/** GET /t/:tenantId/insights/devices/availability: each device's availability over a period, from the daily snapshots. */
export interface DeviceAvailabilityData {
  from: string;
  to: string;
  /** days in the period with a reading */
  days: number;
  /** the first day Voxshift kept device readings for this customer, if any */
  firstDay: string | null;
  devices: { name: string; sitecode: string | null; availabilityPct: number | null; days: number }[];
  /** the mean over every device and day */
  availabilityPct: number | null;
}

/** GET /t/:tenantId/insights/changes: changes made in the customer's Teams tenant by live runs. */
export interface ChangeLogRow {
  at: string;
  sitecode: string | null;
  objectType: string;
  objectId: string | null;
  cmdlet: string;
  result: 'applied' | 'skipped' | 'failed' | 'whatif';
  message: string | null;
  /** who ran the deployment */
  operator: string | null;
  deploymentId: string;
}
export interface ChangeLogData {
  from: string;
  to: string;
  rows: ChangeLogRow[];
  /** more changes than the report reads; the newest are shown */
  truncated: boolean;
}

/* ------------------------------ the reports ------------------------------ */

const dateTime = (iso: string) => {
  const d = new Date(iso);
  return `${utcDay(d)} ${d.toISOString().slice(11, 16)}`;
};

export function buildMigrationReport(m: CustomerMetrics, history: MetricHistoryPoint[], period: ReportPeriod): ReportDocument {
  const g = m.migration;
  // The comparison is the snapshot nearest the start of the period, when there is one.
  const base = history.find((p) => p.day >= period.from && p.day <= period.to) ?? null;
  const prev = <K extends keyof MetricHistoryPoint>(k: K) => (base ? (base[k] as number) : undefined);
  const sections: ReportSection[] = [
    {
      kind: 'figures',
      title: 'Progress',
      figures: [
        { label: 'Sites live', value: g.sitesLive, previous: prev('sitesLive'), better: 'up', note: `of ${g.sites}` },
        { label: 'Users live', value: g.usersLive, previous: prev('usersLive'), better: 'up', note: `of ${g.users.toLocaleString('en-GB')}` },
        { label: 'Numbers live', value: g.numbersLive, previous: prev('numbersLive'), better: 'up', note: `of ${g.numbers.toLocaleString('en-GB')}` },
        { label: 'Sites in service', value: g.sitesInService, previous: prev('sitesInService'), better: 'up' },
        { label: 'Number ports complete', value: g.ports.complete, better: 'up', note: `of ${g.ports.requests}` },
        ...(g.handsets?.total ? [{ label: 'Handsets installed', value: g.handsets.installed, better: 'up' as const, note: `of ${g.handsets.total}` }] : []),
      ],
    },
    {
      kind: 'table',
      title: 'Sites',
      columns: ['Site', 'Name', 'Stage', 'Users', 'Numbers', 'Handsets installed', 'Go-live', 'First agreed', 'Status', 'Why'],
      numeric: [3, 4],
      rows: g.siteList.map((x) => [
        x.sitecode,
        x.name,
        PROGRESS_STAGE_LABELS[x.stage],
        x.users,
        x.numbers,
        x.handsets?.total ? `${x.handsets.installed} of ${x.handsets.total}` : null,
        x.targetGoLive ? goLiveDateLabel(x.targetGoLive) : null,
        x.firstGoLive && x.firstGoLive !== x.targetGoLive ? goLiveDateLabel(x.firstGoLive) : null,
        GO_LIVE_STATUS_LABELS[x.goLive.status],
        x.goLive.reason,
      ]),
      empty: 'No sites yet.',
    },
  ];
  if (history.length) {
    sections.push({
      kind: 'table',
      title: 'Day by day',
      columns: ['Day', 'Sites live', 'Users live', 'Numbers live'],
      numeric: [1, 2, 3],
      rows: history.filter((p) => p.day >= period.from && p.day <= period.to).map((p) => [p.day, p.sitesLive, p.usersLive, p.numbersLive]),
      empty: 'No daily figures in this period.',
      note: 'Voxshift records these figures once a day.',
    });
  }
  return {
    key: 'migration',
    title: REPORT_CATALOGUE.migration.title,
    summary: `${g.sitesLive} of ${g.sites} sites live · ${g.usersLive.toLocaleString('en-GB')} of ${g.users.toLocaleString('en-GB')} users`,
    period,
    comparedWith: base ? { from: base.day, to: base.day } : undefined,
    sections,
  };
}

export function buildIncidentReport(r: IncidentReportData, prev: IncidentReportData | null, period: ReportPeriod, comparedWith?: ReportPeriod): ReportDocument {
  const p = <T>(f: (x: IncidentReportData) => T) => (prev ? f(prev) : undefined);
  const open = (x: IncidentReportData) => x.backlog.under1d + x.backlog.d1to3 + x.backlog.d3to7 + x.backlog.over7d;
  const sections: ReportSection[] = [
    {
      kind: 'figures',
      title: 'In the period',
      figures: [
        { label: 'Raised', value: r.raised, previous: p((x) => x.raised), better: 'down' },
        { label: 'Resolved', value: r.resolved, previous: p((x) => x.resolved), better: 'up' },
        { label: 'Reopened', value: r.reopened, previous: p((x) => x.reopened), better: 'down' },
        { label: 'Major incidents', value: r.major, previous: p((x) => x.major), better: 'down' },
        { label: 'Open now', value: open(r), better: 'down' },
      ],
    },
    {
      kind: 'figures',
      title: 'Speed and targets',
      figures: [
        { label: 'Typical time to acknowledge', value: r.median_minutes_to_acknowledge, previous: p((x) => x.median_minutes_to_acknowledge), unit: 'min', better: 'down' },
        { label: 'Typical time to restore', value: r.median_hours_to_restore, previous: p((x) => x.median_hours_to_restore), unit: 'h', better: 'down' },
        { label: 'First response on time', value: r.on_time.response.percent, previous: p((x) => x.on_time.response.percent), unit: '%', better: 'up', note: `${r.on_time.response.met} of ${r.on_time.response.met + r.on_time.response.missed}` },
        { label: 'Service restored on time', value: r.on_time.restoration.percent, previous: p((x) => x.on_time.restoration.percent), unit: '%', better: 'up', note: `${r.on_time.restoration.met} of ${r.on_time.restoration.met + r.on_time.restoration.missed}` },
        { label: 'Resolved on time', value: r.on_time.resolution.percent, previous: p((x) => x.on_time.resolution.percent), unit: '%', better: 'up', note: `${r.on_time.resolution.met} of ${r.on_time.resolution.met + r.on_time.resolution.missed}` },
      ],
    },
    { kind: 'note', text: 'Time on hold waiting for the customer, a carrier or Microsoft isn’t counted.' },
    {
      kind: 'table',
      title: 'By priority',
      columns: ['Priority', 'Raised', ...(prev ? ['Before'] : [])],
      numeric: prev ? [1, 2] : [1],
      rows: r.by_priority.map((x) => [INC_PRIORITY_LABELS[x.priority], x.count, ...(prev ? [prev.by_priority.find((y) => y.priority === x.priority)?.count ?? 0] : [])]),
    },
    { kind: 'table', title: 'By category', columns: ['Category', 'Raised'], numeric: [1], rows: r.by_category.map((x) => [x.label, x.count]), empty: 'None in this period.' },
    { kind: 'table', title: 'By site', columns: ['Site', 'Raised'], numeric: [1], rows: r.by_site.map((x) => [x.site, x.count]), empty: 'None in this period.' },
    {
      kind: 'table',
      title: 'Open now, by age',
      columns: ['Age', 'Open'],
      numeric: [1],
      rows: [
        ['Under a day', r.backlog.under1d],
        ['1 to 3 days', r.backlog.d1to3],
        ['3 to 7 days', r.backlog.d3to7],
        ['Over a week', r.backlog.over7d],
      ],
    },
  ];
  if (r.fixed_by && r.resolved > 0 && (r.fixed_by.agent > 0 || r.fixed_by.person_with_agent > 0)) {
    sections.push({
      kind: 'table',
      title: 'Who fixed them',
      columns: ['', 'Incidents'],
      numeric: [1],
      rows: [
        ['An assistant on its own', r.fixed_by.agent],
        ['A person, with an assistant’s help', r.fixed_by.person_with_agent],
        ['A person on their own', r.fixed_by.person],
      ],
    });
  }
  if (r.repeats.length) {
    sections.push({ kind: 'table', title: 'Keeps happening', columns: ['What', 'Where', 'Times', 'Incidents'], numeric: [2], rows: r.repeats.map((x) => [x.category_label, x.sitecode ?? 'All sites', x.count, x.references.join(', ')]) });
  }
  if (r.problems?.length) {
    sections.push({ kind: 'table', title: 'Problems behind these incidents', columns: ['Problem', 'Incidents'], numeric: [1], rows: r.problems.map((x) => [`${x.reference} · ${x.title}`, x.count]) });
  }
  if (r.truncated) sections.push({ kind: 'note', text: 'This period has more incidents than the report reads; the figures cover the most recent ones.' });
  return {
    key: 'incidents',
    title: REPORT_CATALOGUE.incidents.title,
    summary: `${r.raised} raised · ${r.resolved} resolved · ${r.on_time.restoration.percent === null ? 'no restore targets measured' : `${r.on_time.restoration.percent}% restored on time`}`,
    period,
    comparedWith: prev ? comparedWith : undefined,
    sections,
  };
}

export function buildServiceRequestReport(
  r: ServiceRequestReportData,
  prev: ServiceRequestReportData | null,
  period: ReportPeriod,
  typeLabel: (t: SrType) => string,
  comparedWith?: ReportPeriod,
): ReportDocument {
  const p = <T>(f: (x: ServiceRequestReportData) => T) => (prev ? f(prev) : undefined);
  const sections: ReportSection[] = [
    {
      kind: 'figures',
      title: 'In the period',
      figures: [
        { label: 'Raised', value: r.raised, previous: p((x) => x.raised), better: null },
        { label: 'Completed', value: r.deployed, previous: p((x) => x.deployed), better: 'up' },
        { label: 'Completed by an assistant', value: r.completedBy?.assistants ?? 0, previous: p((x) => x.completedBy?.assistants ?? 0), better: 'up' },
        { label: 'Typical time to complete', value: r.medianHoursToDeploy, previous: p((x) => x.medianHoursToDeploy), unit: 'h', better: 'down' },
        { label: 'Response on time', value: r.responseMetPct, previous: p((x) => x.responseMetPct), unit: '%', better: 'up', note: `${r.responseMeasured} measured` },
        { label: 'Completed on time', value: r.resolutionMetPct, previous: p((x) => x.resolutionMetPct), unit: '%', better: 'up', note: `${r.resolutionMeasured} measured` },
      ],
    },
    {
      kind: 'table',
      title: 'By type',
      columns: ['Type', 'Raised', ...(prev ? ['Before'] : [])],
      numeric: prev ? [1, 2] : [1],
      rows: SR_TYPES.filter((t) => r.byType[t] || prev?.byType[t]).map((t) => [typeLabel(t), r.byType[t] ?? 0, ...(prev ? [prev.byType[t] ?? 0] : [])]),
      empty: 'None in this period.',
    },
    {
      kind: 'table',
      title: 'Open now, by age',
      columns: ['Age', 'Open'],
      numeric: [1],
      rows: [
        ['Under a day', r.openBacklog.under1d],
        ['1 to 3 days', r.openBacklog.d1to3],
        ['3 to 7 days', r.openBacklog.d3to7],
        ['Over a week', r.openBacklog.over7d],
      ],
    },
    { kind: 'note', text: 'Time waiting for the customer isn’t counted.' },
  ];
  return {
    key: 'service-requests',
    title: REPORT_CATALOGUE['service-requests'].title,
    summary: `${r.raised} raised · ${r.deployed} completed · ${r.openBacklog.total} open now`,
    period,
    comparedWith: prev ? comparedWith : undefined,
    sections,
  };
}

export function buildAssistantReport(a: AssistantActivityData, prev: AssistantActivityData | null, period: ReportPeriod, comparedWith?: ReportPeriod): ReportDocument {
  const sum = (d: AssistantActivityData, f: (r: AssistantActivityRow) => number) => d.assistants.reduce((n, r) => n + f(r), 0);
  const p = (f: (d: AssistantActivityData) => number | null) => (prev ? f(prev) : undefined);
  const approvedPct = (d: AssistantActivityData) => {
    const yes = sum(d, (r) => r.approved);
    const decided = yes + sum(d, (r) => r.rejected);
    return decided ? Math.round((yes / decided) * 1000) / 10 : null;
  };
  const figures: ReportFigure[] = [];
  if (a.incidents) figures.push({ label: 'Incidents worked', value: a.incidentsWorked, previous: p((d) => d.incidentsWorked), better: null });
  if (a.serviceRequests) figures.push({ label: 'Service requests worked', value: a.requestsWorked, previous: p((d) => d.requestsWorked), better: null });
  figures.push(
    { label: 'Steps proposed', value: sum(a, (r) => r.proposed), previous: p((d) => sum(d, (r) => r.proposed)), better: null },
    { label: 'Approved by a person', value: approvedPct(a), previous: p(approvedPct), unit: '%', better: 'up', note: 'of the steps decided' },
    { label: 'Typical time to a decision', value: a.medianMinutesToDecide, previous: p((d) => d.medianMinutesToDecide), unit: 'min', better: 'down' },
  );
  if (a.incidents) figures.push({ label: 'Incidents resolved by an assistant', value: sum(a, (r) => r.resolved), previous: p((d) => sum(d, (r) => r.resolved)), better: 'up' });
  if (a.serviceRequests) figures.push({ label: 'Requests completed by an assistant', value: sum(a, (r) => r.completed), previous: p((d) => sum(d, (r) => r.completed)), better: 'up' });
  figures.push({ label: 'Handed to a person', value: sum(a, (r) => r.handedOff), previous: p((d) => sum(d, (r) => r.handedOff)), better: null });

  const cols = ['Assistant', ...(a.incidents ? ['Incidents'] : []), ...(a.serviceRequests ? ['Requests'] : []), 'Proposed', 'Approved', 'Rejected', 'Expired', 'Waiting', 'Handed over', 'Taken back', ...(a.incidents ? ['Resolved'] : []), ...(a.serviceRequests ? ['Completed'] : [])];
  const active = a.assistants.filter((r) => r.incidentsWorked + r.requestsWorked + r.proposed + r.handedOff + r.takenBack + r.resolved + r.completed > 0);
  const sections: ReportSection[] = [
    { kind: 'figures', title: 'In the period', figures },
    {
      kind: 'table',
      title: 'By assistant',
      columns: cols,
      numeric: cols.map((_, i) => i).slice(1),
      rows: active.map((r) => [
        r.builtin ? `${r.name} (Voxshift)` : r.name,
        ...(a.incidents ? [r.incidentsWorked] : []),
        ...(a.serviceRequests ? [r.requestsWorked] : []),
        r.proposed,
        r.approved,
        r.rejected,
        r.expired,
        r.waiting,
        r.handedOff,
        r.takenBack,
        ...(a.incidents ? [r.resolved] : []),
        ...(a.serviceRequests ? [r.completed] : []),
      ]),
      empty: 'No assistant worked for this customer in this period.',
      note: 'Taken back: a person took the work over, or gave it to someone else.',
    },
    {
      kind: 'table',
      title: 'Steps proposed, by kind',
      columns: ['Step', 'Where', 'Proposed', 'Approved', 'Rejected', 'Expired', 'Waiting'],
      numeric: [2, 3, 4, 5, 6],
      rows: a.proposals.map((x) => [x.label, x.area === 'incident' ? 'Incidents' : 'Service requests', x.proposed, x.approved, x.rejected, x.expired, x.waiting]),
      empty: 'No steps proposed in this period.',
    },
    {
      kind: 'note',
      text: 'An assistant does only what this customer’s assistant settings allow. A person approves every deployment, and every customer message about a priority 1 or 2 incident.',
    },
  ];
  const proposed = sum(a, (r) => r.proposed);
  return {
    key: 'assistants',
    title: REPORT_CATALOGUE.assistants.title,
    summary: [a.incidents ? `${a.incidentsWorked} incidents` : '', a.serviceRequests ? `${a.requestsWorked} service requests` : '', `${proposed} steps proposed`].filter(Boolean).join(' · '),
    period,
    comparedWith: prev ? comparedWith : undefined,
    sections,
  };
}

const RESULT_LABELS: Record<ChangeLogRow['result'], string> = { applied: 'Applied', skipped: 'Skipped', failed: 'Failed', whatif: 'What-if' };

export function buildChangeLogReport(c: ChangeLogData, period: ReportPeriod): ReportDocument {
  const n = (r: ChangeLogRow['result']) => c.rows.filter((x) => x.result === r).length;
  const applied = n('applied');
  const failed = n('failed');
  const byType = new Map<string, number>();
  for (const x of c.rows) byType.set(x.objectType, (byType.get(x.objectType) ?? 0) + 1);
  const sections: ReportSection[] = [
    {
      kind: 'figures',
      title: 'Changes to Teams',
      figures: [
        { label: 'Applied', value: applied, better: null },
        { label: 'Failed', value: failed, better: 'down' },
        { label: 'Skipped (already as designed)', value: n('skipped'), better: null },
        { label: 'Applied first time', value: applied + failed ? Math.round((applied / (applied + failed)) * 1000) / 10 : null, unit: '%', better: 'up' },
      ],
    },
    {
      kind: 'table',
      title: 'By kind of object',
      columns: ['Object', 'Changes'],
      numeric: [1],
      rows: [...byType.entries()].sort((a, b) => b[1] - a[1]).map(([k, v]) => [k, v]),
      empty: 'No changes in this period.',
    },
    {
      kind: 'table',
      title: 'Every change',
      columns: ['When (UTC)', 'Site', 'Object', 'Name or ID', 'Command', 'Result', 'Message', 'Run by'],
      rows: c.rows.map((x) => [dateTime(x.at), x.sitecode, x.objectType, x.objectId, x.cmdlet, RESULT_LABELS[x.result], x.message, x.operator]),
      empty: 'No changes in this period.',
      note: 'Live runs only; dry runs change nothing. Every change is kept, unaltered, in the deployment record.',
    },
  ];
  if (c.truncated) sections.push({ kind: 'note', text: 'This period has more changes than the report reads; the newest are shown. Choose a shorter period to see them all.' });
  return {
    key: 'changes',
    title: REPORT_CATALOGUE.changes.title,
    summary: `${c.rows.length.toLocaleString('en-GB')} changes · ${failed} failed`,
    period,
    sections,
  };
}

const DEVICE_STATE_LABELS: Record<DeviceRow['state'], string> = { up: 'Up', down: 'Down', pending: 'Pending', maintenance: 'Maintenance', unknown: 'Unknown' };

/** The Device status report: now, and (step 6d) each device's availability over the period, from the daily readings. */
export function buildDeviceReport(devices: DeviceRow[], today: string, history?: { period: ReportPeriod; data: DeviceAvailabilityData; before?: DeviceAvailabilityData | null; comparedWith?: ReportPeriod }): ReportDocument {
  const up = devices.filter((d) => d.state === 'up').length;
  const down = devices.filter((d) => d.state === 'down').length;
  const uptimes = devices.map((d) => d.uptime24h).filter((u): u is number => u !== null);
  const avg = uptimes.length ? Math.round((uptimes.reduce((a, b) => a + b, 0) / uptimes.length) * 10000) / 100 : null;
  const over: ReportSection[] = [];
  if (history) {
    const h = history.data;
    const below = h.devices.filter((d) => d.availabilityPct !== null && d.availabilityPct < 99).length;
    over.push(
      {
        kind: 'figures',
        title: 'Over the period',
        figures: [
          { label: 'Available', value: h.availabilityPct, previous: history.before ? history.before.availabilityPct : undefined, unit: '%', better: 'up', note: `${h.days} day${h.days === 1 ? '' : 's'} recorded` },
          { label: 'Devices below 99%', value: below, previous: history.before ? history.before.devices.filter((d) => d.availabilityPct !== null && d.availabilityPct < 99).length : undefined, better: 'down' },
        ],
      },
      {
        kind: 'table',
        title: 'Availability over the period',
        columns: ['Device', 'Site', 'Available (%)', 'Days recorded'],
        numeric: [2, 3],
        rows: [...h.devices].sort((a, b) => (a.availabilityPct ?? 101) - (b.availabilityPct ?? 101) || a.name.localeCompare(b.name)).map((d) => [d.name, d.sitecode, d.availabilityPct, d.days]),
        empty: h.firstDay ? 'No device readings in this period.' : 'No device readings yet: Voxshift records them once a day from now on.',
      },
      {
        kind: 'note',
        text: `Worked out from Voxshift's daily reading of each device's last 24 hours${h.firstDay ? `, kept since ${h.firstDay}` : ''}.`,
      },
    );
  }
  return {
    key: 'devices',
    title: REPORT_CATALOGUE.devices.title,
    summary: `${devices.length} devices · ${down} down now${history?.data.availabilityPct != null ? ` · ${history.data.availabilityPct}% available over the period` : ''}`,
    period: history ? history.period : { from: today, to: today },
    comparedWith: history?.before ? history.comparedWith : undefined,
    sections: [
      ...over,
      {
        kind: 'figures',
        title: 'Now',
        figures: [
          { label: 'Monitored', value: devices.length, better: null },
          { label: 'Up', value: up, better: 'up' },
          { label: 'Down', value: down, better: 'down' },
          { label: 'Available, last 24 hours', value: avg, unit: '%', better: 'up' },
        ],
      },
      {
        kind: 'table',
        title: 'Devices',
        columns: ['Device', 'Site', 'Group', 'State', 'Since (UTC)', 'Available, 24 h (%)', 'Response (ms)'],
        numeric: [5, 6],
        rows: [...devices]
          .sort((a, b) => (a.state === b.state ? a.name.localeCompare(b.name) : a.state === 'down' ? -1 : b.state === 'down' ? 1 : 0))
          .map((d) => [d.name, d.sitecode, d.group, DEVICE_STATE_LABELS[d.state], dateTime(d.since), d.uptime24h === null ? null : Math.round(d.uptime24h * 10000) / 100, d.responseMs === null ? null : Math.round(d.responseMs)]),
        empty: 'No devices are monitored.',
      },
    ],
  };
}

/**
 * The Executive summary: one page for a review meeting. `metrics` covers the period (its incident, request and change
 * figures) and `previous` the period before; migration figures are as at the end of the period, from the daily
 * snapshots when the period has ended, and compared with the end of the period before.
 */
export function buildExecutiveSummary(input: {
  metrics: CustomerMetrics;
  previous: CustomerMetrics | null;
  history: MetricHistoryPoint[];
  period: ReportPeriod;
  comparedWith: ReportPeriod;
  today: string;
}): ReportDocument {
  const { metrics: m, previous, history, period, comparedWith, today } = input;
  const g = m.migration;
  const lastUpTo = (day: string) => [...history].reverse().find((p) => p.day <= day) ?? null;
  const end = period.to >= today ? null : lastUpTo(period.to);
  const start = lastUpTo(comparedWith.to) ?? history.find((p) => p.day >= period.from && p.day <= period.to) ?? null;
  const now = {
    sitesLive: end?.sitesLive ?? g.sitesLive,
    sites: end?.sites ?? g.sites,
    usersLive: end?.usersLive ?? g.usersLive,
    users: end?.users ?? g.users,
    numbersLive: end?.numbersLive ?? g.numbersLive,
  };
  const fmt = (n: number) => n.toLocaleString('en-GB');
  const inc = m.incidents;
  const incPrev = previous?.incidents;
  const sr = m.serviceRequests;
  const srPrev = previous?.serviceRequests;

  // The headline: where the migration stands now (the Overview's sentences), then what the period did.
  const head = overviewHeadline(m);
  const sentences: string[] = [];
  if (start) {
    const moved = now.usersLive - start.usersLive;
    const sitesMoved = now.sitesLive - start.sitesLive;
    if (moved > 0 || sitesMoved > 0) {
      sentences.push(`In this period ${fmt(moved)} ${moved === 1 ? 'user' : 'users'} moved to Teams Phone${sitesMoved > 0 ? ` and ${sitesMoved} ${sitesMoved === 1 ? 'site' : 'sites'} went live` : ''}.`);
    } else sentences.push('No users or sites went live in this period.');
  }
  if (inc && inc.targetsMetPct !== null) {
    const was = incPrev?.targetsMetPct;
    sentences.push(`${inc.targetsMetPct}% of incident response and restore targets were met${was !== undefined && was !== null ? ` (${was}% the period before)` : ''}, from ${inc.raised} ${inc.raised === 1 ? 'incident' : 'incidents'} raised.`);
  }
  if (sr && sr.completed > 0) sentences.push(`${sr.completed} service ${sr.completed === 1 ? 'request was' : 'requests were'} completed${sr.completedByAssistants ? `, ${sr.completedByAssistants} by an assistant` : ''}.`);
  for (const x of head.sentences.slice(1)) if (sentences.length < 5) sentences.push(x);

  const figures: ReportFigure[] = [
    { label: 'Users live', value: now.usersLive, previous: start?.usersLive, better: 'up', note: `of ${fmt(now.users)}` },
    { label: 'Sites live', value: now.sitesLive, previous: start?.sitesLive, better: 'up', note: `of ${now.sites}` },
    { label: 'Numbers live', value: now.numbersLive, previous: start?.numbersLive, better: 'up' },
  ];
  if (inc) {
    figures.push({ label: 'Incident targets met', value: inc.targetsMetPct, previous: incPrev ? incPrev.targetsMetPct : undefined, unit: '%', better: 'up', note: `${inc.targetsMeasured} targets` });
    figures.push({ label: 'Incidents raised', value: inc.raised, previous: incPrev?.raised, better: 'down', note: `${inc.open} open now` });
  }
  if (sr) figures.push({ label: 'Service requests completed', value: sr.completed, previous: srPrev?.completed, better: 'up', note: sr.medianHoursToComplete === null ? undefined : `typically ${sr.medianHoursToComplete < 48 ? `${sr.medianHoursToComplete} h` : `${Math.round((sr.medianHoursToComplete / 24) * 10) / 10} days`}` });
  figures.push({ label: 'Changes applied first time', value: m.changes.firstTimePct, previous: previous ? previous.changes.firstTimePct : undefined, unit: '%', better: 'up', note: `${fmt(m.changes.applied + m.changes.failed)} changes` });
  if (m.devices) figures.push({ label: 'Device availability, 24 h', value: m.devices.availability24hPct, unit: '%', better: 'up', note: `${m.devices.monitored} devices` });

  const risks: ReportCell[][] = g.siteList
    .filter((x) => x.goLive.status === 'off_track' || x.goLive.status === 'at_risk')
    .sort((a, b) => (a.goLive.status === b.goLive.status ? 0 : a.goLive.status === 'off_track' ? -1 : 1))
    .map((x) => [x.sitecode, GO_LIVE_STATUS_LABELS[x.goLive.status], x.goLive.reason]);
  if (inc && inc.openP1 > 0) risks.unshift(['All sites', 'Priority 1', `${inc.openP1} priority 1 ${inc.openP1 === 1 ? 'incident is' : 'incidents are'} open`]);
  const undated = g.siteList.filter((x) => x.goLive.status === 'no_date').length;
  if (undated > 0) risks.push([`${undated} ${undated === 1 ? 'site' : 'sites'}`, 'No go-live date', 'Set a go-live date so progress can be measured against a plan']);

  const next = g.siteList
    .filter((x) => !x.live && x.targetGoLive)
    .sort((a, b) => a.targetGoLive!.localeCompare(b.targetGoLive!))
    .slice(0, 8)
    .map((x) => [x.sitecode, x.name, PROGRESS_STAGE_LABELS[x.stage], goLiveDateLabel(x.targetGoLive!), GO_LIVE_STATUS_LABELS[x.goLive.status]]);

  // The title line counts sites as at the end of the period, like the figures under it; the risk count is as of now.
  const title = end ? head.title.replace(/^\d[\d,]* of [\d,]+ sites? live/, `${now.sitesLive} of ${now.sites} ${now.sites === 1 ? 'site' : 'sites'} live`) : head.title;
  return {
    key: 'executive',
    title: REPORT_CATALOGUE.executive.title,
    summary: title,
    period,
    comparedWith,
    sections: [
      { kind: 'headline', title, sentences },
      { kind: 'figures', title: 'Headline figures', figures },
      { kind: 'table', title: 'Risks and decisions', columns: ['Where', 'What', 'Why'], rows: risks, empty: 'Nothing is at risk.' },
      { kind: 'table', title: 'Next go-lives', columns: ['Site', 'Name', 'Stage now', 'Go-live', 'Status'], rows: next, empty: 'No go-live dates ahead.' },
      ...(end ? [{ kind: 'note' as const, text: `Migration figures are as at ${goLiveDateLabel(end.day)}, the last daily record in the period.` }] : []),
    ],
  };
}

/* ------------------------------ all customers (step 5) ------------------------------ */

/** One customer on the All customers view. */
export interface PortfolioRow {
  tenantId: string;
  name: string;
  mspName: string | null;
  status: import('./insights').CustomerGoLiveStatus;
  /** 'operations' once every site is in service */
  mode: 'migration' | 'operations';
  sites: number;
  sitesLive: number;
  sitesInService: number;
  users: number;
  usersLive: number;
  /** users live about 30 days ago, from the daily snapshots; null without history that far back */
  usersLive30dAgo: number | null;
  /** sites at risk or off track */
  atRisk: number;
  nextGoLive: { sitecode: string; date: string } | null;
  /** present when Managed Services is on */
  incidents?: { open: number; openP1: number; openP2: number; targetsMetPct: number | null; targetsMeasured: number };
  openServiceRequests?: number;
  /** the figures could not be worked out for this customer */
  error?: string;
}

/** GET /insights/portfolio */
export interface PortfolioData {
  asOf: string;
  rows: PortfolioRow[];
}

const STATUS_ORDER: Record<string, number> = { off_track: 0, at_risk: 1, on_track: 2, no_date: 3, complete: 4, no_sites: 5 };

/** Worst first: off track, then a P1 open, at risk, on track, no dates, all live; then by name. */
export function sortPortfolio(rows: PortfolioRow[]): PortfolioRow[] {
  const rank = (r: PortfolioRow) => (r.error ? -1 : r.incidents?.openP1 ? 0.5 : STATUS_ORDER[r.status] ?? 9);
  return [...rows].sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));
}

export interface PortfolioTotals {
  customers: number;
  sites: number;
  sitesLive: number;
  users: number;
  usersLive: number;
  usersLive30dAgo: number | null;
  openP1: number;
  openP2: number;
  /** response and restore targets met across customers, weighted by how many were measured */
  targetsMetPct: number | null;
  needAttention: number;
}

export function portfolioTotals(rows: PortfolioRow[]): PortfolioTotals {
  const ok = rows.filter((r) => !r.error);
  const sum = (f: (r: PortfolioRow) => number) => ok.reduce((n, r) => n + f(r), 0);
  const measured = sum((r) => r.incidents?.targetsMeasured ?? 0);
  const met = sum((r) => (r.incidents && r.incidents.targetsMetPct !== null ? (r.incidents.targetsMetPct / 100) * r.incidents.targetsMeasured : 0));
  const withHistory = ok.filter((r) => r.usersLive30dAgo !== null);
  return {
    customers: rows.length,
    sites: sum((r) => r.sites),
    sitesLive: sum((r) => r.sitesLive),
    users: sum((r) => r.users),
    usersLive: sum((r) => r.usersLive),
    usersLive30dAgo: withHistory.length ? withHistory.reduce((n, r) => n + r.usersLive30dAgo!, 0) + ok.filter((r) => r.usersLive30dAgo === null).reduce((n, r) => n + r.usersLive, 0) : null,
    openP1: sum((r) => r.incidents?.openP1 ?? 0),
    openP2: sum((r) => r.incidents?.openP2 ?? 0),
    targetsMetPct: measured ? Math.round((met / measured) * 1000) / 10 : null,
    needAttention: rows.filter((r) => r.error || r.status === 'off_track' || r.status === 'at_risk' || (r.incidents?.openP1 ?? 0) > 0).length,
  };
}

/** The Portfolio report: every customer the person can open, worst first, as on the All customers view. */
export function buildPortfolioReport(data: PortfolioData, today: string): ReportDocument {
  const rows = sortPortfolio(data.rows);
  const t = portfolioTotals(rows);
  const fmt = (n: number) => n.toLocaleString('en-GB');
  const sentences = [
    `${fmt(t.usersLive)} of ${fmt(t.users)} users are live on Teams Phone across ${t.customers} ${t.customers === 1 ? 'customer' : 'customers'}, at ${t.sitesLive} of ${t.sites} sites.`,
  ];
  if (t.usersLive30dAgo !== null && t.usersLive > t.usersLive30dAgo) sentences.push(`${fmt(t.usersLive - t.usersLive30dAgo)} users went live in the last 30 days.`);
  if (t.targetsMetPct !== null) sentences.push(`${t.targetsMetPct}% of incident response and restore targets were met in the last 30 days.`);
  sentences.push(t.needAttention ? `${t.needAttention} ${t.needAttention === 1 ? 'customer needs' : 'customers need'} attention.` : 'No customer needs attention.');
  return {
    key: 'portfolio',
    title: 'Portfolio',
    summary: `${t.customers} customers · ${fmt(t.usersLive)} users live`,
    period: { from: today, to: today },
    sections: [
      { kind: 'headline', title: `${t.sitesLive} of ${t.sites} sites live across ${t.customers} ${t.customers === 1 ? 'customer' : 'customers'}`, sentences },
      {
        kind: 'figures',
        title: 'Across all customers',
        figures: [
          { label: 'Users live', value: t.usersLive, previous: t.usersLive30dAgo ?? undefined, better: 'up', note: `of ${fmt(t.users)}` },
          { label: 'Sites live', value: t.sitesLive, better: 'up', note: `of ${t.sites}` },
          { label: 'Incident targets met, 30 days', value: t.targetsMetPct, unit: '%', better: 'up' },
          { label: 'Open P1 / P2 incidents', value: t.openP1 + t.openP2, better: 'down', note: `P1 ${t.openP1} · P2 ${t.openP2}` },
          { label: 'Customers needing attention', value: t.needAttention, better: 'down', note: `of ${t.customers}` },
        ],
      },
      {
        kind: 'table',
        title: 'Customers',
        columns: ['Customer', 'Status', 'Sites live', 'Users live', 'Targets met', 'Open P1 / P2', 'Next go-live'],
        numeric: [3],
        rows: rows.map((r) => [
          r.mspName ? `${r.name} (${r.mspName})` : r.name,
          r.error ? 'Figures unavailable' : r.incidents?.openP1 ? 'P1 open' : r.mode === 'operations' && r.status === 'complete' ? 'In service' : (CUSTOMER_STATUS_TEXT[r.status] ?? null),
          `${r.sitesLive} / ${r.sites}`,
          r.usersLive,
          r.incidents?.targetsMetPct === null || !r.incidents ? null : `${r.incidents.targetsMetPct}%`,
          r.incidents ? `${r.incidents.openP1} / ${r.incidents.openP2}` : null,
          r.nextGoLive ? `${r.nextGoLive.sitecode}, ${goLiveDateLabel(r.nextGoLive.date)}` : null,
        ]),
        empty: 'No customers.',
      },
    ],
  };
}

const CUSTOMER_STATUS_TEXT: Record<string, string> = { complete: 'All sites live', on_track: 'On track', at_risk: 'At risk', off_track: 'Off track', no_date: 'No go-live dates', no_sites: 'No sites yet' };

/* ------------------------------ scheduled reports (step 4b) ------------------------------ */

export const SCHEDULE_FREQUENCIES = ['monthly', 'quarterly'] as const;
export type ScheduleFrequency = (typeof SCHEDULE_FREQUENCIES)[number];
export const SCHEDULE_FREQUENCY_LABELS: Record<ScheduleFrequency, string> = { monthly: 'Monthly', quarterly: 'Quarterly' };
/** The period each send covers: the whole month or quarter just ended. */
export const SCHEDULE_PERIOD: Record<ScheduleFrequency, ReportPeriodPreset> = { monthly: 'last_month', quarterly: 'last_quarter' };
/** Sends go out at this hour (UTC) on the 1st, once the daily snapshot of the 1st has been taken. */
export const SCHEDULE_SEND_HOUR_UTC = 7;
/** How many people one schedule can send to. */
export const MAX_SCHEDULE_RECIPIENTS = 25;

/** The first send time strictly after `after`: 07:00 UTC on the 1st of the next month (quarterly: of January, April, July or October). */
export function nextScheduleRun(frequency: ScheduleFrequency, after: Date): Date {
  const y = after.getUTCFullYear();
  const m = after.getUTCMonth();
  for (let i = 0; i <= 12; i++) {
    const at = new Date(Date.UTC(y, m + i, 1, SCHEDULE_SEND_HOUR_UTC));
    if (at.getTime() <= after.getTime()) continue;
    if (frequency === 'quarterly' && at.getUTCMonth() % 3 !== 0) continue;
    return at;
  }
  throw new Error('no next run');
}

export const reportScheduleSchema = z
  .object({
    reportKey: z.enum(REPORT_KEYS),
    frequency: z.enum(SCHEDULE_FREQUENCIES),
    recipients: z.array(z.string().uuid()).min(1, 'Choose at least one person').max(MAX_SCHEDULE_RECIPIENTS),
    enabled: z.boolean().optional(),
  })
  .strict();
export type ReportScheduleInput = z.infer<typeof reportScheduleSchema>;

export interface ScheduleRecipient {
  id: string;
  name: string;
  email: string;
  role: import('./rbac').Role;
  /** false when they can no longer open the customer (left, or switched off): they are skipped */
  ok: boolean;
}

/** GET /t/:tenantId/insights/schedules */
/** Reports › Sent (step 6b): one copy of a scheduled report as it was emailed, from the email log. */
export interface SentReportView {
  /** the email's id */
  id: string;
  at: string;
  reportTitle: string;
  periodLabel: string;
  toName: string | null;
  toEmail: string;
  /** the email log's state: waiting to go, sent, failed, or not sent (email off, or a test customer's mail held back) */
  status: 'queued' | 'sent' | 'failed' | 'skipped';
  error: string | null;
  /** the report page for the same period, as a path in the app */
  path: string | null;
  /** the PDF that was sent is still kept (90 days) and can be downloaded */
  pdf: { filename: string } | null;
  /** who pressed Send now; null for the schedule's own send */
  sentBy: string | null;
}

export interface ReportScheduleView {
  id: string;
  reportKey: ReportKey;
  reportTitle: string;
  frequency: ScheduleFrequency;
  recipients: ScheduleRecipient[];
  enabled: boolean;
  nextRunAt: string;
  lastRunAt: string | null;
  /** 'sent' | 'partly_sent' | 'email_off' | 'failed' */
  lastStatus: string | null;
  lastDetail: string | null;
  createdBy: string | null;
}

/* ------------------------------ exports ------------------------------ */

/** A sheet for Excel, or a table for CSV: a title and rows of cells, the first row the column headings. */
export interface ExportSheet {
  name: string;
  rows: ReportCell[][];
}

/** Excel sheet names: at most 31 characters, none of : \ / ? * [ ] */
const sheetName = (s: string, used: Set<string>) => {
  const base = s.replace(/[:\\/?*[\]]/g, ' ').slice(0, 31).trim() || 'Sheet';
  let name = base;
  for (let i = 2; used.has(name.toLowerCase()); i++) name = `${base.slice(0, 28)} ${i}`;
  used.add(name.toLowerCase());
  return name;
};

/**
 * The report as sheets: a Summary sheet (the report, its period, every figure with the comparison) and one sheet per table.
 * Excel exports all of them; CSV exports the largest table.
 */
export function reportSheets(doc: ReportDocument, customer: string): ExportSheet[] {
  const used = new Set<string>();
  const summary: ReportCell[][] = [
    [doc.title],
    ['Customer', customer],
    ...(doc.site ? [['Site', doc.site] as ReportCell[]] : []),
    ['Period', reportPeriodLabel(doc.period)],
    ...(doc.comparedWith ? [['Compared with', reportPeriodLabel(doc.comparedWith)] as ReportCell[]] : []),
    [],
    ['Figure', 'Value', ...(doc.comparedWith ? ['Before', 'Change'] : []), 'Note'],
  ];
  for (const s of doc.sections) {
    if (s.kind !== 'figures') continue;
    for (const f of s.figures) {
      const ch = figureChange(f);
      summary.push([`${s.title}: ${f.label}`, f.value, ...(doc.comparedWith ? [f.previous ?? null, ch?.text ?? null] : []), f.note ?? null]);
    }
  }
  const headline = doc.sections.find((s): s is Extract<ReportSection, { kind: 'headline' }> => s.kind === 'headline');
  if (headline) summary.splice((doc.comparedWith ? 4 : 3) + (doc.site ? 1 : 0), 0, [], [headline.title], ...headline.sentences.map((x) => [x] as ReportCell[]));
  const notes = doc.sections.filter((s): s is Extract<ReportSection, { kind: 'note' }> => s.kind === 'note');
  if (notes.length) summary.push([], ...notes.map((n) => [n.text] as ReportCell[]));
  const sheets: ExportSheet[] = [{ name: sheetName('Summary', used), rows: summary }];
  for (const s of doc.sections) {
    if (s.kind === 'table') sheets.push({ name: sheetName(s.title, used), rows: [s.columns, ...s.rows] });
  }
  return sheets;
}

/** One table as CSV (RFC 4180: quoted when it holds a comma, quote or line break). */
export function toCsv(rows: ReportCell[][]): string {
  const cell = (v: ReportCell) => {
    const s = v === null ? '' : String(v);
    return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return rows.map((r) => r.map(cell).join(',')).join('\r\n');
}

/** "voxshift-incidents-contoso-2026-08-01-to-2026-10-31" */
export function reportFileName(doc: ReportDocument, customer: string): string {
  const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  const when = doc.period.from === doc.period.to ? doc.period.from : `${doc.period.from}-to-${doc.period.to}`;
  // a report cut to one site names it by its sitecode (the label's first word)
  const site = doc.site ? `-${slug(doc.site.split(' ')[0]!)}` : '';
  return `voxshift-${doc.key}-${slug(customer) || 'customer'}${site}-${when}`;
}
