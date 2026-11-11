// Bug report "Number not in site Ranges": a user imported with a number they couldn't be given now says why - the number isn't in any
// of the site's ranges, or it is but already assigned (or parked or reserved).
import { beforeAll, describe, expect, it } from 'vitest';
import { AuditService } from '../../../../apps/api/src/common/audit.service';
import { DataCollectionService } from '../../../../apps/api/src/modules/data-collection/data-collection.service';
import { TelephonyService } from '../../../../apps/api/src/modules/data-collection/data-collection.telephony.service';
import { seedCustomer, seedNumbers, seedSite, seedUser, useDb } from '../helpers';

const handle = useDb();
let svc: TelephonyService;

beforeAll(() => {
  const audit = new AuditService(handle.db);
  svc = new TelephonyService(handle.db, audit, new DataCollectionService(handle.db, audit));
});

describe('a requested number the user was not given', () => {
  it('says whether it is outside the site’s ranges or already in use', async () => {
    const c = await seedCustomer(handle);
    const pm = await seedUser(handle, 'PROJECT_MANAGER');
    const lon = (await seedSite(c.s, { sitecode: 'LON01' })).id;
    await seedSite(c.s, { sitecode: 'MAN01' });
    await seedNumbers(c.s, 'LON01', ['+442070000101', '+442070000102']);
    await seedNumbers(c.s, 'MAN01', ['+441610000101']);

    const r = await svc.importUsers(c.t, pm, lon, [
      { upn: 'held@contoso.test', requested_number: '+442070000101' },
      // the same number again: inside London's ranges, but the first user has it
      { upn: 'taken@contoso.test', requested_number: '020 7000 0101' },
      // Manchester's number: not in London's ranges
      { upn: 'elsewhere@contoso.test', requested_number: '+441610000101' },
      { upn: 'nowhere@contoso.test', requested_number: '+15550000000' },
      { upn: 'none@contoso.test' },
    ] as never, true);
    expect(r).toMatchObject({ created: 5, errors: [] });

    const list = await svc.listUsers(c.t, { siteId: lon } as never);
    const state = Object.fromEntries(list.items.map((u) => [u.upn, [u.phone_number, u.requested_number_state]]));
    expect(state).toEqual({
      'held@contoso.test': ['+442070000101', null],
      'taken@contoso.test': [null, 'taken'],
      'elsewhere@contoso.test': [null, 'outside_site_ranges'],
      'nowhere@contoso.test': [null, 'outside_site_ranges'],
      'none@contoso.test': [null, null],
    });
  });
});
