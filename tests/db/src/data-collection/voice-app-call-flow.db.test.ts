// An auto attendant or call queue and its Call flow are one row in Site Data ("Auto attendants & call queues"): the voice app
// list carries its call flow, deleting either deletes both, and a call flow that lost its voice app before this (Glasgow on dev,
// 5 Nov) gets it back when Populate from Site Data runs - so its auto attendant or call queue reaches Design & Build.
import { beforeAll, describe, expect, it } from 'vitest';
import { AuditService } from '../../../../apps/api/src/common/audit.service';
import { BuildService } from '../../../../apps/api/src/modules/build/build.service';
import { BuildValidationService } from '../../../../apps/api/src/modules/build/build-validation.service';
import { DataCollectionService } from '../../../../apps/api/src/modules/data-collection/data-collection.service';
import { TelephonyService } from '../../../../apps/api/src/modules/data-collection/data-collection.telephony.service';
import { TenantDiscoveryService } from '../../../../apps/api/src/modules/tenant-discovery/tenant-discovery.service';
import { seedCustomer, seedSite, seedUser, unused, useDb, type TestCustomer } from '../helpers';

const handle = useDb();
let c: TestCustomer;
let dc: DataCollectionService;
let tel: TelephonyService;
let build: BuildService;
let engineer: Awaited<ReturnType<typeof seedUser>>;
let gla: string;

const flow = (name: string, kind: 'auto_attendant' | 'call_queue' | 'other', extra: Record<string, unknown> = {}) =>
  dc.addFlow(c.t, engineer, { site_id: gla, kind, name, ...extra } as never, true);

beforeAll(async () => {
  c = await seedCustomer(handle);
  engineer = await seedUser(handle, 'ENGINEER');
  gla = (await seedSite(c.s, { sitecode: 'GLA01' })).id;
  const audit = new AuditService(handle.db);
  dc = new DataCollectionService(handle.db, audit);
  tel = new TelephonyService(handle.db, audit, dc);
  const discovery = new TenantDiscoveryService(handle.db, unused('queue'), audit, unused('deployments'), dc, tel);
  build = new BuildService(handle.db, audit, new BuildValidationService(handle.db), discovery, unused('documentBuilder'), unused('files'));
});

describe('one row per auto attendant or call queue', () => {
  it('lists each voice app with its call flow, and lists other routing notes on their own', async () => {
    const sales = await flow('Sales', 'call_queue');
    await flow('Fax line', 'other', { description: 'Rings the fax machine' });
    const list = await tel.listVoiceApps(c.t, { siteId: gla, page: 1, limit: 50 });
    expect(list.items).toHaveLength(1);
    expect(list.items[0]).toMatchObject({ name: 'Sales', kind: 'call_queue', call_flow: { id: sales.id, name: 'Sales' } });
    const other = await dc.listFlows(c.t, { siteId: gla, kind: 'other', page: 1, limit: 50 });
    expect(other.items.map((f) => f.name)).toEqual(['Fax line']);
  });

  it('deletes the call flow with its voice app, one at a time or all at once', async () => {
    const accounts = await flow('Accounts', 'call_queue');
    const r = await tel.deleteVoiceApp(c.t, engineer, accounts.voice_app_id!, true);
    expect(r).toEqual({ ok: true, callFlowsDeleted: 1 });
    expect(await c.s.selectFrom('discovery_flows').select('id').where('id', '=', accounts.id).executeTakeFirst()).toBeUndefined();

    const site2 = (await seedSite(c.s, { sitecode: 'EDI01' })).id;
    await dc.addFlow(c.t, engineer, { site_id: site2, kind: 'call_queue', name: 'Q1' } as never, true);
    await dc.addFlow(c.t, engineer, { site_id: site2, kind: 'auto_attendant', name: 'AA1' } as never, true);
    expect(await tel.bulkDelete(c.t, engineer, 'voice_app', { site_id: site2, all: true } as never, true)).toEqual({ deleted: 2, callFlowsDeleted: 2 });
    expect(await c.s.selectFrom('discovery_flows').select('id').where('site_id', '=', site2).execute()).toEqual([]);
  });

  it('deletes the voice app with its call flow, leaving its resource account on the site', async () => {
    const ra = await tel.addResourceAccount(c.t, engineer, { site_id: gla, name: 'Main', kind: 'auto_attendant', upn: 'aa-main@contoso.test' } as never, true);
    const main = await flow('Main Number', 'auto_attendant', { resource_account_id: ra.id });
    await dc.deleteFlow(c.t, engineer, main.id, true);
    expect(await c.s.selectFrom('discovery_voice_apps').select('id').where('id', '=', main.voice_app_id!).executeTakeFirst()).toBeUndefined();
    expect(await c.s.selectFrom('discovery_resource_accounts').select(['id', 'voice_app_id']).where('id', '=', ra.id).executeTakeFirst()).toEqual({ id: ra.id, voice_app_id: null });
  });
});

describe('Populate from Site Data and a call flow that lost its voice app', () => {
  it('gives the flow its voice app back and copies it into Design & Build, with its resource account', async () => {
    const ra = await tel.addResourceAccount(c.t, engineer, { site_id: gla, name: 'Main', kind: 'auto_attendant', upn: 'aa-gla@contoso.test' } as never, true);
    const main = await flow('Glasgow Main', 'auto_attendant', { resource_account_id: ra.id });
    const purchasing = await flow('Purchasing', 'call_queue');
    // What a voice app delete did before this change: the voice apps go, the flows stay with no voice app.
    await c.s.deleteFrom('discovery_voice_apps').where('id', 'in', [main.voice_app_id!, purchasing.voice_app_id!]).execute();
    expect((await c.s.selectFrom('discovery_flows').select('voice_app_id').where('id', '=', main.id).executeTakeFirstOrThrow()).voice_app_id).toBeNull();

    await build.populateAll(c.t, engineer, gla);
    const aa = await c.s.selectFrom('build_auto_attendants').select(['name', 'discovery_voice_app_id']).where('site_id', '=', gla).execute();
    const cq = await c.s.selectFrom('build_call_queues').select(['name']).where('site_id', '=', gla).execute();
    expect(aa.map((x) => x.name)).toContain('Glasgow Main');
    expect(cq.map((x) => x.name)).toEqual(expect.arrayContaining(['Purchasing', 'Sales']));
    const repaired = await c.s.selectFrom('discovery_flows').select('voice_app_id').where('id', '=', main.id).executeTakeFirstOrThrow();
    expect(repaired.voice_app_id).not.toBeNull();
    expect((await c.s.selectFrom('discovery_resource_accounts').select('voice_app_id').where('id', '=', ra.id).executeTakeFirstOrThrow()).voice_app_id).toBe(repaired.voice_app_id);
    // Running it again copies nothing twice.
    const again = await build.populateAll(c.t, engineer, gla);
    expect(again.voiceApps.created).toBe(0);
  });
});
