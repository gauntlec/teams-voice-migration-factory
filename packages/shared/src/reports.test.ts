import { describe, expect, it } from 'vitest';
import {
  buildChangeLogReport,
  buildIncidentReport,
  figureChange,
  previousReportPeriod,
  reportFileName,
  reportPeriodLabel,
  reportPresetPeriod,
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
