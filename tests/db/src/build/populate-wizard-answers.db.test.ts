// Bug reports, 5 Nov (Chris Rae): an auto attendant or call queue designed in the Site Data wizard came into Design & Build by
// Populate from Site Data as an empty row - no language (en-GB on Glasgow), time zone, menus or hours, so it could not be deployed
// (New-CsAutoAttendant needs -LanguageId, -TimeZoneId and -DefaultCallFlow). Populate now builds it from the wizard's answers, as
// Import to Design & Build does, and fills in a row an earlier Populate left empty. The wizard's "Play the message, then hang up"
// becomes the greeting and a Disconnect (New-CsAutoAttendantMenuOption -Action DisconnectCall -DtmfResponse Automatic).
import { beforeAll, describe, expect, it } from 'vitest';
import type { AutoAttendantWizardAnswers, CallQueueWizardAnswers } from '@tvmf/shared';
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

const weekdays = { monday: [{ start: '08:00', end: '18:00' }], tuesday: [{ start: '08:00', end: '18:00' }], wednesday: [{ start: '08:00', end: '18:00' }], thursday: [{ start: '08:00', end: '18:00' }], friday: [{ start: '08:00', end: '18:00' }], saturday: [], sunday: [] };
const cqAnswers: CallQueueWizardAnswers = {
  languageId: 'en-GB',
  agents: ['someone@contoso.test'],
  routingMethod: 'LongestIdle',
  presenceBasedRouting: true,
  agentAlertTime: 20,
  overflowThreshold: 10,
  overflow: { action: 'DisconnectWithBusy' },
  timeoutThreshold: 300,
  timeout: { action: 'Disconnect', message: 'Sorry, nobody could take your call.' },
  noAgents: { action: 'Queue' },
  noAgentsApplyTo: 'AllCalls',
};
const aaAnswers = (salesFlowId: string): AutoAttendantWizardAnswers => ({
  languageId: 'en-GB',
  timeZoneId: 'GMT Standard Time',
  hoursType: 'custom',
  customHours: weekdays,
  businessFlow: { mode: 'menu', greeting: 'Welcome to Contoso Glasgow', options: [{ key: '1', label: 'Sales', target: { kind: 'call_queue', label: 'Sales', flowId: salesFlowId } }] },
  afterHoursFlow: { mode: 'disconnect', greeting: 'We are closed. Our hours are 8am to 6pm, Monday to Friday.' },
  holidaysEnabled: false,
});

beforeAll(async () => {
  c = await seedCustomer(handle);
  engineer = await seedUser(handle, 'ENGINEER');
  const audit = new AuditService(handle.db);
  dc = new DataCollectionService(handle.db, audit);
  tel = new TelephonyService(handle.db, audit, dc);
  const discovery = new TenantDiscoveryService(handle.db, unused('queue'), audit, unused('deployments'), dc, tel);
  build = new BuildService(handle.db, audit, new BuildValidationService(handle.db), discovery, unused('documentBuilder'), unused('files'));
});

async function designSite(sitecode: string) {
  const siteId = (await seedSite(c.s, { sitecode })).id;
  const ra = await tel.addResourceAccount(c.t, engineer, { site_id: siteId, name: 'Main', kind: 'auto_attendant', upn: `aa-${sitecode.toLowerCase()}@contoso.test` } as never, true);
  const sales = await dc.addFlow(c.t, engineer, { site_id: siteId, kind: 'call_queue', name: 'Sales', wizard_answers: cqAnswers } as never, true);
  const main = await dc.addFlow(c.t, engineer, { site_id: siteId, kind: 'auto_attendant', name: 'Main Number', resource_account_id: ra.id, wizard_answers: aaAnswers(sales.id) } as never, true);
  return { siteId, ra, sales, main };
}

