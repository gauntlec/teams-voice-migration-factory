// Number cool-off: a number released in Teams is not reassigned for the customer's period, unless an engineer ends it with a reason.
import { beforeAll, describe, expect, it } from 'vitest';
import { cooloffDays, markNumbersReleased } from '@tvmf/db';
import { AuditService } from '../../../../apps/api/src/common/audit.service';
import { DataCollectionService } from '../../../../apps/api/src/modules/data-collection/data-collection.service';
import { TelephonyService } from '../../../../apps/api/src/modules/data-collection/data-collection.telephony.service';
import { seedCustomer, seedNumbers, seedSite, seedUser, useDb, type TestCustomer } from '../helpers';

const handle = useDb();
let c: TestCustomer;
let svc: TelephonyService;
let engineer: Awaited<ReturnType<typeof seedUser>>;
let userId: string;
let numbers: Awaited<ReturnType<typeof seedNumbers>>;
const actor = () => ({ id: engineer.id, email: engineer.email, role: 'ENGINEER' }) as never;

beforeAll(async () => {
  c = await seedCustomer(handle);
  const audit = new AuditService(handle.db);
  svc = new TelephonyService(handle.db, audit, new DataCollectionService(handle.db, audit));
  engineer = await seedUser(handle, 'ENGINEER');
  const site = await seedSite(c.s, { sitecode: 'LTN01' });
  numbers = await seedNumbers(c.s, 'LTN01', ['+441582000001', '+441582000002']);
  userId = (await c.s.insertInto('discovery_users').values({ site_id: site.id, upn: 'new@contoso.test' } as never).returning('id').executeTakeFirstOrThrow()).id;
});

describe('number cool-off', () => {
  it('defaults to 90 days and marks a released number', async () => {
    expect(await cooloffDays(c.s)).toBe(90);
    expect(await markNumbersReleased(c.s, ['+441582000001'], 'Released in Teams (seen by Discovery)', new Date('2026-10-26T00:00:00Z'))).toBe(1);
    const n = await c.s.selectFrom('phone_numbers').select(['cooling_until', 'cooling_reason']).where('e164', '=', '+441582000001').executeTakeFirstOrThrow();
    expect(new Date(n.cooling_until!).toISOString()).toBe('2027-01-24T00:00:00.000Z');
  });

  it('refuses to assign a cooling number, and lists it', async () => {
    await expect(svc.updateUser(c.t, actor(), userId, { phone_number_id: numbers[0].id } as never, true)).rejects.toThrow(/cooling off until 2027-01-24/);
    const list = await svc.listNumbers(c.t, { page: 1, limit: 50 } as never);
    expect(list.items.find((i) => i.e164 === '+441582000001')).toMatchObject({ cooling_reason: 'Released in Teams (seen by Discovery)' });
  });

  it('assigns it once an engineer ends the cool-off, and records why', async () => {
    await svc.endNumberCooloff(c.t, actor(), numbers[0].id, 'Customer wants the old reception number back');
    await svc.updateUser(c.t, actor(), userId, { phone_number_id: numbers[0].id } as never, true);
    const n = await c.s.selectFrom('phone_numbers').select(['holder_id', 'cooling_until']).where('id', '=', numbers[0].id).executeTakeFirstOrThrow();
    expect(n).toEqual({ holder_id: userId, cooling_until: null });
  });

  it('does nothing when the period is 0', async () => {
    await svc.updateNumberPolicy(c.t, actor(), 0);
    expect(await markNumbersReleased(c.s, ['+441582000002'], 'x')).toBe(0);
  });
});
