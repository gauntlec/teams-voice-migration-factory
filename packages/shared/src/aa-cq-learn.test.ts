import { describe, expect, it } from 'vitest';
import { liveAutoAttendantToStructured, parseLiveCallTarget, parseLiveMenuOption, parseLiveSchedule } from './aa-live-parse';
import {
  autoAttendantDeployBlockers,
  autoAttendantDifferences,
  autoAttendantRowWarnings,
  callQueueRowWarnings,
  normalizeFixedRange,
  planAutoAttendantRow,
  planCallQueueRow,
  planSharedCallingPolicyRow,
  renderCommand,
  type AutoAttendantCallFlow,
  type BuildAutoAttendantRow,
  type BuildCallQueueRow,
  type CmdletInvocation,
  type PreambleStep,
} from './deployment';
import { convertAutoAttendantWizard, convertCallQueueWizard } from './wizard-convert';
import { buildAutoAttendantFlowGraphFromLive, buildCallQueueFlowGraphFromLive } from './call-flow-graph';
import { buildAutoAttendantToWizard } from './voice-app-wizard';
import { AA_SUPPORTED_LANGUAGES } from './domain';

/** Every cmdlet+params a call (and its preamble) issues, for asserting on one specific cmdlet. */
function steps(call: CmdletInvocation): { cmdlet: string; parameters: Record<string, unknown> }[] {
  const pre = (call.preamble ?? []).filter((s): s is Extract<PreambleStep, { cmdlet: string }> => 'cmdlet' in s);
  return [...pre, { cmdlet: call.cmdlet, parameters: call.parameters }];
}

const USER_GUID = '11111111-2222-3333-4444-555555555555';
const GROUP_GUID = '99999999-8888-7777-6666-555555555555';

const flow = (options: AutoAttendantCallFlow['menu']['options']): AutoAttendantCallFlow => ({ greetings: [{ type: 'Text', text: 'Hello' }], menu: { options } });

const aaRow = (over: Partial<BuildAutoAttendantRow> = {}): BuildAutoAttendantRow => ({
  id: 'aa-1',
  name: 'Main AA',
  language_id: 'en-GB',
  time_zone_id: 'GMT Standard Time',
  voice_id: null,
  voice_response_enabled: false,
  operator: { kind: 'user', upn: 'op@contoso.com' },
  default_call_flow: flow([{ dtmf: 'Tone0', action: 'TransferCallToOperator' }]),
  after_hours_call_flow: null,
  holiday_call_flows: [],
  schedule: null,
  resource_accounts: [],
  ...over,
});

const users = new Map([['op@contoso.com', USER_GUID]]);

describe('Auto Attendant menu options (New-CsAutoAttendantMenuOption)', () => {
  it('keeps TransferCallToOperator, with no -CallTarget', () => {
    const [call] = planAutoAttendantRow(aaRow(), new Map(), new Map(), users);
    const opt = steps(call!).find((s) => s.cmdlet === 'New-CsAutoAttendantMenuOption')!;
    expect(opt.parameters).toEqual({ Action: 'TransferCallToOperator', DtmfResponse: 'Tone0' });
  });

  it('sends an Announcement with its own -Prompt', () => {
    const row = aaRow({ default_call_flow: flow([{ dtmf: 'Tone2', action: 'Announcement', prompt: { type: 'Text', text: 'We are open 9 to 5' } }]) });
    const [call] = planAutoAttendantRow(row, new Map(), new Map(), users);
    const text = renderCommand(call!);
    expect(text).toContain("New-CsAutoAttendantPrompt -TextToSpeechPrompt 'We are open 9 to 5'");
    expect(text).toMatch(/New-CsAutoAttendantMenuOption -Action 'Announcement' -DtmfResponse 'Tone2' -Prompt \$prompt\d+/);
  });

  it('falls back to DisconnectCall for an Announcement with no text, and warns', () => {
    const row = aaRow({ default_call_flow: flow([{ dtmf: 'Tone2', action: 'Announcement' }]) });
    const [call] = planAutoAttendantRow(row, new Map(), new Map(), users);
    expect(steps(call!).find((s) => s.cmdlet === 'New-CsAutoAttendantMenuOption')!.parameters.Action).toBe('DisconnectCall');
    expect(autoAttendantRowWarnings(row, new Map(), new Map(), users).join(' ')).toMatch(/announcement with no text/);
  });

  it('warns when an option goes to the operator but no operator is set', () => {
    const warnings = autoAttendantRowWarnings(aaRow({ operator: null }), new Map(), new Map(), users);
    expect(warnings.join(' ')).toMatch(/no operator set/);
  });
});

