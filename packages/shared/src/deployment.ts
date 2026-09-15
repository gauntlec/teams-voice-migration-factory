import { POLICY_KIND_TO_TENANT_TYPE, POLICY_KINDS, RESOURCE_ACCOUNT_APPLICATION_IDS } from './domain';

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
}

/** Last 10 significant digits, for loose number matching (same rule Data Collection and Design & Build use). */
function numKey(v: string | null | undefined): string {
  return String(v ?? '').replace(/\D/g, '').slice(-10);
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

/** Render a cmdlet + params as the PowerShell one-liner (What-If output, and the executor). */
export function renderCommand(call: CmdletInvocation): string {
  const parts = [call.cmdlet];
  for (const [k, v] of Object.entries(call.parameters)) {
    if (v === undefined || v === null || v === '') continue;
    if (Array.isArray(v)) {
      if (v.length === 0) continue;
      parts.push(`-${k} @(${v.map((item) => psQuote(String(item))).join(', ')})`);
    } else if (typeof v === 'boolean') parts.push(`-${k} $${v}`);
    else if (typeof v === 'number') parts.push(`-${k} ${v}`);
    else parts.push(`-${k} ${psQuote(String(v))}`);
  }
  return parts.join(' ');
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
  for (const d of row.delegates ?? []) {
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
