import { sql, type Kysely } from 'kysely';
import {
  CALL_QUEUE_NO_AGENT_ACTIONS,
  CALL_QUEUE_NO_AGENT_APPLY_TO,
  CALL_QUEUE_OVERFLOW_ACTIONS,
  CALL_QUEUE_ROUTING_METHODS,
  CALL_QUEUE_TIMEOUT_ACTIONS,
  decodeCallQueueEnum,
  extractLiveCallTargetId,
  liveCallQueueActionExtras,
  liveAutoAttendantToStructured,
  type AutoAttendantCallableEntity,
  type AutoAttendantCrossRef,
  type AutoAttendantLiveState,
  type CallQueueLiveState,
  type LiveCallableEntityRef,
  type LiveCallingSettings,
  type LiveIdentityState,
  type SharedCallingPolicyLiveState,
} from '@tvmf/shared';
import type { DB } from './schema';

const GUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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
  // -ResourceAccount accepts the account's Identity (UPN/SIP) or its ObjectId
  // (Microsoft Learn), so the live value can be either. The planner compares
  // against the resolved Entra ObjectId - normalize a UPN to that here, or
  // the same account reads as "changed" on every preview.
  const raw = rows.map((r) => (r.data as Record<string, unknown>).ResourceAccount).filter((v): v is string => typeof v === 'string');
  const upns = [...new Set(raw.filter((v) => !GUID_RE.test(v)).map((v) => v.replace(/^sip:/i, '').toLowerCase()))];
  const entraByUpn = new Map<string, string>();
  if (upns.length) {
    const users = await scoped.selectFrom('tenant_users').select(['upn', 'entra_id']).where(sql`lower(upn)`, 'in', upns).execute();
    for (const u of users) if (u.entra_id) entraByUpn.set(u.upn.toLowerCase(), u.entra_id);
  }
  const toObjectId = (v: unknown): string | undefined => {
    if (typeof v !== 'string' || !v) return undefined;
    if (GUID_RE.test(v)) return v.toLowerCase();
    return entraByUpn.get(v.replace(/^sip:/i, '').toLowerCase())?.toLowerCase() ?? v;
  };
  for (const r of rows) {
    const d = r.data as Record<string, unknown>;
    out.set(r.name.toLowerCase(), {
      identity: r.name,
      resourceAccount: toObjectId(d.ResourceAccount),
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
      'calling_settings',
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
      // null (never read) becomes undefined so planIdentityRow keeps always emitting until the sync has read this user.
      callingSettings: (r.calling_settings as LiveCallingSettings | null) ?? undefined,
    });
  }
  return out;
}

/** A Design & Build auto attendant / call queue row, as far as finding its live object goes. */
export interface LiveRowRef {
  id: string;
  name: string;
  discovery_voice_app_id?: string | null;
}

/**
 * Finds the live object (Discovery's tenant_objects) behind each Design & Build row, keyed by the row's id. A row made from, or linked
 * to, a Data Collection voice app is matched on that voice app's exact discovered object (its Teams GUID) - never on its name, which
 * two voice apps can share. Only a row with no link falls back to its name, and then only when exactly one live object has that name
 * and no other row has already claimed it: a name that fits several is not guessed at.
 */
