import { sql } from 'kysely';
import { planIdentityRows, planResourceAccountRows, resolveLiveNumberTypes, type PlannedIdentityRow } from '@tvmf/db';
import {
  identityBeforeState,
  lineUriToNumber,
  planIdentityRow,
  planResourceAccountRow,
  UNVERIFIABLE_CMDLETS,
  verificationRowDifferences,
  type CallDelegate,
  type CallForwardingSettings,
  type CmdletInvocation,
  type DeploymentVerification,
  type DeploymentVerificationRow,
  type LiveIdentityState,
  type PickupGroupSettings,
} from '@tvmf/shared';
import { emptyProgress, runTargetedUserSync, type Scoped } from './discovery/run';
import type { TeamsExecutor } from './teams/executor';

// Planning a site's rows against live state is shared with the API (Service
// Handover's as-built check), so it lives in @tvmf/db.
export { planIdentityRows, planResourceAccountRows, type PlannedIdentityRow } from '@tvmf/db';

/**
 * What each planned call is about to change, as recorded in
 * deployment_changes.before - the rollback script's only source for "what to
 * put back". Looks up the live numbers' types in one query for all rows.
 */
export async function beforeStateResolver(s: Scoped, rows: PlannedIdentityRow[]) {
  const numberTypes = await resolveLiveNumberTypes(s, rows.map((r) => lineUriToNumber(r.live?.lineUri)));
  return (row: PlannedIdentityRow, call: CmdletInvocation): Record<string, unknown> =>
    identityBeforeState(call, row.live, numberTypes.get(lineUriToNumber(row.live?.lineUri) ?? '') ?? null);
}

/** Bounds the re-check's runtime - one pwsh session, ~2 calls per account. */
export const VERIFY_MAX_ACCOUNTS = 200;

const IDENTITY_TYPES = ['user', 'cap', 'resource_account'] as const;
type IdentityType = (typeof IDENTITY_TYPES)[number];

/**
 * After a live deployment run: re-read exactly the users, CAPs and resource
 * accounts it touched from Teams (a targeted Discovery check, the same one
 * Design & Build's Validate uses), then re-plan those rows against the fresh
 * state. A design that landed plans zero calls; anything still planned is
 * listed as still different. The verdict is saved on deployments.verification
 * and returned. Never throws for a Teams problem - that becomes a 'failed'
 * verdict, and the deployment itself is unaffected either way.
 */
