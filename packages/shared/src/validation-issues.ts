import type { BuildRowValidation } from './index';

/**
 * One thing wrong (or worth knowing) about a Design & Build row, in the words
 * an engineer reads. The single list behind the row's badge, the Validation
 * issues tab and the count on the site card, so they can never disagree.
 *
 * - `blocking`: a deployment cannot apply this row correctly, so it is left out of the run
 *   (and listed in the change document under "Not deployed") until it is fixed in Design & Build.
 * - `warning`: the row still deploys, but something about the account is likely to cause trouble.
 * - `info`: nothing is wrong; only a record of an engineer's accept or reject of a number change (kept so it can be undone).
 *
 * What deployment will change (a policy that differs from live, a renamed policy) is not a validation issue: the Deployment module
 * shows it in its preview.
 */
export type ValidationSeverity = 'blocking' | 'warning' | 'info';

export type ValidationIssueCode =
  | 'not_in_tenant'
  | 'number_conflict'
  | 'unknown_policy'
  | 'requested_number_mismatch'
  | 'number_change'
  | 'account_disabled'
  | 'no_phone_licence'
  | 'usage_location'
  | 'number_type_missing';

export interface ValidationIssue {
  code: ValidationIssueCode;
  severity: ValidationSeverity;
  /** short name of the problem, for a column or a filter */
  label: string;
  /** the full sentence */
  detail: string;
  /** number_change only: where the engineer's accept/reject stands */
  decision?: 'pending' | 'accepted' | 'rejected';
}

/** Every issue on one row, most serious first. A row with no stored validation has none. */
export function validationIssues(v: BuildRowValidation | null | undefined): ValidationIssue[] {
  if (!v) return [];
  const out: ValidationIssue[] = [];
  if (!v.existsInTenant) {
    out.push({
      code: 'not_in_tenant',
      severity: 'blocking',
      label: 'Not in tenant',
      detail:
        'Not found in the synced tenant data. The account may not exist, or a sync may have left it out: syncs skip disabled accounts and accounts without a Teams licence unless those options are ticked.',
    });
  }
  if (v.numberConflict) {
    out.push({
      code: 'number_conflict',
      severity: 'blocking',
      label: 'Number used twice',
      detail: 'This number is also assigned to another user, common area phone or resource account in this tenant.',
    });
  }
  for (const p of v.unknownPolicies) {
    out.push({
      code: 'unknown_policy',
      severity: 'blocking',
      label: 'Unknown policy',
      detail: `${p.label}: "${p.value}" doesn't exist in the tenant.`,
    });
  }
  const rn = v.requestedNumberMismatch;
  if (rn) {
    out.push({
      code: 'requested_number_mismatch',
      severity: 'blocking',
      label: 'Requested number differs',
      detail: rn.assigned
        ? `The customer asked for ${rn.requested} but ${rn.assigned} is assigned. Assign the requested number or clear the request.`
        : `The customer asked for ${rn.requested} but no number is assigned. Assign it or clear the request.`,
    });
  }
  const nc = v.numberChange;
  if (nc) {
    const bits: string[] = [];
    if (nc.live) bits.push(`the user already has ${nc.live} in the tenant`);
    if (nc.dataCollection) bits.push(`Site Data has ${nc.dataCollection} assigned`);
    // what Reject means: the designed number is not deployed
    const keepText = nc.live ? `deployment leaves the user's number as it is in Teams (${nc.live}).` : `deployment does not assign ${nc.designed}.`;
    out.push({
      code: 'number_change',
      // an undecided change needs the engineer; once decided it is just a record
      severity: nc.decision === 'pending' ? 'warning' : 'info',
      label: nc.decision === 'pending' ? 'Number will change' : nc.decision === 'accepted' ? 'Number change accepted' : 'Number change rejected',
      detail:
        nc.decision === 'pending'
          ? `The design assigns ${nc.designed}, but ${bits.join(' and ')}. Accept: deployment changes the user's number to ${nc.designed}. Reject: ${keepText}`
          : nc.decision === 'accepted'
            ? `The design assigns ${nc.designed}; ${bits.join(' and ')}. Accepted: deployment will change the user's number to ${nc.designed}.`
            : `The design assigns ${nc.designed}; ${bits.join(' and ')}. Rejected: ${keepText} The design still says ${nc.designed}: edit the number on the row if the design should match.`,
      decision: nc.decision,
    });
  }
  if (v.accountDisabled) {
    out.push({
      code: 'account_disabled',
      severity: 'warning',
      label: 'Account disabled',
      detail: 'The account is disabled in the tenant: it cannot sign in or take calls.',
    });
  }
  if (v.noPhoneLicence) {
    out.push({
      code: 'no_phone_licence',
      severity: 'warning',
      label: 'No phone licence',
      detail: 'No Teams Phone licence on the account: a number cannot be assigned until it has one.',
    });
  }
  if (v.usageLocationMismatch) {
    out.push({
      code: 'usage_location',
      severity: 'warning',
      label: 'Usage location',
      detail: `Usage location is ${v.usageLocationMismatch.live ?? 'not set'} in the tenant, but this site is in ${v.usageLocationMismatch.country} (${v.usageLocationMismatch.expected}). They should match.`,
    });
  }
  if (v.numberTypeMissing) {
    out.push({
      code: 'number_type_missing',
      severity: 'warning',
      label: 'No number type',
      detail: "A phone number is set but no number type: the number won't be assigned (and Enterprise Voice won't be enabled) on deployment.",
    });
  }
  return out;
}

