import { describe, expect, it } from 'vitest';
import { fromCaptures, newVisualGroup, onlyRingsAGroup, toCaptures, type VisualCallFlow } from './call-flows-visual';
import { autoAttendantWizardAnswersSchema, callQueueWizardAnswersSchema, type AutoAttendantWizardAnswers, type CallQueueWizardAnswers } from './wizard';
import { convertAutoAttendantWizard, convertCallQueueWizard } from './wizard-convert';

const SALES = '11111111-1111-4111-8111-111111111111';
const SUPPORT = '22222222-2222-4222-8222-222222222222';
const OTHER = '33333333-3333-4333-8333-333333333333';
const MAIN = '44444444-4444-4444-8444-444444444444';

const sales = { ...newVisualGroup(SALES, 'Sales', 'en-GB'), people: ['jo@contoso.test', 'sam@contoso.test'], ifNoAnswer: { kind: 'shared_voicemail' as const, group: 'Sales voicemail' } };
const support = { ...newVisualGroup(SUPPORT, 'Support', 'en-GB'), people: ['pat@contoso.test'], ringing: 'longest_idle' as const, ifNoAnswer: { kind: 'forward' as const, to: '+442070000999' } };

const flow: VisualCallFlow = {
  name: 'Main number',
  languageId: 'en-GB',
  timeZoneId: 'GMT Standard Time',
  voiceInputs: true,
  hours: { type: 'standard' },
  business: {
    greeting: 'Thank you for calling Contoso.',
    then: {
      kind: 'menu',
      prompt: 'For sales press 1, for support press 2.',
      options: [
        { key: '1', label: 'Sales', say: 'sales', then: sales },
        { key: '2', label: 'Support', then: support },
        { key: '3', label: 'Opening times', then: { kind: 'announcement', text: 'We are open nine to five.' } },
        { key: '4', label: 'Head office', then: { kind: 'link', flowId: OTHER, name: 'Head office menu' } },
        { key: '0', label: 'Operator', then: { kind: 'operator' } },
      ],
    },
  },
  afterHours: { greeting: 'We are closed.', then: { kind: 'shared_voicemail', group: 'Main voicemail' } },
};

describe('Call Flows (preview): visual flow to captures', () => {
  it('saves an auto attendant and one call queue per group, linked by flowId, in answers the classic wizards accept', () => {
    const c = toCaptures(flow, { attendantFlowId: MAIN });
    expect(c.top.kind).toBe('auto_attendant');
    const aa = c.top.capture.answers as AutoAttendantWizardAnswers;
    expect(autoAttendantWizardAnswersSchema.safeParse(aa).success).toBe(true);
    for (const q of c.queues) expect(callQueueWizardAnswersSchema.safeParse(q.answers).success).toBe(true);

    expect(c.queues.map((q) => [q.flowId, q.name, q.answers.routingMethod, q.answers.agents])).toEqual([
      [SALES, 'Sales', 'Attendant', ['jo@contoso.test', 'sam@contoso.test']],
      [SUPPORT, 'Support', 'LongestIdle', ['pat@contoso.test']],
    ]);
    expect(c.queues[0]!.answers.timeout).toEqual({ action: 'SharedVoicemail', forwardTo: 'Sales voicemail' });
    expect(c.queues[1]!.answers.timeout).toEqual({ action: 'Forward', forwardTo: '+442070000999' });
    expect(aa.businessFlow.options!.map((o) => o.target)).toEqual([
      { kind: 'call_queue', label: 'Sales', flowId: SALES },
      { kind: 'call_queue', label: 'Support', flowId: SUPPORT },
      { kind: 'message', label: 'We are open nine to five.' },
      { kind: 'team', label: 'Head office menu', flowId: OTHER },
      { kind: 'operator' },
    ]);
    expect(aa.businessFlow.options![0]!.voiceCommand).toBe('sales');
    expect(aa.afterHoursFlow).toEqual({ mode: 'direct', greeting: 'We are closed.', target: { kind: 'voicemail', label: 'Main voicemail' } });
  });

  it('goes through the classic import unchanged: the menu links to the queues once they are in Design & Build', () => {
    const c = toCaptures(flow, { attendantFlowId: MAIN });
    const rows: Record<string, string> = { [SALES]: 'row-sales', [SUPPORT]: 'row-support', [OTHER]: 'row-other' };
    const resolvers = {
      resolvePerson: (l: string) => (l.includes('@') ? l : undefined),
      resolveTeam: () => undefined,
      resolveFlow: (id: string) => (rows[id] ? { kind: (id === OTHER ? 'auto_attendant' : 'call_queue') as 'auto_attendant' | 'call_queue', buildId: rows[id]! } : undefined),
    };
    const { value } = convertAutoAttendantWizard(c.top.capture.answers as AutoAttendantWizardAnswers, { siteId: 's', name: 'Main number', resolvers });
    expect(value.default_call_flow!.menu.options.map((o) => [o.dtmf, o.action, o.target && 'buildId' in o.target ? o.target.buildId : undefined])).toEqual([
      ['Tone1', 'TransferCallToTarget', 'row-sales'],
      ['Tone2', 'TransferCallToTarget', 'row-support'],
      ['Tone3', 'Announcement', undefined],
      ['Tone4', 'TransferCallToTarget', 'row-other'],
      ['Tone0', 'TransferCallToOperator', undefined],
    ]);
    const q = convertCallQueueWizard(c.queues[0]!.answers, { siteId: 's', name: 'Sales', resolvers });
    expect(q.value.agents).toEqual(['jo@contoso.test', 'sam@contoso.test']);
  });

  it('sends a number that only rings a group straight to its call queue, unless an auto attendant is wanted in front', () => {
    const simple: VisualCallFlow = { name: 'Sales line', languageId: 'en-GB', timeZoneId: 'GMT Standard Time', hours: { type: 'always' }, business: { then: sales } };
    expect(onlyRingsAGroup(simple)).toBe(sales);
    const direct = toCaptures(simple, { attendantFlowId: MAIN });
    expect(direct.top).toMatchObject({ kind: 'call_queue', capture: { flowId: SALES, name: 'Sales' } });
    expect(direct.queues).toEqual([]);

    const fronted = toCaptures(simple, { attendantFlowId: MAIN, attendantInFront: true });
    expect(fronted.top.kind).toBe('auto_attendant');
    expect((fronted.top.capture.answers as AutoAttendantWizardAnswers).businessFlow).toEqual({ mode: 'direct', target: { kind: 'call_queue', label: 'Sales', flowId: SALES } });
    expect(fronted.queues.map((q) => q.flowId)).toEqual([SALES]);
    // a greeting or business hours need an auto attendant
    expect(onlyRingsAGroup({ ...simple, business: { greeting: 'Hello', then: sales } })).toBeNull();
    expect(onlyRingsAGroup({ ...simple, hours: { type: 'standard' } })).toBeNull();
  });

  it('saves a group reached from two places once', () => {
    const twice: VisualCallFlow = { ...flow, afterHours: { then: sales } };
    expect(toCaptures(twice, { attendantFlowId: MAIN }).queues.map((q) => q.flowId)).toEqual([SALES, SUPPORT]);
  });
});

