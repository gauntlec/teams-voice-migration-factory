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
import type { LiveAutoAttendantStructured } from './aa-live-parse';

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
  /** tenant_users.entra_id - the real Entra/Azure AD object GUID, needed by cmdlets that take -Users/-Identities as GUIDs (e.g. Set-CsCallQueue), not UPNs. NOT tenant_users.object_id, which is our own internal tenant_objects.id row reference - a bug fixed this session (confirmed against OVP012's real live Call Queue Agents, whose ObjectId matched entra_id, never object_id). */
  objectId?: string;
  /**
   * From a targeted Get-CsOnlineVoicemailUserSettings check (Design &
   * Build's "Validate against tenant"), not the full-tenant sweep -
   * Get-CsOnlineVoicemailUserSettings has no bulk/wildcard form (confirmed
   * against Microsoft Learn: -Identity is mandatory, single value), so it
   * can't join Get-CsOnlineUser's tenant-wide sweep. `undefined` means this
   * UPN has never had a targeted check run - planIdentityRow falls back to
   * always emitting, same as an unmatched `live` elsewhere in this file.
   */
  voicemailEnabled?: boolean;
  voicemailPromptLanguage?: string | null;
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
export interface PreambleCallStep {
  kind?: 'call';
  /** PowerShell variable name (no leading $) this step's result is assigned to. */
  assignTo: string;
  cmdlet: string;
  parameters: Record<string, unknown>;
}

/**
 * `$target.property = value` - not a cmdlet call. Set-CsAutoAttendant has no
 * -Identity/-Name/-LanguageId/... parameters of its own (confirmed against
 * Microsoft Learn - its entire parameter surface is `-Instance`/`-Tenant`);
 * the only supported pattern is Get-CsAutoAttendant -Identity ... into a
 * variable, set each property on that object, then
 * Set-CsAutoAttendant -Instance $that. These steps are how
 * planAutoAttendantRow renders the "set each property" half of that.
 */
export interface PreambleAssignStep {
  kind: 'assign';
  /** PowerShell variable name (no leading $) whose property is being set. */
  target: string;
  property: string;
  value: unknown;
}

export type PreambleStep = PreambleCallStep | PreambleAssignStep;

/**
 * Sentinel: reference an earlier PreambleStep's result by variable name,
 * instead of a literal value. `prop` renders a property access on it
 * (`$name.Id`) - needed for New-CsAutoAttendantCallHandlingAssociation's
 * -ScheduleId/-CallFlowId, which take the *string* Id a locally-constructed
 * New-CsOnlineSchedule/New-CsAutoAttendantCallFlow object generates, not the
 * object itself.
 */
