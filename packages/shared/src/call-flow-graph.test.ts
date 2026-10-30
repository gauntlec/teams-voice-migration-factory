import { describe, expect, it } from 'vitest';
import { buildAutoAttendantFlowGraphFromDesign, buildAutoAttendantFlowGraphFromLive, buildCallQueueFlowGraphFromDesign, buildCallQueueFlowGraphFromLive, formatWeeklyHours } from './call-flow-graph';

const none = { monday: [], tuesday: [], wednesday: [], thursday: [], friday: [], saturday: [], sunday: [] };
const nineToFive = [{ start: '09:00', end: '17:00' }];

describe('formatWeeklyHours', () => {
  it('joins consecutive days with the same hours and leaves out closed days', () => {
    const lines = formatWeeklyHours({ ...none, monday: nineToFive, tuesday: nineToFive, wednesday: nineToFive, thursday: nineToFive, friday: nineToFive, saturday: [{ start: '10:00', end: '14:00' }], complement: true });
    expect(lines).toEqual(['Mon–Fri 09:00–17:00', 'Sat 10:00–14:00']);
  });
  it('shows a split day and a day on its own', () => {
    expect(formatWeeklyHours({ ...none, monday: [{ start: '08:00', end: '12:00' }, { start: '13:00', end: '17:00' }], wednesday: nineToFive })).toEqual([
      'Mon 08:00–12:00, 13:00–17:00',
      'Wed 09:00–17:00',
    ]);
  });
  it('says so when there are no hours, and when the list is the closed hours', () => {
    expect(formatWeeklyHours(none)).toEqual(['No hours set']);
    expect(formatWeeklyHours({ ...none, sunday: nineToFive, complement: false })).toEqual(['Closed during:', 'Sun 09:00–17:00']);
  });
});

const menu = { options: [] };
const flow = { greetings: [], menu };

describe('Auto Attendant graph from Design & Build', () => {
  it('names the front door\'s resource account and number and shows the business hours', () => {
    const aa = {
      buildId: 'a1',
      name: 'Main line',
      operator: null,
      defaultCallFlow: flow,
      afterHoursCallFlow: null,
      holidayCallFlows: [],
      hasPhoneNumber: true,
      resourceAccounts: [{ name: 'aa-main', upn: 'aa-main@contoso.test', number: '+442070001000' }],
      schedule: { type: 'weekly' as const, weekly: { ...none, monday: nineToFive, tuesday: nineToFive, complement: true } },
      timeZone: 'GMT Standard Time',
    };
    const g = buildAutoAttendantFlowGraphFromDesign(aa, [aa], []);
    const root = g.nodes.find((n) => n.id === 'aa:a1')!;
    expect(root.badge).toBe('Front door');
    expect(root.details).toEqual(['Resource account: aa-main', 'Number: +442070001000']);
    const hours = g.nodes.find((n) => n.id === 'aa:a1:business_hours')!;
    expect(hours.details).toEqual(['Mon–Tue 09:00–17:00', 'Time zone: GMT Standard Time']);
  });

  it('draws nothing extra for an attendant with no resource account or schedule', () => {
    const aa = { buildId: 'a2', name: 'Menu', operator: null, defaultCallFlow: flow, afterHoursCallFlow: null, holidayCallFlows: [] };
    const g = buildAutoAttendantFlowGraphFromDesign(aa, [aa], []);
    expect(g.nodes.find((n) => n.id === 'aa:a2')!.details).toEqual([]);
    expect(g.nodes.find((n) => n.id === 'aa:a2:business_hours')!.details).toEqual([]);
  });
});

describe('Auto Attendant graph from the live tenant', () => {
  const t = (h: number, m = 0) => ({ Hours: h, Minutes: m });
  it('reads the resource account behind ApplicationInstances and the hours from the After hours schedule', () => {
    const data = {
      Identity: 'aa-1',
      TimeZoneId: 'GMT Standard Time',
      ApplicationInstances: ['11111111-1111-1111-1111-111111111111'],
      DefaultCallFlow: { Id: 'cf0', Greetings: [], Menu: { MenuOptions: [] } },
      CallFlows: [{ Id: 'cf1', Greetings: [], Menu: { MenuOptions: [] } }],
      CallHandlingAssociations: [{ Type: 0, ScheduleId: 'sch1', CallFlowId: 'cf1' }],
    };
    const schedule = {
      key: 'sch1',
      data: { WeeklyRecurrentSchedule: { ComplementEnabled: true, MondayHours: [{ Start: t(9), End: t(17) }], TuesdayHours: [{ Start: t(9), End: t(17) }] } },
    };
    const accounts = new Map([['11111111-1111-1111-1111-111111111111', { name: 'Main AA', upn: 'aa-main@contoso.test', number: 'tel:+442070001000' }]]);
    const g = buildAutoAttendantFlowGraphFromLive({ name: 'Main line', data }, [{ name: 'Main line', data }], [], [schedule], undefined, accounts);
    expect(g.nodes.find((n) => n.id === 'aa:aa-1')!.details).toEqual(['Resource account: Main AA', 'Number: +442070001000']);
    expect(g.nodes.find((n) => n.id === 'aa:aa-1:business_hours')!.details).toEqual(['Mon–Tue 09:00–17:00', 'Time zone: GMT Standard Time']);
  });
});

