import { describe, expect, it } from 'vitest';
import { can, ROLES } from './rbac';

describe('Monitoring permissions', () => {
  it('lets only engineers and administrators add devices, set monitoring up and change alerts', () => {
    expect(ROLES.filter((r) => can(r, 'monitoring:manage')).sort()).toEqual(['ENGINEER', 'SUPER_ADMIN']);
  });
  it('lets everyone who sees a customer see the status screen, project managers included', () => {
    expect(ROLES.filter((r) => can(r, 'monitoring:read')).sort()).toEqual(['CUSTOMER', 'ENGINEER', 'PROJECT_MANAGER', 'SUPER_ADMIN']);
  });
  it('keeps project managers on the status screen only', () => {
    expect(can('PROJECT_MANAGER', 'monitoring:read')).toBe(true);
    expect(can('PROJECT_MANAGER', 'monitoring:manage')).toBe(false);
    // and the old, wider permission no longer opens monitoring: it is only about sites
    expect(can('PROJECT_MANAGER', 'discovery:sites:manage')).toBe(true);
  });
  it('never lets a customer change monitoring', () => {
    expect(can('CUSTOMER', 'monitoring:manage')).toBe(false);
  });
});
