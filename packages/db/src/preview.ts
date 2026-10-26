import {
  autoAttendantDifferences,
  autoAttendantRowWarnings,
  callQueueRowWarnings,
  collectAutoAttendantUserUpns,
  collectCallQueueTargetUpns,
  collectDependencyUserRowIds,
  identityRowWarnings,
  planAutoAttendantRow,
  planCallQueueRow,
  planIdentityRow,
  planResourceAccountRow,
  planSharedCallingPolicyRow,
  renderCommand,
  resourceAccountRowWarnings,
  sharedCallingPolicyRowWarnings,
  type AutoAttendantCallableEntity,
  type AutoAttendantCallFlow,
  type AutoAttendantHolidayCallFlow,
  type AutoAttendantLiveState,
  type AutoAttendantSchedule,
  type BuildAutoAttendantRow,
  type CallDelegate,
  type CallForwardingSettings,
  type CallQueueActionSettings,
  type CallQueueLiveState,
  type DeploymentPreviewQuery,
  type DeploymentPreviewRow,
  type PickupGroupSettings,
} from '@tvmf/shared';
import {
  buildAutoAttendantCrossRef,
  resolveAutoAttendantDeepContext,
  resolveLiveAutoAttendantState,
  resolveLiveCallQueueState,
  resolveLiveIdentityState,
  resolveLivePolicyNames,
  resolveLiveSharedCallingPolicyState,
  type Scoped,
} from './live-state';
import { identitySkipReasons } from './validate-rows';

export type DeploymentSheetName = 'users' | 'caps' | 'resource_accounts' | 'shared_calling_policies' | 'call_queues' | 'auto_attendants';
type SheetName = DeploymentSheetName;

/**
 * Silently pulls in any build_users row a selected Call Queue's agents or
 * a selected Auto Attendant's -Operator/menu-option targets reference, so
 * that user's own Enterprise Voice/number/policy config deploys - in this
 * same run, before the queue/attendant that relies on it - without the
 * operator having to notice the dependency and select it separately. Only
 * applies when `rowIds` is a specific subset: a whole-site run (no rowIds
 * filter) already deploys every build_users row for any included sheet, so
 * there's nothing to add. Used by both previewChanges (so "Planned
 * changes" shows exactly what a real run would do) and createDeployment
 * (so it actually does). See collectDependencyUserRowIds.
 */
export async function expandScopeWithDependencies(
  s: Scoped,
  siteId: string,
  sheets: SheetName[],
  rowIds: string[] | undefined,
): Promise<{ sheets: SheetName[]; rowIds: string[] | undefined; autoIncludedRowIds: string[] }> {
  if (!rowIds?.length) return { sheets, rowIds, autoIncludedRowIds: [] };
  const needsCq = sheets.includes('call_queues');
  const needsAa = sheets.includes('auto_attendants');
  if (!needsCq && !needsAa) return { sheets, rowIds, autoIncludedRowIds: [] };

  const [cqRows, aaRows, siteUsers] = await Promise.all([
    needsCq
      ? s.selectFrom('build_call_queues').select('agents').where('site_id', '=', siteId).where('id', 'in', rowIds).execute()
      : Promise.resolve([]),
    needsAa
      ? s
          .selectFrom('build_auto_attendants')
          .select(['operator', 'default_call_flow', 'after_hours_call_flow', 'holiday_call_flows'])
          .where('site_id', '=', siteId)
          .where('id', 'in', rowIds)
          .execute()
      : Promise.resolve([]),
    s.selectFrom('build_users').select(['id', 'upn']).where('site_id', '=', siteId).where('hidden', '=', false).execute(),
  ]);

  const depIds = collectDependencyUserRowIds(
    cqRows.map((r) => ({ agents: (r.agents as string[] | null) ?? [] })),
    aaRows.map((r) => ({
      operator: (r.operator as AutoAttendantCallableEntity) ?? null,
      default_call_flow: (r.default_call_flow as AutoAttendantCallFlow) ?? null,
      after_hours_call_flow: (r.after_hours_call_flow as AutoAttendantCallFlow) ?? null,
      holiday_call_flows: (r.holiday_call_flows as AutoAttendantHolidayCallFlow[]) ?? [],
    })),
    siteUsers,
  );
  const missing = depIds.filter((id) => !rowIds.includes(id));
  if (missing.length === 0) return { sheets, rowIds, autoIncludedRowIds: [] };
  return {
    sheets: sheets.includes('users') ? sheets : [...sheets, 'users'],
    rowIds: [...rowIds, ...missing],
    autoIncludedRowIds: missing,
  };
}

