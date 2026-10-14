// The incident report for a period, and the MSP console: one queue and one major-incident
// board across an MSP's customers, who sees which, and acting from the queue.
import { ForbiddenException } from '@nestjs/common';
import { beforeAll, describe, expect, it } from 'vitest';
import { platformDb } from '@tvmf/db';
import { createIncidentSchema, createProblemSchema, type CreateIncidentInput } from '@tvmf/shared';
import { seedCustomer, seedSite, seedUser, useDb, type TestCustomer } from '../helpers';
import { incidentServices } from './services';

const handle = useDb();
let s: ReturnType<typeof incidentServices>;
let a: TestCustomer; // an MSP customer the engineers are on
let b: TestCustomer; // an MSP customer they are not on
let eng: Awaited<ReturnType<typeof seedUser>>;
let eng2: Awaited<ReturnType<typeof seedUser>>;
let stranger: Awaited<ReturnType<typeof seedUser>>; // an engineer at another organisation
let admin: Awaited<ReturnType<typeof seedUser>>;
let cara: Awaited<ReturnType<typeof seedUser>>;
let rdgA: string;
let lonA: string;
let siteB: string;
let mspId: string;

const call = (siteId: string, over: Partial<CreateIncidentInput> = {}) =>
  createIncidentSchema.parse({
    title: 'No audio on inbound calls',
    category: 'call_quality',
    subcategory: 'one_way_audio',
    siteId,
    impact: 'team',
    urgency: 'degraded',
    description: 'People hear nothing on inbound calls.',
    answers: { where: 'In the office on wifi', how_often: 'Every call', started: 'Today 09:00' },
    ...over,
  });
const raise = (t: TestCustomer, siteId: string, over: Partial<CreateIncidentInput> = {}) => s.svc.create(t.t, cara, call(siteId, over), false);
const setRow = (t: TestCustomer, id: string, v: Record<string, unknown>) => t.s.updateTable('incidents').set(v as never).where('id', '=', id).execute();
const DAY = 86_400_000;
const ago = (ms: number) => new Date(Date.now() - ms).toISOString();

beforeAll(async () => {
  s = incidentServices(handle);
  const p = platformDb(handle.db);
  eng = await seedUser(handle, 'ENGINEER', { displayName: 'Eve Engineer' });
  eng2 = await seedUser(handle, 'ENGINEER', { displayName: 'Ed Engineer' });
  stranger = await seedUser(handle, 'ENGINEER', { displayName: 'Sue Stranger' });
  admin = await seedUser(handle, 'SUPER_ADMIN', { displayName: 'Ada Admin' });
  cara = await seedUser(handle, 'CUSTOMER', { displayName: 'Cara Customer' });
  // The MSP is found by the engineers' email domain.
  const domain = `msp-${Date.now()}.test`;
  for (const u of [eng, eng2]) {
    u.email = u.email.replace('@msp.test', `@${domain}`);
    await p.updateTable('users').set({ email: u.email }).where('id', '=', u.id).execute();
  }
  const msp = await p.insertInto('msps').values({ name: 'Voxshift Test MSP', slug: `vox-${Date.now()}`, domains: [domain] } as never).returning('id').executeTakeFirstOrThrow();
  mspId = msp.id;
  a = await seedCustomer(handle, { name: 'Acme', managedServices: true });
  b = await seedCustomer(handle, { name: 'Beta', managedServices: true });
  await p.updateTable('tenants').set({ msp_id: mspId }).where('id', 'in', [a.t.id, b.t.id]).execute();
  await p.insertInto('tenant_memberships').values([{ tenant_id: a.t.id, user_id: eng.id }, { tenant_id: a.t.id, user_id: eng2.id }, { tenant_id: a.t.id, user_id: cara.id }, { tenant_id: b.t.id, user_id: cara.id }] as never).execute();
  rdgA = (await seedSite(a.s, { sitecode: 'RDG01' })).id;
  lonA = (await seedSite(a.s, { sitecode: 'LON01' })).id;
  siteB = (await seedSite(b.s, { sitecode: 'BHM01' })).id;
  await a.s.updateTable('discovery_sites').set({ mode: 'operations' } as never).execute();
  await b.s.updateTable('discovery_sites').set({ mode: 'operations' } as never).execute();
});

