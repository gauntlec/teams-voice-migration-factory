// Incidents by email (docs/INTAKE.md): a reply is the person it was sent to commenting; mail to the incidents address raises one
// for customers that switched it on; auto-replies, forgeries and repeats do nothing.
import { randomUUID } from 'node:crypto';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { platformDb } from '@tvmf/db';
import { createIncidentSchema, inboundTarget } from '@tvmf/shared';
import type { EnqueueMailInput } from '../../../../apps/api/src/mail/mail.service';
import { seedCustomer, seedSite, seedUser, useDb, type TestCustomer } from '../helpers';
import { incidentServices } from './services';

const handle = useDb();
let c: TestCustomer;
let s: ReturnType<typeof incidentServices>;
let admin: Awaited<ReturnType<typeof seedUser>>;
let eng: Awaited<ReturnType<typeof seedUser>>;
let cara: Awaited<ReturnType<typeof seedUser>>;
let dan: Awaited<ReturnType<typeof seedUser>>;
let siteId: string;
let sent: EnqueueMailInput[] = [];

const BASE = 'incidents@mail.test';
const call = (over = {}) =>
  createIncidentSchema.parse({ title: 'No audio on inbound calls', category: 'call_quality', subcategory: 'one_way_audio', siteId, impact: 'team', urgency: 'degraded', description: 'People hear nothing on inbound calls.', answers: { where: 'In the office on wifi', how_often: 'Every call', started: 'Today 09:00' }, ...over });
const raise = () => s.svc.create(c.t, cara, call(), false);
const email = (over: Record<string, unknown> = {}) => ({ messageId: `<${randomUUID()}@x>`, from: { email: cara.email }, to: [BASE], subject: 'Hello', text: 'Hi', authenticated: true, ...over });
const events = (id: string) => c.s.selectFrom('incident_events').selectAll().where('incident_id', '=', id).orderBy('created_at').execute();
const row = (id: string) => c.s.selectFrom('incidents').selectAll().where('id', '=', id).executeTakeFirstOrThrow();
const log = (messageId: string) => platformDb(handle.db).selectFrom('inbound_email_log').selectAll().where('message_id', '=', messageId).executeTakeFirstOrThrow();
/** The reply address an email to this person about this incident carries. */
const replyTo = async (incidentId: string, userId: string) => (await s.replies.replyTo(c.t.id, incidentId, userId))!;

beforeAll(async () => {
  c = await seedCustomer(handle, { managedServices: true });
  admin = await seedUser(handle, 'SUPER_ADMIN', { displayName: 'Ada Admin' });
  eng = await seedUser(handle, 'ENGINEER', { displayName: 'Eve Engineer' });
  cara = await seedUser(handle, 'CUSTOMER', { displayName: 'Cara Customer' });
  dan = await seedUser(handle, 'CUSTOMER', { displayName: 'Dan Customer' });
  await platformDb(handle.db).insertInto('tenant_memberships').values([eng, cara, dan].map((u) => ({ tenant_id: c.t.id, user_id: u.id })) as never).execute();
  siteId = (await seedSite(c.s, { sitecode: 'RDG01' })).id;
  await c.s.updateTable('discovery_sites').set({ mode: 'operations' } as never).execute();
  s = incidentServices(handle, { enqueue: async (i: EnqueueMailInput) => (sent.push(i), { id: 'm' }) });
});
beforeEach(async () => {
  sent = [];
  await platformDb(handle.db).updateTable('tenants').set({ inc_settings: JSON.stringify({}) } as never).where('id', '=', c.t.id).execute();
});

describe('reply addresses on outgoing email', () => {
  it('puts a per-person reply address on the customer-side emails, and none on the team\'s', async () => {
    const i = await raise();
    const reporter = sent.find((m) => m.template === 'incident_created' && (m.context as { audience?: string }).audience === 'reporter')!;
    expect(reporter.to.email).toBe(cara.email);
    expect(reporter.replyTo).toMatch(/^incidents\+[a-z2-7]{26}@mail\.test$/);
    const team = sent.filter((m) => m.template === 'incident_created' && (m.context as { audience?: string }).audience === 'team');
    expect(team.length).toBeGreaterThan(0);
    expect(team.every((m) => !m.replyTo)).toBe(true);
    // The same person gets the same address for the same incident; another person gets another.
    const again = await replyTo(i.id, cara.id);
    expect(again).toBe(reporter.replyTo);
    expect(await replyTo(i.id, dan.id)).not.toBe(again);
    await s.svc.comment(c.t, eng, i.id, { body: 'We are on it.' }, true);
    const msg = sent.find((m) => m.template === 'incident_message')!;
    expect(msg.replyTo).toBe(again);
  });
  it('is off when no inbound address is configured: no Reply-To, and mail posted to us is not acted on', async () => {
    sent = [];
    const off = incidentServices(handle, { enqueue: async (i: EnqueueMailInput) => (sent.push(i), { id: 'm' }) }, { inbound: false });
    const i = await off.svc.create(c.t, cara, call(), false);
    expect(sent.length).toBeGreaterThan(0);
    expect(sent.every((m) => !m.replyTo)).toBe(true);
    expect(await off.replies.replyTo(c.t.id, i.id, cara.id)).toBeUndefined();
    expect((await off.inbound.handle(email({ text: 'Hello' }))).outcome).toBe('disabled');
    expect(inboundTarget(['x@y.z'], BASE)).toBeNull();
  });
});

