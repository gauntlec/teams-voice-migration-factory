// Monitoring can be switched off for the whole installation (Platform settings > Menus and features) and for one customer (Customers): the
// API refuses, and the worker stops reading, setting up and emailing. Nothing is deleted. (Holds the global settings lock: it changes app_settings.)
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ForbiddenException, type ExecutionContext } from '@nestjs/common';
import { deviceStatusOverview, enableManagedKuma, forgetAppSettings, platformDb, saveDeviceAlertSettings, saveDeviceMonitorSettings } from '@tvmf/db';
import { permissionBlocked, PLATFORM_FEATURES } from '@tvmf/shared';
import { AuditService } from '../../../../apps/api/src/common/audit.service';
import { MonitoringEnabledGuard } from '../../../../apps/api/src/modules/device-status/monitoring-enabled.guard';
import { TenantsService } from '../../../../apps/api/src/tenants/tenants.service';
import { sweepDeviceAlerts } from '../../../../apps/worker/src/device-alerts';
import { sweepDeviceStatus } from '../../../../apps/worker/src/device-status';
import { sweepKumaSync } from '../../../../apps/worker/src/kuma-manager';
import type { EnqueueMailInput } from '../../../../apps/worker/src/mail/enqueue';
import { seedCustomer, seedUser, useDb, useGlobalSettingsLock, type TestCustomer } from '../helpers';

const handle = useDb();
useGlobalSettingsLock(handle);
let c: TestCustomer;
let admin: Awaited<ReturnType<typeof seedUser>>;
let tenants: TenantsService;
const sent: EnqueueMailInput[] = [];
const enqueue = async (m: EnqueueMailInput) => { sent.push(m); };
const T0 = new Date('2026-10-27T12:00:00Z');
const at = (min: number) => new Date(T0.getTime() + min * 60_000);

const setCustomer = (enabled: boolean) => platformDb(handle.db).updateTable('tenants').set({ monitoring_enabled: enabled }).where('id', '=', c.t.id).execute();
const setPlatform = async (off: boolean) => {
  await platformDb(handle.db).insertInto('app_settings').values({ id: true, base_url: null, disabled_features: off ? ['monitoring'] : [] } as never)
    .onConflict((oc) => oc.column('id').doUpdateSet({ disabled_features: off ? ['monitoring'] : [] })).execute();
  forgetAppSettings();
};
const guardFor = (monitoringEnabled?: boolean) =>
  new MonitoringEnabledGuard().canActivate({ switchToHttp: () => ({ getRequest: () => ({ tenant: { monitoringEnabled } }) }) } as unknown as ExecutionContext);

beforeAll(async () => {
  c = await seedCustomer(handle, { name: 'Switch test' });
  admin = await seedUser(handle, 'SUPER_ADMIN');
  tenants = new TenantsService(handle.db, handle.pool as never, new AuditService(handle.db), {} as never);
  await saveDeviceMonitorSettings(c.s, { enabled: true, kumaUrl: 'http://127.0.0.1:9', statusSlug: 'nothing-here' });
});
afterAll(async () => {
  await setPlatform(false);
  await platformDb(handle.db).deleteFrom('app_settings').execute();
  forgetAppSettings();
});

