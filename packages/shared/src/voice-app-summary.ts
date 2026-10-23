import { formatWeeklyHours } from './call-flow-graph';
import type { AutoAttendantCallableEntity, AutoAttendantCallFlow, AutoAttendantHolidayCallFlow, AutoAttendantSchedule } from './deployment';
import { decodeCallQueueEnum } from './deployment';
import type { LiveAutoAttendantStructured } from './aa-live-parse';
import { CALL_QUEUE_NO_AGENT_ACTIONS, CALL_QUEUE_OVERFLOW_ACTIONS, CALL_QUEUE_ROUTING_METHODS, CALL_QUEUE_TIMEOUT_ACTIONS } from './domain';

/**
 * Plain-words descriptions of a discovered auto attendant or call queue, for the free-text fields of its Data Collection
 * resource account record (business hours, who answers, out-of-hours action, exception handling, holiday handling, advanced
 * features). Used when a discovered voice app is added to a site, so what Teams already has is not lost on the way in.
 * Anything Teams does not hold for a field is null, never invented.
 */
export interface VoiceAppFields {
  business_hours: string | null;
  who_answers: string | null;
  ooh_action: string | null;
  exception_conditions: string | null;
  exception_action: string | null;
  holiday: string | null;
  advanced_features: string | null;
}

const empty = (): VoiceAppFields => ({ business_hours: null, who_answers: null, ooh_action: null, exception_conditions: null, exception_action: null, holiday: null, advanced_features: null });
const join = (parts: (string | null | undefined | false)[], sep = '. ') => parts.filter((p): p is string => !!p).join(sep) || null;
const keyOf = (dtmf: string) => (dtmf === 'Automatic' ? 'no key pressed' : `press ${dtmf.replace('Tone', '')}`);

/** Where a call goes, in words. `nameOf` turns a live voice app / person id into a name when the caller knows it. */
function entityText(e: AutoAttendantCallableEntity | undefined, nameOf: (id: string) => string | undefined): string {
  if (!e) return 'an unresolved target';
  if (e.kind === 'user') return e.upn ?? 'a user';
  if (e.kind === 'external') return (e.number ?? 'an external number').replace(/^tel:/i, '');
  if (e.kind === 'shared_voicemail') return 'shared voicemail';
  const name = e.buildId ? nameOf(e.buildId) : undefined;
  return name ? `${e.kind === 'call_queue' ? 'call queue' : 'auto attendant'} ${name}` : e.kind === 'call_queue' ? 'a call queue' : 'an auto attendant';
}

function flowText(cf: AutoAttendantCallFlow | null, operator: AutoAttendantCallableEntity | null | undefined, nameOf: (id: string) => string | undefined): string | null {
  if (!cf) return null;
  const greeting = cf.greetings.find((g) => g.type === 'Text' && g.text)?.text;
  const options = cf.menu.options.map((o) => {
    const where =
      o.action === 'TransferCallToTarget' ? `transfer to ${entityText(o.target, nameOf)}` :
      o.action === 'TransferCallToOperator' ? `transfer to the operator${operator ? ` (${entityText(operator, nameOf)})` : ''}` :
      o.action === 'Announcement' ? 'play an announcement' : 'end the call';
    return `${keyOf(o.dtmf)}: ${where}`;
  });
  return join([
    greeting ? `Greeting: "${greeting}"` : null,
    options.length ? `Menu: ${options.join('; ')}` : 'No menu options',
    cf.menu.enableDialByName ? 'Dial by name is on' : null,
  ]);
}

function scheduleText(s: AutoAttendantSchedule | null | undefined): string | null {
  if (!s?.weekly) return null;
  return formatWeeklyHours(s.weekly).join('; ');
}

function holidayText(h: AutoAttendantHolidayCallFlow, nameOf: (id: string) => string | undefined, operator: AutoAttendantCallableEntity | null | undefined): string {
  const dates = h.schedule.fixed?.ranges?.map((r) => `${r.start.slice(0, 10)}${r.end && r.end.slice(0, 10) !== r.start.slice(0, 10) ? ` to ${r.end.slice(0, 10)}` : ''}`).join(', ');
  return join([h.name, dates ? `(${dates})` : null, flowText(h.callFlow, operator, nameOf)], ' ') ?? h.name;
}