describe('Call Flows (preview): captures back to the visual flow', () => {
  it('reads what it saved back exactly', () => {
    const c = toCaptures(flow, { attendantFlowId: MAIN });
    const back = fromCaptures(c.top, c.queues);
    expect(back).toEqual({ ok: true, attendantFlowId: MAIN, flow });

    const simple: VisualCallFlow = { name: 'Sales', languageId: 'en-GB', timeZoneId: 'GMT Standard Time', hours: { type: 'always' }, business: { then: sales } };
    const q = toCaptures(simple, { attendantFlowId: MAIN });
    expect(fromCaptures(q.top, q.queues, { timeZoneId: 'GMT Standard Time' })).toEqual({ ok: true, attendantFlowId: null, flow: simple });
  });

  it('reads a classic capture and saves it back the same', () => {
    const classic: AutoAttendantWizardAnswers = {
      languageId: 'en-US',
      timeZoneId: 'Eastern Standard Time',
      hoursType: 'custom',
      customHours: { monday: [{ start: '08:00', end: '17:00' }], tuesday: [{ start: '08:00', end: '17:00' }], wednesday: [], thursday: [], friday: [], saturday: [], sunday: [] },
      businessFlow: { mode: 'menu', greeting: 'Welcome', options: [{ key: '1', label: 'Sales', target: { kind: 'call_queue', label: 'Sales', flowId: SALES } }, { key: '2', label: 'Jo', target: { kind: 'person', label: 'jo@contoso.test' } }] },
      afterHoursFlow: { mode: 'disconnect', greeting: 'We are closed.' },
      holidaysEnabled: false,
    };
    const queue: CallQueueWizardAnswers = {
      languageId: 'en-US',
      agents: ['jo@contoso.test'],
      routingMethod: 'Serial',
      presenceBasedRouting: false,
      agentAlertTime: 20,
      overflowThreshold: 10,
      overflow: { action: 'DisconnectWithBusy' },
      timeoutThreshold: 120,
      timeout: { action: 'Voicemail', forwardTo: 'jo@contoso.test' },
      noAgents: { action: 'Queue' },
      noAgentsApplyTo: 'NewCalls',
    };
    const back = fromCaptures({ kind: 'auto_attendant', capture: { flowId: MAIN, name: 'Main', answers: classic } }, [{ flowId: SALES, name: 'Sales', answers: queue }]);
    expect(back.ok).toBe(true);
    if (!back.ok) return;
    const again = toCaptures(back.flow, { attendantFlowId: MAIN });
    expect(again.top.capture.answers).toEqual(classic);
    expect(again.queues).toEqual([{ flowId: SALES, name: 'Sales', answers: queue }]);
  });

  it('says why a classic capture can’t be shown, rather than losing part of it', () => {
    const withHolidays: AutoAttendantWizardAnswers = {
      languageId: 'en-GB',
      timeZoneId: 'GMT Standard Time',
      hoursType: 'always',
      businessFlow: { mode: 'direct', target: { kind: 'message', label: 'Hello' } },
      operator: { kind: 'person', label: 'jo@contoso.test' },
      holidaysEnabled: true,
      holidays: [{ name: 'Christmas', dateRange: { start: '2026-12-25', end: '2026-12-26' }, flow: { mode: 'disconnect' } }],
    };
    const r = fromCaptures({ kind: 'auto_attendant', capture: { flowId: MAIN, name: 'Main', answers: withHolidays } });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    // holidays are shown since step 5; an operator still isn't
    expect(r.reasons).toEqual([
      'It names an operator, which the preview doesn’t show yet.',
      'Business hours: plays a message, which only a menu option can do.',
    ]);
  });
});
