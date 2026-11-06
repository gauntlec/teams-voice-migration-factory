import { describe, expect, it } from 'vitest';
import {
  autoAttendantSettingDifferences,
  formatDifference,
  planAutoAttendantRow,
  planCallQueueRow,
  planIdentityRow,
  planResourceAccountRow,
  planSharedCallingPolicyRow,
  type AutoAttendantCallFlow,
  type BuildAutoAttendantRow,
  type BuildCallQueueRow,
  type BuildIdentityRow,
  type CallQueueLiveState,
  type CmdletInvocation,
} from './deployment';

const differences = (calls: CmdletInvocation[], cmdlet: string) => calls.find((c) => c.cmdlet === cmdlet)?.differences;
const MESSAGE = 'We are unable to take your call.';

describe('what differs on a call queue', () => {
  const row = (over: Partial<BuildCallQueueRow> = {}): BuildCallQueueRow => ({
    id: 'q1',
    name: 'Sales',
    routing_method: 'RoundRobin',
    agent_alert_time: 20,
    presence_based_routing: true,
    agents: [],
    overflow: { action: 'DisconnectWithBusy', threshold: 2, redirectPrompt: MESSAGE },
    timeout: { action: 'Disconnect', threshold: 60, redirectPrompt: MESSAGE },
    no_agent_action: { action: 'Disconnect', redirectPrompt: MESSAGE },
    no_agent_apply_to: 'AllCalls',
    language_id: 'en-GB',
    resource_accounts: [],
    authorized_users: null,
    hide_authorized_users: null,
    voicemail_triage_template_id: null,
    ...over,
  });
  const live = (over: Partial<CallQueueLiveState> = {}): CallQueueLiveState => ({
    identity: 'cq-live',
    routingMethod: 'RoundRobin',
    agentAlertTime: 20,
    presenceBasedRouting: true,
    agentObjectIds: [],
    overflowAction: 'DisconnectWithBusy',
    overflowThreshold: 2,
    timeoutAction: 'Disconnect',
    timeoutThreshold: 60,
    noAgentAction: 'Disconnect',
    noAgentApplyTo: 'AllCalls',
    languageId: 'en-GB',
    overflowExtras: { redirectPrompt: MESSAGE },
    timeoutExtras: { redirectPrompt: MESSAGE },
    noAgentExtras: { redirectPrompt: MESSAGE },
    ...over,
  });
  const plan = (r: BuildCallQueueRow, l: CallQueueLiveState, agents = new Map<string, string>()) => planCallQueueRow(r, agents, new Map(), l);

  it('plans nothing and names nothing when they match', () => {
    expect(plan(row(), live())).toEqual([]);
  });

  it('names the one setting that differs, with both values (the Glasgow report)', () => {
    expect(differences(plan(row(), live({ noAgentApplyTo: 'NewCalls' })), 'Set-CsCallQueue')).toEqual([{ setting: 'No agents: applies to', design: 'AllCalls', teams: 'NewCalls' }]);
  });

  it('names every setting that plans the command', () => {
    const cases: [Partial<CallQueueLiveState>, string][] = [
      [{ routingMethod: 'Serial' }, 'Routing method'],
      [{ agentAlertTime: 30 }, 'Agent alert time'],
      [{ presenceBasedRouting: false }, 'Presence-based routing'],
      [{ overflowAction: 'Forward' }, 'Overflow: action'],
      [{ overflowThreshold: 5 }, 'Overflow: threshold'],
      [{ overflowActionTarget: 'someone' }, 'Overflow: target'],
      [{ timeoutAction: 'Forward' }, 'Timeout: action'],
      [{ timeoutThreshold: 90 }, 'Timeout: threshold'],
      [{ timeoutActionTarget: 'someone' }, 'Timeout: target'],
      [{ noAgentAction: 'Queue' }, 'No agents: action'],
      [{ noAgentActionTarget: 'someone' }, 'No agents: target'],
      [{ overflowExtras: {} }, 'Overflow: spoken message'],
      [{ timeoutExtras: { redirectPrompt: 'Other' } }, 'Timeout: spoken message'],
      [{ noAgentExtras: {} }, 'No agents: spoken message'],
      [{ languageId: 'de-DE' }, 'Language'],
    ];
    for (const [over, setting] of cases) {
      expect(differences(plan(row(), live(over)), 'Set-CsCallQueue')?.map((d) => d.setting)).toEqual([setting]);
    }
  });

  it('names agents by UPN, not object id', () => {
    const agents = new Map([['a@contoso.com', 'id-a'], ['b@contoso.com', 'id-b']]);
    expect(differences(plan(row({ agents: ['a@contoso.com'] }), live({ agentObjectIds: ['ID-B'] }), agents), 'Set-CsCallQueue')).toEqual([{ setting: 'Agents', design: 'a@contoso.com', teams: 'b@contoso.com' }]);
  });

  it('says why a resource account link is planned', () => {
    const calls = planCallQueueRow(row({ resource_accounts: ['ra'] }), new Map(), new Map([['ra', 'ra-live']]), live({ applicationInstanceIds: [] }));
    expect(differences(calls, 'New-CsOnlineApplicationInstanceAssociation')).toEqual([{ setting: 'Linked resource accounts', design: 'ra-live', teams: 'None' }]);
  });

  it('names nothing for a new queue, which has nothing to compare with', () => {
    expect(planCallQueueRow(row(), new Map(), new Map())[0]!.differences).toBeUndefined();
  });
});

