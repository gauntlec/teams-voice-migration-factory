import { describe, expect, it } from 'vitest';
import {
  INC_CATEGORIES,
  INC_DEFAULT_TARGETS,
  INC_STATUSES,
  INC_DEFAULT_BUSINESS_TARGETS,
  incAddWorkingMs,
  incCoverFor,
  incClockCalendar,
  incSlaFor,
  incWorkingMs,
  type IncCalendar,
  createIncidentSchema,
  incCanReopen,
  incCleanAnswers,
  incEffectiveMatrix,
  incEffectiveTargets,
  incHoldPauses,
  incMoveKind,
  incNextClock,
  incPause,
  incPriority,
  incReference,
  incSla,
  incidentSettingsSchema,
  incidentStatusSchema,
  type IncSlaInput,
} from './incidents';
import { can } from './rbac';

const SITE = '11111111-1111-4111-8111-111111111111';
const valid = {
  title: 'No audio on calls',
  category: 'call_quality',
  subcategory: 'one_way_audio',
  siteId: SITE,
  impact: 'team',
  urgency: 'degraded',
  description: 'People at Reading hear nothing on inbound calls.',
  answers: { where: 'In the office on wifi', how_often: 'Every call', started: 'Today 09:00' },
};

describe('priority', () => {
  it('is impact x urgency', () => {
    expect(incPriority('company', 'cannot_call').priority).toBe('p1');
    expect(incPriority('site', 'degraded').priority).toBe('p2');
    expect(incPriority('team', 'cannot_call').priority).toBe('p2');
    expect(incPriority('individual', 'cannot_call').priority).toBe('p3');
    expect(incPriority('individual', 'question').priority).toBe('p4');
  });
  it('makes emergency calling P1 whatever the customer picked', () => {
    expect(incPriority('individual', 'question', 'emergency')).toEqual({ priority: 'p1', reason: 'emergency' });
  });
  it("uses a customer's own matrix over the default, cell by cell", () => {
    const m = incEffectiveMatrix({ matrix: { individual: { cannot_call: 'p2' } } });
    expect(incPriority('individual', 'cannot_call', null, m).priority).toBe('p2');
    expect(incPriority('individual', 'degraded', null, m).priority).toBe('p3');
  });
});

describe('categories', () => {
  it('have unique keys, sub-categories and question keys', () => {
    expect(new Set(INC_CATEGORIES.map((c) => c.key)).size).toBe(INC_CATEGORIES.length);
    for (const c of INC_CATEGORIES) {
      expect(new Set(c.subcategories.map((s) => s.key)).size).toBe(c.subcategories.length);
      expect(new Set(c.questions.map((q) => q.key)).size).toBe(c.questions.length);
      for (const q of c.questions) if (q.kind === 'select' || q.kind === 'choices') expect(q.options?.length).toBeGreaterThan(0);
    }
  });
  it('treat emergency calling as the only forced P1 and warn the customer', () => {
    const forced = INC_CATEGORIES.filter((c) => c.forcePriority);
    expect(forced.map((c) => c.key)).toEqual(['emergency']);
    expect(forced[0]!.warning).toMatch(/emergency services/);
  });
  it('checks answers: required, options, length; drops unknown keys', () => {
    expect(incCleanAnswers('call_quality', {}).ok).toBe(false);
    const ok = incCleanAnswers('call_quality', { where: 'Everywhere', how_often: 'Every call', started: ' today ', junk: 1 });
    expect(ok).toEqual({ ok: true, answers: { where: 'Everywhere', how_often: 'Every call', started: 'today' } });
    expect(incCleanAnswers('call_quality', { where: 'Mars', how_often: 'Every call', started: 'x' }).ok).toBe(false);
    expect(incCleanAnswers('direct_routing', { symptom: ['Nope'], started: 'x' }).ok).toBe(false);
    expect(incCleanAnswers('emergency', { what_happened: 'x', call_attempted: 'yes', started: 'x' }).ok).toBe(false);
  });
});

