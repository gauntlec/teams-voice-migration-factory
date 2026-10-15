// Demo history (docs/INTAKE.md, "Demo data"): a believable two months of incidents and requests, tagged, with no emails, and removable.
import { beforeAll, describe, expect, it } from 'vitest';
import { platformDb } from '@tvmf/db';
import { createIncidentSchema, incSlaFor } from '@tvmf/shared';
import { seedCustomer, seedSite, seedUser, useDb, type TestCustomer } from '../helpers';
import { srServices } from '../service-requests/services';
import { incidentServices } from './services';

const handle = useDb();
const sent: unknown[] = [];
let c: TestCustomer;
let s: ReturnType<typeof incidentServices>;
let sr: ReturnType<typeof srServices>;
let admin: Awaited<ReturnType<typeof seedUser>>;
const NOW = new Date('2026-10-14T14:00:00Z'); // a Wednesday afternoon

beforeAll(async () => {
  c = await seedCustomer(handle, { managedServices: true, name: 'AT&T Voice Consult' });
  admin = await seedUser(handle, 'SUPER_ADMIN', { displayName: 'Platform Admin' });
  const e1 = await seedUser(handle, 'ENGINEER', { displayName: 'Eve Engineer' });
  const e2 = await seedUser(handle, 'ENGINEER', { displayName: 'Evan Engineer' });
  const pm = await seedUser(handle, 'PROJECT_MANAGER', { displayName: 'Pam Manager' });
  await platformDb(handle.db).insertInto('tenant_memberships').values([e1, e2, pm].map((u) => ({ tenant_id: c.t.id, user_id: u.id })) as never).execute();
  await seedSite(c.s, { sitecode: 'DAL001' });
  await seedSite(c.s, { sitecode: 'LUT01' });
  await c.s.updateTable('discovery_sites').set({ mode: 'operations' } as never).execute();
  for (let i = 0; i < 12; i++) {
    const upn = `user${i}@attvoiceconsult.com`;
    const o = await c.s.insertInto('tenant_objects').values({ object_type: 'User', object_key: upn, display_name: `Demo Person ${i}`, data: JSON.stringify({ upn }) } as never).returning('id').executeTakeFirstOrThrow();
    await c.s.insertInto('tenant_users').values({ object_id: o.id, upn, display_name: `Demo Person ${i}`, account_enabled: true } as never).execute();
  }
  s = incidentServices(handle, { enqueue: async (m: unknown) => (sent.push(m), { id: 'm' }) } as never);
  sr = srServices(handle);
});