describe('what differs on a user', () => {
  const user = (over: Partial<BuildIdentityRow> = {}) => ({ id: 'u1', upn: 'a@contoso.com', e164: '+441234', number_type: 'DirectRouting', policies: {}, ...over }) as BuildIdentityRow;
  const liveUser = (over = {}) => ({ enterpriseVoiceEnabled: true, lineUri: 'tel:+441234', policies: {}, ...over });

  it('names the number', () => {
    expect(differences(planIdentityRow(user(), 'user', liveUser({ lineUri: 'tel:+449999' })), 'Set-CsPhoneNumberAssignment')).toEqual([{ setting: 'Phone number', design: '+441234', teams: 'tel:+449999' }]);
  });

  it('names a policy by its label, and calls an empty one Global', () => {
    const r = user({ policies: { voice_routing_policy: 'UK' } as never });
    expect(differences(planIdentityRow(r, 'user', liveUser({ policies: { OnlineVoiceRoutingPolicy: 'US' } })), 'Grant-CsOnlineVoiceRoutingPolicy')).toEqual([{ setting: 'Voice Routing Policy', design: 'UK', teams: 'US' }]);
    expect(differences(planIdentityRow(r, 'user', liveUser()), 'Grant-CsOnlineVoiceRoutingPolicy')).toEqual([{ setting: 'Voice Routing Policy', design: 'UK', teams: 'Global (default)' }]);
  });

  it('separates voicemail on or off from its language, and says when Teams has not been read', () => {
    const on = user({ voicemail: { enabled: true, language: 'en-GB' } as never });
    expect(differences(planIdentityRow(on, 'user', liveUser({ voicemailEnabled: false })), 'Set-CsOnlineVoicemailUserSettings')).toEqual([{ setting: 'Voicemail', design: 'On', teams: 'Off' }]);
    expect(differences(planIdentityRow(on, 'user', liveUser({ voicemailEnabled: true, voicemailPromptLanguage: 'de-DE' })), 'Set-CsOnlineVoicemailUserSettings')).toEqual([{ setting: 'Voicemail language', design: 'en-GB', teams: 'de-DE' }]);
    expect(differences(planIdentityRow(on, 'user', liveUser()), 'Set-CsOnlineVoicemailUserSettings')).toEqual([{ setting: 'Voicemail', design: 'On', teams: 'Not read yet' }]);
  });
});

describe('what differs on a resource account and a shared calling policy', () => {
  it('names the number and policy of a resource account', () => {
    const calls = planResourceAccountRow(
      { id: 'r', upn: 'ra@contoso.com', display_name: null, kind: 'call_queue', location_id: null, phone_number: '+441', number_type: 'DirectRouting', voice_routing_policy: 'UK', application_id: 'app' },
      { enterpriseVoiceEnabled: true, lineUri: 'tel:+442', policies: { OnlineVoiceRoutingPolicy: 'US' } },
    );
    expect(calls.flatMap((c) => c.differences ?? [])).toEqual([
      { setting: 'Phone number', design: '+441', teams: 'tel:+442' },
      { setting: 'Voice Routing Policy', design: 'UK', teams: 'US' },
    ]);
  });

  it('names what differs on a policy, and plans nothing when it matches', () => {
    const row = { id: 'p', name: 'SC', resource_account_id: 'ra', emergency_numbers: ['+441'], description: 'New' };
    const ras = new Map([['ra', 'ra-live']]);
    expect(planSharedCallingPolicyRow(row, ras, { identity: 'SC', resourceAccount: 'RA-LIVE', emergencyNumbers: ['+441'], description: 'New' })).toEqual([]);
    expect(planSharedCallingPolicyRow(row, ras, { identity: 'SC', resourceAccount: 'ra-live', emergencyNumbers: [], description: 'Old' })[0]!.differences).toEqual([
      { setting: 'Emergency numbers', design: '+441', teams: 'None' },
      { setting: 'Description', design: 'New', teams: 'Old' },
    ]);
  });
});

