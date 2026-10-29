// Parked numbers in operations: the Numbers tab no longer parks them, a "Park or unpark phone numbers" request does when an
// engineer completes it, and it changes every number on the request or none.
import { beforeAll, describe, expect, it } from 'vitest';
import { platformDb } from '@tvmf/db';
import { createServiceRequestSchema, type SrStatus } from '@tvmf/shared';
import { AuditService } from '../../../../apps/api/src/common/audit.service';
import { DataCollectionService } from '../../../../apps/api/src/modules/data-collection/data-collection.service';
import { TelephonyService } from '../../../../apps/api/src/modules/data-collection/data-collection.telephony.service';
import { seedCustomer, seedNumbers, seedSite, seedUser, useDb, type TestCustomer } from '../helpers';
import { srServices } from './services';

const handle = useDb();
let c: TestCustomer;
let s: ReturnType<typeof srServices>;
let telephony: TelephonyService;
let eng: Awaited<ReturnType<typeof seedUser>>;
let cara: Awaited<ReturnType<typeof seedUser>>;
let siteId: string;

const N = ['+12125550301', '+12125550302', '+12125550303', '+12125550304'];
const num = (e164: string) => c.s.selectFrom('phone_numbers').selectAll().where('e164', '=', e164).executeTakeFirstOrThrow();
const raise = (details: Record<string, unknown>) =>
  s.requests.create(c.t, cara, createServiceRequestSchema.parse({ type: 'change_number_state', title: 'Spare numbers', siteId, details }));
async function complete(id: string) {
  for (const to of ['planned', 'built', 'deployed'] as SrStatus[]) await s.requests.move(c.t, eng, id, { to }, true);
}

beforeAll(async () => {
  c = await seedCustomer(handle, { managedServices: true });
  eng = await seedUser(handle, 'ENGINEER', { displayName: 'Eve Engineer' });
  cara = await seedUser(handle, 'CUSTOMER', { displayName: 'Cara Customer' });
  await platformDb(handle.db).insertInto('tenant_memberships').values([eng, cara].map((u) => ({ tenant_id: c.t.id, user_id: u.id })) as never).execute();
  siteId = (await seedSite(c.s, { sitecode: 'OPS01' })).id;
  await seedNumbers(c.s, 'OPS01', N);
  await c.s.updateTable('discovery_sites').set({ mode: 'operations' } as never).where('id', '=', siteId).execute();
  s = srServices(handle);
  const audit = new AuditService(handle.db);
  telephony = new TelephonyService(handle.db, audit, new DataCollectionService(handle.db, audit));
});

describe('parking numbers at a site in operations', () => {
  it('refuses to park from the Numbers tab', async () => {
    await expect(telephony.parkNumber(c.t, eng, (await num(N[0]!)).id, true)).rejects.toThrow(/service request/);
  });

  it('parks the numbers when the request is completed, and keeps them off other requests meanwhile', async () => {
    const sr = await raise({ park_action: 'Park them', park_numbers: [N[0], N[1]] });
    const options = await s.requests.options(c.t, siteId);
    expect(options.availableNumbers).not.toContain(N[0]);
    await expect(raise({ park_action: 'Park them', park_numbers: [N[1]] })).rejects.toThrow(/another open request/);
    await complete(sr.id);
    expect((await num(N[0]!)).status).toBe('parked');
    expect((await num(N[1]!)).status).toBe('parked');
    expect((await s.requests.options(c.t, siteId)).parkedNumbers).toEqual([N[0], N[1]]);
  });

  it('only offers spare numbers to park and parked numbers to unpark', async () => {
    await expect(raise({ park_action: 'Park them', park_numbers: [N[0]] })).rejects.toThrow(/isn't a spare number/);
    await expect(raise({ park_action: 'Bring them back into use', unpark_numbers: [N[2]] })).rejects.toThrow(/isn't parked/);
  });

  it('changes nothing when a number was given to someone after the request was raised', async () => {
    const sr = await raise({ park_action: 'Park them', park_numbers: [N[2], N[3]] });
    for (const to of ['planned', 'built'] as SrStatus[]) await s.requests.move(c.t, eng, sr.id, { to }, true);
    await c.s.updateTable('phone_numbers').set({ status: 'reserved' }).where('e164', '=', N[3]!).execute();
    await expect(s.requests.move(c.t, eng, sr.id, { to: 'deployed' }, true)).rejects.toThrow(/no number has changed/);
    expect((await num(N[2]!)).status).toBe('available');
    const after = await c.s.selectFrom('service_requests').select('status').where('id', '=', sr.id).executeTakeFirstOrThrow();
    expect(after.status).toBe('built');
  });

  it('brings parked numbers back into use', async () => {
    const sr = await raise({ park_action: 'Bring them back into use', unpark_numbers: [N[0]] });
    await complete(sr.id);
    expect(await num(N[0]!)).toMatchObject({ status: 'available', parked_at: null });
  });
});

describe('parking numbers at a site in project mode', () => {
  it('parks and unparks from the Numbers tab', async () => {
    await c.s.updateTable('discovery_sites').set({ mode: 'project' } as never).where('id', '=', siteId).execute();
    const id = (await num(N[2]!)).id;
    expect((await telephony.parkNumber(c.t, eng, id, true)).status).toBe('parked');
    expect((await telephony.parkNumber(c.t, eng, id, false)).status).toBe('available');
  });
});
