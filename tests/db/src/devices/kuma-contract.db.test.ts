// The Socket.IO client (apps/worker/src/kuma-client.ts) against a REAL Uptime Kuma. Skipped unless KUMA_CONTRACT_URL points at a Kuma that has no
// administrator yet (a throwaway: this test creates one). A Kuma upgrade must pass this before the pin in the installer and compose files moves.
//   Kuma from source:  UPTIME_KUMA_DB_TYPE=sqlite UPTIME_KUMA_PORT=3011 DATA_DIR=/tmp/kuma-data/ node server/server.js
//   Run:               KUMA_CONTRACT_URL=http://127.0.0.1:3011 npx vitest run src/devices/kuma-contract
process.env.DATA_ENCRYPTION_KEY ||= 'kuma-contract-test-key';
import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { addDevice, deviceStatusOverview, enableManagedKuma, listDeviceInventory, recordDeviceSync, removeDevice, syncDeviceInventory, updateDevice } from '@tvmf/db';
import { parseKumaStatus } from '@tvmf/shared';
import { decryptSecret } from '../../../../apps/worker/src/crypto';
import { KumaClient } from '../../../../apps/worker/src/kuma-client';
import { syncKumaFor } from '../../../../apps/worker/src/kuma-manager';
import { seedCustomer, seedSite, useDb, type TestCustomer } from '../helpers';

const url = process.env.KUMA_CONTRACT_URL;
const handle = useDb();
let c: TestCustomer;
let client: KumaClient;
let password = '';

const status = async () => {
  const page = await fetch(`${url}/api/status-page/voxshift`).then((r) => r.json());
  const beats = await fetch(`${url}/api/status-page/heartbeat/voxshift`).then((r) => r.json());
  return parseKumaStatus(page, beats);
};

