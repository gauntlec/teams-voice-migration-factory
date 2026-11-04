// Bug report "Associated Resource Account to AA & CQ": a resource account linked to an auto attendant from the Resource accounts
// tab must show in the AA / CQ wizard (the Call flow's resource_account_id), and the wizard's choice must show on the Resource
// accounts tab (the account's voice_app_id).
import { beforeAll, describe, expect, it } from 'vitest';
import { AuditService } from '../../../../apps/api/src/common/audit.service';
import { DataCollectionService } from '../../../../apps/api/src/modules/data-collection/data-collection.service';
import { TelephonyService } from '../../../../apps/api/src/modules/data-collection/data-collection.telephony.service';
import { seedCustomer, seedSite, seedUser, useDb, type TestCustomer } from '../helpers';

const handle = useDb();
let c: TestCustomer;
let dc: DataCollectionService;
let tel: TelephonyService;
let engineer: Awaited<ReturnType<typeof seedUser>>;
let site: string;

beforeAll(async () => {
  c = await seedCustomer(handle);
  engineer = await seedUser(handle, 'ENGINEER');
  site = (await seedSite(c.s, { sitecode: 'LNK01' })).id;
  const audit = new AuditService(handle.db);
  dc = new DataCollectionService(handle.db, audit);
  tel = new TelephonyService(handle.db, audit, dc);
});

const flowRa = async (id: string) =>
  (await c.s.selectFrom('discovery_flows').select('resource_account_id').where('id', '=', id).executeTakeFirstOrThrow()).resource_account_id;
const raApp = async (id: string) =>
  (await c.s.selectFrom('discovery_resource_accounts').select('voice_app_id').where('id', '=', id).executeTakeFirstOrThrow()).voice_app_id;

describe('call flow and resource account stay linked both ways', () => {
  it('an account linked from the Resource accounts tab shows on the flow', async () => {
    const flow = await dc.addFlow(c.t, engineer, { site_id: site, kind: 'auto_attendant', name: 'Main AA' } as never, true);
    expect(flow.resource_account_id).toBeNull();
    const ra = await tel.addResourceAccount(c.t, engineer, { site_id: site, name: 'ra-main', kind: 'auto_attendant' } as never, true);
    await tel.updateResourceAccount(c.t, engineer, ra.id, { voice_app_id: flow.voice_app_id } as never, true);
    expect(await flowRa(flow.id)).toBe(ra.id);
  });

  it('an account added already linked fills the flow', async () => {
    const flow = await dc.addFlow(c.t, engineer, { site_id: site, kind: 'call_queue', name: 'Sales CQ' } as never, true);
    const ra = await tel.addResourceAccount(c.t, engineer, { site_id: site, name: 'ra-sales', kind: 'call_queue', voice_app_id: flow.voice_app_id } as never, true);
    expect(await flowRa(flow.id)).toBe(ra.id);
  });

  it('unlinking or deleting an account hands the flow to another account on the app, or none', async () => {
    const flow = await dc.addFlow(c.t, engineer, { site_id: site, kind: 'auto_attendant', name: 'Two RAs' } as never, true);
    const a = await tel.addResourceAccount(c.t, engineer, { site_id: site, name: 'ra-a', kind: 'auto_attendant', voice_app_id: flow.voice_app_id } as never, true);
    const b = await tel.addResourceAccount(c.t, engineer, { site_id: site, name: 'ra-b', kind: 'auto_attendant', voice_app_id: flow.voice_app_id } as never, true);
    expect(await flowRa(flow.id)).toBe(a.id);
    await tel.updateResourceAccount(c.t, engineer, a.id, { voice_app_id: null } as never, true);
    expect(await flowRa(flow.id)).toBe(b.id);
    await tel.deleteResourceAccount(c.t, engineer, b.id, true);
    expect(await flowRa(flow.id)).toBeNull();
  });

  it("the wizard's choice links the account, and a cleared choice unlinks it", async () => {
    const flow = await dc.addFlow(c.t, engineer, { site_id: site, kind: 'call_queue', name: 'Wizard CQ' } as never, true);
    const ra = await tel.addResourceAccount(c.t, engineer, { site_id: site, name: 'ra-wiz', kind: 'call_queue' } as never, true);
    await dc.updateFlow(c.t, engineer, flow.id, { resource_account_id: ra.id } as never, true);
    expect(await raApp(ra.id)).toBe(flow.voice_app_id);
    await dc.updateFlow(c.t, engineer, flow.id, { resource_account_id: null } as never, true);
    expect(await raApp(ra.id)).toBeNull();
    expect(await flowRa(flow.id)).toBeNull();
  });
});
