// Incident management against a real Postgres: numbering, who can raise what,
// the status workflow and who may make each move, the clocks pausing while on
// hold, what a customer is (and is not) shown, and site-contact scoping.
import { BadRequestException, ConflictException, ForbiddenException } from '@nestjs/common';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { createIncidentSchema, type CreateIncidentInput } from '@tvmf/shared';
import { AuditService } from '../../../../apps/api/src/common/audit.service';
import { FilesService } from '../../../../apps/api/src/modules/files/files.service';
import { IncidentsService } from '../../../../apps/api/src/modules/incidents/incidents.service';
import { seedCustomer, seedSite, seedUser, useDb, type TestCustomer } from '../helpers';

const handle = useDb();
let c: TestCustomer;
let svc: IncidentsService;
let engineer: Awaited<ReturnType<typeof seedUser>>;
let engineer2: Awaited<ReturnType<typeof seedUser>>;
let cara: Awaited<ReturnType<typeof seedUser>>;
let dan: Awaited<ReturnType<typeof seedUser>>;
let live: string; // an operations-mode site
let project: string; // a project-mode site
let other: string; // a second operations-mode site

const call = (over: Partial<CreateIncidentInput> = {}): CreateIncidentInput =>
  createIncidentSchema.parse({
    title: 'No audio on inbound calls',
    category: 'call_quality',
    subcategory: 'one_way_audio',
    siteId: live,
    impact: 'team',
    urgency: 'degraded',
    description: 'People at Reading hear nothing on inbound calls.',
    answers: { where: 'In the office on wifi', how_often: 'Every call', started: 'Today 09:00' },
    ...over,
  });

const raise = (over: Partial<CreateIncidentInput> = {}, as = cara, manage = false) => svc.create(c.t, as, call(over), manage);
const move = (id: string, input: Parameters<IncidentsService['move']>[3], as = engineer, manage = true) => svc.move(c.t, as, id, input, manage);
const row = (id: string) => c.s.selectFrom('incidents').selectAll().where('id', '=', id).executeTakeFirstOrThrow();
const scoped = (ids: string[]) => ({ ...c.t, siteScope: ids });

beforeAll(async () => {
  c = await seedCustomer(handle, { managedServices: true });
  engineer = await seedUser(handle, 'ENGINEER', { displayName: 'Eve Engineer' });
  engineer2 = await seedUser(handle, 'ENGINEER', { displayName: 'Ed Engineer' });
  cara = await seedUser(handle, 'CUSTOMER', { displayName: 'Cara Customer' });
  dan = await seedUser(handle, 'CUSTOMER', { displayName: 'Dan Customer' });
  const { platformDb } = await import('@tvmf/db');
  await platformDb(handle.db)
    .insertInto('tenant_memberships')
    .values([engineer, engineer2, cara, dan].map((u) => ({ tenant_id: c.t.id, user_id: u.id })) as never)
    .execute();
  live = (await seedSite(c.s, { sitecode: 'RDG01' })).id;
  other = (await seedSite(c.s, { sitecode: 'LON01' })).id;
  project = (await seedSite(c.s, { sitecode: 'NEW01' })).id;
  await c.s.updateTable('discovery_sites').set({ mode: 'operations' } as never).where('id', 'in', [live, other]).execute();
  svc = new IncidentsService(handle.db, new AuditService(handle.db), new FilesService(handle.db, { write: async () => {}, read: async () => Buffer.alloc(0), delete: async () => {}, exists: async () => true }));
});

