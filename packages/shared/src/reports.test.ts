import { describe, expect, it } from 'vitest';
import {
  buildChangeLogReport,
  buildExecutiveSummary,
  buildIncidentReport,
  figureChange,
  previousReportPeriod,
  reportFileName,
  reportPeriodLabel,
  reportAvailableFor,
  reportPresetPeriod,
  reportQueryPeriod,
  reportSheets,
  toCsv,
  type IncidentReportData,
} from './reports';

const today = '2026-11-05';

describe('report periods', () => {
  it('works out each preset', () => {
    expect(reportPresetPeriod('last_30_days', today)).toEqual({ from: '2026-10-07', to: today });
    expect(reportPresetPeriod('this_month', today)).toEqual({ from: '2026-11-01', to: today });
    expect(reportPresetPeriod('last_month', today)).toEqual({ from: '2026-10-01', to: '2026-10-31' });
    expect(reportPresetPeriod('this_quarter', today)).toEqual({ from: '2026-10-01', to: today });
    expect(reportPresetPeriod('last_quarter', today)).toEqual({ from: '2026-07-01', to: '2026-09-30' });
    expect(reportPresetPeriod('last_month', '2026-01-15')).toEqual({ from: '2025-12-01', to: '2025-12-31' });
    expect(reportPresetPeriod('last_12_months', today)).toEqual({ from: '2025-12-01', to: today });
  });

  it('compares a whole month or quarter with the one before, and other periods with the same number of days', () => {
    expect(previousReportPeriod({ from: '2026-10-01', to: '2026-10-31' })).toEqual({ from: '2026-09-01', to: '2026-09-30' });
    expect(previousReportPeriod({ from: '2026-07-01', to: '2026-09-30' })).toEqual({ from: '2026-04-01', to: '2026-06-30' });
    expect(previousReportPeriod({ from: '2026-10-07', to: '2026-11-05' })).toEqual({ from: '2026-09-07', to: '2026-10-06' });
  });

  it('labels periods', () => {
    expect(reportPeriodLabel({ from: '2026-08-01', to: '2026-10-31' })).toBe('1 Aug – 31 Oct 2026');
    expect(reportPeriodLabel({ from: '2025-12-01', to: '2026-01-31' })).toBe('1 Dec 2025 – 31 Jan 2026');
    expect(reportPeriodLabel({ from: today, to: today })).toBe('5 Nov 2026');
  });
});

describe('figures', () => {
  it('says which way a change went and whether that is good', () => {
    expect(figureChange({ label: 'x', value: 97.8, previous: 95.1, unit: '%', better: 'up' })).toEqual({ text: '▲ 2.7 pts', good: true });
    expect(figureChange({ label: 'x', value: 2, previous: 5, better: 'down' })).toEqual({ text: '▼ 3', good: true });
    expect(figureChange({ label: 'x', value: 4, previous: 4, better: 'up' })).toEqual({ text: 'No change', good: null });
    expect(figureChange({ label: 'x', value: 4, better: 'up' })).toBeNull();
  });
});

const incidents = (over: Partial<IncidentReportData> = {}): IncidentReportData => ({
  from: '', to: '', raised: 10, resolved: 8, reopened: 1, major: 0,
  by_priority: [{ priority: 'p1', count: 1 }, { priority: 'p2', count: 9 }],
  by_category: [], by_site: [{ site: 'LON01', count: 10 }],
  median_minutes_to_acknowledge: 6, median_hours_to_restore: 2, median_hours_to_resolve: 5,
  on_time: { response: { met: 9, missed: 1, percent: 90 }, restoration: { met: 8, missed: 2, percent: 80 }, resolution: { met: 7, missed: 1, percent: 88 } },
  backlog: { under1d: 1, d1to3: 1, d3to7: 0, over7d: 0 }, repeats: [], truncated: false, ...over,
});

