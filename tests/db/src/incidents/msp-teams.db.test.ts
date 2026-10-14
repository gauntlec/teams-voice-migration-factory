// An MSP's Teams channel (docs/INTAKE.md): connected by a Super Admin with a genuine Microsoft webhook address (stored encrypted, never shown),
// told about P1/P2 incidents, major incidents and missed targets through an outbox, delivered by the worker with retries.
import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import { platformDb } from '@tvmf/db';
import { createIncidentSchema, teamsPayload } from '@tvmf/shared';
import { MspsService } from '../../../../apps/api/src/msps/msps.service';
import { AuditService } from '../../../../apps/api/src/common/audit.service';
import { deliverMspNotifications, queueMspNotification } from '../../../../apps/worker/src/msp-notify';
import { seedCustomer, seedSite, seedUser, unused, useDb, type TestCustomer } from '../helpers';
import { incidentServices } from './services';

const handle = useDb();
let c: TestCustomer;
let s: ReturnType<typeof incidentServices>;
let msps: MspsService;
let mspId: string;
let admin: Awaited<ReturnType<typeof seedUser>>;
let eng: Awaited<ReturnType<typeof seedUser>>;
let cara: Awaited<ReturnType<typeof seedUser>>;
let siteId: string;

const HOOK = 'https://prod-12.westeurope.logic.azure.com:443/workflows/abc/triggers/manual/paths/invoke?sig=SECRETSIG';
const actor = () => ({ id: admin.id, email: admin.email, role: admin.role });
const call = (over = {}) =>
  createIncidentSchema.parse({ title: 'No calls at Reading', category: 'call_failure', subcategory: 'outbound_fail', siteId, impact: 'company', urgency: 'cannot_call', description: 'Nobody at Reading can make or receive calls.', answers: { direction: 'Outbound calls', started: 'Today 09:00' }, ...over });
const outbox = () => platformDb(handle.db).selectFrom('msp_notifications').selectAll().where('msp_id', '=', mspId).orderBy('created_at').execute();
const clear = () => platformDb(handle.db).deleteFrom('msp_notifications').where('msp_id', '=', mspId).execute();

beforeAll(async () => {
  c = await seedCustomer(handle, { managedServices: true });
  admin = await seedUser(handle, 'SUPER_ADMIN', { displayName: 'Ada Admin' });
  eng = await seedUser(handle, 'ENGINEER', { displayName: 'Eve Engineer' });
  cara = await seedUser(handle, 'CUSTOMER', { displayName: 'Cara Customer' });
  await platformDb(handle.db).insertInto('tenant_memberships').values([eng, cara].map((u) => ({ tenant_id: c.t.id, user_id: u.id })) as never).execute();
  siteId = (await seedSite(c.s, { sitecode: 'RDG01' })).id;
  await c.s.updateTable('discovery_sites').set({ mode: 'operations' } as never).execute();
  const m = await platformDb(handle.db).insertInto('msps').values({ name: `Voice MSP ${randomUUID().slice(0, 4)}`, slug: `vm-${randomUUID().slice(0, 6)}` } as never).returning('id').executeTakeFirstOrThrow();
  mspId = m.id;
  await platformDb(handle.db).updateTable('tenants').set({ msp_id: mspId }).where('id', '=', c.t.id).execute();
  msps = new MspsService(handle.db, new AuditService(handle.db), unused('storage'));
  s = incidentServices(handle);
});

