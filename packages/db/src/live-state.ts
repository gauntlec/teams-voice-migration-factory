import { sql, type Kysely } from 'kysely';
import {
  CALL_QUEUE_NO_AGENT_ACTIONS,
  CALL_QUEUE_NO_AGENT_APPLY_TO,
  CALL_QUEUE_OVERFLOW_ACTIONS,
  CALL_QUEUE_ROUTING_METHODS,
  CALL_QUEUE_TIMEOUT_ACTIONS,
  decodeCallQueueEnum,
  extractLiveCallTargetId,
  liveAutoAttendantToStructured,
  type AutoAttendantCallableEntity,
  type AutoAttendantCrossRef,
  type AutoAttendantLiveState,
  type CallQueueLiveState,
  type LiveCallableEntityRef,
  type LiveIdentityState,
  type SharedCallingPolicyLiveState,
} from '@tvmf/shared';
import type { DB } from './schema';

/**
 * A tenant-schema-scoped Kysely instance, as returned by `tenantDb()`. Every
 * function here only ever takes one of these as input - never raw
 * credentials or an unscoped connection.
 */
export type Scoped = Kysely<DB>;

/**
 * Batch-resolves tenant_policies ids to their *current* live name, so a
 * preview/deployment always shows whatever the tenant calls that policy
 * right now - not a stale copy from whenever the engineer last saved the
 * row in Design & Build. Was duplicated verbatim between
 * apps/api/.../deployment.service.ts and apps/worker/src/main.ts; moved
 * here so a fix only ever needs to land once.
 */
export async function resolveLivePolicyNames(scoped: Scoped, ids: (string | null | undefined)[]) {
  const wanted = [...new Set(ids.filter((id): id is string => !!id))];
  const out = new Map<string, string>();
  if (wanted.length === 0) return out;
  const rows = await scoped
    .selectFrom('tenant_policies')
    .select(['id', 'name'])
    .where('id', 'in', wanted)
    .where('removed_at', 'is', null)
    .execute();
  for (const r of rows) out.set(r.id, r.name);
  return out;
}

/**
 * What Discovery's live-tenant snapshot (tenant_policies, policy_type
 * 'TeamsSharedCallingRoutingPolicy') knows about a Shared Calling policy,
 * matched by lowercased name - the generic TENANT_POLICY_TYPES sweep
 * (Get-Cs<type> for every entry, apps/worker/src/discovery/cmdlets.ts)
 * already captures the full raw Get-CsTeamsSharedCallingRoutingPolicy
 * object here, so no separate live-capture step was needed for this.
 */
export async function resolveLiveSharedCallingPolicyState(scoped: Scoped, names: string[]) {
  const wanted = [...new Set(names.map((n) => n.toLowerCase()).filter(Boolean))];
  const out = new Map<string, SharedCallingPolicyLiveState>();
  if (wanted.length === 0) return out;
  const rows = await scoped
    .selectFrom('tenant_policies')
    .select(['name', 'data'])
    .where('policy_type', '=', 'TeamsSharedCallingRoutingPolicy')
    .where('removed_at', 'is', null)
    .where(sql`lower(name)`, 'in', wanted)
    .execute();
  for (const r of rows) {
    const d = r.data as Record<string, unknown>;
    out.set(r.name.toLowerCase(), {
      identity: r.name,
      resourceAccount: typeof d.ResourceAccount === 'string' ? d.ResourceAccount : undefined,
      emergencyNumbers: Array.isArray(d.EmergencyNumbers) ? (d.EmergencyNumbers as unknown[]).filter((v): v is string => typeof v === 'string') : undefined,
      description: typeof d.Description === 'string' ? d.Description : undefined,
    });
  }
  return out;
}

