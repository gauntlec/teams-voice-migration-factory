import type { DeploymentVerification } from './deployment-verify';

/**
 * What a site's deployment screen says about its runs: is one running, is it being checked in Teams, how did it end. A live run has
 * two stages after the click: sending the changes, then (about a minute later, as Teams takes a moment to show them) reading them
 * back. Until that read-back the stored live state is still from before the run, so its rows still look undeployed.
 */

/** A re-check older than this never finished (the worker stopped mid-way), so it no longer counts as under way. */
export const VERIFY_STALE_MS = 60 * 60_000;
/** How long the screen keeps showing how a run ended. */
export const RUN_RESULT_SHOWN_MS = 15 * 60_000;
export const NOTHING_CHANGED_REASON = 'Nothing was changed live, so there was nothing to check.';

export interface DeploymentRunStatus {
  id: string;
  mode: string;
  status: string;
  run_at?: string | null;
  summary?: Record<string, number> | null;
  verification?: DeploymentVerification | null;
  finished_at?: string | null;
  /** how many changes have gone out so far, while it is running */
  changes_done?: number;
}

export type RunStage = 'scheduled' | 'starting' | 'running' | 'checking' | 'finished';

export function runStage(r: DeploymentRunStatus, now = Date.now()): RunStage {
  if (r.status === 'queued') return r.run_at && Date.parse(r.run_at) > now ? 'scheduled' : 'starting';
  if (r.status === 'running') return 'running';
  const v = r.verification;
  if (r.mode === 'execute' && r.status === 'completed' && v?.status === 'pending' && now - Date.parse(v.startedAt) <= VERIFY_STALE_MS) return 'checking';
  return 'finished';
}

export const isRunActive = (r: DeploymentRunStatus, now = Date.now()) => ['starting', 'running', 'checking'].includes(runStage(r, now));

const changes = (n: number) => `${n} change${n === 1 ? '' : 's'}`;

export interface RunMessage {
  tone: 'progress' | 'success' | 'info' | 'warning' | 'error';
  title: string;
  detail: string;
}

export function runMessage(r: DeploymentRunStatus, now = Date.now()): RunMessage {
  const live = r.mode === 'execute';
  const applied = r.summary?.applied ?? 0;
  const failed = r.summary?.failed ?? 0;
  const skipped = r.summary?.skipped ?? 0;
  const whatif = r.summary?.whatif ?? 0;
  const stage = runStage(r, now);
  if (stage === 'starting') return { tone: 'progress', title: live ? 'Starting the live deployment…' : 'Starting the What-If…', detail: 'Waiting for the sign-in to the customer tenant to be free.' };
  if (stage === 'running') {
    const done = r.changes_done ?? 0;
    if (!live) return { tone: 'progress', title: 'What-If running…', detail: `${changes(done)} worked out so far. Nothing is sent to Teams.` };
    return { tone: 'progress', title: 'Deploying to Teams…', detail: `${changes(done)} sent so far. This keeps running if you leave this page.` };
  }
  if (stage === 'checking') {
    return {
      tone: 'progress',
      title: 'Sent to Teams. Checking they took effect…',
      detail: `${changes(applied)} sent${failed ? `, ${failed} failed` : ''}. Voxshift waits about a minute, then reads them back from Teams. Don't deploy these again: they show as "checking Teams" until this finishes.`,
    };
  }
  if (r.status === 'failed') return { tone: 'error', title: live ? 'The deployment did not finish' : 'The What-If did not finish', detail: 'See Run history for what was done before it stopped.' };
  if (!live) {
    if (failed) return { tone: 'error', title: `What-If found ${failed} problem${failed === 1 ? '' : 's'}`, detail: 'Nothing was sent to Teams. See the run for what failed.' };
    return { tone: 'info', title: 'What-If complete', detail: whatif ? `${changes(whatif)} worked out. Nothing was sent to Teams.` : 'Nothing to change. Nothing was sent to Teams.' };
  }
  if (failed) return { tone: 'error', title: `Deployment finished with ${failed} failed`, detail: `${changes(applied)} applied, ${failed} failed. See the run for what failed and why.` };
  if (applied && skipped) return { tone: 'warning', title: `Deployed, but ${skipped} left out`, detail: `${changes(applied)} applied. ${skipped} left out: see the run for why.` };
  if (!applied && skipped) return { tone: 'warning', title: `Nothing deployed: ${skipped} left out`, detail: 'See the run for why.' };
  if (!applied) return { tone: 'info', title: 'Nothing to deploy', detail: 'What you selected already matches Teams, so nothing was sent.' };
  const v = r.verification;
  if (v?.status === 'verified') {
    const differ = v.differing.length;
    if (differ) return { tone: 'warning', title: `Deployed, but ${differ} account${differ === 1 ? '' : 's'} still differ${differ === 1 ? 's' : ''} in Teams`, detail: `${changes(applied)} applied. See Run history for what differs. Teams can take a few minutes to show a change.` };
    return { tone: 'success', title: 'Deployment complete', detail: `${changes(applied)} applied and confirmed in Teams (${v.matched} of ${v.checked} account${v.checked === 1 ? ' matches' : 's match'}).` };
  }
  if (v?.status === 'skipped' || v?.status === 'failed') return { tone: 'warning', title: 'Deployed, but not confirmed in Teams', detail: `${changes(applied)} applied. ${v.reason}` };
  return { tone: 'warning', title: 'Deployed, but not confirmed in Teams', detail: `${changes(applied)} applied. Run Validate against tenant on this site to check them.` };
}

/** The runs to show at the top of the screen: everything under way (oldest first), then the latest to finish, until it is dismissed or old. */
export function runsToShow(runs: readonly DeploymentRunStatus[], dismissed: ReadonlySet<string> = new Set(), now = Date.now()): DeploymentRunStatus[] {
  const active = runs.filter((r) => isRunActive(r, now)).reverse();
  const finished = runs.find((r) => runStage(r, now) === 'finished' && !!r.finished_at && now - Date.parse(r.finished_at) <= RUN_RESULT_SHOWN_MS);
  return [...active, ...(finished && !dismissed.has(finished.id) ? [finished] : [])];
}

/** Changes whenever a run moves on a stage, which is when the planned changes need reading again. */
export function runsSignature(runs: readonly DeploymentRunStatus[], now = Date.now()): string {
  return runs
    .slice(0, 10)
    .map((r) => `${r.id}:${runStage(r, now)}:${r.verification?.status ?? ''}`)
    .join('|');
}