describe('connecting a channel', () => {
  it('stores the address encrypted, never returns it, and says only whether one is connected', async () => {
    expect(await msps.teams(mspId)).toEqual({ configured: false, notify: { incidents: true, major: true, sla: true } });
    const r = await msps.setTeams(mspId, { webhookUrl: HOOK, notify: { incidents: true, major: true, sla: false } }, actor());
    expect(r).toEqual({ configured: true, notify: { incidents: true, major: true, sla: false } });
    expect(JSON.stringify(r)).not.toContain('SECRETSIG');
    const stored = await platformDb(handle.db).selectFrom('msps').select('teams_webhook_enc').where('id', '=', mspId).executeTakeFirstOrThrow();
    expect(stored.teams_webhook_enc).not.toContain('SECRETSIG');
    expect(stored.teams_webhook_enc).not.toContain('logic.azure.com');
    // Changing only what it tells the channel keeps the address.
    expect((await msps.setTeams(mspId, { notify: { incidents: true, major: true, sla: true } }, actor())).configured).toBe(true);
  });
  it('refuses an address that is not a Microsoft Teams webhook', async () => {
    for (const bad of ['https://evil.example/hook', 'http://x.logic.azure.com/y', 'https://169.254.169.254/latest', 'nonsense']) await expect(msps.setTeams(mspId, { webhookUrl: bad }, actor())).rejects.toThrow(/not a Microsoft Teams webhook/);
    expect((await msps.teams(mspId)).configured).toBe(true);
  });
  it('can be tested, and disconnected', async () => {
    await clear();
    expect(await msps.testTeams(mspId, actor())).toEqual({ queued: true });
    expect((await outbox())[0]).toMatchObject({ kind: 'test', status: 'queued' });
    await msps.setTeams(mspId, { webhookUrl: null }, actor());
    expect((await msps.teams(mspId)).configured).toBe(false);
    await expect(msps.testTeams(mspId, actor())).rejects.toThrow(/Connect a Teams channel first/);
    await msps.setTeams(mspId, { webhookUrl: HOOK }, actor());
  });
});

describe('what it is told', () => {
  it('a P1 and a P2 incident, but not a P3', async () => {
    await clear();
    const p1 = await s.svc.create(c.t, cara, call(), false);
    expect(p1.priority).toBe('p1');
    const p3 = await s.svc.create(c.t, cara, call({ title: 'Minor glitch', impact: 'individual', urgency: 'feature_broken' }), false);
    expect(p3.priority).not.toBe('p1');
    const rows = (await outbox()).filter((r) => r.kind === 'incident');
    expect(rows.length).toBe(['p1', 'p2'].includes(p3.priority) ? 2 : 1);
    const card = rows[0]!.card as { title: string; facts: { title: string; value: string }[]; link: { url: string }; tone: string };
    expect(card.title).toBe(`P1 Critical incident: ${p1.reference} No calls at Reading`);
    expect(card.facts).toContainEqual({ title: 'Customer', value: c.t.name });
    expect(card.facts.find((f) => f.title === 'Site')!.value).toContain('RDG01');
    expect(card.link.url).toBe(`https://app.test/incidents/${p1.id}`);
    expect(card.tone).toBe('attention');
  });

  it('a major incident declared and over', async () => {
    await clear();
    const i = await s.svc.create(c.t, cara, call({ title: 'Reading outage' }), false);
    await clear();
    await s.svc.move(c.t, eng, i.id, { to: 'in_progress' }, true);
    await s.major.declare(c.t, eng, i.id, { leadId: eng.id, commsId: eng.id, summary: 'The SBC at Reading is down; carrier engaged.' });
    await s.svc.move(c.t, eng, i.id, { to: 'restored', note: 'Carrier fixed the trunk' }, true);
    await s.svc.move(c.t, eng, i.id, { to: 'resolved', note: 'Carrier fixed the trunk' }, true);
    const rows = (await outbox()).filter((r) => r.kind === 'major');
    expect(rows.map((r) => (r.card as { title: string }).title)).toEqual([`Major incident declared: ${i.reference} Reading outage`, `Major incident over: ${i.reference} Reading outage`]);
    expect((rows[1]!.card as { tone: string }).tone).toBe('good');
  });

  it('respects what the MSP switched off, and nothing at all without a channel', async () => {
    await msps.setTeams(mspId, { notify: { incidents: false, major: true, sla: true } }, actor());
    await clear();
    await s.svc.create(c.t, cara, call({ title: 'Another outage' }), false);
    expect((await outbox()).filter((r) => r.kind === 'incident')).toHaveLength(0);
    await msps.setTeams(mspId, { notify: { incidents: true, major: true, sla: true }, webhookUrl: null }, actor());
    await s.svc.create(c.t, cara, call({ title: 'Yet another outage' }), false);
    expect(await outbox()).toHaveLength(0);
    expect(await queueMspNotification(handle.db, c.t.id, 'sla', { title: 'x' })).toBe(false);
    await msps.setTeams(mspId, { webhookUrl: HOOK }, actor());
    expect(await queueMspNotification(handle.db, c.t.id, 'sla', { title: 'Target missed: INC-0001 x' })).toBe(true);
    await msps.setTeams(mspId, { notify: { incidents: true, major: true, sla: false } }, actor());
    expect(await queueMspNotification(handle.db, c.t.id, 'sla', { title: 'again' })).toBe(false);
    await msps.setTeams(mspId, { notify: { incidents: true, major: true, sla: true } }, actor());
  });

  it('a customer with no MSP is never posted anywhere', async () => {
    const lone = await seedCustomer(handle, { managedServices: true });
    expect(await queueMspNotification(handle.db, lone.t.id, 'incident', { title: 'x' })).toBe(false);
  });
});

