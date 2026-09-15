import {
  AA_CALLABLE_ENTITY_KINDS,
  AA_DIRECTORY_SEARCH_METHODS,
  AA_DTMF_RESPONSES,
  AA_MENU_OPTION_ACTIONS,
  AA_SCHEDULE_TYPES,
  CALL_QUEUE_NO_AGENT_ACTIONS,
  CALL_QUEUE_OVERFLOW_ACTIONS,
  CALL_QUEUE_ROUTING_METHODS,
  CALL_QUEUE_TIMEOUT_ACTIONS,
  GREETING_TYPES,
  POLICY_KIND_TO_TENANT_TYPE,
  POLICY_KINDS,
  RESOURCE_ACCOUNT_APPLICATION_IDS,
} from './domain';

/**
 * What Discovery's live-tenant snapshot (tenant_users) knows about a UPN -
 * the same data BuildValidationService compares against for Design & Build's
 * amber "pending change" badge (apps/api/src/modules/build/
 * build-validation.service.ts), reused here so a deployment only issues a
 * cmdlet when it would actually change something. `undefined` means no live
 * row was found for this UPN (e.g. a brand-new user not yet in the tenant) -
 * callers fall back to always emitting, since there's nothing to diff
 * against.
 */
export interface LiveIdentityState {
  enterpriseVoiceEnabled: boolean;
  lineUri: string | null;
  /** keyed by TenantPolicyType (e.g. 'OnlineVoiceRoutingPolicy') - the raw tenant_users.policies shape. */
  policies: Record<string, string | null>;
  /** tenant_users.object_id - the Entra object GUID, needed by cmdlets that take -Users/-Identities as GUIDs (e.g. Set-CsCallQueue), not UPNs. */
  objectId?: string;
}

/** Last 10 significant digits, for loose number matching (same rule Data Collection and Design & Build use). */
function numKey(v: string | null | undefined): string {
  return String(v ?? '').replace(/\D/g, '').slice(-10);
}

/**
 * One local, non-mutating object-constructor line needed before a compound
 * cmdlet can run - e.g. Auto Attendant deployment's real construction chain
 * (New-CsAutoAttendantCallableEntity -> ...Prompt -> ...MenuOption ->
 * ...Menu -> ...CallFlow -> New-CsOnlineSchedule -> ...CallHandlingAssociation)
 * before the one call that actually mutates the tenant
 * (New-CsAutoAttendant). Assigned to a PowerShell variable so later steps -
 * including the CmdletInvocation's own `parameters` - can reference it via
 * a `VarRef` instead of a literal value. Never audited/recorded on its own;
 * see renderCommand and handleDeploymentRun in apps/worker/src/main.ts,
 * which treats a CmdletInvocation with a `preamble` as a single change.
 */
export interface PreambleStep {
  /** PowerShell variable name (no leading $) this step's result is assigned to. */
  assignTo: string;
  cmdlet: string;
  parameters: Record<string, unknown>;
}

/** Sentinel: reference an earlier PreambleStep's result by variable name, instead of a literal value. */
export interface VarRef {
  $var: string;
}

function isVarRef(v: unknown): v is VarRef {
  return typeof v === 'object' && v !== null && typeof (v as VarRef).$var === 'string';
}

export interface CmdletInvocation {
  cmdlet: string;
  parameters: Record<string, unknown>;
  objectType: string;
  objectId?: string;
  /**
   * True for a cmdlet that must never run live - e.g. New-CsOnlineApplicationInstance,
   * which always needs a manual licensing step (a role a Teams Administrator
   * doesn't have) before anything downstream can succeed. A deferred call is
   * always rendered to the exported script and recorded as 'whatif', in both
   * dry_run and execute mode - see handleDeploymentRun in apps/worker/src/main.ts.
   */
  deferred?: boolean;
  /** Local object-construction lines to run first - see PreambleStep. Rendered (renderCommand) and executed (pwsh-executor's invoke) as one multi-line script; still exactly one deployment_changes row. */
  preamble?: PreambleStep[];
}

