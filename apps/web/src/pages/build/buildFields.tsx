import { tokens } from '@fluentui/react-components';
import { NUMBER_TYPES, POLICY_KINDS, VOICEMAIL_PROMPT_LANGUAGES, type BuildRowValidation } from '@tvmf/shared';
import { type Choice, type ColumnDef, type FieldDef, type Row } from '../../components/records';
import { VOICEMAIL_LANGUAGE_CHOICES } from './buildShared';

/** One grid column per POLICY_KINDS entry, reading the same `policies` jsonb the edit dialog writes to. */
export function policyColumns(): ColumnDef[] {
  return POLICY_KINDS.map((k) => ({
    key: `policies.${k.key}`,
    label: k.label,
    render: (r: Row) => {
      const target = (r.policies as Record<string, string>)?.[k.key];
      if (!target) return '—';
      // Blank targets get backfilled from live on Validate (BuildService.backfillPolicyTargets)
      // as a starting point; once the target diverges from live - by that
      // backfill matching nothing, or the engineer picking something else -
      // policyMismatches flags it, so it's obvious which accounts have a
      // real pending change before deploying.
      const v = r.validation as BuildRowValidation | null;
      const mismatch = v?.policyMismatches.find((p) => p.key === k.key);
      if (!mismatch) return target;
      return (
        <span
          title={`Live: ${mismatch.live ?? '(none)'} → will change to "${target}" on deploy`}
          style={{ color: tokens.colorPaletteMarigoldForeground2, backgroundColor: tokens.colorPaletteMarigoldBackground2, fontWeight: tokens.fontWeightSemibold, padding: '1px 6px', borderRadius: tokens.borderRadiusSmall }}
        >
          {target}
        </span>
      );
    },
  }));
}

// Per Microsoft's Shared Calling setup guide: a Shared Calling user must not
// also have a phone number assigned (they get EnterpriseVoiceEnabled set
// directly instead - see planIdentityRow, packages/shared/src/deployment.ts).
// Greying these out here stops that mistake before it's saved, rather than
// only warning about it after (identityRowWarnings).
const disabledForSharedCalling = (values: Record<string, string>) => !!values['policy_ids.shared_calling_policy'];

export function identityFields(policyFields: FieldDef[], numberChoicesFor: (row: Row | null) => Choice[]): FieldDef[] {
  return [
    { key: 'upn', label: 'UPN', required: true, placeholder: 'user@customer.com' },
    { key: 'phone_number_id', label: 'Phone number', type: 'ref', choices: numberChoicesFor, disabledWhen: disabledForSharedCalling },
    { key: 'did', label: 'DID (if not yet in inventory)', disabledWhen: disabledForSharedCalling },
    { key: 'number_type', label: 'Number type', type: 'select', options: NUMBER_TYPES, disabledWhen: disabledForSharedCalling },
    { key: 'revoke_ev', label: 'Revoke Enterprise Voice', type: 'boolean' },
    { key: 'migration_wave', label: 'Migration wave' },
    // The actual Set-CsOnlineVoicemailUserSettings target - separate from
    // voicemail_policy below (a policy grant, a different setting). Populate
    // prefills this from Site Data; it deploys from here.
    { key: 'voicemail.enabled', label: 'Voicemail enabled', type: 'boolean' },
    // Culture codes only - Teams rejects a plain name like "English" (see VOICEMAIL_PROMPT_LANGUAGES).
    { key: 'voicemail.language', label: 'Voicemail language', type: 'ref', choices: VOICEMAIL_LANGUAGE_CHOICES },
    ...policyFields,
    { key: 'comments', label: 'Comments', type: 'textarea', full: true },
  ];
}

/**
 * The fields bulk edit exposes - identityFields() (shared by Users and
 * CAPs) minus upn/phone_number_id/did. Those three are per-row-unique
 * identifiers - bulk-applying the same UPN, phone number, or raw DID text
 * to many rows would be destructive, not a real bulk operation (see
 * buildBulkPatchSchema, packages/shared/src/dto.ts). numberChoicesFor isn't
 * needed since phone_number_id is excluded.
 */
export function bulkIdentityFields(policyFields: FieldDef[]): FieldDef[] {
  return identityFields(policyFields, () => []).filter((f) => !['upn', 'phone_number_id', 'did'].includes(f.key));
}
