import { sql } from 'kysely';
import {
  DEPLOYMENT_SHEETS,
  classifyDrift,
  type DeploymentPreviewRow,
  type DriftRow,
  type RowDeploymentHistory,
  type SiteDriftSummary,
} from '@tvmf/shared';
import type { Scoped } from './live-state';
import { previewSiteChanges } from './preview';

/*
 * Drift for a site: the deployment preview (the exact plan a live run would make) narrowed to rows that were deployed,
 * have not been edited since, and still plan commands - so Teams changed after the deployment. Rules in
 * packages/shared/src/drift.ts. Used by the worker after a Discovery sync and by the API when the Drift view opens.
 */

const TABLE_OF = {
  user: 'build_users',
  cap: 'build_caps',
  resource_account: 'build_resource_accounts',
  shared_calling_policy: 'build_shared_calling_policies',
  call_queue: 'build_call_queues',
  auto_attendant: 'build_auto_attendants',
} as const;

const iso = (v: unknown) => new Date(v as string).toISOString();

/** Each row's latest live run that applied or failed something for it (deployment_changes.object_id is the build row id). */
export async function rowDeploymentHistory(s: Scoped, rowIds: string[]): Promise<Map<string, RowDeploymentHistory>> {
  const out = new Map<string, RowDeploymentHistory>();
  if (rowIds.length === 0) return out;
  const runs = await s
    .selectFrom('deployment_changes as c')
    .innerJoin('deployments as d', 'd.id', 'c.deployment_id')
    .select([
      'c.object_id',
      sql<string>`max(c.at)`.as('at'),
      sql<boolean>`bool_or(c.result = 'applied')`.as('applied'),
      sql<boolean>`bool_or(c.result = 'failed')`.as('failed'),
    ])
    .where('d.mode', '=', 'execute')
    .where('c.object_id', 'in', rowIds)
    .where('c.result', 'in', ['applied', 'failed'])
    .groupBy(['c.object_id', 'c.deployment_id'])
    .execute();
  const latest = new Map<string, (typeof runs)[number]>();
  for (const r of runs) {
    if (!r.object_id) continue;
    const prev = latest.get(r.object_id);
    if (!prev || Date.parse(iso(r.at)) > Date.parse(iso(prev.at))) latest.set(r.object_id, r);
  }
  for (const [id, r] of latest) out.set(id, r.failed ? { lastCleanAt: null, failedSince: true } : { lastCleanAt: iso(r.at), failedSince: false });
  return out;
}

/** finished_at of the latest completed Discovery sync (not a Validate check), or null. */
export async function lastCompletedSyncAt(s: Scoped): Promise<string | null> {
  const r = await s
    .selectFrom('tenant_discovery_runs')
    .select(sql<string | null>`max(finished_at)`.as('at'))
    .where('kind', '=', 'sync')
    .where('status', '=', 'completed')
    .executeTakeFirst();
  return r?.at ? iso(r.at) : null;
}

/** Marks each preview row that drifted (`drift` set), in place. */
export async function annotateDrift(s: Scoped, rows: DeploymentPreviewRow[]): Promise<void> {
  const planned = rows.filter((r) => r.calls.length > 0);
  if (planned.length === 0) return;
  const ids = planned.map((r) => r.rowId);
  const [history, lastSyncAt, updated] = await Promise.all([
    rowDeploymentHistory(s, ids),
    lastCompletedSyncAt(s),
    rowUpdatedAt(s, planned),
  ]);
  for (const r of planned) {
    const state = classifyDrift({ planned: true, history: history.get(r.rowId), rowUpdatedAt: updated.get(r.rowId) ?? new Date().toISOString(), lastSyncAt });
    if (state) r.drift = state;
  }
}

async function rowUpdatedAt(s: Scoped, rows: DeploymentPreviewRow[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (const [type, table] of Object.entries(TABLE_OF) as [DeploymentPreviewRow['objectType'], (typeof TABLE_OF)[keyof typeof TABLE_OF]][]) {
    const ids = rows.filter((r) => r.objectType === type).map((r) => r.rowId);
    if (!ids.length) continue;
    const found = await s.selectFrom(table).select(['id', 'updated_at']).where('id', 'in', ids).execute();
    for (const f of found) out.set(f.id, iso(f.updated_at));
  }
  return out;
}

/** Works out a site's drift from the stored live state and saves it (deployment_drift), replacing the last check. */
export async function computeSiteDrift(s: Scoped, siteId: string, runId: string | null = null): Promise<SiteDriftSummary> {
  const preview = await previewSiteChanges(s, { siteId, sheets: [...DEPLOYMENT_SHEETS] });
  await annotateDrift(s, preview);
  const history = await rowDeploymentHistory(s, preview.filter((r) => r.drift).map((r) => r.rowId));
  const rows: DriftRow[] = preview
    .filter((r) => r.drift)
    .map((r) => ({
      rowId: r.rowId,
      objectType: r.objectType,
      name: r.upn,
      state: r.drift!,
      cmdlets: [...new Set(r.calls.map((c) => c.cmdlet))],
      lastDeployedAt: history.get(r.rowId)?.lastCleanAt ?? '',
    }));
  const summary: SiteDriftSummary = {
    siteId,
    drifted: rows.filter((r) => r.state === 'drift').length,
    awaitingSync: rows.filter((r) => r.state === 'awaiting_sync').length,
    computedAt: new Date().toISOString(),
    rows,
  };
  await s
    .insertInto('deployment_drift')
    .values({ site_id: siteId, drifted: summary.drifted, awaiting_sync: summary.awaitingSync, rows: JSON.stringify(rows), run_id: runId, computed_at: summary.computedAt })
    .onConflict((oc) =>
      oc.column('site_id').doUpdateSet({ drifted: summary.drifted, awaiting_sync: summary.awaitingSync, rows: JSON.stringify(rows), run_id: runId, computed_at: summary.computedAt }),
    )
    .execute();
  return summary;
}

/** Sites with at least one live run - the only ones that can have drift. */
export async function sitesWithLiveRuns(s: Scoped): Promise<string[]> {
  const r = await s
    .selectFrom('deployments')
    .select(sql<string>`scope->>'siteId'`.as('site_id'))
    .distinct()
    .where('mode', '=', 'execute')
    .execute();
  const ids = r.map((x) => x.site_id).filter((x): x is string => !!x);
  if (!ids.length) return [];
  const sites = await s.selectFrom('discovery_sites').select('id').where('id', 'in', ids).execute();
  return sites.map((x) => x.id);
}
