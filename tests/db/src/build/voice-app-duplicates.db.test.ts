// Bug report "Site Data -> Design and Build CQ/AA name change" (Glasgow): deployed call queues and an auto attendant were built a
// second time by Add to site, renamed back by a re-import, and after their Site Data entries were deleted planned New-Cs* for
// things Teams already had. Each guard is tested on its own here.
import { ConflictException } from '@nestjs/common';
import type { CallQueueWizardAnswers } from '@tvmf/shared';
import { beforeAll, describe, expect, it } from 'vitest';
import { AuditService } from '../../../../apps/api/src/common/audit.service';
import { BuildService } from '../../../../apps/api/src/modules/build/build.service';
import { BuildValidationService } from '../../../../apps/api/src/modules/build/build-validation.service';
import { DataCollectionService } from '../../../../apps/api/src/modules/data-collection/data-collection.service';
import { TelephonyService } from '../../../../apps/api/src/modules/data-collection/data-collection.telephony.service';
import { DeploymentDocumentService } from '../../../../apps/api/src/modules/deployment/deployment-document.service';
import { DeploymentService } from '../../../../apps/api/src/modules/deployment/deployment.service';
import { TenantDiscoveryService } from '../../../../apps/api/src/modules/tenant-discovery/tenant-discovery.service';
import { seedCustomer, seedSite, seedUser, unused, useDb, type TestCustomer } from '../helpers';

const handle = useDb();
let c: TestCustomer;
let dc: DataCollectionService;
let build: BuildService;
let deploy: DeploymentService;
let engineer: Awaited<ReturnType<typeof seedUser>>;

const cqAnswers: CallQueueWizardAnswers = {
  languageId: 'en-GB',
  agents: [],
  routingMethod: 'LongestIdle',
  presenceBasedRouting: true,
  agentAlertTime: 20,
  overflowThreshold: 10,
  overflow: { action: 'DisconnectWithBusy' },
  timeoutThreshold: 300,
  timeout: { action: 'Disconnect' },
  noAgents: { action: 'Queue' },
  noAgentsApplyTo: 'AllCalls',
};

async function liveQueue(identity: string, name: string) {
  return (
    await c.s
      .insertInto('tenant_objects')
      .values({ object_type: 'call_queue', object_key: identity, display_name: name, data: { Identity: identity, Name: name, LanguageId: 'en-GB', RoutingMethod: 'LongestIdle', Agents: [] } } as never)
      .returning('id')
      .executeTakeFirstOrThrow()
  ).id;
}
/** A row as the Glasgow ones were: typed in the wizard, imported, deployed. */
async function deployedQueue(siteId: string, name: string, identity: string | null) {
  const flow = await dc.addFlow(c.t, engineer, { site_id: siteId, kind: 'call_queue', name, wizard_answers: cqAnswers } as never, true);
  const { row } = await build.importFlowWizard(c.t, engineer, flow.id);
  if (identity) await c.s.updateTable('build_call_queues').set({ teams_identity: identity }).where('id', '=', row.id).execute();
  return { flowId: flow.id, rowId: row.id };
}
const queuesNamed = (siteId: string, name: string) => c.s.selectFrom('build_call_queues').selectAll().where('site_id', '=', siteId).where('name', '=', name).execute();

beforeAll(async () => {
  c = await seedCustomer(handle);
  engineer = await seedUser(handle, 'ENGINEER');
  const audit = new AuditService(handle.db);
  dc = new DataCollectionService(handle.db, audit);
  const tel = new TelephonyService(handle.db, audit, dc);
  const discovery = new TenantDiscoveryService(handle.db, unused('queue'), audit, unused('deployments'), dc, tel);
  build = new BuildService(handle.db, audit, new BuildValidationService(handle.db), discovery, unused('documentBuilder'), unused('files'));
  deploy = new DeploymentService(handle.db, unused('queue'), audit, unused('files'), new DeploymentDocumentService());
});

