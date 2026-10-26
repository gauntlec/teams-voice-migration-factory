// Call queue settings Microsoft documents as PowerShell only: call priority and redirect prompts on overflow, time-out and no-agent.
import { describe, expect, it } from 'vitest';
import { callQueueActionExtras, liveCallQueueActionExtras, planCallQueueRow, type BuildCallQueueRow, type CallQueueLiveState } from './deployment';

const SUPPORT = '11111111-1111-4111-8111-111111111111';
const row: BuildCallQueueRow = {
  id: 'cq-1',
  name: 'Sales',
  routing_method: 'RoundRobin',
  agent_alert_time: 20,
  presence_based_routing: true,
  agents: [],
  overflow: { action: 'Forward', threshold: 10, target: SUPPORT, priority: 2, redirectPrompt: 'Transferring you to support' },
  timeout: { action: 'Voicemail', threshold: 120, target: 'ann@contoso.test', redirectPrompt: 'Please leave a message' },
  no_agent_action: null,
  no_agent_apply_to: null,
  language_id: null,
  resource_accounts: [],
};
const ann = new Map([['ann@contoso.test', '22222222-2222-4222-8222-222222222222']]);
const live: CallQueueLiveState = {
  identity: 'q',
  routingMethod: 'RoundRobin',
  agentAlertTime: 20,
  presenceBasedRouting: true,
  agentObjectIds: [],
  overflowAction: 'Forward',
  overflowThreshold: 10,
  overflowActionTarget: SUPPORT,
  overflowExtras: { priority: 2, redirectPrompt: 'Transferring you to support' },
  timeoutAction: 'Voicemail',
  timeoutThreshold: 120,
  timeoutActionTarget: '22222222-2222-4222-8222-222222222222',
  timeoutExtras: { redirectPrompt: 'Please leave a message' },
};

describe('call queue PowerShell-only extras', () => {
  it('sends priority only for a forward, and the prompt that matches the action', () => {
    expect(callQueueActionExtras('Overflow', row.overflow)).toEqual({ OverflowActionCallPriority: 2, OverflowRedirectPersonTextToSpeechPrompt: 'Transferring you to support' });
    expect(callQueueActionExtras('Timeout', row.timeout)).toEqual({ TimeoutRedirectVoicemailTextToSpeechPrompt: 'Please leave a message' });
    expect(callQueueActionExtras('NoAgent', { action: 'Disconnect', priority: 1, redirectPrompt: 'x' })).toEqual({});
  });

  it('reads them back from Get-CsCallQueue output for the live action', () => {
    expect(liveCallQueueActionExtras('Overflow', { OverflowActionCallPriority: 2, OverflowRedirectPersonTextToSpeechPrompt: 'Hi' }, 'Forward')).toEqual({ priority: 2, redirectPrompt: 'Hi' });
    expect(liveCallQueueActionExtras('Timeout', { TimeoutRedirectVoicemailTextToSpeechPrompt: 'Bye', TimeoutActionCallPriority: 3 }, 'Voicemail')).toEqual({ redirectPrompt: 'Bye' });
  });

  it('round-trips: a design that matches live plans nothing', () => {
    expect(planCallQueueRow(row, ann, new Map(), live)).toEqual([]);
  });

  it('plans Set-CsCallQueue with the extras when one differs', () => {
    const calls = planCallQueueRow({ ...row, overflow: { ...row.overflow!, priority: 1 } }, ann, new Map(), live);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.parameters).toMatchObject({ OverflowActionCallPriority: 1, TimeoutRedirectVoicemailTextToSpeechPrompt: 'Please leave a message' });
  });

  it('leaves an extra the design does not set to whatever Teams has', () => {
    const plain = { ...row, overflow: { action: 'Forward', threshold: 10, target: SUPPORT }, timeout: { action: 'Voicemail', threshold: 120, target: 'ann@contoso.test' } };
    expect(planCallQueueRow(plain, ann, new Map(), live)).toEqual([]);
  });
});