describe('the incident report', () => {
  it('puts the previous period beside each figure and table', () => {
    const doc = buildIncidentReport(incidents(), incidents({ raised: 14, by_priority: [{ priority: 'p1', count: 3 }, { priority: 'p2', count: 11 }] }), { from: '2026-10-01', to: '2026-10-31' }, { from: '2026-09-01', to: '2026-09-30' });
    const figs = doc.sections[0]!;
    expect(figs.kind === 'figures' && figureChange(figs.figures[0]!)).toEqual({ text: '▼ 4', good: true });
    const byPriority = doc.sections.find((s) => s.kind === 'table' && s.title === 'By priority');
    expect(byPriority).toMatchObject({ columns: ['Priority', 'Raised', 'Before'], rows: [['P1 Critical', 1, 3], expect.any(Array)] });
    expect(doc.comparedWith).toEqual({ from: '2026-09-01', to: '2026-09-30' });
  });
});

describe('exports', () => {
  const doc = buildChangeLogReport(
    {
      from: '', to: '', truncated: false,
      rows: [
        { at: '2026-11-03T09:05:00Z', sitecode: 'LON01', objectType: 'user', objectId: 'a@contoso.test', cmdlet: 'Set-CsPhoneNumberAssignment', result: 'applied', message: null, operator: 'Eng One', deploymentId: 'd' },
        { at: '2026-11-03T09:06:00Z', sitecode: 'LON01', objectType: 'user', objectId: 'b@contoso.test', cmdlet: 'Set-CsPhoneNumberAssignment', result: 'failed', message: 'Number in use, "already"', operator: 'Eng One', deploymentId: 'd' },
      ],
    },
    { from: '2026-11-01', to: '2026-11-05' },
  );

  it('makes a Summary sheet and a sheet per table', () => {
    const sheets = reportSheets(doc, 'Contoso');
    expect(sheets.map((s) => s.name)).toEqual(['Summary', 'By kind of object', 'Every change']);
    expect(sheets[0]!.rows.slice(0, 3)).toEqual([['Change log'], ['Customer', 'Contoso'], ['Period', '1 Nov – 5 Nov 2026']]);
    expect(sheets[0]!.rows).toContainEqual(['Changes to Teams: Applied first time', 50, null]);
    expect(sheets[2]!.rows[0]).toEqual(['When (UTC)', 'Site', 'Object', 'Name or ID', 'Command', 'Result', 'Message', 'Run by']);
  });

  it('quotes CSV cells that need it, and names the file', () => {
    expect(toCsv([['a', 'b,c', 'say "hi"', null, 3]])).toBe('a,"b,c","say ""hi""",,3');
    expect(reportFileName(doc, 'AT&T Voice Consult')).toBe('voxshift-changes-at-t-voice-consult-2026-11-01-to-2026-11-05');
  });
});


describe('report queries and availability', () => {
  it('reads the period from the address', () => {
    expect(reportQueryPeriod({ period: 'last_month' }, today)).toEqual({ period: { from: '2026-10-01', to: '2026-10-31' }, preset: 'last_month' });
    expect(reportQueryPeriod({ from: '2026-08-01', to: '2026-08-31', period: 'last_month' }, today)).toEqual({ period: { from: '2026-08-01', to: '2026-08-31' }, preset: 'custom' });
    expect(reportQueryPeriod({ period: 'nonsense' }, today).preset).toBe('last_30_days');
  });
  it('offers a report only where its data can be read', () => {
    const all = () => true;
    expect(reportAvailableFor('executive', () => false, { managedServices: false, monitoring: false })).toBe(true);
    expect(reportAvailableFor('incidents', all, { managedServices: false, monitoring: true })).toBe(false);
    expect(reportAvailableFor('devices', all, { managedServices: true, monitoring: false })).toBe(false);
    expect(reportAvailableFor('changes', (p) => p === 'audit:read:tenant', { managedServices: false, monitoring: false })).toBe(true);
  });
});

