// Knowledge saved from resolved incidents, suggested on new ones; and the history of past service notices.
import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import { platformDb } from '@tvmf/db';
import { createAgentSchema, createIncidentSchema } from '@tvmf/shared';
import { seedCustomer, seedSite, seedUser, useDb, type TestCustomer } from '../helpers';
import { incidentServices } from './services';

const handle = useDb();
let c: TestCustomer;
let s: ReturnType<typeof incidentServices>;
let admin: Awaited<ReturnType<typeof seedUser>>;
let eng: Awaited<ReturnType<typeof seedUser>>;
let cara: Awaited<ReturnType<typeof seedUser>>;
let siteId: string;

const call = (over = {}) =>
  createIncidentSchema.parse({ title: 'One-way audio on wifi handsets', category: 'call_quality', subcategory: 'one_way_audio', siteId, impact: 'team', urgency: 'degraded', description: 'Callers on the wifi network hear nothing from our side.', answers: { where: 'In the office on wifi', how_often: 'Every call', started: 'Today 09:00' }, ...over });
const raise = (over = {}) => s.svc.create(c.t, cara, call(over), false);

beforeAll(async () => {
  c = await seedCustomer(handle, { managedServices: true });
  admin = await seedUser(handle, 'SUPER_ADMIN', { displayName: 'Ada Admin' });
  eng = await seedUser(handle, 'ENGINEER', { displayName: 'Eve Engineer' });
  cara = await seedUser(handle, 'CUSTOMER', { displayName: 'Cara Customer' });
  await platformDb(handle.db).insertInto('tenant_memberships').values([eng, cara].map((u) => ({ tenant_id: c.t.id, user_id: u.id })) as never).execute();
  siteId = (await seedSite(c.s, { sitecode: 'RDG01' })).id;
  await c.s.updateTable('discovery_sites').set({ mode: 'operations' } as never).execute();
  s = incidentServices(handle);
});

async function resolved() {
  const i = await raise();
  await s.svc.move(c.t, eng, i.id, { to: 'in_progress' }, true);
  await s.svc.move(c.t, eng, i.id, { to: 'restored', note: 'Opened UDP 3478-3481 on the firewall.' }, true);
  await s.svc.move(c.t, eng, i.id, { to: 'resolved', note: 'Opened UDP 3478-3481 to the Teams media range on the Reading firewall.' }, true);
  return i;
}

describe('saving knowledge', () => {
  it('starts from the incident: its title, what was reported and how it was fixed', async () => {
    const i = await resolved();
    const d = await s.knowledge.draftFrom(c.t, i.id);
    expect(d).toMatchObject({ title: 'One-way audio on wifi handsets', category: 'call_quality', subcategory: 'one_way_audio', sourceIncidentId: i.id });
    expect(d.symptoms).toContain('hear nothing');
    expect(d.fix).toBe('Opened UDP 3478-3481 to the Teams media range on the Reading firewall.');
    await expect(s.knowledge.draftFrom(c.t, randomUUID())).rejects.toThrow(/not found/);
  });

  it('keeps it, and an archived one is gone from lists and matches', async () => {
    const i = await resolved();
    const d = await s.knowledge.draftFrom(c.t, i.id);
    const k = await s.knowledge.create(c.t, eng, { ...d, customerText: 'If calls on wifi have no audio, check your firewall allows the Teams media ports.' } as never);
    expect((await s.knowledge.list(c.t)).some((x) => x.id === k.id)).toBe(true);
    await s.knowledge.update(c.t, eng, k.id, { fix: 'Open UDP 3478-3481 to 52.112.0.0/14 on the Reading firewall.' });
    expect((await s.knowledge.list(c.t)).find((x) => x.id === k.id)!.fix).toContain('52.112.0.0/14');
    await s.knowledge.archive(c.t, eng, k.id);
    expect((await s.knowledge.list(c.t)).some((x) => x.id === k.id)).toBe(false);
    expect(await s.knowledge.match(c.t, { category: 'call_quality', subcategory: 'one_way_audio', text: 'wifi audio' }, true)).not.toContainEqual(expect.objectContaining({ id: k.id }));
    await expect(s.knowledge.update(c.t, eng, k.id, { title: 'Nope again' })).rejects.toThrow(/not found/);
  });
});

