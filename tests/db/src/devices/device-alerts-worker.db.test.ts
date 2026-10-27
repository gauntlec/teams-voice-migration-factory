// The Monitoring alert email and the worker sweep that sends it, with a fake mail queue.
import { beforeAll, describe, expect, it } from 'vitest';
import { platformDb, saveDeviceAlertSettings } from '@tvmf/db';
import { renderEmail } from '../../../../apps/worker/src/mail/templates';
import { sweepDeviceAlerts } from '../../../../apps/worker/src/device-alerts';
import type { EnqueueMailInput } from '../../../../apps/worker/src/mail/enqueue';
import { seedCustomer, seedUser, useDb, useGlobalSettingsLock, type TestCustomer } from '../helpers';

const handle = useDb();
useGlobalSettingsLock(handle); // the sweep reads the platform's switched-off features, which another test file changes
let c: TestCustomer;
let engineer: Awaited<ReturnType<typeof seedUser>>;
let pm: Awaited<ReturnType<typeof seedUser>>;
const sent: EnqueueMailInput[] = [];
const enqueue = async (m: EnqueueMailInput) => { sent.push(m); };
const T0 = new Date('2026-10-27T12:00:00Z');
const at = (min: number) => new Date(T0.getTime() + min * 60_000);
const on = { enabled: true, frequency: 'immediate' as const, reminderHours: 0 as const, notifyEngineers: true, notifyProjectManagers: false, recipients: [] as string[] };

async function goDown(kumaId: number, name: string, min: number) {
  await c.s.insertInto('device_status_changes').values({ kuma_id: kumaId, name, sitecode: 'LTN01', device_kind: 'algo', from_state: 'up', to_state: 'down', at: at(min).toISOString() } as never).execute();
  await c.s.insertInto('device_monitors').values({ kuma_id: kumaId, name, sitecode: 'LTN01', device_kind: 'algo', state: 'down', since: at(min).toISOString() } as never).onConflict((oc) => oc.column('kuma_id').doNothing()).execute();
}

beforeAll(async () => {
  c = await seedCustomer(handle, { name: 'Contoso' });
  engineer = await seedUser(handle, 'ENGINEER');
  pm = await seedUser(handle, 'PROJECT_MANAGER');
  for (const u of [engineer, pm]) await platformDb(handle.db).insertInto('tenant_memberships').values({ tenant_id: c.t.id, user_id: u.id } as never).execute();
});

describe('the alert email', () => {
  const ctx = { customerName: 'Contoso', subject: 'Device down: Door paging (LTN01): Contoso', test: false, wentDown: ['Door paging · LTN01 · Algo paging, down since 27 Oct 12:00 UTC'], recovered: [], reminders: [], stillDown: ['DECT base · LTN01 · DECT, down since 27 Oct 09:00 UTC'], frequencyLabel: 'Straight away', monitoringUrl: 'https://v.example/monitoring/devices', alertsUrl: 'https://v.example/monitoring/alerts' };
  it('names the devices, links to the page and says how to change it', () => {
    const e = renderEmail('device_alert', ctx as never);
    expect(e.subject).toBe(ctx.subject);
    for (const part of ['Door paging', 'DECT base', 'Went down', 'Also down', 'https://v.example/monitoring/devices', 'https://v.example/monitoring/alerts', 'straight away']) expect(e.html + e.text).toContain(part);
    expect(e.html + e.text).not.toMatch(/kuma/i);
  });
  it('says it is a test, and has no real device lines in the heading', () => {
    const e = renderEmail('device_alert', { ...ctx, test: true, subject: 'Voxshift monitoring test: Contoso' } as never);
    expect(e.html).toContain('Test alert');
    expect(e.subject).toBe('Voxshift monitoring test: Contoso');
  });
});

describe('sweepDeviceAlerts', () => {
  it('does nothing while alerts are off', async () => {
    await goDown(1, 'Old news', -60);
    expect((await sweepDeviceAlerts(handle.db, enqueue, at(0), { tenantId: c.t.id })).emails).toBe(0);
    expect(sent).toHaveLength(0);
  });

  it('emails the customer\'s engineers (not project managers, not other customers\' people) when a device goes down', async () => {
    await saveDeviceAlertSettings(c.s, { ...on, recipients: ['ops@contoso.com'] }, at(1));
    await goDown(2, 'Door paging', 2);
    const r = await sweepDeviceAlerts(handle.db, enqueue, at(3), { tenantId: c.t.id });
    expect(r.emails).toBeGreaterThanOrEqual(2);
    const to = sent.map((m) => m.to.email);
    expect(to).toContain(engineer.email);
    expect(to).toContain('ops@contoso.com');
    expect(to).not.toContain(pm.email);
    expect(sent.every((m) => m.template === 'device_alert' && m.tenantId === c.t.id)).toBe(true);
    const ctx = sent[0]!.context as { wentDown: string[]; stillDown: string[] };
    expect(ctx.wentDown.join()).toContain('Door paging');
    // the device that was already down when alerts were switched on is part of the picture, not news
    expect(ctx.wentDown.join()).not.toContain('Old news');
    expect(ctx.stillDown.join()).toContain('Old news');
  });

  it('does not send the same news twice', async () => {
    const n = sent.length;
    expect((await sweepDeviceAlerts(handle.db, enqueue, at(4), { tenantId: c.t.id })).emails).toBe(0);
    expect(sent).toHaveLength(n);
  });

  it('includes project managers when asked, and in summary mode waits its interval from the last email', async () => {
    await saveDeviceAlertSettings(c.s, { ...on, frequency: '1h', notifyProjectManagers: true }, at(5));
    await goDown(3, 'Reception DECT', 6);
    const n = sent.length;
    expect((await sweepDeviceAlerts(handle.db, enqueue, at(10), { tenantId: c.t.id })).emails).toBe(0); // the last email went at minute 3: an hour has not passed
    expect(sent).toHaveLength(n);
    expect((await sweepDeviceAlerts(handle.db, enqueue, at(70), { tenantId: c.t.id })).emails).toBeGreaterThan(0);
    const batch = sent.slice(n);
    expect(batch.map((m) => m.to.email)).toContain(pm.email);
    expect(JSON.stringify(batch[0]!.context)).toContain('Reception DECT');
    await goDown(4, 'Warehouse horn', 80);
    const m = sent.length;
    expect((await sweepDeviceAlerts(handle.db, enqueue, at(90), { tenantId: c.t.id })).emails).toBe(0);
    expect(sent).toHaveLength(m);
    expect((await sweepDeviceAlerts(handle.db, enqueue, at(135), { tenantId: c.t.id })).emails).toBeGreaterThan(0);
    expect(JSON.stringify(sent[m]!.context)).toContain('Warehouse horn');
  });
});
