// The incident housekeeping sweep: reminders while waiting on the customer, one
// "at risk" and one "missed" email per target, silence while the clocks are
// paused, and a resolved incident closing itself when nobody has replied.
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { platformDb } from '@tvmf/db';
import { createIncidentSchema, type CreateIncidentInput } from '@tvmf/shared';
import { AuditService } from '../../../../apps/api/src/common/audit.service';
import type { AppConfig } from '../../../../apps/api/src/common/config';
import type { MailService } from '../../../../apps/api/src/mail/mail.service';
import { FilesService } from '../../../../apps/api/src/modules/files/files.service';
import { IncidentNotifier } from '../../../../apps/api/src/modules/incidents/incident-notifier';
import { IncidentsService } from '../../../../apps/api/src/modules/incidents/incidents.service';
import { sweepIncidents } from '../../../../apps/worker/src/incidents';
import { seedCustomer, seedSite, seedUser, useDb, type TestCustomer } from '../helpers';

const handle = useDb();
let c: TestCustomer;
let svc: IncidentsService;
let engineer: Awaited<ReturnType<typeof seedUser>>;
let engineer2: Awaited<ReturnType<typeof seedUser>>;
let cara: Awaited<ReturnType<typeof seedUser>>;
let dan: Awaited<ReturnType<typeof seedUser>>;
let siteId: string;
let sent: { template: string; to: { email: string }; context: Record<string, unknown> }[] = [];

const enqueue = async (m: { template: string; to: { email: string }; context: Record<string, unknown> }) => {
  sent.push(m);
  return { id: 'm' } as never;
};
const sweep = () => sweepIncidents(handle.db, enqueue as never, { tenantId: c.t.id });
const call = (over: Partial<CreateIncidentInput> = {}) =>
  createIncidentSchema.parse({
    title: 'No audio on inbound calls',
    category: 'call_quality',
    subcategory: 'one_way_audio',
    siteId,
    impact: 'team',
    urgency: 'degraded',
    description: 'People at Reading hear nothing on inbound calls.',
    answers: { where: 'In the office on wifi', how_often: 'Every call', started: 'Today 09:00' },
    ...over,
  });
const raise = (over: Partial<CreateIncidentInput> = {}) => svc.create(c.t, cara, call(over), false);
const move = (id: string, input: Parameters<IncidentsService['move']>[3]) => svc.move(c.t, engineer, id, input, true);
const ago = (ms: number) => new Date(Date.now() - ms).toISOString();
const MIN = 60_000;
const DAY = 86_400_000;
const set = (id: string, values: Record<string, unknown>) => c.s.updateTable('incidents').set(values as never).where('id', '=', id).execute();
const row = (id: string) => c.s.selectFrom('incidents').selectAll().where('id', '=', id).executeTakeFirstOrThrow();
const mailFor = (template: string, id?: string) => sent.filter((m) => m.template === template && (!id || (m as unknown as { related?: { id: string } }).related?.id === id));

beforeAll(async () => {
  c = await seedCustomer(handle, { managedServices: true });
  engineer = await seedUser(handle, 'ENGINEER', { displayName: 'Eve Engineer' });
  engineer2 = await seedUser(handle, 'ENGINEER', { displayName: 'Ed Engineer' });
  cara = await seedUser(handle, 'CUSTOMER', { displayName: 'Cara Customer' });
  dan = await seedUser(handle, 'CUSTOMER', { displayName: 'Dan Customer' });
  await platformDb(handle.db)
    .insertInto('tenant_memberships')
    .values([engineer, engineer2, cara, dan].map((u) => ({ tenant_id: c.t.id, user_id: u.id })) as never)
    .execute();
  siteId = (await seedSite(c.s, { sitecode: 'RDG01' })).id;
  await c.s.updateTable('discovery_sites').set({ mode: 'operations' } as never).where('id', '=', siteId).execute();
  const mail = { enqueue: async () => ({ id: 'm' }) } as unknown as MailService; // the API's own mail isn't under test here
  svc = new IncidentsService(handle.db, new AuditService(handle.db), new FilesService(handle.db, { write: async () => {}, read: async () => Buffer.alloc(0), delete: async () => {}, exists: async () => true }), new IncidentNotifier(handle.db, mail, { WEB_ORIGIN: 'https://app.test', JWT_REFRESH_SECRET: 'x'.repeat(32) } as AppConfig));
});

