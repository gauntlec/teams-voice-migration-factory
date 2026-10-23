import { describe, expect, it } from 'vitest';
import { autoAttendantFields, callQueueFields } from './voice-app-summary';

const hours = { monday: [{ start: '09:00', end: '17:00' }], tuesday: [{ start: '09:00', end: '17:00' }], wednesday: [{ start: '09:00', end: '17:00' }], thursday: [{ start: '09:00', end: '17:00' }], friday: [{ start: '09:00', end: '17:00' }], saturday: [], sunday: [] };

describe('what a discovered voice app says in Data Collection', () => {
  it('describes an auto attendant: hours, who answers, out of hours, holidays and settings', () => {
    const f = autoAttendantFields(
      {
        languageId: 'en-GB',
        timeZoneId: 'GMT Standard Time',
        enableVoiceResponse: true,
        operator: { kind: 'user', upn: 'op@contoso.test' },
        schedule: { type: 'WeeklyRecurrentSchedule', weekly: { ...hours, complement: true } } as never,
        defaultCallFlow: { greetings: [{ type: 'Text', text: 'Hello' }], menu: { enableDialByName: true, options: [{ dtmf: 'Tone1', action: 'TransferCallToTarget', target: { kind: 'call_queue', buildId: 'cq1' } }, { dtmf: 'Tone0', action: 'TransferCallToOperator' }] } },
        afterHoursCallFlow: { greetings: [], menu: { options: [{ dtmf: 'Automatic', action: 'DisconnectCall' }] } },
        holidayCallFlows: [{ name: 'Christmas', schedule: { type: 'FixedSchedule', fixed: { ranges: [{ start: '2026-12-25T00:00:00', end: '2026-12-26T00:00:00' }] } } as never, callFlow: { greetings: [], menu: { options: [] } } }],
      },
      (id) => (id === 'cq1' ? 'Sales' : undefined),
    );
    expect(f.business_hours).toBe('Mon–Fri 09:00–17:00');
    expect(f.who_answers).toContain('press 1: transfer to call queue Sales');
    expect(f.who_answers).toContain('press 0: transfer to the operator (op@contoso.test)');
    expect(f.who_answers).toContain('Greeting: "Hello"');
    expect(f.ooh_action).toContain('no key pressed: end the call');
    expect(f.holiday).toContain('Christmas (2026-12-25 to 2026-12-26)');
    expect(f.advanced_features).toBe('Language en-GB; Time zone GMT Standard Time; Voice response on');
  });

  it('leaves a field empty when Teams holds nothing for it', () => {
    const f = autoAttendantFields({ operator: null, defaultCallFlow: null, afterHoursCallFlow: null, holidayCallFlows: [], schedule: null });
    expect(f).toEqual({ business_hours: null, who_answers: null, ooh_action: null, exception_conditions: null, exception_action: null, holiday: null, advanced_features: null });
  });

  it('describes a call queue: agents, routing and what happens when calls overflow or time out', () => {
    const f = callQueueFields({ Agents: [{ ObjectId: 'a1' }], RoutingMethod: 'LongestIdle', OverflowAction: 'Disconnect', OverflowThreshold: 10, TimeoutAction: 'Voicemail', TimeoutThreshold: 60, TimeoutActionTarget: { Id: 'u1' }, AgentAlertTime: 20 }, (id) => (id === 'a1' ? 'one@x.test' : id === 'u1' ? 'boss@x.test' : undefined));
    expect(f.who_answers).toBe('Agents: one@x.test. Routing: LongestIdle');
    expect(f.exception_conditions).toBe('More than 10 calls waiting\nA call waits more than 60 seconds');
    expect(f.exception_action).toBe('Overflow: disconnect the call\nTimeout: send to voicemail (boss@x.test)');
    expect(f.advanced_features).toBe('Agent alert time 20 seconds');
  });
});
