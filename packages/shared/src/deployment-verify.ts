import { POLICY_KINDS, POLICY_KIND_TO_TENANT_TYPE } from './domain';
import type { CmdletInvocation, LiveIdentityState } from './deployment';

/* ========================================================================
 * After a live deployment: what was there before each change (for the
 * rollback script) and whether the design actually landed (verification).
 * See docs/DEPLOYMENT.md "Verifying a deployment" and "Rolling back".
 * ======================================================================== */

/** Grant cmdlet -> the tenant_users.policies key (TenantPolicyType) it changes. */
export const GRANT_CMDLET_POLICY: Record<string, { tenantType: string; label: string }> = Object.fromEntries(
  POLICY_KINDS.flatMap((k) => {
    const tenantType = POLICY_KIND_TO_TENANT_TYPE[k.key];
    return tenantType ? [[k.cmdlet, { tenantType, label: k.label }]] : [];
  }),
);

/**
 * What a user/CAP/resource account looked like before one cmdlet changed it,
 * stored in deployment_changes.before. Only the fields that cmdlet changes
 * are set. Taken from Discovery's stored snapshot (tenant_users) at the moment
 * the run planned the row - the same state the plan was diffed against - not
 * a separate live read, so it is as fresh as the last Discovery run or
 * Validate check for that person.
 */
export type IdentityBeforeState = {
  source: 'discovery_snapshot';
  lineUri?: string | null;
  /** CallingPlan / DirectRouting / OperatorConnect for lineUri, from Discovery's phone number inventory; null when unknown */
  phoneNumberType?: string | null;
  enterpriseVoiceEnabled?: boolean;
  /** the per-user assignment for this cmdlet's policy type; null = none (Global) */
  policyName?: string | null;
  voicemailEnabled?: boolean;
  voicemailPromptLanguage?: string | null;
};

/**
 * The before-state to record for one identity cmdlet. Returns `{}` when there
 * is nothing trustworthy to record: no snapshot of this person at all, or a
 * setting Discovery doesn't capture (call forwarding, delegates, voicemail
 * that was never checked). The rollback script lists those as not reversible.
 */
export function identityBeforeState(
  call: Pick<CmdletInvocation, 'cmdlet'>,
  live: LiveIdentityState | undefined,
  liveNumberType?: string | null,
): IdentityBeforeState | Record<string, never> {
  if (!live) return {};
  if (call.cmdlet === 'Set-CsPhoneNumberAssignment' || call.cmdlet === 'Remove-CsPhoneNumberAssignment') {
    return {
      source: 'discovery_snapshot',
      lineUri: live.lineUri,
      phoneNumberType: live.lineUri ? (liveNumberType ?? null) : null,
      enterpriseVoiceEnabled: live.enterpriseVoiceEnabled,
    };
  }
  const grant = GRANT_CMDLET_POLICY[call.cmdlet];
  if (grant) return { source: 'discovery_snapshot', policyName: live.policies[grant.tenantType] ?? null };
  if (call.cmdlet === 'Set-CsOnlineVoicemailUserSettings') {
    if (live.voicemailEnabled === undefined) return {};
    return { source: 'discovery_snapshot', voicemailEnabled: live.voicemailEnabled, voicemailPromptLanguage: live.voicemailPromptLanguage ?? null };
  }
  return {};
}

/** `tel:+15551234567;ext=12` -> `+15551234567` - the form Set-CsPhoneNumberAssignment -PhoneNumber and Discovery's phone number inventory use. */
export function lineUriToNumber(lineUri: string | null | undefined): string | null {
  if (!lineUri) return null;
  const n = (lineUri.replace(/^tel:/i, '').split(';')[0] ?? '').trim();
  return n || null;
}

/* --------------------------- Verification ---------------------------- */

/**
 * Cmdlets planIdentityRow always re-emits because Discovery can't read the
 * live setting back (Get-CsUserCallingSettings isn't captured) - so they can
 * never "match" and are left out of the verdict rather than counted as a
 * difference.
 */
export const UNVERIFIABLE_CMDLETS: ReadonlySet<string> = new Set(['Set-CsUserCallingSettings', 'New-CsUserCallingDelegate']);

