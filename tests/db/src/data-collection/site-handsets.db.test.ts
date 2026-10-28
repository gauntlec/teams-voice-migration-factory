// Handset tracker: counted from the site's users (handset_model) and common area phones (device_model), with the stage the project
// manager sets for each model. Quantities follow Data Collection; the stage is kept per site and model.
import { NotFoundException } from '@nestjs/common';
import { beforeAll, describe, expect, it } from 'vitest';
import { AuditService } from '../../../../apps/api/src/common/audit.service';
import { DataCollectionService } from '../../../../apps/api/src/modules/data-collection/data-collection.service';
import { seedCustomer, seedSite, seedUser, useDb, type TestCustomer } from '../helpers';

const handle = useDb();
let c: TestCustomer;
let svc: DataCollectionService;
let pm: Awaited<ReturnType<typeof seedUser>>;
let siteA: string, siteB: string;

beforeAll(async () => {
  c = await seedCustomer(handle);
  pm = await seedUser(handle, 'PROJECT_MANAGER');
  siteA = (await seedSite(c.s, { sitecode: 'LON01' })).id;
  siteB = (await seedSite(c.s, { sitecode: 'MAN01' })).id;
  svc = new DataCollectionService(handle.db, new AuditService(handle.db));
});

const user = (site: string, upn: string, model: string | null, requires = true) =>
  c.s.insertInto('discovery_users').values({ site_id: site, upn, handset_model: model, requires_handset: requires } as never).execute();
const cap = (site: string, name: string, model: string | null) =>
  c.s.insertInto('discovery_caps').values({ site_id: site, display_name: name, device_model: model } as never).execute();

describe('handset tracker', () => {
  it('counts users and common area phones per model for one site only', async () => {
    await user(siteA, 'a1@contoso.test', 'Poly CCX 400');
    await user(siteA, 'a2@contoso.test', 'poly ccx 400');
    await user(siteA, 'a3@contoso.test', null); // needs a handset, no model yet
    await user(siteA, 'a4@contoso.test', null, false); // no handset needed: not mentioned
    await cap(siteA, 'Lobby', 'Poly CCX 400');
    await cap(siteA, 'Warehouse', 'Yealink T54W');
    await user(siteB, 'b1@contoso.test', 'Other Model');

    const r = await svc.siteHandsets(c.t, siteA);
    expect(r.models.map((m) => [m.model, m.users, m.caps, m.status])).toEqual([
      ['Poly CCX 400', 2, 1, 'not_ordered'],
      ['Yealink T54W', 0, 1, 'not_ordered'],
    ]);
    expect(r.usersWithoutModel).toBe(1);
    expect(r.totals.not_ordered).toBe(4);
  });

  it('records the stage per model and moves it on; not_ordered clears it', async () => {
    let r = await svc.setSiteHandsetStatus(c.t, pm, siteA, { model: 'POLY CCX 400', status: 'ordered' });
    expect(r.models.find((m) => m.key === 'poly ccx 400')).toMatchObject({ status: 'ordered', updatedBy: pm.displayName });
    r = await svc.setSiteHandsetStatus(c.t, pm, siteA, { model: 'Poly CCX 400', status: 'delivered' });
    expect(r.models.find((m) => m.key === 'poly ccx 400')!.status).toBe('delivered');
    expect(r.totals.delivered).toBe(3);
    r = await svc.setSiteHandsetStatus(c.t, pm, siteA, { model: 'Poly CCX 400', status: 'installed' });
    expect(r.models.find((m) => m.key === 'poly ccx 400')!.status).toBe('installed');
    expect(r.totals).toMatchObject({ installed: 3, not_ordered: 1 });
    r = await svc.setSiteHandsetStatus(c.t, pm, siteA, { model: 'Poly CCX 400', status: 'not_ordered' });
    expect(r.models.find((m) => m.key === 'poly ccx 400')!.status).toBe('not_ordered');
  });

  it('keeps each site separate and refuses a model the site does not have', async () => {
    await svc.setSiteHandsetStatus(c.t, pm, siteA, { model: 'Yealink T54W', status: 'in_tooling' });
    expect((await svc.siteHandsets(c.t, siteB)).models).toEqual([expect.objectContaining({ model: 'Other Model', status: 'not_ordered' })]);
    await expect(svc.setSiteHandsetStatus(c.t, pm, siteB, { model: 'Yealink T54W', status: 'ordered' })).rejects.toBeInstanceOf(NotFoundException);
  });
});
