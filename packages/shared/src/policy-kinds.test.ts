import { describe, expect, it } from 'vitest';
import { POLICY_KIND_GROUPS, POLICY_KIND_TO_TENANT_TYPE, POLICY_KINDS, TENANT_POLICY_TYPES, TENANT_POLICY_TYPE_LABELS } from './domain';

describe('policy kinds', () => {
  it('covers the 13 policies the original build sets plus the four other per-user voice policies', () => {
    expect(POLICY_KINDS).toHaveLength(17);
    const keys = POLICY_KINDS.map((k) => k.key);
    for (const k of ['mobility_policy', 'audio_conferencing_policy', 'compliance_recording_policy', 'survivable_branch_policy']) {
      expect(keys).toContain(k);
    }
  });

  it('has unique keys and cmdlets, every one a Grant-Cs cmdlet', () => {
    expect(new Set(POLICY_KINDS.map((k) => k.key)).size).toBe(POLICY_KINDS.length);
    expect(new Set(POLICY_KINDS.map((k) => k.cmdlet)).size).toBe(POLICY_KINDS.length);
    for (const k of POLICY_KINDS) expect(k.cmdlet).toMatch(/^Grant-Cs[A-Za-z]+$/);
  });

  it('puts every kind in a known group', () => {
    for (const k of POLICY_KINDS) expect(POLICY_KIND_GROUPS).toContain(k.group);
    for (const g of POLICY_KIND_GROUPS) expect(POLICY_KINDS.some((k) => k.group === g)).toBe(true);
  });

  it('can compare every kind with what Discovery reads from the tenant', () => {
    for (const k of POLICY_KINDS) {
      const type = POLICY_KIND_TO_TENANT_TYPE[k.key];
      expect(type, k.key).toBeDefined();
      expect(TENANT_POLICY_TYPES).toContain(type);
      expect(TENANT_POLICY_TYPE_LABELS[type!]).toBeTruthy();
    }
  });
});