describe('demo history', () => {
  it('seeds incidents, majors, problems, knowledge and requests without sending anything', async () => {
    const real = await s.svc.create(c.t, admin, createIncidentSchema.parse({ title: 'A real one', category: 'other', impact: 'individual', urgency: 'question', description: 'This one is real and must survive.', answers: {} }), true);
    const before = sent.length;
    const made = await s.demoData.seed(c.t, admin, { now: NOW });
    expect(made).toMatchObject({ incidents: 49, requests: 27, problems: 3, majors: 3, knowledge: 4 });
    expect(sent.length).toBe(before); // direct writes: no emails
    expect(await s.demoData.status(c.t)).toEqual({ incidents: 49, requests: 27, problems: 3 });

    const rows = await c.s.selectFrom('incidents').selectAll().where('title', '<>', 'A real one').execute();
    const by = (st: string) => rows.filter((r) => r.status === st).length;
    expect(by('closed')).toBeGreaterThanOrEqual(25);
    expect(rows.filter((r) => ['new', 'in_progress', 'on_hold', 'restored'].includes(r.status)).length).toBeGreaterThanOrEqual(8);
    expect(rows.filter((r) => r.major && !r.major_ended_at)).toHaveLength(1);
    expect(rows.filter((r) => r.major && r.major_ended_at)).toHaveLength(2);
    expect(rows.filter((r) => r.parent_id)).toHaveLength(3);
    expect(by('on_hold')).toBe(2);
    expect(by('cancelled')).toBe(1);
    expect(by('duplicate')).toBe(1);

    // Nothing in the future, and every case moves forward in time.
    for (const r of rows) {
      const t = [r.created_at, r.acknowledged_at, r.restored_at, r.resolved_at, r.closed_at].filter(Boolean).map((v) => new Date(v as string).getTime());
      for (let i = 1; i < t.length; i++) expect(t[i]!).toBeGreaterThanOrEqual(t[i - 1]!);
      expect(Math.max(...t)).toBeLessThanOrEqual(NOW.getTime());
    }
    // The customer's real incident is untouched, and people in the data come from Discovery.
    expect((await c.s.selectFrom('incidents').select('id').where('id', '=', real.id).executeTakeFirst())?.id).toBe(real.id);
    const items = await c.s.selectFrom('incident_items').select('ref').where('kind', '=', 'user').execute();
    expect(items.length).toBeGreaterThan(40);
    expect(items.every((i) => /^user\d+@attvoiceconsult\.com$/.test(i.ref))).toBe(true);
    const reqs = await c.s.selectFrom('service_requests').select(['details', 'status']).execute();
    expect(JSON.stringify(reqs.map((r) => r.details))).toContain('attvoiceconsult.com');
  });

  it('fills the queues and both reports', async () => {
    const from = new Date(NOW.getTime() - 70 * 86_400_000).toISOString();
    const to = new Date(NOW.getTime() + 86_400_000).toISOString();
    const report = await s.reports.report(c.t, from, to, true);
    expect(report.raised).toBeGreaterThanOrEqual(45);
    expect(report.resolved).toBeGreaterThanOrEqual(30);
    expect(report.major).toBe(3);
    expect(report.by_priority.length).toBeGreaterThanOrEqual(3);
    expect(report.on_time.response.percent).not.toBeNull();
    expect(report.on_time.resolution.percent).not.toBeNull();
    // Some targets were missed, and most were met: a believable service, not a perfect one.
    for (const w of ['response', 'restoration', 'resolution'] as const) {
      expect(report.on_time[w].missed).toBeGreaterThan(0);
      expect(report.on_time[w].percent!).toBeGreaterThan(50);
    }
    expect(report.median_minutes_to_acknowledge).not.toBeNull();
    expect(report.median_hours_to_resolve).not.toBeNull();
    expect(report.repeats.length).toBeGreaterThanOrEqual(1);
    expect(report.problems?.length).toBeGreaterThanOrEqual(2);
    expect(report.backlog.under1d + report.backlog.d1to3 + report.backlog.d3to7 + report.backlog.over7d).toBeGreaterThanOrEqual(8);

    const srReport = await sr.requests.report(c.t, from, to);
    expect(srReport.raised).toBe(27);
    expect(srReport.deployed).toBe(16);
    expect(srReport.medianHoursToDeploy).not.toBeNull();
    expect(srReport.responseMetPct).toBeGreaterThan(50);
    expect(srReport.resolutionMetPct).toBeGreaterThan(50);
    expect(srReport.openBacklog.total).toBeGreaterThanOrEqual(8);
    expect(Object.values(srReport.byStatus).reduce((a, b) => a + b, 0)).toBe(27);
  });

  it('gives the open queue some work at risk and some overdue', async () => {
    const open = await c.s.selectFrom('incidents').selectAll().where('status', 'in', ['new', 'in_progress', 'on_hold', 'restored']).execute();
    const states = open.map((r) => incSlaFor(r as never, null, NOW.getTime()));
    const names = states.flatMap((x) => [x.response.state, x.restoration.state, x.resolution.state]);
    expect(names).toContain('on_track');
    expect(names.some((n) => n === 'overdue' || n === 'at_risk')).toBe(true);
    // At least one is still waiting to be acknowledged, and one is on hold.
    expect(open.some((r) => !r.acknowledged_at)).toBe(true);
    expect(open.some((r) => r.status === 'on_hold')).toBe(true);
  });

  it('will not add it twice, and removes exactly what it added', async () => {
    await expect(s.demoData.seed(c.t, admin, { now: NOW })).rejects.toThrow(/already has demo data/);
    const gone = await s.demoData.remove(c.t, admin);
    expect(gone).toEqual({ incidents: 49, requests: 27, problems: 3 });
    expect(await s.demoData.status(c.t)).toEqual({ incidents: 0, requests: 0, problems: 0 });
    expect(await c.s.selectFrom('incident_knowledge').select('id').execute()).toHaveLength(0);
    expect((await c.s.selectFrom('incidents').select('id').execute()).length).toBe(1); // the real one
    // And it can be added again.
    expect((await s.demoData.seed(c.t, admin, { now: NOW })).incidents).toBe(49);
  });

  it('is refused where Managed Services is off', async () => {
    const off = await seedCustomer(handle, { managedServices: false });
    await expect(s.demoData.seed(off.t, admin)).rejects.toThrow(/Managed Services/);
  });
});
