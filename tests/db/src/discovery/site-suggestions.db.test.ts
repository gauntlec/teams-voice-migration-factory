// A discovered object's site, suggested from its number's range: accounts, common area phones, resource accounts, auto attendants and
// call queues. Only a suggestion, unless the customer switches on automatic adding - which never moves anything already on a site.
import { beforeAll, describe, expect, it } from 'vitest';
import { siteSuggestions } from '@tvmf/db';
import { AuditService } from '../../../../apps/api/src/common/audit.service';
import { DataCollectionService } from '../../../../apps/api/src/modules/data-collection/data-collection.service';
import { TelephonyService } from '../../../../apps/api/src/modules/data-collection/data-collection.telephony.service';
import { AutoAddByRangeService } from '../../../../apps/api/src/modules/tenant-discovery/auto-add-by-range.service';
import { TenantDiscoveryService } from '../../../../apps/api/src/modules/tenant-discovery/tenant-discovery.service';
import { seedCustomer, seedNumbers, seedSite, seedUser, unused, useDb, type TestCustomer } from '../helpers';

const handle = useDb();
let c: TestCustomer;
let boston: string;
let nyc: string;
let discovery: TenantDiscoveryService;
let auto: AutoAddByRangeService;
let engineer: Awaited<ReturnType<typeof seedUser>>;

const CAP_PLAN = [{ Capability: 'MCOCAP', CapabilityStatus: 'Enabled' }];
async function account(upn: string, name: string, lineUri: string | null, plans: unknown[] = []) {
  const obj = await c.s.insertInto('tenant_objects').values({ object_type: 'user', object_key: upn, display_name: name, data: {} } as never).returning('id').executeTakeFirstOrThrow();
  return (await c.s.insertInto('tenant_users').values({ object_id: obj.id, upn, display_name: name, entra_id: `eid-${upn}`, account_enabled: true, enterprise_voice_enabled: true, line_uri: lineUri, assigned_plans: JSON.stringify(plans) } as never).returning('id').executeTakeFirstOrThrow()).id;
}
async function object(type: string, key: string, name: string, data: Record<string, unknown>) {
  return (await c.s.insertInto('tenant_objects').values({ object_type: type, object_key: key, display_name: name, data } as never).returning('id').executeTakeFirstOrThrow()).id;
}
const by = async () => Object.fromEntries((await siteSuggestions(c.s)).items.map((i) => [i.key, i]));

let ann: string, lobby: string, onNyc: string, mixed: string, raMain: string, aa: string;

beforeAll(async () => {
  c = await seedCustomer(handle);
  engineer = await seedUser(handle, 'ENGINEER');
  boston = (await seedSite(c.s, { sitecode: 'BOS01' })).id;
  nyc = (await seedSite(c.s, { sitecode: 'NYC01' })).id;
  await seedNumbers(c.s, 'BOS01', ['+16175550101', '+16175550102', '+16175550103', '+16175550104', '+16175550105']);
  await seedNumbers(c.s, 'NYC01', ['+12125550101']);
  ann = await account('ann@contoso.test', 'Ann', 'tel:+16175550101');
  lobby = await account('lobby@contoso.test', 'Lobby', 'tel:+16175550102;ext=1', CAP_PLAN);
  onNyc = await account('nyc.user@contoso.test', 'On NYC', 'tel:+16175550103');
  await account('both@contoso.test', 'Both', 'tel:+16175550104');
  await c.s.updateTable('tenant_users').set({ telephone_numbers: JSON.stringify([{ number: '+12125550101' }]) } as never).where('upn', '=', 'both@contoso.test').execute();
  mixed = 'both@contoso.test';
  await account('nobody@contoso.test', 'No number', null);
  await account('elsewhere@contoso.test', 'Elsewhere', 'tel:+18005550100'); // not in any range
  await c.s.insertInto('discovery_users').values({ site_id: nyc, upn: 'nyc.user@contoso.test', display_name: 'On NYC' } as never).execute();
  raMain = await object('resource_account', 'ra-guid-1', 'Main RA', { PhoneNumber: 'tel:+16175550105' });
  aa = await object('auto_attendant', 'aa-1', 'Main Menu', { ApplicationInstances: ['RA-GUID-1'] });
  const audit = new AuditService(handle.db);
  const dc = new DataCollectionService(handle.db, audit);
  discovery = new TenantDiscoveryService(handle.db, unused('queue'), audit, unused('deployments'), dc, new TelephonyService(handle.db, audit, dc));
  auto = new AutoAddByRangeService(handle.db, audit, discovery);
});

