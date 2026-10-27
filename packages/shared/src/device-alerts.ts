import { z } from 'zod';
import { DEVICE_KIND_LABEL, type DeviceKind, type DeviceState } from './device-status';
import type { DeviceAlertContext } from './email';

/*
 * Email alerts for Monitoring (tenant migration 0072). When a device goes down, or comes back, the people the customer chooses are emailed. How often
 * is the customer's choice: straight away, or a summary no more often than every 15 minutes up to once a day, and optionally a reminder while a device
 * stays down. `planDeviceAlert` is the whole decision, kept pure so it is tested without a database or a mail server.
 */

export const DEVICE_ALERT_FREQUENCIES = ['immediate', '15m', '30m', '1h', '4h', 'daily'] as const;
export type DeviceAlertFrequency = (typeof DEVICE_ALERT_FREQUENCIES)[number];
export const DEVICE_ALERT_FREQUENCY_LABEL: Record<DeviceAlertFrequency, string> = {
  immediate: 'Straight away',
  '15m': 'At most every 15 minutes',
  '30m': 'At most every 30 minutes',
  '1h': 'At most every hour',
  '4h': 'At most every 4 hours',
  daily: 'At most once a day',
};
export const DEVICE_ALERT_FREQUENCY_MS: Record<DeviceAlertFrequency, number> = {
  immediate: 0,
  '15m': 15 * 60_000,
  '30m': 30 * 60_000,
  '1h': 60 * 60_000,
  '4h': 4 * 60 * 60_000,
  daily: 24 * 60 * 60_000,
};

/** 0 = no reminders. */
export const DEVICE_ALERT_REMINDER_HOURS = [0, 1, 4, 24] as const;
export const DEVICE_ALERT_REMINDER_LABEL: Record<number, string> = { 0: 'No reminders', 1: 'Every hour', 4: 'Every 4 hours', 24: 'Once a day' };

export interface DeviceAlertSettings {
  enabled: boolean;
  frequency: DeviceAlertFrequency;
  /** While a device stays down, remind every this many hours (0 = never). */
  reminderHours: (typeof DEVICE_ALERT_REMINDER_HOURS)[number];
  /** Email the customer's engineers and the administrators. */
  notifyEngineers: boolean;
  /** Email the customer's project managers. */
  notifyProjectManagers: boolean;
  /** Anyone else, by address. */
  recipients: string[];
}

export const DEFAULT_DEVICE_ALERT_SETTINGS: DeviceAlertSettings = { enabled: false, frequency: 'immediate', reminderHours: 0, notifyEngineers: true, notifyProjectManagers: false, recipients: [] };

export const deviceAlertSettingsSchema = z.object({
  enabled: z.boolean(),
  frequency: z.enum(DEVICE_ALERT_FREQUENCIES),
  reminderHours: z.union([z.literal(0), z.literal(1), z.literal(4), z.literal(24)]),
  notifyEngineers: z.boolean(),
  notifyProjectManagers: z.boolean(),
  recipients: z
    .array(z.string().trim().toLowerCase().max(254).email('Check the email addresses: one of them is not valid.'))
    .max(20, 'At most 20 extra addresses.')
    .transform((l) => [...new Set(l)]),
});
export type DeviceAlertSettingsInput = z.infer<typeof deviceAlertSettingsSchema>;

/** Splits what a person typed (commas, semicolons, spaces or new lines) into addresses. */
export function parseRecipients(text: string): string[] {
  return text.split(/[\s,;]+/).map((x) => x.trim()).filter(Boolean);
}

/** A change of state, as device_status_changes records it. */
export interface DeviceAlertChange {
  id: string;
  kumaId: number;
  name: string;
  sitecode: string | null;
  deviceKind: DeviceKind;
  from: DeviceState | null;
  to: DeviceState;
  at: string;
}
/** A device that is down now. */
export interface DeviceAlertDown {
  kumaId: number;
  name: string;
  sitecode: string | null;
  deviceKind: DeviceKind;
  since: string;
  /** When an email last told anyone it was down (null: before alerts were switched on). */
  lastAlertedAt: string | null;
}

export interface DeviceAlertEntry {
  kumaId: number;
  name: string;
  sitecode: string | null;
  deviceKind: DeviceKind;
  /** When it went down / came back / has been down since. */
  at: string;
}

export interface DeviceAlertPlan {
  send: boolean;
  wentDown: DeviceAlertEntry[];
  recovered: DeviceAlertEntry[];
  /** Down now and not in the lists above: part of the picture, not news. */
  stillDown: DeviceAlertEntry[];
  /** Devices whose "still down" reminder this email carries. */
  remindedIds: number[];
  /** Where the next look starts. */
  cursor: string;
}

const isAlertable = (c: DeviceAlertChange) => c.to === 'down' || (c.to === 'up' && c.from === 'down');
const bigger = (a: string, b: string) => (BigInt(a) >= BigInt(b) ? a : b);

/**
 * What to do now. Only two things are news: a device going down, and a device coming back after being down (checking, maintenance and "no data" are not).
 * Straight-away mode sends as soon as there is news; the other modes wait until that long since the last email and then send one summary. A reminder is
 * part of the next email once a device has been down that long since it was last mentioned. The cursor only moves past news once it has been sent.
 */
