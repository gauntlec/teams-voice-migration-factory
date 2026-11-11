// Call Flows (preview), docs/CALL-FLOWS-WIZARD.md step 2: a flow made in the preview is saved as the classic wizards save one - the
// number on a resource account answering an auto attendant, a call queue capture per group linked by flowId - marked editor
// 'call-flows'. A number already answering a flow, a customer, or a flow with something missing leaves nothing behind.
import { beforeAll, describe, expect, it } from 'vitest';
import { fromCaptures, newVisualGroup, type AutoAttendantWizardAnswers, type CallQueueWizardAnswers, type VisualCallFlow } from '@tvmf/shared';
import { AuditService } from '../../../../apps/api/src/common/audit.service';
import { DataCollectionService } from '../../../../apps/api/src/modules/data-collection/data-collection.service';
import { TelephonyService } from '../../../../apps/api/src/modules/data-collection/data-collection.telephony.service';
import { seedCustomer, seedNumbers, seedSite, seedUser, useDb, type TestCustomer } from '../helpers';

const handle = useDb();
let c: TestCustomer;
let svc: TelephonyService;
let engineer: Awaited<ReturnType<typeof seedUser>>;
let customer: Awaited<ReturnType<typeof seedUser>>;
let site: string;

beforeAll(async () => {
  c = await seedCustomer(handle);
  engineer = await seedUser(handle, 'ENGINEER');
  customer = await seedUser(handle, 'CUSTOMER');
  site = (await seedSite(c.s, { sitecode: 'CFP01' })).id;
  const audit = new AuditService(handle.db);
  svc = new TelephonyService(handle.db, audit, new DataCollectionService(handle.db, audit));
});

const sales = { ...newVisualGroup('local-sales', 'Sales', 'en-GB'), people: ['jo@contoso.test', 'sam@contoso.test'] };
const menuFlow: VisualCallFlow = {
  name: 'Main Line',
  languageId: 'en-GB',
  timeZoneId: 'GMT Standard Time',
  hours: { type: 'standard' },
  business: {
    greeting: 'Welcome to Contoso.',
    then: {
      kind: 'menu',
      options: [
        { key: '1', label: 'Sales', then: sales },
        { key: '2', label: 'Sales again', then: sales },
        { key: '3', label: 'Accounts', then: { kind: 'person', who: 'pat@contoso.test' } },
      ],
    },
  },
  afterHours: { then: { kind: 'shared_voicemail', group: 'Main voicemail' } },
};

const counts = async () => ({
  apps: (await c.s.selectFrom('discovery_voice_apps').select('id').execute()).length,
  ras: (await c.s.selectFrom('discovery_resource_accounts').select('id').execute()).length,
  flows: (await c.s.selectFrom('discovery_flows').select('id').execute()).length,
});

