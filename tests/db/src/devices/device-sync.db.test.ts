// Device inventory and the sync that keeps Kuma in step with it (migration 0071), against a fake Kuma.
import { beforeAll, describe, expect, it } from 'vitest';
import { addDevice, canonicalSiteCode, deviceStatusOverview, deviceSyncDue, disableManagedKuma, enableManagedKuma, listDeviceInventory, recordDeviceSync, removeDevice, syncDeviceInventory, updateDevice, type KumaApi, type KumaMonitorInfo } from '@tvmf/db';
import { seedCustomer, seedSite, useDb, type TestCustomer } from '../helpers';

const handle = useDb();
let c: TestCustomer;

class FakeKuma implements KumaApi {
  monitors = new Map<number, KumaMonitorInfo>();
  tags = new Map<string, number>();
  nextId = 1;
  nextTag = 1;
  calls: string[] = [];
  page: { slug: string; title: string; groups: Array<{ name: string; monitorIds: number[] }> } | null = null;
  failAddFor: string | null = null;
  async listMonitors() { return new Map(this.monitors); }
  async ensureTag(name: string) { if (!this.tags.has(name)) this.tags.set(name, this.nextTag++); return this.tags.get(name)!; }
  async addMonitor(p: Record<string, unknown>) {
    if (p.name === this.failAddFor) throw new Error('Kuma refused this monitor');
    const id = this.nextId++; this.calls.push(`add ${p.name}`);
    this.monitors.set(id, { id, name: p.name as string, type: p.type as string, hostname: p.hostname as string, port: (p.port as number | null) ?? null, tags: [] }); return id;
  }
  async editMonitor(cur: KumaMonitorInfo, f: Record<string, unknown>) { this.calls.push(`edit ${cur.id}`); this.monitors.set(cur.id, { ...cur, ...f } as KumaMonitorInfo); }
  async deleteMonitor(id: number) { this.calls.push(`delete ${id}`); this.monitors.delete(id); }
  async addMonitorTag(tagId: number, monitorId: number, value: string) {
    const name = [...this.tags].find(([, v]) => v === tagId)![0]; this.calls.push(`tag+ ${monitorId} ${name}=${value}`);
    const m = this.monitors.get(monitorId)!; m.tags = [...(m.tags ?? []), { tag_id: tagId, name, value }];
  }
  async deleteMonitorTag(tagId: number, monitorId: number, value: string) {
    this.calls.push(`tag- ${monitorId} ${tagId}=${value}`);
    const m = this.monitors.get(monitorId)!; m.tags = (m.tags ?? []).filter((t) => !(t.tag_id === tagId && t.value === value));
  }
  async saveStatusPage(slug: string, title: string, groups: Array<{ name: string; monitorIds: number[] }>) { this.page = { slug, title, groups }; }
  idOf(name: string) { return [...this.monitors.values()].find((m) => m.name === name)!.id; }
  tagsOf(id: number) { return (this.monitors.get(id)?.tags ?? []).map((t) => `${t.name}=${t.value}`).sort(); }
}

const door = { siteCode: 'LTN01', name: 'Door paging', kind: 'algo', checkType: 'ping', address: '10.1.2.3', port: null } as const;
const dect = { siteCode: 'LTN01', name: 'DECT base', kind: 'dect', checkType: 'port', address: '10.1.2.4', port: 5060 } as const;
let kuma: FakeKuma;

beforeAll(async () => {
  c = await seedCustomer(handle);
  await seedSite(c.s, { sitecode: 'LTN01', name: 'Luton' });
  await seedSite(c.s, { sitecode: 'MAN02', name: 'Manchester' });
});

describe('inventory', () => {
  it('adds devices, lists them in order, and asks for a sync once Voxshift looks after Kuma', async () => {
    await enableManagedKuma(c.s, {});
    kuma = new FakeKuma();
    await addDevice(c.s, dect);
    const d = await addDevice(c.s, door);
    expect((await listDeviceInventory(c.s)).map((x) => x.name)).toEqual(['DECT base', 'Door paging']);
    expect(d).toMatchObject({ syncState: 'pending', siteCode: 'LTN01', port: null });
    const o = await deviceStatusOverview(c.s);
    expect(o.managed).toMatchObject({ managed: true, syncNeeded: true, hasCredentials: false });
    expect(o.settings).toMatchObject({ enabled: true, kumaUrl: 'http://kuma:3001', statusSlug: 'voxshift' });
    expect(o.inventory).toHaveLength(2);
  });
  it('matches a site code written in any case, or none', async () => {
    expect(await canonicalSiteCode(c.s, 'ltn01')).toBe('LTN01');
    expect(await canonicalSiteCode(c.s, 'NOPE')).toBeNull();
  });
});

