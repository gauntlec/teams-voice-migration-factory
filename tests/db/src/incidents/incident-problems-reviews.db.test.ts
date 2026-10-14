// Problem records (root cause, workaround, known errors engineers can use on new
// incidents) and post-incident reviews (a draft for the team, shared with the
// customer when ready).
import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { platformDb } from '@tvmf/db';
import { createIncidentSchema, createProblemSchema, type CreateIncidentInput } from '@tvmf/shared';
import type { EnqueueMailInput } from '../../../../apps/api/src/mail/mail.service';
import { seedCustomer, seedSite, seedUser, useDb, type TestCustomer } from '../helpers';
import { incidentServices } from './services';

const handle = useDb();
let c: TestCustomer;
let s: ReturnType<typeof incidentServices>;
let eng: Awaited<ReturnType<typeof seedUser>>;
let cara: Awaited<ReturnType<typeof seedUser>>;
let dan: Awaited<ReturnType<typeof seedUser>>;
let sam: Awaited<ReturnType<typeof seedUser>>;
let siteId: string;
let sent: EnqueueMailInput[] = [];

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
const raise = (over: Partial<CreateIncidentInput> = {}) => s.svc.create(c.t, cara, call(over), false);
const problem = (over: Record<string, unknown> = {}) => s.problems.create(c.t, eng, createProblemSchema.parse({ title: 'SBC certificate renewal keeps slipping', ...over }));

beforeAll(async () => {
  c = await seedCustomer(handle, { managedServices: true });
  eng = await seedUser(handle, 'ENGINEER', { displayName: 'Eve Engineer' });
  cara = await seedUser(handle, 'CUSTOMER', { displayName: 'Cara Customer' });
  dan = await seedUser(handle, 'CUSTOMER', { displayName: 'Dan Customer' });
  sam = await seedUser(handle, 'CUSTOMER', { displayName: 'Sam Stakeholder' });
  await platformDb(handle.db).insertInto('tenant_memberships').values([eng, cara, dan, sam].map((u) => ({ tenant_id: c.t.id, user_id: u.id })) as never).execute();
  siteId = (await seedSite(c.s, { sitecode: 'RDG01' })).id;
  await c.s.updateTable('discovery_sites').set({ mode: 'operations' } as never).where('id', '=', siteId).execute();
  await platformDb(handle.db).updateTable('tenants').set({ inc_settings: JSON.stringify({ stakeholders: [sam.id] }) }).where('id', '=', c.t.id).execute();
  s = incidentServices(handle, { enqueue: async (i: EnqueueMailInput) => (sent.push(i), { id: 'm' }) });
});

beforeEach(() => {
  sent = [];
});

