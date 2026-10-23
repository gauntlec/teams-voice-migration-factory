// Add discovered objects to a site: matched on UPN / tenant object id (never a display name), accounts routed to Users or CAPs.
import { beforeAll, describe, expect, it } from 'vitest';
import { AuditService } from '../../../../apps/api/src/common/audit.service';
import { BuildService } from '../../../../apps/api/src/modules/build/build.service';
import { BuildValidationService } from '../../../../apps/api/src/modules/build/build-validation.service';
import { DataCollectionService } from '../../../../apps/api/src/modules/data-collection/data-collection.service';
import { TelephonyService } from '../../../../apps/api/src/modules/data-collection/data-collection.telephony.service';
import { TenantDiscoveryService } from '../../../../apps/api/src/modules/tenant-discovery/tenant-discovery.service';
import { seedCustomer, seedNumbers, seedSite, seedUser, unused, useDb, type TestCustomer } from '../helpers';

const handle = useDb();
let c: TestCustomer;
let build: BuildService;
let engineer: Awaited<ReturnType<typeof seedUser>>;
let luton: string;
let nyc: string;

const CAP_PLAN = [{ Capability: 'MCOCAP', CapabilityStatus: 'Enabled' }];
async function account(upn: string, name: string, plans: unknown[] = []) {
  const obj = await c.s.insertInto('tenant_objects').values({ object_type: 'user', object_key: upn, display_name: name, data: {} } as never).returning('id').executeTakeFirstOrThrow();
  return (await c.s.insertInto('tenant_users').values({ object_id: obj.id, upn, display_name: name, entra_id: `eid-${upn}`, account_enabled: true, enterprise_voice_enabled: false, assigned_plans: JSON.stringify(plans) } as never).returning('id').executeTakeFirstOrThrow()).id;
}
async function object(type: string, key: string, name: string, data: Record<string, unknown>) {
  return (await c.s.insertInto('tenant_objects').values({ object_type: type, object_key: key, display_name: name, data } as never).returning('id').executeTakeFirstOrThrow()).id;
}

beforeAll(async () => {
  c = await seedCustomer(handle);
  engineer = await seedUser(handle, 'ENGINEER');
  luton = (await seedSite(c.s, { sitecode: 'LUT01' })).id;
  nyc = (await seedSite(c.s, { sitecode: 'NYC01' })).id;
  const audit = new AuditService(handle.db);
  const dc = new DataCollectionService(handle.db, audit);
  const discovery = new TenantDiscoveryService(handle.db, unused('queue'), audit, unused('deployments'), dc, new TelephonyService(handle.db, audit, dc));
  build = new BuildService(handle.db, audit, new BuildValidationService(handle.db), discovery, unused('documentBuilder'), unused('files'));
});

describe('accounts: routed to Users or Common area phones', () => {
  it('detects a common area phone from its licence plan, and lets the engineer override', async () => {
    const person = await account('pat@contoso.test', 'Pat Lee');
    const lobby = await account('lobby@contoso.test', 'Lobby Phone', CAP_PLAN);
    const forced = await account('hall@contoso.test', 'Hall Phone', CAP_PLAN);
    const res = await build.addFromDiscovery(c.t, engineer, {
      kind: 'account',
      items: [{ id: person, siteId: luton }, { id: lobby, siteId: luton }, { id: forced, siteId: luton, as: 'user' }],
      alsoBuild: true,
    });
    const by = Object.fromEntries(res.map((r) => [r.key, r]));
    expect(by['pat@contoso.test']).toMatchObject({ as: 'user', dataCollection: 'added', designAndBuild: 'added' });
    expect(by['lobby@contoso.test']).toMatchObject({ as: 'cap', dataCollection: 'added', designAndBuild: 'added' });
    expect(by['hall@contoso.test']).toMatchObject({ as: 'user' });
    expect((await c.s.selectFrom('discovery_users').select('upn').execute()).map((r) => r.upn).sort()).toEqual(['hall@contoso.test', 'pat@contoso.test']);
    expect((await c.s.selectFrom('discovery_caps').select('upn').execute()).map((r) => r.upn)).toEqual(['lobby@contoso.test']);
    expect((await c.s.selectFrom('build_caps').select('upn').execute()).map((r) => r.upn)).toEqual(['lobby@contoso.test']);
    expect((await c.s.selectFrom('build_users').select('upn').execute()).map((r) => r.upn).sort()).toEqual(['hall@contoso.test', 'pat@contoso.test']);
  });

  it('does not add twice, does not move between sites, and says when it is already the other kind', async () => {
    const [pat] = (await c.s.selectFrom('tenant_users').select('id').where('upn', '=', 'pat@contoso.test').execute());
    const [lobby] = (await c.s.selectFrom('tenant_users').select('id').where('upn', '=', 'lobby@contoso.test').execute());
    const res = await build.addFromDiscovery(c.t, engineer, { kind: 'account', items: [{ id: pat.id, siteId: luton }, { id: lobby.id, siteId: nyc }], alsoBuild: true });
    expect(res.find((r) => r.key === 'pat@contoso.test')).toMatchObject({ dataCollection: 'already_on_site', designAndBuild: 'already_on_site' });
    expect(res.find((r) => r.key === 'lobby@contoso.test')).toMatchObject({ dataCollection: 'on_other_site', otherSite: 'LUT01', designAndBuild: 'not_added' });
    const wrongKind = await build.addFromDiscovery(c.t, engineer, { kind: 'account', items: [{ id: pat.id, siteId: luton, as: 'cap' }], alsoBuild: true });
    expect(wrongKind[0].note).toMatch(/already in data collection as a user/i);
    expect((await c.s.selectFrom('discovery_caps').select('id').where('upn', '=', 'pat@contoso.test').execute())).toHaveLength(0);
  });

  it('can stop at Data Collection', async () => {
    const id = await account('dc.only@contoso.test', 'DC Only');
    const res = await build.addFromDiscovery(c.t, engineer, { kind: 'account', items: [{ id, siteId: luton }], alsoBuild: false });
    expect(res[0]).toMatchObject({ dataCollection: 'added', designAndBuild: 'off' });
    expect(await c.s.selectFrom('build_users').select('id').where('upn', '=', 'dc.only@contoso.test').execute()).toHaveLength(0);
  });
});