export interface VarRef {
  $var: string;
  prop?: string;
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
  /**
   * Local object-construction lines to run first - see PreambleStep.
   * `renderCommand` flattens these into one multi-line string for display
   * (What-If preview, exported PS1 script), but PwshTeamsExecutor.invoke
   * executes each step as its own separate round-trip to the pwsh session,
   * then the final call as one more - so a hang or error pins to a single
   * named step instead of an opaque combined script. Still exactly one
   * deployment_changes row per CmdletInvocation regardless of preamble size.
   */
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

/** Renders a VarRef as `$name` or, with `prop` set, `$name.Prop` (no quoting either way - it's a variable/property reference, not a literal). */
function renderVarRef(v: VarRef): string {
  return v.prop ? `$${v.$var}.${v.prop}` : `$${v.$var}`;
}

/** Render one -Param value; a VarRef renders per renderVarRef. */
function renderValue(v: unknown): string | null {
  if (v === undefined || v === null || v === '') return null;
  if (isVarRef(v)) return renderVarRef(v);
  if (Array.isArray(v)) {
    if (v.length === 0) return null;
    return `@(${v.map((item) => (isVarRef(item) ? renderVarRef(item) : psQuote(String(item)))).join(', ')})`;
  }
  if (typeof v === 'boolean') return `$${v}`;
  if (typeof v === 'number') return String(v);
  return psQuote(String(v));
}

/** Render one `Cmdlet -Param value ...` statement, with no assignment/wrapping. */
export function renderStatement(cmdlet: string, parameters: Record<string, unknown>): string {
  const parts = [cmdlet];
  for (const [k, v] of Object.entries(parameters)) {
    const rendered = renderValue(v);
    if (rendered === null) continue;
    // A boolean must bind with colon syntax (-Param:$true), never a bare
    // space (-Param $true) - PowerShell only auto-consumes the next token
    // for a switch parameter when it's `:`-joined; written with a space,
    // $true/$false is parsed as a *positional* argument instead, and fails
    // with "A positional parameter cannot be found that accepts argument
    // 'True'" the moment the cmdlet has no positional slot free - confirmed
    // live on New-CsOnlineSchedule's -WeeklyRecurrentSchedule/-Complement.
    // Colon syntax is valid for every switch AND every plain [bool]
    // parameter, so it's safe to use unconditionally here.
    parts.push(typeof v === 'boolean' ? `-${k}:${rendered}` : `-${k} ${rendered}`);
  }
  return parts.join(' ');
}

/**
 * Render exactly one PreambleStep as its own standalone statement - either
 * `$var = Cmdlet ...` (call) or `$target.property = value` (assign). Used
 * both by renderCommand (the flattened preview/export text) and by
 * PwshTeamsExecutor.invoke, which now runs each step as its own separate
 * round-trip to the pwsh session instead of bundling every step into one
 * script - see that file for why (a hung step used to be untraceable inside
 * an opaque multi-line blob).
 */
export function renderPreambleStep(step: PreambleStep): string {
  return step.kind === 'assign'
    ? `$${step.target}.${step.property} = ${renderValue(step.value) ?? '$null'}`
    : `$${step.assignTo} = ${renderStatement(step.cmdlet, step.parameters)}`;
}

/**
 * Render a cmdlet + params as PowerShell (What-If output and the exported
 * PS1 script). A `preamble` renders as one construction line per step
 * before it, each usable by name (via VarRef) in any later step or in this
 * call's own `parameters`. This flattened text is for *display* only now -
 * PwshTeamsExecutor.invoke executes each line as its own round-trip rather
 * than sending this whole string at once.
 */
export function renderCommand(call: CmdletInvocation): string {
  const lines = (call.preamble ?? []).map(renderPreambleStep);
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
  // target either way. Diffed against live.voicemailEnabled/
  // voicemailPromptLanguage when available (from a targeted
  // Get-CsOnlineVoicemailUserSettings check - see LiveIdentityState); if that
  // UPN has never had a targeted check run, `live.voicemailEnabled` is
  // undefined and this falls back to always emitting, same as every other
  // live-optional check in this function.
  if (row.voicemail?.enabled != null) {
    const matches =
      live?.voicemailEnabled === row.voicemail.enabled &&
      (!row.voicemail.enabled || !row.voicemail.language || live.voicemailPromptLanguage === row.voicemail.language);
    if (!matches) {
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
  // build_users/build_caps.pickup_group defaults to `{}` (NOT NULL, see the
  // 0001_init migration) for every never-designed row, so checking the
  // object's mere presence would fire this call for literally every row on
  // every deploy. `order` is only ever set by the settings dialog's own
  // save (BuildSiteWorkspace.tsx) - present means "explicitly designed",
  // absent means "still the untouched default" - so it's the real signal,
  // not `.targets.length` (which the dialog can legitimately save as empty
  // to clear a previously-saved group).
  if (row.pickup_group?.order) {
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

const GUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/**
 * Confirmed against Microsoft Learn: Set-CsCallQueue's Overflow/Timeout/
 * NoAgentActionTarget ("must be set to a Guid or a telephone number with a
 * mandatory 'tel:' prefix") and New-CsAutoAttendantCallableEntity's
 * ExternalPstn -Identity both require a raw PSTN number to carry a 'tel:'
 * prefix - a bare GUID (person, or a nested AA/CQ resource account) or an
 * already-prefixed value passes through unchanged.
 */
export function normalizePstnTarget(target: string): string {
  const trimmed = target.trim();
  if (/^tel:/i.test(trimmed) || GUID_RE.test(trimmed)) return trimmed;
  return `tel:${trimmed}`;
}

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
  /** Unwrapped via extractLiveCallTargetId - a raw GUID or 'tel:' number, directly comparable to resolveActionTarget's own output. */
  overflowActionTarget?: string;
  timeoutAction?: string;
  timeoutThreshold?: number;
  timeoutActionTarget?: string;
  /** No live NoAgentThreshold exists - "no agents" fires purely on zero agents opted in, not a numeric threshold. */
  noAgentAction?: string;
  noAgentActionTarget?: string;
  noAgentApplyTo?: string;
  languageId?: string;
  /**
   * From the live tenant_objects call_queue record's ApplicationInstances -
   * confirmed live across several real tenants this session (populates with
   * real GUIDs when a resource account is directly linked, `[]` when none
   * is - same field AutoAttendantLiveState already uses reliably), despite
   * an earlier comment here claiming Get-CsCallQueue's output "doesn't
   * reliably expose" this. That was wrong; the diffing below relies on it.
   */
  applicationInstanceIds?: string[];
}

/**
 * Get-CsCallQueue's Overflow/Timeout/NoAgentActionTarget each serialize as
 * an object ({ Id: string, ... }), not a plain string - same shape
 * populateStructuredFromLive's own targetOf closure
 * (apps/api/.../build.service.ts) already unwraps for the Populate path.
 * resolveLiveCallQueueState (duplicated in api and worker) needs the same
 * unwrap so planCallQueueRow's live-diff can compare it directly against
 * resolveActionTarget's own GUID/'tel:' output.
 */
export function extractLiveCallTargetId(raw: unknown): string | undefined {
  const o = raw as Record<string, unknown> | null;
  return o && typeof o.Id === 'string' ? o.Id : undefined;
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
 * Every UPN a Call Queue's Forward action targets (Overflow/Timeout/
 * NoAgent) across a batch of rows - the Design & Build editor's target
 * field is a freeform UpnAutocomplete (it also accepts a raw phone number
 * or an existing GUID), so a person target is stored as their plain UPN.
 * planCallQueueRow/callQueueRowWarnings need each one resolved to its live
 * Entra Object ID first (Set-CsCallQueue's …ActionTarget takes a GUID or a
 * 'tel:' number, never a bare UPN), so the caller collects them up front
 * the same way it already does for agent UPNs and
 * collectAutoAttendantUserUpns does for Auto Attendant 'user'-kind targets,
 * before calling resolveLiveIdentityState. Only 'Forward' is collected -
 * SharedVoicemail's target is an M365 group GUID, a different identity
 * space entirely, and the other actions don't use target at all.
 */
export function collectCallQueueTargetUpns(
  rows: Pick<BuildCallQueueRow, 'overflow' | 'timeout' | 'no_agent_action'>[],
): string[] {
  const out: string[] = [];
  for (const row of rows) {
    if (row.overflow?.action === 'Forward' && row.overflow.target) out.push(row.overflow.target);
    if (row.timeout?.action === 'Forward' && row.timeout.target) out.push(row.timeout.target);
    if (row.no_agent_action?.action === 'Forward' && row.no_agent_action.target) out.push(row.no_agent_action.target);
  }
  return out;
}

/**
 * Flags agent UPNs / linked resource accounts that don't resolve to a live
 * Entra object id - planCallQueueRow silently skips these (a typo'd UPN or a
 * resource account not yet licensed shouldn't block the rest of the queue's
 * config from deploying), so this is the only place that gap is visible.
 * Also flags a SharedVoicemail action with no language_id - planCallQueueRow
 * (see needsLanguage below) silently omits the LanguageId cmdlet parameter
 * in that case rather than guessing one, which Teams then rejects at deploy
 * time; surfacing it here means the gap is visible in the preview instead of
 * as a failed cmdlet.
 */
export function callQueueRowWarnings(
  row: Pick<BuildCallQueueRow, 'agents' | 'resource_accounts' | 'overflow' | 'timeout' | 'no_agent_action' | 'language_id'>,
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
  const needsLanguage =
    row.overflow?.action === 'SharedVoicemail' ||
    row.timeout?.action === 'SharedVoicemail' ||
    row.no_agent_action?.action === 'SharedVoicemail';
  if (needsLanguage && !row.language_id) {
    warnings.push('A SharedVoicemail action is configured but no language is set, so this queue will fail to deploy until one is chosen.');
  }
  // A Forward target that isn't a raw number/GUID must resolve as a live
  // UPN (see collectCallQueueTargetUpns/planCallQueueRow) - otherwise it's
  // about to get 'tel:'-prefixed and rejected by Set-CsCallQueue.
  const checkForwardTarget = (settings: CallQueueActionSettings | null | undefined, where: string) => {
    const target = settings?.target?.trim();
    if (settings?.action !== 'Forward' || !target) return;
    if (/^tel:/i.test(target) || GUID_RE.test(target)) return;
    if (!agentObjectIds.has(target.toLowerCase())) {
      warnings.push(`${where} forwards to "${target}", which doesn't resolve to a live Entra identity yet, so it won't deploy correctly.`);
    }
  };
  checkForwardTarget(row.overflow, 'Overflow');
  checkForwardTarget(row.timeout, 'Timeout');
  checkForwardTarget(row.no_agent_action, 'No-agent');
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

  // A Forward target picked via the Design & Build editor's freeform
  // UpnAutocomplete field is stored as the person's plain UPN, not their
  // Entra Object ID - resolve it the same way -Users does before falling
  // back to normalizePstnTarget, which only knows how to pass a raw GUID/
  // number through unchanged and would otherwise 'tel:'-prefix a UPN,
  // producing a target Set-CsCallQueue rejects (confirmed bug).
  const resolveActionTarget = (settings: CallQueueActionSettings | null | undefined): string | undefined => {
    const target = settings?.target?.trim();
    if (!target) return undefined;
    if (settings?.action === 'Forward') {
      const resolved = agentObjectIds.get(target.toLowerCase());
      if (resolved) return resolved;
    }
    return normalizePstnTarget(target);
  };
  const overflowTarget = resolveActionTarget(row.overflow);
  const timeoutTarget = resolveActionTarget(row.timeout);
  const noAgentTarget = resolveActionTarget(row.no_agent_action);

  const parameters: Record<string, unknown> = {
    Name: row.name,
    RoutingMethod: row.routing_method,
    AgentAlertTime: row.agent_alert_time,
    PresenceBasedRouting: row.presence_based_routing,
    Users: users,
    ...(needsLanguage && row.language_id ? { LanguageId: row.language_id } : {}),
    ...(row.overflow?.action ? { OverflowAction: row.overflow.action } : {}),
    ...(row.overflow?.threshold != null ? { OverflowThreshold: row.overflow.threshold } : {}),
    ...(overflowTarget ? { OverflowActionTarget: overflowTarget } : {}),
    ...(row.timeout?.action ? { TimeoutAction: row.timeout.action } : {}),
    ...(row.timeout?.threshold != null ? { TimeoutThreshold: row.timeout.threshold } : {}),
    ...(timeoutTarget ? { TimeoutActionTarget: timeoutTarget } : {}),
    ...(row.no_agent_action?.action ? { NoAgentAction: row.no_agent_action.action } : {}),
    ...(noAgentTarget ? { NoAgentActionTarget: noAgentTarget } : {}),
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
      (live.overflowActionTarget ?? undefined) !== (overflowTarget ?? undefined) ||
      (live.timeoutAction ?? undefined) !== (row.timeout?.action ?? undefined) ||
      (live.timeoutThreshold ?? undefined) !== (row.timeout?.threshold ?? undefined) ||
      (live.timeoutActionTarget ?? undefined) !== (timeoutTarget ?? undefined) ||
      (live.noAgentAction ?? undefined) !== (row.no_agent_action?.action ?? undefined) ||
      (live.noAgentActionTarget ?? undefined) !== (noAgentTarget ?? undefined) ||
      (live.noAgentApplyTo ?? undefined) !== (row.no_agent_apply_to ?? undefined) ||
      (needsLanguage && (live.languageId ?? undefined) !== (row.language_id ?? undefined)) ||
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
  // pattern above). Diffed against live.applicationInstanceIds - same
  // pattern as planAutoAttendantRow's equivalent step - so it only emits
  // instance ids not already associated live, instead of re-emitting every
  // pass regardless.
  const linkedInstanceIds = row.resource_accounts.map((id) => raObjectIds.get(id)).filter((id): id is string => !!id);
  const alreadyAssociated = new Set((live?.applicationInstanceIds ?? []).map((id) => id.toLowerCase()));
  const unassociatedInstanceIds = linkedInstanceIds.filter((id) => !alreadyAssociated.has(id.toLowerCase()));
  if (live?.identity && unassociatedInstanceIds.length > 0) {
    calls.push({
      cmdlet: 'New-CsOnlineApplicationInstanceAssociation',
      parameters: { Identities: unassociatedInstanceIds, ConfigurationId: live.identity, ConfigurationType: 'CallQueue' },
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
  /** -Prompts - the menu's own spoken prompt (e.g. "For Sales press 1, for Support press 2"), distinct from the CallFlow's Greetings (the initial "Thank you for calling..."). Confirmed against Microsoft Learn's own New-CsAutoAttendantMenu examples. */
  prompts?: AutoAttendantPrompt[];
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

export interface BuildAutoAttendantRow {
  id: string;
  name: string;
  language_id: string | null;
  time_zone_id: string | null;
  voice_id: string | null;
  voice_response_enabled: boolean;
  operator: AutoAttendantCallableEntity | null;
  default_call_flow: AutoAttendantCallFlow | null;
  after_hours_call_flow: AutoAttendantCallFlow | null;
  holiday_call_flows: AutoAttendantHolidayCallFlow[];
  schedule: AutoAttendantSchedule | null;
  /** build_resource_accounts.id array - resolved to Application Instance GUIDs via raObjectIds, same as BuildCallQueueRow's own field. */
  resource_accounts: string[];
}

/**
 * What Discovery's live-tenant snapshot (tenant_objects, object_type
 * 'auto_attendant') knows about an AA, matched by Name - same rationale as
 * CallQueueLiveState. `identity` is needed both to target Set-CsAutoAttendant
 * and to resolve this AA as a menu-option target from another AA (see
 * AutoAttendantCrossRef). `structured`, when the caller resolved it (the
 * deployment preview/execute path does; AutoAttendantCrossRef's own
 * identity-only resolution pass doesn't need to), is the same live object
 * converted to build_auto_attendants' own shape via
 * aa-live-parse.ts's liveAutoAttendantToStructured - what planAutoAttendantRow
 * diffs the saved row against to decide whether anything actually changed.
 */
export interface AutoAttendantLiveState {
  identity: string;
  languageId?: string;
  timeZoneId?: string;
  voiceId?: string;
  enableVoiceResponse?: boolean;
  structured?: LiveAutoAttendantStructured;
  /** Get-CsAutoAttendant's own ApplicationInstances array (the resource accounts already associated with it) - lets the resource-account association step diff instead of always re-sending. */
  applicationInstanceIds?: string[];
}

/**
 * Live Identity GUIDs for every same-site Auto Attendant/Call Queue, keyed
 * `${kind}:${buildId}` - resolves a menu option or -Operator that targets
 * another AA/CQ on the same site (AutoAttendantCallableEntity.buildId) to
 * the live GUID New-CsAutoAttendantCallableEntity -Type ApplicationEndpoint
 * -Identity needs. Built by the caller (mirrors raObjectIds/agentObjectIds
 * in planCallQueueRow) from every build_auto_attendants/build_call_queues
 * row on the site, not just the one(s) being planned - a target can point at
 * a sibling row outside the current plan/preview scope.
 */
export type AutoAttendantCrossRef = Map<string, string>;

function crossRefKey(kind: 'auto_attendant' | 'call_queue', buildId: string): string {
  return `${kind}:${buildId}`;
}

/**
 * Flags anything planAutoAttendantRow silently drops rather than guesses -
 * an unresolved menu-option/operator target, no default call flow at all
 * (nothing to deploy without one, so the row plans no calls), or a linked
 * resource account with no live Application Instance yet - same check,
 * same wording, as callQueueRowWarnings' own unresolved-RA warning (an AA
 * can have several resource accounts or none, exactly like a Call Queue).
 */
function collectUserUpnsFromCallFlow(cf: AutoAttendantCallFlow | null | undefined, out: string[]) {
  for (const opt of cf?.menu.options ?? []) {
    if (opt.action === 'TransferCallToTarget' && opt.target?.kind === 'user' && opt.target.upn) out.push(opt.target.upn);
  }
}
/**
 * Every UPN a 'user'-kind callable entity (an AA's -Operator, or a menu
 * option's TransferCallToTarget) references across a batch of rows -
 * planAutoAttendantRow/autoAttendantRowWarnings need each one resolved to
 * its live Entra Object ID first (see buildCallableEntity's 'user' case),
 * so the caller collects them up front the same way it already does for
 * Call Queue agent UPNs before calling resolveLiveIdentityState.
 */
export function collectAutoAttendantUserUpns(
  rows: Pick<BuildAutoAttendantRow, 'operator' | 'default_call_flow' | 'after_hours_call_flow' | 'holiday_call_flows'>[],
): string[] {
  const out: string[] = [];
  for (const row of rows) {
    if (row.operator?.kind === 'user' && row.operator.upn) out.push(row.operator.upn);
    collectUserUpnsFromCallFlow(row.default_call_flow, out);
    collectUserUpnsFromCallFlow(row.after_hours_call_flow, out);
    for (const h of row.holiday_call_flows) collectUserUpnsFromCallFlow(h.callFlow, out);
  }
  return out;
}

/** One AA/CQ transfer target - see collectAutoAttendantVoiceAppRefs. */
export interface AutoAttendantVoiceAppRef {
  kind: 'auto_attendant' | 'call_queue';
  buildId: string;
}

function collectVoiceAppRefsFromCallFlow(cf: AutoAttendantCallFlow | null | undefined, out: AutoAttendantVoiceAppRef[]) {
  for (const opt of cf?.menu.options ?? []) {
    const target = opt.target;
    if (opt.action === 'TransferCallToTarget' && target && (target.kind === 'auto_attendant' || target.kind === 'call_queue') && target.buildId) {
      out.push({ kind: target.kind, buildId: target.buildId });
    }
  }
}

/**
 * Every same-site Auto Attendant/Call Queue a row's -Operator or menu
 * options transfer to (AutoAttendantCallableEntity.buildId) - used by
 * orderAutoAttendantRowsByDependency to sequence a deployment run so a
 * target deploys before the row that references it, the same way
 * collectAutoAttendantUserUpns collects 'user'-kind targets for identity
 * resolution.
 */
export function collectAutoAttendantVoiceAppRefs(
  row: Pick<BuildAutoAttendantRow, 'operator' | 'default_call_flow' | 'after_hours_call_flow' | 'holiday_call_flows'>,
): AutoAttendantVoiceAppRef[] {
  const out: AutoAttendantVoiceAppRef[] = [];
  if (row.operator && (row.operator.kind === 'auto_attendant' || row.operator.kind === 'call_queue') && row.operator.buildId) {
    out.push({ kind: row.operator.kind, buildId: row.operator.buildId });
  }
  collectVoiceAppRefsFromCallFlow(row.default_call_flow, out);
  collectVoiceAppRefsFromCallFlow(row.after_hours_call_flow, out);
  for (const h of row.holiday_call_flows) collectVoiceAppRefsFromCallFlow(h.callFlow, out);
  return out;
}

/**
 * Orders a batch of Auto Attendant rows being deployed together so a row
 * that transfers to another Auto Attendant IN THE SAME BATCH deploys after
 * its target - otherwise the target's live Identity may not exist yet when
 * this row is planned, and the transfer silently stays unresolved for the
 * rest of the run (flagged by autoAttendantRowWarnings, not fixed until a
 * later Discovery sync + a second deployment run). A Call Queue target isn't
 * ordered here - planCallQueueRow never references another build row, so
 * call_queues has nothing to topologically sort; the worker's block-level
 * order (call_queues before auto_attendants) already covers CQ-before-AA.
 * Stable for any row with no same-batch AA dependency (keeps the original
 * order); a same-batch cycle (A targets B, B targets A) can't be fully
 * ordered either way and is left as encountered, same as before this sort
 * existed.
 */
export function orderAutoAttendantRowsByDependency(rows: BuildAutoAttendantRow[]): BuildAutoAttendantRow[] {
  const dependsOn = new Map<string, Set<string>>();
  const idSet = new Set(rows.map((r) => r.id));
  for (const row of rows) {
    const deps = new Set<string>();
    for (const ref of collectAutoAttendantVoiceAppRefs(row)) {
      if (ref.kind === 'auto_attendant' && ref.buildId !== row.id && idSet.has(ref.buildId)) deps.add(ref.buildId);
    }
    dependsOn.set(row.id, deps);
  }
  const idToRow = new Map(rows.map((r) => [r.id, r]));
  const visited = new Set<string>();
  const visiting = new Set<string>();
  const ordered: BuildAutoAttendantRow[] = [];
  const visit = (id: string) => {
    if (visited.has(id) || visiting.has(id)) return; // already placed, or a cycle - leave the rest to unwind as-is
    visiting.add(id);
    for (const dep of dependsOn.get(id) ?? []) visit(dep);
    visiting.delete(id);
    visited.add(id);
    const row = idToRow.get(id);
    if (row) ordered.push(row);
  };
  for (const row of rows) visit(row.id);
  return ordered;
}

/**
 * Given the Call Queue/Auto Attendant rows selected for a deployment run and
 * this site's build_users rows, returns the build_users row ids that must
 * also be included so a referenced agent/-Operator/menu-option target's own
 * Enterprise Voice/number/policy config deploys before the queue/attendant
 * that relies on it, instead of the operator having to notice and select it
 * separately. Matching is by UPN, case-insensitive.
 */
export function collectDependencyUserRowIds(
  selectedCallQueues: Pick<BuildCallQueueRow, 'agents'>[],
  selectedAutoAttendants: Pick<BuildAutoAttendantRow, 'operator' | 'default_call_flow' | 'after_hours_call_flow' | 'holiday_call_flows'>[],
  siteUsers: { id: string; upn: string }[],
): string[] {
  const upns = new Set<string>();
  for (const cq of selectedCallQueues) for (const upn of cq.agents ?? []) upns.add(upn.toLowerCase());
  for (const upn of collectAutoAttendantUserUpns(selectedAutoAttendants)) upns.add(upn.toLowerCase());
  if (upns.size === 0) return [];
  return siteUsers.filter((u) => upns.has(u.upn.toLowerCase())).map((u) => u.id);
}

export function autoAttendantRowWarnings(
  row: BuildAutoAttendantRow,
  crossRef: AutoAttendantCrossRef,
  raObjectIds: Map<string, string>,
  userObjectIds: Map<string, string>,
): string[] {
  const warnings: string[] = [];
  const unresolvedRas = row.resource_accounts.filter((id) => !raObjectIds.has(id));
  if (unresolvedRas.length) {
    warnings.push(
      `${unresolvedRas.length} linked resource account(s) have no live Application Instance yet (New-CsOnlineApplicationInstance not run), so this Auto Attendant won't get a phone number until that's done.`,
    );
  }
  if (!row.default_call_flow) {
    warnings.push('No business-hours call flow configured yet, so nothing will deploy for this Auto Attendant.');
    return warnings;
  }
  if (!row.language_id || !row.time_zone_id) {
    warnings.push('Language and time zone must both be set before this Auto Attendant can be created - New-CsAutoAttendant requires both, and this row deploys nothing until they are.');
  }
  const unresolved: string[] = [];
  const check = (entity: AutoAttendantCallableEntity | undefined, where: string) => {
    if (!entity) return;
    if ((entity.kind === 'auto_attendant' || entity.kind === 'call_queue') && (!entity.buildId || !crossRef.has(crossRefKey(entity.kind, entity.buildId)))) {
      unresolved.push(`${where} targets an Auto Attendant/Call Queue that doesn't resolve live yet`);
    }
    if (entity.kind === 'user') {
      if (!entity.upn) unresolved.push(`${where} has no UPN set for its user target`);
      else if (!userObjectIds.has(entity.upn.toLowerCase())) unresolved.push(`${where} targets a user (${entity.upn}) that doesn't resolve to a live Entra identity yet`);
    }
    // buildCallableEntity always returns undefined for these two kinds (see
    // its own comments) - Microsoft's cmdlet has no plain Voicemail -Type at
    // all, and SharedVoicemail has no data field to supply its M365 group
    // identity yet. Both silently fall back to DisconnectCall with no
    // warning until now - confirmed live this session.
    if (entity.kind === 'voicemail') {
      unresolved.push(`${where} targets plain Voicemail, which has no deployable cmdlet form - it will disconnect the call instead of deploying`);
    }
    if (entity.kind === 'shared_voicemail') {
      unresolved.push(`${where} targets Shared Voicemail, but its M365 group identity can't be supplied yet - it will disconnect the call instead of deploying`);
    }
  };
  check(row.operator ?? undefined, 'Operator');
  const checkFlow = (cf: AutoAttendantCallFlow | null | undefined, label: string) => {
    for (const opt of cf?.menu.options ?? []) {
      if (opt.action === 'TransferCallToTarget') check(opt.target, `${label} DTMF ${opt.dtmf}`);
    }
  };
  checkFlow(row.default_call_flow, 'Business hours');
  checkFlow(row.after_hours_call_flow, 'After hours');
  for (const h of row.holiday_call_flows) checkFlow(h.callFlow, h.name);
  if (unresolved.length) warnings.push(...unresolved);
  return warnings;
}

/** Accumulates one AA row's preamble steps plus its own per-prefix variable-name counters - passed through every builder below instead of module state, so nothing leaks across calls. */
interface AaBuildCtx {
  steps: PreambleStep[];
  counters: Record<string, number>;
}
function nextAaVar(ctx: AaBuildCtx, prefix: string): string {
  ctx.counters[prefix] = (ctx.counters[prefix] ?? 0) + 1;
  return `${prefix}${ctx.counters[prefix]}`;
}

/**
 * New-CsAutoAttendantCallableEntity - a menu option's transfer target or the
 * AA's -Operator. Returns undefined (skip, don't guess) when the target
 * can't resolve to a live identity - an unresolved same-site AA/CQ, or a
 * user target with no UPN. 'external'/'voicemail'/'shared_voicemail' always
 * resolve (a raw number needs no live lookup; Voicemail/SharedVoicemail
 * don't take an -Identity at all).
 */
function buildCallableEntity(ctx: AaBuildCtx, entity: AutoAttendantCallableEntity, crossRef: AutoAttendantCrossRef, userObjectIds: Map<string, string>): VarRef | undefined {
  let type: string;
  let identity: string | undefined;
  switch (entity.kind) {
    case 'auto_attendant':
    case 'call_queue':
      // Microsoft Learn's own -Type parameter doc is explicit: ApplicationEndpoint
      // is "when transferring to a Resource Account", ConfigurationEndpoint is
      // "when transferring directly to a nested Auto Attendant or Call Queue" -
      // this is the nested-AA/CQ case, not the resource-account one (that's the
      // separate New-CsOnlineApplicationInstanceAssociation step below).
      type = 'ConfigurationEndpoint';
      identity = entity.buildId ? crossRef.get(crossRefKey(entity.kind, entity.buildId)) : undefined;
      if (!identity) return undefined;
      break;
    case 'user':
      // New-CsAutoAttendantCallableEntity -Type User needs the Enterprise-
      // Voice-enabled user's Entra Object ID (every Microsoft Learn example
      // resolves via Get-CsOnlineUser), not the raw UPN - mirrors how
      // planCallQueueRow already resolves agent UPNs via agentObjectIds.
      type = 'User';
      identity = entity.upn ? userObjectIds.get(entity.upn.toLowerCase()) : undefined;
      if (!identity) return undefined;
      break;
    case 'external':
      // New-CsAutoAttendantCallableEntity's -Identity for ExternalPstn is a
      // TEL URI (Microsoft Learn's own example: 'tel:+1234567890') - the
      // Design & Build editor only hints at the 'tel:' prefix via a
      // placeholder, it doesn't enforce it, so normalize here too.
      type = 'ExternalPstn';
      identity = entity.number ? normalizePstnTarget(entity.number) : undefined;
      if (!identity) return undefined;
      break;
    case 'voicemail':
      // Microsoft's cmdlet has no plain "Voicemail" -Type at all (Microsoft
      // Learn's -Type enum is only User | ApplicationEndpoint |
      // ConfigurationEndpoint | ExternalPstn | SharedVoicemail) and
      // -Identity is mandatory for every type it does support - there is no
      // way to render this kind correctly today. Skip it, same as any other
      // unresolved target (buildMenuOption falls back to DisconnectCall),
      // instead of sending an invalid enum value.
      return undefined;
    case 'shared_voicemail':
      // SharedVoicemail's -Identity must be an M365 group GUID (Find-CsGroup
      // per Microsoft Learn's own example) - AutoAttendantCallableEntity has
      // no field to supply one today, so this can't be rendered correctly
      // either. Same fallback until that field exists.
      return undefined;
  }
  const varName = nextAaVar(ctx, 'ce');
  ctx.steps.push({ assignTo: varName, cmdlet: 'New-CsAutoAttendantCallableEntity', parameters: { Type: type, ...(identity ? { Identity: identity } : {}) } });
  return { $var: varName };
}

/** New-CsAutoAttendantMenuOption. Drops the -CallTarget (falls back to a bare disconnect-shaped option) rather than guess when a TransferCallToTarget's target didn't resolve - see autoAttendantRowWarnings, which is what actually surfaces that gap. */
function buildMenuOption(ctx: AaBuildCtx, opt: AutoAttendantMenuOption, crossRef: AutoAttendantCrossRef, userObjectIds: Map<string, string>): VarRef {
  const callTarget = opt.action === 'TransferCallToTarget' && opt.target ? buildCallableEntity(ctx, opt.target, crossRef, userObjectIds) : undefined;
  const varName = nextAaVar(ctx, 'opt');
  ctx.steps.push({
    assignTo: varName,
    cmdlet: 'New-CsAutoAttendantMenuOption',
    parameters: { Action: callTarget ? opt.action : 'DisconnectCall', DtmfResponse: opt.dtmf, ...(callTarget ? { CallTarget: callTarget } : {}) },
  });
  return { $var: varName };
}

/**
 * New-CsAutoAttendantMenu itself rejects an empty menu ("must have either
 * menu options, dial-by-name or dial-by-extension") - confirmed live: this
 * is the real shape of a "just play the greeting" after-hours flow (no
 * caller interaction at all, e.g. "we're closed, please leave a
 * voicemail"). Microsoft's own documented way to model that is a single
 * option with DtmfResponse Automatic ("executed without user response"),
 * so the caller never sees a menu at all - synthesize one rather than
 * reject a row that has always been a legitimate, common AA shape. Shared
 * between buildMenu (what actually gets sent) and sortedMenuOptions (what a
 * saved row is compared against once live) so they never disagree - a
 * deployed row whose comparison didn't know about this synthesized option
 * saw a permanent, unfixable mismatch against its own live state, even
 * though nothing had actually changed - confirmed live right after this
 * exact fix first shipped.
 */
const SYNTHESIZED_DISCONNECT_OPTION: AutoAttendantMenuOption = { dtmf: 'Automatic', action: 'DisconnectCall' };
function effectiveMenuOptions(menu: AutoAttendantMenu): AutoAttendantMenuOption[] {
  return menu.options.length || menu.enableDialByName || menu.directorySearchMethod ? menu.options : [SYNTHESIZED_DISCONNECT_OPTION];
}

/** New-CsAutoAttendantPrompt. Only a text-to-speech prompt is deployable today - an AudioFile prompt needs Import-CsOnlineAudioFile run first (not modeled), so it's silently skipped rather than emitted broken. */
function buildPrompt(ctx: AaBuildCtx, p: AutoAttendantPrompt): VarRef | undefined {
  if (p.type !== 'Text' || !p.text) return undefined;
  const varName = nextAaVar(ctx, 'prompt');
  ctx.steps.push({ assignTo: varName, cmdlet: 'New-CsAutoAttendantPrompt', parameters: { TextToSpeechPrompt: p.text } });
  return { $var: varName };
}

/**
 * New-CsAutoAttendantMenu. `-Name` is mandatory (Microsoft Learn) - omitting
 * it doesn't error, it makes the cmdlet fall back to PowerShell's own
 * "Supply values for the following parameters: Name:" interactive prompt,
 * which then blocks forever since nothing is listening on stdin to answer
 * it. Confirmed live in production: this exact prompt, caught in a raw pwsh
 * session log, was the real cause behind three consecutive 15-minute
 * "hangs" that looked network- or module-related but had nothing to do with
 * either.
 */
function buildMenu(ctx: AaBuildCtx, menu: AutoAttendantMenu, name: string, crossRef: AutoAttendantCrossRef, userObjectIds: Map<string, string>): VarRef {
  const optionRefs = effectiveMenuOptions(menu).map((o) => buildMenuOption(ctx, o, crossRef, userObjectIds));
  const promptRefs = (menu.prompts ?? []).map((p) => buildPrompt(ctx, p)).filter((v): v is VarRef => !!v);
  const varName = nextAaVar(ctx, 'menu');
  ctx.steps.push({
    assignTo: varName,
    cmdlet: 'New-CsAutoAttendantMenu',
    parameters: {
      Name: `${name} Menu`,
      MenuOptions: optionRefs,
      ...(promptRefs.length ? { Prompts: promptRefs } : {}),
      ...(menu.enableDialByName ? { EnableDialByName: true } : {}),
      ...(menu.directorySearchMethod ? { DirectorySearchMethod: menu.directorySearchMethod } : {}),
    },
  });
  return { $var: varName };
}

/** New-CsAutoAttendantCallFlow. */
function buildCallFlow(ctx: AaBuildCtx, cf: AutoAttendantCallFlow, name: string, crossRef: AutoAttendantCrossRef, userObjectIds: Map<string, string>): VarRef {
  const greetingRefs = cf.greetings.map((g) => buildPrompt(ctx, g)).filter((v): v is VarRef => !!v);
  const menuRef = buildMenu(ctx, cf.menu, name, crossRef, userObjectIds);
  const varName = nextAaVar(ctx, 'flow');
  ctx.steps.push({
    assignTo: varName,
    cmdlet: 'New-CsAutoAttendantCallFlow',
    parameters: { Name: name, ...(greetingRefs.length ? { Greetings: greetingRefs } : {}), Menu: menuRef },
  });
  return { $var: varName };
}

const WEEKLY_SCHEDULE_PARAMS = [
  ['monday', 'MondayHours'],
  ['tuesday', 'TuesdayHours'],
  ['wednesday', 'WednesdayHours'],
  ['thursday', 'ThursdayHours'],
  ['friday', 'FridayHours'],
  ['saturday', 'SaturdayHours'],
  ['sunday', 'SundayHours'],
] as const;

/** New-CsOnlineSchedule - -WeeklyRecurrentSchedule with per-day New-CsOnlineTimeRange objects, or -FixedSchedule with New-CsOnlineDateTimeRange objects (a distinct cmdlet from TimeRange - real dates, not times of day). */
function buildSchedule(ctx: AaBuildCtx, sched: AutoAttendantSchedule, name: string): VarRef {
  const varName = nextAaVar(ctx, 'sched');
  if (sched.type === 'fixed' && sched.fixed) {
    const rangeRefs = sched.fixed.ranges.map((r) => {
      const rv = nextAaVar(ctx, 'dtr');
      ctx.steps.push({ assignTo: rv, cmdlet: 'New-CsOnlineDateTimeRange', parameters: { Start: r.start, End: r.end } });
      return { $var: rv };
    });
    ctx.steps.push({ assignTo: varName, cmdlet: 'New-CsOnlineSchedule', parameters: { Name: name, FixedSchedule: true, DateTimeRanges: rangeRefs } });
  } else {
    const params: Record<string, unknown> = { Name: name, WeeklyRecurrentSchedule: true };
    for (const [day, param] of WEEKLY_SCHEDULE_PARAMS) {
      const ranges = sched.weekly?.[day] ?? [];
      if (ranges.length) {
        params[param] = ranges.map((r) => {
          const rv = nextAaVar(ctx, 'tr');
          ctx.steps.push({ assignTo: rv, cmdlet: 'New-CsOnlineTimeRange', parameters: { Start: r.start, End: r.end } });
          return { $var: rv };
        });
      }
    }
    if (sched.weekly?.complement) params.Complement = true;
    ctx.steps.push({ assignTo: varName, cmdlet: 'New-CsOnlineSchedule', parameters: params });
  }
  return { $var: varName };
}

/** New-CsAutoAttendantCallHandlingAssociation - -ScheduleId/-CallFlowId are the *string* Id a locally-constructed schedule/call-flow object generates, not the object itself (see VarRef's `prop`). */
function buildCallHandlingAssociation(ctx: AaBuildCtx, type: 'AfterHours' | 'Holiday', scheduleRef: VarRef, callFlowRef: VarRef): VarRef {
  const varName = nextAaVar(ctx, 'cha');
  ctx.steps.push({
    assignTo: varName,
    cmdlet: 'New-CsAutoAttendantCallHandlingAssociation',
    parameters: { Type: type, ScheduleId: { ...scheduleRef, prop: 'Id' }, CallFlowId: { ...callFlowRef, prop: 'Id' } },
  });
  return { $var: varName };
}

/** Deep-equal with object keys sorted and `undefined` values dropped, so key order and an omitted-vs-undefined field never register as a difference. */
function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      const v = (value as Record<string, unknown>)[key];
      if (v !== undefined) out[key] = canonicalize(v);
    }
    return out;
  }
  return value;
}
function structurallyEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(canonicalize(a)) === JSON.stringify(canonicalize(b));
}

/** Menu options compared by DTMF key rather than array position - a harmless reordering shouldn't read as a change. */
function sortedMenuOptions(cf: AutoAttendantCallFlow | null): AutoAttendantMenuOption[] {
  return cf ? [...effectiveMenuOptions(cf.menu)].sort((a, b) => a.dtmf.localeCompare(b.dtmf)) : [];
}
function callFlowEqual(a: AutoAttendantCallFlow | null, b: AutoAttendantCallFlow | null): boolean {
  if (!a && !b) return true;
  if (!a || !b) return false;
  if (!structurallyEqual(a.greetings, b.greetings)) return false;
  if (!structurallyEqual(a.menu.prompts ?? [], b.menu.prompts ?? [])) return false;
  if (!!a.menu.enableDialByName !== !!b.menu.enableDialByName) return false;
  if ((a.menu.directorySearchMethod ?? undefined) !== (b.menu.directorySearchMethod ?? undefined)) return false;
  return structurallyEqual(sortedMenuOptions(a), sortedMenuOptions(b));
}
/** Holidays compared by name rather than array position, for the same reason. */
function sortedHolidays(list: AutoAttendantHolidayCallFlow[]): AutoAttendantHolidayCallFlow[] {
  return [...list].sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * True when a saved row already matches what's live, field for field -
 * decides whether planAutoAttendantRow needs to send Set-CsAutoAttendant at
 * all. Compares against `live.structured` (aa-live-parse.ts's
 * liveAutoAttendantToStructured, run fresh by the caller against the same
 * live object) rather than the raw columns directly, because after-hours
 * only actually deploys when both the call flow AND its schedule are set
 * (see planAutoAttendantRow's own preamble-building below) - a half-filled
 * after-hours config that wouldn't be sent live yet must not register as a
 * "change" just because the column itself is non-null.
 */
function autoAttendantMatchesLive(row: BuildAutoAttendantRow, live: AutoAttendantLiveState): boolean {
  const s = live.structured;
  if (!s) return false;
  if ((row.language_id ?? undefined) !== (s.languageId ?? undefined)) return false;
  if ((row.time_zone_id ?? undefined) !== (s.timeZoneId ?? undefined)) return false;
  if ((row.voice_id ?? undefined) !== (s.voiceId ?? undefined)) return false;
  if (!!row.voice_response_enabled !== !!s.enableVoiceResponse) return false;
  if (!structurallyEqual(row.operator ?? null, s.operator ?? null)) return false;
  if (!callFlowEqual(row.default_call_flow, s.defaultCallFlow)) return false;

  const effectiveAfterHours = row.after_hours_call_flow && row.schedule ? row.after_hours_call_flow : null;
  const effectiveAfterHoursSchedule = row.after_hours_call_flow && row.schedule ? row.schedule : null;
  if (!callFlowEqual(effectiveAfterHours, s.afterHoursCallFlow)) return false;
  if (!structurallyEqual(effectiveAfterHoursSchedule, s.schedule)) return false;

  const rowHolidays = sortedHolidays(row.holiday_call_flows);
  const liveHolidays = sortedHolidays(s.holidayCallFlows);
  if (rowHolidays.length !== liveHolidays.length) return false;
  for (let i = 0; i < rowHolidays.length; i++) {
    const a = rowHolidays[i];
    const b = liveHolidays[i];
    if (!a || !b) return false;
    if (a.name !== b.name) return false;
    if (!callFlowEqual(a.callFlow, b.callFlow)) return false;
    if (!structurallyEqual(a.schedule, b.schedule)) return false;
  }
  return true;
}

/**
 * Turn a build_auto_attendants row into its cmdlet chain: the real
 * New-CsAutoAttendant construction chain (CallableEntity -> Prompt ->
 * MenuOption -> Menu -> CallFlow -> TimeRange/DateTimeRange -> Schedule ->
 * CallHandlingAssociation), run as one `preamble` before the single
 * mutating New-CsAutoAttendant/Set-CsAutoAttendant call, then a resource-
 * account association. Plans nothing when there's no default_call_flow yet -
 * see autoAttendantRowWarnings, which is what surfaces that (and any
 * unresolved target) to the preview.
 *
 * A live AA is only re-Set when autoAttendantMatchesLive finds an actual
 * difference - the preamble/parameters are only built at all in that case,
 * so a row that already matches the tenant plans nothing and disappears
 * from the preview, the same as every other object type. The resource-
 * account association is similarly only re-sent when `live`'s own
 * ApplicationInstances array (Get-CsAutoAttendant reliably exposes this,
 * confirmed against OVP012's real data - see the "front door" badge in the
 * call-flow diagram, which relies on the same field) doesn't already list
 * the target.
 */
export function planAutoAttendantRow(
  row: BuildAutoAttendantRow,
  crossRef: AutoAttendantCrossRef,
  raObjectIds: Map<string, string>,
  userObjectIds: Map<string, string>,
  live?: AutoAttendantLiveState,
): CmdletInvocation[] {
  const calls: CmdletInvocation[] = [];
  if (!row.default_call_flow) return calls;
  // New-CsAutoAttendant requires -LanguageId/-TimeZoneId (Microsoft Learn:
  // both Mandatory: True). Unlike the update path below (Set-CsAutoAttendant
  // via an existing $aa object), there's no live object to inherit a value
  // from when creating brand new, so a row missing either can't be created
  // at all - skip rather than send an incomplete mandatory-param call that
  // hangs on PowerShell's own interactive prompt (the same failure mode as
  // the already-fixed New-CsAutoAttendantMenu -Name bug). Surfaced to the
  // user ahead of time via autoAttendantRowWarnings.
  if (!live && (!row.language_id || !row.time_zone_id)) return calls;

  if (!live || !autoAttendantMatchesLive(row, live)) {
    const ctx: AaBuildCtx = { steps: [], counters: {} };

    const defaultFlowRef = buildCallFlow(ctx, row.default_call_flow, `${row.name} - Business hours`, crossRef, userObjectIds);
    const otherFlowRefs: VarRef[] = [];
    const chaRefs: VarRef[] = [];

    if (row.after_hours_call_flow && row.schedule) {
      const afRef = buildCallFlow(ctx, row.after_hours_call_flow, `${row.name} - After hours`, crossRef, userObjectIds);
      const schedRef = buildSchedule(ctx, row.schedule, `${row.name} - After hours schedule`);
      otherFlowRefs.push(afRef);
      chaRefs.push(buildCallHandlingAssociation(ctx, 'AfterHours', schedRef, afRef));
    }
    for (const holiday of row.holiday_call_flows) {
      const hfRef = buildCallFlow(ctx, holiday.callFlow, `${row.name} - ${holiday.name}`, crossRef, userObjectIds);
      const schedRef = buildSchedule(ctx, holiday.schedule, holiday.name);
      otherFlowRefs.push(hfRef);
      chaRefs.push(buildCallHandlingAssociation(ctx, 'Holiday', schedRef, hfRef));
    }

    const operatorRef = row.operator ? buildCallableEntity(ctx, row.operator, crossRef, userObjectIds) : undefined;

    if (!live) {
      // New-CsAutoAttendant takes every property directly as a parameter -
      // confirmed against Microsoft Learn.
      const parameters: Record<string, unknown> = {
        Name: row.name,
        ...(row.language_id ? { LanguageId: row.language_id } : {}),
        ...(row.time_zone_id ? { TimeZoneId: row.time_zone_id } : {}),
        ...(row.voice_id ? { VoiceId: row.voice_id } : {}),
        ...(row.voice_response_enabled ? { EnableVoiceResponse: true } : {}),
        DefaultCallFlow: defaultFlowRef,
        ...(otherFlowRefs.length ? { CallFlows: otherFlowRefs } : {}),
        ...(chaRefs.length ? { CallHandlingAssociations: chaRefs } : {}),
        ...(operatorRef ? { Operator: operatorRef } : {}),
      };
      calls.push({ cmdlet: 'New-CsAutoAttendant', parameters, objectType: 'auto_attendant', objectId: row.id, preamble: ctx.steps });
    } else {
      // Unlike New-CsAutoAttendant, Set-CsAutoAttendant has no -Identity/
      // -Name/-LanguageId/... parameters at all - confirmed against
      // Microsoft Learn, its entire parameter surface is -Instance/-Tenant.
      // The only supported pattern is Get-CsAutoAttendant into a variable,
      // set each property on that object, then Set-CsAutoAttendant -Instance
      // $that - an earlier version of this function passed every parameter
      // directly the same way New-CsAutoAttendant does, which Teams would
      // have rejected outright the first time this ever actually ran live.
      ctx.steps.push({ assignTo: 'aa', cmdlet: 'Get-CsAutoAttendant', parameters: { Identity: live.identity } });
      const assign = (property: string, value: unknown) => ctx.steps.push({ kind: 'assign', target: 'aa', property, value });
      assign('Name', row.name);
      if (row.language_id) assign('LanguageId', row.language_id);
      if (row.time_zone_id) assign('TimeZoneId', row.time_zone_id);
      if (row.voice_id) assign('VoiceId', row.voice_id);
      assign('EnableVoiceResponse', !!row.voice_response_enabled);
      assign('DefaultCallFlow', defaultFlowRef);
      assign('CallFlows', otherFlowRefs);
      assign('CallHandlingAssociations', chaRefs);
      if (operatorRef) assign('Operator', operatorRef);
      calls.push({
        cmdlet: 'Set-CsAutoAttendant',
        parameters: { Instance: { $var: 'aa' } },
        objectType: 'auto_attendant',
        objectId: row.id,
        preamble: ctx.steps,
      });
    }
  }

  // Mirrors planCallQueueRow's own association-diff block exactly - only
  // emits instance ids not already associated live, instead of re-emitting
  // every pass regardless.
  const linkedInstanceIds = row.resource_accounts.map((id) => raObjectIds.get(id)).filter((id): id is string => !!id);
  const alreadyAssociated = new Set((live?.applicationInstanceIds ?? []).map((id) => id.toLowerCase()));
  const unassociatedInstanceIds = linkedInstanceIds.filter((id) => !alreadyAssociated.has(id.toLowerCase()));
  if (live?.identity && unassociatedInstanceIds.length > 0) {
    calls.push({
      cmdlet: 'New-CsOnlineApplicationInstanceAssociation',
      parameters: { Identities: unassociatedInstanceIds, ConfigurationId: live.identity, ConfigurationType: 'AutoAttendant' },
      objectType: 'auto_attendant',
      objectId: row.id,
    });
  }

  return calls;
}
