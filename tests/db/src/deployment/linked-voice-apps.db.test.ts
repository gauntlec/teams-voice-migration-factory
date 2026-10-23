// A design row that was made from (or linked to) a live voice app is compared with that exact live object - found through its Teams id,
// never its name - so linking what already exists does not look like a change, and two voice apps sharing a name cannot be mixed up.
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
let build: BuildService;
let deploy: DeploymentService;
let engineer: Awaited<ReturnType<typeof seedUser>>;
let site: string;

async function object(type: string, key: string, name: string, data: Record<string, unknown>) {
  return (await c.s.insertInto('tenant_objects').values({ object_type: type, object_key: key, display_name: name, data } as never).returning('id').executeTakeFirstOrThrow()).id;
}
const time = (h: number) => ({ Hours: h, Minutes: 0, Days: 0 });
const flow = (id: string, greeting: string, option: Record<string, unknown>) => ({ Id: id, Name: id, Greetings: [{ TextToSpeechPrompt: greeting }], Menu: { Name: `${id} menu`, MenuOptions: [option] } });
const disconnect = { DtmfResponse: 100, Action: 1 };

/** A live auto attendant with business hours, after hours (weekly schedule) and one holiday - the shape Get-CsAutoAttendant returns. */
function liveAa(identity: string, name: string, afterHoursOption: Record<string, unknown> = disconnect) {
  return {
    Identity: identity, Name: name, LanguageId: 'en-US', TimeZoneId: 'Eastern Standard Time', VoiceId: 'Male', VoiceResponseEnabled: false,
    DefaultCallFlow: flow(`${identity}-def`, 'Welcome', disconnect),
    CallFlows: [flow(`${identity}-ah`, 'Closed', afterHoursOption), flow(`${identity}-hol`, 'Holiday', disconnect)],
    CallHandlingAssociations: [
      { Type: 0, ScheduleId: `${identity}-sch-ah`, CallFlowId: `${identity}-ah` },
      { Type: 1, ScheduleId: `${identity}-sch-hol`, CallFlowId: `${identity}-hol` },
    ],
    ApplicationInstances: [],
  };
}

beforeAll(async () => {
  c = await seedCustomer(handle);
  engineer = await seedUser(handle, 'ENGINEER');
  site = (await seedSite(c.s, { sitecode: 'FSD02' })).id;
  const audit = new AuditService(handle.db);
  const dc = new DataCollectionService(handle.db, audit);
  const discovery = new TenantDiscoveryService(handle.db, unused('queue'), audit, unused('deployments'), dc, new TelephonyService(handle.db, audit, dc));
  build = new BuildService(handle.db, audit, new BuildValidationService(handle.db), discovery, unused('documentBuilder'), unused('files'));
  deploy = new DeploymentService(handle.db, unused('queue'), audit, unused('files'), new DeploymentDocumentService());
  for (const id of ['ov', 'main', 'twin1', 'twin2']) {
    await object('schedule', `${id}-sch-ah`, `${id} after hours`, { WeeklyRecurrentSchedule: { ComplementEnabled: true, MondayHours: [{ Start: time(7), End: time(16) }] }, FixedSchedule: null });
    await object('schedule', `${id}-sch-hol`, 'US Holidays', { FixedSchedule: { DateTimeRanges: [{ Start: '25/12/2025 0:00', End: '26/12/2025 0:00' }] }, WeeklyRecurrentSchedule: null });
  }
});

