// "Copy to Site Data" (bug report "Site Data Sync Back for Auto Attendants and Call Queues"): a Design & Build auto attendant or
// call queue read back as the Call flows wizard's answers. Wizard -> Design & Build -> wizard must give back what was captured.
import { describe, expect, it } from 'vitest';
import { buildAutoAttendantToWizard, buildCallQueueToWizard } from './voice-app-wizard';
import { convertAutoAttendantWizard, convertCallQueueWizard } from './wizard-convert';
import type { AutoAttendantWizardAnswers, CallQueueWizardAnswers } from './wizard';

const SALES = '33333333-3333-4333-8333-333333333333';
const resolvers = {
  resolvePerson: (l: string) => (l.includes('@') ? l : undefined),
  resolveTeam: () => undefined,
  resolveFlow: (id: string) => (id === 'f1111111-1111-4111-8111-111111111111' ? { kind: 'call_queue' as const, buildId: SALES } : undefined),
};

describe('Design & Build auto attendant as wizard answers', () => {
  const aa: AutoAttendantWizardAnswers = {
    languageId: 'en-GB',
    timeZoneId: 'GMT Standard Time',
    hoursType: 'custom',
    customHours: { monday: [{ start: '08:00', end: '18:00' }], tuesday: [], wednesday: [], thursday: [], friday: [], saturday: [], sunday: [] },
    businessFlow: {
      mode: 'menu',
      greeting: 'Welcome to Contoso',
      options: [
        { key: '1', label: 'Sales', target: { kind: 'call_queue', label: 'Sales', flowId: 'f1111111-1111-4111-8111-111111111111' } },
        { key: '2', label: 'jo@contoso.test', target: { kind: 'person', label: 'jo@contoso.test' } },
      ],
    },
    afterHoursFlow: { mode: 'voicemail', greeting: 'We are closed' },
    holidaysEnabled: false,
  };

  it('gives back the captured answers, naming the queue it transfers to', () => {
    const { value } = convertAutoAttendantWizard(aa, { siteId: 's', name: 'Main', resolvers });
    const back = buildAutoAttendantToWizard(value, { appOf: (id) => (id === SALES ? { name: 'Sales', flowId: 'f1111111-1111-4111-8111-111111111111' } : undefined) });
    expect(back.answers).toMatchObject({
      languageId: 'en-GB',
      timeZoneId: 'GMT Standard Time',
      hoursType: 'custom',
      customHours: { monday: [{ start: '08:00', end: '18:00' }] },
      businessFlow: { mode: 'menu', greeting: 'Welcome to Contoso', options: [{ key: '1', target: { kind: 'call_queue', label: 'Sales' } }, { key: '2', target: { kind: 'person', label: 'jo@contoso.test' } }] },
      afterHoursFlow: { mode: 'voicemail', greeting: 'We are closed' },
    });
  });

  it('says so when there is no call flow yet', () => {
    expect(buildAutoAttendantToWizard({}).answers).toBeNull();
  });
});

describe('Design & Build call queue as wizard answers', () => {
  const cq: CallQueueWizardAnswers = {
    languageId: 'en-GB',
    agents: ['ann@contoso.test', 'bob@contoso.test'],
    routingMethod: 'LongestIdle',
    presenceBasedRouting: false,
    agentAlertTime: 25,
    overflowThreshold: 12,
    overflow: { action: 'DisconnectWithBusy', message: 'We are busy' },
    timeoutThreshold: 300,
    timeout: { action: 'Forward', forwardTo: '+442070000000' },
    noAgents: { action: 'Voicemail', forwardTo: 'ann@contoso.test' },
    noAgentsApplyTo: 'NewCalls',
  };

  it('gives back the captured answers', () => {
    const { value } = convertCallQueueWizard(cq, { siteId: 's', name: 'Sales', resolvers });
    expect(buildCallQueueToWizard(value as never).answers).toEqual(cq);
  });

  it('notes what the wizard cannot show, and falls back for a bare row', () => {
    const { answers, notes } = buildCallQueueToWizard({ overflow: { action: 'Forward', target: 'ann@contoso.test', redirectPrompt: 'One moment', redirectAudio: { fileId: 'x', filename: 'a.wav' } } });
    expect(answers).toMatchObject({ overflow: { action: 'Forward', forwardTo: 'ann@contoso.test' }, timeout: { action: 'Disconnect' }, noAgents: { action: 'Queue' } });
    expect(notes).toHaveLength(2);
  });
});
