// Who is emailed about what on an incident: the reporter and followers hear what
// the team does, the team hears what the customer does, an internal note stays
// internal, "Is it fixed?" carries a signed link that answers without signing in,
// and a mail problem never fails the change.
import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { platformDb } from '@tvmf/db';
import { createIncidentSchema, type CreateIncidentInput } from '@tvmf/shared';
import { AuditService } from '../../../../apps/api/src/common/audit.service';
import type { AppConfig } from '../../../../apps/api/src/common/config';
import type { EnqueueMailInput, MailService } from '../../../../apps/api/src/mail/mail.service';
import { FilesService } from '../../../../apps/api/src/modules/files/files.service';
import { IncidentNotifier } from '../../../../apps/api/src/modules/incidents/incident-notifier';
import { signIncidentLink, verifyIncidentLink } from '../../../../apps/api/src/modules/incidents/incident-links';
import { IncidentResponseService } from '../../../../apps/api/src/modules/incidents/incident-response.service';
import { IncidentsService } from '../../../../apps/api/src/modules/incidents/incidents.service';
import { seedCustomer, seedSite, seedUser, useDb, type TestCustomer } from '../helpers';

const handle = useDb();
const SECRET = 'incident-secret-for-tests-0123456789';
let c: TestCustomer;
let svc: IncidentsService;
let response: IncidentResponseService;
let engineer: Awaited<ReturnType<typeof seedUser>>;
let engineer2: Awaited<ReturnType<typeof seedUser>>;
let cara: Awaited<ReturnType<typeof seedUser>>;
let dan: Awaited<ReturnType<typeof seedUser>>;
let eve: Awaited<ReturnType<typeof seedUser>>; // a customer user who isn't involved
let siteId: string;
let sent: EnqueueMailInput[] = [];
let failMail = false;

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
const raise = (as = cara, manage = false, over: Partial<CreateIncidentInput> = {}) => svc.create(c.t, as, call(over), manage);
const move = (id: string, input: Parameters<IncidentsService['move']>[3], as = engineer, manage = true) => svc.move(c.t, as, id, input, manage);
const to = (template: string, ...users: { email: string }[]) => sent.filter((m) => m.template === template && users.some((u) => u.email === m.to.email));
const ctx = (m: EnqueueMailInput) => m.context as Record<string, unknown>;
const tokenIn = (url: string) => new URL(url).searchParams.get('t')!;

beforeAll(async () => {
  c = await seedCustomer(handle, { managedServices: true });
  engineer = await seedUser(handle, 'ENGINEER', { displayName: 'Eve Engineer' });
  engineer2 = await seedUser(handle, 'ENGINEER', { displayName: 'Ed Engineer' });
  cara = await seedUser(handle, 'CUSTOMER', { displayName: 'Cara Customer' });
  dan = await seedUser(handle, 'CUSTOMER', { displayName: 'Dan Customer' });
  eve = await seedUser(handle, 'CUSTOMER', { displayName: 'Eve Stranger' });
  await platformDb(handle.db)
    .insertInto('tenant_memberships')
    .values([engineer, engineer2, cara, dan, eve].map((u) => ({ tenant_id: c.t.id, user_id: u.id })) as never)
    .execute();
  siteId = (await seedSite(c.s, { sitecode: 'RDG01', name: 'Reading' })).id;
  await c.s.updateTable('discovery_sites').set({ mode: 'operations' } as never).where('id', '=', siteId).execute();
  const mail = {
    enqueue: async (i: EnqueueMailInput) => {
      if (failMail) throw new Error('queue is down');
      sent.push(i);
      return { id: 'm' };
    },
  } as unknown as MailService;
  const cfg = { WEB_ORIGIN: 'https://app.test/', JWT_REFRESH_SECRET: SECRET } as AppConfig;
  svc = new IncidentsService(handle.db, new AuditService(handle.db), new FilesService(handle.db, { write: async () => {}, read: async () => Buffer.alloc(0), delete: async () => {}, exists: async () => true }), new IncidentNotifier(handle.db, mail, cfg));
  response = new IncidentResponseService(handle.db, cfg, svc);
});

beforeEach(() => {
  sent = [];
  failMail = false;
});