describe('Auto Attendant schedules', () => {
  it('normalizes a wizard date (inclusive end) to an exclusive ISO range', () => {
    expect(normalizeFixedRange({ start: '2026-12-25', end: '2026-12-26' })).toEqual({ start: '2026-12-25T00:00:00', end: '2026-12-27T00:00:00' });
    expect(normalizeFixedRange({ start: '2026-12-25', end: '' })).toEqual({ start: '2026-12-25T00:00:00', end: '2026-12-26T00:00:00' });
    expect(normalizeFixedRange({ start: '2026-12-25T00:00:00', end: '2026-12-26T00:00:00' })).toEqual({ start: '2026-12-25T00:00:00', end: '2026-12-26T00:00:00' });
    expect(normalizeFixedRange({ start: '24/12/2026', end: '27/12/2026 00:00' })).toEqual({ start: '2026-12-24T00:00:00', end: '2026-12-27T00:00:00' });
    expect(normalizeFixedRange({ start: 'Christmas', end: '' })).toBeUndefined();
  });

  it('renders holiday ranges in the d/m/yyyy H:mm form New-CsOnlineDateTimeRange requires', () => {
    const row = aaRow({
      holiday_call_flows: [{ name: 'Christmas', callFlow: flow([]), schedule: { type: 'fixed', fixed: { ranges: [{ start: '2026-12-25', end: '2026-12-26' }] } } }],
    });
    const [call] = planAutoAttendantRow(row, new Map(), new Map(), users);
    const dtr = steps(call!).find((s) => s.cmdlet === 'New-CsOnlineDateTimeRange')!;
    expect(dtr.parameters).toEqual({ Start: '25/12/2026 0:00', End: '27/12/2026 0:00' });
  });

  it('renders an end-of-day time range as the TimeSpan 1.00:00', () => {
    const day = [{ start: '17:00', end: '24:00' }];
    const row = aaRow({
      after_hours_call_flow: flow([]),
      schedule: { type: 'weekly', weekly: { monday: day, tuesday: [], wednesday: [], thursday: [], friday: [], saturday: [], sunday: [], complement: true } },
    });
    const [call] = planAutoAttendantRow(row, new Map(), new Map(), users);
    expect(steps(call!).find((s) => s.cmdlet === 'New-CsOnlineTimeRange')!.parameters).toEqual({ Start: '17:00', End: '1.00:00' });
  });

  it('warns about a weekly schedule with no hours and an unaligned time', () => {
    const empty = { monday: [], tuesday: [], wednesday: [], thursday: [], friday: [], saturday: [], sunday: [] };
    const w1 = autoAttendantRowWarnings(aaRow({ after_hours_call_flow: flow([]), schedule: { type: 'weekly', weekly: { ...empty, complement: true } } }), new Map(), new Map(), users);
    expect(w1.join(' ')).toMatch(/no hours set/);
    const w2 = autoAttendantRowWarnings(
      aaRow({ after_hours_call_flow: flow([]), schedule: { type: 'weekly', weekly: { ...empty, monday: [{ start: '09:10', end: '17:00' }] } } }),
      new Map(),
      new Map(),
      users,
    );
    expect(w2.join(' ')).toMatch(/15-minute steps/);
  });

  it('treats a wizard holiday and its live round-trip as unchanged', () => {
    const row = aaRow({
      operator: null,
      default_call_flow: flow([{ dtmf: 'Automatic', action: 'DisconnectCall' }]),
      holiday_call_flows: [{ name: 'Christmas', callFlow: flow([{ dtmf: 'Automatic', action: 'DisconnectCall' }]), schedule: { type: 'fixed', fixed: { ranges: [{ start: '2026-12-25', end: '2026-12-25' }] } } }],
    });
    const liveFlow = (id: string) => ({
      Id: id,
      Greetings: [{ TextToSpeechPrompt: 'Hello' }],
      Menu: { MenuOptions: [{ DtmfResponse: 100, Action: 1 }] },
    });
    const liveData = {
      Identity: 'aa-live',
      LanguageId: 'en-GB',
      TimeZoneId: 'GMT Standard Time',
      VoiceResponseEnabled: false,
      DefaultCallFlow: liveFlow('cf-default'),
      CallFlows: [liveFlow('cf-xmas')],
      CallHandlingAssociations: [{ Type: 1, ScheduleId: 'sch-1', CallFlowId: 'cf-xmas' }],
    };
    const schedules = new Map([['sch-1', { Name: 'Christmas', FixedSchedule: { DateTimeRanges: [{ Start: '2026-12-25T00:00:00', End: '2026-12-26T00:00:00' }] } }]]);
    const structured = liveAutoAttendantToStructured(liveData, schedules, () => undefined);
    const calls = planAutoAttendantRow(row, new Map(), new Map(), users, { identity: 'aa-live', structured, applicationInstanceIds: [] });
    expect(calls).toEqual([]);
  });

  it('clears a removed operator on Set-CsAutoAttendant', () => {
    const live = { identity: 'aa-live', structured: undefined, applicationInstanceIds: [] };
    const [call] = planAutoAttendantRow(aaRow({ operator: null, default_call_flow: flow([]) }), new Map(), new Map(), users, live);
    expect(renderCommand(call!)).toContain('$aa.Operator = $null');
  });
});

describe('Live Auto Attendant parsing (MicrosoftTeams 8.0.0 enum values)', () => {
  it('reads the option Action rather than inferring it from CallTarget', () => {
    expect(parseLiveMenuOption({ DtmfResponse: 0, Action: 0 })).toEqual({ dtmf: 'Tone0', action: 'TransferCallToOperator' });
    expect(parseLiveMenuOption({ DtmfResponse: 2, Action: 3, Prompt: { TextToSpeechPrompt: 'Hours' } })).toEqual({
      dtmf: 'Tone2',
      action: 'Announcement',
      prompt: { type: 'Text', text: 'Hours' },
    });
    expect(parseLiveMenuOption({ DtmfResponse: 1, Action: 2, CallTarget: { Id: USER_GUID, Type: 0 } })?.target).toEqual({ kind: 'user', liveId: USER_GUID });
  });

  it('decodes ApplicationEndpoint and SharedVoicemail call targets', () => {
    expect(parseLiveCallTarget({ Id: USER_GUID, Type: 3 })).toEqual({ kind: 'resource_account', liveId: USER_GUID });
    expect(parseLiveCallTarget({ Id: GROUP_GUID, Type: 5 })).toEqual({ kind: 'shared_voicemail', liveId: GROUP_GUID });
    expect(parseLiveCallTarget({ Id: USER_GUID, Type: 6 })).toEqual({ kind: 'voice_app', liveId: USER_GUID });
    expect(parseLiveCallTarget({ Id: 'tel:+441234567890', Type: 4 })).toEqual({ kind: 'external', number: 'tel:+441234567890' });
  });

  it('reads an end-of-day TimeSpan as 24:00', () => {
    const s = parseLiveSchedule({ WeeklyRecurrentSchedule: { MondayHours: [{ Start: { Days: 0, Hours: 17, Minutes: 0 }, End: { Days: 1, Hours: 0, Minutes: 0 } }] } });
    expect(s?.weekly?.monday).toEqual([{ start: '17:00', end: '24:00' }]);
  });
});

