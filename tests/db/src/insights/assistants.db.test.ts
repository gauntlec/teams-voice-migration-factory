// The Assistant activity report (docs/INSIGHTS.md): what each AI assistant did for a customer in a period - incidents and
// service requests it took on, the steps it proposed and how people decided them, hand-offs and take-backs, and what it
// resolved or completed itself. Incidents need inc:read and service requests sr:read; a site contact sees only their sites.
// Built-in assistants are shared by every test file, so the "(Voxshift)" label is checked in reports.test.ts.
import { beforeAll, describe, expect, it } from 'vitest';
import { platformDb } from '@tvmf/db';
import { buildAssistantReport, createIncidentSchema, reportAvailableFor, can } from '@tvmf/shared';
import { InsightsAssistantsService } from '../../../../apps/api/src/modules/insights/insights-assistants.service';
import { seedCustomer, seedSite, seedUser, useDb, type TestCustomer } from '../helpers';
import { incidentServices } from '../incidents/services';

const handle = useDb();
let c: TestCustomer;
let svc: InsightsAssistantsService;
let triage: string;
let changes: string;
let rdg: string;
let lds: string;
const window = { from: '2026-10-01T00:00:00.000Z', to: '2026-11-01T00:00:00.000Z' };
const inOct = (day: number, hour = 10) => `2026-10-${String(day).padStart(2, '0')}T${String(hour).padStart(2, '0')}:00:00.000Z`;

beforeAll(async () => {
  c = await seedCustomer(handle, { managedServices: true });
  svc = new InsightsAssistantsService(handle.db);
  const p = platformDb(handle.db);
  triage = (await p.insertInto('agents').values({ name: `Triage bot ${Date.now() % 100000}` } as never).returning('id').executeTakeFirstOrThrow()).id;
  changes = (await p.insertInto('agents').values({ name: `Change bot ${Date.now() % 100000}` } as never).returning('id').executeTakeFirstOrThrow()).id;
  rdg = (await seedSite(c.s, { sitecode: 'RDG01' })).id;
  lds = (await seedSite(c.s, { sitecode: 'LDS01' })).id;
  await c.s.updateTable('discovery_sites').set({ mode: 'operations' } as never).execute();
  const cara = await seedUser(handle, 'CUSTOMER');
  const inc = incidentServices(handle);
  const raise = (siteId: string) =>
    inc.svc.create(
      c.t,
      cara,
      createIncidentSchema.parse({ title: 'No audio', category: 'call_quality', subcategory: 'one_way_audio', siteId, impact: 'team', urgency: 'degraded', description: 'Nothing heard on inbound calls.', answers: { where: 'In the office on wifi', how_often: 'Every call', started: 'Today 09:00' } }),
      false,
    );
  const [i1, i2, i3] = [await raise(rdg), await raise(rdg), await raise(lds)];

  // Triage bot: worked i1 (handed it to a person) and i2 (resolved it itself), and i3 at Leeds (a person took it back).
  await c.s
    .insertInto('incident_claims')
    .values([
      { incident_id: i1.id, agent_id: triage, started_at: inOct(3), expires_at: inOct(3, 11), released_at: inOct(3, 12), release_reason: 'handed_off' },
      { incident_id: i2.id, agent_id: triage, started_at: inOct(5), expires_at: inOct(5, 11), released_at: inOct(5, 11), release_reason: 'released' },
      { incident_id: i3.id, agent_id: triage, started_at: inOct(7), expires_at: inOct(7, 11), released_at: inOct(7, 11), release_reason: 'revoked' },
      // before the period: not counted
      { incident_id: i1.id, agent_id: triage, started_at: '2026-09-20T10:00:00.000Z', expires_at: '2026-09-20T11:00:00.000Z', released_at: '2026-09-20T11:00:00.000Z', release_reason: 'expired' },
    ] as never)
    .execute();
  await c.s
    .insertInto('incident_actions')
    .values([
      { incident_id: i1.id, agent_id: triage, kind: 'customer_update', action_class: 'customer_update', state: 'done', created_at: inOct(3, 10), decided_at: inOct(3, 11), expires_at: inOct(4) },
      { incident_id: i1.id, agent_id: triage, kind: 'set_priority', action_class: 'triage', state: 'rejected', created_at: inOct(3, 10), decided_at: inOct(3, 10), expires_at: inOct(4) },
      { incident_id: i2.id, agent_id: triage, kind: 'customer_update', action_class: 'customer_update', state: 'expired', created_at: inOct(5), expires_at: inOct(6) },
      { incident_id: i3.id, agent_id: triage, kind: 'status_change', action_class: 'resolve', state: 'proposed', created_at: inOct(7), expires_at: inOct(8) },
    ] as never)
    .execute();
  await c.s.insertInto('incident_events').values({ incident_id: i2.id, kind: 'status_changed', to_status: 'resolved', actor_type: 'agent', author_id: triage, created_at: inOct(5, 11) } as never).execute();

  // Change bot: completed one service request at Reading with one approved deployment.
  const sr = await c.s.insertInto('service_requests').values({ type: 'new_user', title: 'Add Jo', details: JSON.stringify({}), requested_by: cara.id, site_id: rdg } as never).returning('id').executeTakeFirstOrThrow();
  await c.s.insertInto('service_request_claims').values({ request_id: sr.id, agent_id: changes, started_at: inOct(10), expires_at: inOct(10, 11), released_at: inOct(10, 12), release_reason: 'released' } as never).execute();
  await c.s.insertInto('service_request_actions').values({ request_id: sr.id, agent_id: changes, kind: 'external', action_class: 'change_deploy', state: 'done', created_at: inOct(10), decided_at: inOct(10, 11), expires_at: inOct(11) } as never).execute();
  await c.s.insertInto('service_request_events').values({ request_id: sr.id, kind: 'status_changed', to_status: 'deployed', actor_type: 'agent', author_id: changes, created_at: inOct(10, 12) } as never).execute();
});