describe('the report', () => {
  /** A customer with incidents shaped to give known numbers. */
  async function seedReport() {
    const t = await seedCustomer(handle, { managedServices: true });
    const site1 = (await seedSite(t.s, { sitecode: 'AAA01' })).id;
    const site2 = (await seedSite(t.s, { sitecode: 'BBB01' })).id;
    await t.s.updateTable('discovery_sites').set({ mode: 'operations' } as never).execute();
    const mk = (siteId: string, over: Partial<CreateIncidentInput> = {}) => s.svc.create(t.t, cara, call(siteId, over), false);
    const i1 = await mk(site1, { impact: 'company', urgency: 'cannot_call' }); // P1
    const i2 = await mk(site1); // P3
    const i3 = await mk(site2, { category: 'users', subcategory: 'voicemail', answers: { affected_user: 'Jo' }, impact: 'individual', urgency: 'feature_broken' }); // P4
    const i4 = await mk(site1); // P3, still open
    const created = ago(10 * DAY);
    for (const i of [i1, i2, i3, i4]) await setRow(t, i.id, { created_at: created });
    const at = (hours: number) => new Date(Date.parse(created) + hours * 3_600_000).toISOString();
    await setRow(t, i1.id, { acknowledged_at: at(0.5), restored_at: at(3), resolved_at: at(5), status: 'closed', paused_seconds: 7200 });
    await setRow(t, i2.id, { acknowledged_at: at(0.5), resolved_at: at(5), status: 'resolved' });
    await setRow(t, i3.id, { acknowledged_at: at(1), resolved_at: at(6), status: 'closed' });
    await setRow(t, i4.id, { acknowledged_at: at(60), status: 'in_progress' });
    const before = await mk(site1); // raised before the period, still open
    await setRow(t, before.id, { created_at: ago(40 * DAY) });
    const from = new Date(Date.now() - 20 * DAY).toISOString().slice(0, 10);
    const to = new Date(Date.now() + DAY).toISOString().slice(0, 10);
    return { t, from, to, i1, i2, i3, i4 };
  }

  it('counts what was raised and resolved in the period, by priority, category and site', async () => {
    const { t, from, to } = await seedReport();
    const r = await s.reports.report(t.t, from, to, true);
    expect(r.raised).toBe(4);
    expect(r.resolved).toBe(3);
    expect(r.by_priority).toEqual([{ priority: 'p1', count: 1 }, { priority: 'p2', count: 0 }, { priority: 'p3', count: 2 }, { priority: 'p4', count: 1 }]);
    expect(r.by_category[0]).toMatchObject({ category: 'call_quality', count: 3 });
    expect(r.by_site).toEqual([{ site: 'AAA01', count: 3 }, { site: 'BBB01', count: 1 }]);
    expect(r.truncated).toBe(false);
  });

  it('gives typical times, leaving out time spent on hold', async () => {
    const { t, from, to } = await seedReport();
    const r = await s.reports.report(t.t, from, to, true);
    expect(r.median_minutes_to_acknowledge).toBe(45); // 30, 30, 60 and 3600 minutes
    expect(r.median_hours_to_restore).toBe(5); // 1 (3h less 2h on hold), 5 (resolved without a restore), 6, and one still open
    expect(r.median_hours_to_resolve).toBe(5); // 3 (5h less 2h on hold), 5, 6
  });

  it('says how often each target was met: a target still running late counts as missed, no target is left out', async () => {
    const { t, from, to } = await seedReport();
    const r = await s.reports.report(t.t, from, to, true);
    // The P1's time on hold stretches its response target too, so its 30 minutes to acknowledge is on time.
    expect(r.on_time.response).toEqual({ met: 3, missed: 1, percent: 75 });
    expect(r.on_time.restoration).toEqual({ met: 2, missed: 1, percent: 67 }); // the P4 has no restoration target
    expect(r.on_time.resolution).toEqual({ met: 3, missed: 1, percent: 75 });
  });

  it("shows today's backlog by age, whenever the open incidents were raised", async () => {
    const { t, from, to } = await seedReport();
    const r = await s.reports.report(t.t, from, to, true);
    expect(r.backlog).toEqual({ under1d: 0, d1to3: 0, d3to7: 0, over7d: 2 });
    const r2 = await s.reports.report(t.t, '2020-01-01', '2020-02-01', true);
    expect(r2).toMatchObject({ raised: 0, resolved: 0 });
    expect(r2.backlog.over7d).toBe(2);
  });

  it('finds the same kind of incident at the same place again and again, and the problems behind them (for staff only)', async () => {
    const { t, from, to, i1, i2, i4 } = await seedReport();
    const p = await s.problems.create(t.t, eng, createProblemSchema.parse({ title: 'Reading wifi drops RTP' }));
    for (const i of [i2, i4, i1]) await s.problems.link(t.t, eng, i.id, { problemId: p.id });
    const staff = await s.reports.report(t.t, from, to, true);
    expect(staff.repeats).toEqual([{ category: 'call_quality', category_label: expect.stringContaining('Call quality'), sitecode: 'AAA01', count: 3, references: [i4.reference, i2.reference, i1.reference] }]);
    expect(staff.problems).toEqual([{ id: p.id, reference: p.reference, title: 'Reading wifi drops RTP', count: 3 }]);
    expect((await s.reports.report(t.t, from, to, false)).problems).toBeUndefined();
  });

  it('counts major incidents and reopens, and keeps a site contact to their own sites', async () => {
    const { t, from, to, i1, i2 } = await seedReport();
    await setRow(t, i2.id, { reopened_at: ago(5 * DAY) });
    await setRow(t, i1.id, { major: true, major_declared_at: ago(9 * DAY), lead_id: eng.id, comms_id: eng.id });
    const all = await s.reports.report(t.t, from, to, false);
    expect(all).toMatchObject({ major: 1, reopened: 1 });
    const siteBBB = (await t.s.selectFrom('discovery_sites').select('id').where('sitecode', '=', 'BBB01').executeTakeFirstOrThrow()).id;
    const scoped = await s.reports.report({ ...t.t, siteScope: [siteBBB] }, from, to, false);
    expect(scoped.raised).toBe(1);
    expect(scoped.by_site).toEqual([{ site: 'BBB01', count: 1 }]);
    await expect(s.reports.report({ ...t.t, managedServices: false }, from, to, false)).rejects.toBeInstanceOf(ForbiddenException);
  });
});

