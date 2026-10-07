import { describe, expect, it } from 'vitest';
import { liveAutoAttendantToStructured, parseLiveCallTarget, parseLiveMenuOption, parseLiveSchedule } from './aa-live-parse';
import {
  autoAttendantRowWarnings,
  callQueueRowWarnings,
  normalizeFixedRange,
  planAutoAttendantRow,
  planCallQueueRow,
  renderCommand,
  type AutoAttendantCallFlow,
  type BuildAutoAttendantRow,
  type BuildCallQueueRow,
  type CmdletInvocation,
  type PreambleStep,
} from './deployment';
import { convertAutoAttendantWizard, convertCallQueueWizard } from './wizard-convert';
import { buildAutoAttendantFlowGraphFromLive, buildCallQueueFlowGraphFromLive } from './call-flow-graph';

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
