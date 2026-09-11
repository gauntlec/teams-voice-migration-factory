import { POLICY_KINDS, RESOURCE_ACCOUNT_APPLICATION_IDS } from '@tvmf/shared';
import type { CmdletInvocation } from './teams/executor';

interface BuildIdentityRow {
  id: string;
  upn: string;
  e164: string | null;
  number_type: string | null;
  revoke_ev: boolean;
  policies: Record<string, string | null> | null;
}

/**
 * Turn a build_users/build_caps row into the ordered list of cmdlets the
 * deployment engine would run. Mirrors the order in the real
 * Teams-Migration-Build .ps1: number assignment first, then policy grants.
 * Users and CAPs plan identically - only the object type tag differs, matching
 * `deployment_changes.object_type` ('user' | 'cap').
 */
export function planIdentityRow(row: BuildIdentityRow, objectType: 'user' | 'cap'): CmdletInvocation[] {
  const calls: CmdletInvocation[] = [];
  const identity = row.upn;

  if (row.revoke_ev) {
    calls.push({
      cmdlet: 'Remove-CsPhoneNumberAssignment',
      parameters: { Identity: identity, RemoveAll: true },
      objectType,
      objectId: row.id,
    });
    return calls;
  }

  if (row.e164 && row.number_type) {
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
    calls.push({
      cmdlet: kind.cmdlet,
      parameters: { Identity: identity, PolicyName: value },
      objectType,
      objectId: row.id,
    });
  }

  return calls;
}

interface BuildResourceAccountRow {
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

/**
 * Resource accounts are a genuine two-phase process (see docs/DEPLOYMENT.md):
 * New-CsOnlineApplicationInstance always needs a Phone System license applied
 * by a User/Global Admin before anything else can succeed - a role a Teams
 * Administrator doesn't have. So phase 1 is always `deferred: true` (rendered
 * to the exported script, never invoked live, in either dry_run or execute
 * mode). Only once the row has an `application_id` from a completed phase 1
 * does phase 2 (number + voice routing policy, live-capable) run.
 */
export function planResourceAccountRow(row: BuildResourceAccountRow): CmdletInvocation[] {
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
  if (row.phone_number && row.number_type) {
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
  if (row.voice_routing_policy) {
    calls.push({
      cmdlet: 'Grant-CsOnlineVoiceRoutingPolicy',
      parameters: { Identity: row.upn, PolicyName: row.voice_routing_policy },
      objectType: 'resource_account',
      objectId: row.id,
    });
  }
  return calls;
}