/**
 * Batch-fetches what Discovery's live-tenant snapshot (tenant_users) knows
 * about a set of UPNs, keyed by lowercased UPN - the same data
 * BuildValidationService compares against for Design & Build's amber
 * "pending change" badge (apps/api/src/modules/build/build-validation.service.ts),
 * reused here so a deployment only issues a cmdlet when it would actually
 * change something live. Resource accounts appear in tenant_users too (a
 * normal Entra/Teams identity under its own UPN), so this covers all three
 * sheets.
 */
export async function resolveLiveIdentityState(scoped: Scoped, upns: string[]) {
  const wanted = [...new Set(upns.map((u) => u.toLowerCase()))];
  const out = new Map<string, LiveIdentityState>();
  if (wanted.length === 0) return out;
  const rows = await scoped
    .selectFrom('tenant_users')
    .select([
      'upn',
      'enterprise_voice_enabled',
      'line_uri',
      'policies',
      'entra_id',
      'voicemail_enabled',
      'voicemail_prompt_language',
    ])
    .where('removed_at', 'is', null)
    .where(sql`lower(upn)`, 'in', wanted)
    .execute();
  for (const r of rows) {
    out.set(r.upn.toLowerCase(), {
      enterpriseVoiceEnabled: r.enterprise_voice_enabled,
      lineUri: r.line_uri,
      policies: (r.policies as Record<string, string | null>) ?? {},
      // objectId must be the real Entra/Azure AD object GUID that
      // Set-CsCallQueue -Users / New-CsOnlineApplicationInstanceAssociation
      // -Identities expects - that's tenant_users.entra_id (populated from
      // Get-CsOnlineUser's own .Identity), NOT tenant_users.object_id (our
      // internal tenant_objects.id row reference - a bug, confirmed against
      // OVP012's real live Call Queue Agents this session: a live Agent's
      // ObjectId matched entra_id, never object_id).
      objectId: r.entra_id ?? undefined,
      // null (never targeted-checked) becomes undefined so planIdentityRow's
      // fallback-to-always-emit applies, same as an unmatched UPN.
      voicemailEnabled: r.voicemail_enabled ?? undefined,
      voicemailPromptLanguage: r.voicemail_prompt_language,
    });
  }
  return out;
}

/**
 * What Discovery's live-tenant snapshot (tenant_objects, object_type
 * 'call_queue') knows about a queue, matched by lowercased Name - the same
 * queue can't be matched by any stored id yet (build_call_queues has no live
 * Identity column), so Name is the best available key, same as a fresh
 * tenant would show in Teams admin center.
 */
export async function resolveLiveCallQueueState(scoped: Scoped, names: string[]) {
  const wanted = [...new Set(names.map((n) => n.toLowerCase()).filter(Boolean))];
  const out = new Map<string, CallQueueLiveState>();
  if (wanted.length === 0) return out;
  const rows = await scoped
    .selectFrom('tenant_objects')
    .select(['display_name', 'data'])
    .where('object_type', '=', 'call_queue')
    .where('removed_at', 'is', null)
    .where(sql`lower(display_name)`, 'in', wanted)
    .execute();
  for (const r of rows) {
    if (!r.display_name) continue;
    const d = r.data as Record<string, unknown>;
    const agents = Array.isArray(d.Agents)
      ? (d.Agents as Record<string, unknown>[])
          .map((a) => (typeof a?.ObjectId === 'string' ? a.ObjectId : null))
          .filter((v): v is string => !!v)
      : [];
    out.set(r.display_name.toLowerCase(), {
      identity: String(d.Identity ?? ''),
      routingMethod: decodeCallQueueEnum(d.RoutingMethod, CALL_QUEUE_ROUTING_METHODS),
      agentAlertTime: typeof d.AgentAlertTime === 'number' ? d.AgentAlertTime : undefined,
      presenceBasedRouting: typeof d.PresenceBasedRouting === 'boolean' ? d.PresenceBasedRouting : undefined,
      agentObjectIds: agents,
      overflowAction: decodeCallQueueEnum(d.OverflowAction, CALL_QUEUE_OVERFLOW_ACTIONS),
      overflowThreshold: typeof d.OverflowThreshold === 'number' ? d.OverflowThreshold : undefined,
      overflowActionTarget: extractLiveCallTargetId(d.OverflowActionTarget),
      timeoutAction: decodeCallQueueEnum(d.TimeoutAction, CALL_QUEUE_TIMEOUT_ACTIONS),
      timeoutThreshold: typeof d.TimeoutThreshold === 'number' ? d.TimeoutThreshold : undefined,
      timeoutActionTarget: extractLiveCallTargetId(d.TimeoutActionTarget),
      noAgentAction: decodeCallQueueEnum(d.NoAgentAction, CALL_QUEUE_NO_AGENT_ACTIONS),
      noAgentActionTarget: extractLiveCallTargetId(d.NoAgentActionTarget),
      noAgentApplyTo: decodeCallQueueEnum(d.NoAgentApplyTo, CALL_QUEUE_NO_AGENT_APPLY_TO),
      languageId: typeof d.LanguageId === 'string' ? d.LanguageId : undefined,
      applicationInstanceIds: Array.isArray(d.ApplicationInstances)
        ? (d.ApplicationInstances as unknown[]).filter((v): v is string => typeof v === 'string')
        : undefined,
    });
  }
  return out;
}