describe('the per-customer switch', () => {
  it('is on for a new customer, so nothing changes for customers that already use monitoring', async () => {
    const r = await platformDb(handle.db).selectFrom('tenants').select('monitoring_enabled').where('id', '=', c.t.id).executeTakeFirstOrThrow();
    expect(r.monitoring_enabled).toBe(true);
  });

  it('is changed by a Super Admin, audited, and listed', async () => {
    const off = await tenants.setMonitoring(c.t.id, false, { id: admin.id, email: admin.email });
    expect(off.monitoring_enabled).toBe(false);
    const listed = (await tenants.list({ id: admin.id, role: 'SUPER_ADMIN' })).find((t) => t.id === c.t.id)!;
    expect(listed.monitoring_enabled).toBe(false);
    const audit = await platformDb(handle.db).selectFrom('platform_audit_log').select('detail').where('action', '=', 'tenant.monitoring_changed').where('tenant_id', '=', c.t.id).execute();
    expect(audit.length).toBeGreaterThan(0);
    await expect(tenants.setMonitoring('00000000-0000-4000-8000-000000000000', true, { id: admin.id, email: admin.email })).rejects.toThrow();
  });

  it('makes the monitoring API refuse that customer, and nobody else', async () => {
    expect(() => guardFor(false)).toThrow(ForbiddenException);
    expect(guardFor(true)).toBe(true);
    expect(guardFor(undefined)).toBe(true);
  });

  it('stops the worker reading, setting up and emailing for that customer, and starts again when switched back on', async () => {
    await setCustomer(false);
    await enableManagedKuma(c.s, { tenantId: c.t.id, kumaUrl: 'http://127.0.0.1:9' });
    await saveDeviceAlertSettings(c.s, { enabled: true, frequency: 'immediate', reminderHours: 0, notifyEngineers: false, notifyProjectManagers: false, recipients: ['ops@switch.test'] }, at(0));
    await c.s.insertInto('device_status_changes').values({ kuma_id: 1, name: 'Door', sitecode: 'LTN01', device_kind: 'algo', from_state: 'up', to_state: 'down', at: at(1).toISOString() } as never).execute();
    await c.s.insertInto('device_monitors').values({ kuma_id: 1, name: 'Door', sitecode: 'LTN01', device_kind: 'algo', state: 'down', since: at(1).toISOString() } as never).execute();

    await sweepDeviceStatus(handle.db);
    await sweepKumaSync(handle.db);
    expect((await sweepDeviceAlerts(handle.db, enqueue, at(2), { tenantId: c.t.id })).emails).toBe(0);
    let o = await deviceStatusOverview(c.s);
    expect(o.settings.lastPolledAt).toBeNull();
    expect(o.managed.lastSyncAt).toBeNull();
    expect(sent).toHaveLength(0);

    await setCustomer(true);
    await sweepDeviceStatus(handle.db);
    await sweepKumaSync(handle.db);
    o = await deviceStatusOverview(c.s);
    expect(o.settings.lastPolledAt).not.toBeNull();
    expect(o.managed.lastSyncAt).not.toBeNull();
    expect((await sweepDeviceAlerts(handle.db, enqueue, at(3), { tenantId: c.t.id })).emails).toBeGreaterThan(0);
  });
});

describe('the installation-wide switch', () => {
  it('is one of the platform features, and blocks both monitoring permissions', () => {
    expect(PLATFORM_FEATURES).toContain('monitoring');
    for (const p of ['monitoring:read', 'monitoring:manage']) {
      expect(permissionBlocked(['monitoring'], p)).toBe(true);
      expect(permissionBlocked([], p)).toBe(false);
    }
    expect(permissionBlocked(['monitoring'], 'inc:read')).toBe(false);
  });

  it('stops the worker everywhere while it is off', async () => {
    await c.s.updateTable('device_monitor_settings').set({ last_polled_at: null, last_sync_at: null, sync_needed: true }).execute();
    const before = sent.length;
    await c.s.insertInto('device_status_changes').values({ kuma_id: 2, name: 'DECT', sitecode: 'LTN01', device_kind: 'dect', from_state: 'up', to_state: 'down', at: at(5).toISOString() } as never).execute();
    await setPlatform(true);
    await sweepDeviceStatus(handle.db);
    await sweepKumaSync(handle.db);
    expect((await sweepDeviceAlerts(handle.db, enqueue, at(6), { tenantId: c.t.id })).emails).toBe(0);
    const o = await deviceStatusOverview(c.s);
    expect(o.settings.lastPolledAt).toBeNull();
    expect(o.managed.lastSyncAt).toBeNull();
    expect(sent).toHaveLength(before);
    await setPlatform(false);
    await sweepDeviceStatus(handle.db);
    expect((await deviceStatusOverview(c.s)).settings.lastPolledAt).not.toBeNull();
  });
});
