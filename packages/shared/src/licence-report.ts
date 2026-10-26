/*
 * Licence and cost hygiene, from the last Discovery: Teams Phone licences, resource accounts and numbers that are paid for but
 * not used, and resource accounts that cannot work. Teams Admin Center has no single view of this. Counts only - no prices.
 */

export type LicenceFindingSeverity = 'cost' | 'broken' | 'tidy';

export interface LicenceReportAccount {
  id: string;
  /** Entra object id - what an auto attendant or call queue lists in ApplicationInstances */
  entraId: string | null;
  upn: string;
  displayName: string | null;
  accountType: string | null;
  accountEnabled: boolean | null;
  enterpriseVoice: boolean;
  lineUri: string | null;
  assignedPlans: unknown[];
}

export interface LicenceReportNumber {
  number: string;
  numberType: string | null;
  assignmentStatus: string | null;
}

export interface LicenceReportInput {
  accounts: LicenceReportAccount[];
  numbers: LicenceReportNumber[];
  /** Entra object ids of resource accounts that some auto attendant or call queue uses */
  attachedResourceAccountIds: Set<string>;
  /** lower-case UPN -> the Data Collection site it is captured on */
  siteOf: Map<string, string>;
}

export interface LicenceFindingItem {
  name: string;
  upn: string | null;
  detail: string;
  site: string | null;
}

export interface LicenceFinding {
  key: 'leaver_phone_licence' | 'licensed_not_calling' | 'unassigned_numbers' | 'resource_account_unused' | 'resource_account_no_licence';
  severity: LicenceFindingSeverity;
  title: string;
  /** why it matters */
  why: string;
  /** what to do about it */
  action: string;
  items: LicenceFindingItem[];
  /** items per site, most first; items not captured on a site count as "No site" */
  bySite: { site: string; count: number }[];
}

const LIVE_PLAN = (p: Record<string, unknown>) => String(p?.CapabilityStatus ?? 'Enabled') !== 'Deleted';
const plans = (a: LicenceReportAccount) => (Array.isArray(a.assignedPlans) ? (a.assignedPlans as Record<string, unknown>[]) : []);

/** A Teams Phone licence for a person or common area phone (MCOEV / TEAMSPHONE / MCOPSTN, not the resource-account one). */
export function hasUserPhoneLicence(a: LicenceReportAccount): boolean {
  return plans(a).some((p) => {
    const c = String(p?.Capability ?? '');
    return LIVE_PLAN(p) && !/VIRTUALUSER/i.test(c) && (/^MCOEV/i.test(c) || /TEAMSPHONE|MCOPSTN/i.test(c));
  });
}

/** The Teams Phone Resource Account licence (MCOEV_VIRTUALUSER). */
export function hasResourceAccountLicence(a: LicenceReportAccount): boolean {
  return plans(a).some((p) => LIVE_PLAN(p) && /VIRTUALUSER/i.test(String(p?.Capability ?? '')));
}

const plainNumber = (lineUri: string | null) => (lineUri ? lineUri.replace(/^tel:/i, '') : null);

export function buildLicenceReport(input: LicenceReportInput): LicenceFinding[] {
  const site = (upn: string | null) => (upn ? input.siteOf.get(upn.toLowerCase()) ?? null : null);
  const item = (a: LicenceReportAccount, detail: string): LicenceFindingItem => ({ name: a.displayName ?? a.upn, upn: a.upn, detail, site: site(a.upn) });
  const isRa = (a: LicenceReportAccount) => a.accountType === 'ResourceAccount';
  const people = input.accounts.filter((a) => !isRa(a));
  const ras = input.accounts.filter(isRa);

  const findings: Omit<LicenceFinding, 'bySite'>[] = [
    {
      key: 'leaver_phone_licence',
      severity: 'cost',
      title: 'Switched-off accounts with a Teams Phone licence',
      why: 'The account is disabled, usually a leaver, but still holds a Teams Phone licence (and often a number).',
      action: 'Remove the licence and release the number, or raise a leaver request.',
      items: people
        .filter((a) => a.accountEnabled === false && hasUserPhoneLicence(a))
        .map((a) => item(a, plainNumber(a.lineUri) ? `Still has ${plainNumber(a.lineUri)}` : 'No number')),
    },
    {
      key: 'licensed_not_calling',
      severity: 'cost',
      title: 'Teams Phone licence, but not set up for calling',
      why: 'The licence is assigned, but Enterprise Voice is off and there is no number, so it is not used for calls.',
      action: 'Set the person up for calling, or take the licence back.',
      items: people
        .filter((a) => a.accountEnabled !== false && hasUserPhoneLicence(a) && !a.enterpriseVoice && !a.lineUri)
        .map((a) => item(a, 'Enterprise Voice off, no number')),
    },
    {
      key: 'unassigned_numbers',
      severity: 'cost',
      title: 'Numbers assigned to nobody',
      why: 'Calling Plan and Operator Connect numbers are paid for per number; a Direct Routing number is paid to your carrier.',
      action: 'Assign the number, keep it as a spare on purpose, or release it.',
      items: input.numbers
        .filter((n) => /^unassigned$/i.test(n.assignmentStatus ?? ''))
        .map((n) => ({ name: n.number, upn: null, detail: n.numberType ?? 'Unknown type', site: null })),
    },
    {
      key: 'resource_account_unused',
      severity: 'cost',
      title: 'Resource accounts that no auto attendant or call queue uses',
      why: 'The account answers nothing, but may still hold a licence or a number.',
      action: 'Attach it to a voice app, or delete it and release its number.',
      items: ras
        .filter((a) => !(a.entraId && input.attachedResourceAccountIds.has(a.entraId)))
        .map((a) =>
          item(a, [plainNumber(a.lineUri) ? `Has ${plainNumber(a.lineUri)}` : 'No number', hasResourceAccountLicence(a) ? 'licensed' : 'no licence'].join(', ')),
        ),
    },
    {
      key: 'resource_account_no_licence',
      severity: 'broken',
      title: 'Resource accounts with a number but no resource account licence',
      why: 'A resource account needs the Teams Phone Resource Account licence to use a phone number; callers may not reach it.',
      action: 'Assign the Teams Phone Resource Account licence (it is free).',
      items: ras.filter((a) => !!a.lineUri && !hasResourceAccountLicence(a)).map((a) => item(a, `Has ${plainNumber(a.lineUri)}`)),
    },
  ];

  return findings.map((f) => {
    const counts = new Map<string, number>();
    for (const i of f.items) counts.set(i.site ?? 'No site', (counts.get(i.site ?? 'No site') ?? 0) + 1);
    return { ...f, bySite: [...counts].map(([s, count]) => ({ site: s, count })).sort((x, y) => y.count - x.count || x.site.localeCompare(y.site)) };
  });
}
