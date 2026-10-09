import { describe, expect, it } from 'vitest';
import { SR_DEFAULT_TARGETS, serviceRequestSettingsSchema, srDuration, srEffectiveTargets, srNextClock, srSla } from './service-request-sla';

const H = 3_600_000;
const now = Date.parse('2026-10-09T12:00:00Z');
const base = { priority: 'normal' as const, status: 'new' as const, first_response_at: null, deployed_at: null, waiting_since: null, waiting_seconds: 0 };
const at = (hoursAgo: number) => new Date(now - hoursAgo * H).toISOString();

describe('srSla', () => {
  it('is on track, then at risk, then overdue', () => {
    expect(srSla({ ...base, created_at: at(1) }, SR_DEFAULT_TARGETS, now).response.state).toBe('on_track');
    expect(srSla({ ...base, created_at: at(7) }, SR_DEFAULT_TARGETS, now).response.state).toBe('at_risk'); // 8h target, 1h left
    expect(srSla({ ...base, created_at: at(9) }, SR_DEFAULT_TARGETS, now).response.state).toBe('overdue');
  });
  it('leaves waiting time out', () => {
    const r = srSla({ ...base, created_at: at(9), waiting_seconds: 3 * 3600 }, SR_DEFAULT_TARGETS, now);
    expect(r.response.state).toBe('on_track');
    expect(srSla({ ...base, created_at: at(9), waiting_since: at(1) }, SR_DEFAULT_TARGETS, now).response.state).toBe('paused');
  });
  it('marks met and missed', () => {
    const r = srSla({ ...base, status: 'deployed', created_at: at(100), first_response_at: at(99), deployed_at: at(20) }, SR_DEFAULT_TARGETS, now);
    expect(r.response.state).toBe('met');
    expect(r.resolution.state).toBe('missed'); // 80h > 72h
  });
  it('stops both clocks when cancelled', () => {
    const r = srSla({ ...base, status: 'cancelled', created_at: at(500) }, SR_DEFAULT_TARGETS, now);
    expect([r.response.state, r.resolution.state]).toEqual(['stopped', 'stopped']);
  });
  it('restarts resolution on reopen', () => {
    const r = srSla({ ...base, status: 'planned', created_at: at(500), first_response_at: at(499), reopened_at: at(1) }, SR_DEFAULT_TARGETS, now);
    expect(r.resolution.state).toBe('on_track');
    expect(srNextClock(r).which).toBe('resolution');
  });
});

describe('settings', () => {
  it('fills in defaults', () => {
    expect(srEffectiveTargets({ targets: { urgent: { responseHours: 2, resolveHours: 6 } } }).urgent.responseHours).toBe(2);
    expect(srEffectiveTargets({}).low).toEqual(SR_DEFAULT_TARGETS.low);
  });
  it('validates targets, approvals and the window', () => {
    expect(serviceRequestSettingsSchema.safeParse({ targets: { normal: { responseHours: 10, resolveHours: 2 } } }).success).toBe(false);
    expect(serviceRequestSettingsSchema.safeParse({ approval: { types: ['new_user'], approverIds: [] } }).success).toBe(false);
    expect(serviceRequestSettingsSchema.safeParse({ changeWindow: { days: [1], start: '22:00', end: '06:00', timeZone: 'Europe/London' } }).success).toBe(false);
    expect(serviceRequestSettingsSchema.safeParse({ changeWindow: { days: [1], start: '18:00', end: '22:00', timeZone: 'Mars/Base' } }).success).toBe(false);
    expect(serviceRequestSettingsSchema.safeParse({ changeWindow: null }).success).toBe(true);
  });
  it('formats durations', () => {
    expect(srDuration(90 * 60_000)).toBe('1h 30m');
    expect(srDuration(-26 * H)).toBe('1d 2h');
  });
});
