// Call Flows (preview), docs/CALL-FLOWS-WIZARD.md step 2: a flow made in the preview is saved as the classic wizards save one - the
// number on a resource account answering an auto attendant, a call queue capture per group linked by flowId - marked editor
// 'call-flows'. A number already answering a flow, a customer, or a flow with something missing leaves nothing behind.
import { beforeAll, describe, expect, it } from 'vitest';
import { attendantFlowIds, fromCaptures, newVisualGroup, visualFlowFromRows, type AutoAttendantWizardAnswers, type CallQueueWizardAnswers, type VisualCallFlow } from '@tvmf/shared';
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

describe('Call Flows (preview): reopening and changing a saved flow (step 4)', () => {
  const siteRows = () => c.s.selectFrom('discovery_flows').select(['id', 'kind', 'name', 'wizard_answers', 'editor', 'resource_account_id', 'voice_app_id']).where('site_id', '=', site).execute();
  const reopen = async (id: string) => {
    const rows = await siteRows();
    const r = visualFlowFromRows(rows.find((x) => x.id === id)!, rows, { timeZoneId: 'GMT Standard Time' });
    if (!r.ok) throw new Error(r.reasons.join(' '));
    return r as Extract<typeof r, { ok: true }>;
  };

  it('reads a saved flow back, from its auto attendant or from one of its groups, and saves changes in place', async () => {
    const [n] = await seedNumbers(c.s, 'CFP01', ['+442070000401']);
    const made = await svc.saveVisualCallFlow(c.t, engineer, { site_id: site, phone_number_id: n!.id, flow: menuFlow }, true);
    const opened = await reopen(made.flowId);
    expect(opened.top.id).toBe(made.flowId);
    expect(opened.straightToQueue).toBe(false);
    const menu = opened.flow.business.then;
    if (menu.kind !== 'menu' || menu.options[0]!.then.kind !== 'group') throw new Error('expected a menu with a group');
    const salesId = menu.options[0]!.then.id;
    // a group's own row opens its auto attendant
    expect((await reopen(salesId)).top.id).toBe(made.flowId);

    // rename the flow and the group, add a new group, drop the person
    const support = { ...newVisualGroup('local-new', 'Support', 'en-GB'), people: ['pat@contoso.test'] };
    const changed: VisualCallFlow = {
      ...opened.flow,
      name: 'Main Line (new)',
      business: { ...opened.flow.business, then: { ...menu, options: [{ ...menu.options[0]!, then: { ...menu.options[0]!.then, name: 'Sales team' } }, { key: '2', label: 'Support', then: support }] } },
    };
    const res = await svc.updateVisualCallFlow(c.t, engineer, made.flowId, { flow: changed }, true);
    expect(res.queues).toBe(2);

    const rows = await siteRows();
    const attendant = rows.find((r) => r.id === made.flowId)!;
    expect(attendant.name).toBe('Main Line (new)');
    expect(rows.find((r) => r.id === salesId)!.name).toBe('Sales team');
    const newQueue = rows.find((r) => r.name === 'Support' && r.kind === 'call_queue')!;
    expect(newQueue.editor).toBe('call-flows');
    expect(attendantFlowIds(attendant.wizard_answers as AutoAttendantWizardAnswers).sort()).toEqual([salesId, newQueue.id].sort());
    const app = await c.s.selectFrom('discovery_voice_apps').select('name').where('id', '=', attendant.voice_app_id!).executeTakeFirstOrThrow();
    expect(app.name).toBe('Main Line (new)');
    // the number is still on the same resource account
    const num = await c.s.selectFrom('phone_numbers').select('holder_id').where('id', '=', n!.id).executeTakeFirstOrThrow();
    expect(num.holder_id).toBe(attendant.resource_account_id);

    // take Support out again: its capture and voice app go
    const back = await reopen(made.flowId);
    const m2 = back.flow.business.then;
    if (m2.kind !== 'menu') throw new Error('menu');
    await svc.updateVisualCallFlow(c.t, engineer, made.flowId, { flow: { ...back.flow, business: { ...back.flow.business, then: { ...m2, options: [m2.options[0]!] } } } }, true);
    expect((await siteRows()).some((r) => r.id === newQueue.id)).toBe(false);
    expect(await c.s.selectFrom('discovery_voice_apps').select('id').where('id', '=', newQueue.voice_app_id!).execute()).toEqual([]);
  });

  it('changes a straight-to-group flow, but not whether it goes straight', async () => {
    const [n] = await seedNumbers(c.s, 'CFP01', ['+442070000402']);
    const flow: VisualCallFlow = { name: 'Help desk', languageId: 'en-GB', timeZoneId: 'GMT Standard Time', hours: { type: 'always' }, business: { then: { ...sales, id: 'hd2', name: 'Help desk' } } };
    const made = await svc.saveVisualCallFlow(c.t, engineer, { site_id: site, phone_number_id: n!.id, flow, straight_to_queue: true }, true);
    const opened = await reopen(made.flowId);
    expect(opened.straightToQueue).toBe(true);
    const g = opened.flow.business.then;
    if (g.kind !== 'group') throw new Error('group');
    await svc.updateVisualCallFlow(c.t, engineer, made.flowId, { flow: { ...opened.flow, business: { then: { ...g, name: 'IT help desk', people: ['sam@contoso.test'] } } }, straight_to_queue: true }, true);
    const row = (await siteRows()).find((r) => r.id === made.flowId)!;
    expect([row.name, (row.wizard_answers as CallQueueWizardAnswers).agents]).toEqual(['IT help desk', ['sam@contoso.test']]);
    await expect(svc.updateVisualCallFlow(c.t, engineer, made.flowId, { flow: opened.flow }, true)).rejects.toThrow(/straight to its group/);
  });

  it('only changes the preview’s own flows, and only for engineers', async () => {
    const classic = await new DataCollectionService(handle.db, new AuditService(handle.db)).addFlow(c.t, engineer, { site_id: site, kind: 'auto_attendant', name: 'Classic', wizard_answers: undefined } as never, true);
    await expect(svc.updateVisualCallFlow(c.t, engineer, classic.id, { flow: menuFlow }, true)).rejects.toThrow(/classic wizard/);
    await expect(svc.updateVisualCallFlow(c.t, customer, classic.id, { flow: menuFlow }, false)).rejects.toThrow(/for engineers/);
  });
});