describe('the Executive summary', () => {
  const site = (id: string, live: boolean, status: string, reason: string | null = null) => ({
    id, sitecode: id.toUpperCase(), name: null, stage: live ? 'operations' : 'designed', live, inService: live, users: 10, numbers: 10,
    targetGoLive: live ? null : '2026-11-20', firstGoLive: null, goLive: { status, reason, daysLeft: null }, blockers: 0,
  });
  const metrics = {
    asOf: '', period: { from: '', to: '' }, fullView: true, changes: { applied: 9, failed: 1, skipped: 0, firstTimePct: 90 },
    migration: { status: 'at_risk', sites: 3, sitesLive: 2, sitesInService: 2, sitesByStage: {}, users: 30, usersLive: 20, numbers: 30, numbersLive: 20, ports: { requests: 0, complete: 0 },
      nextGoLive: { siteId: 'c', sitecode: 'C', date: '2026-11-20' }, programmeEnd: '2026-11-20',
      siteList: [site('a', true, 'live'), site('b', true, 'live'), site('c', false, 'at_risk', 'There is no clean dry run yet and go-live is in 15 days')] },
    incidents: { raised: 5, resolved: 4, open: 1, openP1: 0, openP2: 0, targetsMetPct: 90, targetsMeasured: 10, medianMinutesToAcknowledge: 5, medianHoursToRestore: 1 },
  } as never;
  const history = [
    { day: '2026-09-30', sites: 3, sitesLive: 0, sitesInService: 0, users: 30, usersLive: 0, numbers: 30, numbersLive: 0 },
    { day: '2026-10-31', sites: 3, sitesLive: 1, sitesInService: 1, users: 30, usersLive: 10, numbers: 30, numbersLive: 10 },
  ];
  it('counts the migration as at the end of a past period and says what the period did', () => {
    const doc = buildExecutiveSummary({ metrics, previous: { ...(metrics as object), incidents: { ...(metrics as { incidents: object }).incidents, targetsMetPct: 80 } } as never, history, period: { from: '2026-10-01', to: '2026-10-31' }, comparedWith: { from: '2026-09-01', to: '2026-09-30' }, today });
    const head = doc.sections[0];
    expect(head).toMatchObject({ kind: 'headline', title: '1 of 3 sites live, 1 at risk' });
    expect(head?.kind === 'headline' && head.sentences.slice(0, 2)).toEqual([
      'In this period 10 users moved to Teams Phone and 1 site went live.',
      '90% of incident response and restore targets were met (80% the period before), from 5 incidents raised.',
    ]);
    const figs = doc.sections[1];
    expect(figs?.kind === 'figures' && figs.figures[0]).toMatchObject({ label: 'Users live', value: 10, previous: 0 });
    expect(doc.sections[2]).toMatchObject({ title: 'Risks and decisions', rows: [['C', 'At risk', 'There is no clean dry run yet and go-live is in 15 days']] });
  });
});

describe('scheduled report times', () => {
  it('sends on the 1st at 07:00 UTC, quarterly in January, April, July and October', async () => {
    const { nextScheduleRun } = await import('./reports');
    expect(nextScheduleRun('monthly', new Date('2026-11-05T10:00:00Z')).toISOString()).toBe('2026-12-01T07:00:00.000Z');
    expect(nextScheduleRun('monthly', new Date('2026-12-01T06:59:00Z')).toISOString()).toBe('2026-12-01T07:00:00.000Z');
    expect(nextScheduleRun('monthly', new Date('2026-12-01T07:00:00Z')).toISOString()).toBe('2027-01-01T07:00:00.000Z');
    expect(nextScheduleRun('quarterly', new Date('2026-11-05T10:00:00Z')).toISOString()).toBe('2027-01-01T07:00:00.000Z');
    expect(nextScheduleRun('quarterly', new Date('2027-01-01T07:00:00Z')).toISOString()).toBe('2027-04-01T07:00:00.000Z');
  });
});
