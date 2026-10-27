// Customer isolation for Monitoring. There is ONE monitoring service per installation, shared by every customer on it, so what keeps customers apart is
// (1) each customer's own status page (named from its id), which its dashboard reads and its sync writes, (2) each customer only ever touching the monitors
// it made, and (3) a customer not being able to point itself at another customer's page. Run against a fake service that, like the real one, has one set of
// monitors and one status page per address.
import { beforeAll, describe, expect, it } from 'vitest';
import { addDevice, deviceStatusOverview, deviceSyncDue, enableManagedKuma, listDeviceInventory, pollDeviceStatus, removeDevice, syncDeviceInventory, saveDeviceMonitorSettings, tenantDb, type KumaApi, type KumaMonitorInfo } from '@tvmf/db';
import { KUMA_LEGACY_SLUG, kumaSlugForTenant } from '@tvmf/shared';
import { AuditService } from '../../../../apps/api/src/common/audit.service';
import { DeviceStatusService } from '../../../../apps/api/src/modules/device-status/device-status.service';
import { seedCustomer, seedSite, seedUser, useDb, type TestCustomer } from '../helpers';

const handle = useDb();
let a: TestCustomer;
let b: TestCustomer;

/** One shared service: every customer's sync talks to this same object. */
class SharedKuma implements KumaApi {
  monitors = new Map<number, KumaMonitorInfo>();
  pages = new Map<string, Array<{ name: string; monitorIds: number[] }>>();
  tags = new Map<string, number>();
  nextId = 1;
  nextTag = 1;
  async listMonitors() { return new Map(this.monitors); }
  async ensureTag(name: string) { if (!this.tags.has(name)) this.tags.set(name, this.nextTag++); return this.tags.get(name)!; }
  async addMonitor(p: Record<string, unknown>) { const id = this.nextId++; this.monitors.set(id, { id, name: p.name as string, type: p.type as string, hostname: p.hostname as string, port: null, tags: [] }); return id; }
  async editMonitor(cur: KumaMonitorInfo, f: Record<string, unknown>) { this.monitors.set(cur.id, { ...cur, ...f } as KumaMonitorInfo); }
  async deleteMonitor(id: number) { this.monitors.delete(id); }
  async addMonitorTag(tagId: number, monitorId: number, value: string) {
    const name = [...this.tags].find(([, v]) => v === tagId)![0];
    const m = this.monitors.get(monitorId)!; m.tags = [...(m.tags ?? []), { tag_id: tagId, name, value }];
  }
  async deleteMonitorTag(tagId: number, monitorId: number, value: string) { const m = this.monitors.get(monitorId)!; m.tags = (m.tags ?? []).filter((t) => !(t.tag_id === tagId && t.value === value)); }
  async saveStatusPage(slug: string, _title: string, groups: Array<{ name: string; monitorIds: number[] }>) { this.pages.set(slug, groups); }
  namesOn(slug: string) { return (this.pages.get(slug) ?? []).flatMap((g) => g.monitorIds).map((id) => this.monitors.get(id)?.name).sort(); }
}
const kuma = new SharedKuma();

const dev = (name: string, address: string) => ({ siteCode: 'LTN01', name, kind: 'algo', checkType: 'ping', address, port: null }) as const;

beforeAll(async () => {
  a = await seedCustomer(handle, { name: 'Alpha' });
  b = await seedCustomer(handle, { name: 'Bravo' });
  for (const c of [a, b]) await seedSite(c.s, { sitecode: 'LTN01', name: 'Luton' });
  await enableManagedKuma(a.s, { tenantId: a.t.id });
  await enableManagedKuma(b.s, { tenantId: b.t.id });
});

