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
let discovery: TenantDiscoveryService;
let tel: TelephonyService;
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
  discovery = new TenantDiscoveryService(handle.db, unused('queue'), audit, unused('deployments'), dc, (tel = new TelephonyService(handle.db, audit, dc)));
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
    const aaA = await object('auto_attendant', 'aa-guid-a', 'Reception', { Identity: 'aa-guid-a', LanguageId: 'en-GB', TimeZoneId: 'GMT Standard Time', ApplicationInstances: ['ra-guid-a'], DefaultCallFlow: { Greetings: [{ TextToSpeechPrompt: 'Welcome to Luton' }], Menu: { MenuOptions: [{ DtmfResponse: 100, Action: 2, CallTarget: { Id: 'tel:+442079990000', Type: 4 } }] } } });
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

    // each also has its own Call flows row, read back from its own live settings and already linked to its Design & Build row
    const flows = await c.s.selectFrom('discovery_flows').selectAll().orderBy('site_id').execute();
    expect(flows).toHaveLength(2);
    const lutonFlow = flows.find((f) => f.site_id === luton)!;
    const nycFlow = flows.find((f) => f.site_id === nyc)!;
    expect(lutonFlow).toMatchObject({ kind: 'auto_attendant', name: 'Reception', tenant_object_id: aaA, resource_account_id: dcLuton.id });
    expect(nycFlow).toMatchObject({ tenant_object_id: aaB, resource_account_id: dcNyc.id });
    expect(lutonFlow.wizard_answers).toMatchObject({ languageId: 'en-GB', businessFlow: { mode: 'direct', greeting: 'Welcome to Luton', target: { kind: 'external', label: '+442079990000' } } });
    expect(lutonFlow.build_auto_attendant_id).toBeTruthy();
    expect(lutonFlow.imported_at).toBeTruthy();
    expect(nycFlow.build_auto_attendant_id).toBeTruthy();

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

    // a resource account whose number is in no range: the number is added to the site's ranges (as a single-number re-point range) and attached
    const out = await build.addFromDiscovery(c.t, engineer, { kind: 'resource_account', items: [{ id: raOutside, siteId: luton }], alsoBuild: false });
    expect(out[0].note).toBeUndefined();
    const range = await c.s.selectFrom('discovery_number_ranges').select(['sitecode', 'kind', 'range_start', 'range_end']).where('range_start', '=', '+33140000000').executeTakeFirstOrThrow();
    expect(range).toMatchObject({ sitecode: 'LUT01', kind: 'retain', range_end: '+33140000000' });
    const heldOut = await c.s.selectFrom('phone_numbers').select(['holder_type']).where('e164', '=', '+33140000000').executeTakeFirstOrThrow();
    expect(heldOut.holder_type).toBe('resource_account');
    void ra;
  });
});

describe('Call flows for discovered voice apps', () => {
  it('shows a menu that sends calls to a call queue as a link to that queue\'s own Call flows row, and Import links instead of duplicating', async () => {
    await account('agent.two@contoso.test', 'Agent Two');
    const cq = await object('call_queue', 'cq-guid-n', 'Billing Queue', { Identity: 'cq-guid-n', LanguageId: 'en-GB', Agents: [{ ObjectId: 'eid-agent.two@contoso.test' }], RoutingMethod: 'RoundRobin' });
    const aa = await object('auto_attendant', 'aa-guid-n', 'Main Menu', { Identity: 'aa-guid-n', LanguageId: 'en-GB', DefaultCallFlow: { Greetings: [{ TextToSpeechPrompt: 'Press 1 for billing' }], Menu: { DialByNameEnabled: true, MenuOptions: [{ DtmfResponse: 1, Action: 2, CallTarget: { Id: 'cq-guid-n', Type: 6 } }, { DtmfResponse: 0, Action: 0 }] } } });
    await build.addFromDiscovery(c.t, engineer, { kind: 'call_queue', items: [{ id: cq, siteId: luton }], alsoBuild: false });
    await build.addFromDiscovery(c.t, engineer, { kind: 'auto_attendant', items: [{ id: aa, siteId: luton }], alsoBuild: false });

    const queueFlow = await c.s.selectFrom('discovery_flows').selectAll().where('tenant_object_id', '=', cq).executeTakeFirstOrThrow();
    const menuFlow = await c.s.selectFrom('discovery_flows').selectAll().where('tenant_object_id', '=', aa).executeTakeFirstOrThrow();
    expect(queueFlow.wizard_answers).toMatchObject({ routingMethod: 'RoundRobin', agents: ['agent.two@contoso.test'] });
    const options = (menuFlow.wizard_answers as { businessFlow: { options: { key: string; target: Record<string, unknown> }[] } }).businessFlow.options;
    expect(options[0]).toMatchObject({ key: '1', target: { kind: 'call_queue', label: 'Billing Queue', flowId: queueFlow.id } });
    expect(options[1]).toMatchObject({ key: '0', target: { kind: 'operator' } });
    // Data Collection only so far: not in Design & Build, so the flow is not marked imported
    expect(menuFlow.imported_at).toBeNull();

    // Import to Design & Build: builds the row from the live settings and links it, once
    const first = await build.importFlowWizard(c.t, engineer, menuFlow.id);
    const again = await build.importFlowWizard(c.t, engineer, menuFlow.id);
    expect(again.row.id).toBe(first.row.id);
    expect(await c.s.selectFrom('build_auto_attendants').select('id').where('name', '=', 'Main Menu').execute()).toHaveLength(1);
    const linked = await c.s.selectFrom('discovery_flows').select(['imported_at', 'build_auto_attendant_id']).where('id', '=', menuFlow.id).executeTakeFirstOrThrow();
    expect(linked.build_auto_attendant_id).toBe(first.row.id);
    expect(linked.imported_at).toBeTruthy();
  });
});