describe('Call Flows (preview): saving', () => {
  it('saves the number, the auto attendant and one call queue per group, linked as the classic wizards link them', async () => {
    const [n] = await seedNumbers(c.s, 'CFP01', ['+442070000301']);
    const res = await svc.saveVisualCallFlow(c.t, engineer, { site_id: site, phone_number_id: n!.id, flow: menuFlow }, true);
    expect(res.queues).toBe(1);

    const flows = await c.s.selectFrom('discovery_flows').selectAll().where('editor', '=', 'call-flows').orderBy('created_at').execute();
    expect(flows.map((f) => [f.kind, f.name])).toEqual([
      ['call_queue', 'Sales'],
      ['auto_attendant', 'Main Line'],
    ]);
    const [queue, attendant] = flows as [(typeof flows)[0], (typeof flows)[0]];
    expect(attendant.id).toBe(res.flowId);
    expect(attendant.voice_app_id).toBe(res.voiceAppId);
    expect(queue.voice_app_id).not.toBeNull();
    expect(queue.voice_app_id).not.toBe(res.voiceAppId);

    // the number is on a resource account named as the flow, answering its auto attendant
    const ra = await c.s.selectFrom('discovery_resource_accounts').selectAll().where('voice_app_id', '=', res.voiceAppId).executeTakeFirstOrThrow();
    expect([ra.name, ra.kind, attendant.resource_account_id]).toEqual(['Main Line', 'auto_attendant', ra.id]);
    const num = await c.s.selectFrom('phone_numbers').select(['holder_type', 'holder_id']).where('id', '=', n!.id).executeTakeFirstOrThrow();
    expect(num).toEqual({ holder_type: 'resource_account', holder_id: ra.id });

    // both menu options point at the one queue capture, by its id
    const aa = attendant.wizard_answers as AutoAttendantWizardAnswers;
    expect(aa.businessFlow.options!.map((o) => o.target)).toEqual([
      { kind: 'call_queue', label: 'Sales', flowId: queue.id },
      { kind: 'call_queue', label: 'Sales', flowId: queue.id },
      { kind: 'person', label: 'pat@contoso.test' },
    ]);

    // and it reads back into the preview as it was made
    const back = fromCaptures(
      { kind: 'auto_attendant', capture: { flowId: attendant.id, name: attendant.name, answers: aa } },
      [{ flowId: queue.id, name: queue.name, answers: queue.wizard_answers as CallQueueWizardAnswers }],
    );
    expect(back.ok).toBe(true);
    if (back.ok) expect(back.flow.business.then.kind === 'menu' && back.flow.business.then.options[0]!.then).toMatchObject({ kind: 'group', id: queue.id, people: sales.people });
  });

  it('sends the number straight to the group when asked', async () => {
    const [n] = await seedNumbers(c.s, 'CFP01', ['+442070000302']);
    const flow: VisualCallFlow = { name: 'Help desk', languageId: 'en-GB', timeZoneId: 'GMT Standard Time', hours: { type: 'always' }, business: { then: { ...sales, id: 'hd', name: 'Help desk' } } };
    const res = await svc.saveVisualCallFlow(c.t, engineer, { site_id: site, phone_number_id: n!.id, flow, straight_to_queue: true }, true);
    const row = await c.s.selectFrom('discovery_flows').selectAll().where('id', '=', res.flowId).executeTakeFirstOrThrow();
    expect([row.kind, row.name, row.editor]).toEqual(['call_queue', 'Help desk', 'call-flows']);
    const ra = await c.s.selectFrom('discovery_resource_accounts').select(['id', 'kind']).where('voice_app_id', '=', res.voiceAppId).executeTakeFirstOrThrow();
    expect([ra.kind, row.resource_account_id]).toEqual(['call_queue', ra.id]);
    expect(await c.s.selectFrom('discovery_flows').select('id').where('kind', '=', 'auto_attendant').where('name', '=', 'Help desk').execute()).toEqual([]);
  });

  it('refuses a number already answering a call flow, naming it, and writes nothing', async () => {
    const [n] = await seedNumbers(c.s, 'CFP01', ['+442070000303']);
    await svc.addVoiceApp(c.t, engineer, { site_id: site, name: 'Reception', kind: 'auto_attendant', phone_number_id: n!.id } as never, true);
    const before = await counts();
    await expect(svc.saveVisualCallFlow(c.t, engineer, { site_id: site, phone_number_id: n!.id, flow: menuFlow }, true)).rejects.toThrow(/already answers "Reception"/);
    expect(await counts()).toEqual(before);
  });

  it('says what is missing, and writes nothing', async () => {
    const [n] = await seedNumbers(c.s, 'CFP01', ['+442070000304']);
    const before = await counts();
    const noPeople: VisualCallFlow = { ...menuFlow, business: { then: { kind: 'menu', options: [{ key: '1', label: 'Sales', then: { ...sales, people: [] } }] } } };
    await expect(svc.saveVisualCallFlow(c.t, engineer, { site_id: site, phone_number_id: n!.id, flow: noPeople }, true)).rejects.toThrow('add at least one person to the group "Sales"');
    await expect(svc.saveVisualCallFlow(c.t, engineer, { site_id: site, phone_number_id: n!.id, flow: menuFlow, straight_to_queue: true }, true)).rejects.toThrow(/straight to the group/);
    expect(await counts()).toEqual(before);
    const num = await c.s.selectFrom('phone_numbers').select('holder_id').where('id', '=', n!.id).executeTakeFirstOrThrow();
    expect(num.holder_id).toBeNull();
  });

  it('is for engineers only while it is a preview', async () => {
    const [n] = await seedNumbers(c.s, 'CFP01', ['+442070000305']);
    await expect(svc.saveVisualCallFlow(c.t, customer, { site_id: site, phone_number_id: n!.id, flow: menuFlow }, false)).rejects.toThrow(/for engineers/);
  });

  it('leaves nothing behind when the number cannot be taken', async () => {
    const [n] = await seedNumbers(c.s, 'CFP01', ['+442070000306']);
    await c.s.updateTable('phone_numbers').set({ status: 'reserved' } as never).where('id', '=', n!.id).execute();
    const before = await counts();
    await expect(svc.saveVisualCallFlow(c.t, engineer, { site_id: site, phone_number_id: n!.id, flow: menuFlow }, true)).rejects.toThrow(/reserved/);
    expect(await counts()).toEqual(before);
  });
});
