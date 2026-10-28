// A campus with several buildings is one site: one site code, a primary address, and any number of additional addresses, each pinned on the map.
import { beforeAll, describe, expect, it } from 'vitest';
import { discoverySiteSchema } from '@tvmf/shared';
import { AuditService } from '../../../../apps/api/src/common/audit.service';
import { DataCollectionService } from '../../../../apps/api/src/modules/data-collection/data-collection.service';
import { seedCustomer, seedUser, useDb, type TestCustomer } from '../helpers';

const handle = useDb();
let c: TestCustomer;
let svc: DataCollectionService;
let engineer: Awaited<ReturnType<typeof seedUser>>;

beforeAll(async () => {
  c = await seedCustomer(handle);
  svc = new DataCollectionService(handle.db, new AuditService(handle.db));
  engineer = await seedUser(handle, 'ENGINEER');
});

const input = (v: Record<string, unknown>) => discoverySiteSchema.parse(v);
const patch = (v: Record<string, unknown>) => discoverySiteSchema.partial().parse(v);
const landing = async (code: string) => (await svc.get(c.t)).sites.find((s) => s.sitecode === code)!;

describe('site addresses', () => {
  it('saves additional addresses with a new site and returns them in order on the landing list', async () => {
    const site = await svc.addSite(
      c.t,
      engineer,
      input({
        sitecode: 'CAMP01',
        name: 'North Campus',
        address: '1 Main St, Springfield',
        latitude: '39.80',
        longitude: '-89.65',
        additionalAddresses: [
          { label: 'Building B', address: '20 Oak Ave, Springfield', latitude: '39.81', longitude: '-89.66' },
          { label: '', address: '22 Oak Ave, Springfield' },
        ],
      }),
      true,
    );
    expect(site.additionalAddresses).toHaveLength(2);
    const l = await landing('CAMP01');
    expect(l.additionalAddresses.map((a) => [a.label, a.address, a.latitude, a.longitude])).toEqual([
      ['Building B', '20 Oak Ave, Springfield', 39.81, -89.66],
      [null, '22 Oak Ave, Springfield', null, null],
    ]);
    expect(l.sitecode).toBe('CAMP01'); // the same site code for every address
  });

  it('replaces the list on edit, keeps it when an edit does not send it, and removes it with the site', async () => {
    const id = (await landing('CAMP01')).id;
    await svc.updateSite(c.t, engineer, id, patch({ additionalAddresses: [{ label: 'Gym', address: '5 Elm St' }] }), true);
    expect((await landing('CAMP01')).additionalAddresses.map((a) => a.label)).toEqual(['Gym']);
    const renamed = await svc.updateSite(c.t, engineer, id, patch({ name: 'North Campus (renamed)' }), true);
    expect(renamed.name).toBe('North Campus (renamed)');
    expect((await landing('CAMP01')).additionalAddresses.map((a) => a.label)).toEqual(['Gym']);
    await svc.updateSite(c.t, engineer, id, patch({ additionalAddresses: [] }), true);
    expect((await landing('CAMP01')).additionalAddresses).toEqual([]);
    await svc.updateSite(c.t, engineer, id, patch({ additionalAddresses: [{ address: 'x' }] }), true);
    await svc.deleteSite(c.t, engineer, id, true);
    expect(await c.s.selectFrom('discovery_site_addresses').select('id').execute()).toEqual([]);
  });

  it('refuses a blank address or a bad coordinate on an additional address', () => {
    expect(() => input({ sitecode: 'X1', additionalAddresses: [{ label: 'Blank', address: '   ' }] })).toThrow();
    expect(() => input({ sitecode: 'X1', additionalAddresses: [{ address: 'a', latitude: '200' }] })).toThrow();
  });
});