/**
 * PowerShell single-quoted string literal. Single quotes are the only safe
 * choice here: PS double-quoted strings interpolate `$variables` and treat
 * backslash as a plain character (not an escape), so `JSON.stringify` output
 * (which escapes `"` as `\"`) does NOT close cleanly inside one - a value
 * containing a `"` breaks out of the literal and the remainder is parsed as
 * live PowerShell. A single-quoted literal has exactly one escape rule -
 * double an embedded `'` - and no other metacharacter has special meaning
 * inside it, so this is immune to both injection and variable expansion.
 */
export function psQuote(v: string): string {
  return `'${v.replace(/'/g, "''")}'`;
}

/** Render one -Param value; a VarRef renders as a bare `$name` (no quoting - it's a variable reference, not a literal). */
function renderValue(v: unknown): string | null {
  if (v === undefined || v === null || v === '') return null;
  if (isVarRef(v)) return `$${v.$var}`;
  if (Array.isArray(v)) {
    if (v.length === 0) return null;
    return `@(${v.map((item) => (isVarRef(item) ? `$${item.$var}` : psQuote(String(item)))).join(', ')})`;
  }
  if (typeof v === 'boolean') return `$${v}`;
  if (typeof v === 'number') return String(v);
  return psQuote(String(v));
}

function renderStatement(cmdlet: string, parameters: Record<string, unknown>): string {
  const parts = [cmdlet];
  for (const [k, v] of Object.entries(parameters)) {
    const rendered = renderValue(v);
    if (rendered !== null) parts.push(`-${k} ${rendered}`);
  }
  return parts.join(' ');
}

/**
 * Render a cmdlet + params as PowerShell (What-If output, and the
 * executor - see PwshTeamsExecutor.invoke, which appends `-ErrorAction Stop`
 * straight onto this string, so the LAST line must always be the one real
 * mutating call). A `preamble` renders as one construction line per step
 * before it, each usable by name (via VarRef) in any later step or in this
 * call's own `parameters`.
 */
export function renderCommand(call: CmdletInvocation): string {
  const lines = (call.preamble ?? []).map((step) => `$${step.assignTo} = ${renderStatement(step.cmdlet, step.parameters)}`);
  lines.push(renderStatement(call.cmdlet, call.parameters));
  return lines.join('\n');
}

/** Mirrors dto.ts's callForwardingSchema exactly - see that file for the field-by-field cmdlet mapping. */
export interface CallForwardingSettings {
  forwarding?: {
    enabled: boolean;
    type?: 'Immediate' | 'Simultaneous';
    targetType?: 'Voicemail' | 'SingleTarget' | 'MyDelegates' | 'Group';
    target?: string | null;
  };
  unanswered?: {
    enabled: boolean;
    delaySeconds?: number;
    targetType?: 'Voicemail' | 'SingleTarget' | 'MyDelegates' | 'Group';
    target?: string | null;
  };
  busyOnBusy?: 'PlayBusySignal' | 'RedirectAsUnansweredCall' | 'RingUser';
}

/** Mirrors dto.ts's pickupGroupSchema - Set-CsUserCallingSettings' CallGroup settings group. */
export interface PickupGroupSettings {
  order: 'Simultaneous' | 'InOrder';
  targets: string[];
}

/** Mirrors dto.ts's delegateSchema - New-CsUserCallingDelegate's own parameters, one entry per delegate. */
export interface CallDelegate {
  delegateUpn: string;
  makeCalls: boolean;
  receiveCalls: boolean;
  manageSettings: boolean;
  pickUpHeldCalls: boolean;
  joinActiveCalls: boolean;
}

export interface BuildIdentityRow {
  id: string;
  upn: string;
  e164: string | null;
  number_type: string | null;
  revoke_ev: boolean;
  policies: Record<string, string | null> | null;
  voicemail: { enabled?: boolean | null; language?: string | null } | null;
  call_forwarding: CallForwardingSettings | null;
  pickup_group: PickupGroupSettings | null;
  delegates: CallDelegate[] | null;
}

