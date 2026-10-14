// Monitoring alerts (docs/INTAKE.md): one incident per alert key however often it fires, raised by the source as a system actor,
// and a token that can post alerts for its own customer and nothing else.
import { randomUUID } from 'node:crypto';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { platformDb } from '@tvmf/db';
import { formatIntakeToken, can, type IntakeConfig, type IntakeKind } from '@tvmf/shared';
import type { EnqueueMailInput } from '../../../../apps/api/src/mail/mail.service';
import { seedCustomer, seedSite, seedUser, useDb, type TestCustomer } from '../helpers';
import { incidentServices } from './services';

const handle = useDb();
let c: TestCustomer;
let s: ReturnType<typeof incidentServices>;
let admin: Awaited<ReturnType<typeof seedUser>>;
let eng: Awaited<ReturnType<typeof seedUser>>;
let cara: Awaited<ReturnType<typeof seedUser>>;
let sent: EnqueueMailInput[] = [];
let n = 0;

beforeAll(async () => {
  c = await seedCustomer(handle, { managedServices: true });
  admin = await seedUser(handle, 'SUPER_ADMIN', { displayName: 'Ada Admin' });
  eng = await seedUser(handle, 'ENGINEER', { displayName: 'Eve Engineer' });
  cara = await seedUser(handle, 'CUSTOMER', { displayName: 'Cara Customer' });
  await platformDb(handle.db).insertInto('tenant_memberships').values([eng, cara].map((u) => ({ tenant_id: c.t.id, user_id: u.id })) as never).execute();
  await seedSite(c.s, { sitecode: 'RDG01' });
  s = incidentServices(handle, { enqueue: async (i: EnqueueMailInput) => (sent.push(i), { id: 'm' }) });
});
beforeEach(() => {
  sent = [];
});

/** A source for the customer, and the principal the guard would build for it. */
async function source(kind: IntakeKind = 'sbc', config: IntakeConfig = {}) {
  const r = await s.intakeAdmin.create(c.t, admin, { name: `Mon-${++n}-${randomUUID().slice(0, 4)}`, kind, config, ipAllow: [] });
  return { ...r, p: { sourceId: r.id, tenantId: c.t.id, name: r.name, kind, config } };
}
const alert = (over: Record<string, unknown> = {}) => ({ dedupKey: `k-${n}`, title: 'SBC trunk down', severity: 'major', state: 'firing', ...over });
const inc = (ref: string | null) => c.s.selectFrom('incidents').selectAll().where('number', '=', Number(ref!.replace('INC-', ''))).executeTakeFirstOrThrow();
const events = (id: string) => c.s.selectFrom('incident_events').selectAll().where('incident_id', '=', id).orderBy('created_at').execute();

describe('managing sources', () => {
  it('is for Super Admins only, shows the token once, and never stores it', async () => {
    expect(can('SUPER_ADMIN', 'intake:manage')).toBe(true);
    expect(can('ENGINEER', 'intake:manage')).toBe(false);
    const r = await source();
    expect(r.token).toMatch(/^vxs_intake_[0-9a-f-]{36}_/);
    const list = await s.intakeAdmin.list(c.t);
    const row = list.find((x) => x.id === r.id)!;
    expect(row).not.toHaveProperty('secret_hash');
    expect(row.hint).toBe(`vxs_intake_…${r.token.slice(-4)}`);
    const stored = await platformDb(handle.db).selectFrom('intake_sources').select('secret_hash').where('id', '=', r.id).executeTakeFirstOrThrow();
    expect(stored.secret_hash).not.toContain(r.token.slice(-20));
    await expect(s.intakeAdmin.create(c.t, admin, { name: r.name, kind: 'generic', config: {}, ipAllow: [] })).rejects.toThrow(/already exists/);
  });

  it('rotates a token (the old one stops), switches off, and deletes', async () => {
    const r = await source();
    const ctx = (token: string, ip = '10.0.0.1') => ({ switchToHttp: () => ({ getRequest: () => ({ headers: { authorization: `Bearer ${token}` }, ip, method: 'POST' }) }) }) as never;
    expect(await s.intakeGuard.canActivate(ctx(r.token))).toBe(true);
    const next = await s.intakeAdmin.rotate(c.t, admin, r.id);
    await expect(s.intakeGuard.canActivate(ctx(r.token))).rejects.toThrow(/not valid/);
    expect(await s.intakeGuard.canActivate(ctx(next.token))).toBe(true);
    await s.intakeAdmin.update(c.t, admin, r.id, { enabled: false });
    await expect(s.intakeGuard.canActivate(ctx(next.token))).rejects.toThrow(/switched off/);
    await s.intakeAdmin.remove(c.t, admin, r.id);
    await expect(s.intakeGuard.canActivate(ctx(next.token))).rejects.toThrow(/not valid/);
  });
});