describe('site suggestions from number ranges', () => {
  it('suggests a site for accounts, common area phones and voice apps; an app brings its resource account', async () => {
    const x = await by();
    expect(x['ann@contoso.test']).toMatchObject({ kind: 'account', as: 'user', sitecode: 'BOS01', state: 'suggest', numbers: ['+16175550101'] });
    expect(x['lobby@contoso.test']).toMatchObject({ kind: 'account', as: 'cap', sitecode: 'BOS01', state: 'suggest' });
    expect(x['aa-1']).toMatchObject({ kind: 'auto_attendant', sitecode: 'BOS01', state: 'suggest', numbers: ['+16175550105'] });
    expect(x['ra-guid-1']).toBeUndefined(); // listed by the auto attendant that is suggested to the same site
    expect(x['nobody@contoso.test']).toBeUndefined();
    expect(x['elsewhere@contoso.test']).toBeUndefined();
  });

  it('flags something on another site instead of suggesting it, and lists numbers that span two sites as mixed', async () => {
    const r = await siteSuggestions(c.s);
    expect(r.items.find((i) => i.key === 'nyc.user@contoso.test')).toMatchObject({ state: 'other_site', sitecode: 'BOS01', onSitecode: 'NYC01' });
    expect(r.mixed.map((m) => [m.label, m.sitecodes])).toEqual([['Both', ['BOS01', 'NYC01']]]);
    expect(r.items.find((i) => i.key === mixed)).toBeUndefined();
  });

  it('shows a resource account on its own when no voice app of the same site lists it', async () => {
    await c.s.updateTable('tenant_objects').set({ data: { ApplicationInstances: [] } as never }).where('id', '=', aa).execute();
    expect((await by())['ra-guid-1']).toMatchObject({ kind: 'resource_account', sitecode: 'BOS01', state: 'suggest' });
    await c.s.updateTable('tenant_objects').set({ data: { ApplicationInstances: ['RA-GUID-1'] } as never }).where('id', '=', aa).execute();
  });
});

describe('automatic adding', () => {
  it('does nothing while it is switched off', async () => {
    const run = await c.s.insertInto('tenant_discovery_runs').values({ started_by: engineer.id, status: 'completed', kind: 'sync', finished_at: new Date().toISOString() } as never).returning('id').executeTakeFirstOrThrow();
    expect(await auto.forTenant(c.t)).toBe(0);
    expect(await c.s.selectFrom('discovery_users').select('upn').execute()).toHaveLength(1);
    expect(run.id).toBeTruthy();
  });

  it('adds what is on no site to the site its number says, once per run, and never moves anything', async () => {
    await c.s.updateTable('tenant_discovery_config').set({ auto_add_by_number_range: true }).execute();
    expect(await auto.forTenant(c.t)).toBe(3); // ann, lobby, and the auto attendant (which brings its resource account)
    expect((await c.s.selectFrom('discovery_users').select(['upn', 'site_id']).orderBy('upn').execute()).map((r) => [r.upn, r.site_id])).toEqual([
      ['ann@contoso.test', boston],
      ['nyc.user@contoso.test', nyc], // untouched
    ]);
    expect((await c.s.selectFrom('discovery_caps').select(['upn', 'site_id']).execute()).map((r) => [r.upn, r.site_id])).toEqual([['lobby@contoso.test', boston]]);
    expect((await c.s.selectFrom('discovery_voice_apps').select('site_id').execute()).map((r) => r.site_id)).toEqual([boston]);
    expect(await auto.forTenant(c.t)).toBe(0); // the same run is not handled twice
    const cfg = await c.s.selectFrom('tenant_discovery_config').select(['auto_add_last_summary']).executeTakeFirstOrThrow();
    expect(cfg.auto_add_last_summary).toMatchObject({ added: 3, bySite: { BOS01: 3 } });
    expect(ann && lobby && onNyc && raMain).toBeTruthy();
  });
});
