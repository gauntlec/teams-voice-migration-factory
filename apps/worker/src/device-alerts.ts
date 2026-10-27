import type { Kysely } from 'kysely';
import { alertRecipientList, buildDeviceAlertContext, DEVICE_ALERT_FREQUENCY_LABEL } from '@tvmf/shared';
import { deviceAlertDue, deviceAlertPeople, platformDb, settleDeviceAlert, tenantDb, webOrigin as resolveWebOrigin, type DB } from '@tvmf/db';
import type { MailEnqueuer } from './mail/enqueue';

/**
 * Monitoring email alerts (docs/DEVICE-MONITORING.md): every 15 seconds, for each customer who has alerts on, ask the rules (packages/shared/src/device-alerts.ts)
 * whether an email is due, and if so queue one to each person. Straight-away mode therefore tells people within about a minute of Voxshift seeing a device go down
 * (Kuma's own check interval is 20 seconds); the other modes wait their interval. Never throws into the worker.
 */
let running = false;
export async function sweepDeviceAlerts(db: Kysely<DB>, enqueueMail: MailEnqueuer, now = new Date(), opts: { tenantId?: string } = {}): Promise<{ emails: number }> {
  if (running) return { emails: 0 };
  running = true;
  let emails = 0;
  try {
    let q = platformDb(db).selectFrom('tenants').select(['id', 'name', 'schema_name']).where('status', '=', 'active');
    if (opts.tenantId) q = q.where('id', '=', opts.tenantId);
    const tenants = await q.execute();
    const origin = await resolveWebOrigin(db);
    for (const t of tenants) {
      try {
        const s = tenantDb(db, t.schema_name);
        const due = await deviceAlertDue(s, now);
        if (!due) continue;
        const { plan, settings, cursor } = due;
        if (!plan.send) {
          // Nothing to say (or waiting for its time): move on past anything that was not news, keep what is.
          if (plan.cursor !== cursor) await settleDeviceAlert(s, plan, false, now);
          continue;
        }
        const people = await deviceAlertPeople(db, t.id);
        const to = alertRecipientList({ ...people, extra: settings.recipients }, settings);
        if (to.length === 0) {
          // Nobody to tell: do not keep the news for ever.
          // eslint-disable-next-line no-console
          console.warn(`[device-alerts] ${t.schema_name}: alerts are on but there is nobody to email`);
          await settleDeviceAlert(s, plan, false, now);
          continue;
        }
        const context = buildDeviceAlertContext(plan, {
          customerName: t.name,
          frequencyLabel: DEVICE_ALERT_FREQUENCY_LABEL[settings.frequency],
          monitoringUrl: `${origin}/monitoring/devices`,
          alertsUrl: `${origin}/monitoring/alerts`,
        });
        for (const email of to) await enqueueMail({ template: 'device_alert', to: { email }, context, related: { type: 'device_alert', id: t.id }, tenantId: t.id });
        await settleDeviceAlert(s, plan, true, now);
        emails += to.length;
      } catch (e) {
        // eslint-disable-next-line no-console
        console.warn(`[device-alerts] ${t.schema_name}: ${(e as Error).message}`);
      }
    }
  } finally {
    running = false;
  }
  return { emails };
}