/**
 * Read-only "what would this deploy right now" preview: reuses
 * planIdentityRow/planResourceAccountRow directly against the DB, with no
 * connection and no worker/queue involvement - see apps/worker/src/main.ts's
 * handleDeploymentRun for the live-execution counterpart this mirrors.
 * Shared by the API (Deployment's planned changes) and the worker (the drift
 * check after a Discovery sync), so both see exactly the same plan.
 */
export async function previewSiteChanges(s: Scoped, query: DeploymentPreviewQuery): Promise<DeploymentPreviewRow[]> {
  const { sheets, rowIds, autoIncludedRowIds } = await expandScopeWithDependencies(
    s,
    query.siteId,
    query.sheets,
    query.rowIds,
  );
  const autoIncluded = new Set(autoIncludedRowIds);
  const out: DeploymentPreviewRow[] = [];

  if (sheets.includes('users') || sheets.includes('caps')) {
    for (const [sheet, table, objectType] of [
      ['users', 'build_users', 'user'],
      ['caps', 'build_caps', 'cap'],
    ] as const) {
      if (!sheets.includes(sheet)) continue;
      let q = s.selectFrom(table).selectAll().where('site_id', '=', query.siteId).where('hidden', '=', false);
      if (rowIds?.length) q = q.where('id', 'in', rowIds);
      const rows = await q.execute();
      // Errors are triaged in Design & Build: a row with a blocking problem is shown as not deployed, not refused.
      const skipReasons = await identitySkipReasons(s, rows);
      const [liveNames, liveState] = await Promise.all([
        resolveLivePolicyNames(
          s,
          rows.flatMap((row) => Object.values((row.policy_ids as Record<string, string | null>) ?? {})),
        ),
        resolveLiveIdentityState(s, rows.map((row) => row.upn)),
      ]);
      for (const row of rows) {
        const policyIds = (row.policy_ids as Record<string, string | null>) ?? {};
        const storedPolicies = (row.policies as Record<string, string | null>) ?? {};
        const policies: Record<string, string | null> = {};
        for (const key of Object.keys(storedPolicies)) {
          const linkedId = policyIds[key];
          policies[key] = (linkedId && liveNames.get(linkedId)) || storedPolicies[key] || null;
        }
        const calls = planIdentityRow(
          {
            id: row.id,
            upn: row.upn,
            e164: row.e164,
            number_type: row.number_type,
            revoke_ev: row.revoke_ev,
            policies,
            voicemail: (row.voicemail as { enabled?: boolean | null; language?: string | null }) ?? null,
            call_forwarding: (row.call_forwarding as CallForwardingSettings) ?? null,
            pickup_group: (row.pickup_group as PickupGroupSettings) ?? null,
            delegates: (row.delegates as CallDelegate[]) ?? null,
          },
          objectType,
          liveState.get(row.upn.toLowerCase()),
        );
        const warnings = identityRowWarnings({ e164: row.e164, number_type: row.number_type, policies });
        const skipped = skipReasons.get(row.id) ?? [];
        if (calls.length === 0 && warnings.length === 0 && skipped.length === 0) continue;
        out.push({
          rowId: row.id,
          objectType,
          upn: row.upn,
          calls,
          renderedCommands: calls.map(renderCommand),
          warnings,
          skipReasons: skipped,
          wave: row.migration_wave?.trim() || null,
          autoIncluded: autoIncluded.has(row.id),
        });
      }
    }
  }

  if (sheets.includes('resource_accounts')) {
    let q = s.selectFrom('build_resource_accounts').selectAll().where('site_id', '=', query.siteId);
    if (rowIds?.length) q = q.where('id', 'in', rowIds);
    const rows = await q.execute();
    const [liveNames, liveState] = await Promise.all([
      resolveLivePolicyNames(s, rows.map((r) => r.voice_routing_policy_id)),
      resolveLiveIdentityState(s, rows.map((row) => row.upn)),
    ]);
    for (const row of rows) {
      const linkedId = row.voice_routing_policy_id;
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
        liveState.get(row.upn.toLowerCase()),
      );
      const warnings = resourceAccountRowWarnings({ phone_number: row.phone_number, number_type: row.number_type });
      if (calls.length === 0 && warnings.length === 0) continue;
      out.push({
        rowId: row.id,
        objectType: 'resource_account',
        upn: row.upn,
        calls,
        renderedCommands: calls.map(renderCommand),
        warnings,
      });
    }
  }

  if (sheets.includes('shared_calling_policies')) {
    let q = s.selectFrom('build_shared_calling_policies').selectAll().where('site_id', '=', query.siteId);
    if (rowIds?.length) q = q.where('id', 'in', rowIds);
    const rows = await q.execute();

    const raIds = [...new Set(rows.map((r) => r.resource_account_id).filter((id): id is string => !!id))];
    const ras = raIds.length
      ? await s.selectFrom('build_resource_accounts').select(['id', 'upn']).where('id', 'in', raIds).execute()
      : [];
    const raIdentity = await resolveLiveIdentityState(s, ras.map((r) => r.upn));
    const raObjectIds = new Map<string, string>();
    for (const ra of ras) {
      const oid = raIdentity.get(ra.upn.toLowerCase())?.objectId;
      if (oid) raObjectIds.set(ra.id, oid);
    }
    const live = await resolveLiveSharedCallingPolicyState(s, rows.map((r) => r.name));
    for (const row of rows) {
      const planRow = {
        id: row.id,
        name: row.name,
        resource_account_id: row.resource_account_id,
        emergency_numbers: (row.emergency_numbers as string[] | null) ?? [],
        description: row.description,
      };
      const calls = planSharedCallingPolicyRow(planRow, raObjectIds, live.get(row.name.toLowerCase()));
      const warnings = sharedCallingPolicyRowWarnings(planRow, raObjectIds);
      if (calls.length === 0 && warnings.length === 0) continue;
      out.push({
        rowId: row.id,
        objectType: 'shared_calling_policy',
        upn: row.name,
        calls,
        renderedCommands: calls.map(renderCommand),
        warnings,
      });
    }
  }

  if (sheets.includes('call_queues')) {
    let q = s.selectFrom('build_call_queues').selectAll().where('site_id', '=', query.siteId);
    if (rowIds?.length) q = q.where('id', 'in', rowIds);
    const rows = await q.execute();

    // A queue's agents and its linked resource accounts are both stored
    // as UPNs (agents) or an internal build_resource_accounts.id
    // (resource_accounts) - Set-CsCallQueue/the association cmdlet both
    // need live Entra object GUIDs, resolved via tenant_users.object_id
    // the same way resolveLiveIdentityState already resolves for
    // users/caps/resource-account diffing above.
    const raIds = [...new Set(rows.flatMap((r) => (r.resource_accounts as string[] | null) ?? []))];
    const ras = raIds.length
      ? await s.selectFrom('build_resource_accounts').select(['id', 'upn']).where('id', 'in', raIds).execute()
      : [];
    const cqTargetUpns = collectCallQueueTargetUpns(
      rows.map((r) => ({
        overflow: (r.overflow as CallQueueActionSettings | null) ?? null,
        timeout: (r.timeout as CallQueueActionSettings | null) ?? null,
        no_agent_action: (r.no_agent_action as CallQueueActionSettings | null) ?? null,
      })),
    );
    const allUpns = [...rows.flatMap((r) => (r.agents as string[] | null) ?? []), ...ras.map((r) => r.upn), ...cqTargetUpns];
    const [liveIdentity, liveQueues] = await Promise.all([
      resolveLiveIdentityState(s, allUpns),
      resolveLiveCallQueueState(s, rows),
    ]);
    const agentObjectIds = new Map<string, string>();
    for (const [upn, v] of liveIdentity) if (v.objectId) agentObjectIds.set(upn, v.objectId);
    const raObjectIds = new Map<string, string>();
    for (const ra of ras) {
      const oid = liveIdentity.get(ra.upn.toLowerCase())?.objectId;
      if (oid) raObjectIds.set(ra.id, oid);
    }

    for (const row of rows) {
      const agents = (row.agents as string[] | null) ?? [];
      const resourceAccounts = (row.resource_accounts as string[] | null) ?? [];
      const planRow = {
        id: row.id,
        name: row.name,
        routing_method: row.routing_method,
        agent_alert_time: row.agent_alert_time,
        presence_based_routing: row.presence_based_routing,
        agents,
        overflow: (row.overflow as CallQueueActionSettings) ?? null,
        timeout: (row.timeout as CallQueueActionSettings) ?? null,
        no_agent_action: (row.no_agent_action as CallQueueActionSettings) ?? null,
        no_agent_apply_to: row.no_agent_apply_to,
        language_id: row.language_id,
        resource_accounts: resourceAccounts,
      };
      const live: CallQueueLiveState | undefined = liveQueues.get(row.id);
      const calls = planCallQueueRow(planRow, agentObjectIds, raObjectIds, live);
      const warnings = callQueueRowWarnings(planRow, agentObjectIds, raObjectIds);
      if (calls.length === 0 && warnings.length === 0) continue;
      out.push({
        rowId: row.id,
        objectType: 'call_queue',
        upn: row.name,
        calls,
        renderedCommands: calls.map(renderCommand),
        warnings,
      });
    }
  }

  if (sheets.includes('auto_attendants')) {
    let q = s.selectFrom('build_auto_attendants').selectAll().where('site_id', '=', query.siteId);
    if (rowIds?.length) q = q.where('id', 'in', rowIds);
    const rows = await q.execute();

    // A row's linked resource accounts resolve the same way a call
    // queue's do (raIds -> build_resource_accounts -> live Entra object
    // GUID) - an AA can have several resource accounts, or none yet,
    // exactly like a Call Queue.
    const raIds = [...new Set(rows.flatMap((r) => (r.resource_accounts as string[] | null) ?? []))];
    const [ras, crossRef] = await Promise.all([
      raIds.length
        ? s.selectFrom('build_resource_accounts').select(['id', 'upn']).where('id', 'in', raIds).execute()
        : Promise.resolve([]),
      buildAutoAttendantCrossRef(s, query.siteId),
    ]);
    const liveIdentity = await resolveLiveIdentityState(s, ras.map((r) => r.upn));
    const raObjectIds = new Map<string, string>();
    for (const ra of ras) {
      const oid = liveIdentity.get(ra.upn.toLowerCase())?.objectId;
      if (oid) raObjectIds.set(ra.id, oid);
    }
    const deep = await resolveAutoAttendantDeepContext(s, crossRef);
    const liveAutoAttendants = await resolveLiveAutoAttendantState(s, rows, deep);

    const planRows: BuildAutoAttendantRow[] = rows.map((row) => ({
      id: row.id,
      name: row.name,
      language_id: row.language_id,
      time_zone_id: row.time_zone_id,
      voice_id: row.voice_id,
      voice_response_enabled: row.voice_response_enabled,
      operator: (row.operator as AutoAttendantCallableEntity) ?? null,
      default_call_flow: (row.default_call_flow as AutoAttendantCallFlow) ?? null,
      after_hours_call_flow: (row.after_hours_call_flow as AutoAttendantCallFlow) ?? null,
      holiday_call_flows: (row.holiday_call_flows as AutoAttendantHolidayCallFlow[]) ?? [],
      schedule: (row.schedule as AutoAttendantSchedule) ?? null,
      resource_accounts: (row.resource_accounts as string[] | null) ?? [],
    }));
    // 'user'-kind callable entities (operator / menu-option transfer
    // targets) need their own UPN -> live Entra Object ID resolution -
    // see buildCallableEntity's 'user' case.
    const userLiveIdentity = await resolveLiveIdentityState(s, collectAutoAttendantUserUpns(planRows));
    const userObjectIds = new Map<string, string>();
    for (const [upn, v] of userLiveIdentity) if (v.objectId) userObjectIds.set(upn, v.objectId);

    for (const planRow of planRows) {
      const live: AutoAttendantLiveState | undefined = liveAutoAttendants.get(planRow.id);
      const calls = planAutoAttendantRow(planRow, crossRef, raObjectIds, userObjectIds, live);
      const warnings = autoAttendantRowWarnings(planRow, crossRef, raObjectIds, userObjectIds);
      // say why a live auto attendant is being changed, so a row that looks unchanged to the engineer is not a mystery
      if (live && calls.length > 0) {
        const diffs = autoAttendantDifferences(planRow, live, crossRef);
        if (diffs.length > 0) warnings.push(`Differs from the live auto attendant: ${diffs.join('; ')}.`);
      }
      if (calls.length === 0 && warnings.length === 0) continue;
      out.push({
        rowId: planRow.id,
        objectType: 'auto_attendant',
        upn: planRow.name,
        calls,
        renderedCommands: calls.map(renderCommand),
        warnings,
      });
    }
  }

  return out;
}