describe('linking voice apps that already exist', () => {
  it('plans no change for a linked auto attendant, even when it transfers to another one that also has a duplicate row', async () => {
    const ov = await object('auto_attendant', 'aa-ov', 'AA-Overflow', liveAa('ov', 'AA-Overflow'));
    const main = await object('auto_attendant', 'aa-main', 'AA-Main', liveAa('main', 'AA-Main', { DtmfResponse: 100, Action: 2, CallTarget: { Id: 'ov', Type: 6 } }));
    // the Identity the transfer points at is the overflow attendant's
    await c.s.updateTable('tenant_objects').set({ data: { ...liveAa('ov', 'AA-Overflow'), Identity: 'ov' } as never }).where('id', '=', ov).execute();
    await build.addFromDiscovery(c.t, engineer, { kind: 'auto_attendant', items: [{ id: ov, siteId: site }, { id: main, siteId: site }], alsoBuild: true });

    const first = await deploy.previewChanges(c.t, { siteId: site, sheets: ['auto_attendants'] } as never);
    expect(first.map((r) => [r.upn, r.calls.map((x) => x.cmdlet)])).toEqual([]);

    // a second row for the overflow attendant (made by hand, no link) is not mistaken for the live object: the linked rows still match
    await c.s.insertInto('build_auto_attendants').values({
      site_id: site, name: 'AA-Overflow', language_id: 'en-US', time_zone_id: 'Eastern Standard Time',
      default_call_flow: { greetings: [{ type: 'Text', text: 'Hi' }], menu: { options: [{ dtmf: 'Automatic', action: 'DisconnectCall' }] } },
    } as never).execute();
    const second = await deploy.previewChanges(c.t, { siteId: site, sheets: ['auto_attendants'] } as never);
    expect(second.map((r) => [r.upn, r.calls.map((x) => x.cmdlet)])).toEqual([['AA-Overflow', ['New-CsAutoAttendant']]]);
  });

  it('keeps two live auto attendants with the same name apart', async () => {
    const a = await object('auto_attendant', 'aa-twin1', 'Twin', { ...liveAa('twin1', 'Twin'), Identity: 'twin1' });
    const b = await object('auto_attendant', 'aa-twin2', 'Twin', { ...liveAa('twin2', 'Twin'), Identity: 'twin2', LanguageId: 'fr-FR' });
    await build.addFromDiscovery(c.t, engineer, { kind: 'auto_attendant', items: [{ id: a, siteId: site }, { id: b, siteId: site }], alsoBuild: true });
    const rows = await deploy.previewChanges(c.t, { siteId: site, sheets: ['auto_attendants'] } as never);
    expect(rows.filter((r) => r.upn === 'Twin')).toEqual([]);
    // change one of them in Design & Build: only that one is planned, against its own live object
    await c.s.updateTable('build_auto_attendants').set({ language_id: 'de-DE' }).where('name', '=', 'Twin').where('language_id', '=', 'fr-FR').execute();
    const changed = await deploy.previewChanges(c.t, { siteId: site, sheets: ['auto_attendants'] } as never);
    const twin = changed.filter((r) => r.upn === 'Twin');
    expect(twin).toHaveLength(1);
    expect(JSON.stringify(twin[0]!.calls)).toContain('twin2');
    expect(twin[0]!.warnings.join(' ')).toMatch(/Differs from the live auto attendant: language \(design de-DE, live fr-FR\)/);
  });

  it('plans no change for an auto attendant whose menu transfers to a voice app that is not on the site', async () => {
    const transfer = { DtmfResponse: 100, Action: 2, Prompt: null, CallTarget: { Id: '23fa0565-93af-4c1f-802b-d21c8aa19291', Type: 6, CallPriority: 3 }, VoiceResponses: [] };
    const base = liveAa('far', 'Far');
    const data = { ...base, Identity: 'far', DefaultCallFlow: flow('far-def', 'Welcome', transfer) };
    await object('schedule', 'far-sch-ah', 'far after hours', { WeeklyRecurrentSchedule: { ComplementEnabled: true, MondayHours: [{ Start: time(7), End: time(16) }] }, FixedSchedule: null });
    await object('schedule', 'far-sch-hol', 'US Holidays', { FixedSchedule: { DateTimeRanges: [{ Start: '25/12/2025 0:00', End: '26/12/2025 0:00' }] }, WeeklyRecurrentSchedule: null });
    const far = await object('auto_attendant', 'aa-far', 'Far', data);
    await build.addFromDiscovery(c.t, engineer, { kind: 'auto_attendant', items: [{ id: far, siteId: site }], alsoBuild: true });
    const rows = await deploy.previewChanges(c.t, { siteId: site, sheets: ['auto_attendants'] } as never);
    expect(rows.filter((r) => r.upn === 'Far').map((r) => r.warnings)).toEqual([]);

    // the transfer is kept, as the Teams id, instead of being dropped (which would turn it into a disconnect on deploy)
    const row = await c.s.selectFrom('build_auto_attendants').select(['id', 'default_call_flow']).where('name', '=', 'Far').executeTakeFirstOrThrow();
    const option = (row.default_call_flow as { menu: { options: { action: string; target?: Record<string, unknown> }[] } }).menu.options[0]!;
    expect(option).toMatchObject({ action: 'TransferCallToTarget', target: { liveId: '23fa0565-93af-4c1f-802b-d21c8aa19291' } });

    // a later change to the row deploys with that same target, not a disconnect
    await c.s.updateTable('build_auto_attendants').set({ language_id: 'en-GB' }).where('id', '=', row.id).execute();
    const changed = await deploy.previewChanges(c.t, { siteId: site, sheets: ['auto_attendants'] } as never);
    const farRow = changed.find((r) => r.upn === 'Far')!;
    expect(farRow.warnings.join(' ')).toMatch(/Differs from the live auto attendant: language/);
    expect(JSON.stringify(farRow.calls)).toContain('23fa0565-93af-4c1f-802b-d21c8aa19291');
    await c.s.updateTable('build_auto_attendants').set({ language_id: 'en-US' }).where('id', '=', row.id).execute();

    // when that voice app later becomes part of the site, the same target is still no change
    const queue = await object('call_queue', 'cq-far', 'Far Queue', { Identity: '23fa0565-93af-4c1f-802b-d21c8aa19291', LanguageId: 'en-US', RoutingMethod: 'Attendant', Agents: [], ApplicationInstances: [] });
    await build.addFromDiscovery(c.t, engineer, { kind: 'call_queue', items: [{ id: queue, siteId: site }], alsoBuild: true });
    const after = await deploy.previewChanges(c.t, { siteId: site, sheets: ['auto_attendants'] } as never);
    expect(after.filter((r) => r.upn === 'Far')).toEqual([]);
  });
});

