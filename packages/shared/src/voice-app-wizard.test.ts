import { describe, expect, it } from 'vitest';
import { autoAttendantToWizard, callQueueToWizard } from './voice-app-wizard';
import { autoAttendantWizardAnswersSchema, callQueueWizardAnswersSchema } from './wizard';

const weekdays = { monday: [{ start: '09:00', end: '17:00' }], tuesday: [{ start: '09:00', end: '17:00' }], wednesday: [{ start: '09:00', end: '17:00' }], thursday: [{ start: '09:00', end: '17:00' }], friday: [{ start: '09:00', end: '17:00' }], saturday: [], sunday: [] };
const ctx = { personOf: (id: string) => (id === 'u1' ? 'jo@x.test' : undefined), appOf: (id: string) => (id === 'cq1' ? { name: 'Sales', flowId: '3f0c1a52-8d3e-4c55-9b1a-0a4a1b2c3d4e' } : undefined) };

describe('a discovered auto attendant as wizard answers', () => {
  it('turns menus, hours, operator and holidays into answers the wizard accepts', () => {
    const { answers, notes } = autoAttendantToWizard(
      {
        languageId: 'en-GB',
        timeZoneId: 'GMT Standard Time',
        operator: { kind: 'user', upn: 'op@x.test' },
        schedule: { type: 'weekly', weekly: { ...weekdays, complement: true } } as never,
        defaultCallFlow: { greetings: [{ type: 'Text', text: 'Hello' }], menu: { enableDialByName: true, options: [{ dtmf: 'Tone1', action: 'TransferCallToTarget', target: { kind: 'call_queue', buildId: 'cq1' } }, { dtmf: 'Tone2', action: 'TransferCallToTarget', target: { kind: 'external', number: 'tel:+442071234567' } }, { dtmf: 'Tone0', action: 'TransferCallToOperator' }] } },
        afterHoursCallFlow: { greetings: [], menu: { options: [{ dtmf: 'Automatic', action: 'TransferCallToTarget', target: { kind: 'shared_voicemail', groupId: 'g1' } }] } },
        holidayCallFlows: [{ name: 'Christmas', schedule: { type: 'fixed', fixed: { ranges: [{ start: '2026-12-25T00:00:00', end: '2026-12-27T00:00:00' }] } } as never, callFlow: { greetings: [], menu: { options: [{ dtmf: 'Automatic', action: 'DisconnectCall' }] } } }],
      },
      ctx,
    );
    expect(answers).not.toBeNull();
    expect(autoAttendantWizardAnswersSchema.safeParse(answers).success).toBe(true);
    expect(answers!.hoursType).toBe('custom');
    expect(answers!.customHours!.monday).toEqual([{ start: '09:00', end: '17:00' }]);
    expect(answers!.businessFlow).toMatchObject({ mode: 'menu', greeting: 'Hello', allowDialByName: true });
    expect(answers!.businessFlow.options).toEqual([
      { key: '1', label: 'Sales', target: { kind: 'call_queue', label: 'Sales', flowId: '3f0c1a52-8d3e-4c55-9b1a-0a4a1b2c3d4e' } },
      { key: '2', label: '+442071234567', target: { kind: 'external', label: '+442071234567' } },
      { key: '0', label: 'Operator', target: { kind: 'operator' } },
    ]);
    expect(answers!.afterHoursFlow).toEqual({ mode: 'voicemail' });
    expect(answers!.operator).toEqual({ kind: 'person', label: 'op@x.test' });
    // the stored end is exclusive; the wizard's dates are whole days, both included
    expect(answers!.holidays![0]!.dateRange).toEqual({ start: '2026-12-25', end: '2026-12-26' });
    expect(notes).toContain('Holiday "Christmas": the call is ended after the greeting.');
  });

  it('shows an attendant with no after-hours flow as open all the time, and reads a single catch-all as a direct transfer', () => {
    const { answers } = autoAttendantToWizard(
      { operator: null, schedule: null, afterHoursCallFlow: null, holidayCallFlows: [], defaultCallFlow: { greetings: [], menu: { options: [{ dtmf: 'Automatic', action: 'TransferCallToTarget', target: { kind: 'user', upn: 'jo@x.test' } }] } } },
      ctx,
    );
    expect(answers).toMatchObject({ hoursType: 'always', holidaysEnabled: false, businessFlow: { mode: 'direct', target: { kind: 'person', label: 'jo@x.test' } } });
    expect(answers!.afterHoursFlow).toBeUndefined();
  });

  it('says so when there is no call flow to read', () => {
    const r = autoAttendantToWizard({ operator: null, schedule: null, afterHoursCallFlow: null, holidayCallFlows: [], defaultCallFlow: null });
    expect(r.answers).toBeNull();
    expect(r.notes[0]).toMatch(/no call flow/i);
  });
});

describe('a discovered call queue as wizard answers', () => {
  it('carries agents, routing and the three exception actions, and leaves out an agent it cannot name', () => {
    const { answers, notes } = callQueueToWizard(
      { LanguageId: 'en-GB', RoutingMethod: 'LongestIdle', PresenceBasedRouting: false, AgentAlertTime: 20, Agents: [{ ObjectId: 'u1' }, { ObjectId: 'unknown' }], OverflowAction: 'Forward', OverflowThreshold: 15, OverflowActionTarget: { Id: 'tel:+442079999999' }, TimeoutAction: 'Voicemail', TimeoutThreshold: 120, TimeoutActionTarget: { Id: 'u1' }, NoAgentAction: 'Queue', NoAgentApplyTo: 'NewCalls' },
      ctx,
    );
    expect(callQueueWizardAnswersSchema.safeParse(answers).success).toBe(true);
    expect(answers).toMatchObject({
      languageId: 'en-GB',
      agents: ['jo@x.test'],
      routingMethod: 'LongestIdle',
      presenceBasedRouting: false,
      agentAlertTime: 20,
      overflowThreshold: 15,
      overflow: { action: 'Forward', forwardTo: '+442079999999' },
      timeoutThreshold: 120,
      timeout: { action: 'Voicemail', forwardTo: 'jo@x.test' },
      noAgents: { action: 'Queue' },
      noAgentsApplyTo: 'NewCalls',
    });
    expect(notes[0]).toContain('unknown');
  });

  it('falls back to safe defaults for a queue with little set', () => {
    const { answers } = callQueueToWizard({}, {});
    expect(answers).toMatchObject({ routingMethod: 'Attendant', agentAlertTime: 30, overflow: { action: 'DisconnectWithBusy' }, timeout: { action: 'Disconnect' } });
  });
});