describe('one auto attendant with several resource accounts', () => {
  async function setup(tag: string, siteCode: string, nums: [string, string]) {
    await seedNumbers(c.s, siteCode, nums);
    const ra1 = await object('resource_account', `ra-${tag}-1`, `Main ${tag} 1`, { UserPrincipalName: `main1.${tag}@contoso.test`, ApplicationId: 'ce933385-9390-45d1-9512-c8d228074e07', PhoneNumber: `tel:${nums[0]}` });
    const ra2 = await object('resource_account', `ra-${tag}-2`, `Main ${tag} 2`, { UserPrincipalName: `main2.${tag}@contoso.test`, ApplicationId: 'ce933385-9390-45d1-9512-c8d228074e07', PhoneNumber: `tel:${nums[1]}` });
    const aa = await object('auto_attendant', `aa-${tag}`, `Main ${tag}`, { Identity: `aa-${tag}`, LanguageId: 'en-GB', ApplicationInstances: [`ra-${tag}-1`, `ra-${tag}-2`] });
    return { ra1, ra2, aa };
  }
  async function expectWhole(tag: string, siteId: string, nums: [string, string]) {
    const dc = await c.s.selectFrom('discovery_resource_accounts').selectAll().where('site_id', '=', siteId).where('name', 'like', `Main ${tag}%`).execute();
    expect(dc).toHaveLength(1);
    const held = await c.s.selectFrom('phone_numbers').select(['e164', 'holder_id']).where('e164', 'in', nums).execute();
    expect(held.map((h) => h.holder_id)).toEqual([dc[0]!.id, dc[0]!.id]);
    expect(dc[0]!.comments).toContain(`main1.${tag}@contoso.test`);
    expect(dc[0]!.comments).toContain(`main2.${tag}@contoso.test`);
    const aas = await c.s.selectFrom('build_auto_attendants').select(['id', 'resource_accounts']).where('site_id', '=', siteId).where('name', 'like', `Main ${tag}%`).execute();
    expect(aas).toHaveLength(1);
    const ras = await c.s.selectFrom('build_resource_accounts').select(['id', 'upn', 'phone_number']).where('site_id', '=', siteId).where('upn', 'like', `%.${tag}@contoso.test`).orderBy('upn').execute();
    expect(ras.map((r) => r.upn)).toEqual([`main1.${tag}@contoso.test`, `main2.${tag}@contoso.test`]);
    expect(ras.map((r) => r.phone_number)).toEqual(nums);
    expect([...(aas[0]!.resource_accounts as string[])].sort()).toEqual(ras.map((r) => r.id).sort());
    expect(await c.s.selectFrom('discovery_flows').select('id').where('site_id', '=', siteId).where('name', 'like', `Main ${tag}%`).execute()).toHaveLength(1);
  }

  it('keeps both resource accounts when both are added together', async () => {
    const { ra1, ra2 } = await setup('both', 'LUT01', ['+442070001001', '+442070001002']);
    const res = await build.addFromDiscovery(c.t, engineer, { kind: 'resource_account', items: [{ id: ra1, siteId: luton }, { id: ra2, siteId: luton }], alsoBuild: true });
    expect(res.map((r) => r.designAndBuild)).toEqual(['added', 'added']);
    await expectWhole('both', luton, ['+442070001001', '+442070001002']);
  });

  it('keeps both when the auto attendant itself is added', async () => {
    const { aa } = await setup('aa', 'NYC01', ['+12125552001', '+12125552002']);
    await build.addFromDiscovery(c.t, engineer, { kind: 'auto_attendant', items: [{ id: aa, siteId: nyc }], alsoBuild: true });
    await expectWhole('aa', nyc, ['+12125552001', '+12125552002']);
  });

  it('adds the second resource account to the existing record when it comes later', async () => {
    const { ra1, ra2 } = await setup('late', 'LUT01', ['+442070003001', '+442070003002']);
    await build.addFromDiscovery(c.t, engineer, { kind: 'resource_account', items: [{ id: ra1, siteId: luton }], alsoBuild: true });
    const later = await build.addFromDiscovery(c.t, engineer, { kind: 'resource_account', items: [{ id: ra2, siteId: luton }], alsoBuild: true });
    expect(later[0]).toMatchObject({ dataCollection: 'added', designAndBuild: 'added' });
    await expectWhole('late', luton, ['+442070003001', '+442070003002']);
  });

  it('also makes one record when the bulk Import brings both resource accounts in', async () => {
    const { ra1, ra2 } = await setup('bulk', 'LUT01', ['+442070004001', '+442070004002']);
    await discovery.importResourceAccounts(c.t, engineer, { assignments: [{ id: ra1, siteId: luton }, { id: ra2, siteId: luton }] } as never, true);
    const dc = await c.s.selectFrom('discovery_resource_accounts').select('id').where('site_id', '=', luton).where('name', 'like', 'Main bulk%').execute();
    expect(dc).toHaveLength(1);
    expect(await c.s.selectFrom('discovery_resource_account_members').select('tenant_object_id').where('resource_account_id', '=', dc[0]!.id).execute()).toHaveLength(2);
    const held = await c.s.selectFrom('phone_numbers').select('holder_id').where('e164', 'in', ['+442070004001', '+442070004002']).execute();
    expect(held.map((h) => h.holder_id)).toEqual([dc[0]!.id, dc[0]!.id]);
  });
});

