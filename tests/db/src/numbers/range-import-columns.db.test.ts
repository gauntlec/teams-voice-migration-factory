// Bug report "Number Range Import from Excel" (11 Nov 2026): the template only had the range's start and end. A row can now carry its
// own Number transition, carrier, new carrier and comments (blank = the choice made on screen), and ticked ranges can be changed together.
import { beforeAll, describe, expect, it } from 'vitest';
import { AuditService } from '../../../../apps/api/src/common/audit.service';
import { DataCollectionService } from '../../../../apps/api/src/modules/data-collection/data-collection.service';
import { TelephonyService } from '../../../../apps/api/src/modules/data-collection/data-collection.telephony.service';
import { seedCustomer, seedSite, seedUser, useDb } from '../helpers';

const handle = useDb();
let svc: TelephonyService;

beforeAll(() => {
  const audit = new AuditService(handle.db);
  svc = new TelephonyService(handle.db, audit, new DataCollectionService(handle.db, audit));
});

describe('number ranges from a spreadsheet', () => {
  it('takes each row’s own transition, carriers and comments, and the on-screen choices for blank cells', async () => {
    const c = await seedCustomer(handle);
    const pm = await seedUser(handle, 'PROJECT_MANAGER');
    const site = (await seedSite(c.s, { sitecode: 'LON01' })).id;

    const r = await svc.importRanges(c.t, pm, {
      site_id: site,
      kind: 'new',
      carrier: 'Gamma',
      rows: [
        { range_start: '+442070000100', range_end: '+442070000109', kind: 'port', carrier: 'BT', new_carrier: 'Gamma', comments: 'Main DDI block' },
        { range_start: '+442070000200', range_end: '+442070000201' },
        { range_start: '+442070000300', range_end: '+442070000300', kind: 'retain', comments: 'Fax line' },
        // a port with no new carrier anywhere: reported, the rest still go in
        { range_start: '+442070000400', range_end: '+442070000401', kind: 'port' },
      ],
    }, true);
    expect(r).toMatchObject({ created: 3, errors: [{ row: 4, message: expect.stringMatching(/NEW CARRIER/) }] });

    const rows = await c.s.selectFrom('discovery_number_ranges').select(['range_start', 'kind', 'carrier', 'new_carrier', 'comments']).where('sitecode', '=', 'LON01').orderBy('range_start').execute();
    expect(rows).toEqual([
      { range_start: '+442070000100', kind: 'port', carrier: 'BT', new_carrier: 'Gamma', comments: 'Main DDI block' },
      { range_start: '+442070000200', kind: 'new', carrier: 'Gamma', new_carrier: null, comments: null },
      { range_start: '+442070000300', kind: 'retain', carrier: 'Gamma', new_carrier: null, comments: 'Fax line' },
    ]);
  });

  it('changes ticked ranges together, each checked as editing it alone would be', async () => {
    const c = await seedCustomer(handle);
    const pm = await seedUser(handle, 'PROJECT_MANAGER');
    const site = (await seedSite(c.s, { sitecode: 'MAN01' })).id;
    await svc.importRanges(c.t, pm, { site_id: site, kind: 'new', rows: [{ range_start: '+441610000100', range_end: '+441610000101' }, { range_start: '+441610000200', range_end: '+441610000201' }] }, true);
    const ids = (await c.s.selectFrom('discovery_number_ranges').select('id').where('sitecode', '=', 'MAN01').orderBy('range_start').execute()).map((x) => x.id);

    // a port needs its new carrier: without one nothing changes, and each range says why
    const refused = await svc.bulkUpdateRanges(c.t, pm, { ids, kind: 'port' }, true);
    expect(refused).toMatchObject({ updated: 0, errors: [{ range: '+441610000100 – +441610000101' }, { range: '+441610000200 – +441610000201' }] });

    expect(await svc.bulkUpdateRanges(c.t, pm, { ids, kind: 'port', carrier: 'BT', new_carrier: 'Gamma' }, true)).toEqual({ updated: 2, errors: [] });
    const after = await c.s.selectFrom('discovery_number_ranges').select(['kind', 'carrier', 'new_carrier']).where('sitecode', '=', 'MAN01').execute();
    expect(after).toEqual([
      { kind: 'port', carrier: 'BT', new_carrier: 'Gamma' },
      { kind: 'port', carrier: 'BT', new_carrier: 'Gamma' },
    ]);
    await expect(svc.bulkUpdateRanges(c.t, pm, { ids }, true)).rejects.toThrow(/Choose what to change/);
  });
});