describe('the token', () => {
  const ctx = (token: string | undefined, ip = '10.0.0.1') => ({ switchToHttp: () => ({ getRequest: () => ({ headers: token ? { authorization: `Bearer ${token}` } : {}, ip, method: 'POST' }) }) }) as never;
  it('refuses a missing, malformed, wrong or another kind of token', async () => {
    const r = await source();
    await expect(s.intakeGuard.canActivate(ctx(undefined))).rejects.toThrow(/Send an intake token/);
    await expect(s.intakeGuard.canActivate(ctx('vxs_agent_nope'))).rejects.toThrow(/Send an intake token/);
    await expect(s.intakeGuard.canActivate(ctx(formatIntakeToken(r.id, 'x'.repeat(43))))).rejects.toThrow(/not valid/);
    await expect(s.intakeGuard.canActivate(ctx(formatIntakeToken(randomUUID(), 'x'.repeat(43))))).rejects.toThrow(/not valid/);
  });
  it('honours the address list, and a customer whose incidents are switched off', async () => {
    const r = await s.intakeAdmin.create(c.t, admin, { name: `Lock-${++n}`, kind: 'generic', config: {}, ipAllow: ['203.0.113.0/24'] });
    await expect(s.intakeGuard.canActivate(ctx(r.token, '198.51.100.7'))).rejects.toThrow(/cannot be used from this address/);
    expect(await s.intakeGuard.canActivate(ctx(r.token, '203.0.113.9'))).toBe(true);
    await platformDb(handle.db).updateTable('tenants').set({ managed_services_enabled: false }).where('id', '=', c.t.id).execute();
    await expect(s.intakeGuard.canActivate(ctx(r.token, '203.0.113.9'))).rejects.toThrow(/not switched on/);
    await platformDb(handle.db).updateTable('tenants').set({ managed_services_enabled: true }).where('id', '=', c.t.id).execute();
  });
  it('slows a source that floods', async () => {
    const r = await source();
    let refused = 0;
    for (let i = 0; i < 125; i++) await s.intakeGuard.canActivate(ctx(r.token)).catch(() => refused++);
    expect(refused).toBeGreaterThanOrEqual(5);
  });
});