describe('Call Queue exception targets (Set-CsCallQueue)', () => {
  const cq = (over: Partial<BuildCallQueueRow>): BuildCallQueueRow => ({
    id: 'cq-1',
    name: 'Support',
    routing_method: 'RoundRobin',
    agent_alert_time: 20,
    presence_based_routing: true,
    agents: [],
    overflow: null,
    timeout: null,
    no_agent_action: null,
    no_agent_apply_to: null,
    language_id: 'en-GB',
    resource_accounts: [],
    ...over,
  });
  const people = new Map([['jane@contoso.com', USER_GUID]]);

  it('creates the queue with default music on hold', () => {
    const [call] = planCallQueueRow(cq({}), people, new Map());
    expect(call!.cmdlet).toBe('New-CsCallQueue');
    expect(call!.parameters.UseDefaultMusicOnHold).toBe(true);
  });

  it('resolves a personal Voicemail target to the user object id', () => {
    const [call] = planCallQueueRow(cq({ timeout: { action: 'Voicemail', threshold: 300, target: 'jane@contoso.com' } }), people, new Map());
    expect(call!.parameters.TimeoutActionTarget).toBe(USER_GUID);
  });

  it('never tel:-prefixes a SharedVoicemail target that is not a group id, and warns', () => {
    const row = cq({ overflow: { action: 'SharedVoicemail', threshold: 10, target: 'Support team' } });
    const [call] = planCallQueueRow(row, people, new Map());
    expect(call!.parameters.OverflowActionTarget).toBeUndefined();
    expect(callQueueRowWarnings(row, people, new Map()).join(' ')).toMatch(/no Microsoft 365 group is selected/);
  });

  it('drops a stale target for an action that takes none', () => {
    const [call] = planCallQueueRow(cq({ overflow: { action: 'DisconnectWithBusy', threshold: 10, target: 'jane@contoso.com' } }), people, new Map());
    expect(call!.parameters.OverflowActionTarget).toBeUndefined();
  });

  it('rounds the timeout threshold to 15 seconds so it matches live', () => {
    const row = cq({ timeout: { action: 'Disconnect', threshold: 47 } });
    expect(planCallQueueRow(row, people, new Map())[0]!.parameters.TimeoutThreshold).toBe(45);
    const live = {
      identity: 'cq-live',
      routingMethod: 'RoundRobin',
      agentAlertTime: 20,
      presenceBasedRouting: true,
      agentObjectIds: [],
      timeoutAction: 'Disconnect',
      timeoutThreshold: 45,
      applicationInstanceIds: [],
    };
    expect(planCallQueueRow(row, people, new Map(), live)).toEqual([]);
  });

  it('warns when personal voicemail has no person', () => {
    expect(callQueueRowWarnings(cq({ no_agent_action: { action: 'Voicemail' } }), people, new Map()).join(' ')).toMatch(/no person is set/);
  });
});

describe('Wizard conversion', () => {
  it('stores a wizard holiday as an exclusive ISO range', () => {
    const { value } = convertAutoAttendantWizard(
      {
        languageId: 'en-GB',
        timeZoneId: 'GMT Standard Time',
        hoursType: 'always',
        businessFlow: { mode: 'direct', target: { kind: 'operator' } },
        holidaysEnabled: true,
        holidays: [{ name: 'Boxing Day', dateRange: { start: '2026-12-26', end: '' }, flow: { mode: 'voicemail' } }],
      },
      { siteId: 's', name: 'AA' },
    );
    expect(value.holiday_call_flows?.[0]?.schedule.fixed?.ranges).toEqual([{ start: '2026-12-26T00:00:00', end: '2026-12-27T00:00:00' }]);
    // An AA's "voicemail" is always shared voicemail (Microsoft Learn).
    expect(value.holiday_call_flows?.[0]?.callFlow.menu.options[0]?.target?.kind).toBe('shared_voicemail');
  });

  it('turns a "play a message" menu option into an Announcement', () => {
    const { value } = convertAutoAttendantWizard(
      {
        languageId: 'en-GB',
        timeZoneId: 'GMT Standard Time',
        hoursType: 'always',
        businessFlow: { mode: 'menu', options: [{ key: '2', label: 'Hours', target: { kind: 'message', label: 'Open 9 to 5' } }] },
        holidaysEnabled: false,
      },
      { siteId: 's', name: 'AA' },
    );
    expect(value.default_call_flow?.menu.options[0]).toEqual({ dtmf: 'Tone2', action: 'Announcement', prompt: { type: 'Text', text: 'Open 9 to 5' } });
  });

  it('carries a Call Queue personal-voicemail target, resolved to a UPN', () => {
    const { value } = convertCallQueueWizard(
      {
        languageId: 'en-GB',
        agents: [],
        routingMethod: 'RoundRobin',
        presenceBasedRouting: true,
        agentAlertTime: 20,
        overflowThreshold: 50,
        overflow: { action: 'DisconnectWithBusy' },
        timeoutThreshold: 600,
        timeout: { action: 'Voicemail', forwardTo: 'Jane Doe' },
        noAgents: { action: 'Queue' },
        noAgentsApplyTo: 'AllCalls',
      },
      { siteId: 's', name: 'CQ', resolvers: { resolvePerson: (l) => (l === 'Jane Doe' ? 'jane@contoso.com' : undefined), resolveTeam: () => undefined, resolveFlow: () => undefined } },
    );
    expect(value.timeout).toEqual({ action: 'Voicemail', threshold: 600, target: 'jane@contoso.com' });
  });
});

