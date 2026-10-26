import { describe, expect, it } from 'vitest';
import { buildLicenceReport, hasResourceAccountLicence, hasUserPhoneLicence, type LicenceReportAccount } from './licence-report';

const phone = [{ Capability: 'MCOEV', CapabilityStatus: 'Enabled' }];
const raLicence = [{ Capability: 'MCOEV_VIRTUALUSER', CapabilityStatus: 'Enabled' }];
const acct = (over: Partial<LicenceReportAccount>): LicenceReportAccount => ({
  id: over.upn ?? 'x',
  entraId: null,
  upn: 'x@contoso.test',
  displayName: null,
  accountType: 'User',
  accountEnabled: true,
  enterpriseVoice: true,
  lineUri: 'tel:+441582000001',
  assignedPlans: phone,
  ...over,
});

describe('licence plans', () => {
  it('tells the person licence from the resource account one', () => {
    expect(hasUserPhoneLicence(acct({}))).toBe(true);
    expect(hasUserPhoneLicence(acct({ assignedPlans: raLicence }))).toBe(false);
    expect(hasResourceAccountLicence(acct({ assignedPlans: raLicence }))).toBe(true);
    expect(hasUserPhoneLicence(acct({ assignedPlans: [{ Capability: 'MCOEV', CapabilityStatus: 'Deleted' }] }))).toBe(false);
  });
});

describe('buildLicenceReport', () => {
  const report = buildLicenceReport({
    accounts: [
      acct({ upn: 'fine@contoso.test' }),
      acct({ upn: 'leaver@contoso.test', accountEnabled: false }),
      acct({ upn: 'idle@contoso.test', enterpriseVoice: false, lineUri: null }),
      acct({ upn: 'idle2@contoso.test', enterpriseVoice: false, lineUri: null }),
      acct({ upn: 'ra-main@contoso.test', accountType: 'ResourceAccount', entraId: 'ra1', assignedPlans: raLicence }),
      acct({ upn: 'ra-old@contoso.test', accountType: 'ResourceAccount', entraId: 'ra2', assignedPlans: raLicence }),
      acct({ upn: 'ra-bad@contoso.test', accountType: 'ResourceAccount', entraId: 'ra3', assignedPlans: [] }),
    ],
    numbers: [
      { number: '+441582000009', numberType: 'CallingPlan', assignmentStatus: 'Unassigned' },
      { number: '+441582000001', numberType: 'DirectRouting', assignmentStatus: 'UserAssigned' },
    ],
    attachedResourceAccountIds: new Set(['ra1', 'ra3']),
    siteOf: new Map([['idle@contoso.test', 'LTN01'], ['idle2@contoso.test', 'LTN01']]),
  });
  const upns = (key: string) => report.find((f) => f.key === key)!.items.map((i) => i.upn ?? i.name);

  it('finds each kind of waste once', () => {
    expect(upns('leaver_phone_licence')).toEqual(['leaver@contoso.test']);
    expect(upns('licensed_not_calling')).toEqual(['idle@contoso.test', 'idle2@contoso.test']);
    expect(upns('unassigned_numbers')).toEqual(['+441582000009']);
    expect(upns('resource_account_unused')).toEqual(['ra-old@contoso.test']);
    expect(upns('resource_account_no_licence')).toEqual(['ra-bad@contoso.test']);
  });

  it('counts by site, most first', () => {
    expect(report.find((f) => f.key === 'licensed_not_calling')!.bySite).toEqual([{ site: 'LTN01', count: 2 }]);
    expect(report.find((f) => f.key === 'leaver_phone_licence')!.bySite).toEqual([{ site: 'No site', count: 1 }]);
  });
});