describe('raising an incident', () => {
  it('numbers incidents per customer and works the priority out from impact and urgency', async () => {
    const a = await raise();
    const b = await raise({ impact: 'individual', urgency: 'question' });
    expect(b.number).toBe(a.number + 1);
    expect(a.reference).toMatch(/^INC-\d{4}$/);
    expect(a.priority).toBe('p3'); // team + degraded
    expect(b.priority).toBe('p4');
    expect(a.status).toBe('new');
    expect(a.source).toBe('customer');
  });

  it('makes emergency calling P1 whatever was picked', async () => {
    const e = await raise({
      category: 'emergency',
      subcategory: 'call_failed',
      impact: 'individual',
      urgency: 'question',
      answers: { what_happened: '999 equivalent would not connect', call_attempted: true, started: 'Today 10:00' },
    });
    expect(e.priority).toBe('p1');
  });

  it("uses the customer's own matrix", async () => {
    const m = await seedCustomer(handle, { managedServices: true });
    const { platformDb } = await import('@tvmf/db');
    await platformDb(handle.db).updateTable('tenants').set({ inc_settings: JSON.stringify({ matrix: { team: { degraded: 'p1' } } }) }).where('id', '=', m.t.id).execute();
    const site = await seedSite(m.s, { sitecode: 'X01' });
    await m.s.updateTable('discovery_sites').set({ mode: 'operations' } as never).where('id', '=', site.id).execute();
    const r = await svc.create(m.t, cara, call({ siteId: site.id }), false);
    expect(r.priority).toBe('p1');
  });

  it('refuses a site still in project mode, and a priority set by a customer', async () => {
    await expect(raise({ siteId: project })).rejects.toThrow(/project mode/);
    await expect(raise({ priority: 'p1' })).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('lets staff set the priority and records that it was overridden', async () => {
    const r = await raise({ priority: 'p2' }, engineer, true);
    expect(r.priority).toBe('p2');
    expect(r.priority_overridden).toBe(true);
    expect(r.source).toBe('staff');
  });

  it('lets a customer-wide category go without a site, but a site contact cannot', async () => {
    const dr = { category: 'direct_routing', subcategory: 'sbc_offline', siteId: null, answers: { symptom: ['All calls failing'], started: 'now' } } as const;
    expect((await raise({ ...dr })).site_id).toBeNull();
    await expect(svc.create(scoped([live]), cara, call({ ...dr }), false)).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('refuses when Managed Services is off', async () => {
    const off = await seedCustomer(handle, { managedServices: false });
    await expect(svc.list(off.t, cara, { status: 'open', limit: 10 })).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('stores the details, items and a created event', async () => {
    const r = await raise({
      exampleCalls: [{ at: 'about 10:15', direction: 'inbound', from: '+441189000001', to: '+441189000002', note: 'silent' }],
      contactPhone: '+441189000009',
      items: [{ kind: 'user', ref: 'jo@contoso.test', label: 'Jo Bloggs' }, { kind: 'user', ref: 'jo@contoso.test' }],
    });
    const full = await svc.get(c.t, r.id, true, engineer.id);
    expect(full.incident.details.example_calls).toHaveLength(1);
    expect(full.incident.details.contact_phone).toBe('+441189000009');
    expect(full.items).toHaveLength(1);
    expect(full.events.map((e) => e.kind)).toEqual(['created']);
  });
});

describe('the workflow', () => {
  it('acknowledging assigns the engineer and stops the response clock', async () => {
    const r = await raise();
    const m = await move(r.id, { to: 'in_progress' });
    expect(m.status).toBe('in_progress');
    const after = await row(r.id);
    expect(after.assigned_to).toBe(engineer.id);
    expect(after.acknowledged_at).not.toBeNull();
    expect(after.version).toBeGreaterThan(r.version);
    const g = await svc.get(c.t, r.id, true, engineer.id);
    expect(g.sla.response.state).toBe('met');
  });

  it('keeps an existing assignee when someone else acknowledges', async () => {
    const r = await raise();
    await svc.assign(c.t, engineer, r.id, { userId: engineer2.id });
    await move(r.id, { to: 'in_progress' });
    expect((await row(r.id)).assigned_to).toBe(engineer2.id);
  });

  it('only assigns to staff on this customer', async () => {
    const r = await raise();
    await expect(svc.assign(c.t, engineer, r.id, { userId: cara.id })).rejects.toBeInstanceOf(BadRequestException);
  });

  it('needs a reason to go on hold, and says what each finish needs', async () => {
    const r = await raise();
    await move(r.id, { to: 'in_progress' });
    await expect(move(r.id, { to: 'on_hold' })).rejects.toThrow(/waiting on/);
    await expect(move(r.id, { to: 'restored' })).rejects.toThrow(/how service was restored/);
    await expect(move(r.id, { to: 'resolved' })).rejects.toThrow(/what fixed it/);
    await expect(move(r.id, { to: 'closed' })).rejects.toThrow(/can't be moved/);
  });

  it('pauses the clocks while on hold and banks the time when it resumes', async () => {
    const r = await raise();
    await move(r.id, { to: 'in_progress' });
    await move(r.id, { to: 'on_hold', holdReason: 'carrier' });
    let h = await row(r.id);
    expect(h.paused_since).not.toBeNull();
    // Pretend the hold started an hour ago.
    await c.s.updateTable('incidents').set({ paused_since: new Date(Date.now() - 3_600_000).toISOString() } as never).where('id', '=', r.id).execute();
    await move(r.id, { to: 'in_progress' });
    h = await row(r.id);
    expect(h.paused_since).toBeNull();
    expect(h.hold_reason).toBeNull();
    expect(h.paused_seconds).toBeGreaterThanOrEqual(3599);
  });

  it('does not pause a P1 held on the carrier', async () => {
    const r = await raise({ impact: 'company', urgency: 'cannot_call' });
    expect(r.priority).toBe('p1');
    await move(r.id, { to: 'on_hold', holdReason: 'carrier' });
    expect((await row(r.id)).paused_since).toBeNull();
    await move(r.id, { to: 'in_progress' });
    await move(r.id, { to: 'on_hold', holdReason: 'customer' });
    expect((await row(r.id)).paused_since).not.toBeNull();
  });

  it('restores, resolves, and lets the customer confirm it closed', async () => {
    const r = await raise();
    await move(r.id, { to: 'in_progress' });
    await move(r.id, { to: 'restored', note: 'Re-routed via the second SBC' });
    expect((await row(r.id)).restored_at).not.toBeNull();
    await move(r.id, { to: 'resolved', note: 'Replaced the expired certificate' });
    const g = await svc.get(c.t, r.id, false, cara.id);
    expect(g.can.confirmFixed).toBe(true);
    await move(r.id, { to: 'closed' }, cara, false);
    const done = await row(r.id);
    expect(done.status).toBe('closed');
    expect(done.closed_at).not.toBeNull();
  });

  it('lets the reporter say "still broken" and restarts the clocks', async () => {
    const r = await raise();
    await move(r.id, { to: 'in_progress' });
    await move(r.id, { to: 'resolved', note: 'Changed the policy' });
    await expect(move(r.id, { to: 'in_progress' }, cara, false)).rejects.toThrow(/still wrong/);
    await move(r.id, { to: 'in_progress', note: 'Still no audio' }, cara, false);
    const again = await row(r.id);
    expect(again.status).toBe('in_progress');
    expect(again.resolved_at).toBeNull();
    expect(again.reopened_at).not.toBeNull();
    expect(again.paused_seconds).toBe(0);
  });

  it('will not reopen after seven days', async () => {
    const r = await raise();
    await move(r.id, { to: 'resolved', note: 'Fixed' });
    await c.s.updateTable('incidents').set({ resolved_at: new Date(Date.now() - 8 * 86_400_000).toISOString() } as never).where('id', '=', r.id).execute();
    await expect(move(r.id, { to: 'in_progress', note: 'Back again' }, cara, false)).rejects.toThrow(/7 days/);
  });

  it('keeps customers to cancelling their own New incident, confirming and reopening', async () => {
    const mine = await raise();
    await expect(move(mine.id, { to: 'in_progress' }, cara, false)).rejects.toBeInstanceOf(ForbiddenException);
    await expect(move(mine.id, { to: 'cancelled' }, dan, false)).rejects.toBeInstanceOf(ForbiddenException);
    await move(mine.id, { to: 'cancelled' }, cara, false);
    expect((await row(mine.id)).status).toBe('cancelled');
    const busy = await raise();
    await move(busy.id, { to: 'in_progress' });
    await expect(move(busy.id, { to: 'cancelled' }, cara, false)).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('lets a watcher confirm a fix', async () => {
    const r = await raise();
    await move(r.id, { to: 'resolved', note: 'Fixed' });
    await expect(move(r.id, { to: 'closed' }, dan, false)).rejects.toBeInstanceOf(ForbiddenException);
    await svc.watch(c.t, dan, r.id, undefined, false);
    await move(r.id, { to: 'closed' }, dan, false);
    expect((await row(r.id)).status).toBe('closed');
  });

  it('marks a duplicate against another incident only', async () => {
    const a = await raise();
    const b = await raise();
    await expect(move(b.id, { to: 'duplicate', note: 'Same fault' })).rejects.toThrow(/Choose the incident/);
    await expect(move(b.id, { to: 'duplicate', note: 'Same fault', duplicateOf: b.id })).rejects.toThrow(/itself/);
    await move(b.id, { to: 'duplicate', note: 'Same fault', duplicateOf: a.id });
    const done = await row(b.id);
    expect(done.status).toBe('duplicate');
    expect(done.duplicate_of).toBe(a.id);
    const g = await svc.get(c.t, b.id, true, engineer.id);
    expect(g.sla.response.state).toBe('stopped');
  });

  it('refuses a change made from a stale copy', async () => {
    const r = await raise();
    const stale = await row(r.id);
    await move(r.id, { to: 'in_progress' }); // someone else got there first
    vi.spyOn(svc as unknown as { load: () => Promise<unknown> }, 'load').mockResolvedValueOnce(stale);
    await expect(move(r.id, { to: 'on_hold', holdReason: 'vendor' })).rejects.toBeInstanceOf(ConflictException);
    expect((await row(r.id)).status).toBe('in_progress');
  });
});

describe('conversation', () => {
  it('keeps internal notes from customers, and from customers who try to write one', async () => {
    const r = await raise();
    await svc.comment(c.t, engineer, r.id, { body: 'Checking the SBC logs', internal: true }, true);
    await svc.comment(c.t, engineer, r.id, { body: 'We are looking at the SBC' }, true);
    await expect(svc.comment(c.t, cara, r.id, { body: 'sneaky', internal: true }, false)).rejects.toBeInstanceOf(ForbiddenException);
    const staff = await svc.get(c.t, r.id, true, engineer.id);
    const customer = await svc.get(c.t, r.id, false, cara.id);
    expect(staff.events.filter((e) => e.kind === 'comment')).toHaveLength(2);
    expect(customer.events.filter((e) => e.kind === 'comment').map((e) => e.body)).toEqual(['We are looking at the SBC']);
  });

  it('counts the first public reply as the acknowledgement, but not an internal note', async () => {
    const quiet = await raise();
    await svc.comment(c.t, engineer, quiet.id, { body: 'private', internal: true }, true);
    expect((await row(quiet.id)).acknowledged_at).toBeNull();
    await svc.comment(c.t, engineer, quiet.id, { body: 'Hello, looking now' }, true);
    expect((await row(quiet.id)).acknowledged_at).not.toBeNull();
  });

  it('puts a question on hold, waiting on the customer, until they reply', async () => {
    const r = await raise();
    await move(r.id, { to: 'in_progress' });
    await svc.comment(c.t, engineer, r.id, { body: 'Which handsets?', waitForReply: true }, true);
    let h = await row(r.id);
    expect([h.status, h.hold_reason]).toEqual(['on_hold', 'customer']);
    expect(h.paused_since).not.toBeNull();
    await expect(svc.comment(c.t, cara, r.id, { body: 'x', waitForReply: true }, false)).rejects.toBeInstanceOf(BadRequestException);
    await svc.comment(c.t, cara, r.id, { body: 'Yealink T54W' }, false);
    h = await row(r.id);
    expect([h.status, h.hold_reason, h.paused_since]).toEqual(['in_progress', null, null]);
    const g = await svc.get(c.t, r.id, true, engineer.id);
    expect(g.events.map((e) => e.kind)).toEqual(['created', 'status_changed', 'waiting', 'comment', 'resumed']);
  });

  it('does not let a customer comment on a closed incident', async () => {
    const r = await raise();
    await move(r.id, { to: 'resolved', note: 'Fixed' });
    await move(r.id, { to: 'closed' });
    await expect(svc.comment(c.t, cara, r.id, { body: 'thanks' }, false)).rejects.toThrow(/closed/);
  });
});

describe('priority changes', () => {
  it('shows the customer that it changed but not why', async () => {
    const r = await raise();
    await svc.setPriority(c.t, engineer, r.id, { priority: 'p1', reason: 'The CEO is affected' });
    const staff = await svc.get(c.t, r.id, true, engineer.id);
    const customer = await svc.get(c.t, r.id, false, cara.id);
    const ev = (g: typeof staff) => g.events.find((e) => e.kind === 'priority_changed')!;
    expect(ev(staff).body).toBe('The CEO is affected');
    expect(ev(customer).body).toBeNull();
    expect(ev(customer).to_status).toBe('p1');
    expect(staff.incident.priority_overridden).toBe(true);
    await expect(svc.setPriority(c.t, engineer, r.id, { priority: 'p1', reason: 'again' })).rejects.toThrow(/already/);
  });

  it('starts pausing a held P2 that is bumped to P1 only if it stops pausing', async () => {
    const r = await raise({ impact: 'site', urgency: 'degraded' }); // p2
    await move(r.id, { to: 'on_hold', holdReason: 'carrier' });
    expect((await row(r.id)).paused_since).not.toBeNull();
    await svc.setPriority(c.t, engineer, r.id, { priority: 'p1', reason: 'Escalated' });
    const h = await row(r.id);
    expect(h.paused_since).toBeNull();
  });
});

describe('what customers are shown', () => {
  it('hides engineering fields from customers but not from staff', async () => {
    const r = await raise();
    const customer = (await svc.get(c.t, r.id, false, cara.id)).incident as Record<string, unknown>;
    const staff = (await svc.get(c.t, r.id, true, engineer.id)).incident as Record<string, unknown>;
    for (const k of ['dedup_key', 'sla_notified', 'assigned_agent_id']) {
      expect(k in customer).toBe(false);
      expect(k in staff).toBe(true);
    }
    expect((await svc.get(c.t, r.id, false, cara.id)).watchers).toBeUndefined();
  });

  it('lists with an SLA clock and the people involved', async () => {
    const r = await raise();
    await svc.assign(c.t, engineer, r.id, { userId: engineer.id });
    const list = await svc.list(c.t, cara, { status: 'open', limit: 200 });
    const me = list.find((i) => i.id === r.id)!;
    expect(me.assigned_to_name).toBe('Eve Engineer');
    expect(me.reporter_name).toBe('Cara Customer');
    expect(me.sla.which).toBe('response');
    expect(me.category_label).toContain('One-way or no audio');
  });

  it('filters the list', async () => {
    const a = await raise({ title: 'Queue silent at lunch', category: 'other', subcategory: undefined, answers: {}, siteId: null });
    await svc.assign(c.t, engineer, a.id, { userId: engineer.id });
    const q = (x: Partial<Parameters<IncidentsService['list']>[2]>) => svc.list(c.t, engineer, { status: 'open', limit: 200, ...x });
    expect((await q({ q: 'lunch' })).map((i) => i.id)).toEqual([a.id]);
    expect((await q({ q: `INC-${a.number}` })).map((i) => i.id)).toEqual([a.id]);
    expect((await q({ assigned: 'me', category: 'other' })).map((i) => i.id)).toEqual([a.id]);
    expect((await q({ assigned: 'none' })).every((i) => i.assigned_to === null)).toBe(true);
    const done = await raise();
    await move(done.id, { to: 'resolved', note: 'Fixed' });
    await move(done.id, { to: 'closed' });
    expect((await q({})).some((i) => i.id === done.id)).toBe(false);
    expect((await q({ status: 'closed' })).some((i) => i.id === done.id)).toBe(true);
  });
});

describe('site contacts', () => {
  it('only see and open incidents on their own sites', async () => {
    const mine = await raise({ siteId: live });
    const theirs = await raise({ siteId: other });
    const wide = await raise({ category: 'other', subcategory: undefined, answers: {}, siteId: null });
    const t = scoped([live]);
    const ids = (await svc.list(t, cara, { status: 'open', limit: 500 })).map((i) => i.id);
    expect(ids).toContain(mine.id);
    expect(ids).not.toContain(theirs.id);
    expect(ids).not.toContain(wide.id);
    await expect(svc.get(t, theirs.id, false, cara.id)).rejects.toBeInstanceOf(ForbiddenException);
    await expect(svc.get(t, wide.id, false, cara.id)).rejects.toBeInstanceOf(ForbiddenException);
    expect((await svc.sites(t)).map((s) => s.id)).toEqual([live]);
    await expect(svc.create(t, cara, call({ siteId: other }), false)).rejects.toBeInstanceOf(ForbiddenException);
  });
});

describe('similar incidents', () => {
  it('finds open incidents of the same category at the site or customer-wide, and says whether you follow them', async () => {
    const site = await seedCustomer(handle, { managedServices: true });
    const lon = await seedSite(site.s, { sitecode: 'LON9' });
    const rdg = await seedSite(site.s, { sitecode: 'RDG9' });
    await site.s.updateTable('discovery_sites').set({ mode: 'operations' } as never).execute();
    // Direct Routing is the one category that can also be customer-wide.
    const dr = { category: 'direct_routing', subcategory: 'sbc_offline', answers: { symptom: ['All calls failing'], started: 'now' } } as const;
    const mk = (siteId: string | null, over: Partial<CreateIncidentInput> = {}) => svc.create(site.t, dan, call({ siteId, ...dr, ...over }), false);
    const here = await mk(lon.id);
    const elsewhere = await mk(rdg.id);
    const otherCategory = await mk(lon.id, { category: 'users', subcategory: 'voicemail', answers: { affected_user: 'Jo' } });
    const wide = await mk(null);
    const closed = await mk(lon.id);
    await svc.move(site.t, engineer, closed.id, { to: 'resolved', note: 'Fixed' }, true);
    await svc.move(site.t, engineer, closed.id, { to: 'closed' }, true);
    const found = await svc.similar(site.t, cara, { category: 'direct_routing', siteId: lon.id });
    const ids = found.map((f) => f.id);
    expect(ids).toContain(here.id);
    expect(ids).toContain(wide.id);
    expect(ids).not.toContain(elsewhere.id);
    expect(ids).not.toContain(otherCategory.id);
    expect(ids).not.toContain(closed.id);
    expect(found.find((f) => f.id === here.id)!.following).toBe(false);
    await svc.watch(site.t, cara, here.id, undefined, false);
    expect((await svc.similar(site.t, cara, { category: 'direct_routing', siteId: lon.id })).find((f) => f.id === here.id)!.following).toBe(true);
    // The reporter already follows their own.
    expect((await svc.similar(site.t, dan, { category: 'direct_routing', siteId: lon.id })).find((f) => f.id === here.id)!.following).toBe(true);
    // A site contact never sees another site's, or a customer-wide one.
    const scopedIds = (await svc.similar({ ...site.t, siteScope: [rdg.id] }, cara, { category: 'direct_routing' })).map((f) => f.id);
    expect(scopedIds).toEqual([elsewhere.id]);
  });
});

describe('watchers, items and settings', () => {
  it('adds a watcher once, lets staff add a customer user, and refuses a stranger', async () => {
    const r = await raise();
    await svc.watch(c.t, dan, r.id, undefined, false);
    await svc.watch(c.t, dan, r.id, undefined, false);
    await svc.watch(c.t, engineer, r.id, cara.id, true);
    await expect(svc.watch(c.t, dan, r.id, cara.id, false)).rejects.toBeInstanceOf(ForbiddenException);
    const stranger = await seedUser(handle, 'CUSTOMER');
    await expect(svc.watch(c.t, engineer, r.id, stranger.id, true)).rejects.toBeInstanceOf(BadRequestException);
    expect((await svc.get(c.t, r.id, true, engineer.id)).watchers).toHaveLength(2);
    await svc.unwatch(c.t, dan, r.id, undefined, false);
    expect((await svc.get(c.t, r.id, true, engineer.id)).watchers).toHaveLength(1);
  });

  it('links an item once and removes it', async () => {
    const r = await raise();
    const a = await svc.addItem(c.t, engineer, r.id, { kind: 'call_queue', ref: 'Sales', label: 'Sales queue' });
    const b = await svc.addItem(c.t, engineer, r.id, { kind: 'call_queue', ref: 'Sales' });
    expect(b.id).toBe(a.id);
    expect((await svc.get(c.t, r.id, true, engineer.id)).items).toHaveLength(1);
    await svc.removeItem(c.t, engineer, r.id, a.id);
    expect((await svc.get(c.t, r.id, true, engineer.id)).items).toHaveLength(0);
  });

  it('lets only a Super Admin change targets, and applies them to the clocks', async () => {
    const admin = await seedUser(handle, 'SUPER_ADMIN');
    await expect(svc.updateSettings(c.t, engineer, { targets: {} })).rejects.toBeInstanceOf(ForbiddenException);
    const s = await svc.updateSettings(c.t, admin, { targets: { p3: { responseMinutes: 5, restoreHours: 1, resolveHours: 2 } } });
    expect(s.targets.p3.responseMinutes).toBe(5);
    expect(s.targets.p1.responseMinutes).toBe(15);
    const r = await raise({ impact: 'individual', urgency: 'cannot_call' }); // p3
    await c.s.updateTable('incidents').set({ created_at: new Date(Date.now() - 30 * 60_000).toISOString() } as never).where('id', '=', r.id).execute();
    expect((await svc.get(c.t, r.id, true, engineer.id)).sla.response.state).toBe('overdue');
  });

  it('stores an attachment against the incident and only serves it through that incident', async () => {
    const r = await raise();
    const other2 = await raise();
    const stored = await svc.attach(c.t, cara, r.id, { originalname: 'trace.txt', mimetype: 'text/plain', buffer: Buffer.from('sip trace'), size: 9 });
    expect((await svc.attachments(c.t, r.id)).map((f) => f.filename)).toEqual(['trace.txt']);
    await expect(svc.attachment(c.t, other2.id, stored.id)).rejects.toThrow(/not found/);
    await expect(svc.attach(c.t, cara, r.id, { originalname: 'x.exe', mimetype: 'application/x-msdownload', buffer: Buffer.alloc(1), size: 1 })).rejects.toBeInstanceOf(BadRequestException);
    const g = await svc.get(c.t, r.id, false, cara.id);
    expect(g.events.some((e) => e.kind === 'attachment' && e.body === 'trace.txt')).toBe(true);
  });
});