describe('each customer has its own status page', () => {
  it('is named from the customer, differs between customers, and is what each customer reads', async () => {
    const oa = await deviceStatusOverview(a.s);
    const ob = await deviceStatusOverview(b.s);
    expect(oa.settings.statusSlug).toBe(kumaSlugForTenant(a.t.id));
    expect(ob.settings.statusSlug).toBe(kumaSlugForTenant(b.t.id));
    expect(oa.settings.statusSlug).not.toBe(ob.settings.statusSlug);
  });

  it('puts only a customer\'s own devices on its page, whatever order the two sync in', async () => {
    await addDevice(a.s, dev('Alpha door', '10.1.1.1'));
    await addDevice(a.s, dev('Alpha DECT', '10.1.1.2'));
    await addDevice(b.s, dev('Bravo gateway', '10.2.2.1'));
    await syncDeviceInventory(b.s, kuma);
    await syncDeviceInventory(a.s, kuma);
    await syncDeviceInventory(b.s, kuma);
    expect(kuma.namesOn(kumaSlugForTenant(a.t.id))).toEqual(['Alpha DECT', 'Alpha door']);
    expect(kuma.namesOn(kumaSlugForTenant(b.t.id))).toEqual(['Bravo gateway']);
    // and the service really holds all three monitors, so the separation is the pages, not the data being absent
    expect(kuma.monitors.size).toBe(3);
  });

  it('never shows one customer another\'s watch list', async () => {
    expect((await deviceStatusOverview(a.s)).inventory.map((d) => d.name).sort()).toEqual(['Alpha DECT', 'Alpha door']);
    expect((await deviceStatusOverview(b.s)).inventory.map((d) => d.name)).toEqual(['Bravo gateway']);
  });

  it('removing a device only ever deletes that customer\'s own monitor', async () => {
    const door = (await listDeviceInventory(a.s)).find((d) => d.name === 'Alpha door')!;
    await removeDevice(a.s, door.id);
    await syncDeviceInventory(a.s, kuma);
    expect(kuma.namesOn(kumaSlugForTenant(a.t.id))).toEqual(['Alpha DECT']);
    expect(kuma.namesOn(kumaSlugForTenant(b.t.id))).toEqual(['Bravo gateway']);
    expect([...kuma.monitors.values()].map((m) => m.name).sort()).toEqual(['Alpha DECT', 'Bravo gateway']);
  });
});

describe('what a customer reads from the service', () => {
  it('is only its own page', async () => {
    const served = new Map<string, unknown>();
    const pageJson = (slug: string) => ({ publicGroupList: (kuma.pages.get(slug) ?? []).map((g) => ({ name: g.name, monitorList: g.monitorIds.map((id) => ({ id, name: kuma.monitors.get(id)?.name ?? '', type: 'ping', tags: [] })) })) });
    const fetchFn = (async (url: string) => {
      served.set(url, true);
      const m = url.match(/status-page\/(heartbeat\/)?([^/?]+)$/);
      const slug = m![2]!;
      return new Response(JSON.stringify(m![1] ? { heartbeatList: {}, uptimeList: {} } : pageJson(slug)), { status: 200 });
    }) as unknown as typeof fetch;
    expect(await pollDeviceStatus(a.s, { fetchFn })).toBe('ok');
    expect([...served.keys()].every((u) => u.includes(kumaSlugForTenant(a.t.id)))).toBe(true);
    expect([...served.keys()].some((u) => u.includes(kumaSlugForTenant(b.t.id)))).toBe(false);
    expect((await deviceStatusOverview(a.s)).devices.map((d) => d.name)).toEqual(['Alpha DECT']);
    expect(await pollDeviceStatus(b.s, { fetchFn })).toBe('ok');
    expect((await deviceStatusOverview(b.s)).devices.map((d) => d.name)).toEqual(['Bravo gateway']);
  });
});

