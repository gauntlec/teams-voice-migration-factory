import { describe, expect, it } from 'vitest';
import { isRunActive, NOTHING_CHANGED_REASON, runMessage, runsSignature, runsToShow, runStage, VERIFY_STALE_MS, type DeploymentRunStatus } from './deployment-status';

const now = Date.parse('2026-11-06T15:36:00Z');
const ago = (ms: number) => new Date(now - ms).toISOString();
const run = (o: Partial<DeploymentRunStatus> = {}): DeploymentRunStatus => ({ id: 'r1', mode: 'execute', status: 'completed', summary: { applied: 6, failed: 0, skipped: 0, whatif: 0 }, finished_at: ago(1000), ...o });
const verified = { status: 'verified' as const, checkedAt: ago(0), discoveryRunId: 'x', checked: 1, matched: 1, differing: [], notChecked: 0, unverifiableSettings: 0 };

describe('a run on the deployment screen', () => {
  it('goes from starting, to running, to checking in Teams, to finished', () => {
    expect(runStage(run({ status: 'queued' }), now)).toBe('starting');
    expect(runStage(run({ status: 'running' }), now)).toBe('running');
    expect(runStage(run({ verification: { status: 'pending', startedAt: ago(1000) } }), now)).toBe('checking');
    expect(runStage(run({ verification: verified }), now)).toBe('finished');
  });

  it('counts a scheduled run as not started, and one past its time as starting', () => {
    expect(runStage(run({ status: 'queued', run_at: ago(-60_000) }), now)).toBe('scheduled');
    expect(runStage(run({ status: 'queued', run_at: ago(1000) }), now)).toBe('starting');
    expect(isRunActive(run({ status: 'queued', run_at: ago(-60_000) }), now)).toBe(false);
  });

  it('stops saying "checking" once a re-check is too old to still be going', () => {
    expect(runStage(run({ verification: { status: 'pending', startedAt: ago(VERIFY_STALE_MS + 1) } }), now)).toBe('finished');
  });

  it('says how far a live run has got and that it keeps going', () => {
    expect(runMessage(run({ status: 'running', changes_done: 4 }), now)).toMatchObject({ tone: 'progress', title: 'Deploying to Teams…', detail: expect.stringContaining('4 changes sent so far') });
    expect(runMessage(run({ verification: { status: 'pending', startedAt: ago(0) } }), now)).toMatchObject({ tone: 'progress', detail: expect.stringContaining("Don't deploy these again") });
  });

  it('only calls a live run complete once Teams has confirmed it', () => {
    expect(runMessage(run({ verification: verified }), now)).toMatchObject({ tone: 'success', title: 'Deployment complete', detail: '6 changes applied and confirmed in Teams (1 of 1 account matches).' });
    const differs = { ...verified, matched: 0, differing: [{ objectType: 'user' as const, objectId: 'a', upn: 'a', differences: ['x'] }] };
    expect(runMessage(run({ verification: differs }), now)).toMatchObject({ tone: 'warning', title: 'Deployed, but 1 account still differs in Teams' });
    expect(runMessage(run({ verification: { status: 'skipped', checkedAt: ago(0), reason: 'Why.' } }), now)).toMatchObject({ tone: 'warning', title: 'Deployed, but not confirmed in Teams', detail: '6 changes applied. Why.' });
  });

  it('never calls a What-If or a run that changed nothing a deployment', () => {
    expect(runMessage(run({ mode: 'dry_run', summary: { whatif: 238 } }), now)).toMatchObject({ tone: 'info', title: 'What-If complete', detail: '238 changes worked out. Nothing was sent to Teams.' });
    expect(runMessage(run({ summary: {}, verification: { status: 'skipped', checkedAt: ago(0), reason: NOTHING_CHANGED_REASON } }), now)).toMatchObject({ tone: 'info', title: 'Nothing to deploy' });
  });

  it('reports failures ahead of anything else', () => {
    expect(runMessage(run({ summary: { applied: 5, failed: 1 }, verification: verified }), now)).toMatchObject({ tone: 'error', title: 'Deployment finished with 1 failed' });
    expect(runMessage(run({ status: 'failed' }), now)).toMatchObject({ tone: 'error', title: 'The deployment did not finish' });
  });
});

describe('which runs the screen shows', () => {
  const a = run({ id: 'new', mode: 'dry_run', summary: { whatif: 1 } });
  const b = run({ id: 'checking', verification: { status: 'pending', startedAt: ago(0) } });
  it('shows everything under way as well as the latest to finish, so a What-If can\'t hide a live run being checked', () => {
    expect(runsToShow([a, b], new Set(), now).map((r) => r.id)).toEqual(['checking', 'new']);
  });
  it('drops a result when dismissed or old, but never a run under way', () => {
    expect(runsToShow([a, b], new Set(['new', 'checking']), now).map((r) => r.id)).toEqual(['checking']);
    expect(runsToShow([run({ finished_at: ago(16 * 60_000), verification: verified })], new Set(), now)).toEqual([]);
  });
  it('notices when a run moves on, so the planned changes are read again', () => {
    const before = runsSignature([run({ verification: { status: 'pending', startedAt: ago(0) } })], now);
    expect(runsSignature([run({ verification: verified })], now)).not.toBe(before);
    expect(runsSignature([run({ verification: { status: 'pending', startedAt: ago(1) } })], now)).toBe(before);
  });
});