describe('Assistant activity', () => {
  it('counts what each assistant did in the period', async () => {
    const a = await svc.activity(c.t, 'SUPER_ADMIN', window);
    expect(a).toMatchObject({ incidents: true, serviceRequests: true, incidentsWorked: 3, requestsWorked: 1 });
    const bot = a.assistants.find((r) => r.agentId === triage)!;
    expect(bot).toMatchObject({ builtin: false, incidentsWorked: 3, requestsWorked: 0, proposed: 4, approved: 1, rejected: 1, expired: 1, waiting: 1, handedOff: 1, takenBack: 1, resolved: 1, completed: 0 });
    expect(a.assistants.find((r) => r.agentId === changes)).toMatchObject({ requestsWorked: 1, proposed: 1, approved: 1, completed: 1 });
    expect(a.proposals.find((p) => p.area === 'incident' && p.kind === 'customer_update')).toMatchObject({ label: 'Update the customer', proposed: 2, approved: 1, expired: 1 });
    // decided after 60, 0 and 60 minutes
    expect(a.medianMinutesToDecide).toBe(60);
  });

  it('shows only what the person may see: their sites, and only the areas they can read', async () => {
    const leedsContact = { ...c.t, siteScope: [lds] } as never;
    const scoped = await svc.activity(leedsContact, 'SUPER_ADMIN', window);
    expect(scoped).toMatchObject({ incidentsWorked: 1, requestsWorked: 0 });
    expect(scoped.assistants.find((r) => r.agentId === triage)).toMatchObject({ incidentsWorked: 1, takenBack: 1, handedOff: 0, resolved: 0, proposed: 1 });
    const roles = ['SUPER_ADMIN', 'ENGINEER', 'PROJECT_MANAGER', 'CUSTOMER'] as const;
    for (const role of roles) {
      const offered = reportAvailableFor('assistants', (p) => can(role, p), { managedServices: true, monitoring: false });
      if (!offered) await expect(svc.activity(c.t, role, window)).rejects.toThrow();
      else {
        const a = await svc.activity(c.t, role, window);
        expect(a.incidents).toBe(can(role, 'inc:read'));
        expect(a.serviceRequests).toBe(can(role, 'sr:read'));
      }
    }
    await expect(svc.activity({ ...c.t, managedServices: false } as never, 'SUPER_ADMIN', window)).rejects.toThrow();
  });

  it('makes a report that compares with the period before', async () => {
    const cur = await svc.activity(c.t, 'SUPER_ADMIN', window);
    const before = await svc.activity(c.t, 'SUPER_ADMIN', { from: '2026-09-01T00:00:00.000Z', to: window.from });
    const doc = buildAssistantReport(cur, before, { from: '2026-10-01', to: '2026-10-31' }, { from: '2026-09-01', to: '2026-09-30' });
    const figures = doc.sections.find((x) => x.kind === 'figures')!;
    expect(figures.kind === 'figures' && figures.figures.find((f) => f.label === 'Incidents worked')).toMatchObject({ value: 3, previous: 1 }); // the 20 September claim
    expect(figures.kind === 'figures' && figures.figures.find((f) => f.label === 'Approved by a person')).toMatchObject({ value: 66.7 });
    const table = doc.sections.find((x) => x.kind === 'table' && x.title === 'By assistant')!;
    expect(table.kind === 'table' && table.rows.map((r) => r[0])).toEqual(expect.arrayContaining([expect.stringContaining('Triage bot'), expect.stringContaining('Change bot')]));
    expect(doc.summary).toBe('3 incidents · 1 service requests · 5 steps proposed');
  });
});