export interface DeploymentVerificationRow {
  objectType: 'user' | 'cap' | 'resource_account';
  /** build_users / build_caps / build_resource_accounts id */
  objectId: string;
  upn: string;
  /** one plain-English line per thing that still differs */
  differences: string[];
}

/** Stored on deployments.verification once an execute run's re-check finishes (or couldn't run). */
export type DeploymentVerification =
  | {
      status: 'verified';
      checkedAt: string;
      /** the targeted Discovery run (kind 'targeted') that read the live state */
      discoveryRunId: string;
      /** people/accounts the run touched and that were re-read live */
      checked: number;
      matched: number;
      differing: DeploymentVerificationRow[];
      /** touched but not re-checked (over the per-run cap) */
      notChecked: number;
      /** call forwarding / delegates were changed but can't be read back, so weren't part of the verdict */
      unverifiableSettings: number;
    }
  | {
      /** the re-check is under way - set when it starts */
      status: 'pending';
      startedAt: string;
    }
  | {
      status: 'skipped' | 'failed';
      checkedAt: string;
      /** why there's no verdict - shown as-is */
      reason: string;
    };

const describeNumber = (lineUri: string | null | undefined) => lineUriToNumber(lineUri) ?? 'none';

/**
 * One line describing why a call is still in the plan after the live
 * re-check - i.e. what the design wants vs what Teams has now.
 */
export function describeRemainingCall(call: CmdletInvocation, live: LiveIdentityState | undefined): string {
  const p = call.parameters;
  if (call.cmdlet === 'Remove-CsPhoneNumberAssignment') {
    return `Enterprise Voice should be off - still on${live?.lineUri ? ` with ${describeNumber(live.lineUri)}` : ''}`;
  }
  if (call.cmdlet === 'Set-CsPhoneNumberAssignment') {
    if (p.PhoneNumber) return `Phone number: designed ${String(p.PhoneNumber)}, live ${describeNumber(live?.lineUri)}`;
    return 'Enterprise Voice: designed on, live off';
  }
  const grant = GRANT_CMDLET_POLICY[call.cmdlet];
  if (grant) {
    const designed = typeof p.PolicyName === 'string' ? p.PolicyName : 'Global';
    const liveName = live?.policies[grant.tenantType];
    return `${grant.label}: designed ${designed}, live ${liveName || 'Global'}`;
  }
  if (call.cmdlet === 'Set-CsOnlineVoicemailUserSettings') {
    const designed = p.VoicemailEnabled ? `on${p.PromptLanguage ? ` (${String(p.PromptLanguage)})` : ''}` : 'off';
    const liveText =
      live?.voicemailEnabled === undefined
        ? 'could not be read'
        : live.voicemailEnabled
          ? `on${live.voicemailPromptLanguage ? ` (${live.voicemailPromptLanguage})` : ''}`
          : 'off';
    return `Voicemail: designed ${designed}, live ${liveText}`;
  }
  return `${call.cmdlet} still pending`;
}

/**
 * The verdict for one re-checked row: re-plan it against the fresh live state
 * (the same planIdentityRow/planResourceAccountRow call a deployment makes) -
 * anything still planned is something that didn't land. `live` undefined
 * means the targeted check didn't find the account in Teams at all.
 */
export function verificationRowDifferences(calls: CmdletInvocation[], live: LiveIdentityState | undefined): string[] {
  if (!live) return ['Not found in Teams when re-checked'];
  return calls.filter((c) => !UNVERIFIABLE_CMDLETS.has(c.cmdlet)).map((c) => describeRemainingCall(c, live));
}

/** "Verified: 48/50 match - 2 still differ" - the one-line summary the Run history shows. */
export function verificationHeadline(v: DeploymentVerification): string {
  if (v.status === 'pending') return 'Checking the live tenant…';
  if (v.status !== 'verified') return v.status === 'skipped' ? `Not verified: ${v.reason}` : `Verification failed: ${v.reason}`;
  const differ = v.differing.length;
  return `Verified: ${v.matched}/${v.checked} match${differ ? ` - ${differ} still differ` : ''}`;
}
