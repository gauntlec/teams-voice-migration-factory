// Monitoring email alerts: settings, the baseline when switched on, what is due, and what is recorded as sent (migration 0072).
import { beforeAll, describe, expect, it } from 'vitest';
import { deviceAlertDue, deviceAlertPeople, deviceAlertView, getDeviceAlertSettings, saveDeviceAlertSettings, settleDeviceAlert } from '@tvmf/db';
import { platformDb } from '@tvmf/db';
import { seedCustomer, seedUser, useDb, type TestCustomer } from '../helpers';

const handle = useDb();
let c: TestCustomer;
const T0 = new Date('2026-10-27T12:00:00Z');
const at = (min: number) => new Date(T0.getTime() + min * 60_000);
const on = { enabled: true, frequency: 'immediate' as const, reminderHours: 0 as const, notifyEngineers: true, notifyProjectManagers: false, recipients: [] as string[] };

async function change(kumaId: number, from: string | null, to: string, min: number, name = `dev${kumaId}`) {
  await c.s.insertInto('device_status_changes').values({ kuma_id: kumaId, name, sitecode: 'LTN01', device_kind: 'algo', from_state: from, to_state: to, at: at(min).toISOString() } as never).execute();
}
async function monitor(kumaId: number, state: string, min: number, lastAlerted: Date | null = null) {
  await c.s
    .insertInto('device_monitors')
    .values({ kuma_id: kumaId, name: `dev${kumaId}`, sitecode: 'LTN01', device_kind: 'algo', state, since: at(min).toISOString(), last_alerted_at: lastAlerted?.toISOString() ?? null } as never)
    .onConflict((oc) => oc.column('kuma_id').doUpdateSet({ state, since: at(min).toISOString(), last_alerted_at: lastAlerted?.toISOString() ?? null } as never))
    .execute();
}

beforeAll(async () => {
  c = await seedCustomer(handle);
});

describe('alert settings', () => {
  it('start switched off with sensible defaults', async () => {
    expect(await getDeviceAlertSettings(c.s)).toMatchObject({ enabled: false, frequency: 'immediate', reminderHours: 0, notifyEngineers: true, notifyProjectManagers: false, recipients: [], lastSentAt: null, cursor: '0' });
    expect(await deviceAlertDue(c.s, at(0))).toBeNull();
  });

  it('switching on starts from now: old history is not news, and devices already down are not announced', async () => {
    await change(1, null, 'down', -120);
    await monitor(1, 'down', -120);
    await saveDeviceAlertSettings(c.s, { ...on, recipients: ['ops@contoso.com'] }, at(0));
    const cur = await getDeviceAlertSettings(c.s);
    expect(cur).toMatchObject({ enabled: true, recipients: ['ops@contoso.com'] });
    expect(Number(cur.cursor)).toBeGreaterThan(0);
    const due = await deviceAlertDue(c.s, at(1));
    expect(due!.plan.send).toBe(false);
    expect((await c.s.selectFrom('device_monitors').select('last_alerted_at').where('kuma_id', '=', 1).executeTakeFirstOrThrow()).last_alerted_at).not.toBeNull();
  });

  it('saving again while on does not reset the baseline', async () => {
    const before = await getDeviceAlertSettings(c.s);
    await saveDeviceAlertSettings(c.s, { ...on, frequency: '1h', recipients: [] }, at(2));
    const after = await getDeviceAlertSettings(c.s);
    expect(after.cursor).toBe(before.cursor);
    expect(after).toMatchObject({ frequency: '1h', recipients: [] });
    await saveDeviceAlertSettings(c.s, { ...on }, at(2));
  });
});

describe('what is due and what is recorded', () => {
  it('news after the baseline is due, and is recorded as sent', async () => {
    await monitor(2, 'down', 5);
    await change(2, 'up', 'down', 5, 'Door paging');
    const due = await deviceAlertDue(c.s, at(6));
    expect(due!.plan.send).toBe(true);
    expect(due!.plan.wentDown.map((e) => e.name)).toEqual(['Door paging']);
    expect(due!.plan.stillDown.map((e) => e.kumaId)).toEqual([1]);
    await settleDeviceAlert(c.s, due!.plan, true, at(6));
    const after = await getDeviceAlertSettings(c.s);
    expect(after.lastSentAt).toBe(at(6).toISOString());
    expect(await deviceAlertDue(c.s, at(7))).toMatchObject({ plan: { send: false } });
    const mentioned = await c.s.selectFrom('device_monitors').select(['kuma_id', 'last_alerted_at']).where('state', '=', 'down').execute();
    expect(mentioned.every((m) => m.last_alerted_at !== null)).toBe(true);
  });

  it('noise moves the cursor on without an email', async () => {
    await change(3, 'up', 'pending', 8);
    const due = await deviceAlertDue(c.s, at(9));
    expect(due!.plan.send).toBe(false);
    await settleDeviceAlert(c.s, due!.plan, false, at(9));
    expect((await getDeviceAlertSettings(c.s)).lastSentAt).toBe(at(6).toISOString());
    expect((await deviceAlertDue(c.s, at(10)))!.plan).toMatchObject({ send: false, cursor: due!.plan.cursor });
  });

  it('a summary mode holds news until its time, and keeps it meanwhile', async () => {
    await saveDeviceAlertSettings(c.s, { ...on, frequency: '1h' }, at(10));
    await change(4, 'up', 'down', 20, 'Reception DECT');
    await monitor(4, 'down', 20);
    const early = await deviceAlertDue(c.s, at(30));
    expect(early!.plan.send).toBe(false);
    await settleDeviceAlert(c.s, early!.plan, false, at(30));
    const late = await deviceAlertDue(c.s, at(70));
    expect(late!.plan.send).toBe(true);
    expect(late!.plan.wentDown.map((e) => e.name)).toEqual(['Reception DECT']);
  });
});

describe('who is emailed', () => {
  it('engineers and administrators of the customer, project managers separately, and the extras', async () => {
    const eng = await seedUser(handle, 'ENGINEER');
    const pm = await seedUser(handle, 'PROJECT_MANAGER');
    const otherEng = await seedUser(handle, 'ENGINEER');
    for (const u of [eng, pm]) await platformDb(handle.db).insertInto('tenant_memberships').values({ tenant_id: c.t.id, user_id: u.id } as never).execute();
    const people = await deviceAlertPeople(handle.db, c.t.id);
    expect(people.engineers).toContain(eng.email);
    expect(people.engineers).not.toContain(otherEng.email);
    expect(people.projectManagers).toEqual([pm.email]);
    await saveDeviceAlertSettings(c.s, { ...on, notifyProjectManagers: true, recipients: ['ops@contoso.com'] }, at(100));
    const view = await deviceAlertView(c.s, handle.db, c.t.id);
    expect(view.recipientCount).toBeGreaterThanOrEqual(3);
    expect(typeof view.emailOff).toBe('boolean');
  });
});