describe('two discovered objects with the same name on the same site', () => {
  it('keeps two auto attendants and their resource accounts apart, whichever way they are brought in', async () => {
    await seedNumbers(c.s, 'LUT01', ['+442070005001', '+442070005002']);
    const raA = await object('resource_account', 'ra-dup-a', 'Switchboard', { UserPrincipalName: 'switchboard.a@contoso.test', ApplicationId: 'ce933385-9390-45d1-9512-c8d228074e07', PhoneNumber: 'tel:+442070005001' });
    const raB = await object('resource_account', 'ra-dup-b', 'Switchboard', { UserPrincipalName: 'switchboard.b@contoso.test', ApplicationId: 'ce933385-9390-45d1-9512-c8d228074e07', PhoneNumber: 'tel:+442070005002' });
    const aaA = await object('auto_attendant', 'aa-dup-a', 'Switchboard', { Identity: 'aa-dup-a', LanguageId: 'en-GB', ApplicationInstances: ['ra-dup-a'] });
    const aaB = await object('auto_attendant', 'aa-dup-b', 'Switchboard', { Identity: 'aa-dup-b', LanguageId: 'fr-FR', ApplicationInstances: ['ra-dup-b'] });

    // both attendants at once
    const res = await build.addFromDiscovery(c.t, engineer, { kind: 'auto_attendant', items: [{ id: aaA, siteId: luton }, { id: aaB, siteId: luton }], alsoBuild: true });
    expect(res.map((r) => [r.dataCollection, r.designAndBuild])).toEqual([['added', 'added'], ['added', 'added']]);
    expect(await c.s.selectFrom('discovery_resource_accounts').select('id').where('site_id', '=', luton).where('name', '=', 'Switchboard').execute()).toHaveLength(2);
    const aas = await c.s.selectFrom('build_auto_attendants').select(['language_id', 'resource_accounts']).where('site_id', '=', luton).where('name', '=', 'Switchboard').orderBy('language_id').execute();
    expect(aas.map((a) => a.language_id)).toEqual(['en-GB', 'fr-FR']);
    const ras = await c.s.selectFrom('build_resource_accounts').select(['id', 'upn']).where('site_id', '=', luton).where('upn', 'like', 'switchboard.%').orderBy('upn').execute();
    expect(ras.map((r) => r.upn)).toEqual(['switchboard.a@contoso.test', 'switchboard.b@contoso.test']);
    // each attendant lists its own resource account, not the other one's
    expect(aas[0]!.resource_accounts).toEqual([ras[0]!.id]);
    expect(aas[1]!.resource_accounts).toEqual([ras[1]!.id]);
    expect(await c.s.selectFrom('discovery_flows').select('id').where('site_id', '=', luton).where('name', '=', 'Switchboard').execute()).toHaveLength(2);

    // adding either resource account again is recognised, by its own id, as already there
    const again = await build.addFromDiscovery(c.t, engineer, { kind: 'resource_account', items: [{ id: raA, siteId: luton }, { id: raB, siteId: luton }], alsoBuild: true });
    expect(again.map((r) => r.dataCollection)).toEqual(['already_on_site', 'already_on_site']);
  });

  it('keeps two same-named resource accounts apart through the bulk import', async () => {
    await seedNumbers(c.s, 'NYC01', ['+12125556001', '+12125556002']);
    const a = await object('resource_account', 'ra-bulkdup-a', 'Front Desk', { UserPrincipalName: 'front.a@contoso.test', ApplicationId: 'ce933385-9390-45d1-9512-c8d228074e07', PhoneNumber: 'tel:+12125556001' });
    const b = await object('resource_account', 'ra-bulkdup-b', 'Front Desk', { UserPrincipalName: 'front.b@contoso.test', ApplicationId: '11cd3e2e-fccb-42ad-ad00-878b93575e07', PhoneNumber: 'tel:+12125556002' });
    const preview = await discovery.importResourceAccountsPreview(c.t);
    expect(preview.candidates.filter((x) => x.name === 'Front Desk')).toHaveLength(2);
    await discovery.importResourceAccounts(c.t, engineer, { assignments: [{ id: a, siteId: nyc }, { id: b, siteId: nyc }] } as never, true);
    const dc = await c.s.selectFrom('discovery_resource_accounts').select(['id', 'kind', 'tenant_object_id']).where('site_id', '=', nyc).where('name', '=', 'Front Desk').execute();
    expect(dc).toHaveLength(2);
    expect(dc.map((d) => d.tenant_object_id).sort()).toEqual([a, b].sort());
    // and nothing is offered to import twice afterwards
    const after = await discovery.importResourceAccountsPreview(c.t);
    expect(after.candidates.filter((x) => x.name === 'Front Desk')).toHaveLength(0);
  });
});