describe('raising', () => {
  it('thanks the reporter and tells the team, but not the person who raised it', async () => {
    const r = await raise();
    const reporter = to('incident_created', cara);
    expect(reporter).toHaveLength(1);
    expect(ctx(reporter[0]!)).toMatchObject({ audience: 'reporter', reference: r.reference, priorityLabel: 'medium', siteLabel: 'RDG01 — Reading' });
    expect(ctx(reporter[0]!).respondText).toBe('We aim to respond within 4 hours.');
    const team = to('incident_created', engineer, engineer2);
    expect(team.map((m) => m.to.email).sort()).toEqual([engineer.email, engineer2.email].sort());
    expect(ctx(team[0]!)).toMatchObject({ audience: 'team', priorityLabel: 'P3 Medium', raisedBy: 'Cara Customer' });
    expect((ctx(team[0]!).lines as { label: string }[]).map((l) => l.label)).toContain('When did it start?');
    expect(ctx(team[0]!).runUrl).toBe(`https://app.test/incidents/${r.id}`);
    expect(sent.every((m) => m.related?.type === 'incident' && m.related.id === r.id && m.tenantId === c.t.id)).toBe(true);
    expect(to('incident_created', dan)).toHaveLength(0);
  });

  it('does not thank a member of staff who raised it themselves', async () => {
    await raise(engineer, true);
    expect(to('incident_created', engineer)).toHaveLength(0);
    expect(to('incident_created', engineer2)).toHaveLength(1);
  });

  it('is not undone by a mail problem', async () => {
    failMail = true;
    const r = await raise();
    expect(r.reference).toMatch(/^INC-/);
    expect(sent).toHaveLength(0);
  });
});

describe('what the team does', () => {
  it('tells the reporter and followers when it is acknowledged, on hold with a third party, restored, closed', async () => {
    const r = await raise();
    await svc.watch(c.t, dan, r.id, undefined, false);
    sent = [];
    await move(r.id, { to: 'in_progress' });
    expect(to('incident_status_changed', cara, dan).map((m) => ctx(m).kind)).toEqual(['acknowledge', 'acknowledge']);
    expect(to('incident_status_changed', engineer)).toHaveLength(0);
    sent = [];
    await move(r.id, { to: 'on_hold', holdReason: 'carrier', note: 'Raised a fault with the carrier' });
    expect(ctx(to('incident_status_changed', cara)[0]!)).toMatchObject({ kind: 'hold', holdLabel: 'Waiting on your carrier', note: 'Raised a fault with the carrier' });
    sent = [];
    await move(r.id, { to: 'in_progress' });
    expect(sent).toHaveLength(0); // resuming is not news
    await move(r.id, { to: 'restored', note: 'Calls re-routed' });
    expect(ctx(to('incident_status_changed', cara)[0]!)).toMatchObject({ kind: 'restore', note: 'Calls re-routed' });
  });

  it('does not email a hold on the customer: the question that caused it does', async () => {
    const r = await raise();
    await move(r.id, { to: 'in_progress' });
    sent = [];
    await move(r.id, { to: 'on_hold', holdReason: 'customer' });
    expect(sent).toHaveLength(0);
    await svc.comment(c.t, engineer, r.id, { body: 'Which handsets are affected?', waitForReply: true }, true);
    expect(ctx(to('incident_message', cara)[0]!)).toMatchObject({ kind: 'question', author: 'Eve Engineer', body: 'Which handsets are affected?' });
  });

  it('sends public updates to the customer side and keeps internal notes internal', async () => {
    const r = await raise();
    await svc.watch(c.t, dan, r.id, undefined, false);
    await svc.assign(c.t, engineer, r.id, { userId: engineer2.id });
    sent = [];
    await svc.comment(c.t, engineer, r.id, { body: 'We are looking at the SBC' }, true);
    expect(to('incident_message', cara, dan).map((m) => ctx(m).kind)).toEqual(['comment', 'comment']);
    sent = [];
    await svc.comment(c.t, engineer, r.id, { body: 'Checking SBC logs', internal: true }, true);
    expect(to('incident_message', cara, dan)).toHaveLength(0);
    expect(sent.map((m) => [m.template, m.to.email])).toEqual([['incident_activity', engineer2.email]]); // just the assignee
    expect(ctx(sent[0]!).kind).toBe('internal_note');
  });

  it('tells the customer side the priority changed but never why', async () => {
    const r = await raise();
    sent = [];
    await svc.setPriority(c.t, engineer, r.id, { priority: 'p1', reason: 'The CEO is affected' });
    const m = to('incident_status_changed', cara)[0]!;
    expect(ctx(m)).toMatchObject({ kind: 'priority', priorityText: 'critical' });
    expect(JSON.stringify(m.context)).not.toContain('CEO');
  });

  it('tells a new assignee, but not someone assigning themselves', async () => {
    const r = await raise();
    sent = [];
    await svc.assign(c.t, engineer, r.id, { userId: engineer2.id });
    expect(to('incident_activity', engineer2).map((m) => ctx(m).kind)).toEqual(['assigned']);
    sent = [];
    await svc.assign(c.t, engineer, r.id, { userId: engineer.id });
    expect(sent).toHaveLength(0);
  });

  it('emails other statuses to followers too: cancelled by staff, a duplicate, a reopen', async () => {
    const a = await raise();
    const b = await raise();
    sent = [];
    await move(b.id, { to: 'duplicate', note: 'Same fault', duplicateOf: a.id });
    expect(ctx(to('incident_status_changed', cara)[0]!).kind).toBe('duplicate');
    sent = [];
    await move(a.id, { to: 'cancelled', note: 'Raised in error' });
    expect(ctx(to('incident_status_changed', cara)[0]!)).toMatchObject({ kind: 'cancel', note: 'Raised in error' });
  });
});

