import { describe, expect, it } from 'vitest';
import { PERMISSIONS, ROLES, can } from './rbac';
import { blockerMessage, deleteTenantSchema } from './tenant-deletion';

describe('deleting a customer: who may', () => {
  it('only a Super Admin holds tenant:delete', () => {
    expect(PERMISSIONS).toContain('tenant:delete');
    expect(ROLES.filter((r) => can(r, 'tenant:delete'))).toEqual(['SUPER_ADMIN']);
  });

  it('is not implied by the other customer permissions that staff hold', () => {
    // Engineers and project managers can read and manage members of their own customers, never delete the customer.
    for (const role of ['PROJECT_MANAGER', 'ENGINEER', 'CUSTOMER'] as const) {
      expect(can(role, 'tenant:delete')).toBe(false);
      expect(can(role, 'tenant:archive')).toBe(false);
      expect(can(role, 'tenant:update')).toBe(false);
    }
  });
});

describe('deleteTenantSchema', () => {
  it('needs the typed name and a six digit code, and nothing else', () => {
    expect(deleteTenantSchema.safeParse({ confirmName: 'Contoso', totpCode: '123456' }).success).toBe(true);
    expect(deleteTenantSchema.safeParse({ confirmName: '', totpCode: '123456' }).success).toBe(false);
    expect(deleteTenantSchema.safeParse({ confirmName: 'Contoso', totpCode: '12345' }).success).toBe(false);
    expect(deleteTenantSchema.safeParse({ confirmName: 'Contoso', totpCode: 'abcdef' }).success).toBe(false);
    expect(deleteTenantSchema.safeParse({ confirmName: 'Contoso', totpCode: '123456', force: true }).success).toBe(false);
  });
});

describe('blockerMessage', () => {
  it('says what to do, in the singular and the plural', () => {
    expect(blockerMessage('deployment', 1)).toMatch(/Wait for it to finish/);
    expect(blockerMessage('deployment', 3)).toMatch(/3 deployments/);
    expect(blockerMessage('discovery', 1)).toMatch(/Discovery run/);
  });
});