describe('Design & Build diagram with a transfer to a voice app outside the site', () => {
  it('draws the call queue and its agents from the discovered data', () => {
    const live = {
      autoAttendants: [],
      schedules: [],
      callQueues: [{ name: 'Support Queue', data: { Identity: '23fa0565-93af-4c1f-802b-d21c8aa19291', RoutingMethod: 'Attendant', Agents: [{ ObjectId: 'agent-1' }], OverflowAction: 0 } }],
      usersByEntraId: new Map([['agent-1', 'agent.one@contoso.test']]),
    };
    const aa = {
      buildId: 'aa-1', name: 'Main', operator: null, afterHoursCallFlow: null, holidayCallFlows: [],
      defaultCallFlow: { greetings: [], menu: { options: [{ dtmf: 'Automatic' as const, action: 'TransferCallToTarget' as const, target: { kind: 'call_queue' as const, liveId: '23fa0565-93af-4c1f-802b-d21c8aa19291' } }] } },
    };
    const without = buildAutoAttendantFlowGraphFromDesign(aa, [aa], []);
    expect(without.nodes.some((n) => n.label === 'Support Queue')).toBe(false);
    const g = buildAutoAttendantFlowGraphFromDesign(aa, [aa], [], live);
    const queue = g.nodes.find((n) => n.label === 'Support Queue')!;
    // the agents are listed on the queue (one box under it), not drawn as a box each
    expect(queue.agents).toEqual(['agent.one@contoso.test']);
    expect(g.nodes.some((n) => n.label === 'agent.one@contoso.test')).toBe(false);
    expect(g.edges.some((e) => e.label === 'No input' && e.target === 'cq:23fa0565-93af-4c1f-802b-d21c8aa19291')).toBe(true);
  });
});

