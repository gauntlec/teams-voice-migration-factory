import { DEFAULT_DEVICE_ALERT_SETTINGS, alertRecipientList, planDeviceAlert, type DeviceAlertChange, type DeviceAlertDown, type DeviceAlertFrequency, type DeviceAlertPlan, type DeviceAlertSettings, type DeviceAlertSettingsInput, type DeviceAlertView, type DeviceKind, type DeviceState } from '@tvmf/shared';
import type { Kysely } from 'kysely';
import { emailEnabled } from './app-settings';
import type { Scoped } from './live-state';
import { platformDb, type DB } from './index';

/*
 * Monitoring email alerts (migration 0072). The rules are in packages/shared/src/device-alerts.ts; this reads what they need from the database and
 * writes back what was done. The worker (apps/worker/src/device-alerts.ts) does the sending.
 */

const iso = (v: string | Date | null | undefined) => (v ? new Date(v).toISOString() : null);

export async function getDeviceAlertSettings(s: Scoped): Promise<DeviceAlertSettings & { lastSentAt: string | null; cursor: string }> {
  const r = await s.selectFrom('device_alert_settings').selectAll().executeTakeFirst();
  if (!r) return { ...DEFAULT_DEVICE_ALERT_SETTINGS, lastSentAt: null, cursor: '0' };
  return {
    enabled: r.enabled,
    frequency: r.frequency as DeviceAlertFrequency,
    reminderHours: r.reminder_hours as DeviceAlertSettings['reminderHours'],
    notifyEngineers: r.notify_engineers,
    notifyProjectManagers: r.notify_project_managers,
    recipients: Array.isArray(r.recipients) ? r.recipients : [],
    lastSentAt: iso(r.last_sent_at),
    cursor: String(r.cursor),
  };
}

/**
 * Saves the settings. Switching alerts ON starts from now: what happened before is history, not news, and devices that are already down are marked
 * as already mentioned, so switching on does not send a flood (a reminder, if chosen, comes after its time as usual).
 */
export async function saveDeviceAlertSettings(s: Scoped, input: DeviceAlertSettingsInput, now = new Date()): Promise<void> {
  const before = await getDeviceAlertSettings(s);
  const switchingOn = input.enabled && !before.enabled;
  await s.transaction().execute(async (trx) => {
    let cursor: string | undefined;
    if (switchingOn) {
      const m = await trx.selectFrom('device_status_changes').select((eb) => eb.fn.max('id').as('max')).executeTakeFirst();
      cursor = String(m?.max ?? '0');
      await trx.updateTable('device_monitors').set({ last_alerted_at: now.toISOString() }).where('state', '=', 'down').execute();
    }
    await trx
      .insertInto('device_alert_settings')
      .values({ id: true })
      .onConflict((oc) => oc.column('id').doNothing())
      .execute();
    await trx
      .updateTable('device_alert_settings')
      .set({
        enabled: input.enabled,
        frequency: input.frequency,
        reminder_hours: input.reminderHours,
        notify_engineers: input.notifyEngineers,
        notify_project_managers: input.notifyProjectManagers,
        recipients: JSON.stringify(input.recipients),
        updated_at: now.toISOString(),
        ...(cursor !== undefined ? { cursor, last_sent_at: null } : {}),
      })
      .execute();
  });
}

/** The engineers (and administrators) and the project managers who can see this customer, as people to email. */
export async function deviceAlertPeople(db: Kysely<DB>, tenantId: string): Promise<{ engineers: string[]; projectManagers: string[] }> {
  const p = platformDb(db);
  const members = await p
    .selectFrom('tenant_memberships as m')
    .innerJoin('users as u', 'u.id', 'm.user_id')
    .select(['u.email as email', 'u.role as role'])
    .where('m.tenant_id', '=', tenantId)
    .where('u.status', '=', 'active')
    .where('u.role', 'in', ['ENGINEER', 'PROJECT_MANAGER'])
    .execute();
  const admins = await p.selectFrom('users').select('email').where('role', '=', 'SUPER_ADMIN').where('status', '=', 'active').execute();
  return {
    engineers: [...members.filter((m) => m.role === 'ENGINEER').map((m) => m.email), ...admins.map((a) => a.email)],
    projectManagers: members.filter((m) => m.role === 'PROJECT_MANAGER').map((m) => m.email),
  };
}

/** What the Alerts page shows. */
export async function deviceAlertView(s: Scoped, db: Kysely<DB>, tenantId: string): Promise<DeviceAlertView> {
  const cur = await getDeviceAlertSettings(s);
  const people = await deviceAlertPeople(db, tenantId);
  return {
    enabled: cur.enabled,
    frequency: cur.frequency,
    reminderHours: cur.reminderHours,
    notifyEngineers: cur.notifyEngineers,
    notifyProjectManagers: cur.notifyProjectManagers,
    recipients: cur.recipients,
    lastSentAt: cur.lastSentAt,
    recipientCount: alertRecipientList({ ...people, extra: cur.recipients }, cur).length,
    emailOff: !(await emailEnabled(db)),
  };
}

/** What the worker should do for this customer now, or null when alerts are off. */
export async function deviceAlertDue(s: Scoped, now = new Date()): Promise<{ settings: DeviceAlertSettings; plan: DeviceAlertPlan; cursor: string } | null> {
  const cur = await getDeviceAlertSettings(s);
  if (!cur.enabled) return null;
  const rows = await s.selectFrom('device_status_changes').selectAll().where('id', '>', cur.cursor).orderBy('id').limit(500).execute();
  const downRows = await s.selectFrom('device_monitors').select(['kuma_id', 'name', 'sitecode', 'device_kind', 'since', 'last_alerted_at']).where('state', '=', 'down').execute();
  const changes: DeviceAlertChange[] = rows.map((r) => ({
    id: String(r.id),
    kumaId: r.kuma_id,
    name: r.name,
    sitecode: r.sitecode,
    deviceKind: r.device_kind as DeviceKind,
    from: (r.from_state as DeviceState | null) ?? null,
    to: r.to_state as DeviceState,
    at: new Date(r.at).toISOString(),
  }));
  const downNow: DeviceAlertDown[] = downRows.map((r) => ({ kumaId: r.kuma_id, name: r.name, sitecode: r.sitecode, deviceKind: r.device_kind as DeviceKind, since: new Date(r.since).toISOString(), lastAlertedAt: iso(r.last_alerted_at) }));
  const plan = planDeviceAlert({ settings: cur, changes, downNow, lastSentAt: cur.lastSentAt, cursor: cur.cursor, now });
  return { settings: cur, plan, cursor: cur.cursor };
}

/** Records what was done: moves the cursor on, and when an email went out, when, and which down devices it mentioned. */
export async function settleDeviceAlert(s: Scoped, plan: DeviceAlertPlan, sent: boolean, now = new Date()): Promise<void> {
  await s.transaction().execute(async (trx) => {
    await trx
      .updateTable('device_alert_settings')
      .set({ cursor: plan.cursor, ...(sent ? { last_sent_at: now.toISOString() } : {}) })
      .execute();
    if (sent) {
      const mentioned = [...new Set([...plan.wentDown.map((e) => e.kumaId), ...plan.stillDown.map((e) => e.kumaId)])];
      if (mentioned.length) await trx.updateTable('device_monitors').set({ last_alerted_at: now.toISOString() }).where('kuma_id', 'in', mentioned).execute();
    }
  });
}
