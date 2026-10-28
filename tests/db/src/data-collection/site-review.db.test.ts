// The Site Data review is per site: each site is draft, submitted or accepted on its own. Nothing is locked; changes made
// to a site after it was submitted are recorded for the engineer until they are acknowledged. The site overview keeps one region
// (on the site) and the people on the site by role.
import { ConflictException, ForbiddenException } from '@nestjs/common';
import { beforeAll, describe, expect, it } from 'vitest';
import { AuditService } from '../../../../apps/api/src/common/audit.service';
import { DataCollectionService } from '../../../../apps/api/src/modules/data-collection/data-collection.service';
import { seedCustomer, seedSite, seedUser, useDb, type TestCustomer } from '../helpers';

const handle = useDb();
let c: TestCustomer;
let svc: DataCollectionService;
let engineer: Awaited<ReturnType<typeof seedUser>>;
let pm: Awaited<ReturnType<typeof seedUser>>;
let siteA: string, siteB: string;

beforeAll(async () => {
  c = await seedCustomer(handle);
  engineer = await seedUser(handle, 'ENGINEER');
  pm = await seedUser(handle, 'PROJECT_MANAGER');
  siteA = (await seedSite(c.s, { sitecode: 'LON01' })).id;
  siteB = (await seedSite(c.s, { sitecode: 'MAN01' })).id;
  svc = new DataCollectionService(handle.db, new AuditService(handle.db));
});

const status = (site: string) => c.s.selectFrom('discovery_sites').select('review_status').where('id', '=', site).executeTakeFirstOrThrow().then((r) => r.review_status);

describe('per-site review', () => {
  it('moves one site on without touching the other', async () => {
    expect(await status(siteA)).toBe('draft');
    await svc.submitSite(c.t, engineer, siteA);
    expect(await status(siteA)).toBe('submitted');
    expect(await status(siteB)).toBe('draft');

    await expect(svc.submitSite(c.t, engineer, siteA)).rejects.toBeInstanceOf(ConflictException);
    await expect(svc.acceptSite(c.t, pm, siteB)).rejects.toBeInstanceOf(ConflictException);

    await svc.acceptSite(c.t, pm, siteA);
    expect(await status(siteA)).toBe('accepted');
    await svc.reopenSite(c.t, pm, siteA);
    expect(await status(siteA)).toBe('draft');
  });

  it('lets a site contact submit only their own site', async () => {
    const contact = { ...c.t, siteScope: [siteB] };
    await expect(svc.submitSite(contact, engineer, siteA)).rejects.toBeInstanceOf(ForbiddenException);
    await svc.submitSite(contact, engineer, siteB);
    expect(await status(siteB)).toBe('submitted');
    await svc.reopenSite(c.t, pm, siteB);
  });

  it('records changes only after submission, and clears them when the engineer accepts', async () => {
    const pending = () => svc.listSiteChanges(c.t, siteA);

    // draft: edits are not recorded
    await svc.addNetwork(c.t, engineer, { site_id: siteA, scope: 'internal', subnet: '10.0.0.0', mask: '24' } as never, true);
    expect((await pending()).total).toBe(0);

    await svc.submitSite(c.t, engineer, siteA);
    const added = await svc.addNetwork(c.t, engineer, { site_id: siteA, scope: 'internal', subnet: '10.0.1.0', mask: '24' } as never, true);
    await svc.deleteNetwork(c.t, engineer, added.id, true);
    const p = await pending();
    expect(p.total).toBe(2);
    expect(p.items.map((i) => `${i.entity}: ${i.entity_label} ${i.action}`).sort()).toEqual(['Network (E911): 10.0.1.0 added', 'Network (E911): 10.0.1.0 removed']);
    expect(p.items[0]!.actor_name).toBeTruthy();

    // the landing payload counts them for the list of sites
    const landing = await svc.get(c.t);
    expect(landing.sites.find((s) => s.id === siteA)!.pendingChanges).toBe(2);
    expect(landing.sites.find((s) => s.id === siteB)!.pendingChanges).toBe(0);

    await svc.acceptSite(c.t, pm, siteA);
    expect((await pending()).total).toBe(0);
    // still not locked: edits after acceptance are recorded again
    await svc.addNetwork(c.t, engineer, { site_id: siteA, scope: 'internal', subnet: '10.0.2.0', mask: '24' } as never, true);
    expect((await pending()).total).toBe(1);
    await svc.acknowledgeSiteChanges(c.t, pm, siteA);
    expect((await pending()).total).toBe(0);
  });
});

describe('site overview', () => {
  it('keeps the region on the site as AMER, EMEA or APAC and shows it in the overview', async () => {
    await svc.updateSiteOverview(c.t, engineer, siteA, { region: 'EMEA', targetGoLive: 'Q3' } as never, true);
    const site = await c.s.selectFrom('discovery_sites').select(['region', 'overview']).where('id', '=', siteA).executeTakeFirstOrThrow();
    expect(site.region).toBe('EMEA');
    expect(site.overview).not.toHaveProperty('region');
    const summary = await svc.siteSummary(c.t, siteA);
    expect(summary.overview.region).toBe('EMEA');
  });

  it('stores the people by role, picked or typed, and refuses a picked user who is not active staff or the customer\'s', async () => {
    await svc.updateSiteOverview(
      c.t,
      engineer,
      siteA,
      { contacts: { providerPm: [{ userId: pm.id }], siteContacts: [{ name: 'Jane Smith', email: 'jane@contoso.test' }, { name: 'Jane Smith', email: 'jane@contoso.test' }] } } as never,
      true,
    );
    const summary = await svc.siteSummary(c.t, siteA);
    expect(summary.overview.contacts?.providerPm).toEqual([{ userId: pm.id }]);
    expect(summary.overview.contacts?.siteContacts).toEqual([{ name: 'Jane Smith', email: 'jane@contoso.test' }]); // de-duplicated
    expect(summary.contactUsers.map((u) => u.id)).toEqual([pm.id]);

    const outsider = await seedUser(handle, 'CUSTOMER'); // a customer user who is not a member of this customer
    await expect(
      svc.updateSiteOverview(c.t, engineer, siteA, { contacts: { siteContacts: [{ userId: outsider.id }] } } as never, true),
    ).rejects.toBeInstanceOf(ConflictException);
  });
});