describe('syncDeviceInventory', () => {
  it('makes a monitor per device, tags it, and puts the devices on the status page by site', async () => {
    const r = await syncDeviceInventory(c.s, kuma);
    expect(r).toEqual({ created: 2, updated: 0, deleted: 0, errors: 0 });
    const inv = await listDeviceInventory(c.s);
    expect(inv.every((x) => x.syncState === 'synced' && x.syncError === null)).toBe(true);
    const doorId = [...kuma.monitors.values()].find((m) => m.name === 'Door paging')!.id;
    expect(kuma.tagsOf(doorId)).toEqual(['device=algo', 'site=LTN01']);
    expect(kuma.monitors.get(doorId)).toMatchObject({ type: 'ping', hostname: '10.1.2.3' });
    expect([...kuma.monitors.values()].find((m) => m.name === 'DECT base')).toMatchObject({ type: 'port', port: 5060 });
    expect(kuma.page).toMatchObject({ slug: 'voxshift', groups: [{ name: 'LTN01 · Luton', monitorIds: expect.arrayContaining([1, 2]) }] });
    await recordDeviceSync(c.s, {});
    expect((await deviceStatusOverview(c.s)).managed).toMatchObject({ syncNeeded: false, lastSyncError: null });
  });

  it('does nothing when nothing changed', async () => {
    kuma.calls = [];
    expect(await syncDeviceInventory(c.s, kuma)).toEqual({ created: 0, updated: 0, deleted: 0, errors: 0 });
    expect(kuma.calls).toEqual([]);
  });

  it('edits a monitor and its tags when the device changes', async () => {
    const dev = (await listDeviceInventory(c.s)).find((x) => x.name === 'Door paging')!;
    await updateDevice(c.s, dev.id, { ...door, siteCode: 'MAN02', address: '10.9.9.9' });
    kuma.calls = [];
    expect(await syncDeviceInventory(c.s, kuma)).toMatchObject({ updated: 1, created: 0 });
    expect(kuma.monitors.get(kuma.idOf('Door paging'))).toMatchObject({ hostname: '10.9.9.9' });
    expect(kuma.tagsOf(kuma.idOf('Door paging'))).toEqual(['device=algo', 'site=MAN02']);
    expect(kuma.page!.groups.map((g) => g.name)).toEqual(['LTN01 · Luton', 'MAN02 · Manchester']);
  });

  it('makes a monitor again when someone deleted it in Kuma', async () => {
    kuma.monitors.delete(kuma.idOf('DECT base'));
    const r = await syncDeviceInventory(c.s, kuma);
    expect(r.created).toBe(1);
    const dect = (await listDeviceInventory(c.s)).find((x) => x.name === 'DECT base')!;
    expect(dect.syncState).toBe('synced');
    expect(kuma.monitors.size).toBe(2);
  });

  it('leaves tags and monitors that a person added in Kuma alone', async () => {
    kuma.monitors.set(50, { id: 50, name: 'Hand made', type: 'http', tags: [{ tag_id: 99, name: 'owner', value: 'ops' }] });
    kuma.monitors.get(kuma.idOf('Door paging'))!.tags!.push({ tag_id: 98, name: 'owner', value: 'ops' });
    await syncDeviceInventory(c.s, kuma);
    expect(kuma.monitors.has(50)).toBe(true);
    expect(kuma.tagsOf(kuma.idOf('Door paging'))).toContain('owner=ops');
    expect(kuma.page!.groups.flatMap((g) => g.monitorIds)).not.toContain(50);
    kuma.monitors.delete(50);
  });

  it('records a device Kuma refuses, carries on with the rest, and asks for another try', async () => {
    await addDevice(c.s, { ...door, name: 'Broken one', address: '10.5.5.5' });
    await addDevice(c.s, { ...door, name: 'Fine one', address: '10.6.6.6' });
    kuma.failAddFor = 'Broken one';
    const r = await syncDeviceInventory(c.s, kuma);
    expect(r).toMatchObject({ created: 1, errors: 1 });
    const inv = await listDeviceInventory(c.s);
    expect(inv.find((x) => x.name === 'Broken one')).toMatchObject({ syncState: 'error', syncError: 'Kuma refused this monitor' });
    expect(inv.find((x) => x.name === 'Fine one')!.syncState).toBe('synced');
    await recordDeviceSync(c.s, { deviceErrors: r.errors });
    expect((await deviceStatusOverview(c.s)).managed).toMatchObject({ syncNeeded: true, lastSyncError: expect.stringContaining('1 device could not be set up') });
    kuma.failAddFor = null;
    expect(await syncDeviceInventory(c.s, kuma)).toMatchObject({ created: 1, errors: 0 });
    expect((await listDeviceInventory(c.s)).every((x) => x.syncState === 'synced')).toBe(true);
    await recordDeviceSync(c.s, {});
  });

  it('deletes the monitor and then the row when a device is removed; a never-synced one goes at once', async () => {
    const dect = (await listDeviceInventory(c.s)).find((x) => x.name === 'DECT base')!;
    expect(await removeDevice(c.s, dect.id)).toBe(true);
    expect((await listDeviceInventory(c.s)).some((x) => x.name === 'DECT base')).toBe(false);
    expect((await c.s.selectFrom('device_inventory').selectAll().where('id', '=', dect.id).executeTakeFirst())?.removed).toBe(true);
    const before = kuma.monitors.size;
    expect(await syncDeviceInventory(c.s, kuma)).toMatchObject({ deleted: 1 });
    expect(kuma.monitors.size).toBe(before - 1);
    expect(await c.s.selectFrom('device_inventory').selectAll().where('id', '=', dect.id).executeTakeFirst()).toBeUndefined();
    const fresh = await addDevice(c.s, { ...door, name: 'Never synced', address: '10.7.7.7' });
    expect(await removeDevice(c.s, fresh.id)).toBe(true);
    expect(await c.s.selectFrom('device_inventory').selectAll().where('id', '=', fresh.id).executeTakeFirst()).toBeUndefined();
    expect(await removeDevice(c.s, fresh.id)).toBe(false);
  });
});

