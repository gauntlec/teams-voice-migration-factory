import { describe, expect, it } from 'vitest';
import {
  maintenanceFreezeMessage,
  maintenancePhase,
  sandboxRedirect,
  setMaintenanceNoticeSchema,
  summarizeReleaseCheck,
  viewMaintenanceNotice,
  type ReleaseCheckConnection,
  type ReleaseCheckDeployment,
  type ReleaseCheckDiscoveryRun,
} from './release-safety';

const owner = { ownerId: 'u1', ownerName: 'Sam', ownerEmail: 'sam@msp.test', tenantId: 't1', tenantName: 'Contoso', startedAt: '2026-10-12T10:00:00Z' };
const conn: ReleaseCheckConnection = { ...owner, id: 'c1', status: 'active', upn: 'admin@contoso.test' };
const run: ReleaseCheckDiscoveryRun = { ...owner, id: 'r1', status: 'running', kind: 'sync' };
const dep = (mode: 'dry_run' | 'execute'): ReleaseCheckDeployment => ({ ...owner, id: `d-${mode}`, status: 'running', mode });

describe('summarizeReleaseCheck', () => {
  it('is safe when nothing is in progress', () => {
    expect(summarizeReleaseCheck({ connections: [], discoveryRuns: [], deployments: [] })).toEqual({
      safe: true,
      total: 0,
      headline: 'Safe to release - nothing is in progress.',
    });
  });

  it('counts every kind of work and calls out live deployments', () => {
    const r = summarizeReleaseCheck({ connections: [conn, { ...conn, id: 'c2' }], discoveryRuns: [run], deployments: [dep('execute'), dep('dry_run')] });
    expect(r.safe).toBe(false);
    expect(r.total).toBe(5);
    expect(r.headline).toBe('5 things in progress: 2 deployment runs (1 live), 1 discovery run, 2 customer-tenant sign-ins.');
  });

  it('a lone sign-in is still not safe - a release ends it', () => {
    const r = summarizeReleaseCheck({ connections: [conn], discoveryRuns: [], deployments: [] });
    expect(r).toMatchObject({ safe: false, total: 1, headline: '1 thing in progress: 1 customer-tenant sign-in.' });
  });
});

describe('maintenance notice', () => {
  const at = '2026-10-12T18:00:00Z';
  const minus = (m: number) => new Date(Date.parse(at) - m * 60_000);

  it('is scheduled, then frozen for the last 10 minutes, then lapses 30 minutes after', () => {
    expect(maintenancePhase(at, minus(60))).toBe('scheduled');
    expect(maintenancePhase(at, minus(10.5))).toBe('scheduled');
    expect(maintenancePhase(at, minus(10))).toBe('freeze');
    expect(maintenancePhase(at, minus(1))).toBe('freeze');
    expect(maintenancePhase(at, minus(-20))).toBe('freeze'); // update running late - still frozen
    expect(maintenancePhase(at, minus(-31))).toBe('lapsed');
  });

  it('views a notice with a countdown, and hides a lapsed one', () => {
    const notice = { message: 'Update at 18:00 - live tenant sessions will end', startsAt: at, createdByName: 'Admin', createdAt: at };
    expect(viewMaintenanceNotice(notice, minus(7))).toMatchObject({ phase: 'freeze', minutesUntil: 7 });
    expect(viewMaintenanceNotice(notice, minus(-40))).toBeNull();
    expect(viewMaintenanceNotice(null)).toBeNull();
  });

  it('explains a refused start in plain words', () => {
    const view = viewMaintenanceNotice({ message: 'Update at 18:00', startsAt: at, createdByName: null, createdAt: at }, minus(7))!;
    const msg = maintenanceFreezeMessage(view, 'live deployment');
    expect(msg).toContain('due in 7 minutes');
    expect(msg).toContain('Starting a new live deployment is paused');
    expect(msg).toContain('"Update at 18:00"');
    expect(maintenanceFreezeMessage({ ...view, minutesUntil: -3 }, 'discovery run')).toContain('due now');
  });

  it('validates input', () => {
    expect(setMaintenanceNoticeSchema.safeParse({ message: 'x', startsAt: at }).success).toBe(true);
    expect(setMaintenanceNoticeSchema.safeParse({ message: ' ', startsAt: at }).success).toBe(false);
    expect(setMaintenanceNoticeSchema.safeParse({ message: 'x', startsAt: 'tonight' }).success).toBe(false);
  });
});

describe('sandboxRedirect', () => {
  it('sends to the person who triggered the email, with the original recipient in the subject', () => {
    expect(
      sandboxRedirect({ originalTo: 'customer@contoso.test', triggeredBy: { email: 'eng@msp.test', name: 'Eng' }, fallbackEmail: 'qa@msp.test' }),
    ).toEqual({ action: 'redirect', to: 'eng@msp.test', toName: 'Eng', subjectPrefix: '[TEST - would have gone to customer@contoso.test]' });
  });

  it('falls back to the configured address for emails nobody triggered', () => {
    expect(sandboxRedirect({ originalTo: 'c@contoso.test', triggeredBy: null, fallbackEmail: 'qa@msp.test' })).toMatchObject({
      action: 'redirect',
      to: 'qa@msp.test',
    });
  });

  it('skips when there is nobody to send it to', () => {
    expect(sandboxRedirect({ originalTo: 'c@contoso.test', triggeredBy: null, fallbackEmail: null }).action).toBe('skip');
  });
});