describe('create incident schema', () => {
  it('accepts a complete incident', () => {
    expect(createIncidentSchema.safeParse(valid).success).toBe(true);
  });
  it('needs a sub-category where the category has them, and a site where one is required', () => {
    expect(createIncidentSchema.safeParse({ ...valid, subcategory: undefined }).success).toBe(false);
    expect(createIncidentSchema.safeParse({ ...valid, subcategory: 'nope' }).success).toBe(false);
    expect(createIncidentSchema.safeParse({ ...valid, siteId: null }).success).toBe(false);
  });
  it('lets Direct Routing and "something else" be customer-wide', () => {
    const dr = { ...valid, category: 'direct_routing', subcategory: 'sbc_offline', siteId: null, answers: { symptom: ['All calls failing'], started: 'now' } };
    expect(createIncidentSchema.safeParse(dr).success).toBe(true);
    const other = { ...valid, category: 'other', subcategory: undefined, siteId: null, answers: {} };
    expect(createIncidentSchema.safeParse(other).success).toBe(true);
    expect(createIncidentSchema.safeParse({ ...other, subcategory: 'x' }).success).toBe(false);
  });
  it('rejects unanswered required questions and unknown fields', () => {
    expect(createIncidentSchema.safeParse({ ...valid, answers: {} }).success).toBe(false);
    expect(createIncidentSchema.safeParse({ ...valid, surprise: 1 }).success).toBe(false);
  });
});

describe('status moves', () => {
  it('names each allowed move', () => {
    expect(incMoveKind('new', 'in_progress')).toBe('acknowledge');
    expect(incMoveKind('in_progress', 'on_hold')).toBe('hold');
    expect(incMoveKind('on_hold', 'in_progress')).toBe('resume');
    expect(incMoveKind('in_progress', 'restored')).toBe('restore');
    expect(incMoveKind('restored', 'in_progress')).toBe('progress');
    expect(incMoveKind('restored', 'resolved')).toBe('resolve');
    expect(incMoveKind('resolved', 'closed')).toBe('close');
    expect(incMoveKind('resolved', 'in_progress')).toBe('reopen');
    expect(incMoveKind('closed', 'in_progress')).toBe('reopen');
    expect(incMoveKind('new', 'cancelled')).toBe('cancel');
    expect(incMoveKind('in_progress', 'duplicate')).toBe('duplicate');
  });
  it('refuses the rest, and nothing leaves a finished state except reopen', () => {
    expect(incMoveKind('new', 'closed')).toBeNull();
    expect(incMoveKind('on_hold', 'on_hold')).toBeNull();
    expect(incMoveKind('resolved', 'resolved')).toBeNull();
    for (const to of INC_STATUSES) {
      expect(incMoveKind('cancelled', to)).toBeNull();
      expect(incMoveKind('duplicate', to)).toBeNull();
      if (to !== 'in_progress') expect(incMoveKind('closed', to)).toBeNull();
    }
  });
  it('allows reopening for 7 days after resolving', () => {
    const resolved = '2026-10-01T10:00:00Z';
    expect(incCanReopen('resolved', resolved, Date.parse('2026-10-08T09:00:00Z'))).toBe(true);
    expect(incCanReopen('closed', resolved, Date.parse('2026-10-08T11:00:00Z'))).toBe(false);
    expect(incCanReopen('in_progress', resolved)).toBe(false);
  });
  it('formats the reference', () => {
    expect(incReference(42)).toBe('INC-0042');
  });
  it('parses a status request', () => {
    expect(incidentStatusSchema.safeParse({ to: 'on_hold', holdReason: 'carrier' }).success).toBe(true);
    expect(incidentStatusSchema.safeParse({ to: 'on_hold', holdReason: 'nobody' }).success).toBe(false);
  });
});

