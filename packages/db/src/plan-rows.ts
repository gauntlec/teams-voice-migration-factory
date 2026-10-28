import {
  planIdentityRow,
  planResourceAccountRow,
  type CallDelegate,
  type CallForwardingSettings,
  type CmdletInvocation,
  type LiveIdentityState,
  type PickupGroupSettings,
} from '@tvmf/shared';
import { identitySkipReasons, rejectedNumberChanges } from './validate-rows';
import { resolveLiveIdentityState, resolveLivePolicyNames, type Scoped } from './live-state';

/*
 * Design & Build rows planned against Discovery's stored live state - the
 * exact diff a deployment run makes. Shared by the worker (deployments and
 * their post-deploy re-check) and the API (Service Handover's "is this
 * live?"): a row that plans zero calls is in place.
 */

/** One build_users/build_caps/build_resource_accounts row, planned against Discovery's stored live state. */
export interface PlannedIdentityRow {
  objectType: 'user' | 'cap' | 'resource_account';
  id: string;
  upn: string;
  calls: CmdletInvocation[];
  live: LiveIdentityState | undefined;
  /**
   * Why a deployment leaves this row out (its blocking validation issues). Only filled in when asked for
   * (`withSkipReasons`); empty means it deploys.
   */
  skipReasons: string[];
}

/**
 * Plan a site's users or CAPs - shared by a deployment run (apps/worker/src/
 * main.ts handleDeploymentRun) and its post-deploy re-check below, so "did
 * the design land?" is answered by exactly the diff the deployment used.
 * `rowIds` undefined = every row on the site; an empty list = none.
 * `withSkipReasons` also checks each row against the tenant and fills in `skipReasons` - what a deployment
 * uses to leave out a row it cannot apply correctly.
 */
export async function planIdentityRows(
  s: Scoped,
  table: 'build_users' | 'build_caps',
  objectType: 'user' | 'cap',
  siteId: string,
  rowIds?: string[],
  withSkipReasons = false,
): Promise<PlannedIdentityRow[]> {
  if (rowIds && rowIds.length === 0) return [];
  let q = s.selectFrom(table).selectAll().where('site_id', '=', siteId).where('hidden', '=', false);
  if (rowIds) q = q.where('id', 'in', rowIds);
  const rows = await q.execute();
  const skipReasons = withSkipReasons ? await identitySkipReasons(s, rows) : new Map<string, string[]>();
  // a number change the engineer rejected: the user keeps the number they have in Teams
  const keepNumber = await rejectedNumberChanges(s, rows);
  const [liveNames, liveState] = await Promise.all([
    resolveLivePolicyNames(
      s,
      rows.flatMap((row) => Object.values((row.policy_ids as Record<string, string | null>) ?? {})),
    ),
    resolveLiveIdentityState(s, rows.map((row) => row.upn)),
  ]);
  return rows.map((row) => {
    const policyIds = (row.policy_ids as Record<string, string | null>) ?? {};
    const storedPolicies = (row.policies as Record<string, string | null>) ?? {};
    // A row with a policy_ids link always deploys whatever that policy
    // is called *right now* in the tenant, not whatever name was live
    // when the engineer last saved - a rename since then shouldn't ship
    // stale. Rows with no link (legacy, or the untracked
    // dial_out_policy) fall back to the stored name unchanged.
    const policies: Record<string, string | null> = {};
    for (const key of Object.keys(storedPolicies)) {
      const linkedId = policyIds[key];
      policies[key] = (linkedId && liveNames.get(linkedId)) || storedPolicies[key] || null;
    }
    const live = liveState.get(row.upn.toLowerCase());
    const calls = planIdentityRow(
      {
        id: row.id,
        upn: row.upn,
        e164: keepNumber.has(row.id) ? null : row.e164,
        number_type: row.number_type,
        revoke_ev: row.revoke_ev,
        policies,
        voicemail: (row.voicemail as { enabled?: boolean | null; language?: string | null }) ?? null,
        call_forwarding: (row.call_forwarding as CallForwardingSettings) ?? null,
        pickup_group: (row.pickup_group as PickupGroupSettings) ?? null,
        delegates: (row.delegates as CallDelegate[]) ?? null,
      },
      objectType,
      live,
    );
    return { objectType, id: row.id, upn: row.upn, calls, live, skipReasons: skipReasons.get(row.id) ?? [] };
  });
}

/** Same as planIdentityRows, for a site's resource accounts. */
export async function planResourceAccountRows(s: Scoped, siteId: string, rowIds?: string[]): Promise<PlannedIdentityRow[]> {
  if (rowIds && rowIds.length === 0) return [];
  let q = s.selectFrom('build_resource_accounts').selectAll().where('site_id', '=', siteId);
  if (rowIds) q = q.where('id', 'in', rowIds);
  const rows = await q.execute();
  const [liveNames, liveState] = await Promise.all([
    resolveLivePolicyNames(s, rows.map((r) => r.voice_routing_policy_id)),
    resolveLiveIdentityState(s, rows.map((row) => row.upn)),
  ]);
  return rows.map((row) => {
    const linkedId = row.voice_routing_policy_id;
    const live = liveState.get(row.upn.toLowerCase());
    const calls = planResourceAccountRow(
      {
        id: row.id,
        upn: row.upn,
        display_name: row.display_name,
        kind: row.kind,
        location_id: row.location_id,
        phone_number: row.phone_number,
        number_type: row.number_type,
        voice_routing_policy: (linkedId && liveNames.get(linkedId)) || row.voice_routing_policy,
        application_id: row.application_id,
      },
      live,
    );
    return { objectType: 'resource_account' as const, id: row.id, upn: row.upn, calls, live, skipReasons: [] };
  });
}