beforeEach(() => {
  sent = [];
});

describe('waiting on the customer', () => {
  it('reminds the reporter every three days, quoting the question, at most three times', async () => {
    const r = await raise();
    await move(r.id, { to: 'in_progress' });
    await svc.comment(c.t, engineer, r.id, { body: 'Which handsets are affected?', waitForReply: true }, true);
    await sweep();
    expect(sent).toHaveLength(0); // only just asked
    await set(r.id, { paused_since: ago(4 * DAY) });
    await sweep();
    expect(sent).toHaveLength(1);
    expect(sent[0]!.to.email).toBe(cara.email);
    expect(sent[0]!.template).toBe('incident_message');
    expect(sent[0]!.context).toMatchObject({ kind: 'reminder', author: 'Eve Engineer', body: 'Which handsets are affected?', reference: r.reference });
    await sweep();
    expect(sent).toHaveLength(1); // not again straight away
    for (let n = 2; n <= 3; n++) {
      await set(r.id, { waiting_reminded_at: ago(4 * DAY) });
      await sweep();
    }
    expect(sent).toHaveLength(3);
    await set(r.id, { waiting_reminded_at: ago(4 * DAY) });
    await sweep();
    expect(sent).toHaveLength(3); // that was the last
    expect((await row(r.id)).waiting_reminders).toBe(3);
  });

  it('stops once they reply', async () => {
    const r = await raise();
    await move(r.id, { to: 'in_progress' });
    await svc.comment(c.t, engineer, r.id, { body: 'Which handsets?', waitForReply: true }, true);
    await set(r.id, { paused_since: ago(4 * DAY) });
    await svc.comment(c.t, cara, r.id, { body: 'Yealinks' }, false);
    await sweep();
    expect(mailFor('incident_message')).toHaveLength(0);
  });
});

describe('targets', () => {
  it('warns the team once when a target is at risk and once when it is missed', async () => {
    const r = await raise({ impact: 'company', urgency: 'cannot_call' }); // P1: respond in 15 minutes
    await set(r.id, { created_at: ago(13 * MIN) });
    await sweep();
    const warn = sent.filter((m) => m.template === 'incident_activity' && m.context.kind === 'sla_warning');
    expect(warn.map((m) => m.to.email).sort()).toEqual(expect.arrayContaining([engineer.email, engineer2.email]));
    expect(warn[0]!.context).toMatchObject({ reference: r.reference, priorityLabel: 'P1 Critical' });
    expect(String(warn[0]!.context.body)).toMatch(/^First response is due in/);
    const first = sent.length;
    await sweep();
    expect(sent).toHaveLength(first); // once
    await set(r.id, { created_at: ago(20 * MIN) });
    sent = [];
    await sweep();
    const missed = sent.filter((m) => m.context.kind === 'sla_breached');
    expect(missed.length).toBeGreaterThan(0);
    expect(String(missed[0]!.context.body)).toMatch(/^First response was due .* ago/);
    sent = [];
    await sweep();
    expect(sent).toHaveLength(0);
    expect(Object.keys((await row(r.id)).sla_notified).sort()).toEqual(['response_breached', 'response_warning']);
  });

  it('tells only the assignee when someone has it', async () => {
    const r = await raise({ impact: 'company', urgency: 'cannot_call' });
    await svc.assign(c.t, engineer, r.id, { userId: engineer2.id });
    await set(r.id, { created_at: ago(20 * MIN) });
    sent = [];
    await sweep();
    const m = sent.filter((x) => x.context.reference === r.reference && x.context.kind === 'sla_breached');
    expect(m.map((x) => x.to.email)).toEqual([engineer2.email]);
  });

  it('says nothing once the incident is acknowledged in time, and moves on to the next target', async () => {
    const r = await raise({ impact: 'company', urgency: 'cannot_call' });
    await move(r.id, { to: 'in_progress' });
    await set(r.id, { created_at: ago(3.5 * 3_600_000) }); // restoration is due in 4 hours: 30 minutes left is at risk (20% of 4h = 48 min)
    sent = [];
    await sweep();
    const mine = sent.filter((x) => x.context.reference === r.reference);
    expect(mine.length).toBeGreaterThan(0);
    expect(mine.every((x) => x.context.kind === 'sla_warning')).toBe(true);
    expect(String(mine[0]!.context.body)).toMatch(/^Service restoration is due in/);
  });

  it('stays quiet while the clocks are paused', async () => {
    const r = await raise({ impact: 'company', urgency: 'cannot_call' });
    await move(r.id, { to: 'in_progress' });
    await svc.comment(c.t, engineer, r.id, { body: 'Which SBC?', waitForReply: true }, true);
    await set(r.id, { created_at: ago(30 * DAY), paused_since: ago(29 * DAY) });
    sent = [];
    await sweep();
    // No target emails (it does get the waiting-on-customer reminder, which is its own thing).
    expect(sent.filter((x) => x.context.reference === r.reference && x.template === 'incident_activity')).toHaveLength(0);
  });

  it('uses the customer\'s own targets', async () => {
    await platformDb(handle.db).updateTable('tenants').set({ inc_settings: JSON.stringify({ targets: { p3: { responseMinutes: 10, restoreHours: 1, resolveHours: 2 } } }) }).where('id', '=', c.t.id).execute();
    const r = await raise({ impact: 'individual', urgency: 'cannot_call' }); // P3
    await set(r.id, { created_at: ago(30 * MIN) });
    sent = [];
    await sweep();
    expect(sent.some((x) => x.context.reference === r.reference && x.context.kind === 'sla_breached')).toBe(true);
    await platformDb(handle.db).updateTable('tenants').set({ inc_settings: '{}' }).where('id', '=', c.t.id).execute();
  });
});