// The PowerShell-only settings that change what a caller meets (call priority, the prompt before a redirect, dial-by-name).
describe('Call Queue graph: PowerShell-only extras', () => {
  const cq = (overflow: Record<string, unknown> | null, rest: Record<string, unknown> = {}) =>
    buildCallQueueFlowGraphFromDesign({ buildId: 'q1', name: 'Support', overflow: overflow as never, timeout: null, noAgentAction: null, ...rest });

  it('draws the plain line, exactly as before, when none are set', () => {
    const g = cq({ action: 'Forward', target: 'jo@contoso.test' });
    expect(g.edges.map((e) => [e.label, e.target])).toEqual([['Overflow', 'user:jo@contoso.test']]);
    expect(g.nodes.some((n) => n.kind === 'announcement')).toBe(false);
  });

  it('writes the call priority on the line', () => {
    const g = cq({ action: 'Forward', target: 'jo@contoso.test', priority: 2 });
    expect(g.edges.map((e) => e.label)).toEqual(['Overflow (priority 2)']);
  });

  it('puts what the caller hears between the queue and the person', () => {
    const g = cq({ action: 'Forward', target: 'jo@contoso.test', redirectPrompt: 'Please hold while we find Jo' });
    const heard = g.nodes.find((n) => n.kind === 'announcement')!;
    expect(heard.label).toBe('Caller hears');
    expect(heard.sublabel).toBe('Please hold while we find Jo');
    expect(g.edges.map((e) => [e.source, e.label, e.target])).toEqual([
      ['cq:q1', 'Overflow', heard.id],
      [heard.id, 'then', 'user:jo@contoso.test'],
    ]);
  });

  it('shows an audio file by name, and both when there is text and a file', () => {
    const audio = { fileId: 'f1', filename: 'hold.wav' };
    expect(cq({ action: 'Forward', target: 'jo@contoso.test', redirectAudio: audio }).nodes.find((n) => n.kind === 'announcement')!.sublabel).toBe('🔊 hold.wav');
    const both = cq({ action: 'Voicemail', target: 'jo@contoso.test', redirectPrompt: 'Leave a message', redirectAudio: audio }).nodes.find((n) => n.kind === 'announcement')!;
    expect([both.sublabel, both.details]).toEqual(['Leave a message', ['🔊 hold.wav']]);
  });

  it('ignores extras on an action they do not belong to', () => {
    const g = cq({ action: 'SharedVoicemail', target: 'group-id', priority: 3, redirectPrompt: 'Hello' });
    expect(g.edges.map((e) => e.label)).toEqual(['Overflow']);
    expect(g.nodes.some((n) => n.kind === 'announcement')).toBe(false);
  });

  it('does not write Teams\' default priority (3) on a live line nobody set', () => {
    const data = { Identity: 'cq-2', OverflowAction: 'Forward', OverflowActionTarget: { Id: 'app-1', Type: 'ApplicationInstance' }, OverflowActionCallPriority: 3, TimeoutAction: 'Forward', TimeoutActionTarget: { Id: 'app-2', Type: 'ApplicationInstance' }, TimeoutActionCallPriority: 1 };
    const g = buildCallQueueFlowGraphFromLive({ name: 'Support', data });
    expect(g.edges.map((e) => e.label).sort()).toEqual(['Overflow', 'Timeout (priority 1)']);
  });

  it('reads them from the live queue too', () => {
    const data = {
      Identity: 'cq-1',
      OverflowAction: 'Forward',
      OverflowActionTarget: { Id: 'tel:+15551234567', Type: 'Phone' },
      OverflowActionCallPriority: 2,
      NoAgentAction: 'Voicemail',
      NoAgentActionTarget: { Id: 'agent-1', Type: 'MailBox' },
      NoAgentRedirectVoicemailAudioFilePrompt: 'teams-audio-id',
    };
    const g = buildCallQueueFlowGraphFromLive({ name: 'Support', data }, new Map([['agent-1', 'agent.one@contoso.test']]));
    expect(g.edges.find((e) => e.branch === 'overflow')!.label).toBe('Overflow (priority 2)');
    const heard = g.nodes.find((n) => n.id === 'cq:cq-1:redirect:no_agent')!;
    expect(heard.sublabel).toBe('🔊 Audio file');
    expect(g.edges.find((e) => e.source === heard.id)!.target).toBe('voicemail:agent-1');
  });
});

describe('Auto Attendant graph: dial-by-name extension', () => {
  const aa = (userNameExtension: string | null | undefined) => ({ buildId: 'a3', name: 'Directory', operator: null, defaultCallFlow: flow, afterHoursCallFlow: null, holidayCallFlows: [], userNameExtension });
  const lines = (ext: string | null | undefined) => buildAutoAttendantFlowGraphFromDesign(aa(ext), [aa(ext)], []).nodes.find((n) => n.id === 'aa:a3')!.details;

  it('says what dial-by-name adds when it is Office or Department', () => {
    expect(lines('Department')).toEqual(['Dial by name also says: Department']);
    expect(lines('Office')).toEqual(['Dial by name also says: Office']);
  });
  it('says nothing for None, not managed, or not set', () => {
    expect(lines('None')).toEqual([]);
    expect(lines(null)).toEqual([]);
    expect(lines(undefined)).toEqual([]);
  });
  it('reads it from the live attendant, as a name or the enum number', () => {
    const live = (v: unknown) => {
      const data = { Identity: 'aa-9', UserNameExtension: v, DefaultCallFlow: { Id: 'cf0', Greetings: [], Menu: { MenuOptions: [] } } };
      return buildAutoAttendantFlowGraphFromLive({ name: 'Directory', data }, [{ name: 'Directory', data }], [], []).nodes.find((n) => n.id === 'aa:aa-9')!.details;
    };
    expect(live('Office')).toEqual(['Dial by name also says: Office']);
    expect(live(2)).toEqual(['Dial by name also says: Department']);
    expect(live(0)).toEqual([]);
  });
});

describe('Call Queue agents', () => {
  it('are listed on the queue, in order, with no box or line of their own', () => {
    const g = buildCallQueueFlowGraphFromDesign({ buildId: 'cq-1', name: 'Sales', agents: ['amy@contoso.test', 'ben@contoso.test', ''] } as never);
    expect(g.nodes).toHaveLength(1);
    expect(g.nodes[0]).toMatchObject({ id: 'cq:cq-1', label: 'Sales', agents: ['amy@contoso.test', 'ben@contoso.test'] });
    expect(g.edges).toEqual([]);
  });
});
