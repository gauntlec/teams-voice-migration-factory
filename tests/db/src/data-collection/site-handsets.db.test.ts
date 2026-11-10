// Handset tracker: counted from the site's users (handset_model) and common area phones (device_model), with the stage the project
// manager sets for each model. Quantities follow Site Data; the stage is kept per site and model.
import { NotFoundException } from '@nestjs/common';
import { beforeAll, describe, expect, it } from 'vitest';
import { AuditService } from '../../../../apps/api/src/common/audit.service';
import { DataCollectionService } from '../../../../apps/api/src/modules/data-collection/data-collection.service';
import { TelephonyService } from '../../../../apps/api/src/modules/data-collection/data-collection.telephony.service';
import { BuildService } from '../../../../apps/api/src/modules/build/build.service';
import { BuildValidationService } from '../../../../apps/api/src/modules/build/build-validation.service';
import { seedCustomer, seedSite, seedUser, unused, useDb, type TestCustomer } from '../helpers';

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

// Bug report "Physical Phone Tracking": who gets a handset, a tick per handset once it is installed, and the lists' handset filter.
describe('handset installation', () => {
  let siteC: string;
  let engineer: Awaited<ReturnType<typeof seedUser>>;
  beforeAll(async () => {
    siteC = (await seedSite(c.s, { sitecode: 'GLA01' })).id;
    engineer = await seedUser(handle, 'ENGINEER');
    await user(siteC, 'c1@contoso.test', 'Poly CCX 400');
    await user(siteC, 'c2@contoso.test', null); // needs one, no model yet
    await user(siteC, 'c3@contoso.test', null, false); // gets no handset
    await cap(siteC, 'Reception', 'Poly CCX 400');
  });
  const idOf = async (upn: string) => (await c.s.selectFrom('discovery_users').select('id').where('upn', '=', upn).executeTakeFirstOrThrow()).id;

  it('lists users who need a handset and every common area phone, none installed yet', async () => {
    const r = await svc.siteHandsetDevices(c.t, siteC);
    expect(r.devices.map((d) => [d.kind, d.upn ?? d.name, d.model, d.installedAt])).toEqual([
      ['user', 'c1@contoso.test', 'Poly CCX 400', null],
      ['user', 'c2@contoso.test', null, null],
      ['cap', 'Reception', 'Poly CCX 400', null],
    ]);
    expect(r).toMatchObject({ installed: 0, total: 3 });
  });

  it('records who ticked it, counts it per model on the Overview, and clears it again', async () => {
    const id = await idOf('c1@contoso.test');
    const before = await c.s.selectFrom('discovery_users').select('updated_at').where('id', '=', id).executeTakeFirstOrThrow();
    const r = await svc.setHandsetInstalled(c.t, engineer, siteC, 'user', id, true);
    expect(r.devices.find((d) => d.id === id)).toMatchObject({ installedBy: engineer.displayName });
    expect(r.installed).toBe(1);
    expect((await svc.siteHandsets(c.t, siteC)).models.find((m) => m.key === 'poly ccx 400')).toMatchObject({ total: 2, installed: 1 });
    // a tick is not a Site Data edit
    const after = await c.s.selectFrom('discovery_users').select('updated_at').where('id', '=', id).executeTakeFirstOrThrow();
    expect(new Date(after.updated_at as never).getTime()).toBe(new Date(before.updated_at as never).getTime());
    const cleared = await svc.setHandsetInstalled(c.t, engineer, siteC, 'user', id, false);
    expect(cleared.devices.find((d) => d.id === id)).toMatchObject({ installedAt: null, installedBy: null });
  });

  it("refuses a user from another site", async () => {
    const other = await idOf('b1@contoso.test');
    await expect(svc.setHandsetInstalled(c.t, engineer, siteC, 'user', other, true)).rejects.toThrow(NotFoundException);
  });

  it('filters the Site Data and Design & Build users lists by who gets a handset', async () => {
    const telephony = new TelephonyService(handle.db, new AuditService(handle.db), svc);
    const upns = async (handset: 'yes' | 'no') => (await telephony.listUsers(c.t, { siteId: siteC, handset, page: 1, limit: 50 } as never)).items.map((u) => u.upn).sort();
    expect(await upns('yes')).toEqual(['c1@contoso.test', 'c2@contoso.test']);
    expect(await upns('no')).toEqual(['c3@contoso.test']);

    for (const upn of ['c1@contoso.test', 'c3@contoso.test']) {
      await c.s.insertInto('build_users').values({ site_id: siteC, upn, discovery_user_id: await idOf(upn) } as never).execute();
    }
    const build = new BuildService(handle.db, new AuditService(handle.db), new BuildValidationService(handle.db), unused('discovery'), unused('documentBuilder'), unused('files'));
    const rows = (await build.listUsers(c.t, { siteId: siteC, handset: 'yes', page: 1, limit: 50 } as never)).items;
    expect((rows as Record<string, unknown>[]).map((r) => [r.upn, r.requested_handset, r.requested_handset_model])).toEqual([['c1@contoso.test', true, 'Poly CCX 400']]);
    expect((await build.listUsers(c.t, { siteId: siteC, handset: 'no', page: 1, limit: 50 } as never)).items.map((r) => r.upn)).toEqual(['c3@contoso.test']);
  });
});
