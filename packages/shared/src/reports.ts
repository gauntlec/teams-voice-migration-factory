/**
 * Voxshift Insights, step 3 (docs/INSIGHTS.md): the Reports area. Every report is built here, pure, as a list of sections
 * (headline figures with the previous period beside them, tables, notes). The Reports page draws any report from its
 * sections, and the same sections become the Excel and CSV exports (and, in step 4, the PDF), so what is on screen and
 * what is exported can't drift apart.
 */
import { goLiveDateLabel, utcDay, GO_LIVE_STATUS_LABELS, type CustomerMetrics, type MetricHistoryPoint } from './insights';
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
  | { kind: 'figures'; title: string; figures: ReportFigure[] }
  | { kind: 'table'; title: string; columns: string[]; rows: ReportCell[][]; empty?: string; note?: string; numeric?: number[] }
  | { kind: 'note'; text: string };

export interface ReportDocument {
  key: ReportKey;
  title: string;
  /** one line under the title */
  summary: string;
  period: ReportPeriod;
  comparedWith?: ReportPeriod;
  sections: ReportSection[];
}

export const REPORT_KEYS = ['migration', 'incidents', 'service-requests', 'changes', 'devices'] as const;
export type ReportKey = (typeof REPORT_KEYS)[number];

/** The catalogue: what each report is for, in plain words. */
export const REPORT_CATALOGUE: Record<ReportKey, { title: string; group: 'Migration' | 'Service'; description: string; period: boolean }> = {
  migration: { title: 'Migration progress', group: 'Migration', description: 'Sites by stage, users and numbers live, each site’s go-live date and status, and the figures day by day.', period: true },
  changes: { title: 'Change log', group: 'Migration', description: 'Every change Voxshift made in the customer’s Teams tenant, and whether it applied. For auditors and change boards.', period: true },
  incidents: { title: 'Incidents and service levels', group: 'Service', description: 'Raised and resolved, time to acknowledge and restore, targets met, where incidents come from, and the open backlog.', period: true },
  'service-requests': { title: 'Service requests', group: 'Service', description: 'Requests by type, time to complete, targets met, the open backlog, and how many an assistant completed.', period: true },
  devices: { title: 'Device status', group: 'Service', description: 'Every monitored phone, gateway and paging unit: whether it is up now and its availability over the last 24 hours.', period: false },
};

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
      ],
    },
    {
      kind: 'table',
      title: 'Sites',
      columns: ['Site', 'Name', 'Stage', 'Users', 'Numbers', 'Go-live', 'First agreed', 'Status', 'Why'],
      numeric: [3, 4],
      rows: g.siteList.map((x) => [
        x.sitecode,
        x.name,
        PROGRESS_STAGE_LABELS[x.stage],
        x.users,
        x.numbers,
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

export function buildDeviceReport(devices: DeviceRow[], today: string): ReportDocument {
  const up = devices.filter((d) => d.state === 'up').length;
  const down = devices.filter((d) => d.state === 'down').length;
  const uptimes = devices.map((d) => d.uptime24h).filter((u): u is number => u !== null);
  const avg = uptimes.length ? Math.round((uptimes.reduce((a, b) => a + b, 0) / uptimes.length) * 10000) / 100 : null;
  return {
    key: 'devices',
    title: REPORT_CATALOGUE.devices.title,
    summary: `${devices.length} devices · ${down} down now`,
    period: { from: today, to: today },
    sections: [
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
  return `voxshift-${doc.key}-${slug(customer) || 'customer'}-${when}`;
}
