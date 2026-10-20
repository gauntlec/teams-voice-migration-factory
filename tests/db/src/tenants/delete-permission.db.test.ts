// Only a Super Admin may reach the three "delete a customer" routes: the route table says so, and the guard enforces it.
import 'reflect-metadata';
import { Reflector } from '@nestjs/core';
import { describe, expect, it } from 'vitest';
import { ROLES, type Role } from '@tvmf/shared';
import { PermissionsGuard } from '../../../../apps/api/src/rbac/permissions.guard';
import { REQUIRE_PERMISSION } from '../../../../apps/api/src/rbac/require-permission.decorator';
import { TenantsController } from '../../../../apps/api/src/tenants/tenants.controller';

const guard = new PermissionsGuard(new Reflector());
const routes = ['pendingDeletion', 'deletionSummary', 'deleteTenant'] as const;

const contextFor = (handler: string, role: Role) =>
  ({
    getHandler: () => (TenantsController.prototype as never as Record<string, () => void>)[handler],
    getClass: () => TenantsController,
    switchToHttp: () => ({ getRequest: () => ({ user: { id: 'u', role } }) }),
  }) as never;

describe('the delete-a-customer routes', () => {
  it.each(routes)('%s requires the tenant:delete permission', (handler) => {
    const proto = TenantsController.prototype as never as Record<string, () => void>;
    expect(Reflect.getMetadata(REQUIRE_PERMISSION, proto[handler])).toEqual(['tenant:delete']);
  });

  it.each(routes)('%s: a Super Admin gets in; every other role gets 403', (handler) => {
    expect(guard.canActivate(contextFor(handler, 'SUPER_ADMIN'))).toBe(true);
    for (const role of ROLES.filter((r) => r !== 'SUPER_ADMIN')) {
      expect(() => guard.canActivate(contextFor(handler, role)), role).toThrow(/Missing permission: tenant:delete/);
    }
  });

  it('no one is let through without being signed in', () => {
    const ctx = { getHandler: () => TenantsController.prototype.deleteTenant, getClass: () => TenantsController, switchToHttp: () => ({ getRequest: () => ({}) }) } as never;
    expect(() => guard.canActivate(ctx)).toThrow(/Not authenticated/);
  });
});
