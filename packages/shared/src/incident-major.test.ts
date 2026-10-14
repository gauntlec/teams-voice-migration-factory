import { describe, expect, it } from 'vitest';
import {
  INC_MAJOR_DEFAULT_INTERVAL,
  createProblemSchema,
  declareMajorSchema,
  incIsKnownError,
  incMajorActive,
  incMajorUpdateClock,
  incProblemMatches,
  incProblemReference,
  incidentReviewSchema,
  knownErrorsQuerySchema,
  linkChildrenSchema,
  majorUpdateSchema,
  mspIncidentsQuerySchema,
  updateProblemSchema,
} from './incident-major';
import { incidentSettingsSchema, incidentStatusSchema } from './incidents';

const ID = '11111111-1111-4111-8111-111111111111';
const NOW = Date.parse('2026-10-14T12:00:00Z');
const major = (over: Record<string, unknown> = {}) => ({ major: true, major_ended_at: null, status: 'in_progress' as const, next_update_due_at: '2026-10-14T12:30:00Z', ...over });

describe('major incidents', () => {
  it('are live from declaration until resolved, cancelled or merged', () => {
    expect(incMajorActive(major())).toBe(true);
    for (const status of ['new', 'on_hold', 'restored'] as const) expect(incMajorActive(major({ status }))).toBe(true);
    for (const status of ['resolved', 'closed', 'cancelled', 'duplicate'] as const) expect(incMajorActive(major({ status }))).toBe(false);
    expect(incMajorActive(major({ major_ended_at: '2026-10-14T11:00:00Z' }))).toBe(false);
    expect(incMajorActive(major({ major: false }))).toBe(false);
  });

  it('tracks the cadence of customer updates: on track, due, then late enough to escalate', () => {
    expect(incMajorUpdateClock(major(), NOW).state).toBe('on_track');
    expect(incMajorUpdateClock(major({ next_update_due_at: '2026-10-14T11:55:00Z' }), NOW).state).toBe('due');
    expect(incMajorUpdateClock(major({ next_update_due_at: '2026-10-14T11:40:00Z' }), NOW).state).toBe('overdue');
    expect(incMajorUpdateClock(major({ next_update_due_at: '2026-10-14T11:40:00Z' }), NOW).leftMs).toBe(-20 * 60_000);
    expect(incMajorUpdateClock(major({ status: 'resolved' }), NOW)).toEqual({ state: 'none', dueAt: null, leftMs: null });
    expect(incMajorUpdateClock(major({ next_update_due_at: null }), NOW).state).toBe('none');
  });

  it('update every 30 minutes for a P1 and hourly for a P2 unless told otherwise', () => {
    expect(INC_MAJOR_DEFAULT_INTERVAL.p1).toBe(30);
    expect(INC_MAJOR_DEFAULT_INTERVAL.p2).toBe(60);
  });

  it('are declared with a lead and a first update', () => {
    expect(declareMajorSchema.safeParse({ leadId: ID, summary: 'Calls at Reading are failing; we are checking the SBC.' }).success).toBe(true);
    expect(declareMajorSchema.safeParse({ leadId: ID, commsId: ID, intervalMinutes: 15, summary: 'We are looking.' }).success).toBe(true);
    expect(declareMajorSchema.safeParse({ leadId: ID, summary: 'x' }).success).toBe(false);
    expect(declareMajorSchema.safeParse({ summary: 'We are looking at it.' }).success).toBe(false);
    expect(declareMajorSchema.safeParse({ leadId: ID, summary: 'We are looking.', intervalMinutes: 5 }).success).toBe(false);
    expect(declareMajorSchema.safeParse({ leadId: ID, summary: 'We are looking.', intervalMinutes: 600 }).success).toBe(false);
    expect(majorUpdateSchema.safeParse({ body: 'Carrier engaged.', intervalMinutes: 20 }).success).toBe(true);
    expect(majorUpdateSchema.safeParse({ body: '' }).success).toBe(false);
  });

  it('link up to 50 children and need at least one', () => {
    expect(linkChildrenSchema.safeParse({ childIds: [ID] }).success).toBe(true);
    expect(linkChildrenSchema.safeParse({ childIds: [] }).success).toBe(false);
    expect(linkChildrenSchema.safeParse({ childIds: ['nope'] }).success).toBe(false);
  });

  it('can ask for children to be resolved with the parent', () => {
    expect(incidentStatusSchema.safeParse({ to: 'resolved', note: 'Fixed', resolveChildren: true }).success).toBe(true);
  });
});