describe('holds and pauses', () => {
  it('pauses for the customer always, and for third parties except on a P1', () => {
    expect(incHoldPauses('p1', 'on_hold', 'customer')).toBe(true);
    expect(incHoldPauses('p1', 'on_hold', 'carrier')).toBe(false);
    expect(incHoldPauses('p2', 'on_hold', 'microsoft')).toBe(true);
    expect(incHoldPauses('p2', 'in_progress', null)).toBe(false);
  });
  it('opens a pause when a pausing hold starts and banks the time when it ends', () => {
    const base = { priority: 'p3' as const, status: 'in_progress' as const, hold_reason: null, paused_since: null, paused_seconds: 60 };
    const held = incPause(base, { priority: 'p3', status: 'on_hold', hold_reason: 'customer' }, '2026-10-01T10:00:00.000Z');
    expect(held).toEqual({ paused_since: '2026-10-01T10:00:00.000Z', paused_seconds: 60, pause_log: [] });
    const resumed = incPause({ ...base, ...held, status: 'on_hold', hold_reason: 'customer' }, { priority: 'p3', status: 'in_progress', hold_reason: null }, '2026-10-01T10:30:00.000Z');
    expect(resumed).toEqual({ paused_since: null, paused_seconds: 60 + 1800, pause_log: [{ from: '2026-10-01T10:00:00.000Z', to: '2026-10-01T10:30:00.000Z' }] });
  });
  it('stops pausing when a priority change makes the hold a running one', () => {
    const prev = { priority: 'p2' as const, status: 'on_hold' as const, hold_reason: 'carrier' as const, paused_since: '2026-10-01T10:00:00.000Z', paused_seconds: 0 };
    expect(incPause(prev, { priority: 'p1', status: 'on_hold', hold_reason: 'carrier' }, '2026-10-01T11:00:00.000Z')).toEqual({ paused_since: null, paused_seconds: 3600, pause_log: [{ from: '2026-10-01T10:00:00.000Z', to: '2026-10-01T11:00:00.000Z' }] });
  });
});