/** An auto attendant, from the structured form `liveAutoAttendantToStructured` makes of its live settings. */
export function autoAttendantFields(live: LiveAutoAttendantStructured, nameOf: (id: string) => string | undefined = () => undefined): VoiceAppFields {
  const out = empty();
  out.business_hours = scheduleText(live.schedule);
  out.who_answers = join([
    flowText(live.defaultCallFlow, live.operator, nameOf),
    live.operator ? `Operator: ${entityText(live.operator, nameOf)}` : null,
  ]);
  out.ooh_action = flowText(live.afterHoursCallFlow, live.operator, nameOf);
  out.holiday = live.holidayCallFlows.length ? live.holidayCallFlows.map((h) => holidayText(h, nameOf, live.operator)).join('\n') : null;
  out.advanced_features = join(
    [
      live.languageId ? `Language ${live.languageId}` : null,
      live.timeZoneId ? `Time zone ${live.timeZoneId}` : null,
      live.voiceId ? `Voice ${live.voiceId}` : null,
      live.enableVoiceResponse != null ? `Voice response ${live.enableVoiceResponse ? 'on' : 'off'}` : null,
    ],
    '; ',
  );
  return out;
}

const ACTION_TEXT: Record<string, string> = {
  Disconnect: 'disconnect the call',
  DisconnectWithBusy: 'disconnect with a busy tone',
  Forward: 'forward the call',
  Voicemail: 'send to voicemail',
  SharedVoicemail: 'send to shared voicemail',
  Queue: 'keep the call in the queue',
};

/** A call queue, from its live Get-CsCallQueue data. `nameOf` names an agent or a forward target by its object id. */
export function callQueueFields(data: Record<string, unknown>, nameOf: (id: string) => string | undefined = () => undefined): VoiceAppFields {
  const out = empty();
  const agents = Array.isArray(data.Agents) ? (data.Agents as Record<string, unknown>[]).map((a) => (typeof a?.ObjectId === 'string' ? (nameOf(a.ObjectId) ?? a.ObjectId) : null)).filter((v): v is string => !!v) : [];
  const method = decodeCallQueueEnum(data.RoutingMethod, CALL_QUEUE_ROUTING_METHODS);
  out.who_answers = join([agents.length ? `Agents: ${agents.join(', ')}` : 'No agents', method ? `Routing: ${method}` : null]);

  const branch = (actionKey: string, targetKey: string, values: readonly string[]) => {
    const action = decodeCallQueueEnum(data[actionKey], values);
    if (!action || action === 'Queue') return null;
    const t = data[targetKey] as { Id?: unknown } | null | undefined;
    const id = typeof t?.Id === 'string' ? t.Id : undefined;
    const target = id ? (id.toLowerCase().startsWith('tel:') ? id.replace(/^tel:/i, '') : (nameOf(id) ?? id)) : undefined;
    return `${ACTION_TEXT[action] ?? action}${target ? ` (${target})` : ''}`;
  };
  const overflow = branch('OverflowAction', 'OverflowActionTarget', CALL_QUEUE_OVERFLOW_ACTIONS);
  const timeout = branch('TimeoutAction', 'TimeoutActionTarget', CALL_QUEUE_TIMEOUT_ACTIONS);
  const noAgent = branch('NoAgentAction', 'NoAgentActionTarget', CALL_QUEUE_NO_AGENT_ACTIONS);
  const conditions: string[] = [];
  const actions: string[] = [];
  if (overflow) {
    conditions.push(`More than ${typeof data.OverflowThreshold === 'number' ? data.OverflowThreshold : 'the set number of'} calls waiting`);
    actions.push(`Overflow: ${overflow}`);
  }
  if (timeout) {
    conditions.push(`A call waits more than ${typeof data.TimeoutThreshold === 'number' ? `${data.TimeoutThreshold} seconds` : 'the set time'}`);
    actions.push(`Timeout: ${timeout}`);
  }
  if (noAgent) {
    conditions.push('No agents available');
    actions.push(`No agents: ${noAgent}`);
  }
  out.exception_conditions = conditions.length ? conditions.join('\n') : null;
  out.exception_action = actions.length ? actions.join('\n') : null;
  out.advanced_features = join(
    [
      typeof data.LanguageId === 'string' ? `Language ${data.LanguageId}` : null,
      typeof data.AgentAlertTime === 'number' ? `Agent alert time ${data.AgentAlertTime} seconds` : null,
      typeof data.PresenceBasedRouting === 'boolean' ? `Presence-based routing ${data.PresenceBasedRouting ? 'on' : 'off'}` : null,
      typeof data.ConferenceMode === 'boolean' ? `Conference mode ${data.ConferenceMode ? 'on' : 'off'}` : null,
    ],
    '; ',
  );
  return out;
}
