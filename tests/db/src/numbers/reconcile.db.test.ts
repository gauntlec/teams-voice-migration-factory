// Numbers follow Teams: whatever Teams has assigned is shown as assigned to its real holder, and a clash with Data Collection is flagged.
import { beforeAll, describe, expect, it } from 'vitest';
import { reconcileNumbersWithTeams } from '@tvmf/db';
import { seedCustomer, seedNumbers, seedSite, useDb, type TestCustomer } from '../helpers';

const handle = useDb();
let c: TestCustomer;
let siteId: string;

async function liveNumber(number: string, status: string, who?: { kind: 'user' | 'resource_account'; upn: string; displayName: string }) {
  await c.s
    .insertInto('tenant_objects')
    .values({ object_type: 'phone_number', object_key: number, display_name: number, data: { TelephoneNumber: number, PstnAssignmentStatus: status, ...(who ? { AssignedTo: who } : {}) } } as never)
    .onConflict((oc) => oc.columns(['object_type', 'object_key']).doUpdateSet({ data: { TelephoneNumber: number, PstnAssignmentStatus: status, ...(who ? { AssignedTo: who } : {}) } as never }))
    .execute();
}
const row = (e164: string) => c.s.selectFrom('phone_numbers').selectAll().where('e164', '=', e164).executeTakeFirstOrThrow();

beforeAll(async () => {
  c = await seedCustomer(handle);
  siteId = (await seedSite(c.s, { sitecode: 'NYC01' })).id;
  await seedNumbers(c.s, 'NYC01', ['+12125550101', '+12125550102', '+12125550103', '+12125550104', '+12125550105']);
});

describe('reconcileNumbersWithTeams', () => {
  it('adds a number found only in Teams to a range with no site, assigned to its live holder', async () => {
    await liveNumber('+13125550001', 'PhoneNumberAssigned', { kind: 'user', upn: 'ann@contoso.test', displayName: 'Ann' });
    await liveNumber('+13125550002', 'PhoneNumberAssigned', { kind: 'resource_account', upn: 'aa@contoso.test', displayName: 'Main AA' });
    const r = await reconcileNumbersWithTeams(c.s, { releaseMissing: true });
    expect(r.added).toBe(2);
    const n = await row('+13125550001');
    expect(n).toMatchObject({ status: 'assigned', live_only: true, live_holder_upn: 'ann@contoso.test', live_holder_name: 'Ann', conflict: null });
    const range = await c.s.selectFrom('discovery_number_ranges').select(['sitecode', 'range_start', 'range_end']).where('id', '=', n.range_id).executeTakeFirstOrThrow();
    expect(range).toMatchObject({ sitecode: null, range_start: '+13125550001', range_end: '+13125550002' });
  });

  it('shows a free number as assigned when Teams has it, and does it again on the next run without change', async () => {
    await liveNumber('+12125550101', 'PhoneNumberAssigned', { kind: 'user', upn: 'bob@contoso.test', displayName: 'Bob' });
    const first = await reconcileNumbersWithTeams(c.s, { releaseMissing: true });
    expect(first.taken).toBe(1);
    expect(await row('+12125550101')).toMatchObject({ status: 'assigned', live_only: true });
    const again = await reconcileNumbersWithTeams(c.s, { releaseMissing: true });
    expect(again.added).toBe(0);
    expect((await row('+12125550101')).status).toBe('assigned');
  });

  it('flags a Data Collection holder that differs from Teams, and leaves the design alone', async () => {
    const du = await c.s.insertInto('discovery_users').values({ site_id: siteId, upn: 'carol@contoso.test', display_name: 'Carol' } as never).returning('id').executeTakeFirstOrThrow();
    await c.s.updateTable('phone_numbers').set({ status: 'assigned', holder_type: 'user', holder_id: du.id }).where('e164', '=', '+12125550102').execute();
    await liveNumber('+12125550102', 'PhoneNumberAssigned', { kind: 'user', upn: 'dave@contoso.test', displayName: 'Dave' });
    const r = await reconcileNumbersWithTeams(c.s, { releaseMissing: true });
    expect(r.conflicts).toBeGreaterThanOrEqual(1);
    const n = await row('+12125550102');
    expect(n.holder_id).toBe(du.id);
    expect(n.conflict).toMatch(/Dave.*Carol/);
  });

  it('does not flag a Data Collection holder that matches Teams', async () => {
    const du = await c.s.insertInto('discovery_users').values({ site_id: siteId, upn: 'erin@contoso.test', display_name: 'Erin' } as never).returning('id').executeTakeFirstOrThrow();
    await c.s.updateTable('phone_numbers').set({ status: 'assigned', holder_type: 'user', holder_id: du.id }).where('e164', '=', '+12125550103').execute();
    await liveNumber('+12125550103', 'PhoneNumberAssigned', { kind: 'user', upn: 'Erin@Contoso.test', displayName: 'Erin' });
    await reconcileNumbersWithTeams(c.s, { releaseMissing: true });
    expect((await row('+12125550103')).conflict).toBeNull();
  });

  it('flags a reserved number that Teams has live, and keeps it reserved', async () => {
    await c.s.updateTable('phone_numbers').set({ status: 'reserved' }).where('e164', '=', '+12125550104').execute();
    await liveNumber('+12125550104', 'PhoneNumberAssigned', { kind: 'user', upn: 'fay@contoso.test', displayName: 'Fay' });
    await reconcileNumbersWithTeams(c.s, { releaseMissing: true });
    const n = await row('+12125550104');
    expect(n.status).toBe('reserved');
    expect(n.conflict).toMatch(/reserved/);
  });

  it('frees a number only Teams was holding once Teams releases it, but only when the sync read every number', async () => {
    await liveNumber('+12125550101', 'Unassigned');
    await reconcileNumbersWithTeams(c.s, { releaseMissing: false });
    expect(await row('+12125550101')).toMatchObject({ status: 'assigned', live_only: true });
    const r = await reconcileNumbersWithTeams(c.s, { releaseMissing: true });
    expect(r.released).toBeGreaterThanOrEqual(1);
    expect(await row('+12125550101')).toMatchObject({ status: 'available', live_only: false, live_status: null });
  });

  it('keeps a design holder when Teams releases the number, and clears the clash', async () => {
    await liveNumber('+12125550102', 'Unassigned');
    await reconcileNumbersWithTeams(c.s, { releaseMissing: true });
    const n = await row('+12125550102');
    expect(n).toMatchObject({ status: 'assigned', holder_type: 'user', conflict: null, live_status: null });
  });
});