/**
 * What Discovery's live-tenant snapshot (tenant_objects, object_type
 * 'auto_attendant') knows about an AA, matched by lowercased Name - same
 * rationale as resolveLiveCallQueueState. Always reads the scalar fields;
 * `deep` (when the caller has it - previewChanges does, buildAutoAttendantCrossRef's
 * own identity-only pass doesn't need it) additionally resolves the
 * compound call-flow/schedule/operator structure via
 * aa-live-parse.ts's liveAutoAttendantToStructured, so planAutoAttendantRow
 * can diff a saved row against it instead of always re-sending
 * Set-CsAutoAttendant.
 */
export async function resolveLiveAutoAttendantState(
  scoped: Scoped,
  names: string[],
  deep?: { scheduleByKey: Map<string, Record<string, unknown>>; resolveTarget: (ref: LiveCallableEntityRef | undefined) => AutoAttendantCallableEntity | undefined },
): Promise<Map<string, AutoAttendantLiveState>> {
  const wanted = [...new Set(names.map((n) => n.toLowerCase()).filter(Boolean))];
  const out = new Map<string, AutoAttendantLiveState>();
  if (wanted.length === 0) return out;
  const rows = await scoped
    .selectFrom('tenant_objects')
    .select(['display_name', 'data'])
    .where('object_type', '=', 'auto_attendant')
    .where('removed_at', 'is', null)
    .where(sql`lower(display_name)`, 'in', wanted)
    .execute();
  for (const r of rows) {
    if (!r.display_name) continue;
    const d = r.data as Record<string, unknown>;
    out.set(r.display_name.toLowerCase(), {
      identity: String(d.Identity ?? ''),
      languageId: typeof d.LanguageId === 'string' ? d.LanguageId : undefined,
      timeZoneId: typeof d.TimeZoneId === 'string' ? d.TimeZoneId : undefined,
      voiceId: typeof d.VoiceId === 'string' ? d.VoiceId : undefined,
      // Get-CsAutoAttendant's own property is VoiceResponseEnabled, not the
      // New/Set-CsAutoAttendant *write* parameter name EnableVoiceResponse -
      // see aa-live-parse.ts's liveAutoAttendantToStructured for the same fix.
      enableVoiceResponse: typeof d.VoiceResponseEnabled === 'boolean' ? d.VoiceResponseEnabled : undefined,
      applicationInstanceIds: Array.isArray(d.ApplicationInstances)
        ? (d.ApplicationInstances as unknown[]).filter((v): v is string => typeof v === 'string')
        : undefined,
      structured: deep ? liveAutoAttendantToStructured(d, deep.scheduleByKey, deep.resolveTarget) : undefined,
    });
  }
  return out;
}

