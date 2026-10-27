import { describe, expect, it } from 'vitest';
import { deviceMonitorSettingsSchema, kumaTime, parseKumaStatus, readDeviceTags, summariseBySite } from './device-status';

// Shapes recorded from Uptime Kuma 2.5.7 (/api/status-page/<slug> and /api/status-page/heartbeat/<slug>), trimmed.
const page = {
  config: { slug: 'voxshift', showTags: true },
  incidents: [],
  publicGroupList: [
    {
      id: 1,
      name: 'Teams voice equipment',
      monitorList: [
        { id: 2, name: 'ping gateway 10.100.20.1', sendUrl: 0, type: 'ping', tags: [{ id: 1, monitor_id: 2, tag_id: 1, name: 'site', value: 'LTN01', color: '#4657D2' }, { name: 'device', value: 'Algo', color: '#000' }] },
        { id: 1, name: 'door paging', sendUrl: 0, type: 'ping', tags: [{ name: 'site', value: 'LTN01' }] },
        { id: 3, name: 'reception phone', sendUrl: 0, type: 'port', tags: [] },
      ],
    },
  ],
  maintenanceList: [],
};
const heartbeats = {
  heartbeatList: {
    '1': [
      { status: 1, time: '2026-10-27 06:10:48.574', msg: '', ping: 0.07 },
      { status: 0, time: '2026-10-27 06:11:08.577', msg: 'timeout', ping: null },
      { status: 0, time: '2026-10-27 06:11:28.577', msg: 'timeout', ping: null },
    ],
    '2': [
      { status: 1, time: '2026-10-27 06:10:49.039', msg: '', ping: 0.3 },
      { status: 1, time: '2026-10-27 06:11:09.039', msg: '', ping: 0.35 },
    ],
  },
  uptimeList: { '1_24': 0.69, '2_24': 0.9 },
};

describe('parseKumaStatus', () => {
  const monitors = parseKumaStatus(page, heartbeats);
  const by = (id: number) => monitors.find((m) => m.kumaId === id)!;

  it('reads state, response time, tags and uptime per monitor', () => {
    expect(by(2)).toMatchObject({ state: 'up', responseMs: 0.35, sitecode: 'LTN01', deviceKind: 'algo', group: 'Teams voice equipment', uptime24h: 0.9, monitorType: 'ping' });
    expect(by(1)).toMatchObject({ state: 'down', message: 'timeout', sitecode: 'LTN01', deviceKind: 'other' });
  });

  it('dates a change from the first beat in the new state, in UTC', () => {
    expect(by(1)).toMatchObject({ since: '2026-10-27T06:11:08.577Z', sinceExact: true });
  });

  it('says so when the whole window is one state (it has been that way at least that long)', () => {
    expect(by(2)).toMatchObject({ since: '2026-10-27T06:10:49.039Z', sinceExact: false });
  });

  it('shows a monitor with no beats as unknown, with no site', () => {
    expect(by(3)).toMatchObject({ state: 'unknown', since: null, sitecode: null, lastBeatAt: null });
  });

  it('maps pending and maintenance', () => {
    const m = parseKumaStatus(page, { heartbeatList: { '1': [{ status: 2, time: '2026-10-27 06:00:00', ping: null }], '2': [{ status: 3, time: '2026-10-27 06:00:00' }] } });
    expect(m.find((x) => x.kumaId === 1)!.state).toBe('pending');
    expect(m.find((x) => x.kumaId === 2)!.state).toBe('maintenance');
  });

  it('refuses something that is not a status page', () => {
    expect(() => parseKumaStatus({ hello: 'world' }, heartbeats)).toThrow(/monitoring status page/);
    expect(() => parseKumaStatus('<html>', heartbeats)).toThrow(/monitoring status page/);
  });
});

describe('tags', () => {
  it('reads name+value and single-tag spellings, and ignores unknown device kinds', () => {
    expect(readDeviceTags([{ name: 'site', value: ' LTN01 ' }, { name: 'device', value: 'Teams Room' }])).toEqual({ sitecode: 'LTN01', deviceKind: 'teams-room' });
    expect(readDeviceTags([{ name: 'site=LTN02' }, { name: 'device:DECT' }])).toEqual({ sitecode: 'LTN02', deviceKind: 'dect' });
    expect(readDeviceTags([{ name: 'device', value: 'toaster' }])).toEqual({ sitecode: null, deviceKind: 'other' });
  });
});

describe('kumaTime', () => {
  it('treats Kuma time as UTC', () => {
    expect(kumaTime('2026-10-27 06:25:48.595')).toBe('2026-10-27T06:25:48.595Z');
    expect(kumaTime('2026-10-27T06:25:48Z')).toBe('2026-10-27T06:25:48.000Z');
    expect(kumaTime('nonsense')).toBeNull();
  });
});

describe('summariseBySite', () => {
  it('colours a site by its worst device, worst sites first, unassigned last', () => {
    const s = summariseBySite([
      { sitecode: 'A', state: 'up' },
      { sitecode: 'B', state: 'up' },
      { sitecode: 'B', state: 'down' },
      { sitecode: null, state: 'down' },
      { sitecode: 'C', state: 'maintenance' },
      { sitecode: 'C', state: 'up' },
    ]);
    expect(s.map((x) => [x.sitecode, x.state])).toEqual([['B', 'down'], ['C', 'maintenance'], ['A', 'up'], [null, 'down']]);
    expect(s[0]!.counts).toMatchObject({ up: 1, down: 1 });
  });
});

describe('settings', () => {
  it('accepts a bare address and a slug, and refuses paths', () => {
    expect(deviceMonitorSettingsSchema.parse({ enabled: true, kumaUrl: 'http://kuma:3001/', statusSlug: 'voxshift' })).toEqual({ enabled: true, kumaUrl: 'http://kuma:3001', statusSlug: 'voxshift' });
    expect(deviceMonitorSettingsSchema.safeParse({ enabled: true, kumaUrl: 'http://kuma:3001/dashboard', statusSlug: 'x' }).success).toBe(false);
    expect(deviceMonitorSettingsSchema.safeParse({ enabled: true, kumaUrl: 'ftp://kuma', statusSlug: 'x' }).success).toBe(false);
    expect(deviceMonitorSettingsSchema.safeParse({ enabled: true, kumaUrl: 'http://kuma', statusSlug: '../x' }).success).toBe(false);
  });
});