/** hh:mm:ss format Set-CsUserCallingSettings' -UnansweredDelay expects. */
function toHms(totalSeconds: number): string {
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = totalSeconds % 60;
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(h)}:${pad(m)}:${pad(s)}`;
}

/**
 * Flags a build_users/build_caps row whose phone number won't actually get
 * assigned: planIdentityRow's Set-CsPhoneNumberAssignment guard (below)
 * requires `number_type` too, and a row can easily have `e164` set with
 * `number_type` still null (e.g. populated from Discovery on a site with no
 * PSTN/licensing model chosen yet) - that command, and the Enterprise Voice
 * enablement it carries, then just silently never appears in the plan.
 */
export function identityRowWarnings(row: Pick<BuildIdentityRow, 'e164' | 'number_type' | 'policies'>): string[] {
  if (row.policies?.shared_calling_policy && row.e164) {
    // Per Microsoft's Shared Calling setup guide, a Shared Calling user
    // shouldn't be assigned a phone number at all - planIdentityRow enables
    // Enterprise Voice directly for these rows and never emits
    // Set-CsPhoneNumberAssignment with a number, so this row's number is
    // just being silently ignored rather than deployed wrong - flag it so
    // it's not mistaken for a working assignment.
    return [
      "Shared Calling policy is set but this row also has a phone number - Shared Calling users shouldn't have one assigned. The number on this row will be ignored by deployment.",
    ];
  }
  return row.e164 && !row.number_type
    ? ['Phone number set but no Number type - Set-CsPhoneNumberAssignment (and Enterprise Voice) will be skipped until Number type is set.']
    : [];
}

/**
 * Turn a build_users/build_caps row into the ordered list of cmdlets the
 * deployment engine would run. Mirrors the order in the real
 * Teams-Migration-Build .ps1: number assignment first, then policy grants.
 * Users and CAPs plan identically - only the object type tag differs, matching
 * `deployment_changes.object_type` ('user' | 'cap').
 */
export function planIdentityRow(
  row: BuildIdentityRow,
  objectType: 'user' | 'cap',
  live?: LiveIdentityState,
): CmdletInvocation[] {
  const calls: CmdletInvocation[] = [];
  const identity = row.upn;

  if (row.revoke_ev) {
    // Skip if live already shows EV off - nothing left to revoke.
    if (!live || live.enterpriseVoiceEnabled) {
      calls.push({
        cmdlet: 'Remove-CsPhoneNumberAssignment',
        parameters: { Identity: identity, RemoveAll: true },
        objectType,
        objectId: row.id,
      });
    }
    return calls;
  }

  if (row.policies?.shared_calling_policy) {
    // Shared Calling users don't get a phone number - Set-CsPhoneNumberAssignment's
    // separate "Attribute" parameter set enables Enterprise Voice on its own
    // (see docs/DEPLOYMENT.md and Microsoft's Shared Calling setup guide).
    // The Grant-CsTeamsSharedCallingRoutingPolicy call below (from POLICY_KINDS)
    // is what actually gives them calling via the resource account.
    if (!live || !live.enterpriseVoiceEnabled) {
      calls.push({
        cmdlet: 'Set-CsPhoneNumberAssignment',
        parameters: { Identity: identity, EnterpriseVoiceEnabled: true },
        objectType,
        objectId: row.id,
      });
    }
  } else if (row.e164 && row.number_type && (!live || numKey(live.lineUri) !== numKey(row.e164))) {
    // Skip if live already has this number - can only compare the number
    // itself (normalized), not the assignment type (DirectRouting/CallingPlan/
    // etc): Discovery doesn't track live number type per-assignment.
    calls.push({
      cmdlet: 'Set-CsPhoneNumberAssignment',
      parameters: {
        Identity: identity,
        PhoneNumber: row.e164,
        PhoneNumberType: row.number_type,
      },
      objectType,
      objectId: row.id,
    });
  }

  for (const kind of POLICY_KINDS) {
    const value = row.policies?.[kind.key];
    if (!value) continue;
    // Every kind maps to a live TenantPolicyType (POLICY_KIND_TO_TENANT_TYPE);
    // the guard is just defensive for any future kind added without one.
    const tenantType = POLICY_KIND_TO_TENANT_TYPE[kind.key];
    if (tenantType && live && live.policies[tenantType] === value) continue;
    calls.push({
      cmdlet: kind.cmdlet,
      parameters: { Identity: identity, PolicyName: value },
      objectType,
      objectId: row.id,
    });
  }

  // Voicemail on/off + language are settings we set directly in Teams
  // (Set-CsOnlineVoicemailUserSettings), not a policy grant - separate from
  // voicemail_policy in POLICY_KINDS above, which governs a different set of
  // tenant-defined behaviours. `row.voicemail.enabled` undefined/null means
  // "not designed yet" and is left alone; explicitly true/false is a real
  // target either way. Can't be diffed against live like the fields above -
  // Discovery doesn't sync voicemail settings yet (Get-CsOnlineVoicemailUserSettings
  // is per-user, so it's a targeted-run job, not a full-sweep one) - so this
  // always re-issues the cmdlet whenever a target is set.
  if (row.voicemail?.enabled != null) {
    calls.push({
      cmdlet: 'Set-CsOnlineVoicemailUserSettings',
      parameters: {
        Identity: identity,
        VoicemailEnabled: row.voicemail.enabled,
        ...(row.voicemail.enabled && row.voicemail.language ? { PromptLanguage: row.voicemail.language } : {}),
      },
      objectType,
      objectId: row.id,
    });
  }

  // Call forwarding / unanswered / busy-on-busy / pickup group / delegates -
  // Set-CsUserCallingSettings and New-CsUserCallingDelegate, per
  // docs/DEPLOYMENT.md's "natural next increment". None of these are
  // diffable against live state yet (Discovery doesn't capture
  // Get-CsUserCallingSettings - see build-validation.service.ts), so - like
  // voicemail above - they always re-issue whenever a target is designed.
  if (row.call_forwarding?.forwarding) {
    const f = row.call_forwarding.forwarding;
    calls.push({
      cmdlet: 'Set-CsUserCallingSettings',
      parameters: {
        Identity: identity,
        IsForwardingEnabled: f.enabled,
        ...(f.enabled ? { ForwardingType: f.type, ForwardingTargetType: f.targetType, ForwardingTarget: f.target } : {}),
      },
      objectType,
      objectId: row.id,
    });
  }
  if (row.call_forwarding?.unanswered) {
    const u = row.call_forwarding.unanswered;
    calls.push({
      cmdlet: 'Set-CsUserCallingSettings',
      parameters: {
        Identity: identity,
        IsUnansweredEnabled: u.enabled,
        ...(u.enabled
          ? {
              UnansweredDelay: toHms(u.delaySeconds ?? 20),
              UnansweredTargetType: u.targetType,
              UnansweredTarget: u.target,
            }
          : {}),
      },
      objectType,
      objectId: row.id,
    });
  }
  if (row.call_forwarding?.busyOnBusy) {
    calls.push({
      cmdlet: 'Set-CsUserCallingSettings',
      parameters: { Identity: identity, BusyOnBusyOption: row.call_forwarding.busyOnBusy },
      objectType,
      objectId: row.id,
    });
  }
  if (row.pickup_group?.targets?.length) {
    calls.push({
      cmdlet: 'Set-CsUserCallingSettings',
      parameters: {
        Identity: identity,
        CallGroupOrder: row.pickup_group.order,
        CallGroupTargets: row.pickup_group.targets,
      },
      objectType,
      objectId: row.id,
    });
  }
  for (const d of Array.isArray(row.delegates) ? row.delegates : []) {
    calls.push({
      cmdlet: 'New-CsUserCallingDelegate',
      parameters: {
        Identity: identity,
        Delegate: d.delegateUpn,
        MakeCalls: d.makeCalls,
        ReceiveCalls: d.receiveCalls,
        ManageSettings: d.manageSettings,
        PickUpHeldCalls: d.pickUpHeldCalls,
        JoinActiveCalls: d.joinActiveCalls,
      },
      objectType,
      objectId: row.id,
    });
  }

  return calls;
}

export interface BuildResourceAccountRow {
  id: string;
  upn: string;
  display_name: string | null;
  kind: 'auto_attendant' | 'call_queue';
  location_id: string | null;
  phone_number: string | null;
  number_type: string | null;
  voice_routing_policy: string | null;
  application_id: string | null;
}

/** Same gap as identityRowWarnings, for build_resource_accounts. */
export function resourceAccountRowWarnings(row: Pick<BuildResourceAccountRow, 'phone_number' | 'number_type'>): string[] {
  return row.phone_number && !row.number_type
    ? ['Phone number set but no Number type - Set-CsPhoneNumberAssignment (and Enterprise Voice) will be skipped until Number type is set.']
    : [];
}

/**
 * Resource accounts are a genuine two-phase process (see docs/DEPLOYMENT.md):
 * New-CsOnlineApplicationInstance always needs a Phone System license applied
 * by a User/Global Admin before anything else can succeed - a role a Teams
 * Administrator doesn't have. So phase 1 is always `deferred: true` (rendered
 * to the exported script, never invoked live, in either dry_run or execute
 * mode). Only once the row has an `application_id` from a completed phase 1
 * does phase 2 (number + voice routing policy, live-capable) run.
 */
export function planResourceAccountRow(row: BuildResourceAccountRow, live?: LiveIdentityState): CmdletInvocation[] {
  if (!row.application_id) {
    return [
      {
        cmdlet: 'New-CsOnlineApplicationInstance',
        parameters: {
          UserPrincipalName: row.upn,
          ApplicationId: RESOURCE_ACCOUNT_APPLICATION_IDS[row.kind],
          DisplayName: row.display_name ?? row.upn,
        },
        objectType: 'resource_account',
        objectId: row.id,
        deferred: true,
      },
    ];
  }

  const calls: CmdletInvocation[] = [];
  // Same diffing as planIdentityRow - a resource account is a normal
  // Entra/Teams identity under its own UPN, so it appears in tenant_users
  // (Discovery's live snapshot) just like a regular user or CAP.
  if (row.phone_number && row.number_type && (!live || numKey(live.lineUri) !== numKey(row.phone_number))) {
    calls.push({
      cmdlet: 'Set-CsPhoneNumberAssignment',
      parameters: {
        Identity: row.upn,
        PhoneNumber: row.phone_number,
        PhoneNumberType: row.number_type,
        ...(row.location_id ? { LocationId: row.location_id } : {}),
      },
      objectType: 'resource_account',
      objectId: row.id,
    });
  }
  if (row.voice_routing_policy && (!live || live.policies['OnlineVoiceRoutingPolicy'] !== row.voice_routing_policy)) {
    calls.push({
      cmdlet: 'Grant-CsOnlineVoiceRoutingPolicy',
      parameters: { Identity: row.upn, PolicyName: row.voice_routing_policy },
      objectType: 'resource_account',
      objectId: row.id,
    });
  }
  return calls;
}

type CallQueueRoutingMethod = (typeof CALL_QUEUE_ROUTING_METHODS)[number];

/** Mirrors dto.ts's callQueueActionSchema - Set-CsCallQueue's Overflow/Timeout parameter groups. */
export interface CallQueueActionSettings {
  action?: string;
  threshold?: number;
  target?: string | null;
}

export interface BuildCallQueueRow {
  id: string;
  name: string;
  routing_method: CallQueueRoutingMethod;
  agent_alert_time: number;
  presence_based_routing: boolean;
  /** agent UPNs - resolved to Entra object GUIDs via agentObjectIds before planning, see planCallQueueRow. */
  agents: string[];
  overflow: CallQueueActionSettings | null;
  timeout: CallQueueActionSettings | null;
  /** Zero-agents-opted-in action - same shape as overflow/timeout, Set-CsCallQueue -NoAgentAction/-NoAgentActionTarget. */
  no_agent_action: CallQueueActionSettings | null;
  /** Set-CsCallQueue -NoAgentApplyTo. */
  no_agent_apply_to: 'AllCalls' | 'NewCalls' | null;
  language_id: string | null;
  /** build_resource_accounts.id array - resolved to Application Instance GUIDs via raObjectIds. */
  resource_accounts: string[];
}

/**
 * What Discovery's live-tenant snapshot (tenant_objects, object_type
 * 'call_queue') knows about a queue matched by Name - undefined means the
 * queue doesn't exist live yet, so New-CsCallQueue is emitted instead of
 * Set-CsCallQueue. `identity` is the queue's own Identity GUID, needed to
 * target Set-CsCallQueue and to associate a resource account with it.
 */
export interface CallQueueLiveState {
  identity: string;
  routingMethod?: string;
  agentAlertTime?: number;
  presenceBasedRouting?: boolean;
  agentObjectIds?: string[];
  overflowAction?: string;
  overflowThreshold?: number;
  timeoutAction?: string;
  timeoutThreshold?: number;
  /** No live NoAgentThreshold exists - "no agents" fires purely on zero agents opted in, not a numeric threshold. */
  noAgentAction?: string;
}

/**
 * Get-CsCallQueue serializes RoutingMethod/OverflowAction/TimeoutAction/
 * NoAgentAction as their underlying numeric enum value, not the string name
 * PowerShell displays - confirmed against OVP012's real live tenant_objects
 * data this session (e.g. `OverflowAction: 3`, not `"SharedVoicemail"`).
 * Callers building CallQueueLiveState from raw tenant_objects.data must
 * decode through this instead of a bare `typeof v === 'string'` check, or
 * every real tenant's live-diff silently sees `undefined` and never detects
 * "unchanged". The numeric codes line up with these arrays' own index order.
 */
export function decodeCallQueueEnum(v: unknown, values: readonly string[]): string | undefined {
  if (typeof v === 'string') return v;
  if (typeof v === 'number' && values[v] !== undefined) return values[v];
  return undefined;
}

/**
 * Flags agent UPNs / linked resource accounts that don't resolve to a live
 * Entra object id - planCallQueueRow silently skips these (a typo'd UPN or a
 * resource account not yet licensed shouldn't block the rest of the queue's
 * config from deploying), so this is the only place that gap is visible.
 */
export function callQueueRowWarnings(
  row: Pick<BuildCallQueueRow, 'agents' | 'resource_accounts'>,
  agentObjectIds: Map<string, string>,
  raObjectIds: Map<string, string>,
): string[] {
  const warnings: string[] = [];
  const unresolvedAgents = row.agents.filter((upn) => !agentObjectIds.has(upn.toLowerCase()));
  if (unresolvedAgents.length) {
    warnings.push(
      `${unresolvedAgents.length} agent UPN(s) not found in the tenant's synced users, so they'll be skipped: ${unresolvedAgents.join(', ')}`,
    );
  }
  const unresolvedRas = row.resource_accounts.filter((id) => !raObjectIds.has(id));
  if (unresolvedRas.length) {
    warnings.push(
      `${unresolvedRas.length} linked resource account(s) have no live Application Instance yet (New-CsOnlineApplicationInstance not run), so this queue won't get a phone number until that's done.`,
    );
  }
  return warnings;
}

/**
 * Turn a build_call_queues row into the ordered list of cmdlets: create/
 * update the queue itself (New-CsCallQueue / Set-CsCallQueue), then
 * associate any linked resource accounts so the queue actually has a phone
 * number (New-CsOnlineApplicationInstanceAssociation). Only the Call Queue
 * subset of Set-CsCallQueue's full parameter surface is implemented here -
 * see the Phase B plan for the full list of what's deliberately left out
 * (ConferenceMode, DistributionLists, compliance recording, etc).
 */
export function planCallQueueRow(
  row: BuildCallQueueRow,
  agentObjectIds: Map<string, string>,
  raObjectIds: Map<string, string>,
  live?: CallQueueLiveState,
): CmdletInvocation[] {
  const calls: CmdletInvocation[] = [];
  const users = row.agents
    .map((upn) => agentObjectIds.get(upn.toLowerCase()))
    .filter((id): id is string => !!id);
  const needsLanguage =
    row.overflow?.action === 'SharedVoicemail' ||
    row.timeout?.action === 'SharedVoicemail' ||
    row.no_agent_action?.action === 'SharedVoicemail';

  const parameters: Record<string, unknown> = {
    Name: row.name,
    RoutingMethod: row.routing_method,
    AgentAlertTime: row.agent_alert_time,
    PresenceBasedRouting: row.presence_based_routing,
    Users: users,
    ...(needsLanguage && row.language_id ? { LanguageId: row.language_id } : {}),
    ...(row.overflow?.action ? { OverflowAction: row.overflow.action } : {}),
    ...(row.overflow?.threshold != null ? { OverflowThreshold: row.overflow.threshold } : {}),
    ...(row.overflow?.target ? { OverflowActionTarget: row.overflow.target } : {}),
    ...(row.timeout?.action ? { TimeoutAction: row.timeout.action } : {}),
    ...(row.timeout?.threshold != null ? { TimeoutThreshold: row.timeout.threshold } : {}),
    ...(row.timeout?.target ? { TimeoutActionTarget: row.timeout.target } : {}),
    ...(row.no_agent_action?.action ? { NoAgentAction: row.no_agent_action.action } : {}),
    ...(row.no_agent_action?.target ? { NoAgentActionTarget: row.no_agent_action.target } : {}),
    ...(row.no_agent_apply_to ? { NoAgentApplyTo: row.no_agent_apply_to } : {}),
  };

  if (!live) {
    calls.push({ cmdlet: 'New-CsCallQueue', parameters, objectType: 'call_queue', objectId: row.id });
  } else {
    const sortedUsers = [...users].sort();
    const sortedLive = [...(live.agentObjectIds ?? [])].sort();
    const changed =
      live.routingMethod !== row.routing_method ||
      live.agentAlertTime !== row.agent_alert_time ||
      live.presenceBasedRouting !== row.presence_based_routing ||
      (live.overflowAction ?? undefined) !== (row.overflow?.action ?? undefined) ||
      (live.overflowThreshold ?? undefined) !== (row.overflow?.threshold ?? undefined) ||
      (live.timeoutAction ?? undefined) !== (row.timeout?.action ?? undefined) ||
      (live.timeoutThreshold ?? undefined) !== (row.timeout?.threshold ?? undefined) ||
      (live.noAgentAction ?? undefined) !== (row.no_agent_action?.action ?? undefined) ||
      JSON.stringify(sortedUsers) !== JSON.stringify(sortedLive);
    if (changed) {
      calls.push({
        cmdlet: 'Set-CsCallQueue',
        parameters: { Identity: live.identity, ...parameters },
        objectType: 'call_queue',
        objectId: row.id,
      });
    }
  }

  // The queue needs a live Identity before it can be associated with a
  // resource account, so this only ever plans once New-CsCallQueue has
  // already run on a prior pass (mirrors the two-phase resource-account
  // pattern above). Known limitation, called out in the Phase B plan:
  // Get-CsCallQueue's raw output doesn't reliably expose which Application
  // Instances are already associated (undocumented on Microsoft Learn as of
  // this writing), so this can't diff against live state the way the rest
  // of this function does - it re-emits every pass a linked resource
  // account resolves live, which New-CsOnlineApplicationInstanceAssociation
  // tolerates being re-run with the same target.
  const linkedInstanceIds = row.resource_accounts.map((id) => raObjectIds.get(id)).filter((id): id is string => !!id);
  if (live?.identity && linkedInstanceIds.length > 0) {
    calls.push({
      cmdlet: 'New-CsOnlineApplicationInstanceAssociation',
      parameters: { Identities: linkedInstanceIds, ConfigurationId: live.identity, ConfigurationType: 'CallQueue' },
      objectType: 'call_queue',
      objectId: row.id,
    });
  }

  return calls;
}

/* ========================================================================
 * Auto Attendants - structured call-flow config, mirroring
 * BuildAutoAttendantsTable's columns (packages/db/src/schema.ts). Reverse-
 * engineered against OVP012's real live Auto Attendants and Microsoft
 * Learn's New-CsAutoAttendant construction chain this session - see the
 * "reverse-engineer OVP012" plan. planAutoAttendantRow itself (the actual
 * cmdlet-chain builder) needs the `preamble` extension to CmdletInvocation
 * below and is implemented separately; these are the data shapes it will
 * consume, and what BuildAutoAttendantsTable/buildAutoAttendantWritable
 * already store today.
 * ======================================================================== */

/**
 * A transfer target - New-CsAutoAttendantCallableEntity's -Type, plus the
 * app-only 'auto_attendant'/'call_queue' kinds for same-site menu targets
 * (resolved to the target's live Identity at deploy time, the same way
 * planCallQueueRow resolves agent UPNs - see raObjectIds-style resolution).
 * Mirrors dto.ts's autoAttendantCallableEntitySchema.
 */
export interface AutoAttendantCallableEntity {
  kind: (typeof AA_CALLABLE_ENTITY_KINDS)[number];
  /** build_auto_attendants.id or build_call_queues.id - same-site, app-enforced like policy_ids. Only for kind 'auto_attendant'|'call_queue'. */
  buildId?: string;
  /** UPN - only for kind 'user'. */
  upn?: string;
  /** tel: number or raw digits - only for kind 'external'. */
  number?: string;
}

/** New-CsAutoAttendantPrompt - a greeting or menu prompt. Mirrors dto.ts's autoAttendantPromptSchema. */
export interface AutoAttendantPrompt {
  type: (typeof GREETING_TYPES)[number];
  text?: string;
  /** files.id (an uploaded audio prompt) - only for type 'AudioFile'. */
  fileId?: string;
}

/** New-CsAutoAttendantMenuOption. Mirrors dto.ts's autoAttendantMenuOptionSchema. */
export interface AutoAttendantMenuOption {
  dtmf: (typeof AA_DTMF_RESPONSES)[number];
  action: (typeof AA_MENU_OPTION_ACTIONS)[number];
  target?: AutoAttendantCallableEntity;
}

/** New-CsAutoAttendantMenu. Mirrors dto.ts's autoAttendantMenuSchema. */
export interface AutoAttendantMenu {
  enableDialByName?: boolean;
  directorySearchMethod?: (typeof AA_DIRECTORY_SEARCH_METHODS)[number];
  options: AutoAttendantMenuOption[];
}

/** New-CsAutoAttendantCallFlow. Mirrors dto.ts's autoAttendantCallFlowSchema. */
export interface AutoAttendantCallFlow {
  greetings: AutoAttendantPrompt[];
  menu: AutoAttendantMenu;
}

/** New-CsOnlineTimeRange. */
export interface AutoAttendantTimeRange {
  /** "HH:mm" */
  start: string;
  end: string;
}

/** New-CsOnlineSchedule. Mirrors dto.ts's autoAttendantScheduleSchema. */
export interface AutoAttendantSchedule {
  type: (typeof AA_SCHEDULE_TYPES)[number];
  weekly?: {
    monday: AutoAttendantTimeRange[];
    tuesday: AutoAttendantTimeRange[];
    wednesday: AutoAttendantTimeRange[];
    thursday: AutoAttendantTimeRange[];
    friday: AutoAttendantTimeRange[];
    saturday: AutoAttendantTimeRange[];
    sunday: AutoAttendantTimeRange[];
    /** New-CsOnlineSchedule -Complement - the hours above are business hours; this schedule fires outside them. */
    complement?: boolean;
  };
  fixed?: {
    /** ISO date strings, e.g. a holiday date range. */
    ranges: { start: string; end: string }[];
  };
}

/** One New-CsAutoAttendantCallHandlingAssociation of Type Holiday, paired with its own schedule. Mirrors dto.ts's autoAttendantHolidayCallFlowSchema. */
export interface AutoAttendantHolidayCallFlow {
  name: string;
  callFlow: AutoAttendantCallFlow;
  schedule: AutoAttendantSchedule;
}