describe('clocks', () => {
  const T0 = Date.parse('2026-10-01T10:00:00Z');
  const row = (over: Partial<IncSlaInput> = {}): IncSlaInput => ({
    priority: 'p1',
    status: 'new',
    created_at: new Date(T0).toISOString(),
    acknowledged_at: null,
    restored_at: null,
    resolved_at: null,
    paused_since: null,
    paused_seconds: 0,
    ...over,
  });
  it('runs response first, with a warning near the end and overdue after', () => {
    expect(incSla(row(), INC_DEFAULT_TARGETS, T0 + 5 * 60_000).response.state).toBe('on_track');
    expect(incSla(row(), INC_DEFAULT_TARGETS, T0 + 13 * 60_000).response.state).toBe('at_risk');
    expect(incSla(row(), INC_DEFAULT_TARGETS, T0 + 16 * 60_000).response.state).toBe('overdue');
  });
  it('is met when acknowledged in time and missed when late', () => {
    const now = T0 + 10 * 3_600_000;
    expect(incSla(row({ acknowledged_at: new Date(T0 + 10 * 60_000).toISOString() }), INC_DEFAULT_TARGETS, now).response.state).toBe('met');
    expect(incSla(row({ acknowledged_at: new Date(T0 + 40 * 60_000).toISOString() }), INC_DEFAULT_TARGETS, now).response.state).toBe('missed');
  });
  it('counts resolving as restoring when nothing was restored first', () => {
    const r = row({ status: 'resolved', acknowledged_at: new Date(T0).toISOString(), resolved_at: new Date(T0 + 2 * 3_600_000).toISOString() });
    const sla = incSla(r, INC_DEFAULT_TARGETS, T0 + 9 * 3_600_000);
    expect(sla.restoration.state).toBe('met');
    expect(sla.resolution.state).toBe('met');
  });
  it('has no restoration target for P4', () => {
    expect(incSla(row({ priority: 'p4' }), INC_DEFAULT_TARGETS, T0).restoration.state).toBe('none');
  });
  it('pauses while held and pushes the due time out by the time paused', () => {
    const held = row({ priority: 'p3', status: 'on_hold', acknowledged_at: new Date(T0).toISOString(), paused_since: new Date(T0 + 3_600_000).toISOString() });
    const sla = incSla(held, INC_DEFAULT_TARGETS, T0 + 5 * 3_600_000);
    expect(sla.restoration.state).toBe('paused');
    const again = incSla({ ...held, status: 'in_progress', paused_since: null, paused_seconds: 4 * 3600 }, INC_DEFAULT_TARGETS, T0 + 5 * 3_600_000);
    expect(new Date(again.restoration.dueAt!).getTime()).toBe(T0 + 24 * 3_600_000 + 4 * 3_600_000);
  });
  it('stops every clock for cancelled and duplicate incidents', () => {
    for (const status of ['cancelled', 'duplicate'] as const) {
      const sla = incSla(row({ status }), INC_DEFAULT_TARGETS, T0 + 99 * 3_600_000);
      expect([sla.response.state, sla.restoration.state, sla.resolution.state]).toEqual(['stopped', 'stopped', 'stopped']);
    }
  });
  it('restarts restoration and resolution from a reopen, not response', () => {
    const r = row({
      status: 'in_progress',
      acknowledged_at: new Date(T0).toISOString(),
      reopened_at: new Date(T0 + 48 * 3_600_000).toISOString(),
    });
    const sla = incSla(r, INC_DEFAULT_TARGETS, T0 + 49 * 3_600_000);
    expect(sla.response.state).toBe('met');
    expect(sla.restoration.state).toBe('on_track');
  });
  it('shows the clock that matters now', () => {
    const at = T0 + 20 * 60_000;
    expect(incNextClock(incSla(row(), INC_DEFAULT_TARGETS, at)).which).toBe('response');
    expect(incNextClock(incSla(row({ status: 'in_progress', acknowledged_at: new Date(T0).toISOString() }), INC_DEFAULT_TARGETS, at)).which).toBe('restoration');
    expect(
      incNextClock(incSla(row({ status: 'restored', acknowledged_at: new Date(T0).toISOString(), restored_at: new Date(T0 + 3600_000).toISOString() }), INC_DEFAULT_TARGETS, at)).which,
    ).toBe('resolution');
  });
});