describe('problems', () => {
  it('are numbered per customer, and resolved ones keep the date they were resolved', async () => {
    const a = await problem();
    const b = await problem({ title: 'Wifi QoS markings stripped' });
    expect(b.number).toBe(a.number + 1);
    expect(a.reference).toMatch(/^PRB-\d{4}$/);
    expect(a.resolved_at).toBeNull();
    const fixed = await s.problems.update(c.t, eng, a.id, { status: 'resolved' });
    expect(fixed.resolved_at).not.toBeNull();
    const again = await s.problems.update(c.t, eng, a.id, { status: 'resolved', title: 'SBC certificate renewal (fixed)' });
    expect(new Date(again.resolved_at!).getTime()).toBe(new Date(fixed.resolved_at!).getTime());
    expect((await s.problems.update(c.t, eng, a.id, { status: 'investigating' })).resolved_at).toBeNull();
  });

  it('need an owner who is staff, and a category before a sub-category', async () => {
    await expect(problem({ ownerId: cara.id })).rejects.toBeInstanceOf(BadRequestException);
    await expect(problem({ subcategory: 'echo' })).rejects.toThrow(/category/);
    expect((await problem({ ownerId: eng.id })).owner_id).toBe(eng.id);
  });

  it('link to an incident, show how many incidents each explains, and unlink', async () => {
    const p = await problem();
    const i1 = await raise();
    const i2 = await raise();
    await s.problems.link(c.t, eng, i1.id, { problemId: p.id });
    await s.problems.link(c.t, eng, i2.id, { problemId: p.id });
    await s.svc.move(c.t, eng, i2.id, { to: 'resolved', note: 'Fixed' }, true);
    const row = (await s.problems.list(c.t)).find((x) => x.id === p.id)!;
    expect(row).toMatchObject({ incident_count: 2, open_incidents: 1, known_error: false });
    const detail = await s.problems.get(c.t, p.id);
    expect(detail.incidents.map((x) => x.id).sort()).toEqual([i1.id, i2.id].sort());
    await s.problems.link(c.t, eng, i1.id, { problemId: null });
    expect((await s.problems.get(c.t, p.id)).incidents).toHaveLength(1);
    const events = (await s.svc.get(c.t, i1.id, true, eng.id)).events.filter((e) => e.kind === 'problem_linked');
    expect(events.map((e) => [e.body?.startsWith('Linked to PRB-'), e.internal])).toEqual([[true, true], [false, true]]);
    await expect(s.problems.link(c.t, eng, i1.id, { problemId: '00000000-0000-4000-8000-000000000000' })).rejects.toBeInstanceOf(BadRequestException);
  });

  it('can be created from an incident and linked at once', async () => {
    const i = await raise();
    const p = await problem({ incidentId: i.id, title: 'Reading wifi drops RTP' });
    expect((await s.svc.get(c.t, i.id, true, eng.id)).problem).toMatchObject({ id: p.id, reference: p.reference, title: 'Reading wifi drops RTP' });
  });

  it("show the team the problem on an incident, and show customers nothing of it", async () => {
    const i = await raise();
    const p = await problem({ rootCause: 'Wifi QoS markings are stripped', workaround: 'Use wired handsets' });
    await s.problems.link(c.t, eng, i.id, { problemId: p.id });
    expect((await s.svc.get(c.t, i.id, true, eng.id)).problem).toMatchObject({ root_cause: 'Wifi QoS markings are stripped', workaround: 'Use wired handsets' });
    expect((await s.svc.get(c.t, i.id, false, cara.id)).problem).toBeNull();
  });

  describe('known errors', () => {
    it('match a new incident of their category (and sub-category when they name one), only while the cause is understood and there is a way round', async () => {
      const echo = await problem({ title: 'Echo on Yealink T54W', category: 'call_quality', subcategory: 'echo', status: 'known_error', workaround: 'Update the firmware', customerNote: 'Known issue: update your handset firmware.' });
      const anyQuality = await problem({ title: 'Reading wifi drops RTP', category: 'call_quality', status: 'fix_planned', workaround: 'Use wired handsets', customerNote: '' });
      await problem({ title: 'Still looking', category: 'call_quality', status: 'investigating', workaround: 'Maybe reboot' });
      await problem({ title: 'No workaround yet', category: 'call_quality', status: 'known_error', workaround: ' ' });
      await problem({ title: 'Other category', category: 'users', status: 'known_error', workaround: 'x' });
      const done = await problem({ title: 'Already fixed', category: 'call_quality', status: 'resolved', workaround: 'x' });
      const staffEcho = await s.problems.knownErrors(c.t, { category: 'call_quality', subcategory: 'echo' }, true);
      expect(staffEcho.map((p) => p.id).sort()).toEqual([echo.id, anyQuality.id].sort());
      expect(staffEcho.find((p) => p.id === echo.id)).toMatchObject({ workaround: 'Update the firmware', reference: echo.reference });
      const staffLatency = await s.problems.knownErrors(c.t, { category: 'call_quality', subcategory: 'latency' }, true);
      expect(staffLatency.map((p) => p.id)).toEqual([anyQuality.id]);
      expect(staffEcho.some((p) => p.id === done.id)).toBe(false);
    });

    it("give a customer only the title and the note written for them, never the workaround, and only where there is a note", async () => {
      const found = await s.problems.knownErrors(c.t, { category: 'call_quality', subcategory: 'echo' }, false);
      expect(found).toHaveLength(1);
      expect(found[0]).toMatchObject({ title: 'Echo on Yealink T54W', customer_note: 'Known issue: update your handset firmware.' });
      expect('workaround' in found[0]!).toBe(false);
      expect('root_cause' in found[0]!).toBe(false);
    });
  });

  it('refuse everything when Managed Services is off', async () => {
    await expect(s.problems.list({ ...c.t, managedServices: false })).rejects.toBeInstanceOf(ForbiddenException);
    await expect(s.problems.get(c.t, '00000000-0000-4000-8000-000000000000')).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe('post-incident reviews', () => {
  const review = { summary: 'The SBC certificate expired and calls to the PSTN failed for 90 minutes.', cause: 'The renewal reminder went to a mailbox nobody reads.', wentWell: 'The carrier fail-over worked.', wentBadly: 'It took 40 minutes to spot.', actions: [{ text: 'Renew the certificate 30 days early', owner: 'Ed', due: '2026-11-01' }, { text: 'Alert on certificate expiry' }] };

  it('start as a draft only the team can see, with the incident timeline built for them', async () => {
    const i = await raise();
    await s.svc.move(c.t, eng, i.id, { to: 'in_progress' }, true);
    await s.svc.comment(c.t, eng, i.id, { body: 'Looking at the SBC logs', internal: true }, true);
    await s.svc.comment(c.t, eng, i.id, { body: 'We have found the cause' }, true);
    expect((await s.reviews.get(c.t, i.id, true)).review).toBeNull();
    await s.reviews.put(c.t, eng, i.id, review);
    const staff = await s.reviews.get(c.t, i.id, true);
    expect(staff.review).toMatchObject({ status: 'draft', summary: review.summary, went_badly: 'It took 40 minutes to spot.', created_by_name: 'Eve Engineer' });
    expect(staff.review!.actions).toHaveLength(2);
    expect(staff.timeline.map((e) => e.text).filter(Boolean)).toEqual(['We have found the cause']); // no internal notes
    expect(staff.timeline.map((e) => e.kind)).toEqual(['created', 'status_changed', 'comment']);
    await expect(s.reviews.get(c.t, i.id, false)).rejects.toBeInstanceOf(NotFoundException);
    expect((await s.svc.get(c.t, i.id, false, cara.id)).review).toBeNull();
    expect((await s.svc.get(c.t, i.id, true, eng.id)).review).toMatchObject({ status: 'draft' });
  });

  it('can be rewritten while a draft, and are one per incident', async () => {
    const i = await raise();
    await s.reviews.put(c.t, eng, i.id, review);
    const r2 = await s.reviews.put(c.t, eng, i.id, { ...review, summary: 'Rewritten summary of what happened.' });
    expect(r2.summary).toBe('Rewritten summary of what happened.');
    expect(await c.s.selectFrom('incident_reviews').select('incident_id').where('incident_id', '=', i.id).execute()).toHaveLength(1);
  });

  it('need what happened and why before they can be shared, and cannot be shared twice', async () => {
    const i = await raise();
    await expect(s.reviews.share(c.t, eng, i.id)).rejects.toThrow(/Write the review first/);
    await s.reviews.put(c.t, eng, i.id, { ...review, cause: '' });
    await expect(s.reviews.share(c.t, eng, i.id)).rejects.toThrow(/what happened and why/);
    await s.reviews.put(c.t, eng, i.id, review);
    await s.reviews.share(c.t, eng, i.id);
    await expect(s.reviews.share(c.t, eng, i.id)).rejects.toThrow(/already been shared/);
  });

  it('are shared with the customer: visible, on the timeline, and emailed to the customer side and stakeholders', async () => {
    const i = await raise();
    await s.svc.watch(c.t, dan, i.id, undefined, false);
    await s.reviews.put(c.t, eng, i.id, review);
    sent = [];
    const shared = await s.reviews.share(c.t, eng, i.id);
    expect(shared).toMatchObject({ status: 'shared', shared_by: eng.id });
    const customer = await s.reviews.get(c.t, i.id, false);
    expect(customer.review).toMatchObject({ status: 'shared', cause: review.cause, shared_by_name: 'Eve Engineer' });
    expect((await s.svc.get(c.t, i.id, false, cara.id)).review).toMatchObject({ status: 'shared' });
    const mail = sent.filter((m) => m.template === 'incident_review');
    expect(mail.map((m) => m.to.email).sort()).toEqual([cara.email, dan.email, sam.email].sort());
    expect(mail[0]!.context).toMatchObject({ reference: i.reference, summary: review.summary, cause: review.cause });
    expect((mail[0]!.context as { actions: { text: string }[] }).actions.map((a) => a.text)).toEqual(['Renew the certificate 30 days early', 'Alert on certificate expiry']);
    expect((await s.svc.get(c.t, i.id, false, cara.id)).events.some((e) => e.kind === 'review_shared')).toBe(true);
  });

  it('keep a site contact to their own sites', async () => {
    const i = await raise();
    await s.reviews.put(c.t, eng, i.id, review);
    await s.reviews.share(c.t, eng, i.id);
    await expect(s.reviews.get({ ...c.t, siteScope: ['00000000-0000-4000-8000-000000000001'] }, i.id, false)).rejects.toBeInstanceOf(ForbiddenException);
  });
});