describe('what differs on an auto attendant', () => {
  const QUEUE = 'q-build';
  const flowWith = (over: Partial<AutoAttendantCallFlow['menu']> = {}, greeting = 'Welcome.'): AutoAttendantCallFlow => ({
    greetings: [{ type: 'Text', text: greeting }],
    menu: { prompts: [{ type: 'Text', text: 'Press 1.' }], options: [{ dtmf: 'Tone1', action: 'TransferCallToTarget', target: { kind: 'call_queue', buildId: QUEUE } }], ...over },
  });
  const row = (over: Partial<BuildAutoAttendantRow> = {}) =>
    ({ id: 'a', name: 'AA', language_id: 'en-GB', time_zone_id: 'UTC', voice_id: null, voice_response_enabled: false, operator: null, default_call_flow: flowWith(), after_hours_call_flow: null, schedule: null, holiday_call_flows: [], resource_accounts: [], authorized_users: null, hide_authorized_users: null, user_name_extension: null, ...over }) as BuildAutoAttendantRow;
  const crossRef = new Map([[`call_queue:${QUEUE}`, 'q-live']]);
  const names = new Map([[`call_queue:${QUEUE}`, 'Sales queue']]);
  const liveWith = (defaultCallFlow: AutoAttendantCallFlow, over = {}) => ({
    identity: 'aa-live',
    languageId: 'en-GB',
    timeZoneId: 'UTC',
    applicationInstanceIds: [],
    structured: { languageId: 'en-GB', timeZoneId: 'UTC', enableVoiceResponse: false, operator: null, defaultCallFlow, afterHoursCallFlow: null, schedule: null, holidayCallFlows: [], ...over },
  });
  const liveOption = (id: string): AutoAttendantCallFlow['menu']['options'][number] => ({ dtmf: 'Tone1', action: 'TransferCallToTarget', target: { kind: 'call_queue', liveId: id } });
  const same = flowWith({ options: [liveOption('q-live')] });
  const diffs = (r: BuildAutoAttendantRow, cf: AutoAttendantCallFlow, over = {}) => autoAttendantSettingDifferences(r, liveWith(cf, over) as never, crossRef, new Map(), names);

  it('finds nothing when they match', () => {
    expect(diffs(row(), same)).toEqual([]);
  });

  it('names only the part of the call flow that differs, not the whole flow', () => {
    expect(diffs(row(), { ...same, greetings: [{ type: 'Text', text: 'Hello.' }] })).toEqual([{ setting: 'Business hours: greeting', design: 'Welcome.', teams: 'Hello.' }]);
    expect(diffs(row(), { ...same, menu: { ...same.menu, prompts: [{ type: 'Text', text: 'Press 2.' }] } })).toEqual([{ setting: 'Business hours: menu prompt', design: 'Press 1.', teams: 'Press 2.' }]);
  });

  it('names a key, with the queue by name where this site knows it', () => {
    expect(diffs(row(), { ...same, menu: { ...same.menu, options: [{ dtmf: 'Tone1', action: 'DisconnectCall' }] } })).toEqual([{ setting: 'Business hours: key 1', design: 'Transfer to Sales queue', teams: 'Disconnect' }]);
    expect(diffs(row(), { ...same, menu: { ...same.menu, options: [liveOption('q-live'), { dtmf: 'Tone2', action: 'DisconnectCall' }] } })).toEqual([{ setting: 'Business hours: key 2', design: 'No option', teams: 'Disconnect' }]);
  });

  it('gives values for a schedule, not just its name', () => {
    const open = { monday: [{ start: '09:00', end: '17:00' }], tuesday: [], wednesday: [], thursday: [], friday: [], saturday: [], sunday: [], complement: true };
    const ah: AutoAttendantCallFlow = { greetings: [], menu: { options: [{ dtmf: 'Automatic', action: 'DisconnectCall' }] } };
    const r = row({ after_hours_call_flow: ah, schedule: { type: 'weekly', weekly: open } });
    const out = diffs(r, same, { afterHoursCallFlow: ah, schedule: { type: 'weekly', weekly: { ...open, monday: [{ start: '08:00', end: '16:00' }] } } });
    expect(out).toEqual([{ setting: 'After hours: schedule', design: 'Mon 09:00-17:00', teams: 'Mon 08:00-16:00' }]);
  });

  it('puts the differences on the Set command, in the wording the preview shows', () => {
    const [call] = planAutoAttendantRow(row({ language_id: 'de-DE' }), crossRef, new Map(), new Map(), liveWith(same) as never, names);
    expect(call!.differences).toEqual([{ setting: 'Language', design: 'de-DE', teams: 'en-GB' }]);
    expect(formatDifference(call!.differences![0]!)).toBe('language (design de-DE, live en-GB)');
  });
});
