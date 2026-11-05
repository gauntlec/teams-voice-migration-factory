import { describe, expect, it } from 'vitest';
import {
  customerGoLiveStatus,
  daysBetween,
  insightsPeriod,
  insightsPeriodQuerySchema,
  siteGoLiveStatus,
  snapshotPoint,
  type GoLiveInput,
  type MetricSnapshot,
} from './insights';

const today = '2026-11-05';
const site = (over: Partial<GoLiveInput> = {}): GoLiveInput => ({
  live: false,
  targetGoLive: '2027-03-04',
  current: 'designed',
  dryRunDone: false,
  blockers: 0,
  ...over,
});

describe('siteGoLiveStatus', () => {
  it('is live once the site is live, whatever the date', () => {
    expect(siteGoLiveStatus(site({ live: true, targetGoLive: '2026-10-01' }), today).status).toBe('live');
    expect(siteGoLiveStatus(site({ live: true, targetGoLive: null }), today)).toEqual({ status: 'live', reason: null, daysLeft: null });
  });

  it('has no status without a date', () => {
    expect(siteGoLiveStatus(site({ targetGoLive: null }), today).status).toBe('no_date');
  });

  it('is off track once the date has passed', () => {
    const r = siteGoLiveStatus(site({ targetGoLive: '2026-11-04', dryRunDone: true }), today);
    expect(r.status).toBe('off_track');
    expect(r.daysLeft).toBe(-1);
    expect(r.reason).toContain('4 Nov 2026');
  });

  it('is at risk when Site Data is unfinished within 30 days', () => {
    expect(siteGoLiveStatus(site({ current: 'data_collection', targetGoLive: '2026-12-05' }), today).status).toBe('at_risk');
    expect(siteGoLiveStatus(site({ current: 'data_collection', targetGoLive: '2026-12-06' }), today).status).toBe('on_track');
  });

  it('is at risk with blockers or no clean dry run within 14 days', () => {
    expect(siteGoLiveStatus(site({ targetGoLive: '2026-11-19', dryRunDone: true, blockers: 2 }), today).reason).toBe('2 things need fixing and go-live is in 14 days');
    expect(siteGoLiveStatus(site({ targetGoLive: '2026-11-19' }), today).reason).toBe('There is no clean dry run yet and go-live is in 14 days');
    expect(siteGoLiveStatus(site({ targetGoLive: '2026-11-20' }), today).status).toBe('on_track');
    expect(siteGoLiveStatus(site({ targetGoLive: '2026-11-05', dryRunDone: true }), today)).toEqual({ status: 'on_track', reason: null, daysLeft: 0 });
  });
});

describe('customerGoLiveStatus', () => {
  const s = (status: 'live' | 'on_track' | 'at_risk' | 'off_track' | 'no_date') => ({ goLive: { status } });
  it('is the worst unfinished site', () => {
    expect(customerGoLiveStatus([])).toBe('no_sites');
    expect(customerGoLiveStatus([s('live'), s('live')])).toBe('complete');
    expect(customerGoLiveStatus([s('live'), s('on_track'), s('no_date')])).toBe('on_track');
    expect(customerGoLiveStatus([s('on_track'), s('at_risk')])).toBe('at_risk');
    expect(customerGoLiveStatus([s('at_risk'), s('off_track')])).toBe('off_track');
    expect(customerGoLiveStatus([s('live'), s('no_date')])).toBe('no_date');
  });
});

describe('periods', () => {
  it('defaults to the 30 days up to today, to exclusive', () => {
    expect(insightsPeriod({}, new Date('2026-11-05T10:00:00Z'))).toEqual({ from: '2026-10-07T00:00:00.000Z', to: '2026-11-06T00:00:00.000Z' });
    expect(insightsPeriod({ from: '2026-08-01', to: '2026-10-31' })).toEqual({ from: '2026-08-01T00:00:00.000Z', to: '2026-11-01T00:00:00.000Z' });
  });
  it('refuses a backwards or too-long period', () => {
    expect(insightsPeriodQuerySchema.safeParse({ from: '2026-11-02', to: '2026-11-01' }).success).toBe(false);
    expect(insightsPeriodQuerySchema.safeParse({ from: '2025-01-01', to: '2026-11-01' }).success).toBe(false);
    expect(insightsPeriodQuerySchema.safeParse({ from: '2026-08-01', to: '2026-10-31' }).success).toBe(true);
  });
  it('counts calendar days', () => {
    expect(daysBetween('2026-10-31', '2026-11-01')).toBe(1);
  });
});

describe('snapshotPoint', () => {
  const snap: MetricSnapshot = {
    v: 1,
    sites: [
      { id: 'a', stage: 'operations', live: true, inService: true, users: 40, numbers: 50, goLive: 'live', targetGoLive: null },
      { id: 'b', stage: 'dry_run', live: false, inService: false, users: 10, numbers: 12, goLive: 'on_track', targetGoLive: '2026-12-01' },
    ],
    incidents: { open: 3, openP1: 0, openP2: 1 },
    serviceRequests: { open: 4 },
  };
  it('adds up the sites', () => {
    expect(snapshotPoint('2026-11-05', snap)).toEqual({
      day: '2026-11-05', sites: 2, sitesLive: 1, sitesInService: 1, users: 50, usersLive: 40, numbers: 62, numbersLive: 50, openIncidents: 3, openServiceRequests: 4,
    });
  });
  it('limits a site contact to their sites and leaves out customer-wide figures', () => {
    expect(snapshotPoint('2026-11-05', snap, ['b'])).toEqual({ day: '2026-11-05', sites: 1, sitesLive: 0, sitesInService: 0, users: 10, usersLive: 0, numbers: 12, numbersLive: 0 });
  });
});