describe('suggesting it', () => {
  it('shows an engineer the fix for a new incident like it, and a customer only the tip written for them', async () => {
    const src = await resolved();
    const d = await s.knowledge.draftFrom(c.t, src.id);
    const withTip = await s.knowledge.create(c.t, eng, { ...d, title: 'Wifi one-way audio', customerText: 'If calls on wifi have no audio, check your firewall allows the Teams media ports.' } as never);
    const staffOnly = await s.knowledge.create(c.t, eng, { ...d, title: 'Wifi one-way audio: internal notes', fix: 'Check the QoS marking on the Reading AP.', customerText: '' } as never);
    const fresh = await raise({ title: 'No audio when on wifi' });
    const forStaff = await s.knowledge.matchIncident(c.t, fresh.id);
    expect(forStaff.map((k) => k.id)).toEqual(expect.arrayContaining([withTip.id, staffOnly.id]));
    expect(forStaff.find((k) => k.id === withTip.id)).toHaveProperty('fix');
    const forCustomer = await s.knowledge.match(c.t, { category: 'call_quality', subcategory: 'one_way_audio', text: 'No audio on wifi' }, false);
    expect(forCustomer).toEqual([{ id: withTip.id, title: 'Wifi one-way audio', customer_text: 'If calls on wifi have no audio, check your firewall allows the Teams media ports.' }]);
    // Nothing for an unrelated kind of problem.
    expect(await s.knowledge.match(c.t, { category: 'users', text: 'My dial pad is missing' }, true)).toEqual([]);
  });

  it('learns from "this helped": a snippet people keep rejecting stops being suggested', async () => {
    const src = await resolved();
    const d = await s.knowledge.draftFrom(c.t, src.id);
    const k = await s.knowledge.create(c.t, eng, { ...d, title: 'Wifi one-way audio (rejected)', category: 'direct_routing', subcategory: null, symptoms: 'Handsets on wifi', fix: 'Reboot the SBC' } as never);
    const q = { category: 'direct_routing', text: 'Handsets on wifi' };
    expect((await s.knowledge.match(c.t, q, true)).some((x) => x.id === k.id)).toBe(true);
    for (let n = 0; n < 4; n++) await s.knowledge.feedback(c.t, k.id, false);
    expect((await s.knowledge.match(c.t, q, true)).some((x) => x.id === k.id)).toBe(false);
    await expect(s.knowledge.feedback(c.t, randomUUID(), true)).rejects.toThrow(/not found/);
  });

  it('is what an assistant reads with the incident', async () => {
    const a = await s.agentAdmin.create(admin, createAgentSchema.parse({ name: `Know-${Date.now() % 100000}`, kind: 'triage' }));
    await s.agentAdmin.setPolicy(admin, a.id, c.t.id, { enabled: true, autonomy: {} });
    const src = await resolved();
    const k = await s.knowledge.create(c.t, eng, { ...(await s.knowledge.draftFrom(c.t, src.id)), title: 'Wifi one-way audio for agents' } as never);
    const fresh = await raise({ title: 'Wifi calls silent' });
    const got = await s.agentApi.get({ agentId: a.id, tokenId: 't', name: a.name, kind: 'triage', scopes: ['read'] }, c.t.id, fresh.id);
    expect(got.knowledge.map((x: { id: string }) => x.id)).toContain(k.id);
  });
});

describe('past service notices', () => {
  const declare = (id: string) => s.major.declare(c.t, eng, id, { leadId: eng.id, commsId: eng.id, summary: 'Calls at Reading are failing; we are checking the SBC.' });

  it('lists ended notices, newest first, with how long and how it ended; a live one is not history', async () => {
    const a = await raise({ title: 'Reading calls failing' });
    await s.svc.move(c.t, eng, a.id, { to: 'in_progress' }, true);
    await declare(a.id);
    expect(await s.major.noticeHistory(c.t, 90)).not.toContainEqual(expect.objectContaining({ id: a.id }));
    await s.svc.move(c.t, eng, a.id, { to: 'restored', note: 'Carrier fixed the trunk' }, true);
    await s.svc.move(c.t, eng, a.id, { to: 'resolved', note: 'Carrier fixed the trunk' }, true);
    const h = await s.major.noticeHistory(c.t, 90);
    const row = h.find((x) => x.id === a.id)!;
    expect(row).toMatchObject({ title: 'Reading calls failing', sitecode: 'RDG01', can_open: true });
    expect(row.ended_at).not.toBeNull();
    expect(row.minutes).toBeGreaterThanOrEqual(0);
    expect(row.outcome).toBeTruthy();
    // Out of range, and a site contact only sees their sites' notices.
    await c.s.updateTable('incidents').set({ major_ended_at: new Date(Date.now() - 200 * 86_400_000).toISOString() } as never).where('id', '=', a.id).execute();
    expect((await s.major.noticeHistory(c.t, 90)).some((x) => x.id === a.id)).toBe(false);
    expect((await s.major.noticeHistory(c.t, 365)).some((x) => x.id === a.id)).toBe(true);
    const other = (await seedSite(c.s, { sitecode: 'LON01' })).id;
    expect((await s.major.noticeHistory({ ...c.t, siteScope: [other] }, 365)).some((x) => x.id === a.id)).toBe(false);
  });
});