describe('match before creating', () => {
  it('Add to site links the deployed row for the same Teams object instead of building a second', async () => {
    const siteId = (await seedSite(c.s, { sitecode: 'DUP01' })).id;
    const { rowId } = await deployedQueue(siteId, 'Sales', 'cq-sales');
    const live = await liveQueue('cq-sales', 'UK-DUP01-Sales');
    const res = await build.addFromDiscovery(c.t, engineer, { kind: 'call_queue', items: [{ id: live, siteId }], alsoBuild: true });
    expect(res[0]).toMatchObject({ dataCollection: 'added', designAndBuild: 'already_on_site' });
    expect(res[0].note).toMatch(/Linked to "Sales", which was already in Design & Build/);
    const rows = await c.s.selectFrom('build_call_queues').select(['id', 'discovery_voice_app_id']).where('site_id', '=', siteId).execute();
    expect(rows).toHaveLength(1);
    const app = await c.s.selectFrom('discovery_voice_apps').select('id').where('tenant_object_id', '=', live).executeTakeFirstOrThrow();
    expect(rows[0]).toEqual({ id: rowId, discovery_voice_app_id: app.id });
  });

  it('links a row of the same name that was only ever designed, and records its Teams object', async () => {
    const siteId = (await seedSite(c.s, { sitecode: 'DUP02' })).id;
    const { rowId } = await deployedQueue(siteId, 'UK-DUP02-Accounts', null);
    const live = await liveQueue('cq-accounts', 'UK-DUP02-Accounts');
    await build.addFromDiscovery(c.t, engineer, { kind: 'call_queue', items: [{ id: live, siteId }], alsoBuild: true });
    const rows = await queuesNamed(siteId, 'UK-DUP02-Accounts');
    expect(rows.map((r) => [r.id, r.teams_identity])).toEqual([[rowId, 'cq-accounts']]);
  });
});

describe('a deployed row remembers its Teams object', () => {
  it('plans no create when its Site Data entry has been deleted', async () => {
    const siteId = (await seedSite(c.s, { sitecode: 'DUP03' })).id;
    const { rowId } = await deployedQueue(siteId, 'UK-DUP03-Engineering', 'cq-eng');
    await liveQueue('cq-eng', 'UK-DUP03-Engineering');
    // another queue in Teams with the same name, so the name alone can't say which one this row is
    await liveQueue('cq-eng-elsewhere', 'UK-DUP03-Engineering');
    await c.s.updateTable('build_call_queues').set({ discovery_voice_app_id: null }).where('id', '=', rowId).execute();
    const plan = await deploy.previewChanges(c.t, { siteId, sheets: ['call_queues'] } as never);
    const cmdlets = plan.flatMap((r) => r.calls.map((x) => x.cmdlet));
    expect(cmdlets).not.toContain('New-CsCallQueue');
    expect(JSON.stringify(plan)).not.toMatch(/already exists in Teams/);
    // and any change it does plan goes to its own queue
    expect(JSON.stringify(plan)).not.toContain('cq-eng-elsewhere');
  });

  it('holds back a row with no Teams object of its own when Teams already has its name', async () => {
    const siteId = (await seedSite(c.s, { sitecode: 'DUP04' })).id;
    await deployedQueue(siteId, 'UK-DUP04-Purchasing', 'cq-purch');
    await liveQueue('cq-purch', 'UK-DUP04-Purchasing');
    // the duplicate: same name, no link, nothing recorded
    const dup = await c.s.insertInto('build_call_queues').values({ site_id: siteId, name: 'UK-DUP04-Purchasing', agents: JSON.stringify([]), resource_accounts: JSON.stringify([]), overflow: {}, timeout: {} } as never).returning('id').executeTakeFirstOrThrow();
    const plan = await deploy.previewChanges(c.t, { siteId, sheets: ['call_queues'] } as never);
    const row = plan.find((r) => r.rowId === dup.id);
    expect(row?.calls).toEqual([]);
    expect(row?.skipReasons?.join(' ')).toMatch(/A call queue called "UK-DUP04-Purchasing" already exists in Teams/);
    expect(plan.flatMap((r) => r.calls.map((x) => x.cmdlet))).not.toContain('New-CsCallQueue');
  });
});

