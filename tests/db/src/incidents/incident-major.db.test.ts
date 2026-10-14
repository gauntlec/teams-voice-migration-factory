// Major incidents: declaring one with a lead and comms owner, the cadence of customer
// updates, child incidents, what ends it, the notice a customer sees, and the worker's
// reminders when an update is late.
import { BadRequestException, ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { platformDb } from '@tvmf/db';
import { createIncidentSchema, type CreateIncidentInput } from '@tvmf/shared';
import type { EnqueueMailInput } from '../../../../apps/api/src/mail/mail.service';
import { sweepIncidents } from '../../../../apps/worker/src/incidents';
import { seedCustomer, seedSite, seedUser, useDb, type TestCustomer } from '../helpers';
import { incidentServices } from './services';

const handle = useDb();
let c: TestCustomer;
let s: ReturnType<typeof incidentServices>;
let lead: Awaited<ReturnType<typeof seedUser>>;
let comms: Awaited<ReturnType<typeof seedUser>>;
let other: Awaited<ReturnType<typeof seedUser>>;
let cara: Awaited<ReturnType<typeof seedUser>>;
let dan: Awaited<ReturnType<typeof seedUser>>;
let sam: Awaited<ReturnType<typeof seedUser>>; // a named stakeholder who follows nothing
let rdg: string;
let lon: string;
let sent: EnqueueMailInput[] = [];

const call = (over: Partial<CreateIncidentInput> = {}) =>
  createIncidentSchema.parse({
    title: 'No audio on inbound calls',
    category: 'call_quality',
    subcategory: 'one_way_audio',
    siteId: rdg,
    impact: 'company',
    urgency: 'cannot_call',
    description: 'Everyone at Reading hears nothing on inbound calls.',
    answers: { where: 'In the office on wifi', how_often: 'Every call', started: 'Today 09:00' },
    ...over,
  });
const raise = (as = cara, over: Partial<CreateIncidentInput> = {}) => s.svc.create(c.t, as, call(over), false);
const row = (id: string) => c.s.selectFrom('incidents').selectAll().where('id', '=', id).executeTakeFirstOrThrow();
const set = (id: string, v: Record<string, unknown>) => c.s.updateTable('incidents').set(v as never).where('id', '=', id).execute();
const declare = (id: string, over: Record<string, unknown> = {}) => s.major.declare(c.t, lead, id, { leadId: lead.id, commsId: comms.id, summary: 'Calls at Reading are failing; we are checking the SBC.', ...over });
const mails = (template: string, ...users: { email: string }[]) => sent.filter((m) => m.template === template && (users.length === 0 || users.some((u) => u.email === m.to.email)));
const ctx = (m: EnqueueMailInput) => m.context as Record<string, unknown>;
const ago = (ms: number) => new Date(Date.now() - ms).toISOString();

beforeAll(async () => {
  c = await seedCustomer(handle, { managedServices: true });
  lead = await seedUser(handle, 'ENGINEER', { displayName: 'Lee Lead' });
  comms = await seedUser(handle, 'ENGINEER', { displayName: 'Cam Comms' });
  other = await seedUser(handle, 'ENGINEER', { displayName: 'Olly Other' });
  cara = await seedUser(handle, 'CUSTOMER', { displayName: 'Cara Customer' });
  dan = await seedUser(handle, 'CUSTOMER', { displayName: 'Dan Customer' });
  sam = await seedUser(handle, 'CUSTOMER', { displayName: 'Sam Stakeholder' });
  await platformDb(handle.db).insertInto('tenant_memberships').values([lead, comms, other, cara, dan, sam].map((u) => ({ tenant_id: c.t.id, user_id: u.id })) as never).execute();
  rdg = (await seedSite(c.s, { sitecode: 'RDG01', name: 'Reading' })).id;
  lon = (await seedSite(c.s, { sitecode: 'LON01', name: 'London' })).id;
  await c.s.updateTable('discovery_sites').set({ mode: 'operations' } as never).where('id', 'in', [rdg, lon]).execute();
  await platformDb(handle.db).updateTable('tenants').set({ inc_settings: JSON.stringify({ stakeholders: [sam.id] }) }).where('id', '=', c.t.id).execute();
  s = incidentServices(handle, { enqueue: async (i: EnqueueMailInput) => (sent.push(i), { id: 'm' }) });
});

beforeEach(() => {
  sent = [];
});

describe('declaring', () => {
  it('names a lead and a comms owner, starts the update clock at the cadence for its priority, and says what we know', async () => {
    const r = await raise();
    expect(r.priority).toBe('p1');
    await s.svc.watch(c.t, dan, r.id, undefined, false);
    sent = [];
    const m = await declare(r.id);
    expect(m).toMatchObject({ major: true, lead_id: lead.id, comms_id: comms.id, update_interval_minutes: 30, major_ended_at: null });
    expect(new Date(m.next_update_due_at!).getTime() - Date.now()).toBeGreaterThan(29 * 60_000);
    expect(m.assigned_to).toBe(lead.id); // the lead owns it when nobody did
    expect(m.acknowledged_at).not.toBeNull();
    const g = await s.svc.get(c.t, r.id, true, lead.id);
    const ev = g.events.find((e) => e.kind === 'major_declared')!;
    expect(ev).toMatchObject({ body: 'Calls at Reading are failing; we are checking the SBC.', internal: false });
    expect(g.major).toMatchObject({ active: true, lead_name: 'Lee Lead', comms_name: 'Cam Comms', interval_minutes: 30 });
  });

  it('tells the reporter, followers and named stakeholders, tells the team who is leading, and tells the lead and comms owner', async () => {
    const r = await raise();
    await s.svc.watch(c.t, dan, r.id, undefined, false);
    sent = [];
    await declare(r.id, { commsId: other.id });
    const customer = mails('incident_major', cara, dan, sam);
    expect(customer.map((x) => x.to.email).sort()).toEqual([cara.email, dan.email, sam.email].sort());
    expect(ctx(customer[0]!)).toMatchObject({ audience: 'customer', kind: 'declared', priorityLabel: 'critical', lead: 'Lee Lead', siteLabel: 'RDG01 — Reading' });
    expect(String(ctx(customer[0]!).nextUpdateText)).toMatch(/^We'll update you again by \d\d:\d\d UTC\.$/);
    const team = mails('incident_major', comms, other);
    expect(team.every((x) => ctx(x).audience === 'team')).toBe(true);
    expect(mails('incident_major', lead)).toHaveLength(0); // not the person who declared it
    expect(mails('incident_activity', other).map((x) => [ctx(x).kind, ctx(x).body])).toEqual([['major_assigned', 'the comms owner']]);
  });

  it('refuses a finished incident, one that is already major, a lead who is not staff, and one linked under another', async () => {
    const done = await raise();
    await s.svc.move(c.t, lead, done.id, { to: 'resolved', note: 'Fixed' }, true);
    await expect(declare(done.id)).rejects.toThrow(/open incident/);
    const r = await raise();
    await expect(declare(r.id, { leadId: cara.id })).rejects.toBeInstanceOf(BadRequestException);
    await expect(declare(r.id, { commsId: dan.id })).rejects.toBeInstanceOf(BadRequestException);
    await declare(r.id);
    await expect(declare(r.id)).rejects.toBeInstanceOf(ConflictException);
    const kid = await raise();
    await s.major.linkChildren(c.t, lead, r.id, { childIds: [kid.id] });
    await expect(declare(kid.id)).rejects.toThrow(/linked under another/);
  });

  it('can be declared again once a major incident is over', async () => {
    const r = await raise();
    await declare(r.id);
    await s.svc.move(c.t, lead, r.id, { to: 'resolved', note: 'Fixed' }, true);
    await s.svc.move(c.t, cara, r.id, { to: 'in_progress', note: 'Back again' }, false);
    expect((await declare(r.id)).major_ended_at).toBeNull();
  });
});

describe('customer updates', () => {
  it('reset the clock, can change the cadence, and go to the customer side', async () => {
    const r = await raise();
    await declare(r.id);
    await set(r.id, { next_update_due_at: ago(5 * 60_000), update_reminded_at: ago(1000) });
    sent = [];
    const m = await s.major.postUpdate(c.t, comms, r.id, { body: 'The carrier has confirmed a fault on their side.', intervalMinutes: 20 });
    expect(m.update_interval_minutes).toBe(20);
    expect(new Date(m.next_update_due_at!).getTime() - Date.now()).toBeGreaterThan(19 * 60_000);
    expect(new Date(m.next_update_due_at!).getTime() - Date.now()).toBeLessThan(21 * 60_000);
    expect(m.update_reminded_at).toBeNull();
    expect(ctx(mails('incident_major', cara)[0]!)).toMatchObject({ kind: 'update', body: 'The carrier has confirmed a fault on their side.' });
    expect(mails('incident_major', lead, comms)).toHaveLength(0); // customers only
    const g = await s.svc.get(c.t, r.id, false, cara.id);
    expect(g.events.filter((e) => e.kind === 'major_update').map((e) => e.body)).toEqual(['The carrier has confirmed a fault on their side.']);
  });

  it('are only for a live major incident', async () => {
    const r = await raise();
    await expect(s.major.postUpdate(c.t, lead, r.id, { body: 'Hello' })).rejects.toBeInstanceOf(BadRequestException);
  });

  it('can move the lead and the comms owner, telling only the person newly given the role', async () => {
    const r = await raise();
    await declare(r.id);
    sent = [];
    await s.major.setRoles(c.t, lead, r.id, { commsId: other.id });
    expect(mails('incident_activity', other).map((x) => ctx(x).body)).toEqual(['the comms owner']);
    expect(mails('incident_activity', comms)).toHaveLength(0);
    expect((await row(r.id)).comms_id).toBe(other.id);
    await expect(s.major.setRoles(c.t, lead, r.id, { leadId: cara.id })).rejects.toBeInstanceOf(BadRequestException);
  });
});

describe('child incidents', () => {
  it('are linked under a live major incident, and their reporters then hear its updates', async () => {
    const parent = await raise();
    const kid = await raise(dan, { siteId: lon });
    await declare(parent.id);
    const kids = await s.major.linkChildren(c.t, lead, parent.id, { childIds: [kid.id] });
    expect(kids).toMatchObject([{ id: kid.id, reference: kid.reference }]);
    expect((await row(kid.id)).parent_id).toBe(parent.id);
    const childEvents = (await s.svc.get(c.t, kid.id, false, dan.id)).events;
    expect(childEvents.some((e) => e.kind === 'child_linked' && /Part of major incident/.test(e.body ?? ''))).toBe(true);
    sent = [];
    await s.major.postUpdate(c.t, comms, parent.id, { body: 'Carrier engaged.' });
    expect(mails('incident_major', dan)).toHaveLength(1); // the child's reporter
    const staffView = await s.svc.get(c.t, parent.id, true, lead.id);
    expect(staffView.children.map((x) => x.id)).toEqual([kid.id]);
    expect((await s.svc.get(c.t, kid.id, false, dan.id)).parent).toMatchObject({ id: parent.id, reference: parent.reference });
  });

  it('are refused when finished, major themselves, the parent, parents themselves, or missing; and only under a live major', async () => {
    const parent = await raise();
    const plain = await raise(); // not a major incident
    const kid = await raise();
    await expect(s.major.linkChildren(c.t, lead, plain.id, { childIds: [kid.id] })).rejects.toThrow(/live major/);
    await declare(parent.id);
    await expect(s.major.linkChildren(c.t, lead, parent.id, { childIds: [parent.id] })).rejects.toThrow(/itself/);
    await expect(s.major.linkChildren(c.t, lead, parent.id, { childIds: ['00000000-0000-4000-8000-000000000000'] })).rejects.toThrow(/does not exist/);
    const finished = await raise();
    await s.svc.move(c.t, lead, finished.id, { to: 'cancelled', note: 'Raised in error' }, true);
    await expect(s.major.linkChildren(c.t, lead, parent.id, { childIds: [finished.id] })).rejects.toThrow(/already finished/);
    const another = await raise();
    await declare(another.id);
    await expect(s.major.linkChildren(c.t, lead, parent.id, { childIds: [another.id] })).rejects.toThrow(/major incident itself/);
    await s.major.linkChildren(c.t, lead, parent.id, { childIds: [kid.id] });
    const grand = await raise();
    await declare(grand.id);
    await expect(s.major.linkChildren(c.t, lead, grand.id, { childIds: [parent.id] })).rejects.toThrow(); // a major can't be a child
  });

  it('can be unlinked, and moved to another major incident', async () => {
    const a = await raise();
    const b = await raise();
    const kid = await raise();
    await declare(a.id);
    await declare(b.id);
    await s.major.linkChildren(c.t, lead, a.id, { childIds: [kid.id] });
    await s.major.linkChildren(c.t, lead, b.id, { childIds: [kid.id] });
    expect((await row(kid.id)).parent_id).toBe(b.id);
    expect(await s.major.unlinkChild(c.t, lead, b.id, kid.id)).toEqual([]);
    expect((await row(kid.id)).parent_id).toBeNull();
    await expect(s.major.unlinkChild(c.t, lead, b.id, kid.id)).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe('ending a major incident', () => {
  it('is what resolving it does: the clock stops and the customer side is told what fixed it', async () => {
    const r = await raise();
    await s.svc.watch(c.t, dan, r.id, undefined, false);
    await declare(r.id);
    sent = [];
    await s.svc.move(c.t, lead, r.id, { to: 'resolved', note: 'The carrier restored the trunk.' }, true);
    const done = await row(r.id);
    expect(done.major_ended_at).not.toBeNull();
    expect(done.next_update_due_at).toBeNull();
    const customer = mails('incident_major', cara, dan, sam);
    expect(customer).toHaveLength(3);
    expect(ctx(customer[0]!)).toMatchObject({ kind: 'resolved', body: 'The carrier restored the trunk.', nextUpdateText: null });
    expect(mails('incident_resolved', cara)).toHaveLength(1); // and the usual "is it fixed?"
    const g = await s.svc.get(c.t, r.id, true, lead.id);
    expect(g.events.some((e) => e.kind === 'major_ended')).toBe(true);
    expect(g.major).toMatchObject({ active: false });
    await expect(s.major.postUpdate(c.t, comms, r.id, { body: 'Late' })).rejects.toBeInstanceOf(BadRequestException);
  });

  it('can resolve the live child incidents with it, with the same note', async () => {
    const parent = await raise();
    const kid1 = await raise(dan, { siteId: lon });
    const kid2 = await raise(dan, { siteId: lon });
    await declare(parent.id);
    await s.major.linkChildren(c.t, lead, parent.id, { childIds: [kid1.id, kid2.id] });
    await s.svc.move(c.t, lead, kid2.id, { to: 'cancelled', note: 'Raised twice' }, true);
    await s.svc.move(c.t, lead, parent.id, { to: 'resolved', note: 'Trunk restored', resolveChildren: true }, true);
    expect((await row(kid1.id)).status).toBe('resolved');
    expect((await row(kid2.id)).status).toBe('cancelled'); // already finished: left alone
    const ev = (await s.svc.get(c.t, kid1.id, true, lead.id)).events.find((e) => e.to_status === 'resolved')!;
    expect(ev.body).toBe('Trunk restored');
  });

  it('leaves the children open when asked not to resolve them', async () => {
    const parent = await raise();
    const kid = await raise(dan, { siteId: lon });
    await declare(parent.id);
    await s.major.linkChildren(c.t, lead, parent.id, { childIds: [kid.id] });
    await s.svc.move(c.t, lead, parent.id, { to: 'resolved', note: 'Trunk restored' }, true);
    expect((await row(kid.id)).status).toBe('new');
  });

  it('is ended by cancelling it too, without telling customers it was resolved', async () => {
    const r = await raise();
    await declare(r.id);
    sent = [];
    await s.svc.move(c.t, lead, r.id, { to: 'cancelled', note: 'Raised in error' }, true);
    expect((await row(r.id)).major_ended_at).not.toBeNull();
    expect(mails('incident_major').filter((m) => ctx(m).kind === 'resolved')).toHaveLength(0);
  });
});

describe('the customer notice', () => {
  it('lists live major incidents with what we last said, and drops them when they end', async () => {
    const r = await raise();
    await declare(r.id);
    await s.major.postUpdate(c.t, comms, r.id, { body: 'Carrier engaged.' });
    const n = (await s.major.notices(c.t)).find((x) => x.id === r.id)!;
    expect(n).toMatchObject({ reference: r.reference, sitecode: 'RDG01', can_open: true, latest_update: { body: 'Carrier engaged.' } });
    expect(n.next_update_due_at).not.toBeNull();
    await s.svc.move(c.t, lead, r.id, { to: 'resolved', note: 'Fixed' }, true);
    expect((await s.major.notices(c.t)).some((x) => x.id === r.id)).toBe(false);
  });

  it('tells a site contact about their sites and about customer-wide ones, but only lets them open their own', async () => {
    const mine = await raise(cara, { siteId: rdg });
    const theirs = await raise(cara, { siteId: lon });
    const wide = await raise(cara, { category: 'direct_routing', subcategory: 'sbc_offline', siteId: null, answers: { symptom: ['All calls failing'], started: 'now' } });
    for (const x of [mine, theirs, wide]) await declare(x.id);
    const scoped = (await s.major.notices({ ...c.t, siteScope: [rdg] })).filter((x) => [mine.id, theirs.id, wide.id].includes(x.id));
    expect(scoped.map((x) => [x.id, x.can_open]).sort()).toEqual([[mine.id, true], [wide.id, false]].sort());
  });

  it('keeps the lead, comms owner and cadence out of the customer view of an incident', async () => {
    const r = await raise();
    await declare(r.id);
    const customer = await s.svc.get(c.t, r.id, false, cara.id);
    expect(customer.major).toMatchObject({ active: true, lead_name: 'Lee Lead', lead_id: undefined, comms_id: undefined, interval_minutes: undefined });
    for (const k of ['lead_id', 'comms_id', 'update_interval_minutes', 'update_reminded_at', 'update_escalated_at', 'problem_id']) expect(k in customer.incident).toBe(false);
    expect('lead_id' in (await s.svc.get(c.t, r.id, true, lead.id)).incident).toBe(true);
  });
});

describe('late updates (worker)', () => {
  const sweep = () => sweepIncidents(handle.db, (async (m: EnqueueMailInput) => (sent.push(m), { id: 'm' })) as never, { tenantId: c.t.id });

  it('reminds the comms owner when an update is due, and the lead and team when it is 15 minutes late, once each', async () => {
    const r = await raise();
    await declare(r.id);
    sent = []; // (declaring emails the lead and comms owner)
    await sweep();
    expect(sent.filter((m) => ctx(m).reference === r.reference && m.template === 'incident_activity')).toHaveLength(0); // not due yet
    await set(r.id, { next_update_due_at: ago(2 * 60_000) });
    sent = [];
    await sweep();
    const due = sent.filter((m) => ctx(m).reference === r.reference && ctx(m).kind === 'update_due');
    expect(due.map((m) => m.to.email)).toEqual([comms.email]);
    sent = [];
    await sweep();
    expect(sent.filter((m) => ctx(m).reference === r.reference)).toHaveLength(0); // once
    await set(r.id, { next_update_due_at: ago(20 * 60_000) });
    sent = [];
    await sweep();
    const late = sent.filter((m) => ctx(m).reference === r.reference && ctx(m).kind === 'update_overdue');
    expect(late.map((m) => m.to.email)).toEqual(expect.arrayContaining([lead.email, comms.email, other.email]));
    expect(String(ctx(late[0]!).body)).toBe('The update was due 20 minutes ago.');
    sent = [];
    await sweep();
    expect(sent.filter((m) => ctx(m).reference === r.reference && ctx(m).kind === 'update_overdue')).toHaveLength(0);
  });

  it('starts again after an update is posted, and stops once the incident is resolved', async () => {
    const r = await raise();
    await declare(r.id);
    await set(r.id, { next_update_due_at: ago(20 * 60_000) });
    await sweep();
    await s.major.postUpdate(c.t, comms, r.id, { body: 'Still working on it.' });
    sent = [];
    await sweep();
    expect(sent.filter((m) => ctx(m).reference === r.reference && m.template === 'incident_activity')).toHaveLength(0);
    await set(r.id, { next_update_due_at: ago(3 * 60_000) });
    await sweep();
    expect(sent.filter((m) => ctx(m).reference === r.reference && ctx(m).kind === 'update_due')).toHaveLength(1);
    await s.svc.move(c.t, lead, r.id, { to: 'resolved', note: 'Fixed' }, true);
    sent = [];
    await sweep();
    expect(sent.filter((m) => ctx(m).reference === r.reference && ['update_due', 'update_overdue'].includes(String(ctx(m).kind)))).toHaveLength(0);
  });
});

describe('who can do what', () => {
  it('keeps declaring to engineers: the controller needs inc:manage', async () => {
    const { can } = await import('@tvmf/shared');
    expect(can('CUSTOMER', 'inc:manage')).toBe(false);
    expect(can('PROJECT_MANAGER', 'inc:manage')).toBe(false);
    expect(can('ENGINEER', 'inc:manage')).toBe(true);
    await expect(s.major.postUpdate(c.t, comms, '00000000-0000-4000-8000-000000000000', { body: 'x' })).rejects.toBeInstanceOf(NotFoundException);
    await expect(s.major.declare({ ...c.t, managedServices: false }, lead, '00000000-0000-4000-8000-000000000000', { leadId: lead.id, summary: 'Calls are failing.' })).rejects.toBeInstanceOf(ForbiddenException);
  });
});