describe('the Data Collection record shows every resource account it holds', () => {
  it('lists both resource accounts of one attendant, with a number that was in none of the site\'s ranges added to them', async () => {
    await seedNumbers(c.s, 'NYC01', ['+12125557001']);
    // the second resource account has a toll-free number that is in no range: it is added to the site's ranges
    const ra1 = await object('resource_account', 'ra-show-1', 'Hauppauge Main Number', { UserPrincipalName: 'main@contoso.test', ApplicationId: 'ce933385-9390-45d1-9512-c8d228074e07', PhoneNumber: 'tel:+12125557001' });
    const ra2 = await object('resource_account', 'ra-show-2', 'Hauppauge Main Number', { UserPrincipalName: 'main.tollfree@contoso.test', ApplicationId: 'ce933385-9390-45d1-9512-c8d228074e07', PhoneNumber: 'tel:+18008726279' });
    await object('auto_attendant', 'aa-show', 'Hauppauge Main Number', { Identity: 'aa-show', LanguageId: 'en-US', ApplicationInstances: ['ra-show-1', 'ra-show-2'] });
    await build.addFromDiscovery(c.t, engineer, { kind: 'resource_account', items: [{ id: ra1, siteId: nyc }, { id: ra2, siteId: nyc }], alsoBuild: true });

    const list = await tel.listResourceAccounts(c.t, { siteId: nyc, page: 1, limit: 50 } as never);
    const rec = list.items.find((r) => r.name === 'Hauppauge Main Number')!;
    expect(list.items.filter((r) => r.name === 'Hauppauge Main Number')).toHaveLength(1);
    const members = [...rec.members].sort((a, b) => (a.upn ?? '').localeCompare(b.upn ?? ''));
    expect(members).toEqual([
      { name: 'Hauppauge Main Number', upn: 'main.tollfree@contoso.test', number: '+18008726279', attached: true },
      { name: 'Hauppauge Main Number', upn: 'main@contoso.test', number: '+12125557001', attached: true },
    ]);
    expect(rec.phone_numbers.map((n) => n.e164)).toEqual(['+12125557001', '+18008726279']);
  });

  it('does not take a number from another site\'s range', async () => {
    await seedNumbers(c.s, 'LUT01', ['+442070009001']);
    const ra = await object('resource_account', 'ra-other-site', 'Elsewhere Line', { UserPrincipalName: 'elsewhere@contoso.test', ApplicationId: 'ce933385-9390-45d1-9512-c8d228074e07', PhoneNumber: 'tel:+442070009001' });
    const res = await build.addFromDiscovery(c.t, engineer, { kind: 'resource_account', items: [{ id: ra, siteId: nyc }], alsoBuild: false });
    expect(res[0].note).toMatch(/\+442070009001 is in the number range of site LUT01/);
    const still = await c.s.selectFrom('phone_numbers').select('holder_id').where('e164', '=', '+442070009001').executeTakeFirstOrThrow();
    expect(still.holder_id).toBeNull();
  });
});