describe('Live call-flow visualiser', () => {
  const nodes = (g: { nodes: { id: string; kind: string; label: string; sublabel?: string }[] }) => g.nodes;

  it('decodes numeric Call Queue actions and target types (MicrosoftTeams 8.0.0)', () => {
    const cqData = {
      Identity: 'cq-1',
      Agents: [],
      OverflowAction: 3, // SharedVoicemail
      OverflowActionTarget: { Id: GROUP_GUID, Type: 5 }, // MailBox
      TimeoutAction: 1, // Forward
      TimeoutActionTarget: { Id: 'tel:+441234567890', Type: 4 }, // Phone
      NoAgentAction: 1, // Disconnect
      NoAgentActionTarget: null,
    };
    const g = buildCallQueueFlowGraphFromLive({ name: 'Support', data: cqData });
    const kinds = Object.fromEntries(nodes(g).map((n) => [n.id, n.kind]));
    expect(kinds[`group:${GROUP_GUID}`]).toBe('shared_voicemail');
    expect(kinds['ext:tel:+441234567890']).toBe('external_number');
    expect(kinds.disconnect).toBe('disconnect');
  });

  it('names a Forward-to-voice-app target via its resource account', () => {
    const cqData = { Identity: 'cq-1', Agents: [], TimeoutAction: 1, TimeoutActionTarget: { Id: 'ra-guid', Type: 2 } };
    const g = buildCallQueueFlowGraphFromLive({ name: 'Support', data: cqData }, undefined, {
      autoAttendants: [{ name: 'Main AA', data: { Identity: 'aa-1', ApplicationInstances: ['ra-guid'] } }],
      callQueues: [],
    });
    expect(nodes(g).find((n) => n.id === 'aa:aa-1')?.label).toBe('Main AA');
  });

  it('draws operator and announcement menu options, and resource-account transfers', () => {
    const aa = {
      name: 'Main AA',
      data: {
        Identity: 'aa-1',
        Operator: { Id: USER_GUID, Type: 0 },
        DefaultCallFlow: {
          Menu: {
            MenuOptions: [
              { DtmfResponse: 0, Action: 0 },
              { DtmfResponse: 2, Action: 3, Prompt: { TextToSpeechPrompt: 'We are open 9 to 5' } },
              { DtmfResponse: 1, Action: 2, CallTarget: { Id: 'ra-guid', Type: 3 } },
            ],
          },
        },
      },
    };
    const cq = { name: 'Sales', data: { Identity: 'cq-9', ApplicationInstances: ['ra-guid'], Agents: [] } };
    const g = buildAutoAttendantFlowGraphFromLive(aa, [aa], [cq], [], new Map([[USER_GUID, 'op@contoso.com']]));
    const labels = nodes(g).map((n) => n.label);
    expect(labels).toContain('op@contoso.com');
    expect(labels).toContain('Announcement');
    expect(labels).toContain('Sales');
    expect(labels).not.toContain('Disconnect');
  });
});

describe('Shared Calling policy live diff', () => {
  it('treats the same resource account as unchanged regardless of GUID case', () => {
    const row = { id: 'sc-1', name: 'Seattle', resource_account_id: 'ra-1', emergency_numbers: ['+14255556677'], description: null };
    const live = { identity: 'Seattle', resourceAccount: USER_GUID.toLowerCase(), emergencyNumbers: ['+14255556677'] };
    expect(planSharedCallingPolicyRow(row, new Map([['ra-1', USER_GUID.toUpperCase()]]), live)).toEqual([]);
  });
});

describe('Auto Attendant update path (Set-CsAutoAttendant -Instance)', () => {
  const live = { identity: 'aa-live-1', languageId: 'fr-FR', timeZoneId: 'Romance Standard Time', enableVoiceResponse: false, applicationInstanceIds: [] };

  it("assigns the object's real VoiceResponseEnabled property, not the New-CsAutoAttendant parameter name", () => {
    const [call] = planAutoAttendantRow(aaRow({ voice_response_enabled: true }), new Map(), new Map(), users, live as never);
    const assigned = (call!.preamble ?? []).filter((s): s is Extract<PreambleStep, { kind: 'assign' }> => 'kind' in s && s.kind === 'assign');
    const props = assigned.map((a) => a.property);
    expect(props).toContain('VoiceResponseEnabled');
    expect(props).not.toContain('EnableVoiceResponse');
    expect(renderCommand(call!)).toContain('$aa.VoiceResponseEnabled = $true');
  });

  it('still uses -EnableVoiceResponse, the real parameter, when creating', () => {
    const [call] = planAutoAttendantRow(aaRow({ voice_response_enabled: true }), new Map(), new Map(), users);
    expect(call!.parameters.EnableVoiceResponse).toBe(true);
  });
});