describe('Call Flows (preview): holidays (step 5)', () => {
  it('saves holidays as the classic wizard does, with a group of their own, and changes them in place', async () => {
    const [n] = await seedNumbers(c.s, 'CFP01', ['+442070000501']);
    const onCall = { ...newVisualGroup('local-oncall', 'On call', 'en-GB'), people: ['oncall@contoso.test'] };
    const flow: VisualCallFlow = {
      ...menuFlow,
      name: 'Holiday line',
      holidays: [
        { name: 'Christmas', start: '2026-12-25', end: '2026-12-26', path: { greeting: 'We are closed.', then: { kind: 'hangup' } } },
        { name: 'Stocktake', start: '2026-12-30', end: '2026-12-30', path: { then: onCall } },
      ],
    };
    const made = await svc.saveVisualCallFlow(c.t, engineer, { site_id: site, phone_number_id: n!.id, flow }, true);
    expect(made.queues).toBe(2);
    const rows = await c.s.selectFrom('discovery_flows').select(['id', 'kind', 'name', 'wizard_answers', 'editor', 'resource_account_id']).where('site_id', '=', site).execute();
    const aa = rows.find((r) => r.id === made.flowId)!.wizard_answers as AutoAttendantWizardAnswers;
    expect(aa.holidaysEnabled).toBe(true);
    const onCallRow = rows.find((r) => r.name === 'On call' && r.kind === 'call_queue')!;
    expect(aa.holidays!.map((h) => [h.name, h.dateRange.start, h.dateRange.end, h.flow.mode, h.flow.target?.flowId ?? null])).toEqual([
      ['Christmas', '2026-12-25', '2026-12-26', 'disconnect', null],
      ['Stocktake', '2026-12-30', '2026-12-30', 'direct', onCallRow.id],
    ]);

    // reopened: the holidays come back, and the holiday's group is the saved one
    const back = visualFlowFromRows(rows.find((r) => r.id === made.flowId)!, rows, { timeZoneId: 'GMT Standard Time' });
    if (!back.ok) throw new Error(back.reasons.join(' '));
    expect(back.flow.holidays!.map((h) => h.name)).toEqual(['Christmas', 'Stocktake']);
    expect(back.flow.holidays![1]!.path.then).toMatchObject({ kind: 'group', id: onCallRow.id });

    // drop Stocktake: its group goes too
    await svc.updateVisualCallFlow(c.t, engineer, made.flowId, { flow: { ...back.flow, holidays: [back.flow.holidays![0]!] } }, true);
    const after = await c.s.selectFrom('discovery_flows').select(['id', 'wizard_answers']).where('site_id', '=', site).execute();
    expect(after.some((r) => r.id === onCallRow.id)).toBe(false);
    expect((after.find((r) => r.id === made.flowId)!.wizard_answers as AutoAttendantWizardAnswers).holidays!.map((h) => h.name)).toEqual(['Christmas']);
  });
});
