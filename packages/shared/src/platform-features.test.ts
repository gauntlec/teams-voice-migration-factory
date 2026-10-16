import { describe, expect, it } from 'vitest';
import { PLATFORM_FEATURES, PLATFORM_FEATURE_INFO, FEATURE_PERMISSIONS, featureOn, permissionBlocked, setFeaturesSchema } from './platform-features';
import { PERMISSIONS } from './rbac';

describe('platform features', () => {
  it('describes every switchable area', () => {
    for (const f of PLATFORM_FEATURES) {
      expect(PLATFORM_FEATURE_INFO[f].label.length).toBeGreaterThan(2);
      expect(PLATFORM_FEATURE_INFO[f].menus.length).toBeGreaterThan(0);
    }
  });
  it('accepts a list of known areas and refuses anything else', () => {
    expect(setFeaturesSchema.parse({ disabled: ['bug_reports', 'msp'] }).disabled).toEqual(['bug_reports', 'msp']);
    expect(setFeaturesSchema.parse({ disabled: [] }).disabled).toEqual([]);
    expect(setFeaturesSchema.safeParse({ disabled: ['incidents'] }).success).toBe(false);
    expect(setFeaturesSchema.safeParse({ disabled: ['msp'], extra: 1 }).success).toBe(false);
  });
  it('treats everything as on unless listed', () => {
    expect(featureOn(undefined, 'msp')).toBe(true);
    expect(featureOn([], 'bug_reports')).toBe(true);
    expect(featureOn(['bug_reports'], 'bug_reports')).toBe(false);
    expect(featureOn(['bug_reports'], 'msp')).toBe(true);
  });

  it('blocks the permissions of an area that is off, and only those', () => {
    expect(permissionBlocked(['msp'], 'inc:msp')).toBe(true);
    expect(permissionBlocked(['msp'], 'msp:read')).toBe(true);
    expect(permissionBlocked(['msp'], 'bug:read')).toBe(false);
    expect(permissionBlocked(['bug_reports', 'feature_requests'], 'feature:read')).toBe(true);
    expect(permissionBlocked([], 'inc:msp')).toBe(false);
    expect(permissionBlocked(undefined, 'bug:read')).toBe(false);
  });
  it('only names permissions that exist', () => {
    for (const f of PLATFORM_FEATURES) for (const p of FEATURE_PERMISSIONS[f]) expect(PERMISSIONS as readonly string[], p).toContain(p);
  });
});
