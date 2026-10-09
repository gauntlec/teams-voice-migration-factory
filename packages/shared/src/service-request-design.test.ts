import { describe, expect, it } from 'vitest';
import { DEPLOYMENT_SHEETS } from './domain';
import {
  SR_BUILD_ROUTE_KIND,
  SR_ITEM_KINDS,
  SR_ITEM_SHEET,
  serviceRequestDeploySchema,
  srBuiltBlockers,
  srDesignEditable,
  srHasDesign,
  srItemSheets,
} from './service-request-design';
import { SR_TYPES } from './service-requests';

describe('srHasDesign', () => {
  it('is on for the types that make Design & Build rows', () => {
    expect(SR_TYPES.filter(srHasDesign)).toEqual(['new_user', 'new_common_area_phone', 'new_call_queue', 'new_auto_attendant']);
  });
});

describe('srDesignEditable', () => {
  it('only while Planned', () => {
    expect(srDesignEditable('planned')).toBe(true);
    for (const s of ['new', 'built', 'deployed', 'cancelled'] as const) expect(srDesignEditable(s)).toBe(false);
  });
});

describe('srItemSheets', () => {
  it('maps kinds to sheets in deployment order, without duplicates or sites', () => {
    expect(srItemSheets(['auto_attendant', 'user', 'resource_account', 'user', 'site'])).toEqual(['users', 'resource_accounts', 'auto_attendants']);
    expect(srItemSheets(['site'])).toEqual([]);
  });
  it('every deployable kind has a real deployment sheet', () => {
    for (const k of SR_ITEM_KINDS) {
      const sheet = SR_ITEM_SHEET[k];
      if (k === 'site') expect(sheet).toBeUndefined();
      else expect(DEPLOYMENT_SHEETS).toContain(sheet);
    }
  });
});

describe('SR_BUILD_ROUTE_KIND', () => {
  it('only names single-row create routes', () => {
    expect(Object.keys(SR_BUILD_ROUTE_KIND).sort()).toEqual(
      ['auto-attendants', 'call-queues', 'caps', 'resource-accounts', 'shared-calling-policies', 'users'].sort(),
    );
  });
});

describe('srBuiltBlockers', () => {
  it('needs at least one designed row on a site', () => {
    expect(srBuiltBlockers('new_user', { siteId: 's', deployableCount: 0, missingCount: 0 })).toHaveLength(1);
    expect(srBuiltBlockers('new_user', { siteId: null, deployableCount: 0, missingCount: 0 })).toHaveLength(2);
    expect(srBuiltBlockers('new_call_queue', { siteId: 's', deployableCount: 2, missingCount: 0 })).toEqual([]);
  });
  it('flags rows deleted from Design & Build', () => {
    const out = srBuiltBlockers('new_auto_attendant', { siteId: 's', deployableCount: 1, missingCount: 2 });
    expect(out).toHaveLength(1);
    expect(out[0]).toContain('2 linked rows were deleted');
  });
  it('never blocks requests without a design', () => {
    for (const t of ['new_site', 'new_phone_numbers', 'other'] as const) {
      expect(srBuiltBlockers(t, { siteId: null, deployableCount: 0, missingCount: 3 })).toEqual([]);
    }
  });
});

describe('serviceRequestDeploySchema', () => {
  it('accepts a connection and mode, nothing else', () => {
    const id = '00000000-0000-4000-8000-000000000001';
    expect(serviceRequestDeploySchema.safeParse({ connectionId: id, mode: 'dry_run' }).success).toBe(true);
    expect(serviceRequestDeploySchema.safeParse({ connectionId: id, mode: 'execute', scope: {} }).success).toBe(false);
    expect(serviceRequestDeploySchema.safeParse({ connectionId: 'x', mode: 'execute' }).success).toBe(false);
  });
});
