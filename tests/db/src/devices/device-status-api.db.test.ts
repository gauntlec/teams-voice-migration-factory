// The Device status service the API routes call: managed setup, the device list, and what it refuses.
process.env.DATA_ENCRYPTION_KEY ||= 'device-status-api-test-key';
import { beforeAll, describe, expect, it } from 'vitest';
import { AuditService } from '../../../../apps/api/src/common/audit.service';
import { decryptSecret } from '../../../../apps/api/src/common/crypto';
import { DeviceStatusService } from '../../../../apps/api/src/modules/device-status/device-status.service';
import { seedCustomer, seedSite, seedUser, useDb, type TestCustomer } from '../helpers';

const handle = useDb();
let c: TestCustomer;
let svc: DeviceStatusService;
let owner: Awaited<ReturnType<typeof seedUser>>;
const door = { siteCode: 'ltn01', name: 'Door paging', kind: 'algo', checkType: 'ping', address: '10.1.2.3', port: null } as const;

beforeAll(async () => {
  c = await seedCustomer(handle);
  owner = await seedUser(handle, 'ENGINEER');
  await seedSite(c.s, { sitecode: 'LTN01', name: 'Luton' });
  svc = new DeviceStatusService(handle.db, new AuditService(handle.db));
});

describe('DeviceStatusService', () => {
  it('stores a device with the site\'s own code, and refuses a site that does not exist', async () => {
    const row = await svc.addDevice(c.t, owner, door);
    expect(row.siteCode).toBe('LTN01');
    await expect(svc.addDevice(c.t, owner, { ...door, siteCode: 'NOPE' })).rejects.toThrow(/no site "NOPE"/);
  });

  it('changes and removes a device, and says so for one that is not there', async () => {
    const [row] = (await svc.overview(c.t)).inventory;
    expect((await svc.updateDevice(c.t, owner, row!.id, { ...door, name: 'Door horn', siteCode: 'LTN01' })).name).toBe('Door horn');
    await expect(svc.updateDevice(c.t, owner, '00000000-0000-4000-8000-000000000000', { ...door, siteCode: 'LTN01' })).rejects.toThrow(/not on the list/);
    expect(await svc.removeDevice(c.t, owner, row!.id)).toEqual({ ok: true });
    await expect(svc.removeDevice(c.t, owner, row!.id)).rejects.toThrow(/not on the list/);
  });

  it('set up automatically: on, pointed at the stack\'s Kuma, a sync asked for', async () => {
    const o = await svc.autoSetup(c.t, owner, {});
    expect(o.settings).toMatchObject({ enabled: true, kumaUrl: 'http://kuma:3001', statusSlug: 'voxshift' });
    expect(o.managed).toMatchObject({ managed: true, syncNeeded: true, hasCredentials: false });
  });

  it('keeps a supplied Kuma administrator encrypted, and never gives the password back', async () => {
    const o = await svc.autoSetup(c.t, owner, { kumaUrl: 'http://kuma:3001', adminUser: 'admin', adminPassword: 'a-very-long-password-1' });
    expect(o.managed.hasCredentials).toBe(true);
    expect(JSON.stringify(o)).not.toContain('a-very-long-password-1');
    const row = await c.s.selectFrom('device_monitor_settings').select(['kuma_admin_user', 'kuma_admin_pass_enc']).executeTakeFirstOrThrow();
    expect(row.kuma_admin_user).toBe('admin');
    expect(row.kuma_admin_pass_enc).not.toContain('a-very-long-password-1');
    expect(decryptSecret(row.kuma_admin_pass_enc!)).toBe('a-very-long-password-1');
    await expect(svc.autoSetup(c.t, owner, { adminUser: 'admin' })).rejects.toThrow(/both/);
  });

  it('stop managing leaves device status on, and Kuma as it is', async () => {
    const o = await svc.stopManaging(c.t, owner);
    expect(o.managed.managed).toBe(false);
    expect(o.settings.enabled).toBe(true);
  });
});
