import { describe, expect, it } from 'vitest';
import { DEFAULT_DEVICE_ALERT_SETTINGS, alertRecipientList, alertTime, buildDeviceAlertContext, deviceAlertSettingsSchema, parseRecipients, planDeviceAlert, type DeviceAlertChange, type DeviceAlertDown, type DeviceAlertSettings } from './device-alerts';

const T0 = new Date('2026-10-27T12:00:00Z');
const at = (min: number) => new Date(T0.getTime() + min * 60_000);
const settings = (o: Partial<DeviceAlertSettings> = {}): DeviceAlertSettings => ({ ...DEFAULT_DEVICE_ALERT_SETTINGS, enabled: true, ...o });
const change = (id: number, kumaId: number, from: DeviceAlertChange['from'], to: DeviceAlertChange['to'], min = 0): DeviceAlertChange => ({ id: String(id), kumaId, name: `dev${kumaId}`, sitecode: 'LTN01', deviceKind: 'algo', from, to, at: at(min).toISOString() });
const down = (kumaId: number, lastAlertedAt: Date | null): DeviceAlertDown => ({ kumaId, name: `dev${kumaId}`, sitecode: 'LTN01', deviceKind: 'algo', since: at(-300).toISOString(), lastAlertedAt: lastAlertedAt?.toISOString() ?? null });
const plan = (o: Partial<Parameters<typeof planDeviceAlert>[0]>) => planDeviceAlert({ settings: settings(), changes: [], downNow: [], lastSentAt: null, cursor: '0', now: T0, ...o });

describe('planDeviceAlert: what counts as news', () => {
  it('a device going down, and one coming back after being down, are news; checking and maintenance are not', () => {
    const p = plan({ changes: [change(1, 1, 'up', 'down'), change(2, 2, 'down', 'up'), change(3, 3, 'up', 'pending'), change(4, 4, 'pending', 'maintenance'), change(5, 5, null, 'up'), change(6, 6, 'unknown', 'up')] });
    expect(p.send).toBe(true);
    expect(p.wentDown.map((e) => e.kumaId)).toEqual([1]);
    expect(p.recovered.map((e) => e.kumaId)).toEqual([2]);
    expect(p.cursor).toBe('6');
  });
  it('a device first seen already down is news', () => {
    expect(plan({ changes: [change(1, 1, null, 'down')] }).wentDown).toHaveLength(1);
  });
  it('sends nothing when alerts are switched off, but still moves on', () => {
    const p = plan({ settings: settings({ enabled: false }), changes: [change(1, 1, 'up', 'down')] });
    expect(p.send).toBe(false);
  });
  it('sends nothing and moves on when there is only noise', () => {
    const p = plan({ changes: [change(7, 1, 'up', 'pending')] });
    expect(p).toMatchObject({ send: false, cursor: '7' });
  });
});

describe('planDeviceAlert: how often', () => {
  const news = [change(10, 1, 'up', 'down', 1)];
  it('straight away: sends at once, whatever was sent a moment ago', () => {
    expect(plan({ changes: news, lastSentAt: at(-0.1).toISOString() }).send).toBe(true);
  });
  it('a summary mode waits for its interval, keeps the news, and then sends one email with all of it', () => {
    const s = settings({ frequency: '1h' });
    const early = plan({ settings: s, changes: news, lastSentAt: at(-30).toISOString() });
    expect(early).toMatchObject({ send: false, cursor: '0' });
    const more = [...news, change(11, 2, 'up', 'down', 20), change(12, 1, 'down', 'up', 25)];
    const late = plan({ settings: s, changes: more, lastSentAt: at(-61).toISOString() });
    expect(late.send).toBe(true);
    expect(late.wentDown.map((e) => e.kumaId)).toEqual([1, 2]);
    expect(late.recovered.map((e) => e.kumaId)).toEqual([1]);
    expect(late.cursor).toBe('12');
  });
  it('the first email is never held back', () => {
    expect(plan({ settings: settings({ frequency: 'daily' }), changes: news, lastSentAt: null }).send).toBe(true);
  });
  it('every interval option waits the right time', () => {
    for (const [f, min] of [['15m', 15], ['30m', 30], ['1h', 60], ['4h', 240], ['daily', 1440]] as const) {
      expect(plan({ settings: settings({ frequency: f }), changes: news, lastSentAt: at(-(min - 1)).toISOString() }).send, `${f} early`).toBe(false);
      expect(plan({ settings: settings({ frequency: f }), changes: news, lastSentAt: at(-min).toISOString() }).send, `${f} on time`).toBe(true);
    }
  });
});

