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
    expect(wrongKind[0].note).toMatch(/already in site data as a user/i);
    expect((await c.s.selectFrom('discovery_caps').select('id').where('upn', '=', 'pat@contoso.test').execute())).toHaveLength(0);
  });

  it('can stop at Site Data', async () => {
    const id = await account('dc.only@contoso.test', 'DC Only');
    const res = await build.addFromDiscovery(c.t, engineer, { kind: 'account', items: [{ id, siteId: luton }], alsoBuild: false });
    expect(res[0]).toMatchObject({ dataCollection: 'added', designAndBuild: 'off' });
    expect(await c.s.selectFrom('build_users').select('id').where('upn', '=', 'dc.only@contoso.test').execute()).toHaveLength(0);
  });
});

const AA_APP = 'ce933385-9390-45d1-9512-c8d228074e07';
const CQ_APP = '11cd3e2e-fccb-42ad-ad00-878b93575e07';

describe('voice apps: two with the same name stay two', () => {
  it('matches each to its own live object and its own resource account, by id, not by name, and names the voice app by its own name', async () => {
    await seedNumbers(c.s, 'LUT01', ['+442070000001']);
    await seedNumbers(c.s, 'NYC01', ['+12125550002']);
    const raA = await object('resource_account', 'ra-guid-a', 'Reception RA', { UserPrincipalName: 'reception.a@contoso.test', ApplicationId: AA_APP, PhoneNumber: 'tel:+442070000001' });
    const raB = await object('resource_account', 'ra-guid-b', 'Reception RA', { UserPrincipalName: 'reception.b@contoso.test', ApplicationId: AA_APP, PhoneNumber: 'tel:+12125550002' });
    const aaA = await object('auto_attendant', 'aa-guid-a', 'Reception', { Identity: 'aa-guid-a', LanguageId: 'en-GB', TimeZoneId: 'GMT Standard Time', ApplicationInstances: ['ra-guid-a'], DefaultCallFlow: { Greetings: [{ TextToSpeechPrompt: 'Welcome to Luton' }], Menu: { MenuOptions: [{ DtmfResponse: 100, Action: 2, CallTarget: { Id: 'tel:+442079990000', Type: 4 } }] } } });
    const aaB = await object('auto_attendant', 'aa-guid-b', 'Reception', { Identity: 'aa-guid-b', LanguageId: 'en-US', TimeZoneId: 'Eastern Standard Time', ApplicationInstances: ['ra-guid-b'] });

    const res = await build.addFromDiscovery(c.t, engineer, { kind: 'auto_attendant', items: [{ id: aaA, siteId: luton }, { id: aaB, siteId: nyc }], alsoBuild: true });
    expect(res.map((r) => r.dataCollection)).toEqual(['added', 'added']);
    expect(res.map((r) => r.designAndBuild)).toEqual(['added', 'added']);

    // Site Data: a voice app named as in Teams, and a resource account named as in Teams that answers for it
    const apps = await c.s.selectFrom('discovery_voice_apps').selectAll().orderBy('site_id').execute();
    expect(apps).toHaveLength(2);
    expect(apps.map((r) => r.tenant_object_id).sort()).toEqual([aaA, aaB].sort());
    const appLuton = apps.find((a) => a.site_id === luton)!;
    const appNyc = apps.find((a) => a.site_id === nyc)!;
    expect(appLuton.name).toBe('Reception');
    expect(appLuton.advanced_features).toContain('Language en-GB');
    expect(appLuton.advanced_features).toContain('Time zone GMT Standard Time');
    expect(appNyc.advanced_features).toContain('Language en-US');
    const dcRas = await c.s.selectFrom('discovery_resource_accounts').selectAll().execute();
    expect(dcRas).toHaveLength(2);
    const raLuton = dcRas.find((r) => r.site_id === luton)!;
    const raNyc = dcRas.find((r) => r.site_id === nyc)!;
    expect(raLuton).toMatchObject({ name: 'Reception RA', upn: 'reception.a@contoso.test', voice_app_id: appLuton.id, tenant_object_id: raA });
    expect(raNyc).toMatchObject({ upn: 'reception.b@contoso.test', voice_app_id: appNyc.id, tenant_object_id: raB });
    // the number lives on the resource account
    const held = await c.s.selectFrom('phone_numbers').select(['holder_type', 'holder_id']).where('e164', '=', '+442070000001').executeTakeFirstOrThrow();
    expect(held).toMatchObject({ holder_type: 'resource_account', holder_id: raLuton.id });

    // each voice app also has its own Call flows row, read back from its own live settings and linked to its Design & Build row
    const flows = await c.s.selectFrom('discovery_flows').selectAll().orderBy('site_id').execute();
    expect(flows).toHaveLength(2);
    const lutonFlow = flows.find((f) => f.site_id === luton)!;
    const nycFlow = flows.find((f) => f.site_id === nyc)!;
    expect(lutonFlow).toMatchObject({ kind: 'auto_attendant', name: 'Reception', tenant_object_id: aaA, voice_app_id: appLuton.id, resource_account_id: raLuton.id });
    expect(nycFlow).toMatchObject({ tenant_object_id: aaB, voice_app_id: appNyc.id });
    expect(lutonFlow.wizard_answers).toMatchObject({ languageId: 'en-GB', businessFlow: { mode: 'direct', greeting: 'Welcome to Luton', target: { kind: 'external', label: '+442079990000' } } });
    expect(lutonFlow.build_auto_attendant_id).toBeTruthy();
    expect(lutonFlow.imported_at).toBeTruthy();
    expect(nycFlow.build_auto_attendant_id).toBeTruthy();

    // Design & Build: the attendant carries its own name, not the resource account's
    const aas = await c.s.selectFrom('build_auto_attendants').select(['name', 'site_id', 'language_id', 'time_zone_id', 'discovery_voice_app_id']).execute();
    expect(aas.map((a) => a.name)).toEqual(['Reception', 'Reception']);
    expect(aas.find((a) => a.site_id === luton)).toMatchObject({ language_id: 'en-GB', time_zone_id: 'GMT Standard Time', discovery_voice_app_id: appLuton.id });
    expect(aas.find((a) => a.site_id === nyc)).toMatchObject({ language_id: 'en-US', time_zone_id: 'Eastern Standard Time', discovery_voice_app_id: appNyc.id });
    const ras = await c.s.selectFrom('build_resource_accounts').select(['site_id', 'upn', 'phone_number']).execute();
    expect(ras.find((r) => r.site_id === luton)).toMatchObject({ upn: 'reception.a@contoso.test', phone_number: '+442070000001' });
    expect(ras.find((r) => r.site_id === nyc)).toMatchObject({ upn: 'reception.b@contoso.test', phone_number: '+12125550002' });

    // adding a resource account of a voice app already on the site does not make a second row
    const again = await build.addFromDiscovery(c.t, engineer, { kind: 'resource_account', items: [{ id: raA, siteId: luton }, { id: raB, siteId: luton }], alsoBuild: true });
    expect(again.find((r) => r.key === 'ra-guid-a')).toMatchObject({ dataCollection: 'already_on_site', designAndBuild: 'already_on_site' });
    expect(again.find((r) => r.key === 'ra-guid-b')).toMatchObject({ dataCollection: 'on_other_site', otherSite: 'NYC01' });
    expect(await c.s.selectFrom('discovery_resource_accounts').select('id').execute()).toHaveLength(2);
    expect(await c.s.selectFrom('discovery_voice_apps').select('id').execute()).toHaveLength(2);
  });
});

