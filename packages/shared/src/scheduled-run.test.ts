import { describe, expect, it } from 'vitest';
import { scheduledRunProblem } from './scheduled-run';

const now = new Date('2026-10-26T17:30:00Z');
describe('scheduledRunProblem', () => {
  it('allows a start later today or tomorrow', () => {
    expect(scheduledRunProblem('2026-10-26T19:00:00Z', now, null)).toBeNull();
    expect(scheduledRunProblem('2026-10-27T06:00:00+01:00', now, null)).toBeNull();
  });
  it('refuses the past, now, more than a day ahead, and an update in between', () => {
    expect(scheduledRunProblem('2026-10-26T17:00:00Z', now, null)).toMatch(/at least a minute/);
    expect(scheduledRunProblem('2026-10-28T19:00:00Z', now, null)).toMatch(/up to 24 hours/);
    expect(scheduledRunProblem('2026-10-26T23:00:00Z', now, '2026-10-26T22:00:00Z')).toMatch(/update is planned for 2026-10-26 22:00 UTC/);
    expect(scheduledRunProblem('2026-10-26T21:00:00Z', now, '2026-10-26T22:00:00Z')).toBeNull();
  });
});