describe.skipIf(!url)('Uptime Kuma contract', () => {
  beforeAll(async () => {
    c = await seedCustomer(handle);
    await seedSite(c.s, { sitecode: 'LTN01', name: 'Luton' });
  });
  afterAll(() => client?.close());

  it('first-run setup then sign-in, by hand (the protocol)', async () => {
    const probe = await KumaClient.connect(url!);
    expect(await probe.needSetup()).toBe(true);
    probe.close();
  });

  it('the manager makes the administrator itself, keeps its password encrypted, and syncs devices into monitors, tags and the status page', async () => {
    await enableManagedKuma(c.s, { kumaUrl: url! });
    await addDevice(c.s, { siteCode: 'LTN01', name: 'Loopback ping', kind: 'algo', checkType: 'ping', address: '127.0.0.1', port: null });
    const portNumber = Number(new URL(url!).port);
    await addDevice(c.s, { siteCode: 'LTN01', name: 'Kuma itself', kind: 'other', checkType: 'port', address: '127.0.0.1', port: portNumber });
    expect(await syncKumaFor(c.s)).toBe('ok');
    const o = await deviceStatusOverview(c.s);
    expect(o.managed).toMatchObject({ managed: true, hasCredentials: true, syncNeeded: false, lastSyncError: null });
    const row = await c.s.selectFrom('device_monitor_settings').select(['kuma_admin_user', 'kuma_admin_pass_enc']).executeTakeFirstOrThrow();
    expect(row.kuma_admin_user).toBe('voxshift');
    expect(row.kuma_admin_pass_enc).not.toContain('voxshift');
    password = decryptSecret(row.kuma_admin_pass_enc!);
    expect(password.length).toBeGreaterThanOrEqual(24);
    const monitors = await status();
    expect(monitors.map((m) => [m.name, m.monitorType, m.sitecode, m.deviceKind]).sort()).toEqual([
      ['Kuma itself', 'port', 'LTN01', 'other'],
      ['Loopback ping', 'ping', 'LTN01', 'algo'],
    ]);
    expect(monitors[0]!.group).toBe('LTN01 · Luton');
    const page = (await fetch(`${url}/api/status-page/voxshift`).then((r) => r.json())) as { config: { customCSS: string } };
    expect(page.config).toMatchObject({ showTags: true, showPoweredBy: false, title: 'Voxshift device status' });
    expect(page.config.customCSS).toContain('#4657D2');
    client = await KumaClient.connect(url!);
    await client.login('voxshift', password);
  });

  it('a wrong password is refused with a plain message (now that Kuma has an administrator)', async () => {
    const other = await KumaClient.connect(url!);
    await expect(other.login('voxshift', 'not-the-password')).rejects.toThrow(/did not accept the administrator sign-in/);
    other.close();
  });

  it('the manager signs in again with the stored password and says nothing is due until something changes', async () => {
    expect(await syncKumaFor(c.s)).toBe('skipped');
    await c.s.updateTable('device_monitor_settings').set({ sync_needed: true }).execute();
    expect(await syncKumaFor(c.s)).toBe('ok');
  });

  it('a Kuma that has an administrator Voxshift does not know is reported plainly', async () => {
    await c.s.updateTable('device_monitor_settings').set({ kuma_admin_user: null, kuma_admin_pass_enc: null, sync_needed: true, last_sync_error: null }).execute();
    expect(await syncKumaFor(c.s)).toBe('failed');
    expect((await deviceStatusOverview(c.s)).managed.lastSyncError).toMatch(/already has an administrator that Voxshift does not know/);
    const { encryptSecret } = await import('../../../../apps/worker/src/crypto');
    await c.s.updateTable('device_monitor_settings').set({ kuma_admin_user: 'voxshift', kuma_admin_pass_enc: encryptSecret('wrong-password-123'), sync_needed: true, last_sync_error: null }).execute();
    expect(await syncKumaFor(c.s)).toBe('failed');
    expect((await deviceStatusOverview(c.s)).managed.lastSyncError).toMatch(/did not accept the administrator sign-in/);
    await c.s.updateTable('device_monitor_settings').set({ kuma_admin_pass_enc: encryptSecret(password), sync_needed: true, last_sync_error: null }).execute();
    expect(await syncKumaFor(c.s)).toBe('ok');
  });

  it('a second sync changes nothing', async () => {
    expect(await syncDeviceInventory(c.s, client)).toEqual({ created: 0, updated: 0, deleted: 0, errors: 0 });
  });

  it('edits a monitor and its tags when the device changes', async () => {
    const dev = (await listDeviceInventory(c.s)).find((d) => d.name === 'Loopback ping')!;
    await updateDevice(c.s, dev.id, { siteCode: 'LTN01', name: 'Loopback ping (renamed)', kind: 'dect', checkType: 'ping', address: '127.0.0.1', port: null });
    expect(await syncDeviceInventory(c.s, client)).toMatchObject({ updated: 1, errors: 0 });
    const m = (await status()).find((x) => x.name === 'Loopback ping (renamed)');
    expect(m).toMatchObject({ deviceKind: 'dect', sitecode: 'LTN01' });
  });

  it('reads as up once Kuma has checked, through the real poller path', async () => {
    let states: string[] = [];
    for (let i = 0; i < 20; i++) {
      states = (await status()).map((m) => m.state);
      if (states.length === 2 && states.every((s) => s === 'up')) break;
      await new Promise((r) => setTimeout(r, 2000));
    }
    expect(states).toEqual(['up', 'up']);
    const o = await deviceStatusOverview(c.s);
    expect(o.managed.managed).toBe(true);
  }, 60_000);

  it('deletes a monitor when its device is removed', async () => {
    const dev = (await listDeviceInventory(c.s)).find((d) => d.name === 'Kuma itself')!;
    await removeDevice(c.s, dev.id);
    expect(await syncDeviceInventory(c.s, client)).toMatchObject({ deleted: 1, errors: 0 });
    expect((await status()).map((m) => m.name)).toEqual(['Loopback ping (renamed)']);
  });

  it('puts a monitor back that someone deleted in Kuma', async () => {
    const monitors = await client.listMonitors();
    const id = [...monitors.values()].find((m) => m.name === 'Loopback ping (renamed)')!.id;
    await client.deleteMonitor(id);
    const fresh = await KumaClient.connect(url!);
    await fresh.login('voxshift', password);
    expect(await syncDeviceInventory(c.s, fresh)).toMatchObject({ created: 1, errors: 0 });
    fresh.close();
    expect((await status()).map((m) => m.name)).toEqual(['Loopback ping (renamed)']);
  });
});