export function planDeviceAlert(input: {
  settings: DeviceAlertSettings;
  changes: DeviceAlertChange[];
  downNow: DeviceAlertDown[];
  lastSentAt: string | null;
  cursor: string;
  now: Date;
}): DeviceAlertPlan {
  const { settings, changes, downNow, lastSentAt, now } = input;
  const maxId = changes.reduce((m, c) => bigger(m, c.id), input.cursor);
  const entry = (c: DeviceAlertChange): DeviceAlertEntry => ({ kumaId: c.kumaId, name: c.name, sitecode: c.sitecode, deviceKind: c.deviceKind, at: c.at });
  const news = changes.filter(isAlertable);
  const wentDown = news.filter((c) => c.to === 'down').map(entry);
  const recovered = news.filter((c) => c.to === 'up').map(entry);

  const reminderMs = settings.reminderHours * 3_600_000;
  const reminded = reminderMs > 0 ? downNow.filter((d) => d.lastAlertedAt !== null && now.getTime() - Date.parse(d.lastAlertedAt) >= reminderMs && !wentDown.some((w) => w.kumaId === d.kumaId)) : [];

  const interval = DEVICE_ALERT_FREQUENCY_MS[settings.frequency];
  const timeIsRight = lastSentAt === null || now.getTime() - Date.parse(lastSentAt) >= interval;
  const send = settings.enabled && timeIsRight && (news.length > 0 || reminded.length > 0);

  const toEntry = (d: DeviceAlertDown): DeviceAlertEntry => ({ kumaId: d.kumaId, name: d.name, sitecode: d.sitecode, deviceKind: d.deviceKind, at: d.since });
  const stillDown = send ? downNow.filter((d) => !wentDown.some((w) => w.kumaId === d.kumaId)).map(toEntry) : [];
  // News waiting for its time stays where it is; anything else (not news) is passed over.
  const cursor = send || news.length === 0 ? maxId : input.cursor;
  return { send, wentDown, recovered, stillDown, remindedIds: send ? reminded.map((d) => d.kumaId) : [], cursor };
}

/** The addresses to write to: the chosen people plus the extras, once each. */
export function alertRecipientList(parts: { engineers: string[]; projectManagers: string[]; extra: string[] }, s: Pick<DeviceAlertSettings, 'notifyEngineers' | 'notifyProjectManagers'>): string[] {
  const all = [...(s.notifyEngineers ? parts.engineers : []), ...(s.notifyProjectManagers ? parts.projectManagers : []), ...parts.extra].map((e) => e.trim().toLowerCase()).filter(Boolean);
  return [...new Set(all)];
}

/** What GET .../alerts returns. */
export interface DeviceAlertView extends DeviceAlertSettings {
  lastSentAt: string | null;
  /** How many people the next email would go to, so the page can say "3 people" instead of leaving it to guesswork. */
  recipientCount: number;
  /** Email is switched off for the whole installation (Administration > Platform settings): alerts cannot be sent. */
  emailOff: boolean;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/** "27 Oct 12:00 UTC": an alert goes to people in different places, so the zone is said. */
export function alertTime(iso: string): string {
  const d = new Date(iso);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())} UTC`;
}

const lineOf = (e: DeviceAlertEntry, what: string) => `${e.name} · ${e.sitecode ?? 'no site'} · ${DEVICE_KIND_LABEL[e.deviceKind]}, ${what} ${alertTime(e.at)}`;

/** The email for a plan that is to be sent: every line worded, and a subject that says what happened. */
export function buildDeviceAlertContext(plan: DeviceAlertPlan, o: { customerName: string; frequencyLabel: string; monitoringUrl: string; alertsUrl: string; test?: boolean }): DeviceAlertContext {
  const reminded = new Set(plan.remindedIds);
  const reminders = plan.stillDown.filter((e) => reminded.has(e.kumaId));
  const others = plan.stillDown.filter((e) => !reminded.has(e.kumaId));
  const nDown = plan.wentDown.length;
  const nUp = plan.recovered.length;
  const parts = [nDown ? `${nDown} down` : '', nUp ? `${nUp} recovered` : ''].filter(Boolean);
  let subject: string;
  if (o.test) subject = `Voxshift monitoring test: ${o.customerName}`;
  else if (nDown === 1 && nUp === 0) subject = `Device down: ${plan.wentDown[0]!.name} (${plan.wentDown[0]!.sitecode ?? 'no site'}): ${o.customerName}`;
  else if (nDown === 0 && nUp === 1) subject = `Device recovered: ${plan.recovered[0]!.name} (${plan.recovered[0]!.sitecode ?? 'no site'}): ${o.customerName}`;
  else if (parts.length) subject = `Monitoring: ${parts.join(', ')}: ${o.customerName}`;
  else subject = `Still down: ${reminders.length} device${reminders.length === 1 ? '' : 's'}: ${o.customerName}`;
  return {
    customerName: o.customerName,
    subject,
    test: !!o.test,
    wentDown: plan.wentDown.map((e) => lineOf(e, 'down since')),
    recovered: plan.recovered.map((e) => lineOf(e, 'back at')),
    reminders: reminders.map((e) => lineOf(e, 'still down, since')),
    stillDown: others.map((e) => lineOf(e, 'down since')),
    frequencyLabel: o.frequencyLabel,
    monitoringUrl: o.monitoringUrl,
    alertsUrl: o.alertsUrl,
  };
}
