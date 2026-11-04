// "Copy to Site Data" (bug report "Site Data Sync Back for Auto Attendants and Call Queues"): a Design & Build call queue or auto
// attendant written back to Site Data's Call flows as the wizard's answers - a new call flow the first time, the same one after.
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
let build: BuildService;
let dc: DataCollectionService;
let engineer: Awaited<ReturnType<typeof seedUser>>;
let site: string;

beforeAll(async () => {
  c = await seedCustomer(handle);
  engineer = await seedUser(handle, 'ENGINEER');
  site = (await seedSite(c.s, { sitecode: 'CPY01' })).id;
  const audit = new AuditService(handle.db);
  dc = new DataCollectionService(handle.db, audit);
  const discovery = new TenantDiscoveryService(handle.db, unused('queue'), audit, unused('deployments'), dc, new TelephonyService(handle.db, audit, dc));
  build = new BuildService(handle.db, audit, new BuildValidationService(handle.db), discovery, unused('documentBuilder'), unused('files'));
});

const flows = () => c.s.selectFrom('discovery_flows').select(['id', 'name', 'kind', 'wizard_answers', 'build_call_queue_id', 'build_auto_attendant_id', 'voice_app_id']).where('site_id', '=', site).orderBy('name').execute();

describe('Copy to Site Data', () => {
  it('makes a call flow for a call queue Site Data does not have, then updates that same one', async () => {
    const cq = (await c.s
      .insertInto('build_call_queues')
      .values({ site_id: site, name: 'Sales', routing_method: 'LongestIdle', agent_alert_time: 25, agents: JSON.stringify(['ann@contoso.test']), overflow: JSON.stringify({ action: 'DisconnectWithBusy', threshold: 12, redirectPrompt: 'We are busy' }), resource_accounts: JSON.stringify([]) } as never)
      .returning('id')
      .executeTakeFirstOrThrow()).id;
    const first = await build.copyToSiteData(c.t, engineer, 'call-queues', { ids: [cq] });
    expect(first.copied).toEqual([{ name: 'Sales', flowId: expect.any(String), added: true }]);
    let [flow] = await flows();
    expect(flow).toMatchObject({ name: 'Sales', kind: 'call_queue', build_call_queue_id: cq, voice_app_id: expect.any(String) });
    expect(flow!.wizard_answers).toMatchObject({ routingMethod: 'LongestIdle', agentAlertTime: 25, agents: ['ann@contoso.test'], overflowThreshold: 12, overflow: { action: 'DisconnectWithBusy', message: 'We are busy' } });

    await c.s.updateTable('build_call_queues').set({ name: 'Sales Team', agent_alert_time: 40 } as never).where('id', '=', cq).execute();
    const again = await build.copyToSiteData(c.t, engineer, 'call-queues', { site_id: site, all: true });
    expect(again.copied).toEqual([{ name: 'Sales Team', flowId: flow!.id, added: false }]);
    [flow] = await flows();
    expect(flow).toMatchObject({ name: 'Sales Team' });
    expect(flow!.wizard_answers).toMatchObject({ agentAlertTime: 40 });
    const app = await c.s.selectFrom('discovery_voice_apps').select('name').where('id', '=', flow!.voice_app_id!).executeTakeFirstOrThrow();
    expect(app.name).toBe('Sales Team');
  });

  it('updates the call flow an auto attendant was imported from, and skips one with no call flow yet', async () => {
    const imported = await dc.addFlow(c.t, engineer, { site_id: site, kind: 'auto_attendant', name: 'Main AA' } as never, true);
    const aa = (await c.s
      .insertInto('build_auto_attendants')
      .values({ site_id: site, name: 'Main AA', language_id: 'en-GB', time_zone_id: 'UTC', default_call_flow: JSON.stringify({ greetings: [{ type: 'Text', text: 'Hello' }], menu: { options: [{ dtmf: 'Automatic', action: 'TransferCallToTarget', target: { kind: 'external', number: '+442070000000' } }] } }), resource_accounts: JSON.stringify([]), holiday_call_flows: JSON.stringify([]), config: JSON.stringify({}) } as never)
      .returning('id')
      .executeTakeFirstOrThrow()).id;
    await c.s.updateTable('discovery_flows').set({ build_auto_attendant_id: aa }).where('id', '=', imported.id).execute();
    const empty = (await c.s.insertInto('build_auto_attendants').values({ site_id: site, name: 'Empty AA', resource_accounts: JSON.stringify([]), holiday_call_flows: JSON.stringify([]), config: JSON.stringify({}) } as never).returning('id').executeTakeFirstOrThrow()).id;
    const res = await build.copyToSiteData(c.t, engineer, 'auto-attendants', { ids: [aa, empty] });
    expect(res.copied).toEqual([{ name: 'Main AA', flowId: imported.id, added: false }]);
    expect(res.skipped).toEqual([{ name: 'Empty AA', reason: expect.any(String) }]);
    const flow = (await flows()).find((f) => f.id === imported.id)!;
    expect(flow.wizard_answers).toMatchObject({ languageId: 'en-GB', businessFlow: { mode: 'direct', greeting: 'Hello', target: { kind: 'external', label: '+442070000000' } } });
  });
});