describe('voice apps without a resource account', () => {
  it('adds the call queue and the auto attendant but makes no resource account row at all', async () => {
    const before = (await c.s.selectFrom('build_resource_accounts').select('id').execute()).length;
    const dcBefore = (await c.s.selectFrom('discovery_resource_accounts').select('id').execute()).length;
    const cq = await object('call_queue', 'cq-guid-solo', 'Helpdesk Queue', { Identity: 'cq-guid-solo', LanguageId: 'en-GB', ApplicationInstances: [] });
    const aa = await object('auto_attendant', 'aa-guid-solo', 'Helpdesk Menu', { Identity: 'aa-guid-solo', LanguageId: 'en-GB' });
    const res = await build.addFromDiscovery(c.t, engineer, { kind: 'call_queue', items: [{ id: cq, siteId: luton }], alsoBuild: true });
    const res2 = await build.addFromDiscovery(c.t, engineer, { kind: 'auto_attendant', items: [{ id: aa, siteId: luton }], alsoBuild: true });
    expect([...res, ...res2].map((r) => r.designAndBuild)).toEqual(['added', 'added']);
    expect((await c.s.selectFrom('build_resource_accounts').select('id').execute()).length).toBe(before);
    expect((await c.s.selectFrom('discovery_resource_accounts').select('id').execute()).length).toBe(dcBefore);
    const queue = await c.s.selectFrom('build_call_queues').select(['name', 'resource_accounts']).where('name', '=', 'Helpdesk Queue').executeTakeFirstOrThrow();
    const attendant = await c.s.selectFrom('build_auto_attendants').select(['name', 'resource_accounts']).where('name', '=', 'Helpdesk Menu').executeTakeFirstOrThrow();
    expect(queue.resource_accounts).toEqual([]);
    expect(attendant.resource_accounts).toEqual([]);
  });
});