describe('voice apps: two with the same name stay two', () => {
  it('matches each to its own live object and its own resource account, by id, not by name', async () => {
    await seedNumbers(c.s, 'LUT01', ['+442070000001']);
    await seedNumbers(c.s, 'NYC01', ['+12125550002']);
    const raA = await object('resource_account', 'ra-guid-a', 'Reception', { UserPrincipalName: 'reception.a@contoso.test', ApplicationId: 'ce933385-9390-45d1-9512-c8d228074e07', PhoneNumber: 'tel:+442070000001' });
    const raB = await object('resource_account', 'ra-guid-b', 'Reception', { UserPrincipalName: 'reception.b@contoso.test', ApplicationId: 'ce933385-9390-45d1-9512-c8d228074e07', PhoneNumber: 'tel:+12125550002' });
    const aaA = await object('auto_attendant', 'aa-guid-a', 'Reception', { Identity: 'aa-guid-a', LanguageId: 'en-GB', TimeZoneId: 'GMT Standard Time', ApplicationInstances: ['ra-guid-a'] });
    const aaB = await object('auto_attendant', 'aa-guid-b', 'Reception', { Identity: 'aa-guid-b', LanguageId: 'en-US', TimeZoneId: 'Eastern Standard Time', ApplicationInstances: ['ra-guid-b'] });

    const res = await build.addFromDiscovery(c.t, engineer, { kind: 'auto_attendant', items: [{ id: aaA, siteId: luton }, { id: aaB, siteId: nyc }], alsoBuild: true });
    expect(res.map((r) => r.dataCollection)).toEqual(['added', 'added']);
    expect(res.map((r) => r.designAndBuild)).toEqual(['added', 'added']);

    const dcRows = await c.s.selectFrom('discovery_resource_accounts').select(['name', 'site_id', 'tenant_object_id']).orderBy('site_id').execute();
    expect(dcRows).toHaveLength(2);
    expect(dcRows.map((r) => r.tenant_object_id).sort()).toEqual([aaA, aaB].sort());

    // what Teams holds is carried into Data Collection too, not just the name
    const dcLuton = await c.s.selectFrom('discovery_resource_accounts').selectAll().where('site_id', '=', luton).executeTakeFirstOrThrow();
    expect(dcLuton.comments).toContain('reception.a@contoso.test');
    expect(dcLuton.advanced_features).toContain('Language en-GB');
    expect(dcLuton.advanced_features).toContain('Time zone GMT Standard Time');
    const held = await c.s.selectFrom('phone_numbers').select(['e164', 'holder_type', 'holder_id']).where('e164', '=', '+442070000001').executeTakeFirstOrThrow();
    expect(held).toMatchObject({ holder_type: 'resource_account', holder_id: dcLuton.id });
    const dcNyc = await c.s.selectFrom('discovery_resource_accounts').selectAll().where('site_id', '=', nyc).executeTakeFirstOrThrow();
    expect(dcNyc.advanced_features).toContain('Language en-US');
    expect(dcNyc.comments).toContain('reception.b@contoso.test');

    const aas = await c.s.selectFrom('build_auto_attendants').select(['site_id', 'language_id', 'time_zone_id']).execute();
    expect(aas.find((a) => a.site_id === luton)).toMatchObject({ language_id: 'en-GB', time_zone_id: 'GMT Standard Time' });
    expect(aas.find((a) => a.site_id === nyc)).toMatchObject({ language_id: 'en-US', time_zone_id: 'Eastern Standard Time' });
    const ras = await c.s.selectFrom('build_resource_accounts').select(['site_id', 'upn', 'phone_number']).execute();
    expect(ras.find((r) => r.site_id === luton)).toMatchObject({ upn: 'reception.a@contoso.test', phone_number: '+442070000001' });
    expect(ras.find((r) => r.site_id === nyc)).toMatchObject({ upn: 'reception.b@contoso.test', phone_number: '+12125550002' });

    // adding the resource account of an attendant already on the site does not make a second row
    const again = await build.addFromDiscovery(c.t, engineer, { kind: 'resource_account', items: [{ id: raA, siteId: luton }, { id: raB, siteId: luton }], alsoBuild: true });
    expect(again.find((r) => r.key === 'ra-guid-a')).toMatchObject({ dataCollection: 'already_on_site', designAndBuild: 'already_on_site' });
    expect(again.find((r) => r.key === 'ra-guid-b')).toMatchObject({ dataCollection: 'on_other_site', otherSite: 'NYC01' });
    expect(await c.s.selectFrom('discovery_resource_accounts').select('id').execute()).toHaveLength(2);
  });
});