// Glasgow, 6 Nov 2026: AA-UK-PTD649-MainNumber's menu keys all rendered as DisconnectCall because its call queues weren't in Teams yet.
describe('a menu option transferring to a call queue that is not in Teams yet', () => {
  const QUEUE = 'd6259b72-6bd6-4c85-b959-b7cf5fe7749a';
  const names = new Map([[`call_queue:${QUEUE}`, 'UK-Glasgow-MainNumberPurchasing']]);
  const toQueue = { dtmf: 'Tone1' as const, action: 'TransferCallToTarget' as const, target: { kind: 'call_queue' as const, buildId: QUEUE } };
  const row = aaRow({ operator: null, default_call_flow: flow([toQueue]) });
  const optionOf = (call: CmdletInvocation) => steps(call).find((s) => s.cmdlet === 'New-CsAutoAttendantMenuOption')!;
  const entityOf = (call: CmdletInvocation) => steps(call).find((s) => s.cmdlet === 'New-CsAutoAttendantCallableEntity')!;

  it('still shows the transfer, looking the queue up by its exact name', () => {
    const [call] = planAutoAttendantRow(row, new Map(), new Map(), users, undefined, names);
    expect(optionOf(call!).parameters.Action).toBe('TransferCallToTarget');
    const text = renderCommand(call!);
    expect(text).toContain("$cq1 = Get-CsCallQueue -NameFilter 'UK-Glasgow-MainNumberPurchasing' | Where-Object { $_.Name -eq 'UK-Glasgow-MainNumberPurchasing' }");
    expect(text).toMatch(/New-CsAutoAttendantCallableEntity -Type 'ConfigurationEndpoint' -Identity \$cq1\.Identity/);
    expect(text).not.toContain('DisconnectCall');
  });

  it('uses the queue id once it is live, as Microsoft Learn documents for a nested call queue', () => {
    const [call] = planAutoAttendantRow(row, new Map([[`call_queue:${QUEUE}`, 'live-id']]), new Map(), users, undefined, names);
    expect(entityOf(call!).parameters).toEqual({ Type: 'ConfigurationEndpoint', Identity: 'live-id' });
    expect(optionOf(call!).parameters).toMatchObject({ Action: 'TransferCallToTarget', DtmfResponse: 'Tone1' });
    expect(renderCommand(call!)).not.toContain('Get-CsCallQueue');
  });

  it('keeps the attendant out of a live run, naming the queue, until it is in Teams', () => {
    expect(autoAttendantDeployBlockers(row, new Map(), users, names)).toEqual(["Business hours key Tone1 transfers to Call Queue UK-Glasgow-MainNumberPurchasing, which isn't in Teams yet"]);
    expect(autoAttendantDeployBlockers(row, new Map([[`call_queue:${QUEUE}`, 'live-id']]), users, names)).toEqual([]);
    expect(autoAttendantRowWarnings(row, new Map(), new Map(), users, names).join(' ')).toMatch(/leaves this Auto Attendant out/);
  });

  it('also keeps it out for other targets Teams cannot be told about, in the flows that would be sent', () => {
    const shared = { dtmf: 'Automatic' as const, action: 'TransferCallToTarget' as const, target: { kind: 'shared_voicemail' as const } };
    const schedule = { type: 'weekly' as const, weekly: { monday: [{ start: '09:00', end: '17:00' }] } };
    const noSchedule = aaRow({ operator: null, default_call_flow: flow([]), after_hours_call_flow: flow([shared]), schedule: null });
    expect(autoAttendantDeployBlockers(noSchedule, new Map(), users)).toEqual([]);
    expect(autoAttendantDeployBlockers({ ...noSchedule, schedule } as never, new Map(), users)).toEqual(["After hours key Automatic targets Shared Voicemail, but its M365 group ID isn't set yet"]);
    const [shown] = planAutoAttendantRow({ ...noSchedule, schedule } as never, new Map(), new Map(), users);
    expect(renderCommand(shown!)).toContain("-Type 'SharedVoicemail' -Identity '<M365 group ID not set>'");
    expect(renderCommand(shown!)).not.toMatch(/-Action 'DisconnectCall' -DtmfResponse 'Automatic'.*After/);
    const person = aaRow({ operator: null, default_call_flow: flow([{ dtmf: 'Tone1', action: 'TransferCallToTarget', target: { kind: 'user', upn: 'nobody@contoso.test' } }]) });
    expect(autoAttendantDeployBlockers(person, new Map(), new Map()).join(' ')).toMatch(/nobody@contoso\.test/);
  });
});

// Glasgow, 6 Nov 2026: Teams refused the queue with "Language ID must be present for text to speech prompt".
describe('a call queue with a spoken message', () => {
  const cq = (over: Partial<BuildCallQueueRow>): BuildCallQueueRow =>
    ({ id: 'q1', name: 'Sales', routing_method: 'RoundRobin', agent_alert_time: 20, presence_based_routing: true, agents: [], overflow: null, timeout: null, no_agent_action: null, no_agent_apply_to: null, language_id: null, resource_accounts: [], authorized_users: null, hide_authorized_users: null, voicemail_triage_template_id: null, ...over }) as BuildCallQueueRow;
  it('sends its language', () => {
    const [call] = planCallQueueRow(cq({ language_id: 'en-GB', overflow: { action: 'DisconnectWithBusy', threshold: 2, redirectPrompt: 'We are unable to take your call.' } }), new Map(), new Map());
    expect(call!.parameters).toMatchObject({ LanguageId: 'en-GB', OverflowDisconnectTextToSpeechPrompt: 'We are unable to take your call.' });
  });
  it('leaves it out with no spoken message or shared voicemail', () => {
    const [call] = planCallQueueRow(cq({ language_id: 'en-GB', overflow: { action: 'DisconnectWithBusy', threshold: 2 } }), new Map(), new Map());
    expect(call!.parameters.LanguageId).toBeUndefined();
  });
  it('warns when there is a spoken message but no language', () => {
    const warnings = callQueueRowWarnings(cq({ language_id: null, timeout: { action: 'Disconnect', threshold: 60, redirectPrompt: 'Goodbye.' } }), new Map(), new Map());
    expect(warnings.join(' ')).toMatch(/no language is set/);
  });
});

