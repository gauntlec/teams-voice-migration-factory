import { describe, expect, it } from 'vitest';
import type { BuildRowValidation } from './index';
import { blockingIssues, hasValidationIssue, issuesCsv, LICENCE_REQUEST_HEADER, licenceRequestCsv, licenceRequestUpns, validationIssues, type BuildIssueRow } from './validation-issues';

const clean: BuildRowValidation = {
  existsInTenant: true,
  enterpriseVoiceEnabled: true,
  liveLineUri: null,
  numberConflict: false,
  numberTypeMissing: false,
  accountDisabled: false,
  noPhoneLicence: false,
  usageLocationMismatch: null,
  policyMismatches: [],
  unknownPolicies: [],
  renamedPolicies: [],
  untracked: [],
};

describe('validationIssues', () => {
  it('has nothing to say about a matching row, or one with no stored validation', () => {
    expect(validationIssues(clean)).toEqual([]);
    expect(validationIssues(null)).toEqual([]);
    expect(hasValidationIssue(clean)).toBe(false);
  });

  it('puts what stops a deployment first and ranks the rest below it', () => {
    const v: BuildRowValidation = {
      ...clean,
      existsInTenant: false,
      accountDisabled: true,
      numberConflict: true,
      policyMismatches: [{ key: 'calling_policy' as never, label: 'Calling policy', target: 'UK', live: null }],
      unknownPolicies: [{ key: 'dial_plan' as never, label: 'Dial plan', value: 'Typo' }],
    };
    expect(validationIssues(v).map((i) => `${i.severity}:${i.code}`)).toEqual([
      'blocking:not_in_tenant',
      'blocking:number_conflict',
      'blocking:unknown_policy',
      'warning:account_disabled',
    ]);
    expect(blockingIssues(v)).toHaveLength(3);
  });

  it('treats a disabled account, a missing licence or a usage location difference as warnings that do not stop a deployment', () => {
    const v: BuildRowValidation = { ...clean, accountDisabled: true, noPhoneLicence: true, numberTypeMissing: true, usageLocationMismatch: { live: null, expected: 'US', country: 'United States' } };
    expect(blockingIssues(v)).toEqual([]);
    expect(validationIssues(v).map((i) => i.code)).toEqual(['account_disabled', 'no_phone_licence', 'usage_location', 'number_type_missing']);
  });

  it('flags a number the customer asked for that is not the one assigned, but ignores stored validation from before the check existed', () => {
    const asked = validationIssues({ ...clean, requestedNumberMismatch: { requested: '+1 212 555 0999', assigned: null } });
    expect(asked[0]).toMatchObject({ code: 'requested_number_mismatch', severity: 'blocking' });
    expect(validationIssues({ ...clean, requestedNumberMismatch: undefined })).toEqual([]);
  });

  it('does not list what deployment will change (a policy that differs from live, or one that was renamed) as an issue', () => {
    const v: BuildRowValidation = {
      ...clean,
      policyMismatches: [{ key: 'calling_policy' as never, label: 'Calling policy', target: 'UK', live: null }],
      renamedPolicies: [{ key: 'calling_policy' as never, label: 'Calling policy', storedName: 'A', liveName: 'B' }],
    };
    expect(validationIssues(v)).toEqual([]);
    expect(hasValidationIssue(v)).toBe(false);
  });

  it('asks for a decision on a number change until the engineer has made one', () => {
    const change = { designed: '+12125550299', live: '+12125550200', dataCollection: null };
    const pending = validationIssues({ ...clean, numberChange: { ...change, decision: 'pending' } });
    expect(pending[0]).toMatchObject({ code: 'number_change', severity: 'warning', decision: 'pending' });
    expect(hasValidationIssue({ ...clean, numberChange: { ...change, decision: 'pending' } })).toBe(true);
    const accepted: BuildRowValidation = { ...clean, numberChange: { ...change, decision: 'accepted' } };
    expect(validationIssues(accepted)[0]).toMatchObject({ severity: 'info', decision: 'accepted' });
    expect(hasValidationIssue(accepted)).toBe(false);
    expect(blockingIssues({ ...clean, numberChange: { ...change, decision: 'pending' } })).toEqual([]);
  });

  it('says what Accept and Reject do', () => {
    const change = { designed: '+12125550299', live: '+12125550200', dataCollection: null };
    const text = (decision: 'pending' | 'accepted' | 'rejected', c: { designed: string; live: string | null; dataCollection: string | null } = change) => validationIssues({ ...clean, numberChange: { ...c, decision } })[0]!.detail;
    expect(text('pending')).toContain("Accept: deployment changes the user's number to +12125550299. Reject: deployment leaves the user's number as it is in Teams (+12125550200).");
    expect(text('accepted')).toContain("Accepted: deployment will change the user's number to +12125550299.");
    expect(text('rejected')).toContain("Rejected: deployment leaves the user's number as it is in Teams (+12125550200).");
    // nothing live to keep: Reject means the number is not assigned
    expect(text('pending', { designed: '+12125550299', live: null, dataCollection: '+12125550301' })).toContain('Reject: deployment does not assign +12125550299.');
  });
});

describe('exports', () => {
  const row = (upn: string, code: 'no_phone_licence' | 'not_in_tenant', extra: Partial<BuildIssueRow> = {}): BuildIssueRow => ({
    sheet: 'users',
    rowId: upn,
    upn,
    displayName: null,
    issue: { code, severity: code === 'not_in_tenant' ? 'blocking' : 'warning', label: code === 'not_in_tenant' ? 'Not in tenant' : 'No phone licence', detail: 'A detail, with a comma and a "quote".' },
    ...extra,
  });

  it('lists each UPN missing a phone licence once under the title the bulk upload expects', () => {
    const issues = [row('b@contoso.test', 'no_phone_licence'), row('a@contoso.test', 'no_phone_licence'), row('B@Contoso.test', 'no_phone_licence'), row('c@contoso.test', 'not_in_tenant')];
    expect(licenceRequestUpns(issues)).toEqual(['a@contoso.test', 'b@contoso.test']);
    expect(licenceRequestCsv(issues)).toBe(`${LICENCE_REQUEST_HEADER}\r\na@contoso.test\r\nb@contoso.test\r\n`);
    expect(LICENCE_REQUEST_HEADER).toBe('Member object ID or user principal name [memberObjectIdOrUpn] Required');
  });

  it('is just the title when nobody needs a licence', () => {
    expect(licenceRequestCsv([row('c@contoso.test', 'not_in_tenant')])).toBe(`${LICENCE_REQUEST_HEADER}\r\n`);
  });

  it('writes every issue as a line, quoting what needs it', () => {
    const csv = issuesCsv([row('a@contoso.test', 'not_in_tenant', { displayName: 'Ann, A.' })]);
    expect(csv.split('\r\n')[0]).toBe('Severity,Sheet,Name,UPN,Issue,Detail');
    expect(csv.split('\r\n')[1]).toBe('Blocks deployment,Users,"Ann, A.",a@contoso.test,Not in tenant,"A detail, with a comma and a ""quote""."');
  });

  it('stops a spreadsheet running a cell that starts like a formula', () => {
    expect(issuesCsv([row('a@contoso.test', 'not_in_tenant', { displayName: '=HYPERLINK("x")' })])).toContain(`"'=HYPERLINK(""x"")"`);
  });
});