describe('closing resolved incidents', () => {
  it('closes one nobody has replied to after five days, and tells the reporter and followers', async () => {
    const r = await raise();
    await svc.watch(c.t, dan, r.id, undefined, false);
    await move(r.id, { to: 'resolved', note: 'Fixed' });
    await sweep();
    expect((await row(r.id)).status).toBe('resolved'); // too soon
    await set(r.id, { resolved_at: ago(6 * DAY) });
    sent = [];
    await sweep();
    const done = await row(r.id);
    expect(done.status).toBe('closed');
    expect(done.closed_at).not.toBeNull();
    const ev = await c.s.selectFrom('incident_events').selectAll().where('incident_id', '=', r.id).where('to_status', '=', 'closed').executeTakeFirstOrThrow();
    expect(ev).toMatchObject({ actor_type: 'system', author_id: null });
    expect(ev.body).toContain('Closed automatically');
    const mails = sent.filter((m) => m.template === 'incident_status_changed' && m.context.reference === r.reference);
    expect(mails.map((m) => m.to.email).sort()).toEqual([cara.email, dan.email].sort());
    expect(mails[0]!.context.kind).toBe('auto_close');
    sent = [];
    await sweep();
    expect(sent.filter((m) => m.context.reference === r.reference)).toHaveLength(0);
  });

  it('leaves one alone that is being discussed', async () => {
    const r = await raise();
    await move(r.id, { to: 'resolved', note: 'Fixed' });
    await set(r.id, { resolved_at: ago(6 * DAY) });
    await svc.comment(c.t, cara, r.id, { body: 'Not sure it is fixed yet' }, false);
    await sweep();
    expect((await row(r.id)).status).toBe('resolved');
  });

  it('a closed incident can still be reopened within the week', async () => {
    const r = await raise();
    await move(r.id, { to: 'resolved', note: 'Fixed' });
    await set(r.id, { resolved_at: ago(5.5 * DAY) });
    await sweep();
    expect((await row(r.id)).status).toBe('closed');
    await svc.move(c.t, cara, r.id, { to: 'in_progress', note: 'Still broken' }, false);
    expect((await row(r.id)).status).toBe('in_progress');
  });
});