describe('when a sync is due', () => {
  const at = (ms: number) => new Date(Date.parse('2026-10-27T12:00:00Z') + ms);
  it('is not due when Voxshift does not look after Kuma, or it is switched off', async () => {
    await disableManagedKuma(c.s);
    expect(await deviceSyncDue(c.s, at(0))).toBeNull();
    await enableManagedKuma(c.s, {});
  });
  it('is due at once for a change, after a minute for a failure, and hourly otherwise', async () => {
    await c.s.updateTable('device_monitor_settings').set({ sync_needed: true, last_sync_at: at(0).toISOString(), last_sync_error: null }).execute();
    expect(await deviceSyncDue(c.s, at(1000))).toMatchObject({ url: 'http://kuma:3001' });
    await c.s.updateTable('device_monitor_settings').set({ last_sync_error: 'down' }).execute();
    expect(await deviceSyncDue(c.s, at(30_000))).toBeNull();
    expect(await deviceSyncDue(c.s, at(61_000))).not.toBeNull();
    await c.s.updateTable('device_monitor_settings').set({ sync_needed: false, last_sync_error: null }).execute();
    expect(await deviceSyncDue(c.s, at(1_800_000))).toBeNull();
    expect(await deviceSyncDue(c.s, at(3_700_000))).not.toBeNull();
  });
  it('changing the Kuma address makes devices new again and drops what was removed', async () => {
    await enableManagedKuma(c.s, { kumaUrl: 'http://other:3001' });
    expect((await listDeviceInventory(c.s)).every((x) => x.syncState === 'pending')).toBe(true);
    expect((await c.s.selectFrom('device_inventory').select('kuma_monitor_id').execute()).every((x) => x.kuma_monitor_id === null)).toBe(true);
  });
});