describe('replying', () => {
  it('a customer\'s reply is a comment on the incident, cleaned of the quoted thread', async () => {
    const i = await raise();
    const to = await replyTo(i.id, cara.id);
    const m = email({ to: [`Voxshift <${to}>`], subject: 'Re: [INC-0001] No audio', text: 'It is still happening, started again 10:15.\n\nOn Tue, 14 Oct 2026 at 09:30, Voxshift <incidents@mail.test> wrote:\n> We are looking at it.' });
    const r = await s.inbound.handle(m);
    expect(r).toMatchObject({ outcome: 'replied' });
    const ev = (await events(i.id)).filter((e) => e.kind === 'comment');
    expect(ev).toHaveLength(1);
    expect(ev[0]).toMatchObject({ internal: false, actor_type: 'user', author_id: cara.id, body: 'It is still happening, started again 10:15.' });
    expect((await log(m.messageId)).outcome).toBe('replied');
  });

  it('answers a question the team is waiting on, ending the wait', async () => {
    const i = await raise();
    await s.svc.comment(c.t, eng, i.id, { body: 'Which handsets?', waitForReply: true }, true);
    expect((await row(i.id)).status).toBe('on_hold');
    await s.inbound.handle(email({ to: [await replyTo(i.id, cara.id)], text: 'The Yealink ones.' }));
    expect(await row(i.id)).toMatchObject({ status: 'in_progress', hold_reason: null });
  });

  it('a team member\'s reply is an internal note, never a message to the customer', async () => {
    const i = await raise();
    const to = await replyTo(i.id, eng.id);
    const r = await s.inbound.handle(email({ from: { email: eng.email }, to: [to], text: 'Checking the SBC logs.' }));
    expect(r.outcome).toBe('noted');
    const note = (await events(i.id)).find((e) => e.kind === 'comment')!;
    expect(note).toMatchObject({ internal: true, author_id: eng.id, body: 'Checking the SBC logs.' });
  });

  it('only the person the email was sent to can use its address: a forward, a spoof and a stranger do nothing', async () => {
    const i = await raise();
    const to = await replyTo(i.id, cara.id);
    const forged = await s.inbound.handle(email({ from: { email: dan.email }, to: [to], text: 'I am Cara.' }));
    expect(forged.outcome).toBe('sender_mismatch');
    const stranger = await s.inbound.handle(email({ from: { email: 'someone@elsewhere.com' }, to: [to], text: 'Hi' }));
    expect(stranger.outcome).toBe('sender_mismatch');
    const unauth = await s.inbound.handle(email({ to: [to], authenticated: false, text: 'Hi' }));
    expect(unauth.outcome).toBe('unauthenticated');
    const bad = await s.inbound.handle(email({ to: ['incidents+aaaaaaaaaaaaaaaaaaaaaaaaaa@mail.test'], text: 'Hi' }));
    expect(bad.outcome).toBe('bad_token');
    expect((await events(i.id)).filter((e) => e.kind === 'comment')).toHaveLength(0);
  });

  it('drops auto-replies, repeats and empty replies, and does not post to a closed incident', async () => {
    const i = await raise();
    const to = await replyTo(i.id, cara.id);
    expect((await s.inbound.handle(email({ to: [to], subject: 'Automatic reply: INC-0001', text: 'I am away' }))).outcome).toBe('auto_reply');
    expect((await s.inbound.handle(email({ to: [to], headers: { 'Auto-Submitted': 'auto-replied' }, text: 'x' }))).outcome).toBe('auto_reply');
    const m = email({ to: [to], text: 'Real reply' });
    expect((await s.inbound.handle(m)).outcome).toBe('replied');
    expect((await s.inbound.handle(m)).outcome).toBe('duplicate');
    expect((await events(i.id)).filter((e) => e.kind === 'comment')).toHaveLength(1);
    expect((await s.inbound.handle(email({ to: [to], text: '> just quoted\n> text' }))).outcome).toBe('empty');
    await s.svc.move(c.t, eng, i.id, { to: 'cancelled', note: 'Withdrawn' } as never, true);
    expect((await s.inbound.handle(email({ to: [to], text: 'Late reply' }))).outcome).toBe('incident_closed');
  });

  it('a person who no longer belongs to the customer cannot comment with an old address', async () => {
    const i = await raise();
    const to = await replyTo(i.id, dan.id);
    await platformDb(handle.db).deleteFrom('tenant_memberships').where('user_id', '=', dan.id).where('tenant_id', '=', c.t.id).execute();
    expect((await s.inbound.handle(email({ from: { email: dan.email }, to: [to], text: 'Still me' }))).outcome).toBe('not_member');
    await platformDb(handle.db).insertInto('tenant_memberships').values({ tenant_id: c.t.id, user_id: dan.id } as never).execute();
  });
});