describe('voice apps without a resource account', () => {
  it('adds the call queue and the auto attendant but makes no empty resource account row', async () => {
    const before = (await c.s.selectFrom('build_resource_accounts').select('id').execute()).length;
    const cq = await object('call_queue', 'cq-guid-solo', 'Helpdesk Queue', { Identity: 'cq-guid-solo', LanguageId: 'en-GB', ApplicationInstances: [] });
    const aa = await object('auto_attendant', 'aa-guid-solo', 'Helpdesk Menu', { Identity: 'aa-guid-solo', LanguageId: 'en-GB' });
    const res = await build.addFromDiscovery(c.t, engineer, { kind: 'call_queue', items: [{ id: cq, siteId: luton }], alsoBuild: true });
    const res2 = await build.addFromDiscovery(c.t, engineer, { kind: 'auto_attendant', items: [{ id: aa, siteId: luton }], alsoBuild: true });
    expect([...res, ...res2].map((r) => r.designAndBuild)).toEqual(['added', 'added']);
    expect((await c.s.selectFrom('build_resource_accounts').select('id').execute()).length).toBe(before);
    const queue = await c.s.selectFrom('build_call_queues').select(['name', 'resource_accounts']).where('name', '=', 'Helpdesk Queue').executeTakeFirstOrThrow();
    const attendant = await c.s.selectFrom('build_auto_attendants').select(['name', 'resource_accounts']).where('name', '=', 'Helpdesk Menu').executeTakeFirstOrThrow();
    expect(queue.resource_accounts).toEqual([]);
    expect(attendant.resource_accounts).toEqual([]);
  });
});

describe('what a discovered call queue brings into Data Collection', () => {
  it('describes its agents, routing, exception handling and number, and says when a number is not in the site ranges', async () => {
    await seedNumbers(c.s, 'LUT01', ['+442070000050']);
    await account('agent.one@contoso.test', 'Agent One');
    const ra = await object('resource_account', 'ra-guid-q', 'Support Queue', { UserPrincipalName: 'support.q@contoso.test', ApplicationId: '11cd3e2e-fccb-42ad-ad00-878b93575e07', PhoneNumber: 'tel:+442070000050;ext=1' });
    const raOutside = await object('resource_account', 'ra-guid-out', 'Outside Queue', { UserPrincipalName: 'outside.q@contoso.test', ApplicationId: '11cd3e2e-fccb-42ad-ad00-878b93575e07', PhoneNumber: 'tel:+33140000000' });
    const cq = await object('call_queue', 'cq-guid-q', 'Support Queue', { Identity: 'cq-guid-q', LanguageId: 'en-GB', RoutingMethod: 'Attendant', Agents: [{ ObjectId: 'eid-agent.one@contoso.test' }], OverflowAction: 'Forward', OverflowThreshold: 20, OverflowActionTarget: { Id: 'tel:+442079999999', Type: 'Phone' }, TimeoutAction: 'Disconnect', TimeoutThreshold: 90, ApplicationInstances: ['ra-guid-q'] });
    const res = await build.addFromDiscovery(c.t, engineer, { kind: 'call_queue', items: [{ id: cq, siteId: luton }], alsoBuild: false });
    expect(res[0].dataCollection).toBe('added');
    const row = await c.s.selectFrom('discovery_resource_accounts').selectAll().where('tenant_object_id', '=', cq).executeTakeFirstOrThrow();
    expect(row.who_answers).toContain('agent.one@contoso.test');
    expect(row.who_answers).toContain('Routing: Attendant');
    expect(row.exception_conditions).toContain('More than 20 calls waiting');
    expect(row.exception_action).toContain('Overflow: forward the call (442079999999)'.replace('442', '+442'));
    expect(row.exception_action).toContain('Timeout: disconnect the call');
    expect(row.comments).toContain('support.q@contoso.test');
    const held = await c.s.selectFrom('phone_numbers').select(['holder_type', 'holder_id']).where('e164', '=', '+442070000050').executeTakeFirstOrThrow();
    expect(held).toMatchObject({ holder_type: 'resource_account', holder_id: row.id });

    // a resource account whose number is in no range is added, and the result says why the number was not attached
    const out = await build.addFromDiscovery(c.t, engineer, { kind: 'resource_account', items: [{ id: raOutside, siteId: luton }], alsoBuild: false });
    expect(out[0].note).toMatch(/\+33140000000 is not in any number range/);
    void ra;
  });
});