/** The issues that keep a row out of a deployment. */
export function blockingIssues(v: BuildRowValidation | null | undefined): ValidationIssue[] {
  return validationIssues(v).filter((i) => i.severity === 'blocking');
}

/** True when the row needs an engineer's attention: a blocking issue or a warning. A number change that has been decided does not. */
export function hasValidationIssue(v: BuildRowValidation | null | undefined): boolean {
  return validationIssues(v).some((i) => !(i.code === 'number_change' && i.decision !== 'pending'));
}

/** One line of the Validation issues tab: an issue and the row it is on. */
export interface BuildIssueRow {
  sheet: 'users' | 'caps' | 'resource-accounts';
  rowId: string;
  upn: string;
  displayName: string | null;
  issue: ValidationIssue;
}

/** Issues a resource account that has not been created yet can have: it can't exist in the tenant or match live policy yet. */
export const DESIGN_ONLY_ISSUE_CODES: readonly ValidationIssueCode[] = ['number_conflict', 'number_type_missing', 'unknown_policy'];

/* ------------------------------- exports ------------------------------- */

const SEVERITY_EXPORT_LABEL: Record<ValidationSeverity, string> = { blocking: 'Blocks deployment', warning: 'Warning', info: 'Decided' };
const SHEET_EXPORT_LABEL: Record<BuildIssueRow['sheet'], string> = { users: 'Users', caps: 'Common area phones', 'resource-accounts': 'Resource accounts' };

/** The one column the Microsoft 365 / Entra bulk member upload reads: UPNs under this exact title. */
export const LICENCE_REQUEST_HEADER = 'Member object ID or user principal name [memberObjectIdOrUpn] Required';

/** One CSV cell: quoted when it needs to be, and a leading = + - @ is neutralised so a spreadsheet never runs it as a formula. */
function csvCell(v: string): string {
  const safe = /^[=+\-@\t\r]/.test(v) ? `'${v}` : v;
  return /[",\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}
const csvLine = (cells: string[]) => cells.map(csvCell).join(',');

/** Every UPN with a "No phone licence" issue, once each (any case), in order: the people who need a Teams Phone licence. */
export function licenceRequestUpns(issues: readonly BuildIssueRow[]): string[] {
  const seen = new Map<string, string>();
  for (const i of issues) if (i.issue.code === 'no_phone_licence' && i.upn.trim() && !seen.has(i.upn.trim().toLowerCase())) seen.set(i.upn.trim().toLowerCase(), i.upn.trim());
  return [...seen.values()].sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
}

/** The licence request file: the title, then one UPN per line. */
export function licenceRequestCsv(issues: readonly BuildIssueRow[]): string {
  return [LICENCE_REQUEST_HEADER, ...licenceRequestUpns(issues).map(csvCell)].join('\r\n') + '\r\n';
}

/** Every issue on the site as a spreadsheet: one line per issue. */
export function issuesCsv(issues: readonly BuildIssueRow[]): string {
  const lines = [csvLine(['Severity', 'Sheet', 'Name', 'UPN', 'Issue', 'Detail'])];
  for (const i of issues) lines.push(csvLine([SEVERITY_EXPORT_LABEL[i.issue.severity], SHEET_EXPORT_LABEL[i.sheet], i.displayName ?? '', i.upn, i.issue.label, i.issue.detail]));
  return lines.join('\r\n') + '\r\n';
}