describe('a menu that takes key presses needs a spoken prompt (New-CsAutoAttendantMenu -Prompts)', () => {
  const GREETING = 'Thank you for calling. Press 1 for Purchasing.';
  const keys: AutoAttendantCallFlow['menu']['options'] = [{ dtmf: 'Tone1', action: 'DisconnectCall' }];
  const row = (cf: AutoAttendantCallFlow, over: Partial<BuildAutoAttendantRow> = {}) => aaRow({ operator: null, default_call_flow: cf, ...over });
  const greetingOnly: AutoAttendantCallFlow = { greetings: [{ type: 'Text', text: GREETING }], menu: { options: keys } };
  /** The named commands of a plan, and the text of the prompt each parameter points at. */
  const planned = (calls: CmdletInvocation[]) => {
    const all = calls.flatMap(steps);
    const prompts = new Map<string, unknown>();
    for (const p of calls.flatMap((c) => c.preamble ?? [])) {
      if ('cmdlet' in p && p.cmdlet === 'New-CsAutoAttendantPrompt' && p.assignTo) prompts.set(p.assignTo, p.parameters.TextToSpeechPrompt);
    }
    const said = (v: unknown) => ((v as { $var: string }[] | undefined) ?? []).map((r) => prompts.get(r.$var));
    const of = (cmdlet: string) => all.filter((c) => c.cmdlet === cmdlet);
    return { of, said, promptCount: prompts.size };
  };
  const liveState = (r: BuildAutoAttendantRow, defaultCallFlow: AutoAttendantCallFlow) => ({
    identity: 'aa-live',
    languageId: r.language_id ?? undefined,
    timeZoneId: r.time_zone_id ?? undefined,
    applicationInstanceIds: [],
    structured: {
      languageId: r.language_id ?? undefined,
      timeZoneId: r.time_zone_id ?? undefined,
      defaultCallFlow,
      afterHoursCallFlow: null,
      schedule: null,
      holidayCallFlows: [],
    } as never,
  });

  it('sends the greeting as the menu prompt, once, when the menu has keys and no prompt (the Glasgow failure)', () => {
    const p = planned(planAutoAttendantRow(row(greetingOnly), new Map(), new Map(), users));
    const [menu] = p.of('New-CsAutoAttendantMenu');
    const [callFlow] = p.of('New-CsAutoAttendantCallFlow');
    expect(p.said(menu!.parameters.Prompts)).toEqual([GREETING]);
    expect(callFlow!.parameters.Greetings).toBeUndefined();
    expect(p.promptCount).toBe(1);
  });

  it('leaves a greeting and a menu prompt as they are', () => {
    const cf: AutoAttendantCallFlow = { greetings: [{ type: 'Text', text: 'Welcome.' }], menu: { options: keys, prompts: [{ type: 'Text', text: 'Press 1.' }] } };
    const p = planned(planAutoAttendantRow(row(cf), new Map(), new Map(), users));
    expect(p.said(p.of('New-CsAutoAttendantMenu')[0]!.parameters.Prompts)).toEqual(['Press 1.']);
    expect(p.said(p.of('New-CsAutoAttendantCallFlow')[0]!.parameters.Greetings)).toEqual(['Welcome.']);
  });

  it('does not add a prompt to a menu that takes no input: the message stays a greeting', () => {
    const cf: AutoAttendantCallFlow = { greetings: [{ type: 'Text', text: 'We are closed.' }], menu: { options: [{ dtmf: 'Automatic', action: 'DisconnectCall' }] } };
    const p = planned(planAutoAttendantRow(row(cf), new Map(), new Map(), users));
    expect(p.of('New-CsAutoAttendantMenu')[0]!.parameters.Prompts).toBeUndefined();
    expect(p.said(p.of('New-CsAutoAttendantCallFlow')[0]!.parameters.Greetings)).toEqual(['We are closed.']);
    expect(autoAttendantDeployBlockers(row(cf), new Map(), users)).toEqual([]);
  });

  it('treats dial by name as input, as both Learn examples do', () => {
    const cf: AutoAttendantCallFlow = { greetings: [{ type: 'Text', text: 'Say a name.' }], menu: { enableDialByName: true, options: [] } };
    const p = planned(planAutoAttendantRow(row(cf), new Map(), new Map(), users));
    expect(p.said(p.of('New-CsAutoAttendantMenu')[0]!.parameters.Prompts)).toEqual(['Say a name.']);
  });

  it('covers after hours and holiday menus too', () => {
    const r = row(flow([]), {
      after_hours_call_flow: greetingOnly,
      schedule: { type: 'weekly', weekly: { monday: [{ start: '09:00', end: '17:00' }], complement: true } } as never,
      holiday_call_flows: [{ name: 'Christmas', callFlow: greetingOnly, schedule: { type: 'fixed', fixed: { ranges: [{ start: '2026-12-25', end: '2026-12-25' }] } } }] as never,
    });
    const p = planned(planAutoAttendantRow(r, new Map(), new Map(), users));
    expect(p.of('New-CsAutoAttendantMenu').map((m) => p.said(m.parameters.Prompts))).toEqual([[], [GREETING], [GREETING]]);
  });

  it('warns and leaves the attendant out when there is nothing to say', () => {
    const r = row({ greetings: [], menu: { options: keys } });
    expect(autoAttendantDeployBlockers(r, new Map(), users).join(' ')).toMatch(/Business hours menu has no spoken prompt/);
    expect(autoAttendantRowWarnings(r, new Map(), new Map(), users).join(' ')).toMatch(/no spoken prompt.*leaves this Auto Attendant out/);
    expect(autoAttendantRowWarnings(r, new Map(), new Map(), users).join(' ')).not.toMatch(/transfer targets/);
  });

  it('warns about an audio menu prompt, which cannot be sent, rather than letting Teams refuse it', () => {
    const r = row({ greetings: [{ type: 'Text', text: GREETING }], menu: { options: keys, prompts: [{ type: 'AudioFile' }] } });
    expect(autoAttendantDeployBlockers(r, new Map(), users).join(' ')).toMatch(/no spoken prompt/);
  });

  it('does not read as different from Teams once deployed', () => {
    const r = row(greetingOnly);
    const deployed: AutoAttendantCallFlow = { greetings: [], menu: { options: keys, prompts: [{ type: 'Text', text: GREETING }] } };
    expect(planAutoAttendantRow(r, new Map(), new Map(), users, liveState(r, deployed))).toEqual([]);
  });

  it('keeps the live prompt when the design lost it and the greeting is unchanged, so the wording is not overwritten', () => {
    const live: AutoAttendantCallFlow = { greetings: [{ type: 'Text', text: 'Welcome.' }], menu: { options: keys, prompts: [{ type: 'Text', text: 'Press 1 for Sales.' }] } };
    const r = row({ greetings: [{ type: 'Text', text: 'Welcome.' }], menu: { options: keys } });
    expect(planAutoAttendantRow(r, new Map(), new Map(), users, liveState(r, live))).toEqual([]);

    const changed = { ...r, default_call_flow: { ...r.default_call_flow!, menu: { options: [...keys, { dtmf: 'Tone2' as const, action: 'DisconnectCall' as const }] } } };
    const p = planned(planAutoAttendantRow(changed, new Map(), new Map(), users, liveState(changed, live)));
    expect(p.said(p.of('New-CsAutoAttendantMenu')[0]!.parameters.Prompts)).toEqual(['Press 1 for Sales.']);
    expect(p.said(p.of('New-CsAutoAttendantCallFlow')[0]!.parameters.Greetings)).toEqual(['Welcome.']);
  });

  it('keeps a live prompt when the design has no greeting either, rather than leaving the attendant out', () => {
    const live: AutoAttendantCallFlow = { greetings: [], menu: { options: keys, prompts: [{ type: 'Text', text: 'Press 1.' }] } };
    const r = row({ greetings: [], menu: { options: keys } });
    expect(autoAttendantDeployBlockers(r, new Map(), users, new Map(), liveState(r, live))).toEqual([]);
    expect(planAutoAttendantRow(r, new Map(), new Map(), users, liveState(r, live))).toEqual([]);
  });

  it('uses a changed greeting as the new prompt after deployment', () => {
    const live: AutoAttendantCallFlow = { greetings: [], menu: { options: keys, prompts: [{ type: 'Text', text: GREETING }] } };
    const r = row({ greetings: [{ type: 'Text', text: 'New wording. Press 1.' }], menu: { options: keys } });
    const p = planned(planAutoAttendantRow(r, new Map(), new Map(), users, liveState(r, live)));
    expect(p.said(p.of('New-CsAutoAttendantMenu')[0]!.parameters.Prompts)).toEqual(['New wording. Press 1.']);
    expect(p.of('New-CsAutoAttendantCallFlow')[0]!.parameters.Greetings).toBeUndefined();
  });

  it('carries a menu prompt through the wizard both ways', () => {
    const base = { name: 'AA', language: 'en-GB', timeZone: 'GMT Standard Time' };
    const { value } = convertAutoAttendantWizard(
      { ...base, businessFlow: { mode: 'menu', greeting: 'Welcome.', menuPrompt: ' Press 1. ', options: [{ key: '1', label: 'Sales', target: { kind: 'external', label: '+441234567890' } }] } } as never,
      { siteId: 'site', name: 'AA' },
    );
    expect(value.default_call_flow).toMatchObject({ greetings: [{ type: 'Text', text: 'Welcome.' }], menu: { prompts: [{ type: 'Text', text: 'Press 1.' }] } });

    const { answers } = buildAutoAttendantToWizard({ ...aaRow(), default_call_flow: value.default_call_flow } as never);
    expect(answers!.businessFlow).toMatchObject({ mode: 'menu', greeting: 'Welcome.', menuPrompt: 'Press 1.' });
  });
});

