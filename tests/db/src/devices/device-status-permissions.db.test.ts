// Every route of the Monitoring API names the permission it needs. This pins them: the status screen is monitoring:read (project managers and customers
// have it), and EVERYTHING else is monitoring:manage (engineers and administrators only). A new route that forgets its permission fails here.
import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import { can, ROLES } from '@tvmf/shared';
import { DeviceStatusController } from '../../../../apps/api/src/modules/device-status/device-status.controller';
import { REQUIRE_PERMISSION } from '../../../../apps/api/src/rbac/require-permission.decorator';

const proto = DeviceStatusController.prototype as unknown as Record<string, unknown>;
const routes = Object.getOwnPropertyNames(proto).filter((n) => n !== 'constructor' && typeof proto[n] === 'function');
const needs = (name: string) => Reflect.getMetadata(REQUIRE_PERMISSION, proto[name] as object) as string[] | undefined;

describe('Monitoring API permissions', () => {
  it('has the routes we expect', () => {
    expect(routes.sort()).toEqual(['addDevice', 'alerts', 'autoSetup', 'overview', 'removeDevice', 'saveAlerts', 'saveSettings', 'stopManaging', 'testAlert', 'updateDevice']);
  });
  it('every route names a permission', () => {
    for (const r of routes) expect(needs(r), r).toBeTruthy();
  });
  it('only the status screen is open to project managers and customers; everything else is engineers and administrators', () => {
    for (const r of routes) {
      const perms = needs(r)!;
      const allowed = ROLES.filter((role) => perms.every((p) => can(role, p as never))).sort();
      if (r === 'overview') expect(allowed, r).toEqual(['CUSTOMER', 'ENGINEER', 'PROJECT_MANAGER', 'SUPER_ADMIN']);
      else expect(allowed, r).toEqual(['ENGINEER', 'SUPER_ADMIN']);
    }
  });
});