describe('what a discovered call queue brings into Site Data', () => {
  it('describes its agents, routing and exception handling on the voice app, puts the number on its resource account, and adds a number outside the ranges', async () => {
    await seedNumbers(c.s, 'LUT01', ['+442070000050']);
    await account('agent.one@contoso.test', 'Agent One');
    await object('resource_account', 'ra-guid-q', 'Support Queue RA', { UserPrincipalName: 'support.q@contoso.test', ApplicationId: CQ_APP, PhoneNumber: 'tel:+442070000050;ext=1' });
    const raOutside = await object('resource_account', 'ra-guid-out', 'Outside Queue', { UserPrincipalName: 'outside.q@contoso.test', ApplicationId: CQ_APP, PhoneNumber: 'tel:+33140000000' });
    const cq = await object('call_queue', 'cq-guid-q', 'Support Queue', { Identity: 'cq-guid-q', LanguageId: 'en-GB', RoutingMethod: 'Attendant', Agents: [{ ObjectId: 'eid-agent.one@contoso.test' }], OverflowAction: 'Forward', OverflowThreshold: 20, OverflowActionTarget: { Id: 'tel:+442079999999', Type: 'Phone' }, TimeoutAction: 'Disconnect', TimeoutThreshold: 90, ApplicationInstances: ['ra-guid-q'] });
    const res = await build.addFromDiscovery(c.t, engineer, { kind: 'call_queue', items: [{ id: cq, siteId: luton }], alsoBuild: false });
    expect(res[0].dataCollection).toBe('added');
    const app = await c.s.selectFrom('discovery_voice_apps').selectAll().where('tenant_object_id', '=', cq).executeTakeFirstOrThrow();
    expect(app.name).toBe('Support Queue');
    expect(app.who_answers).toContain('agent.one@contoso.test');
    expect(app.who_answers).toContain('Routing: Attendant');
    expect(app.exception_conditions).toContain('More than 20 calls waiting');
    expect(app.exception_action).toContain('Overflow: forward the call (+442079999999)');
    expect(app.exception_action).toContain('Timeout: disconnect the call');
    const ra = await c.s.selectFrom('discovery_resource_accounts').selectAll().where('voice_app_id', '=', app.id).executeTakeFirstOrThrow();
    expect(ra).toMatchObject({ name: 'Support Queue RA', upn: 'support.q@contoso.test', kind: 'call_queue' });
    const held = await c.s.selectFrom('phone_numbers').select(['holder_type', 'holder_id']).where('e164', '=', '+442070000050').executeTakeFirstOrThrow();
    expect(held).toMatchObject({ holder_type: 'resource_account', holder_id: ra.id });

    // a resource account whose number is in no range: the number is added to the site's ranges (as a single-number re-point range) and attached
    const out = await build.addFromDiscovery(c.t, engineer, { kind: 'resource_account', items: [{ id: raOutside, siteId: luton }], alsoBuild: false });
    expect(out[0].note ?? '').not.toMatch(/range/);
    const range = await c.s.selectFrom('discovery_number_ranges').select(['sitecode', 'kind', 'range_start', 'range_end']).where('range_start', '=', '+33140000000').executeTakeFirstOrThrow();
    expect(range).toMatchObject({ sitecode: 'LUT01', kind: 'retain', range_end: '+33140000000' });
    const heldOut = await c.s.selectFrom('phone_numbers').select(['holder_type']).where('e164', '=', '+33140000000').executeTakeFirstOrThrow();
    expect(heldOut.holder_type).toBe('resource_account');
  });
});