describe('voice commands on menu options (New-CsAutoAttendantMenuOption -VoiceResponses)', () => {
  const QUEUE_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
  const opt = (over: Partial<AutoAttendantCallFlow['menu']['options'][number]> = {}): AutoAttendantCallFlow['menu']['options'][number] => ({
    dtmf: 'Tone1',
    action: 'TransferCallToTarget',
    target: { kind: 'call_queue', liveId: QUEUE_ID },
    ...over,
  });
  const cf = (o: AutoAttendantCallFlow['menu']['options'][number]): AutoAttendantCallFlow => ({ greetings: [], menu: { options: [o], prompts: [{ type: 'Text', text: 'Press 1.' }] } });
  const row = (flowOf: AutoAttendantCallFlow, over: Partial<BuildAutoAttendantRow> = {}) => aaRow({ operator: null, default_call_flow: flowOf, ...over });
  const liveOf = (r: BuildAutoAttendantRow, defaultCallFlow: AutoAttendantCallFlow) => ({
    identity: 'aa-live',
    languageId: r.language_id ?? undefined,
    timeZoneId: r.time_zone_id ?? undefined,
    applicationInstanceIds: [],
    structured: { languageId: r.language_id ?? undefined, timeZoneId: r.time_zone_id ?? undefined, enableVoiceResponse: r.voice_response_enabled, operator: null, defaultCallFlow, afterHoursCallFlow: null, schedule: null, holidayCallFlows: [] },
  });
  const sent = (calls: CmdletInvocation[]) => calls.flatMap(steps).find((s) => s.cmdlet === 'New-CsAutoAttendantMenuOption')?.parameters.VoiceResponses;

  it('sends the command as Learn shows, with the key', () => {
    const calls = planAutoAttendantRow(row(cf(opt({ voiceResponse: 'Customer Service' })), { voice_response_enabled: true }), new Map(), new Map(), users);
    expect(renderCommand(calls[0]!)).toContain("-DtmfResponse 'Tone1' -CallTarget $ce1 -VoiceResponses @('Customer Service')");
  });

  it('sends no parameter when there is no command, or on an Automatic option', () => {
    expect(sent(planAutoAttendantRow(row(cf(opt())), new Map(), new Map(), users))).toBeUndefined();
    expect(sent(planAutoAttendantRow(row(cf(opt({ voiceResponse: ' ' }))), new Map(), new Map(), users))).toBeUndefined();
    expect(sent(planAutoAttendantRow(row(cf(opt({ dtmf: 'Automatic', voiceResponse: 'Sales' }))), new Map(), new Map(), users))).toBeUndefined();
  });

  it('keeps the command on an update when the design never held it, instead of deleting it from Teams', () => {
    const saved = row(cf(opt()), { name: 'Renamed' });
    const live = liveOf(saved, cf(opt({ voiceResponse: 'SALES' })));
    expect(planAutoAttendantRow(row(cf(opt())), new Map(), new Map(), users, live)).toEqual([]);
    const changed = row({ ...cf(opt()), greetings: [{ type: 'Text', text: 'New greeting.' }] });
    expect(sent(planAutoAttendantRow(changed, new Map(), new Map(), users, live))).toEqual(['SALES']);
  });

  it('does not carry a command over to a different target or action', () => {
    const r = row(cf(opt({ target: { kind: 'call_queue', liveId: 'ffffffff-bbbb-cccc-dddd-eeeeeeeeeeee' } })));
    expect(sent(planAutoAttendantRow(r, new Map(), new Map(), users, liveOf(r, cf(opt({ voiceResponse: 'SALES' })))))).toBeUndefined();
    const r2 = row(cf(opt({ action: 'DisconnectCall', target: undefined })));
    expect(sent(planAutoAttendantRow(r2, new Map(), new Map(), users, liveOf(r2, cf(opt({ voiceResponse: 'SALES' })))))).toBeUndefined();
  });

  it('removes the command when it is cleared', () => {
    const r = row(cf(opt({ voiceResponse: '' })));
    const calls = planAutoAttendantRow(r, new Map(), new Map(), users, liveOf(r, cf(opt({ voiceResponse: 'SALES' }))));
    expect(calls).toHaveLength(1);
    expect(sent(calls)).toBeUndefined();
  });

  it('changes the command when it is edited, and says so in the difference', () => {
    const r = row(cf(opt({ voiceResponse: 'Accounts' })));
    const live = liveOf(r, cf(opt({ voiceResponse: 'Sales' })));
    expect(sent(planAutoAttendantRow(r, new Map(), new Map(), users, live))).toEqual(['Accounts']);
    expect(autoAttendantDifferences(r, live).join(' ')).toMatch(/say "accounts".*say "sales"/);
  });

  it('ignores case and spacing when comparing, because Teams keeps what it was given', () => {
    const r = row(cf(opt({ voiceResponse: ' sales ' })));
    expect(planAutoAttendantRow(r, new Map(), new Map(), users, liveOf(r, cf(opt({ voiceResponse: 'SALES' }))))).toEqual([]);
  });

  it('reads the command from Teams', () => {
    expect(parseLiveMenuOption({ DtmfResponse: 1, Action: 2, CallTarget: { Id: USER_GUID, Type: 6 }, VoiceResponses: ['SALES'] })?.voiceResponse).toBe('SALES');
    expect(parseLiveMenuOption({ DtmfResponse: 0, Action: 0, VoiceResponses: [] })).toEqual({ dtmf: 'Tone0', action: 'TransferCallToOperator' });
    const structured = liveAutoAttendantToStructured(
      { DefaultCallFlow: { Greetings: [], Menu: { MenuOptions: [{ DtmfResponse: 0, Action: 0, VoiceResponses: ['OPERATOR'] }] } } },
      new Map(),
      () => undefined,
    );
    expect(structured.defaultCallFlow!.menu.options[0]!.voiceResponse).toBe('OPERATOR');
  });

  it('warns when commands are set with voice response off', () => {
    const warn = (r: BuildAutoAttendantRow) => autoAttendantRowWarnings(r, new Map(), new Map(), users).join(' ');
    expect(warn(row(cf(opt({ voiceResponse: 'Sales' }))))).toMatch(/voice response is off/);
    expect(warn(row(cf(opt({ voiceResponse: 'Sales' })), { voice_response_enabled: true }))).not.toMatch(/voice response is off/);
  });

  it('warns when voice response is on for a language Learn lists with no speech recognition', () => {
    const warn = (language_id: string) => autoAttendantRowWarnings(row(cf(opt()), { voice_response_enabled: true, language_id }), new Map(), new Map(), users).join(' ');
    expect(warn('en-IE')).toMatch(/no speech recognition for English \(Ireland\)/);
    expect(warn('en-GB')).not.toMatch(/speech recognition/);
  });

  it('matches the speech recognition languages in Learn', () => {
    expect(AA_SUPPORTED_LANGUAGES.filter((l) => l.speechInput).map((l) => l.code).sort()).toEqual(
      ['de-DE', 'en-AU', 'en-CA', 'en-GB', 'en-IN', 'en-US', 'es-ES', 'es-MX', 'fr-CA', 'fr-CH', 'fr-FR', 'it-IT', 'ja-JP', 'pt-BR', 'zh-CN'],
    );
  });

  it('carries commands and the voice setting through the wizard both ways', () => {
    const { value } = convertAutoAttendantWizard(
      {
        languageId: 'en-GB',
        timeZoneId: 'GMT Standard Time',
        voiceInputs: true,
        hoursType: 'always',
        holidaysEnabled: false,
        businessFlow: { mode: 'menu', menuPrompt: 'Press 1.', options: [{ key: '1', label: 'Sales', voiceCommand: ' Sales ', target: { kind: 'external', label: '+441234567890' } }] },
      } as never,
      { siteId: 'site', name: 'AA' },
    );
    expect(value.voice_response_enabled).toBe(true);
    expect((value.default_call_flow as AutoAttendantCallFlow).menu.options[0]!.voiceResponse).toBe('Sales');

    const { answers } = buildAutoAttendantToWizard(value as never);
    expect(answers!.voiceInputs).toBe(true);
    expect(answers!.businessFlow.options![0]!.voiceCommand).toBe('Sales');
  });

  it('shows the command on the diagram only when callers can use it', () => {
    const data = (on: boolean) => ({ Identity: 'aa', Name: 'Main', VoiceResponseEnabled: on, DefaultCallFlow: { Greetings: [], Menu: { MenuOptions: [{ DtmfResponse: 1, Action: 1, VoiceResponses: ['SALES'] }] } } });
    const labels = (on: boolean) => {
      const aa = { name: 'Main', data: data(on) };
      return buildAutoAttendantFlowGraphFromLive(aa, [aa], [], []).edges.map((e) => e.label);
    };
    expect(labels(true)).toContain('Press 1 or say "SALES"');
    expect(labels(false)).toContain('Press 1');
  });
});
