// Parked numbers: kept with the carrier for a retention fee, never claimed by a holder, and changed all or nothing.
import { beforeAll, describe, expect, it } from 'vitest';
import { setNumbersParked } from '@tvmf/db';
import { seedCustomer, seedNumbers, seedSite, useDb, type TestCustomer } from '../helpers';

const handle = useDb();
let c: TestCustomer;

const row = (e164: string) => c.s.selectFrom('phone_numbers').selectAll().where('e164', '=', e164).executeTakeFirstOrThrow();
const ids = async (...e164s: string[]) => (await c.s.selectFrom('phone_numbers').select('id').where('e164', 'in', e164s).execute()).map((r) => r.id);

beforeAll(async () => {
  c = await seedCustomer(handle);
  await seedSite(c.s, { sitecode: 'PRK01' });
  await seedNumbers(c.s, 'PRK01', ['+12125550201', '+12125550202', '+12125550203', '+12125550204']);
});

describe('setNumbersParked', () => {
  it('parks spare numbers and records when', async () => {
    const r = await setNumbersParked(c.s, await ids('+12125550201', '+12125550202'), true, null);
    expect(r.blocked).toEqual([]);
    expect(r.changed.map((n) => n.e164)).toEqual(['+12125550201', '+12125550202']);
    const n = await row('+12125550201');
    expect(n.status).toBe('parked');
    expect(n.parked_at).not.toBeNull();
  });

  it('changes nothing when one number cannot be parked', async () => {
    await c.s.updateTable('phone_numbers').set({ status: 'reserved' }).where('e164', '=', '+12125550204').execute();
    const r = await setNumbersParked(c.s, await ids('+12125550203', '+12125550204'), true, null);
    expect(r.changed).toEqual([]);
    expect(r.blocked).toEqual(['+12125550204 is reserved. Release the reservation first.']);
    expect((await row('+12125550203')).status).toBe('available');
  });

  it('brings a parked number back into use', async () => {
    const r = await setNumbersParked(c.s, await ids('+12125550202'), false, null);
    expect(r.blocked).toEqual([]);
    expect(await row('+12125550202')).toMatchObject({ status: 'available', parked_at: null, parked_by: null });
  });

  it('refuses to unpark a number that is not parked', async () => {
    const r = await setNumbersParked(c.s, await ids('+12125550203'), false, null);
    expect(r.blocked).toEqual(['+12125550203 is not parked.']);
  });
});