export async function verifyDeployment(
  s: Scoped,
  exec: TeamsExecutor,
  args: {
    deploymentId: string;
    siteId: string;
    connectionId: string;
    operatorUserId: string;
    /** wait before re-reading - Teams can take a moment to show a change it just accepted */
    delayMs?: number;
  },
): Promise<DeploymentVerification> {
  const save = async (v: DeploymentVerification) => {
    await s.updateTable('deployments').set({ verification: v }).where('id', '=', args.deploymentId).execute();
    return v;
  };
  const stop = (status: 'skipped' | 'failed', reason: string) => save({ status, checkedAt: new Date().toISOString(), reason });

  const changes = await s
    .selectFrom('deployment_changes')
    .select(['object_type', 'object_id', 'cmdlet', 'result'])
    .where('deployment_id', '=', args.deploymentId)
    .execute();
  if (!changes.some((c) => c.result === 'applied')) {
    return stop('skipped', 'Nothing was changed live, so there was nothing to check.');
  }
  // Failed changes count as touched too: the re-check then shows what's still missing.
  const touched: Record<IdentityType, Set<string>> = { user: new Set(), cap: new Set(), resource_account: new Set() };
  for (const c of changes) {
    if ((c.result === 'applied' || c.result === 'failed') && c.object_id && (IDENTITY_TYPES as readonly string[]).includes(c.object_type)) {
      touched[c.object_type as IdentityType].add(c.object_id);
    }
  }
  const touchedCount = IDENTITY_TYPES.reduce((n, t) => n + touched[t].size, 0);
  if (touchedCount === 0) {
    return stop(
      'skipped',
      "This run only changed Call Queues, Auto Attendants or Shared Calling policies - those aren't re-checked automatically. Re-run Discovery to see them.",
    );
  }
  const unverifiableSettings = changes.filter((c) => c.result === 'applied' && UNVERIFIABLE_CMDLETS.has(c.cmdlet)).length;

  // Which accounts to re-read, capped.
  const byId = (table: 'build_users' | 'build_caps' | 'build_resource_accounts', ids: Set<string>) =>
    ids.size ? s.selectFrom(table).select(['id', 'upn']).where('id', 'in', [...ids]).execute() : Promise.resolve([]);
  const [users, caps, ras] = await Promise.all([
    byId('build_users', touched.user),
    byId('build_caps', touched.cap),
    byId('build_resource_accounts', touched.resource_account),
  ]);
  const accounts = [
    ...users.map((r) => ({ ...r, objectType: 'user' as const })),
    ...caps.map((r) => ({ ...r, objectType: 'cap' as const })),
    ...ras.map((r) => ({ ...r, objectType: 'resource_account' as const })),
  ];
  const toCheck = accounts.slice(0, VERIFY_MAX_ACCOUNTS);
  const notChecked = accounts.length - toCheck.length;
  const upns = [...new Set(toCheck.map((a) => a.upn.toLowerCase()))];

  // Take the customer's one discovery-run-in-flight slot
  // (idx_tenant_discovery_runs_one_in_flight) so a sync or Validate check
  // can't share the PowerShell session with this - or skip if one has it.
  const run = await s
    .insertInto('tenant_discovery_runs')
    .values({
      connection_id: args.connectionId,
      status: 'running',
      kind: 'targeted',
      started_by: args.operatorUserId,
      started_at: new Date().toISOString(),
      scope_types: ['user'],
    })
    .returning('id')
    .executeTakeFirst()
    .catch((err: { code?: string }) => {
      if (err?.code === '23505') return undefined;
      throw err;
    });
  if (!run) {
    return stop(
      'skipped',
      'A Discovery run or Validate check was already in progress, so the live re-check was skipped. Run Validate against tenant on this site (or re-run Discovery) to check it.',
    );
  }

  await save({ status: 'pending', startedAt: new Date().toISOString() });
  const progress = emptyProgress();
  try {
    if (args.delayMs) await new Promise((r) => setTimeout(r, args.delayMs));
    await runTargetedUserSync(s, exec, run.id, upns, progress);
    progress.step = null;
    await s
      .updateTable('tenant_discovery_runs')
      .set({ status: 'completed', finished_at: new Date().toISOString(), progress })
      .where('id', '=', run.id)
      .execute();
  } catch (e) {
    const message = (e as Error)?.message ?? String(e);
    await s
      .updateTable('tenant_discovery_runs')
      .set({ status: 'failed', finished_at: new Date().toISOString(), progress, error: `Post-deployment check failed: ${message.slice(0, 500)}` })
      .where('id', '=', run.id)
      .execute();
    return stop('failed', `Could not re-read the changed accounts from Teams: ${message.slice(0, 300)}`);
  }

  // Accounts the check actually re-read; anything else kept its old snapshot,
  // so it can't be judged on it.
  const seen = new Set(
    (
      await s
        .selectFrom('tenant_users')
        .select(sql<string>`lower(upn)`.as('upn'))
        .where('last_seen_run_id', '=', run.id)
        .execute()
    ).map((r) => r.upn),
  );
  const ids = (t: IdentityType) => toCheck.filter((a) => a.objectType === t).map((a) => a.id);
  const planned = [
    ...(await planIdentityRows(s, 'build_users', 'user', args.siteId, ids('user'))),
    ...(await planIdentityRows(s, 'build_caps', 'cap', args.siteId, ids('cap'))),
    ...(await planResourceAccountRows(s, args.siteId, ids('resource_account'))),
  ];

  const differing: DeploymentVerificationRow[] = [];
  for (const row of planned) {
    const upn = row.upn.toLowerCase();
    let differences: string[];
    if (!seen.has(upn)) {
      const err = progress.errors.find((e) => e.message.toLowerCase().startsWith(`${upn}:`));
      differences = [err ? `Could not be re-read from Teams: ${err.message.slice(upn.length + 1).trim()}` : 'Not found in Teams when re-checked'];
    } else {
      differences = verificationRowDifferences(row.calls.filter((c) => !c.deferred), row.live);
    }
    if (differences.length) differing.push({ objectType: row.objectType, objectId: row.id, upn: row.upn, differences });
  }

  return save({
    status: 'verified',
    checkedAt: new Date().toISOString(),
    discoveryRunId: run.id,
    checked: planned.length,
    matched: planned.length - differing.length,
    differing,
    notChecked,
    unverifiableSettings,
  });
}
