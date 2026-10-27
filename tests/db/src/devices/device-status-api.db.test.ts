// The Device status service the API routes call: managed setup, the device list, and what it refuses.
process.env.DATA_ENCRYPTION_KEY ||= 'device-status-api-test-key';
import { beforeAll, describe, expect, it } from 'vitest';
import { kumaSlugForTenant } from '@tvmf/shared';
import { AuditService } from '../../../../apps/api/src/common/audit.service';
import { decryptSecret } from '../../../../apps/api/src/common/crypto';
import { DeviceStatusService } from '../../../../apps/api/src/modules/device-status/device-status.service';
import { seedCustomer, seedSite, seedUser, useDb, type TestCustomer } from '../helpers';

const handle = useDb();
let c: TestCustomer;
let svc: DeviceStatusService;
let owner: Awaited<ReturnType<typeof seedUser>>;
let pm: Awaited<ReturnType<typeof seedUser>>;
const queued: unknown[] = [];
const door = { siteCode: 'ltn01', name: 'Door paging', kind: 'algo', checkType: 'ping', address: '10.1.2.3', port: null } as const;

beforeAll(async () => {
  c = await seedCustomer(handle);
  owner = await seedUser(handle, 'ENGINEER');
  pm = await seedUser(handle, 'PROJECT_MANAGER');
  await seedSite(c.s, { sitecode: 'LTN01', name: 'Luton' });
  queued.length = 0;
  svc = new DeviceStatusService(handle.db, new AuditService(handle.db), { enqueue: async (m: unknown) => { queued.push(m); return { id: 'x' }; } } as never);
});

describe('DeviceStatusService', () => {
  it('stores a device with the site\'s own code, and refuses a site that does not exist', async () => {
    const row = await svc.addDevice(c.t, owner, door);
    expect(row.siteCode).toBe('LTN01');
    await expect(svc.addDevice(c.t, owner, { ...door, siteCode: 'NOPE' })).rejects.toThrow(/no site "NOPE"/);
  });

  it('changes and removes a device, and says so for one that is not there', async () => {
    const [row] = (await svc.overview(c.t, owner)).inventory;
    expect((await svc.updateDevice(c.t, owner, row!.id, { ...door, name: 'Door horn', siteCode: 'LTN01' })).name).toBe('Door horn');
    await expect(svc.updateDevice(c.t, owner, '00000000-0000-4000-8000-000000000000', { ...door, siteCode: 'LTN01' })).rejects.toThrow(/not on the list/);
    expect(await svc.removeDevice(c.t, owner, row!.id)).toEqual({ ok: true });
    await expect(svc.removeDevice(c.t, owner, row!.id)).rejects.toThrow(/not on the list/);
  });

  it('set up automatically: on, pointed at the stack\'s Kuma, a sync asked for', async () => {
    const o = await svc.autoSetup(c.t, owner, {});
    expect(o.settings).toMatchObject({ enabled: true, kumaUrl: 'http://kuma:3001', statusSlug: kumaSlugForTenant(c.t.id) });
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

describe('what each person gets to see', () => {
  it('an engineer sees the watch list and the setup; a project manager sees the status only', async () => {
    await svc.autoSetup(c.t, owner, {});
    await svc.addDevice(c.t, owner, { siteCode: 'LTN01', name: 'Door paging', kind: 'algo', checkType: 'ping', address: '10.1.2.3', port: null });
    const eng = await svc.overview(c.t, owner);
    expect(eng.inventory).toHaveLength(1);
    expect(eng.settings.kumaUrl).toBe('http://kuma:3001');
    expect(eng.managed.managed).toBe(true);
    const mgr = await svc.overview(c.t, pm);
    expect(mgr.inventory).toEqual([]);
    expect(mgr.siteOptions).toEqual([]);
    expect(mgr.settings).toMatchObject({ kumaUrl: '', statusSlug: '' });
    expect(mgr.managed).toMatchObject({ managed: false, hasCredentials: false });
    expect(JSON.stringify(mgr)).not.toContain('10.1.2.3');
  });

  it('a customer limited to one site sees only that site\'s devices', async () => {
    await seedSite(c.s, { sitecode: 'MAN02', name: 'Manchester' });
    const sites = await c.s.selectFrom('discovery_sites').select(['id', 'sitecode']).execute();
    const ltn = sites.find((x) => x.sitecode === 'LTN01')!;
    const man = sites.find((x) => x.sitecode === 'MAN02')!;
    for (const [id, code] of [[1, 'LTN01'], [2, 'MAN02']] as const) {
      await c.s.insertInto('device_monitors').values({ kuma_id: id, name: `dev ${code}`, sitecode: code, device_kind: 'algo', state: 'up', since: new Date().toISOString() } as never).execute();
    }
    const scoped = { ...c.t, siteScope: [man.id] };
    const o = await svc.overview(scoped, await seedUser(handle, 'CUSTOMER'));
    expect(o.devices.map((d) => d.sitecode)).toEqual(['MAN02']);
    expect(o.sites.map((x) => x.sitecode)).toEqual(['MAN02']);
    expect(o.inventory).toEqual([]);
    expect((await svc.overview({ ...c.t, siteScope: [ltn.id, man.id] }, owner)).devices).toHaveLength(2);
  });
});

describe('alerts through the service', () => {
  it('saves the settings, audits them and says how many people they reach', async () => {
    const v = await svc.saveAlerts(c.t, owner, { enabled: true, frequency: '1h', reminderHours: 4, notifyEngineers: true, notifyProjectManagers: false, recipients: ['ops@contoso.com'] });
    expect(v).toMatchObject({ enabled: true, frequency: '1h', reminderHours: 4, recipients: ['ops@contoso.com'] });
    expect(v.recipientCount).toBeGreaterThanOrEqual(1);
  });

  it('a test alert goes to the person who asked, as the alert email, and never to anyone else', async () => {
    queued.length = 0;
    expect(await svc.testAlert(c.t, owner)).toEqual({ sentTo: owner.email });
    expect(queued).toHaveLength(1);
    expect(queued[0]).toMatchObject({ template: 'device_alert', to: { email: owner.email }, tenantId: c.t.id });
    expect(JSON.stringify(queued[0])).toContain('"test":true');
  });
});