describe('customers still on the one page earlier releases shared', () => {
  it('move to their own page on the next look, keep their monitors, and drop what was read from the shared one', async () => {
    const c = await seedCustomer(handle, { name: 'Legacy' });
    await seedSite(c.s, { sitecode: 'LTN01', name: 'Luton' });
    await enableManagedKuma(c.s, { tenantId: c.t.id });
    const d = await addDevice(c.s, dev('Legacy phone', '10.3.3.3'));
    await syncDeviceInventory(c.s, kuma);
    const monitorId = (await c.s.selectFrom('device_inventory').select('kuma_monitor_id').where('id', '=', d.id).executeTakeFirstOrThrow()).kuma_monitor_id;
    expect(monitorId).not.toBeNull();
    // as an earlier release left it: the shared page name, with devices read from it
    await c.s.updateTable('device_monitor_settings').set({ status_slug: KUMA_LEGACY_SLUG, sync_needed: false, last_sync_at: new Date().toISOString() }).execute();
    await c.s.insertInto('device_monitors').values({ kuma_id: 77, name: 'Someone else\'s device', sitecode: 'LTN01', device_kind: 'algo', state: 'up', since: new Date().toISOString() } as never).execute();

    const due = await deviceSyncDue(c.s, new Date(), c.t.id);
    expect(due).not.toBeNull(); // asked for at once
    const s = await c.s.selectFrom('device_monitor_settings').select(['status_slug', 'sync_needed']).executeTakeFirstOrThrow();
    expect(s).toMatchObject({ status_slug: kumaSlugForTenant(c.t.id), sync_needed: true });
    expect((await c.s.selectFrom('device_monitors').selectAll().execute())).toEqual([]);
    expect((await c.s.selectFrom('device_inventory').select('kuma_monitor_id').where('id', '=', d.id).executeTakeFirstOrThrow()).kuma_monitor_id).toBe(monitorId);

    await syncDeviceInventory(c.s, kuma);
    expect(kuma.namesOn(kumaSlugForTenant(c.t.id))).toEqual(['Legacy phone']);
    // same monitor, not a copy
    expect([...kuma.monitors.values()].filter((m) => m.name === 'Legacy phone')).toHaveLength(1);
  });

  it('setting monitoring up again on the same service does not make new monitors', async () => {
    const c = await seedCustomer(handle, { name: 'Again' });
    await seedSite(c.s, { sitecode: 'LTN01', name: 'Luton' });
    await enableManagedKuma(c.s, { tenantId: c.t.id });
    const d = await addDevice(c.s, dev('Again phone', '10.4.4.4'));
    await syncDeviceInventory(c.s, kuma);
    await c.s.updateTable('device_monitor_settings').set({ status_slug: KUMA_LEGACY_SLUG }).execute();
    const before = kuma.monitors.size;
    await enableManagedKuma(c.s, { tenantId: c.t.id });
    await syncDeviceInventory(c.s, kuma);
    expect(kuma.monitors.size).toBe(before);
    expect((await c.s.selectFrom('device_inventory').select('sync_state').where('id', '=', d.id).executeTakeFirstOrThrow()).sync_state).toBe('synced');
  });
});

describe('a customer cannot point itself at another customer\'s page', () => {
  it('refuses it, and allows its own page and any ordinary name', async () => {
    const svc = new DeviceStatusService(handle.db, new AuditService(handle.db), { enqueue: async () => ({ id: null }) } as never);
    const eng = await seedUser(handle, 'ENGINEER');
    const base = { enabled: true, kumaUrl: 'http://monitoring:3001' };
    await expect(svc.saveSettings(a.t, eng, { ...base, statusSlug: kumaSlugForTenant(b.t.id) })).rejects.toThrow(/belongs to another customer/);
    await expect(svc.saveSettings(a.t, eng, { ...base, statusSlug: kumaSlugForTenant(a.t.id) })).resolves.toBeTruthy();
    await expect(svc.saveSettings(a.t, eng, { ...base, statusSlug: 'my-own-page' })).resolves.toBeTruthy();
    // the refusal changed nothing
    expect(tenantDb(handle.db, b.t.schema)).toBeTruthy();
    expect((await deviceStatusOverview(b.s)).settings.statusSlug).toBe(kumaSlugForTenant(b.t.id));
  });
  it('the same refusal holds for a customer\'s own Set up automatically: it always gets its own page', async () => {
    const svc = new DeviceStatusService(handle.db, new AuditService(handle.db), { enqueue: async () => ({ id: null }) } as never);
    const eng = await seedUser(handle, 'ENGINEER');
    const o = await svc.autoSetup(b.t, eng, {});
    expect(o.settings.statusSlug).toBe(kumaSlugForTenant(b.t.id));
    await saveDeviceMonitorSettings(b.s, { enabled: true, kumaUrl: 'http://monitoring:3001', statusSlug: kumaSlugForTenant(b.t.id) });
  });
});
