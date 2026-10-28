// Adding a number range reconciles with Teams straight away: numbers Discovery found live move into the new range, and the rest of
// the range's numbers that are live show as assigned without waiting for the next sync.
import { beforeAll, describe, expect, it } from 'vitest';
import { reconcileNumbersWithTeams } from '@tvmf/db';
import { AuditService } from '../../../../apps/api/src/common/audit.service';
import { DataCollectionService } from '../../../../apps/api/src/modules/data-collection/data-collection.service';
import { TelephonyService } from '../../../../apps/api/src/modules/data-collection/data-collection.telephony.service';
import { seedCustomer, seedSite, seedUser, useDb, type TestCustomer } from '../helpers';

const handle = useDb();
let c: TestCustomer;
let svc: TelephonyService;
let engineer: Awaited<ReturnType<typeof seedUser>>;
const actor = () => ({ id: engineer.id, email: engineer.email, role: 'ENGINEER' }) as never;

async function live(number: string, upn: string) {
  const data = { TelephoneNumber: number, PstnAssignmentStatus: 'PhoneNumberAssigned', AssignedTo: { kind: 'user', upn, displayName: upn } };
  await c.s.insertInto('tenant_objects').values({ object_type: 'phone_number', object_key: number, display_name: number, data } as never).execute();
}

beforeAll(async () => {
  c = await seedCustomer(handle);
  const audit = new AuditService(handle.db);
  svc = new TelephonyService(handle.db, audit, new DataCollectionService(handle.db, audit));
  engineer = await seedUser(handle, 'ENGINEER');
  await seedSite(c.s, { sitecode: 'BOS01' });
  await live('+16175550101', 'ann@contoso.test');
  await live('+16175550102', 'bob@contoso.test');
  await reconcileNumbersWithTeams(c.s, { releaseMissing: true }); // both found in Teams, in a range with no site
});

describe('adding a range after Discovery found numbers in Teams', () => {
  it('moves the live numbers into the new range, shows the others as free, and drops the emptied Found-in-Teams range', async () => {
    const before = await c.s.selectFrom('discovery_number_ranges').select('id').where('sitecode', 'is', null).execute();
    expect(before).toHaveLength(1);

    const res = await svc.addRange(c.t, actor(), { sitecode: 'BOS01', range_start: '+16175550101', range_end: '+16175550104', kind: 'new' } as never, true);
    expect(res.skipped).toBe(0);

    const rows = await c.s.selectFrom('phone_numbers').select(['e164', 'range_id', 'status', 'live_only', 'live_holder_upn']).orderBy('e164').execute();
    expect(rows.every((r) => r.range_id === res.range.id)).toBe(true);
    expect(rows.map((r) => [r.e164, r.status])).toEqual([
      ['+16175550101', 'assigned'],
      ['+16175550102', 'assigned'],
      ['+16175550103', 'available'],
      ['+16175550104', 'available'],
    ]);
    expect(rows[0]).toMatchObject({ live_only: true, live_holder_upn: 'ann@contoso.test' });
    expect(await c.s.selectFrom('discovery_number_ranges').select('id').where('sitecode', 'is', null).execute()).toEqual([]);
  });

  it('shows a new range number that is live in Teams as assigned straight away', async () => {
    await live('+16175550203', 'cy@contoso.test'); // stored by a sync, but not in any range of ours yet... added by the range below
    await c.s.deleteFrom('phone_numbers').where('e164', '=', '+16175550203').execute();
    await svc.addRange(c.t, actor(), { sitecode: 'BOS01', range_start: '+16175550201', range_end: '+16175550204', kind: 'new' } as never, true);
    const n = await c.s.selectFrom('phone_numbers').select(['status', 'live_only']).where('e164', '=', '+16175550203').executeTakeFirstOrThrow();
    expect(n).toEqual({ status: 'assigned', live_only: true });
  });
});