describe('raising by email', () => {
  it('is off until the customer switches it on', async () => {
    const r = await s.inbound.handle(email({ subject: 'Phones down', text: 'None of the phones at Reading work since 9.' }));
    expect(r.outcome).toBe('disabled');
    expect((await c.s.selectFrom('incidents').select('id').where('source', '=', 'email').execute())).toHaveLength(0);
  });

  it('raises an incident for a customer user, tied to them, with the subject as the title', async () => {
    await s.svc.updateSettings(c.t, admin, { emailIntake: true });
    expect((await s.svc.settings(c.t)).emailIntake).toBe(true);
    const r = await s.inbound.handle(email({ subject: 'RE: FWD: Phones down at Reading', text: 'None of the phones work since 9.\n\nThanks\n-- \nCara', attachments: 2 }));
    expect(r.outcome).toBe('raised');
    const i = await c.s.selectFrom('incidents').selectAll().where('number', '=', Number(r.incident!.replace('INC-', ''))).executeTakeFirstOrThrow();
    expect(i).toMatchObject({ source: 'email', title: 'Phones down at Reading', category: 'other', reporter_id: cara.id, status: 'new' });
    expect(i.description).toContain('None of the phones work since 9.');
    expect(i.description).toContain('2 attachments were not kept');
    expect(i.description).not.toContain('Cara\n');
    // She gets "we've got it" with an address to reply to; the team is told.
    const ack = sent.find((m) => m.template === 'incident_created' && m.to.email === cara.email)!;
    expect(ack.replyTo).toMatch(/^incidents\+/);
    expect(sent.some((m) => (m.context as { audience?: string }).audience === 'team')).toBe(true);
    // And a reply to that works.
    expect((await s.inbound.handle(email({ to: [ack.replyTo!], text: 'More: it is every phone.' }))).outcome).toBe('replied');
  });

  it('needs an authenticated user, and refuses strangers, a Super Admin who does not say which customer, and empty mail', async () => {
    await s.svc.updateSettings(c.t, admin, { emailIntake: true });
    expect((await s.inbound.handle(email({ authenticated: false, text: 'Phones down' }))).outcome).toBe('unauthenticated');
    expect((await s.inbound.handle(email({ from: { email: 'nobody@elsewhere.com' }, text: 'Phones down' }))).outcome).toBe('unknown_sender');
    expect((await s.inbound.handle(email({ from: { email: admin.email }, text: 'Phones down for Contoso' }))).outcome).toBe('ambiguous_customer');
    expect((await s.inbound.handle(email({ text: '> nothing new' }))).outcome).toBe('empty');
    expect((await s.inbound.handle(email({ to: ['sales@mail.test'], text: 'Phones down' }))).outcome).toBe('not_ours');
  });

  it('lets staff raise for a named customer, and a site contact only for their one site', async () => {
    await s.svc.updateSettings(c.t, admin, { emailIntake: true });
    const slug = c.t.slug;
    const staffRaise = await s.inbound.handle(email({ from: { email: eng.email }, to: [`incidents+${slug}@mail.test`], subject: 'Calls dropping at Reading', text: 'Several people report calls dropping.' }));
    expect(staffRaise.outcome).toBe('raised');
    const contact = await seedUser(handle, 'CUSTOMER', { displayName: 'Site Sam' });
    await platformDb(handle.db).insertInto('tenant_memberships').values({ tenant_id: c.t.id, user_id: contact.id, site_ids: [siteId] } as never).execute();
    const r = await s.inbound.handle(email({ from: { email: contact.email }, subject: 'No dial tone', text: 'No dial tone on the desk phones.' }));
    expect(r.outcome).toBe('raised');
    const i = await c.s.selectFrom('incidents').select(['site_id']).where('number', '=', Number(r.incident!.replace('INC-', ''))).executeTakeFirstOrThrow();
    expect(i.site_id).toBe(siteId);
    const two = await seedUser(handle, 'CUSTOMER', { displayName: 'Two Sites' });
    const other = (await seedSite(c.s, { sitecode: 'LON01' })).id;
    await platformDb(handle.db).insertInto('tenant_memberships').values({ tenant_id: c.t.id, user_id: two.id, site_ids: [siteId, other] } as never).execute();
    expect((await s.inbound.handle(email({ from: { email: two.email }, text: 'No dial tone' }))).outcome).toBe('site_ambiguous');
  });
});
