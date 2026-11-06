import { sql } from 'kysely';
import { VERIFY_STALE_MS, type DeploymentPreviewRow, type DeploymentRowActivity } from '@tvmf/shared';
import type { Scoped } from './live-state';

/** A live run whose re-check didn't happen is only worth flagging for a while: after this its rows read as ordinary planned changes. */
const UNCONFIRMED_SHOWN_DAYS = 7;

export interface SiteRowActivity {
  /** a live run is going out for every row of the site */
  everyRow: boolean;
  rows: Map<string, DeploymentRowActivity>;
}

/**
 * The rows of a site whose stored live state can't be trusted yet, because a live run has just changed them. Until a re-read, the plan
 * still compares them with how Teams was before the run, so they look undeployed and deploying them again re-sends every change.
 * - deploying: a live run is sending them now.
 * - checking: sent, and the run's re-check is waiting to read them back.
 * - unconfirmed: sent, but the re-check didn't happen, and no Discovery run has started since.
 */
export async function siteRowActivity(s: Scoped, siteId: string, now = Date.now()): Promise<SiteRowActivity> {
  const runs = await s
    .selectFrom('deployments')
    .select(['id', 'status', 'run_at', 'scope', 'finished_at', 'verification'])
    .where('mode', '=', 'execute')
    .where(sql<boolean>`scope->>'siteId' = ${siteId}`)
    .where((eb) =>
      eb.or([
        eb('status', 'in', ['queued', 'running']),
        sql<boolean>`verification->>'status' = 'pending'`,
        eb.and([sql<boolean>`verification->>'status' in ('skipped', 'failed')`, eb('finished_at', '>', new Date(now - UNCONFIRMED_SHOWN_DAYS * 86_400_000).toISOString())]),
      ]),
    )
    .execute();
  const out: SiteRowActivity = { everyRow: false, rows: new Map() };
  if (runs.length === 0) return out;

  const latestStart = await s.selectFrom('tenant_discovery_runs').select((eb) => eb.fn.max('started_at').as('at')).where('status', '=', 'completed').executeTakeFirst();
  const lastRead = latestStart?.at ? Date.parse(String(latestStart.at)) : 0;
  const rank: DeploymentRowActivity[] = ['unconfirmed', 'checking', 'deploying'];
  const mark = (id: string, state: DeploymentRowActivity) => {
    const had = out.rows.get(id);
    if (!had || rank.indexOf(state) > rank.indexOf(had)) out.rows.set(id, state);
  };
  for (const r of runs) {
    if (r.status === 'queued' || r.status === 'running') {
      if (r.status === 'queued' && r.run_at && Date.parse(String(r.run_at)) > now) continue;
      const ids = ((r.scope ?? {}) as { rowIds?: string[] }).rowIds;
      if (ids?.length) ids.forEach((id) => mark(id, 'deploying'));
      else out.everyRow = true;
      continue;
    }
    const v = r.verification as { status?: string; startedAt?: string } | null;
    let state: DeploymentRowActivity = 'unconfirmed';
    if (v?.status === 'pending') {
      if (v.startedAt && now - Date.parse(v.startedAt) > VERIFY_STALE_MS) continue;
      state = 'checking';
    } else if (r.finished_at && lastRead > Date.parse(String(r.finished_at))) continue;
    // A re-check also reads what failed, to show what's missing. "Sent, not confirmed" is only for what Teams accepted: a change that failed wasn't sent.
    const results = state === 'checking' ? ['applied', 'failed'] : ['applied'];
    const changed = await s.selectFrom('deployment_changes').select('object_id').distinct().where('deployment_id', '=', r.id).where('result', 'in', results as never).where('object_id', 'is not', null).execute();
    changed.forEach((c) => mark(c.object_id!, state));
  }
  return out;
}

/** Marks each planned row with what is happening to it, for the screen. */
export function annotateRowActivity(rows: DeploymentPreviewRow[], activity: SiteRowActivity): void {
  for (const r of rows) {
    const state = activity.everyRow ? 'deploying' : activity.rows.get(r.rowId);
    if (state) r.activity = state;
  }
}

/**
 * Which of the rows a live run is about to send are already on their way or being checked (no rowIds: the whole site). Sending them
 * again now would repeat every change, because the plan can't yet see the first run's.
 */
export function rowsStillSettling(activity: SiteRowActivity, rowIds: readonly string[] | null | undefined): number {
  const settling = (id: string) => ['deploying', 'checking'].includes(activity.rows.get(id) ?? '');
  if (rowIds?.length) return activity.everyRow ? rowIds.length : rowIds.filter(settling).length;
  return activity.everyRow ? 1 : [...activity.rows.keys()].filter(settling).length;
}