describe('working hours', () => {
  const CAL: IncCalendar = { days: [1, 2, 3, 4, 5], start: '08:00', end: '18:00', timeZone: 'Europe/London', holidays: [] };
  const z = (iso: string) => Date.parse(iso);

  it('adds working time across the evening', () => {
    // Mon 16:30 BST + 3h = 1.5h that evening + 1.5h on Tue morning
    expect(incAddWorkingMs(z('2026-10-12T15:30:00Z'), 3 * 3_600_000, CAL)).toBe(z('2026-10-13T08:30:00Z'));
  });
  it('skips the weekend, and the clocks going back', () => {
    // Fri 17:00 BST + 2h = 1h Friday + 1h from Mon 08:00 GMT (the clocks went back on Sunday)
    expect(incAddWorkingMs(z('2026-10-23T16:00:00Z'), 2 * 3_600_000, CAL)).toBe(z('2026-10-26T09:00:00Z'));
  });
  it('skips a holiday', () => {
    const cal = { ...CAL, holidays: ['2026-10-13'] };
    expect(incAddWorkingMs(z('2026-10-12T16:30:00Z'), 3_600_000, cal)).toBe(z('2026-10-14T07:30:00Z'));
  });
  it('counts only working time between two instants', () => {
    expect(incWorkingMs(z('2026-10-24T10:00:00Z'), z('2026-10-26T09:00:00Z'), CAL)).toBe(3_600_000); // Sat noon to Mon 09:00 GMT
    expect(incWorkingMs(z('2026-10-12T05:00:00Z'), z('2026-10-12T23:00:00Z'), CAL)).toBe(10 * 3_600_000);
    expect(incWorkingMs(z('2026-10-12T10:00:00Z'), z('2026-10-12T09:00:00Z'), CAL)).toBe(0);
  });
  it('falls back to calendar time rather than looping forever when every day is off', () => {
    const never = { ...CAL, days: [0], holidays: [] };
    const cal = { ...never, days: [1], holidays: Array.from({ length: 1000 }, (_, i) => new Date(Date.UTC(2026, 0, 5 + 7 * i)).toISOString().slice(0, 10)) };
    expect(incAddWorkingMs(z('2026-10-12T10:00:00Z'), 3_600_000, cal)).toBe(z('2026-10-12T11:00:00Z'));
  });

  const row = (over: Partial<IncSlaInput> = {}): IncSlaInput => ({
    priority: 'p3',
    status: 'new',
    created_at: '2026-10-23T16:00:00Z', // Fri 17:00 BST
    acknowledged_at: null,
    restored_at: null,
    resolved_at: null,
    paused_since: null,
    paused_seconds: 0,
    ...over,
  });
  const targets = { ...INC_DEFAULT_TARGETS, p3: { responseMinutes: 240, restoreHours: 8, resolveHours: 24 } };

  it('runs the response clock through working hours only', () => {
    // 4h to respond: 1h on Friday, 3h on Monday from 08:00 GMT
    const sla = incSla(row(), targets, z('2026-10-24T12:00:00Z'), CAL);
    expect(sla.response.state).toBe('on_track');
    expect(sla.response.dueAt).toBe('2026-10-26T11:00:00.000Z');
    expect(incSla(row(), targets, z('2026-10-26T11:30:00Z'), CAL).response.state).toBe('overdue');
    expect(incSla(row(), targets, z('2026-10-26T10:30:00Z'), CAL).response.state).toBe('at_risk');
  });
  it('is met by acknowledging in working time, however long it took on the clock', () => {
    const sla = incSla(row({ acknowledged_at: '2026-10-26T10:00:00Z' }), targets, z('2026-10-27T10:00:00Z'), CAL);
    expect(sla.response.state).toBe('met'); // 1h + 2h of working time
    expect(incSla(row({ acknowledged_at: '2026-10-26T10:00:00Z' }), targets, z('2026-10-27T10:00:00Z')).response.state).toBe('missed'); // same incident on 24x7 cover
  });
  it('leaves out only the working time spent paused', () => {
    const weekend = incSla(row({ pause_log: [{ from: '2026-10-24T08:00:00Z', to: '2026-10-25T08:00:00Z' }], paused_seconds: 86_400 }), targets, z('2026-10-24T12:00:00Z'), CAL);
    expect(weekend.response.dueAt).toBe('2026-10-26T11:00:00.000Z'); // a pause over the weekend costs nothing
    const monday = incSla(row({ pause_log: [{ from: '2026-10-26T08:30:00Z', to: '2026-10-26T09:30:00Z' }], paused_seconds: 3600 }), targets, z('2026-10-26T09:45:00Z'), CAL);
    expect(monday.response.dueAt).toBe('2026-10-26T12:00:00.000Z'); // an hour of working time paused moves it an hour
    const held = incSla(row({ paused_since: '2026-10-26T08:30:00Z' }), targets, z('2026-10-26T10:00:00Z'), CAL);
    expect(held.response.state).toBe('paused');
  });
  it('picks cover per priority and only with a calendar', () => {
    expect(incCoverFor({}, 'p3')).toBe('24x7');
    expect(incCoverFor({ calendar: CAL }, 'p1')).toBe('24x7');
    expect(incCoverFor({ calendar: CAL }, 'p3')).toBe('business');
    expect(incCoverFor({ calendar: CAL, cover: { p3: '24x7', p2: 'business' } }, 'p3')).toBe('24x7');
    expect(incCoverFor({ calendar: CAL, cover: { p2: 'business' } }, 'p2')).toBe('business');
    expect(incClockCalendar({ calendar: CAL }, 'p3')).toBe(CAL);
    expect(incClockCalendar({ calendar: CAL }, 'p1')).toBeNull();
  });
  it('uses working-hour target defaults on business cover until the customer sets their own', () => {
    expect(incEffectiveTargets({}).p3).toEqual(INC_DEFAULT_TARGETS.p3);
    expect(incEffectiveTargets({ calendar: CAL }).p3).toEqual(INC_DEFAULT_BUSINESS_TARGETS.p3);
    expect(incEffectiveTargets({ calendar: CAL }).p1).toEqual(INC_DEFAULT_TARGETS.p1);
    expect(incEffectiveTargets({ calendar: CAL, targets: { p3: { responseMinutes: 30, restoreHours: 2, resolveHours: 4 } } }).p3.responseMinutes).toBe(30);
  });
  it('gives clocks and targets together for an incident', () => {
    const r = incSlaFor(row(), { calendar: CAL }, z('2026-10-24T12:00:00Z'));
    expect(r.cover).toBe('business');
    expect(r.target).toEqual(INC_DEFAULT_BUSINESS_TARGETS.p3);
    expect(incSlaFor({ ...row(), priority: 'p1' }, { calendar: CAL }, z('2026-10-24T12:00:00Z')).cover).toBe('24x7');
  });
  it('validates the calendar and cover settings', () => {
    const ok = { calendar: { days: [1, 2, 3, 4, 5], start: '08:00', end: '18:00', timeZone: 'Europe/London', holidays: ['2026-12-25'] }, cover: { p2: 'business' } };
    expect(incidentSettingsSchema.safeParse(ok).success).toBe(true);
    expect(incidentSettingsSchema.safeParse({ calendar: null }).success).toBe(true);
    expect(incidentSettingsSchema.safeParse({ calendar: { ...ok.calendar, end: '07:00' } }).success).toBe(false);
    expect(incidentSettingsSchema.safeParse({ calendar: { ...ok.calendar, timeZone: 'Mars/Base' } }).success).toBe(false);
    expect(incidentSettingsSchema.safeParse({ calendar: { ...ok.calendar, holidays: ['25/12/2026'] } }).success).toBe(false);
    expect(incidentSettingsSchema.safeParse({ cover: { p1: 'sometimes' } }).success).toBe(false);
  });
});