async function liveObjectsForRows(scoped: Scoped, type: 'auto_attendant' | 'call_queue', rows: LiveRowRef[]) {
  const out = new Map<string, { display_name: string | null; data: Record<string, unknown> }>();
  if (rows.length === 0) return out;
  const appIds = [...new Set(rows.map((r) => r.discovery_voice_app_id).filter((v): v is string => !!v))];
  const apps = appIds.length ? await scoped.selectFrom('discovery_voice_apps').select(['id', 'tenant_object_id']).where('id', 'in', appIds).execute() : [];
  const objectOfApp = new Map(apps.map((a) => [a.id, a.tenant_object_id]));
  const linkedObjectIds = [...new Set(apps.map((a) => a.tenant_object_id).filter((v): v is string => !!v))];
  const unlinkedNames = [...new Set(rows.filter((r) => !r.discovery_voice_app_id || !objectOfApp.get(r.discovery_voice_app_id)).map((r) => r.name.toLowerCase()).filter(Boolean))];
  const objects = await scoped
    .selectFrom('tenant_objects')
    .select(['id', 'display_name', 'data'])
    .where('object_type', '=', type)
    .where('removed_at', 'is', null)
    .where((eb) => {
      const parts = [];
      if (linkedObjectIds.length) parts.push(eb('id', 'in', linkedObjectIds));
      if (unlinkedNames.length) parts.push(eb(sql`lower(display_name)`, 'in', unlinkedNames));
      return parts.length ? eb.or(parts) : eb.val(false);
    })
    .execute();
  const byId = new Map(objects.map((o) => [o.id, o]));
  const claimed = new Set<string>();
  for (const r of rows) {
    const objectId = r.discovery_voice_app_id ? objectOfApp.get(r.discovery_voice_app_id) : null;
    const hit = objectId ? byId.get(objectId) : undefined;
    if (hit) {
      out.set(r.id, { display_name: hit.display_name, data: (hit.data ?? {}) as Record<string, unknown> });
      claimed.add(hit.id);
    }
  }
  for (const r of rows) {
    if (out.has(r.id) || (r.discovery_voice_app_id && objectOfApp.get(r.discovery_voice_app_id))) continue;
    const named = objects.filter((o) => !claimed.has(o.id) && (o.display_name ?? '').toLowerCase() === r.name.toLowerCase());
    if (named.length === 1) out.set(r.id, { display_name: named[0]!.display_name, data: (named[0]!.data ?? {}) as Record<string, unknown> });
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
export async function resolveLiveCallQueueState(scoped: Scoped, refs: LiveRowRef[]) {
  const out = new Map<string, CallQueueLiveState>();
  const found = await liveObjectsForRows(scoped, 'call_queue', refs);
  for (const [rowId, r] of found) {
    const d = r.data;
    const agents = Array.isArray(d.Agents)
      ? (d.Agents as Record<string, unknown>[])
          .map((a) => (typeof a?.ObjectId === 'string' ? a.ObjectId : null))
          .filter((v): v is string => !!v)
      : [];
    out.set(rowId, {
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
      overflowExtras: liveCallQueueActionExtras('Overflow', d, decodeCallQueueEnum(d.OverflowAction, CALL_QUEUE_OVERFLOW_ACTIONS)),
      timeoutExtras: liveCallQueueActionExtras('Timeout', d, decodeCallQueueEnum(d.TimeoutAction, CALL_QUEUE_TIMEOUT_ACTIONS)),
      noAgentExtras: liveCallQueueActionExtras('NoAgent', d, decodeCallQueueEnum(d.NoAgentAction, CALL_QUEUE_NO_AGENT_ACTIONS)),
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
  refs: LiveRowRef[],
  deep?: { scheduleByKey: Map<string, Record<string, unknown>>; resolveTarget: (ref: LiveCallableEntityRef | undefined) => AutoAttendantCallableEntity | undefined },
): Promise<Map<string, AutoAttendantLiveState>> {
  const out = new Map<string, AutoAttendantLiveState>();
  const found = await liveObjectsForRows(scoped, 'auto_attendant', refs);
  for (const [rowId, r] of found) {
    const d = r.data;
    out.set(rowId, {
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
 * Turns a live menu-option / operator target into the design's own form. ONE implementation, used by Populate and by the deployment
 * preview, so what is read from Teams and what is compared with it can never disagree. A voice app that is part of the site becomes
 * a reference to its row (`buildId`); one that exists in Teams but not on this site keeps the Teams id it has (`liveId`) instead of
 * being dropped, which would silently turn the transfer into a disconnect.
 */
export function makeAutoAttendantTargetResolver(ctx: {
  upnByEntraId: Map<string, string>;
  /** resource account object id (lower case) -> Identity (lower case) of the voice app that lists it */
  ownerByInstance: Map<string, string>;
  /** live Identity (lower case) -> this site's own row */
  liveIdToBuild: Map<string, { kind: 'auto_attendant' | 'call_queue'; buildId: string }>;
  /** live Identity (lower case) -> what kind of voice app it is, for every one in the tenant */
  liveKindByIdentity: Map<string, 'auto_attendant' | 'call_queue'>;
}) {
  return (ref: LiveCallableEntityRef | undefined): AutoAttendantCallableEntity | undefined => {
    if (!ref) return undefined;
    if (ref.kind === 'external' && ref.number) return { kind: 'external', number: ref.number };
    if (ref.kind === 'user' && ref.liveId) {
      const upn = ctx.upnByEntraId.get(ref.liveId.toLowerCase());
      return upn ? { kind: 'user', upn } : undefined;
    }
    if (ref.kind === 'shared_voicemail' && ref.liveId) return { kind: 'shared_voicemail', groupId: ref.liveId };
    const appIdentity = ref.kind === 'voice_app' ? ref.liveId?.toLowerCase() : ref.kind === 'resource_account' && ref.liveId ? ctx.ownerByInstance.get(ref.liveId.toLowerCase()) : undefined;
    if (!appIdentity) return undefined;
    const hit = ctx.liveIdToBuild.get(appIdentity);
    if (hit) return { kind: hit.kind, buildId: hit.buildId };
    return { kind: ctx.liveKindByIdentity.get(appIdentity) ?? 'auto_attendant', liveId: appIdentity };
  };
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
  const [scheduleRows, userRows, voiceAppRows] = await Promise.all([
    s.selectFrom('tenant_objects').select(['object_key', 'data']).where('object_type', '=', 'schedule').where('removed_at', 'is', null).execute(),
    s.selectFrom('tenant_users').select(['entra_id', 'upn']).where('entra_id', 'is not', null).execute(),
    s
      .selectFrom('tenant_objects')
      .select(['object_type', 'data'])
      .where('object_type', 'in', ['auto_attendant', 'call_queue'])
      .where('removed_at', 'is', null)
      .execute(),
  ]);
  const scheduleByKey = new Map(scheduleRows.map((r) => [r.object_key, r.data as Record<string, unknown>]));
  const upnByEntraId = new Map(userRows.map((r) => [r.entra_id!.toLowerCase(), r.upn]));
  const liveIdToBuild = new Map<string, { kind: 'auto_attendant' | 'call_queue'; buildId: string }>();
  for (const [key, identity] of crossRef) {
    const sep = key.indexOf(':');
    liveIdToBuild.set(identity.toLowerCase(), { kind: key.slice(0, sep) as 'auto_attendant' | 'call_queue', buildId: key.slice(sep + 1) });
  }
  // A transfer to a resource account (ApplicationEndpoint) reaches the AA/CQ
  // that account is associated with - map it through that AA/CQ's own
  // ApplicationInstances to the same target a direct (ConfigurationEndpoint)
  // transfer resolves to.
  const ownerByInstance = new Map<string, string>();
  const liveKindByIdentity = new Map<string, 'auto_attendant' | 'call_queue'>();
  for (const r of voiceAppRows) {
    const d = r.data as Record<string, unknown>;
    const identity = typeof d.Identity === 'string' ? d.Identity : undefined;
    if (!identity) continue;
    liveKindByIdentity.set(identity.toLowerCase(), r.object_type as 'auto_attendant' | 'call_queue');
    if (!Array.isArray(d.ApplicationInstances)) continue;
    for (const i of d.ApplicationInstances as unknown[]) if (typeof i === 'string') ownerByInstance.set(i.toLowerCase(), identity.toLowerCase());
  }
  const resolveTarget = makeAutoAttendantTargetResolver({ upnByEntraId, ownerByInstance, liveIdToBuild, liveKindByIdentity });
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
    s.selectFrom('build_auto_attendants').select(['id', 'name', 'discovery_voice_app_id']).where('site_id', '=', siteId).execute(),
    s.selectFrom('build_call_queues').select(['id', 'name', 'discovery_voice_app_id']).where('site_id', '=', siteId).execute(),
  ]);
  const [liveAa, liveCq] = await Promise.all([
    resolveLiveAutoAttendantState(s, aaRows),
    resolveLiveCallQueueState(s, cqRows),
  ]);
  const crossRef: AutoAttendantCrossRef = new Map();
  for (const row of aaRows) {
    const live = liveAa.get(row.id);
    if (live?.identity) crossRef.set(`auto_attendant:${row.id}`, live.identity);
  }
  for (const row of cqRows) {
    const live = liveCq.get(row.id);
    if (live?.identity) crossRef.set(`call_queue:${row.id}`, live.identity);
  }
  return crossRef;
}

/** The -PhoneNumberType values Set-CsPhoneNumberAssignment accepts. */
const ASSIGNABLE_NUMBER_TYPES = new Set(['CallingPlan', 'DirectRouting', 'OperatorConnect']);

/**
 * Number type (CallingPlan / DirectRouting / OperatorConnect) of each live
 * number, from Discovery's phone number inventory (tenant_objects
 * 'phone_number' = Get-CsPhoneNumberAssignment, keyed by TelephoneNumber).
 * tenant_users only has the LineUri, and putting a number back needs its
 * type - see identityBeforeState in packages/shared/src/deployment-verify.ts.
 * Keyed by the number as given (`+15551234567`); a number Discovery hasn't
 * seen, or of a type that can't be assigned this way, is left out.
 */
export async function resolveLiveNumberTypes(scoped: Scoped, numbers: (string | null | undefined)[]) {
  const wanted = [...new Set(numbers.filter((n): n is string => !!n))];
  const out = new Map<string, string>();
  if (wanted.length === 0) return out;
  const rows = await scoped
    .selectFrom('tenant_objects')
    .select(['object_key', 'data'])
    .where('object_type', '=', 'phone_number')
    .where('removed_at', 'is', null)
    .where('object_key', 'in', wanted)
    .execute();
  for (const r of rows) {
    const type = (r.data as Record<string, unknown>)?.NumberType;
    if (typeof type === 'string' && ASSIGNABLE_NUMBER_TYPES.has(type)) out.set(r.object_key, type);
  }
  return out;
}