describe('alerts', () => {
  it('raises one incident for an alert, as the source, with no reporter email', async () => {
    const src = await source('sbc', { siteCode: 'rdg01' });
    const r = await s.intake.alert(src.p, alert({ dedupKey: 'trunk-1', severity: 'critical', description: 'No answer to OPTIONS from carrier 1', link: 'https://mon/1' }));
    expect(r.action).toBe('created');
    const row = await inc(r.incident);
    expect(row).toMatchObject({ source: 'monitor', category: 'direct_routing', priority: 'p1', status: 'new', reporter_id: src.id, dedup_key: `${src.id}:trunk-1` });
    expect(row.site_id).not.toBeNull();
    expect(row.description).toContain('No answer to OPTIONS');
    expect(((row.details as unknown as { intake?: Record<string, unknown> }).intake)).toMatchObject({ source: src.name, count: 1, link: 'https://mon/1' });
    const ev = await events(row.id);
    expect(ev[0]).toMatchObject({ kind: 'created', actor_type: 'system', author_id: src.id });
    // The team hears; nobody gets "we've got it".
    expect(sent.every((m) => (m.context as { audience?: string }).audience === 'team')).toBe(true);
    expect(sent.length).toBeGreaterThan(0);
    expect(sent.every((m) => m.createdBy === null)).toBe(true);
    // It is named for the source, to the team and the customer.
    const staffView = await s.svc.get(c.t, row.id, true, eng.id);
    expect(staffView.incident.reporter_name).toBe(`${src.name} (monitoring)`);
    expect(staffView.events[0]!.author_name).toBe(`${src.name} (monitoring)`);
    const list = await s.svc.list(c.t, eng, { status: 'all' } as never);
    expect(list.find((x) => x.id === row.id)).toBeTruthy();
  });

  it('is the same incident when it fires again: counted and noted once, priority raised only if worse', async () => {
    const src = await source();
    const first = await s.intake.alert(src.p, alert({ dedupKey: 'flap', severity: 'minor' }));
    const row = await inc(first.incident);
    expect(row.priority).toBe('p3');
    for (let i = 0; i < 4; i++) expect(await s.intake.alert(src.p, alert({ dedupKey: 'flap', severity: 'minor' }))).toMatchObject({ action: 'updated', incident: first.incident });
    const after = await inc(first.incident);
    expect(((after.details as unknown as { intake: { count: number } }).intake).count).toBe(5);
    expect((await events(row.id)).filter((e) => e.actor_type === 'system' && e.kind === 'comment')).toHaveLength(1);
    expect((await c.s.selectFrom('incidents').select('id').where('dedup_key', '=', `${src.id}:flap`).execute())).toHaveLength(1);
    // Worse: the priority goes up, and says why.
    await s.intake.alert(src.p, alert({ dedupKey: 'flap', severity: 'critical' }));
    expect((await inc(first.incident)).priority).toBe('p1');
    const pc = (await events(row.id)).find((e) => e.kind === 'priority_changed')!;
    expect(pc.actor_type).toBe('system');
    // Not worse: nothing changes; and a priority a person set stays.
    await s.svc.setPriority(c.t, eng, row.id, { priority: 'p4', reason: 'It is only a test trunk' });
    await s.intake.alert(src.p, alert({ dedupKey: 'flap', severity: 'critical' }));
    expect((await inc(first.incident)).priority).toBe('p4');
  });

  it('two alerts at once are one incident', async () => {
    const src = await source();
    const rs = await Promise.all([1, 2, 3].map(() => s.intake.alert(src.p, alert({ dedupKey: 'race' }))));
    expect(new Set(rs.map((r) => r.incident)).size).toBe(1);
    expect(rs.filter((r) => r.action === 'created')).toHaveLength(1);
    expect((await c.s.selectFrom('incidents').select('id').where('dedup_key', '=', `${src.id}:race`).execute())).toHaveLength(1);
  });

  it('notes that it cleared, restores the incident only when the source is set to, and ignores a clear with nothing open', async () => {
    const plain = await source('sbc', {});
    const a = await s.intake.alert(plain.p, alert({ dedupKey: 'c1' }));
    await s.svc.move(c.t, eng, (await inc(a.incident)).id, { to: 'in_progress' }, true);
    expect(await s.intake.alert(plain.p, alert({ dedupKey: 'c1', state: 'resolved' }))).toMatchObject({ action: 'resolved', incident: a.incident });
    expect((await inc(a.incident)).status).toBe('in_progress');
    expect((await events((await inc(a.incident)).id)).some((e) => /alert cleared/.test(e.body ?? ''))).toBe(true);

    const auto = await source('sbc', { autoRestore: true });
    const b = await s.intake.alert(auto.p, alert({ dedupKey: 'c2' }));
    // Still New: a machine does not acknowledge an incident for the team, so it is only noted.
    await s.intake.alert(auto.p, alert({ dedupKey: 'c2', state: 'resolved' }));
    expect((await inc(b.incident)).status).toBe('new');
    const d = await s.intake.alert(auto.p, alert({ dedupKey: 'c3' }));
    await s.svc.move(c.t, eng, (await inc(d.incident)).id, { to: 'in_progress' }, true);
    await s.intake.alert(auto.p, alert({ dedupKey: 'c3', state: 'resolved' }));
    expect((await inc(d.incident)).status).toBe('restored');

    expect(await s.intake.alert(auto.p, alert({ dedupKey: 'never-seen', state: 'resolved' }))).toMatchObject({ action: 'ignored', incident: null });
  });

  it('reopens an incident that came back after it was resolved, and raises a fresh one once it is closed', async () => {
    const src = await source();
    const a = await s.intake.alert(src.p, alert({ dedupKey: 'back' }));
    const id = (await inc(a.incident)).id;
    await s.svc.move(c.t, eng, id, { to: 'in_progress' }, true);
    await s.svc.move(c.t, eng, id, { to: 'restored', note: 'Carrier fixed it' }, true);
    await s.svc.move(c.t, eng, id, { to: 'resolved', note: 'Carrier fixed it' }, true);
    expect(await s.intake.alert(src.p, alert({ dedupKey: 'back' }))).toMatchObject({ action: 'updated', incident: a.incident });
    expect((await inc(a.incident)).status).toBe('in_progress');
    await s.svc.move(c.t, eng, id, { to: 'restored', note: 'Again' }, true);
    await s.svc.move(c.t, eng, id, { to: 'resolved', note: 'Again' }, true);
    await s.svc.move(c.t, eng, id, { to: 'closed' }, true);
    const fresh = await s.intake.alert(src.p, alert({ dedupKey: 'back' }));
    expect(fresh.action).toBe('created');
    expect(fresh.incident).not.toBe(a.incident);
  });

  it('ignores alerts below the minimum severity, and says what is wrong with a bad body', async () => {
    const src = await source('generic', { minSeverity: 'major' });
    expect(await s.intake.alert(src.p, alert({ dedupKey: 'low', severity: 'info' }))).toMatchObject({ action: 'ignored' });
    expect(await c.s.selectFrom('incidents').select('id').where('dedup_key', '=', `${src.id}:low`).execute()).toHaveLength(0);
    await expect(s.intake.alert(src.p, { title: 'no key' })).rejects.toThrow(/dedupKey/);
    await expect(s.intake.alert(src.p, { dedupKey: 'x', title: 'ok title', severity: 'weird' })).rejects.toThrow(/severity/);
  });

  it('maps a Microsoft service health issue and its resolution to one incident', async () => {
    const src = await source('microsoft_health', {});
    const issue = { id: 'MO99', title: 'Teams calling degraded', service: 'Microsoft Teams', classification: 'incident', status: 'investigating', impactDescription: 'Some PSTN calls fail.' };
    const a = await s.intake.alert(src.p, issue);
    const row = await inc(a.incident);
    expect(row).toMatchObject({ category: 'microsoft_service', priority: 'p2' });
    expect(row.title).toBe('Microsoft Teams: Teams calling degraded');
    await s.intake.alert(src.p, { ...issue, status: 'serviceRestored', isResolved: true });
    expect((await events(row.id)).some((e) => /alert cleared/.test(e.body ?? ''))).toBe(true);
  });

  it('an unknown site is said so, not guessed', async () => {
    const src = await source('sbc', { siteCode: 'NOWHERE' });
    const a = await s.intake.alert(src.p, alert({ dedupKey: 'nosite' }));
    const row = await inc(a.incident);
    expect(row.site_id).toBeNull();
    expect(row.description).toContain('Site NOWHERE is not known');
  });
});

