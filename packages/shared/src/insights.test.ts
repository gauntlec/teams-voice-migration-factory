import { describe, expect, it } from 'vitest';
import {
  customerGoLiveStatus,
  daysBetween,
  goLivePlan,
  insightsPeriod,
  insightsPeriodQuerySchema,
  overviewHeadline,
  siteGoLiveStatus,
  snapshotPoint,
  type GoLiveInput,
  type MetricSnapshot,
  type SiteMetrics,
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


describe('the Overview headline', () => {
  const s = (over: Partial<SiteMetrics>): SiteMetrics => ({
    id: 'x', sitecode: 'X', name: null, stage: 'designed', live: false, inService: false, users: 10, numbers: 10,
    targetGoLive: null, firstGoLive: null, goLive: { status: 'no_date', reason: null, daysLeft: null }, blockers: 0, ...over,
  });
  const m = (siteList: SiteMetrics[], over: Record<string, unknown> = {}) => ({
    migration: {
      status: 'on_track', sites: siteList.length, sitesLive: siteList.filter((x) => x.live).length, sitesInService: siteList.filter((x) => x.inService).length,
      sitesByStage: {}, users: siteList.reduce((n, x) => n + x.users, 0), usersLive: siteList.filter((x) => x.live).reduce((n, x) => n + x.users, 0),
      numbers: 0, numbersLive: 0, ports: { requests: 0, complete: 0 }, nextGoLive: null, programmeEnd: null, siteList, ...over,
    } as never,
  });

  it('says how many sites are live and when the programme ends', () => {
    const h = overviewHeadline(m(
      [s({ live: true, goLive: { status: 'live', reason: null, daysLeft: null } }), s({ sitecode: 'BHX02', targetGoLive: '2026-11-19', goLive: { status: 'on_track', reason: null, daysLeft: 14 } })],
      { nextGoLive: { siteId: 'b', sitecode: 'BHX02', date: '2026-11-19' }, programmeEnd: '2026-11-19' },
    ));
    expect(h).toEqual({ title: '1 of 2 sites live, on track for 19 Nov 2026', sentences: ['10 of 20 users are live on Teams Phone.', 'The next go-live is BHX02 on 19 Nov 2026.'] });
  });

  it('leads with the worst risk', () => {
    const h = overviewHeadline(m(
      [s({ sitecode: 'GLA01', goLive: { status: 'at_risk', reason: 'Site Data is not finished and go-live is in 20 days', daysLeft: 20 } }),
        s({ sitecode: 'MAN01', goLive: { status: 'off_track', reason: 'The go-live date (1 Nov 2026) has passed and the site is not live', daysLeft: -4 } })],
      { status: 'off_track' },
    ));
    expect(h.title).toBe('0 of 2 sites live, 1 off track');
    expect(h.sentences[1]).toBe('MAN01: The go-live date (1 Nov 2026) has passed and the site is not live.');
  });

  it('handles no sites and all sites live', () => {
    expect(overviewHeadline(m([], { status: 'no_sites' })).title).toBe('No sites yet');
    const done = overviewHeadline(m([s({ live: true, inService: true }), s({ live: true })], { status: 'complete' }));
    expect(done).toEqual({ title: 'All 2 sites are live', sentences: ['20 of 20 users are live on Teams Phone.', '1 site still to hand over to service.'] });
  });
});

describe('goLivePlan', () => {
  it('counts each site’s users from its target date', () => {
    const sites = [{ users: 5, live: true, targetGoLive: null }, { users: 10, live: false, targetGoLive: '2026-11-19' }, { users: 7, live: false, targetGoLive: null }];
    expect(goLivePlan(sites, ['2026-11-18', '2026-11-19', '2026-12-01'])).toEqual([5, 15, 15]);
  });
});