describe('a resource account on its own', () => {
  it('makes only the resource account, never a voice app named after it, and says to add the voice app', async () => {
    await seedNumbers(c.s, 'NYC01', ['+12125558001']);
    const ra = await object('resource_account', 'ra-alone', 'Alone RA', { UserPrincipalName: 'alone@contoso.test', ApplicationId: AA_APP, PhoneNumber: 'tel:+12125558001' });
    const aa = await object('auto_attendant', 'aa-alone', 'Alone Menu', { Identity: 'aa-alone', LanguageId: 'en-US', ApplicationInstances: ['ra-alone'] });
    const appsBefore = (await c.s.selectFrom('discovery_voice_apps').select('id').execute()).length;
    const res = await build.addFromDiscovery(c.t, engineer, { kind: 'resource_account', items: [{ id: ra, siteId: nyc }], alsoBuild: true });
    expect(res[0]).toMatchObject({ dataCollection: 'added', designAndBuild: 'added' });
    expect(res[0].note).toMatch(/Alone Menu/);
    expect((await c.s.selectFrom('discovery_voice_apps').select('id').execute()).length).toBe(appsBefore);
    expect(await c.s.selectFrom('build_auto_attendants').select('id').where('name', 'like', 'Alone%').execute()).toHaveLength(0);
    const dcRa = await c.s.selectFrom('discovery_resource_accounts').selectAll().where('tenant_object_id', '=', ra).executeTakeFirstOrThrow();
    expect(dcRa.voice_app_id).toBeNull();

    // adding the voice app afterwards links the resource account that is already there instead of making another
    const second = await build.addFromDiscovery(c.t, engineer, { kind: 'auto_attendant', items: [{ id: aa, siteId: nyc }], alsoBuild: true });
    expect(second[0].dataCollection).toBe('added');
    expect(await c.s.selectFrom('discovery_resource_accounts').select('id').where('upn', '=', 'alone@contoso.test').execute()).toHaveLength(1);
    const linked = await c.s.selectFrom('discovery_resource_accounts').select('voice_app_id').where('id', '=', dcRa.id).executeTakeFirstOrThrow();
    expect(linked.voice_app_id).toBeTruthy();
    expect(await c.s.selectFrom('build_resource_accounts').select('id').where('upn', '=', 'alone@contoso.test').execute()).toHaveLength(1);
    const aaRow = await c.s.selectFrom('build_auto_attendants').select(['name', 'resource_accounts']).where('name', '=', 'Alone Menu').executeTakeFirstOrThrow();
    const raRow = await c.s.selectFrom('build_resource_accounts').select('id').where('upn', '=', 'alone@contoso.test').executeTakeFirstOrThrow();
    expect(aaRow.resource_accounts).toEqual([raRow.id]);
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
    // Site Data only so far: not in Design & Build, so the flow is not marked imported
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

describe('one voice app with several resource accounts', () => {
  async function setup(tag: string, siteCode: string, nums: [string, string]) {
    await seedNumbers(c.s, siteCode, nums);
    const ra1 = await object('resource_account', `ra-${tag}-1`, `Main ${tag} 1`, { UserPrincipalName: `main1.${tag}@contoso.test`, ApplicationId: AA_APP, PhoneNumber: `tel:${nums[0]}` });
    const ra2 = await object('resource_account', `ra-${tag}-2`, `Main ${tag} 2`, { UserPrincipalName: `main2.${tag}@contoso.test`, ApplicationId: AA_APP, PhoneNumber: `tel:${nums[1]}` });
    const aa = await object('auto_attendant', `aa-${tag}`, `Main ${tag}`, { Identity: `aa-${tag}`, LanguageId: 'en-GB', ApplicationInstances: [`ra-${tag}-1`, `ra-${tag}-2`] });
    return { ra1, ra2, aa };
  }
  /** One voice app and two resource accounts in Site Data, one attendant and two resource accounts in Design & Build, all tied together. */
  async function expectWhole(tag: string, siteId: string, nums: [string, string]) {
    const apps = await c.s.selectFrom('discovery_voice_apps').select('id').where('site_id', '=', siteId).where('name', '=', `Main ${tag}`).execute();
    expect(apps).toHaveLength(1);
    const dc = await c.s.selectFrom('discovery_resource_accounts').select(['id', 'upn', 'voice_app_id']).where('site_id', '=', siteId).where('upn', 'like', `%.${tag}@contoso.test`).orderBy('upn').execute();
    expect(dc.map((r) => r.upn)).toEqual([`main1.${tag}@contoso.test`, `main2.${tag}@contoso.test`]);
    expect(dc.map((r) => r.voice_app_id)).toEqual([apps[0]!.id, apps[0]!.id]);
    const held = await c.s.selectFrom('phone_numbers').select(['e164', 'holder_id']).where('e164', 'in', nums).orderBy('e164').execute();
    expect(held.map((h) => h.holder_id).sort()).toEqual(dc.map((d) => d.id).sort());
    const aas = await c.s.selectFrom('build_auto_attendants').select(['id', 'resource_accounts']).where('site_id', '=', siteId).where('name', '=', `Main ${tag}`).execute();
    expect(aas).toHaveLength(1);
    const ras = await c.s.selectFrom('build_resource_accounts').select(['id', 'upn', 'phone_number']).where('site_id', '=', siteId).where('upn', 'like', `%.${tag}@contoso.test`).orderBy('upn').execute();
    expect(ras.map((r) => r.upn)).toEqual([`main1.${tag}@contoso.test`, `main2.${tag}@contoso.test`]);
    expect(ras.map((r) => r.phone_number)).toEqual(nums);
    expect([...(aas[0]!.resource_accounts as string[])].sort()).toEqual(ras.map((r) => r.id).sort());
    expect(await c.s.selectFrom('discovery_flows').select('id').where('site_id', '=', siteId).where('name', '=', `Main ${tag}`).execute()).toHaveLength(1);
  }

  it('keeps both resource accounts when the voice app is added', async () => {
    const { aa } = await setup('aa', 'NYC01', ['+12125552001', '+12125552002']);
    const res = await build.addFromDiscovery(c.t, engineer, { kind: 'auto_attendant', items: [{ id: aa, siteId: nyc }], alsoBuild: true });
    expect(res[0]).toMatchObject({ dataCollection: 'added', designAndBuild: 'added' });
    await expectWhole('aa', nyc, ['+12125552001', '+12125552002']);
  });

  it('joins both resource accounts to the voice app when they were added first', async () => {
    const { ra1, ra2, aa } = await setup('first', 'LUT01', ['+442070001001', '+442070001002']);
    const res = await build.addFromDiscovery(c.t, engineer, { kind: 'resource_account', items: [{ id: ra1, siteId: luton }, { id: ra2, siteId: luton }], alsoBuild: true });
    expect(res.map((r) => r.designAndBuild)).toEqual(['added', 'added']);
    expect(await c.s.selectFrom('discovery_voice_apps').select('id').where('name', '=', 'Main first').execute()).toHaveLength(0);
    await build.addFromDiscovery(c.t, engineer, { kind: 'auto_attendant', items: [{ id: aa, siteId: luton }], alsoBuild: true });
    await expectWhole('first', luton, ['+442070001001', '+442070001002']);
  });

  it('adds the second resource account to the voice app that is already there when it comes later', async () => {
    const { ra1, ra2, aa } = await setup('late', 'LUT01', ['+442070003001', '+442070003002']);
    await build.addFromDiscovery(c.t, engineer, { kind: 'auto_attendant', items: [{ id: aa, siteId: luton }], alsoBuild: true });
    // simulate the second arriving later: it is already there, so adding it again changes nothing
    const later = await build.addFromDiscovery(c.t, engineer, { kind: 'resource_account', items: [{ id: ra1, siteId: luton }, { id: ra2, siteId: luton }], alsoBuild: true });
    expect(later.map((r) => r.dataCollection)).toEqual(['already_on_site', 'already_on_site']);
    await expectWhole('late', luton, ['+442070003001', '+442070003002']);
  });

  it('brings the resource accounts in through the bulk Import and ties them to the voice app on the site', async () => {
    const { ra1, ra2, aa } = await setup('bulk', 'LUT01', ['+442070004001', '+442070004002']);
    await build.addFromDiscovery(c.t, engineer, { kind: 'auto_attendant', items: [{ id: aa, siteId: luton }], alsoBuild: false });
    const result = await discovery.importResourceAccounts(c.t, engineer, { assignments: [{ id: ra1, siteId: luton }, { id: ra2, siteId: luton }] } as never, true);
    expect(result.created).toBe(0);
    const dc = await c.s.selectFrom('discovery_resource_accounts').select(['id', 'voice_app_id']).where('site_id', '=', luton).where('upn', 'like', '%.bulk@contoso.test').execute();
    expect(dc).toHaveLength(2);
    expect(new Set(dc.map((d) => d.voice_app_id)).size).toBe(1);
    expect(dc[0]!.voice_app_id).toBeTruthy();
  });
});

describe('two discovered objects with the same name on the same site', () => {
  it('keeps two auto attendants and their resource accounts apart', async () => {
    await seedNumbers(c.s, 'LUT01', ['+442070005001', '+442070005002']);
    const raA = await object('resource_account', 'ra-dup-a', 'Switchboard', { UserPrincipalName: 'switchboard.a@contoso.test', ApplicationId: AA_APP, PhoneNumber: 'tel:+442070005001' });
    const raB = await object('resource_account', 'ra-dup-b', 'Switchboard', { UserPrincipalName: 'switchboard.b@contoso.test', ApplicationId: AA_APP, PhoneNumber: 'tel:+442070005002' });
    const aaA = await object('auto_attendant', 'aa-dup-a', 'Switchboard', { Identity: 'aa-dup-a', LanguageId: 'en-GB', ApplicationInstances: ['ra-dup-a'] });
    const aaB = await object('auto_attendant', 'aa-dup-b', 'Switchboard', { Identity: 'aa-dup-b', LanguageId: 'fr-FR', ApplicationInstances: ['ra-dup-b'] });

    const res = await build.addFromDiscovery(c.t, engineer, { kind: 'auto_attendant', items: [{ id: aaA, siteId: luton }, { id: aaB, siteId: luton }], alsoBuild: true });
    expect(res.map((r) => [r.dataCollection, r.designAndBuild])).toEqual([['added', 'added'], ['added', 'added']]);
    expect(await c.s.selectFrom('discovery_voice_apps').select('id').where('site_id', '=', luton).where('name', '=', 'Switchboard').execute()).toHaveLength(2);
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
    const a = await object('resource_account', 'ra-bulkdup-a', 'Front Desk', { UserPrincipalName: 'front.a@contoso.test', ApplicationId: AA_APP, PhoneNumber: 'tel:+12125556001' });
    const b = await object('resource_account', 'ra-bulkdup-b', 'Front Desk', { UserPrincipalName: 'front.b@contoso.test', ApplicationId: CQ_APP, PhoneNumber: 'tel:+12125556002' });
    const preview = await discovery.importResourceAccountsPreview(c.t);
    expect(preview.candidates.filter((x) => x.name === 'Front Desk')).toHaveLength(2);
    await discovery.importResourceAccounts(c.t, engineer, { assignments: [{ id: a, siteId: nyc }, { id: b, siteId: nyc }] } as never, true);
    const dc = await c.s.selectFrom('discovery_resource_accounts').select(['id', 'kind', 'tenant_object_id']).where('site_id', '=', nyc).where('name', '=', 'Front Desk').execute();
    expect(dc).toHaveLength(2);
    expect(dc.map((d) => d.tenant_object_id).sort()).toEqual([a, b].sort());
    expect(await c.s.selectFrom('discovery_voice_apps').select('id').where('name', '=', 'Front Desk').execute()).toHaveLength(0);
    // and nothing is offered to import twice afterwards
    const after = await discovery.importResourceAccountsPreview(c.t);
    expect(after.candidates.filter((x) => x.name === 'Front Desk')).toHaveLength(0);
  });
});

describe('the Site Data lists show every resource account', () => {
  it('lists two same-named resource accounts of one attendant as two, with a number outside the site ranges added', async () => {
    await seedNumbers(c.s, 'NYC01', ['+12125557001']);
    await object('resource_account', 'ra-show-1', 'Hauppauge Main Number', { UserPrincipalName: 'main@contoso.test', ApplicationId: AA_APP, PhoneNumber: 'tel:+12125557001' });
    await object('resource_account', 'ra-show-2', 'Hauppauge Main Number', { UserPrincipalName: 'main.tollfree@contoso.test', ApplicationId: AA_APP, PhoneNumber: 'tel:+18008726279' });
    const aa = await object('auto_attendant', 'aa-show', 'Hauppauge Main Number', { Identity: 'aa-show', LanguageId: 'en-US', ApplicationInstances: ['ra-show-1', 'ra-show-2'] });
    await build.addFromDiscovery(c.t, engineer, { kind: 'auto_attendant', items: [{ id: aa, siteId: nyc }], alsoBuild: true });

    const apps = await tel.listVoiceApps(c.t, { siteId: nyc, page: 1, limit: 50 } as never);
    const app = apps.items.find((r) => r.name === 'Hauppauge Main Number')!;
    expect(apps.items.filter((r) => r.name === 'Hauppauge Main Number')).toHaveLength(1);
    expect([...app.resource_accounts].sort((x, y) => (x.upn ?? '').localeCompare(y.upn ?? ''))).toEqual([
      expect.objectContaining({ upn: 'main.tollfree@contoso.test', numbers: ['+18008726279'] }),
      expect.objectContaining({ upn: 'main@contoso.test', numbers: ['+12125557001'] }),
    ]);

    const ras = await tel.listResourceAccounts(c.t, { siteId: nyc, page: 1, limit: 50 } as never);
    const same = ras.items.filter((r) => r.name === 'Hauppauge Main Number');
    expect(same).toHaveLength(2);
    expect(same.every((r) => r.voice_app_name === 'Hauppauge Main Number')).toBe(true);
    expect(same.flatMap((r) => r.phone_numbers.map((n) => n.e164)).sort()).toEqual(['+12125557001', '+18008726279']);
  });

  it('does not take a number from another site\'s range', async () => {
    await seedNumbers(c.s, 'LUT01', ['+442070009001']);
    const ra = await object('resource_account', 'ra-other-site', 'Elsewhere Line', { UserPrincipalName: 'elsewhere@contoso.test', ApplicationId: AA_APP, PhoneNumber: 'tel:+442070009001' });
    const res = await build.addFromDiscovery(c.t, engineer, { kind: 'resource_account', items: [{ id: ra, siteId: nyc }], alsoBuild: false });
    expect(res[0].note).toMatch(/\+442070009001 is in the number range of site LUT01/);
    const still = await c.s.selectFrom('phone_numbers').select('holder_id').where('e164', '=', '+442070009001').executeTakeFirstOrThrow();
    expect(still.holder_id).toBeNull();
  });
});

describe('design first, then discovery', () => {
  it('links a designed voice app and resource account to the live ones instead of making copies, and does not guess between two designs with one name', async () => {
    await seedNumbers(c.s, 'LUT01', ['+442070006001']);
    const designApp = (await c.s.insertInto('discovery_voice_apps').values({ site_id: luton, name: 'Sales Line', kind: 'auto_attendant' }).returning('id').executeTakeFirstOrThrow()).id;
    const designRa = (await c.s.insertInto('discovery_resource_accounts').values({ site_id: luton, name: 'Sales RA', kind: 'auto_attendant', upn: 'Sales.RA@contoso.test', voice_app_id: designApp }).returning('id').executeTakeFirstOrThrow()).id;
    await object('resource_account', 'ra-sales', 'Sales Resource', { UserPrincipalName: 'sales.ra@contoso.test', ApplicationId: AA_APP, PhoneNumber: 'tel:+442070006001' });
    const live = await object('auto_attendant', 'aa-sales', 'Sales Line', { Identity: 'aa-sales', LanguageId: 'en-GB', ApplicationInstances: ['ra-sales'] });
    const res = await build.addFromDiscovery(c.t, engineer, { kind: 'auto_attendant', items: [{ id: live, siteId: luton }], alsoBuild: false });
    expect(res[0].note).toMatch(/Matched to your design/);
    expect(await c.s.selectFrom('discovery_voice_apps').select('id').where('name', '=', 'Sales Line').execute()).toHaveLength(1);
    expect(await c.s.selectFrom('discovery_resource_accounts').select('id').where('upn', 'ilike', 'sales.ra@contoso.test').execute()).toHaveLength(1);
    expect(await c.s.selectFrom('discovery_voice_apps').select('tenant_object_id').where('id', '=', designApp).executeTakeFirstOrThrow()).toEqual({ tenant_object_id: live });
    const ra = await c.s.selectFrom('discovery_resource_accounts').select(['tenant_object_id', 'voice_app_id']).where('id', '=', designRa).executeTakeFirstOrThrow();
    expect(ra.tenant_object_id).toBeTruthy();
    expect(ra.voice_app_id).toBe(designApp);
    const held = await c.s.selectFrom('phone_numbers').select('holder_id').where('e164', '=', '+442070006001').executeTakeFirstOrThrow();
    expect(held.holder_id).toBe(designRa);

    // two designs with one name: not guessed between
    await c.s.insertInto('discovery_voice_apps').values([{ site_id: luton, name: 'Twin', kind: 'auto_attendant' }, { site_id: luton, name: 'Twin', kind: 'auto_attendant' }]).execute();
    const twin = await object('auto_attendant', 'aa-twin', 'Twin', { Identity: 'aa-twin', LanguageId: 'en-GB' });
    const amb = await build.addFromDiscovery(c.t, engineer, { kind: 'auto_attendant', items: [{ id: twin, siteId: luton }], alsoBuild: true });
    expect(amb[0]).toMatchObject({ dataCollection: 'ambiguous', designAndBuild: 'not_added' });
    expect(await c.s.selectFrom('discovery_voice_apps').select('id').where('name', '=', 'Twin').execute()).toHaveLength(2);
  });
});

describe('a designed call flow imported to Design & Build, then the voice app populated', () => {
  it('makes one Design & Build row, not two', async () => {
    const dc = new DataCollectionService(handle.db, new AuditService(handle.db));
    const flow = await dc.addFlow(c.t, engineer, {
      site_id: luton, kind: 'auto_attendant', name: 'Designed Menu',
      wizard_answers: { languageId: 'en-GB', timeZoneId: 'GMT Standard Time', hoursType: 'always', businessFlow: { mode: 'direct', greeting: 'Hello', target: { kind: 'operator' } }, holidaysEnabled: false },
      wizard_version: 1,
    } as never, true);
    expect(flow.voice_app_id).toBeTruthy();
    const imported = await build.importFlowWizard(c.t, engineer, flow.id);
    const row = await c.s.selectFrom('build_auto_attendants').select(['id', 'discovery_voice_app_id']).where('id', '=', imported.row.id).executeTakeFirstOrThrow();
    expect(row.discovery_voice_app_id).toBe(flow.voice_app_id);
    await build.populateVoiceApps(c.t, engineer, luton);
    expect(await c.s.selectFrom('build_auto_attendants').select('id').where('name', '=', 'Designed Menu').execute()).toHaveLength(1);

    // an older row, made before the link was stamped, is adopted instead of copied
    await c.s.updateTable('build_auto_attendants').set({ discovery_voice_app_id: null }).where('id', '=', row.id).execute();
    await build.populateVoiceApps(c.t, engineer, luton);
    expect(await c.s.selectFrom('build_auto_attendants').select('id').where('name', '=', 'Designed Menu').execute()).toHaveLength(1);
    expect((await c.s.selectFrom('build_auto_attendants').select('discovery_voice_app_id').where('id', '=', row.id).executeTakeFirstOrThrow()).discovery_voice_app_id).toBe(flow.voice_app_id);
  });
});

describe('an auto attendant brings the voice apps it sends calls to', () => {
  it('adds its call queues to the same site, leaves one already on another site where it is, and fills them in on a second add', async () => {
    // Mineral Wells on the dev host: the menu's options go straight to call queues that have no resource account of their own
    const hr = await object('call_queue', 'cq-mw-hr', 'MW Human Resources', { Identity: 'cq-mw-hr', LanguageId: 'en-US', ApplicationInstances: [] });
    const ship = await object('call_queue', 'cq-mw-ship', 'MW Shipping', { Identity: 'cq-mw-ship', LanguageId: 'en-US', ApplicationInstances: ['ra-mw-ship'] });
    await object('resource_account', 'ra-mw-ship', 'MW Shipping RA', { Identity: 'ra-mw-ship', UserPrincipalName: 'mw.ship@contoso.test', ApplicationId: CQ_APP });
    const sub = await object('auto_attendant', 'aa-mw-sub', 'MW Sub Menu', { Identity: 'aa-mw-sub', LanguageId: 'en-US', DefaultCallFlow: { Menu: { MenuOptions: [{ DtmfResponse: 1, Action: 2, CallTarget: { Id: 'cq-mw-dock', Type: 6 } }] } } });
    const dock = await object('call_queue', 'cq-mw-dock', 'MW Dock', { Identity: 'cq-mw-dock', LanguageId: 'en-US' });
    const elsewhere = await object('call_queue', 'cq-mw-ny', 'MW Shared With NYC', { Identity: 'cq-mw-ny', LanguageId: 'en-US' });
    await build.addFromDiscovery(c.t, engineer, { kind: 'call_queue', items: [{ id: elsewhere, siteId: nyc }], alsoBuild: false });
    const options = [
      { DtmfResponse: 1, Action: 2, CallTarget: { Id: 'cq-mw-hr', Type: 6 } }, // the queue itself
      { DtmfResponse: 2, Action: 2, CallTarget: { Id: 'ra-mw-ship', Type: 3 } }, // through its resource account
      { DtmfResponse: 3, Action: 2, CallTarget: { Id: 'aa-mw-sub', Type: 6 } }, // another menu, which has a queue of its own
      { DtmfResponse: 4, Action: 2, CallTarget: { Id: 'cq-mw-ny', Type: 6 } },
    ];
    const aa = await object('auto_attendant', 'aa-mw', 'AA MW HQ', { Identity: 'aa-mw', LanguageId: 'en-US', CallFlows: [{ Menu: { MenuOptions: options } }] });

    const res = await build.addFromDiscovery(c.t, engineer, { kind: 'auto_attendant', items: [{ id: aa, siteId: luton }], alsoBuild: true });
    const by = Object.fromEntries(res.map((r) => [r.id, r]));
    expect(by[aa]).toMatchObject({ dataCollection: 'added', designAndBuild: 'added' });
    for (const id of [hr, ship, sub, dock]) expect(by[id]).toMatchObject({ dataCollection: 'added', designAndBuild: 'added' });
    expect(by[hr].note).toMatch(/Call queue\. Reached from AA MW HQ\./);
    expect(by[dock].note).toMatch(/Reached from MW Sub Menu\./);
    expect(by[elsewhere]).toMatchObject({ dataCollection: 'on_other_site', otherSite: 'NYC01', designAndBuild: 'not_added' });
    expect(res).toHaveLength(6);

    const onLuton = await c.s.selectFrom('discovery_voice_apps').select(['tenant_object_id']).where('site_id', '=', luton).where('name', 'like', 'MW %').execute();
    expect(onLuton.map((r) => r.tenant_object_id).sort()).toEqual([hr, ship, sub, dock].sort());
    expect((await c.s.selectFrom('discovery_voice_apps').select('site_id').where('tenant_object_id', '=', elsewhere).executeTakeFirstOrThrow()).site_id).toBe(nyc);
    expect(await c.s.selectFrom('build_call_queues').select('name').where('site_id', '=', luton).where('name', 'like', 'MW %').orderBy('name').execute()).toEqual([{ name: 'MW Dock' }, { name: 'MW Human Resources' }, { name: 'MW Shipping' }]);
    // the shipping queue came with its own resource account
    expect(await c.s.selectFrom('discovery_resource_accounts').select('upn').where('site_id', '=', luton).where('upn', '=', 'mw.ship@contoso.test').execute()).toHaveLength(1);

    // the tenant gains a queue on the menu: adding the auto attendant again (already on the site) brings it
    const newer = await object('call_queue', 'cq-mw-new', 'MW Purchasing', { Identity: 'cq-mw-new', LanguageId: 'en-US' });
    await c.s.updateTable('tenant_objects').set({ data: JSON.stringify({ Identity: 'aa-mw', LanguageId: 'en-US', CallFlows: [{ Menu: { MenuOptions: [...options, { DtmfResponse: 5, Action: 2, CallTarget: { Id: 'cq-mw-new', Type: 6 } }] } }] }) } as never).where('id', '=', aa).execute();
    const again = await build.addFromDiscovery(c.t, engineer, { kind: 'auto_attendant', items: [{ id: aa, siteId: luton }], alsoBuild: true });
    const by2 = Object.fromEntries(again.map((r) => [r.id, r]));
    expect(by2[aa]).toMatchObject({ dataCollection: 'already_on_site' });
    expect(by2[hr]).toMatchObject({ dataCollection: 'already_on_site' });
    expect(by2[newer]).toMatchObject({ dataCollection: 'added', designAndBuild: 'added' });
  });

  it('does not add twice a call queue the auto attendant already brought', async () => {
    const q = await object('call_queue', 'cq-once', 'Once Queue', { Identity: 'cq-once', LanguageId: 'en-GB' });
    const a = await object('auto_attendant', 'aa-once', 'Once Menu', { Identity: 'aa-once', LanguageId: 'en-GB', DefaultCallFlow: { Menu: { MenuOptions: [{ DtmfResponse: 1, Action: 2, CallTarget: { Id: 'cq-once', Type: 6 } }] } } });
    const res = await build.addFromDiscovery(c.t, engineer, { kind: 'auto_attendant', items: [{ id: a, siteId: luton }], alsoBuild: false });
    expect(res.map((r) => r.id)).toEqual([a, q]);
    const queueRes = await build.addFromDiscovery(c.t, engineer, { kind: 'call_queue', items: [{ id: q, siteId: luton }], alsoBuild: false });
    expect(queueRes).toEqual([expect.objectContaining({ id: q, dataCollection: 'already_on_site' })]);
  });
});

describe('resource accounts: their numbers come with them', () => {
  it("puts every number Teams assigns to the account into the site's number ranges and attaches it, also when the account is already on the site", async () => {
    const site = (await seedSite(c.s, { sitecode: 'MAN01' })).id;
    // No PhoneNumber on the account itself: the number is only in Teams' phone number assignments, which name the account by its object id.
    const ra = await object('resource_account', 'ra-guid-man', 'Manchester RA', { UserPrincipalName: 'man.ra@contoso.test', ApplicationId: AA_APP, ObjectId: 'ra-guid-man' });
    const assignment = (n: string, target: string, status: string) => object('phone_number', n, n, { TelephoneNumber: n, AssignedPstnTargetId: target, PstnAssignmentStatus: status, NumberType: 'DirectRouting' });
    await assignment('+441610000001', 'RA-GUID-MAN', 'VoiceApplicationAssigned');
    await assignment('+441610000009', 'ra-guid-man', 'Unassigned');
    const held = (e164: string) =>
      c.s.selectFrom('phone_numbers as n').innerJoin('discovery_number_ranges as r', 'r.id', 'n.range_id').select(['n.holder_type', 'n.holder_id', 'r.sitecode', 'r.kind']).where('n.e164', '=', e164).executeTakeFirst();

    const res = await build.addFromDiscovery(c.t, engineer, { kind: 'resource_account', items: [{ id: ra, siteId: site }], alsoBuild: false });
    expect(res[0]).toMatchObject({ dataCollection: 'added' });
    const dcRa = await c.s.selectFrom('discovery_resource_accounts').select('id').where('tenant_object_id', '=', ra).executeTakeFirstOrThrow();
    expect(await held('+441610000001')).toMatchObject({ holder_type: 'resource_account', holder_id: dcRa.id, sitecode: 'MAN01', kind: 'retain' });
    expect(await held('+441610000009')).toBeUndefined(); // an unassigned number is not brought in

    // a number Teams has assigned to it since comes in when the account is added again
    await assignment('+441610000002', 'ra-guid-man', 'VoiceApplicationAssigned');
    const again = await build.addFromDiscovery(c.t, engineer, { kind: 'resource_account', items: [{ id: ra, siteId: site }], alsoBuild: false });
    expect(again[0]).toMatchObject({ dataCollection: 'already_on_site' });
    expect(await held('+441610000002')).toMatchObject({ holder_type: 'resource_account', holder_id: dcRa.id, sitecode: 'MAN01' });
    expect(await held('+441610000001')).toMatchObject({ holder_id: dcRa.id });
  });
});
