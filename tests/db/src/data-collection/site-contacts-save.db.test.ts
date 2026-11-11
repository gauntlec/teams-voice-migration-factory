// Bug report "Adding Contacts to Site Data" (11 Nov 2026): the site's people are now saved as soon as they change, by sending only
// the people. That must leave the overview's other fields as they are.
import { beforeAll, describe, expect, it } from 'vitest';
import { AuditService } from '../../../../apps/api/src/common/audit.service';
import { DataCollectionService } from '../../../../apps/api/src/modules/data-collection/data-collection.service';
import { seedCustomer, seedSite, seedUser, useDb } from '../helpers';

const handle = useDb();
let svc: DataCollectionService;

beforeAll(() => {
  svc = new DataCollectionService(handle.db, new AuditService(handle.db));
});

describe('saving only the site’s people', () => {
  it('keeps the other overview fields', async () => {
    const c = await seedCustomer(handle);
    const pm = await seedUser(handle, 'PROJECT_MANAGER', { displayName: 'Pam Manager' });
    const site = (await seedSite(c.s, { sitecode: 'LON01' })).id;
    await svc.updateSiteOverview(c.t, pm, site, { notes: 'Reception moves in March', targetGoLive: '2026-12-01' } as never, true);

    const r = await svc.updateSiteOverview(c.t, pm, site, { contacts: { providerPm: [{ userId: pm.id }], siteContacts: [{ name: 'Sam Site', email: 'sam@contoso.test' }] } } as never, true);
    expect(r.overview).toMatchObject({
      notes: 'Reception moves in March',
      targetGoLive: '2026-12-01',
      contacts: { providerPm: [{ userId: pm.id }], siteContacts: [{ name: 'Sam Site', email: 'sam@contoso.test' }] },
    });
    // and taking someone off is saved the same way
    const after = await svc.updateSiteOverview(c.t, pm, site, { contacts: { providerPm: [{ userId: pm.id }], siteContacts: [] } } as never, true);
    expect(after.overview.contacts?.siteContacts ?? []).toEqual([]);
    expect(after.overview.notes).toBe('Reception moves in March');
  });
});