describe('the MSP console', () => {
  it("shows an MSP engineer every live incident across the MSP's customers, the most urgent first, and which they can open", async () => {
    const low = await raise(a, rdgA, { impact: 'individual', urgency: 'question' }); // P4
    const high = await raise(a, lonA, { impact: 'company', urgency: 'cannot_call' }); // P1
    const inB = await raise(b, siteB, { impact: 'site', urgency: 'degraded' }); // P2
    const q = await s.msp.queue(eng, { status: 'open' });
    expect(q.msp).toMatchObject({ id: mspId });
    expect(q.customers.map((c) => [c.name, c.can_open]).sort()).toEqual([['Acme', true], ['Beta', false]]);
    const ours = q.items.filter((i) => [low.id, high.id, inB.id].includes(i.id));
    expect(ours.map((i) => i.id)).toEqual([high.id, inB.id, low.id]); // P1, P2, P4
    expect(ours.find((i) => i.id === inB.id)).toMatchObject({ tenant_name: 'Beta', can_open: false, reference: inB.reference, sitecode: 'BHM01' });
    expect(ours[0]).toMatchObject({ tenant_name: 'Acme', can_open: true, reporter_name: 'Cara Customer', sla: { which: 'response' } });
    expect('pause_log' in ours[0]!).toBe(false);
  });

  it('puts live major incidents first, and filters to mine, to a priority, and to finished ones', async () => {
    const plain = await raise(a, rdgA, { impact: 'company', urgency: 'cannot_call' }); // P1
    const major = await raise(a, rdgA, { impact: 'individual', urgency: 'question' }); // P4 but a major incident
    await s.major.declare(a.t, eng, major.id, { leadId: eng.id, summary: 'Calls are failing at Reading.' });
    const q = await s.msp.queue(eng, { status: 'open' });
    const ids = q.items.map((i) => i.id);
    expect(ids.indexOf(major.id)).toBeLessThan(ids.indexOf(plain.id));
    expect(q.items.find((i) => i.id === major.id)).toMatchObject({ major: true, major_clock: { state: 'on_track' } });
    await s.svc.assign(a.t, eng, plain.id, { userId: eng.id });
    // (declaring a major incident makes its lead the assignee)
    expect((await s.msp.queue(eng, { status: 'open', mine: 'true' })).items.map((i) => i.id).sort()).toEqual([plain.id, major.id].sort());
    expect((await s.msp.queue(eng, { status: 'open', priority: 'p4' })).items.every((i) => i.priority === 'p4')).toBe(true);
    await s.svc.move(a.t, eng, plain.id, { to: 'resolved', note: 'Fixed' }, true);
    expect((await s.msp.queue(eng, { status: 'resolved' })).items.map((i) => i.id)).toContain(plain.id);
    expect((await s.msp.queue(eng, { status: 'open' })).items.map((i) => i.id)).toContain(plain.id); // awaiting confirmation is still "not closed"
  });

  it("shows an engineer outside the MSP nothing, and a Super Admin everything, optionally by MSP", async () => {
    const x = await raise(a, rdgA);
    expect(await s.msp.queue(stranger, { status: 'open' })).toEqual({ msp: null, customers: [], items: [] });
    const all = await s.msp.queue(admin, { status: 'open' });
    expect(all.items.map((i) => i.id)).toContain(x.id);
    expect(all.customers.every((c) => c.can_open)).toBe(true);
    expect((await s.msp.queue(admin, { status: 'open', mspId })).items.map((i) => i.id)).toContain(x.id);
    expect((await s.msp.queue(admin, { status: 'open', mspId: 'none' })).items.some((i) => i.id === x.id)).toBe(false);
  });

  it('lets someone on the customer team acknowledge, assign and reply from the queue, and no one else', async () => {
    const x = await raise(a, rdgA);
    await s.msp.move(eng, a.t.id, x.id, { to: 'in_progress' });
    expect((await a.s.selectFrom('incidents').select(['status', 'assigned_to']).where('id', '=', x.id).executeTakeFirstOrThrow())).toEqual({ status: 'in_progress', assigned_to: eng.id });
    expect((await s.msp.assignees(eng, a.t.id)).map((m) => m.display_name)).toEqual(expect.arrayContaining(['Eve Engineer', 'Ed Engineer']));
    await s.msp.assign(eng, a.t.id, x.id, { userId: eng2.id });
    await s.msp.comment(eng, a.t.id, x.id, { body: 'Looking now' });
    const g = await s.svc.get(a.t, x.id, true, eng.id);
    expect(g.incident.assigned_to).toBe(eng2.id);
    expect(g.events.some((e) => e.body === 'Looking now')).toBe(true);
    const y = await raise(b, siteB);
    await expect(s.msp.move(eng, b.t.id, y.id, { to: 'in_progress' })).rejects.toBeInstanceOf(ForbiddenException);
    await expect(s.msp.assign(eng, b.t.id, y.id, { userId: null })).rejects.toBeInstanceOf(ForbiddenException);
    await expect(s.msp.comment(cara, a.t.id, x.id, { body: 'x' })).rejects.toBeInstanceOf(ForbiddenException);
    expect((await s.msp.move(admin, b.t.id, y.id, { to: 'in_progress' })).status).toBe('in_progress'); // a Super Admin can
  });
});

