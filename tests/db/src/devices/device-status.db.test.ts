// Device status: reading a Kuma status page into device_monitors and device_status_changes (migration 0070).
import { beforeAll, describe, expect, it } from 'vitest';
import { deviceMonitorSettings, deviceStatusOverview, pollDeviceStatus, saveDeviceMonitorSettings } from '@tvmf/db';
import { seedCustomer, seedSite, useDb, type TestCustomer } from '../helpers';

const handle = useDb();
let c: TestCustomer;

const page = {
  publicGroupList: [
    {
      name: 'Voice equipment',
      monitorList: [
        { id: 1, name: 'Door paging', type: 'ping', tags: [{ name: 'site', value: 'ltn01' }, { name: 'device', value: 'algo' }] },
        { id: 2, name: 'Reception DECT base', type: 'port', tags: [{ name: 'site', value: 'LTN01' }, { name: 'device', value: 'dect' }] },
        { id: 3, name: 'Mystery box', type: 'ping', tags: [] },
      ],
    },
  ],
};
const beat = (status: number, time: string) => ({ status, time, msg: status === 0 ? 'timeout' : '', ping: status === 1 ? 1.2 : null });
let heartbeats: Record<string, unknown> = {};
let calls = 0;
let failWith: (() => Response | Error) | null = null;
const fetchFn = (async (url: string) => {
  calls++;
  if (failWith) {
    const f = failWith();
    if (f instanceof Error) throw f;
    return f;
  }
  const body = url.includes('/heartbeat/') ? { heartbeatList: heartbeats, uptimeList: { '1_24': 0.99 } } : page;
  return new Response(JSON.stringify(body), { status: 200 });
}) as unknown as typeof fetch;

const T0 = new Date('2026-10-27T10:00:00Z');
const at = (min: number) => new Date(T0.getTime() + min * 60_000);

beforeAll(async () => {
  c = await seedCustomer(handle);
  await seedSite(c.s, { sitecode: 'LTN01', name: 'Luton' });
});

describe('pollDeviceStatus', () => {
  it('does nothing until it is switched on and set up', async () => {
    expect(await pollDeviceStatus(c.s, { fetchFn, now: at(0) })).toBe('skipped');
    expect(calls).toBe(0);
    await saveDeviceMonitorSettings(c.s, { enabled: true, kumaUrl: '', statusSlug: '' });
    expect((await deviceMonitorSettings(c.s)).enabled).toBe(false);
  });

  it('reads monitors and only records a first sighting that is not up', async () => {
    await saveDeviceMonitorSettings(c.s, { enabled: true, kumaUrl: 'http://kuma:3001', statusSlug: 'voxshift' });
    heartbeats = {
      '1': [beat(1, '2026-10-27 09:58:00'), beat(1, '2026-10-27 09:59:00')],
      '2': [beat(1, '2026-10-27 09:50:00'), beat(0, '2026-10-27 09:55:00'), beat(0, '2026-10-27 09:59:00')],
    };
    expect(await pollDeviceStatus(c.s, { fetchFn, now: at(0) })).toBe('ok');
    const o = await deviceStatusOverview(c.s, at(0));
    expect(o.stale).toBe(false);
    expect(o.devices.map((d) => [d.name, d.state, d.sitecode, d.deviceKind])).toEqual([
      ['Door paging', 'up', 'LTN01', 'algo'],
      ['Mystery box', 'unknown', null, 'other'],
      ['Reception DECT base', 'down', 'LTN01', 'dect'],
    ]);
    expect(o.devices.find((d) => d.kumaId === 2)).toMatchObject({ since: '2026-10-27T09:55:00.000Z', sinceExact: true, message: 'timeout' });
    expect(o.changes.map((x) => [x.name, x.from, x.to])).toEqual([['Reception DECT base', null, 'down']]);
    expect(o.sites[0]).toMatchObject({ sitecode: 'LTN01', name: 'Luton', known: true, state: 'down' });
    expect(o.sites.at(-1)).toMatchObject({ sitecode: null, state: 'unknown' });
  });

  it('keeps "since" while the state holds, and records a change when it moves', async () => {
    heartbeats['2'] = [beat(0, '2026-10-27 09:59:00'), beat(0, '2026-10-27 10:01:00')];
    await pollDeviceStatus(c.s, { fetchFn, now: at(2) });
    expect((await deviceStatusOverview(c.s, at(2))).devices.find((d) => d.kumaId === 2)!.since).toBe('2026-10-27T09:55:00.000Z');

    heartbeats['2'] = [beat(0, '2026-10-27 10:01:00'), beat(1, '2026-10-27 10:03:00')];
    heartbeats['1'] = [beat(1, '2026-10-27 10:02:00'), beat(0, '2026-10-27 10:03:00')];
    await pollDeviceStatus(c.s, { fetchFn, now: at(4) });
    const o = await deviceStatusOverview(c.s, at(4));
    expect(o.changes.slice(0, 2).map((x) => [x.name, x.from, x.to, x.at]).sort()).toEqual([
      ['Door paging', 'up', 'down', '2026-10-27T10:03:00.000Z'],
      ['Reception DECT base', 'down', 'up', '2026-10-27T10:03:00.000Z'],
    ]);
    expect(o.devices.find((d) => d.kumaId === 1)).toMatchObject({ state: 'down', since: '2026-10-27T10:03:00.000Z' });
  });

  it('keeps the last known states on a failed read, says why, and calls them stale after two minutes', async () => {
    failWith = () => new Response('nope', { status: 503 });
    expect(await pollDeviceStatus(c.s, { fetchFn, now: at(5) })).toBe('failed');
    failWith = () => new Error('connect ECONNREFUSED');
    expect(await pollDeviceStatus(c.s, { fetchFn, now: at(6) })).toBe('failed');
    const o = await deviceStatusOverview(c.s, at(7));
    expect(o.devices).toHaveLength(3);
    expect(o.settings.lastError).toBe('connect ECONNREFUSED');
    expect(o.stale).toBe(true);
    failWith = () => new Response('<html>', { status: 200 });
    await pollDeviceStatus(c.s, { fetchFn, now: at(8) });
    expect((await deviceMonitorSettings(c.s)).lastError).toMatch(/JSON/);
    failWith = () => new Response('', { status: 404 });
    await pollDeviceStatus(c.s, { fetchFn, now: at(8) });
    expect((await deviceMonitorSettings(c.s)).lastError).toMatch(/status page name/);
    failWith = null;
  });

  it('drops a monitor that has left the status page, and everything when the address changes', async () => {
    page.publicGroupList[0]!.monitorList.pop();
    await pollDeviceStatus(c.s, { fetchFn, now: at(9) });
    expect((await deviceStatusOverview(c.s, at(9))).devices.map((d) => d.kumaId)).toEqual([1, 2]);
    await saveDeviceMonitorSettings(c.s, { enabled: true, kumaUrl: 'http://other:3001', statusSlug: 'voxshift' });
    const o = await deviceStatusOverview(c.s, at(9));
    expect(o.devices).toEqual([]);
    expect(o.settings).toMatchObject({ lastOkAt: null, lastError: null });
  });
});
