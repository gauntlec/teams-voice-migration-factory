import { POLICY_KINDS } from '@tvmf/shared';
import type { CmdletInvocation } from './teams/executor';

interface BuildUserRow {
  id: string;
  upn: string;
  e164: string | null;
  number_type: string | null;
  revoke_ev: boolean;
  policies: Record<string, string | null> | null;
}

/**
 * Turn a build_users row into the ordered list of cmdlets the deployment engine
 * would run. Mirrors the order in the current Teams-Migration-Build .ps1:
 * number assignment first, then policy grants.
 */
export function planUserRow(row: BuildUserRow): CmdletInvocation[] {
  const calls: CmdletInvocation[] = [];
  const identity = row.upn;

  if (row.revoke_ev) {
    calls.push({
      cmdlet: 'Remove-CsPhoneNumberAssignment',
      parameters: { Identity: identity, RemoveAll: true },
      objectType: 'user',
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
      objectType: 'user',
      objectId: row.id,
    });
  }

  for (const kind of POLICY_KINDS) {
    const value = row.policies?.[kind.key];
    if (!value) continue;
    calls.push({
      cmdlet: kind.cmdlet,
      parameters: { Identity: identity, PolicyName: value },
      objectType: 'user',
      objectId: row.id,
    });
  }

  return calls;
}