describe('what the customer does', () => {
  it('tells the assignee, or the whole team when nobody has it', async () => {
    const r = await raise();
    sent = [];
    await svc.comment(c.t, cara, r.id, { body: 'It is happening again' }, false);
    expect(to('incident_activity', engineer, engineer2)).toHaveLength(2);
    await svc.assign(c.t, engineer, r.id, { userId: engineer2.id });
    sent = [];
    await svc.comment(c.t, cara, r.id, { body: 'Still happening' }, false);
    expect(to('incident_activity', engineer, engineer2).map((m) => m.to.email)).toEqual([engineer2.email]);
  });

  it('calls a reply to a question a reply', async () => {
    const r = await raise();
    await move(r.id, { to: 'in_progress' });
    await svc.comment(c.t, engineer, r.id, { body: 'Which handsets?', waitForReply: true }, true);
    sent = [];
    await svc.comment(c.t, cara, r.id, { body: 'Yealink T54W' }, false);
    expect(to('incident_activity', engineer).map((m) => ctx(m).kind)).toEqual(['replied']);
  });

  it('tells the team when the customer cancels, confirms a fix, or says it is still broken', async () => {
    const x = await raise();
    sent = [];
    await move(x.id, { to: 'cancelled' }, cara, false);
    expect(to('incident_activity', engineer).map((m) => ctx(m).kind)).toEqual(['cancelled']);

    const y = await raise();
    await move(y.id, { to: 'resolved', note: 'Fixed' });
    sent = [];
    await move(y.id, { to: 'closed' }, cara, false);
    expect(to('incident_activity', engineer).map((m) => ctx(m).kind)).toEqual(['confirmed']);

    const z = await raise();
    await move(z.id, { to: 'resolved', note: 'Fixed' });
    sent = [];
    await move(z.id, { to: 'in_progress', note: 'Still no audio' }, cara, false);
    expect(ctx(to('incident_activity', engineer)[0]!)).toMatchObject({ kind: 'reopened', body: 'Still no audio' });
  });
});