describe('problems', () => {
  it('are numbered PRB-0001', () => {
    expect(incProblemReference(3)).toBe('PRB-0003');
  });

  it('are known errors once the cause is understood and there is a way round it', () => {
    expect(incIsKnownError({ status: 'known_error', workaround: 'Fail over to SBC 2' })).toBe(true);
    expect(incIsKnownError({ status: 'fix_planned', workaround: 'Fail over to SBC 2' })).toBe(true);
    expect(incIsKnownError({ status: 'known_error', workaround: '  ' })).toBe(false);
    expect(incIsKnownError({ status: 'investigating', workaround: 'Fail over' })).toBe(false);
    expect(incIsKnownError({ status: 'resolved', workaround: 'Fail over' })).toBe(false);
  });

  it('match incidents of their category, and their sub-category when they name one', () => {
    expect(incProblemMatches({ category: 'call_quality', subcategory: null }, 'call_quality', 'echo')).toBe(true);
    expect(incProblemMatches({ category: 'call_quality', subcategory: 'echo' }, 'call_quality', 'echo')).toBe(true);
    expect(incProblemMatches({ category: 'call_quality', subcategory: 'echo' }, 'call_quality', 'latency')).toBe(false);
    expect(incProblemMatches({ category: 'call_quality', subcategory: null }, 'users', null)).toBe(false);
    expect(incProblemMatches({ category: null, subcategory: null }, 'users', null)).toBe(false);
  });

  it('are created with defaults and changed a field at a time', () => {
    const p = createProblemSchema.parse({ title: 'SBC certificate renewal keeps slipping' });
    expect(p).toMatchObject({ status: 'investigating', workaround: '', category: null, ownerId: null });
    expect(createProblemSchema.safeParse({ title: 'x' }).success).toBe(false);
    expect(createProblemSchema.safeParse({ title: 'A real title', category: 'nope' }).success).toBe(false);
    expect(updateProblemSchema.safeParse({ status: 'known_error' }).success).toBe(true);
    expect(updateProblemSchema.safeParse({ status: 'solved' }).success).toBe(false);
    expect(updateProblemSchema.safeParse({}).success).toBe(true);
    expect(knownErrorsQuerySchema.safeParse({ category: 'call_quality', subcategory: 'echo' }).success).toBe(true);
  });
});

describe('reviews, queue and settings', () => {
  it('accept a review with actions, and reject an unknown field or a bad date', () => {
    const ok = { summary: 'A', cause: 'B', wentWell: 'C', wentBadly: 'D', actions: [{ text: 'Renew the certificate', owner: 'Ed', due: '2026-11-01' }] };
    expect(incidentReviewSchema.safeParse(ok).success).toBe(true);
    expect(incidentReviewSchema.safeParse({ ...ok, actions: [{ text: 'x', due: '1 Nov' }] }).success).toBe(false);
    expect(incidentReviewSchema.safeParse({ ...ok, extra: 1 }).success).toBe(false);
  });

  it('parses the MSP queue filters', () => {
    expect(mspIncidentsQuerySchema.parse({}).status).toBe('open');
    expect(mspIncidentsQuerySchema.safeParse({ status: 'all', mine: 'true', priority: 'p1' }).success).toBe(true);
    expect(mspIncidentsQuerySchema.safeParse({ mspId: 'none' }).success).toBe(true);
    expect(mspIncidentsQuerySchema.safeParse({ priority: 'p9' }).success).toBe(false);
  });

  it('take a list of stakeholders in the settings', () => {
    expect(incidentSettingsSchema.safeParse({ stakeholders: [ID] }).success).toBe(true);
    expect(incidentSettingsSchema.safeParse({ stakeholders: ['bob'] }).success).toBe(false);
  });
});