describe('the major incident board', () => {
  it('lists live major incidents across customers with lead, comms owner, update clock, children and the latest update', async () => {
    const m = await raise(a, rdgA, { impact: 'company', urgency: 'cannot_call' });
    await s.major.declare(a.t, eng, m.id, { leadId: eng.id, commsId: eng2.id, summary: 'Calls at Reading are failing.', intervalMinutes: 15 });
    await s.major.postUpdate(a.t, eng2, m.id, { body: 'Carrier engaged.' });
    const kid = await raise(a, lonA);
    await s.major.linkChildren(a.t, eng, m.id, { childIds: [kid.id] });
    const finished = await raise(b, siteB, { impact: 'company', urgency: 'cannot_call' });
    await s.major.declare(b.t, admin, finished.id, { leadId: admin.id, summary: 'All calls failing.' });
    const board = await s.msp.board(eng, {});
    const mine = board.items.find((i) => i.id === m.id)!;
    expect(mine).toMatchObject({ tenant_name: 'Acme', lead_name: 'Eve Engineer', comms_name: 'Ed Engineer', children: 1, open_children: 1, can_open: true, update_interval_minutes: 15, latest_update: { body: 'Carrier engaged.' }, update_clock: { state: 'on_track' } });
    expect(board.items.find((i) => i.id === finished.id)).toMatchObject({ tenant_name: 'Beta', can_open: false });
    await s.svc.move(b.t, admin, finished.id, { to: 'resolved', note: 'Fixed' }, true);
    expect((await s.msp.board(eng, {})).items.some((i) => i.id === finished.id)).toBe(false);
    expect(await s.msp.board(stranger, {})).toEqual({ msp: null, items: [] });
  });
});