describe('planDeviceAlert: reminders and the picture', () => {
  it('reminds about a device that has stayed down, once the time has passed since it was last mentioned', () => {
    const s = settings({ reminderHours: 4 });
    expect(plan({ settings: s, downNow: [down(1, at(-200))] }).send).toBe(false);
    const p = plan({ settings: s, downNow: [down(1, at(-241)), down(2, at(-10))] });
    expect(p.send).toBe(true);
    expect(p.remindedIds).toEqual([1]);
    expect(p.stillDown.map((e) => e.kumaId).sort()).toEqual([1, 2]);
  });
  it('does not remind when reminders are off, or about a device nobody was ever told about', () => {
    expect(plan({ downNow: [down(1, at(-9999))] }).send).toBe(false);
    expect(plan({ settings: settings({ reminderHours: 1 }), downNow: [down(1, null)] }).send).toBe(false);
  });
  it('does not call a device that just went down a reminder, and lists the others as still down', () => {
    const p = plan({ settings: settings({ reminderHours: 1 }), changes: [change(1, 1, 'up', 'down')], downNow: [down(1, at(-999)), down(2, at(-10))] });
    expect(p.remindedIds).toEqual([]);
    expect(p.stillDown.map((e) => e.kumaId)).toEqual([2]);
  });
});

describe('settings and recipients', () => {
  it('accepts good settings, lower-cases and de-duplicates addresses, and refuses a bad one', () => {
    const ok = deviceAlertSettingsSchema.parse({ enabled: true, frequency: '1h', reminderHours: 4, notifyEngineers: true, notifyProjectManagers: false, recipients: ['Ops@Contoso.com', 'ops@contoso.com'] });
    expect(ok.recipients).toEqual(['ops@contoso.com']);
    expect(deviceAlertSettingsSchema.safeParse({ ...ok, recipients: ['not an email'] }).success).toBe(false);
    expect(deviceAlertSettingsSchema.safeParse({ ...ok, frequency: 'weekly' }).success).toBe(false);
    expect(deviceAlertSettingsSchema.safeParse({ ...ok, reminderHours: 3 }).success).toBe(false);
  });
  it('splits typed addresses however they are separated', () => {
    expect(parseRecipients('a@x.com, b@x.com;c@x.com\nd@x.com  e@x.com')).toEqual(['a@x.com', 'b@x.com', 'c@x.com', 'd@x.com', 'e@x.com']);
  });
  it('builds the list from the chosen groups plus extras, once each', () => {
    const parts = { engineers: ['E@x.com'], projectManagers: ['pm@x.com', 'e@x.com'], extra: ['ops@x.com'] };
    expect(alertRecipientList(parts, { notifyEngineers: true, notifyProjectManagers: false })).toEqual(['e@x.com', 'ops@x.com']);
    expect(alertRecipientList(parts, { notifyEngineers: true, notifyProjectManagers: true })).toEqual(['e@x.com', 'pm@x.com', 'ops@x.com']);
    expect(alertRecipientList(parts, { notifyEngineers: false, notifyProjectManagers: false })).toEqual(['ops@x.com']);
  });
});

describe('buildDeviceAlertContext', () => {
  const urls = { customerName: 'Contoso', frequencyLabel: 'Straight away', monitoringUrl: 'https://v/monitoring/devices', alertsUrl: 'https://v/monitoring/alerts' };
  it('names a single device in the subject and words every line with its time and zone', () => {
    const p = plan({ changes: [change(1, 1, 'up', 'down', 0)], downNow: [down(2, at(-10))] });
    const c = buildDeviceAlertContext(p, urls);
    expect(c.subject).toBe('Device down: dev1 (LTN01): Contoso');
    expect(c.wentDown).toEqual(['dev1 · LTN01 · Algo paging, down since 27 Oct 12:00 UTC']);
    expect(c.stillDown).toHaveLength(1);
    expect(c.reminders).toEqual([]);
  });
  it('says recovered, and counts when there are several', () => {
    expect(buildDeviceAlertContext(plan({ changes: [change(1, 1, 'down', 'up', 3)] }), urls).subject).toBe('Device recovered: dev1 (LTN01): Contoso');
    const many = plan({ changes: [change(1, 1, 'up', 'down'), change(2, 2, 'up', 'down'), change(3, 3, 'down', 'up')] });
    expect(buildDeviceAlertContext(many, urls).subject).toBe('Monitoring: 2 down, 1 recovered: Contoso');
  });
  it('a reminder-only email says what is still down, and a test says it is a test', () => {
    const p = plan({ settings: settings({ reminderHours: 1 }), downNow: [down(1, at(-90))] });
    const c = buildDeviceAlertContext(p, urls);
    expect(c.subject).toBe('Still down: 1 device: Contoso');
    expect(c.reminders[0]).toContain('still down, since');
    expect(buildDeviceAlertContext(p, { ...urls, test: true }).subject).toBe('Voxshift monitoring test: Contoso');
  });
  it('formats times in UTC', () => {
    expect(alertTime('2026-10-27T09:05:00Z')).toBe('27 Oct 09:05 UTC');
  });
});