describe('settings', () => {
  it('fills in default targets per priority', () => {
    const t = incEffectiveTargets({ targets: { p1: { responseMinutes: 5, restoreHours: 2, resolveHours: 4 } } });
    expect(t.p1.responseMinutes).toBe(5);
    expect(t.p2).toEqual(INC_DEFAULT_TARGETS.p2);
  });
  it('validates targets and matrix', () => {
    expect(incidentSettingsSchema.safeParse({ targets: { p1: { responseMinutes: 5, restoreHours: 2, resolveHours: 4 } }, matrix: { team: { cannot_call: 'p1' } } }).success).toBe(true);
    expect(incidentSettingsSchema.safeParse({ targets: { p1: { responseMinutes: 5, restoreHours: 8, resolveHours: 4 } } }).success).toBe(false);
    expect(incidentSettingsSchema.safeParse({ matrix: { team: { cannot_call: 'p9' } } }).success).toBe(false);
  });
});

describe('permissions', () => {
  it('lets every role see and raise, and only engineers and admins manage', () => {
    for (const role of ['SUPER_ADMIN', 'PROJECT_MANAGER', 'ENGINEER', 'CUSTOMER'] as const) {
      expect(can(role, 'inc:read')).toBe(true);
      expect(can(role, 'inc:create')).toBe(true);
    }
    expect(can('CUSTOMER', 'inc:manage')).toBe(false);
    expect(can('PROJECT_MANAGER', 'inc:manage')).toBe(false);
    expect(can('ENGINEER', 'inc:manage')).toBe(true);
    expect(can('SUPER_ADMIN', 'inc:manage')).toBe(true);
    expect(can('CUSTOMER', 'inc:msp')).toBe(false);
    expect(can('PROJECT_MANAGER', 'inc:msp')).toBe(true);
  });
});
