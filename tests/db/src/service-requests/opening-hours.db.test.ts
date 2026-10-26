// "Change an auto attendant: opening hours" applied from the request's own wording (shared/opening-hours.ts), so it needs no engineer.
import { beforeAll, describe, expect, it } from 'vitest';
import { platformDb } from '@tvmf/db';
import { createServiceRequestSchema } from '@tvmf/shared';
import { seedCustomer, seedSite, seedUser, useDb, type TestCustomer } from '../helpers';
import { srServices } from './services';

const handle = useDb();
let c: TestCustomer;
let s: ReturnType<typeof srServices>;
let eng: Awaited<ReturnType<typeof seedUser>>;
let cara: Awaited<ReturnType<typeof seedUser>>;
let siteId: string;

const closed = { greetings: [{ type: 'Text', text: 'We are closed' }], menu: { options: [{ dtmf: 'Automatic', action: 'DisconnectCall' }] } };

async function aa(name: string, withAfterHours: boolean) {
  return c.s
    .insertInto('build_auto_attendants')
    .values({ site_id: siteId, name, language_id: 'en-GB', time_zone_id: 'GMT Standard Time', ...(withAfterHours ? { after_hours_call_flow: JSON.stringify(closed) } : {}) } as never)
    .returning('id')
    .executeTakeFirstOrThrow();
}

async function hoursRequest(aaId: string, label: string, hours: string) {
  const sr = await s.requests.create(
    c.t,
    cara,
    createServiceRequestSchema.parse({ type: 'change_auto_attendant', title: `Hours for ${label}`, siteId, details: { auto_attendant: { id: aaId, label }, changes: ['Opening hours'], business_hours: hours } }),
  );
  await s.requests.move(c.t, eng, sr.id, { to: 'planned' } as never, true);
  await s.requests.draftInBuild(c.t, eng, sr.id, {} as never);
  return sr;
}

beforeAll(async () => {
  c = await seedCustomer(handle, { managedServices: true });
  eng = await seedUser(handle, 'ENGINEER');
  cara = await seedUser(handle, 'CUSTOMER');
  await platformDb(handle.db).insertInto('tenant_memberships').values([eng, cara].map((u) => ({ tenant_id: c.t.id, user_id: u.id })) as never).execute();
  siteId = (await seedSite(c.s, { sitecode: 'LTN01' })).id;
  await c.s.updateTable('discovery_sites').set({ mode: 'operations' } as never).execute();
  s = srServices(handle);
});

describe('opening hours from a change request', () => {
  it('sets the business hours (outside them the out-of-hours flow plays)', async () => {
    const { id } = await aa('Main', true);
    await hoursRequest(id, 'Main', 'Mon-Fri 8:30-17:30, Sat 9-12');
    const row = await c.s.selectFrom('build_auto_attendants').select('schedule').where('id', '=', id).executeTakeFirstOrThrow();
    expect(row.schedule).toMatchObject({ type: 'weekly', weekly: { complement: true, monday: [{ start: '08:30', end: '17:30' }], saturday: [{ start: '09:00', end: '12:00' }], sunday: [] } });
  });

  it('leaves hours alone, as a to-do, when there is no out-of-hours call flow to switch to', async () => {
    const { id } = await aa('Reception', false);
    const sr = await hoursRequest(id, 'Reception', 'Mon-Fri 9-5');
    const row = await c.s.selectFrom('build_auto_attendants').select('schedule').where('id', '=', id).executeTakeFirstOrThrow();
    expect(row.schedule).toBeNull();
    const events = await c.s.selectFrom('service_request_events').select('body').where('request_id', '=', sr.id).execute();
    expect(events.some((e) => /no out-of-hours call flow yet/.test(String(e.body)))).toBe(true);
  });
});