describe('demo incidents', () => {
  it('are refused for a real customer, built for a test customer once, and leave a believable spread', async () => {
    await expect(s.demo.seed(c.t, admin)).rejects.toThrow(/only be added to a test customer/);
    const demo = await seedCustomer(handle, { managedServices: true });
    await platformDb(handle.db).updateTable('tenants').set({ sandbox: true } as never).where('id', '=', demo.t.id).execute();
    await expect(s.demo.seed(demo.t, admin)).rejects.toThrow(/Move a site to operations/);
    await seedSite(demo.s, { sitecode: 'HQ01' });
    await demo.s.updateTable('discovery_sites').set({ mode: 'operations' } as never).execute();
    expect(await s.demo.seed(demo.t, admin)).toEqual({ created: 6 });
    const rows = await demo.s.selectFrom('incidents').select(['status', 'priority', 'major', 'major_ended_at']).execute();
    expect(rows).toHaveLength(6);
    expect(rows.filter((r) => r.major && !r.major_ended_at)).toHaveLength(1);
    expect(new Set(rows.map((r) => r.status))).toEqual(new Set(['new', 'in_progress', 'on_hold', 'resolved', 'closed']));
    expect((await demo.s.selectFrom('incident_knowledge').select('id').execute())).toHaveLength(1);
    await expect(s.demo.seed(demo.t, admin)).rejects.toThrow(/already has demo incidents/);
  });
});