describe('"Is it fixed?"', () => {
  it('goes to the reporter and each follower with their own signed links', async () => {
    const r = await raise();
    await svc.watch(c.t, dan, r.id, undefined, false);
    await move(r.id, { to: 'in_progress' });
    sent = [];
    await move(r.id, { to: 'resolved', note: 'Replaced the expired certificate' });
    const mails = to('incident_resolved', cara, dan);
    expect(mails).toHaveLength(2);
    for (const m of mails) {
      const x = ctx(m);
      expect(x).toMatchObject({ note: 'Replaced the expired certificate', author: 'Eve Engineer', autoCloseDays: 5 });
      const payload = verifyIncidentLink(SECRET, tokenIn(x.fixedUrl as string))!;
      expect(payload).toMatchObject({ t: c.t.id, i: r.id, u: m.to.email === cara.email ? cara.id : dan.id });
      expect(x.fixedUrl).toContain('/incident-response?t=');
      expect(x.fixedUrl).toContain('&a=fixed');
      expect(x.brokenUrl).toContain('&a=broken');
    }
    expect(tokenIn(ctx(mails[0]!).fixedUrl as string)).not.toBe(tokenIn(ctx(mails[1]!).fixedUrl as string));
  });

  describe('the answer links', () => {
    const resolved = async () => {
      const r = await raise();
      await svc.watch(c.t, dan, r.id, undefined, false);
      sent = [];
      await move(r.id, { to: 'resolved', note: 'Fixed' });
      return { r, caraToken: tokenIn(ctx(to('incident_resolved', cara)[0]!).fixedUrl as string), danToken: tokenIn(ctx(to('incident_resolved', dan)[0]!).fixedUrl as string) };
    };

    it('show only what the page needs, and change nothing', async () => {
      const { r, caraToken } = await resolved();
      expect(await response.preview(caraToken)).toMatchObject({ customerName: 'Contoso', person: 'Cara Customer', reference: r.reference, status: 'resolved', canAnswer: true });
      expect((await c.s.selectFrom('incidents').select('status').where('id', '=', r.id).executeTakeFirstOrThrow()).status).toBe('resolved');
    });

    it('close the incident when someone says it is fixed, and saying so twice is harmless', async () => {
      const { r, caraToken, danToken } = await resolved();
      expect(await response.respond({ t: caraToken, action: 'fixed' })).toMatchObject({ status: 'closed', already: false });
      expect(await response.respond({ t: danToken, action: 'fixed' })).toMatchObject({ status: 'closed', already: true });
      expect((await response.preview(caraToken)).canAnswer).toBe(true); // can still say "broken" within the week
      const events = await c.s.selectFrom('incident_events').select(['kind', 'author_id']).where('incident_id', '=', r.id).where('kind', '=', 'status_changed').orderBy('created_at').execute();
      expect(events.at(-1)!.author_id).toBe(cara.id);
    });

    it('reopen it when someone says it is still broken, with what is wrong', async () => {
      const { r, danToken } = await resolved();
      await expect(response.respond({ t: danToken, action: 'broken' })).rejects.toBeInstanceOf(BadRequestException);
      expect(await response.respond({ t: danToken, action: 'broken', note: 'Still no audio on the 2nd floor' })).toMatchObject({ status: 'in_progress', already: false });
      expect(await response.respond({ t: danToken, action: 'broken', note: 'again' })).toMatchObject({ already: true });
      const g = await svc.get(c.t, r.id, true, engineer.id);
      expect(g.events.some((e) => e.body === 'Still no audio on the 2nd floor')).toBe(true);
    });

    it('refuse a forged, tampered or expired link', async () => {
      const { caraToken } = await resolved();
      await expect(response.preview('nonsense')).rejects.toBeInstanceOf(BadRequestException);
      await expect(response.preview(`${caraToken.slice(0, -2)}xx`)).rejects.toBeInstanceOf(BadRequestException);
      const [body] = caraToken.split('.');
      await expect(response.preview(`${body}.${'a'.repeat(43)}`)).rejects.toBeInstanceOf(BadRequestException);
      const expired = signIncidentLink(SECRET, { t: c.t.id, i: 'x', u: cara.id }, Date.now() - 15 * 86_400_000);
      await expect(response.preview(expired)).rejects.toBeInstanceOf(BadRequestException);
      const wrongKey = signIncidentLink('another-secret-another-secret-123', { t: c.t.id, i: 'x', u: cara.id });
      await expect(response.preview(wrongKey)).rejects.toBeInstanceOf(BadRequestException);
    });

    it('do not let someone who is not the reporter or a follower answer', async () => {
      const { r } = await resolved();
      const forStranger = signIncidentLink(SECRET, { t: c.t.id, i: r.id, u: eve.id });
      await expect(response.respond({ t: forStranger, action: 'fixed' })).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('do not work once the incident has been closed for over a week', async () => {
      const { r, caraToken } = await resolved();
      await response.respond({ t: caraToken, action: 'fixed' });
      await c.s.updateTable('incidents').set({ resolved_at: new Date(Date.now() - 8 * 86_400_000).toISOString() } as never).where('id', '=', r.id).execute();
      expect((await response.preview(caraToken)).canAnswer).toBe(false);
      await expect(response.respond({ t: caraToken, action: 'broken', note: 'too late' })).rejects.toThrow(/7 days/);
    });
  });
});