describe('delivery', () => {
  const ok = (calls: { url: string; body: string }[]) => (async (url: string, init: { body: string }) => (calls.push({ url, body: init.body }), new Response('', { status: 202 }))) as unknown as typeof fetch;

  it('posts an adaptive card to the decrypted address and marks it sent', async () => {
    await clear();
    await queueMspNotification(handle.db, c.t.id, 'incident', { title: 'P1 incident: INC-0001 x', body: 'Nobody can call', tone: 'attention' });
    const calls: { url: string; body: string }[] = [];
    expect(await deliverMspNotifications(handle.db, ok(calls))).toEqual({ sent: 1, failed: 0 });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(HOOK);
    expect(JSON.parse(calls[0]!.body)).toEqual(JSON.parse(JSON.stringify(teamsPayload({ title: 'P1 incident: INC-0001 x', body: 'Nobody can call', tone: 'attention' }))));
    expect((await outbox())[0]).toMatchObject({ status: 'sent', attempts: 1 });
    expect(await deliverMspNotifications(handle.db, ok(calls))).toEqual({ sent: 0, failed: 0 });
  });

  it('retries a failure with a delay, and gives up after six tries', async () => {
    await clear();
    await queueMspNotification(handle.db, c.t.id, 'incident', { title: 'flaky' });
    const failing = (async () => new Response('', { status: 500 })) as unknown as typeof fetch;
    expect(await deliverMspNotifications(handle.db, failing)).toEqual({ sent: 0, failed: 1 });
    let row = (await outbox())[0]!;
    expect(row).toMatchObject({ status: 'queued', attempts: 1, error: 'Teams answered 500.' });
    expect(new Date(row.next_attempt_at).getTime()).toBeGreaterThan(Date.now());
    // Not before its time.
    expect(await deliverMspNotifications(handle.db, failing)).toEqual({ sent: 0, failed: 0 });
    for (let n = 2; n <= 6; n++) {
      await platformDb(handle.db).updateTable('msp_notifications').set({ next_attempt_at: new Date(Date.now() - 1000).toISOString() }).where('id', '=', row.id).execute();
      await deliverMspNotifications(handle.db, failing);
      row = (await outbox())[0]!;
    }
    expect(row).toMatchObject({ status: 'failed', attempts: 6 });
  });

  it('a network error is a failure to retry; a disconnected channel or a tampered address is final and posts nothing', async () => {
    await clear();
    await queueMspNotification(handle.db, c.t.id, 'incident', { title: 'net' });
    const down = (async () => { throw new Error('connect ETIMEDOUT'); }) as unknown as typeof fetch;
    await deliverMspNotifications(handle.db, down);
    expect((await outbox())[0]).toMatchObject({ status: 'queued', error: expect.stringContaining('ETIMEDOUT') });

    await clear();
    await queueMspNotification(handle.db, c.t.id, 'incident', { title: 'gone' });
    await msps.setTeams(mspId, { webhookUrl: null }, actor());
    const calls: { url: string; body: string }[] = [];
    await deliverMspNotifications(handle.db, ok(calls));
    expect((await outbox())[0]).toMatchObject({ status: 'failed', error: 'The Teams channel has been disconnected.' });

    await msps.setTeams(mspId, { webhookUrl: HOOK }, actor());
    await clear();
    await queueMspNotification(handle.db, c.t.id, 'incident', { title: 'tampered' });
    const { encryptSecret } = await import('../../../../apps/api/src/common/crypto');
    await platformDb(handle.db).updateTable('msps').set({ teams_webhook_enc: encryptSecret('https://169.254.169.254/latest/meta-data') }).where('id', '=', mspId).execute();
    await deliverMspNotifications(handle.db, ok(calls));
    expect((await outbox())[0]).toMatchObject({ status: 'failed', error: 'The stored address is not a Microsoft Teams webhook.' });
    expect(calls).toHaveLength(0);
    await msps.setTeams(mspId, { webhookUrl: HOOK }, actor());
  });
});
