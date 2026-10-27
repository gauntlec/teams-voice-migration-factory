// SNMP checks in the device inventory (migration 0073) and their sync into Kuma, against a fake Kuma: what is stored, what is kept secret, what Kuma is sent.
import { beforeAll, describe, expect, it } from 'vitest';
import { addDevice, deviceHasCommunity, enableManagedKuma, listDeviceInventory, removeDevice, syncDeviceInventory, updateDevice, type KumaApi, type KumaMonitorInfo } from '@tvmf/db';
import { seedCustomer, seedSite, useDb, type TestCustomer } from '../helpers';

const handle = useDb();
let c: TestCustomer;

// A stand-in for the API's encryptSecret / the worker's decryptSecret.
const encrypt = (p: string) => `enc:${[...p].reverse().join('')}`;
const decrypt = (e: string) => [...e.replace(/^enc:/, '')].reverse().join('');

class FakeKuma implements KumaApi {
  monitors = new Map<number, KumaMonitorInfo>();
  sent: Array<Record<string, unknown>> = [];
  calls: string[] = [];
  nextId = 1;
  async listMonitors() { return new Map(this.monitors); }
  async ensureTag() { return 1; }
  async addMonitor(p: Record<string, unknown>) {
    const id = this.nextId++;
    this.calls.push(`add ${p.name}`);
    this.sent.push(p);
    this.monitors.set(id, { id, tags: [], ...p } as KumaMonitorInfo);
    return id;
  }
  async editMonitor(cur: KumaMonitorInfo, f: Record<string, unknown>) { this.calls.push(`edit ${cur.id}`); this.sent.push(f); this.monitors.set(cur.id, { ...cur, ...f } as KumaMonitorInfo); }
  async deleteMonitor(id: number) { this.calls.push(`delete ${id}`); this.monitors.delete(id); }
  async addMonitorTag() {}
  async deleteMonitorTag() {}
  async saveStatusPage() {}
}

const algo = {
  siteCode: 'LTN01', name: 'Algo 8180', kind: 'algo', checkType: 'snmp', address: '10.1.2.3', port: 161,
  snmpVersion: '2c', snmpCommunity: 'hunter2', snmpUsername: null, snmpOid: '1.3.6.1.4.1.41738.1.1.2.1.1.0', snmpOperator: 'contains', snmpExpected: 'Registered',
} as const;

beforeAll(async () => {
  c = await seedCustomer(handle);
  await seedSite(c.s, { sitecode: 'LTN01', name: 'Luton' });
  await enableManagedKuma(c.s, { tenantId: c.t.id });
});

describe('SNMP devices', () => {
  const kuma = new FakeKuma();

  it('stores the community string encrypted and never lists it', async () => {
    const row = await addDevice(c.s, algo, encrypt);
    expect(row.snmp).toEqual({ version: '2c', username: null, oid: algo.snmpOid, operator: 'contains', expected: 'Registered', hasCommunity: true });
    expect(JSON.stringify(await listDeviceInventory(c.s))).not.toMatch(/hunter2|enc:/);
    const raw = await c.s.selectFrom('device_inventory').select('snmp_community_enc').executeTakeFirstOrThrow();
    expect(raw.snmp_community_enc).toBe(encrypt('hunter2'));
    expect(await deviceHasCommunity(c.s, row.id)).toBe(true);
  });

  it('sends Kuma the readable community in its own field names, and nothing is edited on a second sync', async () => {
    expect(await syncDeviceInventory(c.s, kuma, { decrypt })).toMatchObject({ created: 1, errors: 0 });
    expect(kuma.sent[0]).toMatchObject({
      type: 'snmp', hostname: '10.1.2.3', port: 161, snmpVersion: '2c', radiusPassword: 'hunter2', snmpOid: algo.snmpOid, jsonPath: '$', jsonPathOperator: 'contains', expectedValue: 'Registered', timeout: 5,
    });
    expect(await syncDeviceInventory(c.s, kuma, { decrypt })).toEqual({ created: 0, updated: 0, deleted: 0, errors: 0 });
  });

  it('edits the monitor when the comparison changes, and keeps the community when a change leaves it blank', async () => {
    const dev = (await listDeviceInventory(c.s))[0]!;
    await updateDevice(c.s, dev.id, { ...algo, snmpCommunity: null, snmpExpected: 'Registered OK' }, encrypt);
    expect(await syncDeviceInventory(c.s, kuma, { decrypt })).toMatchObject({ updated: 1, created: 0, errors: 0 });
    expect(kuma.sent.at(-1)).toMatchObject({ expectedValue: 'Registered OK', radiusPassword: 'hunter2' });
    await updateDevice(c.s, dev.id, { ...algo, snmpCommunity: 'newone' }, encrypt);
    await syncDeviceInventory(c.s, kuma, { decrypt });
    expect(kuma.sent.at(-1)).toMatchObject({ radiusPassword: 'newone' });
  });

  it('recreates an SNMPv3 monitor when the user name changes, because Kuma cannot edit it', async () => {
    const v3 = { ...algo, name: 'Algo v3', snmpVersion: '3', snmpCommunity: null, snmpUsername: 'monitor' } as const;
    const d = await addDevice(c.s, v3, encrypt);
    expect(d.snmp).toMatchObject({ version: '3', username: 'monitor', hasCommunity: false });
    await syncDeviceInventory(c.s, kuma, { decrypt });
    expect(kuma.sent.at(-1)).toMatchObject({ snmpVersion: '3', snmpV3Username: 'monitor', radiusPassword: '' });
    kuma.calls.length = 0;
    await updateDevice(c.s, d.id, { ...v3, snmpUsername: 'other' }, encrypt);
    expect(await syncDeviceInventory(c.s, kuma, { decrypt })).toMatchObject({ created: 1, deleted: 1, errors: 0 });
    expect(kuma.calls).toEqual(['delete 2', 'add Algo v3']);
    expect(kuma.sent.at(-1)).toMatchObject({ snmpV3Username: 'other' });
    expect(await syncDeviceInventory(c.s, kuma, { decrypt })).toEqual({ created: 0, updated: 0, deleted: 0, errors: 0 });
  });

  it('turns a device away from SNMP: the secret is dropped and the monitor becomes a ping', async () => {
    const dev = (await listDeviceInventory(c.s)).find((x) => x.name === 'Algo 8180')!;
    await updateDevice(c.s, dev.id, { siteCode: 'LTN01', name: 'Algo 8180', kind: 'algo', checkType: 'ping', address: '10.1.2.3', port: null }, encrypt);
    expect(await deviceHasCommunity(c.s, dev.id)).toBe(false);
    expect(await syncDeviceInventory(c.s, kuma, { decrypt })).toMatchObject({ updated: 1, errors: 0 });
    expect(kuma.monitors.get(1)).toMatchObject({ type: 'ping' });
  });

  it('says plainly when a v2c device has no community string, or the secret cannot be read', async () => {
    await c.s.updateTable('device_inventory').set({ snmp_community_enc: null }).where('name', '=', 'Algo v3').execute();
    const lost = await addDevice(c.s, { ...algo, name: 'No secret here' }, encrypt);
    await c.s.updateTable('device_inventory').set({ snmp_community_enc: null }).where('id', '=', lost.id).execute();
    const r = await syncDeviceInventory(c.s, kuma, { decrypt });
    expect(r.errors).toBe(1);
    const row = await c.s.selectFrom('device_inventory').select('sync_error').where('id', '=', lost.id).executeTakeFirstOrThrow();
    expect(row.sync_error).toMatch(/no community string/);
    await removeDevice(c.s, lost.id);
  });
});