describe('importing over a deployed row', () => {
  it('lists what would change and needs a confirmation, and never renames the row back', async () => {
    const siteId = (await seedSite(c.s, { sitecode: 'DUP05' })).id;
    const { flowId, rowId } = await deployedQueue(siteId, 'Main Number', 'cq-main');
    await c.s.updateTable('build_call_queues').set({ name: 'UK-DUP05-MainNumber' }).where('id', '=', rowId).execute();
    // the old capture is edited and imported again
    await c.s.updateTable('discovery_flows').set({ wizard_answers: JSON.stringify({ ...cqAnswers, routingMethod: 'RoundRobin' }), updated_at: new Date(Date.now() + 1000).toISOString() } as never).where('id', '=', flowId).execute();

    const refused = await build.importFlowWizard(c.t, engineer, flowId).catch((e: unknown) => e);
    expect(refused).toBeInstanceOf(ConflictException);
    const body = (refused as ConflictException).getResponse() as { code: string; changes: string[] };
    expect(body.code).toBe('confirm_import');
    expect(body.changes).toContain('routing method');
    expect((await c.s.selectFrom('build_call_queues').select(['name', 'routing_method']).where('id', '=', rowId).executeTakeFirstOrThrow())).toEqual({ name: 'UK-DUP05-MainNumber', routing_method: 'LongestIdle' });

    const done = await build.importFlowWizard(c.t, engineer, flowId, { confirmed: true });
    expect(done.warnings.join(' ')).toMatch(/The name stays "UK-DUP05-MainNumber"/);
    expect((await c.s.selectFrom('build_call_queues').select(['name', 'routing_method']).where('id', '=', rowId).executeTakeFirstOrThrow())).toEqual({ name: 'UK-DUP05-MainNumber', routing_method: 'RoundRobin' });
  });

  it('asks nothing for a row that has never been deployed', async () => {
    const siteId = (await seedSite(c.s, { sitecode: 'DUP06' })).id;
    const { flowId, rowId } = await deployedQueue(siteId, 'Design Only', null);
    await c.s.updateTable('discovery_flows').set({ name: 'Design Only 2', wizard_answers: JSON.stringify({ ...cqAnswers, routingMethod: 'RoundRobin' }), updated_at: new Date(Date.now() + 1000).toISOString() } as never).where('id', '=', flowId).execute();
    await build.importFlowWizard(c.t, engineer, flowId);
    expect(await c.s.selectFrom('build_call_queues').select(['name', 'routing_method']).where('id', '=', rowId).executeTakeFirstOrThrow()).toEqual({ name: 'Design Only 2', routing_method: 'RoundRobin' });
  });
});

describe('renaming both sides together', () => {
  it('renames the Site Data voice app and its call flow with the row', async () => {
    const siteId = (await seedSite(c.s, { sitecode: 'DUP07' })).id;
    const { flowId, rowId } = await deployedQueue(siteId, 'Accounts', null);
    const row = await c.s.selectFrom('build_call_queues').select('discovery_voice_app_id').where('id', '=', rowId).executeTakeFirstOrThrow();
    expect(row.discovery_voice_app_id).toBeTruthy();
    await build.updateCallQueue(c.t, engineer, rowId, { name: 'UK-DUP07-MainNumberAccounts', rename_site_data: true });
    const app = await c.s.selectFrom('discovery_voice_apps').select('name').where('id', '=', row.discovery_voice_app_id!).executeTakeFirstOrThrow();
    const flow = await c.s.selectFrom('discovery_flows').select('name').where('id', '=', flowId).executeTakeFirstOrThrow();
    expect([app.name, flow.name]).toEqual(['UK-DUP07-MainNumberAccounts', 'UK-DUP07-MainNumberAccounts']);

    // without the option, Site Data keeps its name
    await build.updateCallQueue(c.t, engineer, rowId, { name: 'Renamed in Design & Build only' });
    expect((await c.s.selectFrom('discovery_voice_apps').select('name').where('id', '=', row.discovery_voice_app_id!).executeTakeFirstOrThrow()).name).toBe('UK-DUP07-MainNumberAccounts');
  });
});
