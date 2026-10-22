import { describe, expect, it } from 'vitest';
import type { BuildRowValidation } from './index';
import { blockingIssues, hasValidationIssue, validationIssues } from './validation-issues';

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
      'info:policy_mismatch',
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

  it('does not count a policy rename as needing attention', () => {
    const v: BuildRowValidation = { ...clean, renamedPolicies: [{ key: 'calling_policy' as never, label: 'Calling policy', storedName: 'A', liveName: 'B' }] };
    expect(validationIssues(v)).toHaveLength(1);
    expect(hasValidationIssue(v)).toBe(false);
  });
});