describe('Populate from Site Data with auto attendants and call queues designed in the wizard', () => {
  it('builds them from the wizard: language, time zone, hours, menus, the after-hours message and hang up, and the queue settings', async () => {
    const { siteId, ra, sales, main } = await designSite('GLA01');
    const r = await build.populateAll(c.t, engineer, siteId);
    expect(r.voiceApps.created).toBe(2);
    expect(r.voiceApps.warnings.join(' ')).not.toContain("hasn't been populated");

    const cq = await c.s.selectFrom('build_call_queues').selectAll().where('site_id', '=', siteId).executeTakeFirstOrThrow();
    expect(cq).toMatchObject({ name: 'Sales', language_id: 'en-GB', routing_method: 'LongestIdle', presence_based_routing: true, agent_alert_time: 20 });
    expect(cq.agents).toEqual(['someone@contoso.test']);
    expect(cq.timeout).toMatchObject({ action: 'Disconnect', threshold: 300, redirectPrompt: 'Sorry, nobody could take your call.' });

    const aa = await c.s.selectFrom('build_auto_attendants').selectAll().where('site_id', '=', siteId).executeTakeFirstOrThrow();
    expect(aa).toMatchObject({ name: 'Main Number', language_id: 'en-GB', time_zone_id: 'GMT Standard Time' });
    expect(aa.default_call_flow).toMatchObject({
      greetings: [{ type: 'Text', text: 'Welcome to Contoso Glasgow' }],
      menu: { options: [{ dtmf: 'Tone1', action: 'TransferCallToTarget', target: { kind: 'call_queue', buildId: cq.id } }] },
    });
    expect(aa.after_hours_call_flow).toEqual({
      greetings: [{ type: 'Text', text: 'We are closed. Our hours are 8am to 6pm, Monday to Friday.' }],
      menu: { options: [{ dtmf: 'Automatic', action: 'DisconnectCall' }] },
    });
    expect(aa.schedule).toMatchObject({ type: 'weekly', weekly: { monday: [{ start: '08:00', end: '18:00' }], complement: true } });

    // the resource account came across and answers for the auto attendant; the flows show as in Design & Build
    const bra = await c.s.selectFrom('build_resource_accounts').select('id').where('discovery_resource_account_id', '=', ra.id).executeTakeFirstOrThrow();
    expect(aa.resource_accounts).toEqual([bra.id]);
    const flows = await c.s.selectFrom('discovery_flows').select(['id', 'imported_at', 'build_auto_attendant_id', 'build_call_queue_id']).where('site_id', '=', siteId).execute();
    expect(flows.find((f) => f.id === main.id)).toMatchObject({ build_auto_attendant_id: aa.id });
    expect(flows.find((f) => f.id === sales.id)).toMatchObject({ build_call_queue_id: cq.id });
    expect(flows.every((f) => f.imported_at)).toBe(true);

    // running it again adds nothing twice
    const again = await build.populateAll(c.t, engineer, siteId);
    expect(again.voiceApps.created).toBe(0);
    expect(await c.s.selectFrom('build_auto_attendants').select('id').where('site_id', '=', siteId).execute()).toHaveLength(1);
  });

  it('fills in a row an earlier Populate left empty, but leaves one an engineer has edited', async () => {
    const { siteId, sales, main } = await designSite('GLA02');
    const appOf = async (flowId: string) => (await c.s.selectFrom('discovery_flows').select('voice_app_id').where('id', '=', flowId).executeTakeFirstOrThrow()).voice_app_id!;
    // What Populate did before this fix: name-only rows.
    const aaRow = await c.s.insertInto('build_auto_attendants').values({ site_id: siteId, discovery_voice_app_id: await appOf(main.id), name: 'Main Number', resource_accounts: JSON.stringify([]), config: {}, holiday_call_flows: JSON.stringify([]) } as never).returning('id').executeTakeFirstOrThrow();
    const cqRow = await c.s.insertInto('build_call_queues').values({ site_id: siteId, discovery_voice_app_id: await appOf(sales.id), name: 'Sales', resource_accounts: JSON.stringify([]), agents: JSON.stringify([]), overflow: {}, timeout: {} } as never).returning('id').executeTakeFirstOrThrow();
    // ...and an engineer has since worked on the call queue by hand
    await c.s.updateTable('build_call_queues').set({ routing_method: 'Serial', updated_at: new Date(Date.now() + 60_000).toISOString() } as never).where('id', '=', cqRow.id).execute();

    const r = await build.populateAll(c.t, engineer, siteId);
    expect(r.voiceApps).toMatchObject({ created: 0, filled: 1 });
    const aa = await c.s.selectFrom('build_auto_attendants').selectAll().where('id', '=', aaRow.id).executeTakeFirstOrThrow();
    expect(aa).toMatchObject({ language_id: 'en-GB', time_zone_id: 'GMT Standard Time' });
    expect(aa.after_hours_call_flow).toMatchObject({ menu: { options: [{ action: 'DisconnectCall' }] } });
    const cq = await c.s.selectFrom('build_call_queues').selectAll().where('id', '=', cqRow.id).executeTakeFirstOrThrow();
    expect(cq).toMatchObject({ routing_method: 'Serial', language_id: null });
    expect(await c.s.selectFrom('build_auto_attendants').select('id').where('site_id', '=', siteId).execute()).toHaveLength(1);
  });
});