/**
 * Every piece resolveLiveAutoAttendantState's `deep` option needs to convert
 * a live AA into build_auto_attendants' own shape: every live Schedule
 * (keyed by the GUID a CallHandlingAssociation's ScheduleId references),
 * every tenant_users UPN (keyed by entra_id, the same column a live
 * CallTarget/-Operator's ObjectId matches - see the "GUID rather than UPN"
 * bug fix in the call-flow diagram), and this site's own live-Identity ->
 * buildId map (the exact reverse of `crossRef`, which the caller already
 * built) to resolve a menu option/-Operator that targets a sibling AA/CQ.
 */
export async function resolveAutoAttendantDeepContext(s: Scoped, crossRef: AutoAttendantCrossRef) {
  const [scheduleRows, userRows] = await Promise.all([
    s.selectFrom('tenant_objects').select(['object_key', 'data']).where('object_type', '=', 'schedule').where('removed_at', 'is', null).execute(),
    s.selectFrom('tenant_users').select(['entra_id', 'upn']).where('entra_id', 'is not', null).execute(),
  ]);
  const scheduleByKey = new Map(scheduleRows.map((r) => [r.object_key, r.data as Record<string, unknown>]));
  const upnByEntraId = new Map(userRows.map((r) => [r.entra_id!.toLowerCase(), r.upn]));
  const liveIdToBuild = new Map<string, { kind: 'auto_attendant' | 'call_queue'; buildId: string }>();
  for (const [key, identity] of crossRef) {
    const sep = key.indexOf(':');
    liveIdToBuild.set(identity.toLowerCase(), { kind: key.slice(0, sep) as 'auto_attendant' | 'call_queue', buildId: key.slice(sep + 1) });
  }
  const resolveTarget = (ref: LiveCallableEntityRef | undefined): AutoAttendantCallableEntity | undefined => {
    if (!ref) return undefined;
    if (ref.kind === 'external' && ref.number) return { kind: 'external', number: ref.number };
    if (ref.kind === 'user' && ref.liveId) {
      const upn = upnByEntraId.get(ref.liveId.toLowerCase());
      return upn ? { kind: 'user', upn } : undefined;
    }
    if (ref.kind === 'voice_app' && ref.liveId) {
      const hit = liveIdToBuild.get(ref.liveId.toLowerCase());
      return hit ? { kind: hit.kind, buildId: hit.buildId } : undefined;
    }
    return undefined;
  };
  return { scheduleByKey, resolveTarget };
}

/**
 * Builds the `${kind}:${buildId}` -> live Identity map planAutoAttendantRow
 * needs to resolve a menu option/-Operator that targets a sibling AA/CQ on
 * the same site - every build_auto_attendants/build_call_queues row on the
 * site, not just the one(s) being planned, since a target can point outside
 * the current plan/preview scope.
 */
export async function buildAutoAttendantCrossRef(s: Scoped, siteId: string): Promise<AutoAttendantCrossRef> {
  const [aaRows, cqRows] = await Promise.all([
    s.selectFrom('build_auto_attendants').select(['id', 'name']).where('site_id', '=', siteId).execute(),
    s.selectFrom('build_call_queues').select(['id', 'name']).where('site_id', '=', siteId).execute(),
  ]);
  const [liveAa, liveCq] = await Promise.all([
    resolveLiveAutoAttendantState(s, aaRows.map((r) => r.name)),
    resolveLiveCallQueueState(s, cqRows.map((r) => r.name)),
  ]);
  const crossRef: AutoAttendantCrossRef = new Map();
  for (const row of aaRows) {
    const live = liveAa.get(row.name.toLowerCase());
    if (live?.identity) crossRef.set(`auto_attendant:${row.id}`, live.identity);
  }
  for (const row of cqRows) {
    const live = liveCq.get(row.name.toLowerCase());
    if (live?.identity) crossRef.set(`call_queue:${row.id}`, live.identity);
  }
  return crossRef;
}
