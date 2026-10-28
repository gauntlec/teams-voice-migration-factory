// Bulk imports in Site Data: number ranges (DID-START, DID-END) and the preview context for the user import.
import { BadRequestException } from '@nestjs/common';
import { beforeAll, describe, expect, it } from 'vitest';
import { AuditService } from '../../../../apps/api/src/common/audit.service';
import { DataCollectionService } from '../../../../apps/api/src/modules/data-collection/data-collection.service';
import { TelephonyService } from '../../../../apps/api/src/modules/data-collection/data-collection.telephony.service';
import { seedCustomer, seedSite, seedUser, useDb, type TestCustomer } from '../helpers';

const handle = useDb();
let c: TestCustomer;
let svc: TelephonyService;
let engineer: Awaited<ReturnType<typeof seedUser>>;
let siteA: string, siteB: string;

beforeAll(async () => {
  c = await seedCustomer(handle);
  engineer = await seedUser(handle, 'ENGINEER');
  siteA = (await seedSite(c.s, { sitecode: 'LON01' })).id;
  siteB = (await seedSite(c.s, { sitecode: 'MAN01' })).id;
  const audit = new AuditService(handle.db);
  svc = new TelephonyService(handle.db, audit, new DataCollectionService(handle.db, audit));
});

const numbersOf = (code: string) =>
  c.s
    .selectFrom('phone_numbers as n')
    .innerJoin('discovery_number_ranges as r', 'r.id', 'n.range_id')
    .select('n.e164')
    .where('r.sitecode', '=', code)
    .orderBy('n.e164')
    .execute()
    .then((r) => r.map((x) => x.e164));

describe('number range import', () => {
  it('creates a range per row, with or without a leading +, and generates the numbers', async () => {
    const r = await svc.importRanges(
      c.t,
      engineer,
      { site_id: siteA, kind: 'new', rows: [{ range_start: '+442070001000', range_end: '+442070001002' }, { range_start: '442070002000', range_end: '442070002001' }] },
      true,
    );
    expect(r).toMatchObject({ created: 2, numbers: 5, skipped: 0, errors: [] });
    expect(await numbersOf('LON01')).toEqual(['+442070001000', '+442070001001', '+442070001002', '+442070002000', '+442070002001']);
  });

  it('skips a row whose numbers are all in the inventory, reports a bad row and still imports the rest', async () => {
    const r = await svc.importRanges(
      c.t,
      engineer,
      {
        site_id: siteA,
        kind: 'retain',
        rows: [
          { range_start: '+442070001000', range_end: '+442070001002' }, // already there
          { range_start: '+442070003005', range_end: '+442070003001' }, // end before start
          { range_start: '+442070003000', range_end: '+442070003000' }, // a single new number
        ],
      },
      true,
    );
    expect(r.created).toBe(1);
    expect(r.skipped).toBe(1);
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0]).toMatchObject({ row: 2 });
    expect(await numbersOf('LON01')).toContain('+442070003000');
    const kinds = await c.s.selectFrom('discovery_number_ranges').select('kind').where('range_start', '=', '+442070003000').execute();
    expect(kinds).toEqual([{ kind: 'retain' }]);
  });
});

describe('user import preview context', () => {
  it('returns the UPNs already on the customer and the numbers still free on the site, read fresh', async () => {
    await c.s.insertInto('discovery_users').values({ site_id: siteB, upn: 'Existing@Contoso.test' }).execute();
    const before = await svc.userImportContext(c.t, siteA);
    expect(before.upns).toContain('existing@contoso.test');
    expect(before.freeNumbers).toEqual(expect.arrayContaining(['+442070001000', '+442070003000']));

    await c.s.updateTable('phone_numbers').set({ status: 'reserved' }).where('e164', '=', '+442070001000').execute();
    const after = await svc.userImportContext(c.t, siteA);
    expect(after.freeNumbers).not.toContain('+442070001000');
  });

  it('is limited to the sites the caller can see and needs a site', async () => {
    await expect(svc.userImportContext(c.t, '')).rejects.toBeInstanceOf(BadRequestException);
    const contact = { ...c.t, siteScope: [siteB] };
    const mine = await svc.userImportContext(contact, siteB);
    expect(mine.upns).toContain('existing@contoso.test');
  });
});
