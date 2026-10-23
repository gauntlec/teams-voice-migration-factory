import type { LiveAutoAttendantStructured } from './aa-live-parse';
import type { AutoAttendantCallableEntity, AutoAttendantCallFlow } from './deployment';
import { decodeCallQueueEnum } from './deployment';
import { CALL_QUEUE_NO_AGENT_ACTIONS, CALL_QUEUE_NO_AGENT_APPLY_TO, CALL_QUEUE_OVERFLOW_ACTIONS, CALL_QUEUE_ROUTING_METHODS, CALL_QUEUE_TIMEOUT_ACTIONS } from './domain';
import {
  autoAttendantWizardAnswersSchema,
  callQueueWizardAnswersSchema,
  type AutoAttendantWizardAnswers,
  type CallQueueWizardAnswers,
  type WizardCallFlow,
  type WizardMenuOption,
  type WizardTarget,
} from './wizard';

/**
 * A discovered auto attendant or call queue as the Call flows wizard's plain-language answers - the reverse of wizard-convert.ts -
 * so a voice app added to a site from Discovery appears on Data Collection's Call flows tab like one captured by hand. Names are
 * only ever taken from ids the caller can resolve (`ctx`); anything the wizard cannot say is left out and listed in `notes`.
 */
export interface VoiceAppWizardContext {
  /** a person's UPN from their object id */
  personOf?: (id: string) => string | undefined;
  /** another voice app by its live identity: its name, and its Call flows row id when the site has one */
  appOf?: (identity: string) => { name: string; flowId?: string } | undefined;
}

const keyOf = (dtmf: string) => dtmf.replace('Tone', '');
const stripTel = (v: string) => v.replace(/^tel:/i, '').split(';')[0]!.trim();

function targetOf(e: AutoAttendantCallableEntity | null | undefined, ctx: VoiceAppWizardContext): WizardTarget | undefined {
  if (!e) return undefined;
  if (e.kind === 'user') return { kind: 'person', label: e.upn };
  if (e.kind === 'external') return { kind: 'external', label: e.number ? stripTel(e.number) : undefined };
  if (e.kind === 'shared_voicemail' || e.kind === 'voicemail') return { kind: 'voicemail' };
  const app = e.buildId ? ctx.appOf?.(e.buildId) : undefined;
  if (e.kind === 'call_queue') return { kind: 'call_queue', label: app?.name ?? 'Call queue', ...(app?.flowId ? { flowId: app.flowId } : {}) };
  return { kind: 'team', label: app?.name ?? 'Auto attendant', ...(app?.flowId ? { flowId: app.flowId } : {}) };
}

function flowOf(cf: AutoAttendantCallFlow | null, operator: AutoAttendantCallableEntity | null | undefined, ctx: VoiceAppWizardContext, where: string, notes: string[]): WizardCallFlow | undefined {
  if (!cf) return undefined;
  const text = cf.greetings.find((g) => g.type === 'Text' && g.text)?.text;
  if (cf.greetings.some((g) => g.type === 'AudioFile')) notes.push(`${where}: an audio greeting was not carried over.`);
  const greeting = text ? { greeting: text.slice(0, 1000) } : {};
  const options = cf.menu.options;

  if (options.length === 1 && options[0]!.dtmf === 'Automatic') {
    const o = options[0]!;
    if (o.action === 'TransferCallToOperator') return { mode: 'direct', ...greeting, target: operator ? (targetOf(operator, ctx) ?? { kind: 'operator' }) : { kind: 'operator' } };
    if (o.action === 'TransferCallToTarget') {
      const t = targetOf(o.target, ctx);
      if (t?.kind === 'voicemail') return { mode: 'voicemail', ...greeting };
      if (t) return { mode: 'direct', ...greeting, target: t };
    }
    notes.push(`${where}: the call is ended after the greeting.`);
    return { mode: 'menu', ...greeting, options: [] };
  }

  const out: WizardMenuOption[] = [];
  for (const o of options) {
    if (o.dtmf === 'Automatic') {
      notes.push(`${where}: the "no key pressed" option was not carried over.`);
      continue;
    }
    let label: string;
    let target: WizardTarget | undefined;
    if (o.action === 'TransferCallToTarget') {
      target = targetOf(o.target, ctx);
      label = target?.label ?? 'Transfer';
    } else if (o.action === 'TransferCallToOperator') {
      target = { kind: 'operator' };
      label = 'Operator';
    } else if (o.action === 'Announcement') {
      target = { kind: 'message', label: o.prompt?.text?.slice(0, 200) };
      label = 'Announcement';
    } else {
      target = { kind: 'message', label: 'The call ends' };
      label = 'End the call';
    }
    if (!target) {
      notes.push(`${where}: option ${keyOf(o.dtmf)} has no destination that could be read.`);
      continue;
    }
    out.push({ key: keyOf(o.dtmf), label: label.slice(0, 100) || 'Option', target });
  }
  if (out.length > 12) notes.push(`${where}: only the first 12 menu options were carried over.`);
  return { mode: 'menu', ...greeting, options: out.slice(0, 12), ...(cf.menu.enableDialByName ? { allowDialByName: true } : {}) };
}

const nextDay = (iso: string) => new Date(Date.UTC(+iso.slice(0, 4), +iso.slice(5, 7) - 1, +iso.slice(8, 10) + 1)).toISOString().slice(0, 10);
const prevDay = (iso: string) => new Date(Date.UTC(+iso.slice(0, 4), +iso.slice(5, 7) - 1, +iso.slice(8, 10) - 1)).toISOString().slice(0, 10);
void nextDay;

/** An auto attendant, from the structured form `liveAutoAttendantToStructured` makes of its live settings. */
export function autoAttendantToWizard(live: LiveAutoAttendantStructured, ctx: VoiceAppWizardContext = {}): { answers: AutoAttendantWizardAnswers | null; notes: string[] } {
  const notes: string[] = [];
  const businessFlow = flowOf(live.defaultCallFlow, live.operator, ctx, 'Business hours', notes);
  if (!businessFlow) return { answers: null, notes: ['No call flow could be read from Teams.'] };

  const weekly = live.schedule?.weekly;
  const afterHoursFlow = flowOf(live.afterHoursCallFlow, live.operator, ctx, 'After hours', notes);
  let hoursType: 'always' | 'custom' = 'always';
  let customHours: AutoAttendantWizardAnswers['customHours'];
  if (weekly && afterHoursFlow) {
    if (weekly.complement === false) {
      notes.push('The schedule lists the closed hours, which the wizard cannot show, so the attendant is shown as open at all times.');
    } else {
      hoursType = 'custom';
      const { complement: _c, ...days } = weekly;
      customHours = days;
    }
  }

  const holidays = live.holidayCallFlows.slice(0, 10).flatMap((h) => {
    const range = h.schedule.fixed?.ranges?.[0];
    const flow = flowOf(h.callFlow, live.operator, ctx, `Holiday "${h.name}"`, notes);
    if (!range || !flow) return [];
    const start = range.start.slice(0, 10);
    // stored with an exclusive end; the wizard's dates are whole days, both included
    const endExclusive = range.end ? range.end.slice(0, 10) : nextDay(start);
    return [{ name: h.name.slice(0, 160) || 'Holiday', dateRange: { start, end: prevDay(endExclusive) < start ? start : prevDay(endExclusive) }, flow }];
  });

  const operator = targetOf(live.operator, ctx);
  const answers = {
    languageId: live.languageId ?? 'en-US',
    timeZoneId: live.timeZoneId ?? 'UTC',
    hoursType,
    ...(customHours ? { customHours } : {}),
    businessFlow,
    ...(hoursType !== 'always' && afterHoursFlow ? { afterHoursFlow } : {}),
    ...(operator ? { operator } : {}),
    holidaysEnabled: holidays.length > 0,
    ...(holidays.length ? { holidays } : {}),
  };
  const parsed = autoAttendantWizardAnswersSchema.safeParse(answers);
  if (!parsed.success) return { answers: null, notes: [...notes, 'The settings could not be shown in the wizard.'] };
  return { answers: parsed.data, notes };
}

const clamp = (n: unknown, lo: number, hi: number, fallback: number) => (typeof n === 'number' && Number.isFinite(n) ? Math.min(hi, Math.max(lo, Math.round(n))) : fallback);

/** A call queue, from its live Get-CsCallQueue data. */
export function callQueueToWizard(data: Record<string, unknown>, ctx: VoiceAppWizardContext = {}): { answers: CallQueueWizardAnswers | null; notes: string[] } {
  const notes: string[] = [];
  const agents: string[] = [];
  for (const a of Array.isArray(data.Agents) ? (data.Agents as Record<string, unknown>[]) : []) {
    const id = typeof a?.ObjectId === 'string' ? a.ObjectId : undefined;
    const upn = id ? ctx.personOf?.(id) : undefined;
    if (upn) agents.push(upn);
    else if (id) notes.push(`An agent (${id}) is not in the synced users, so was left out.`);
  }
  const pick = <T extends readonly string[]>(values: T, raw: unknown, fallback: T[number]): T[number] => {
    const v = decodeCallQueueEnum(raw, values);
    return v && (values as readonly string[]).includes(v) ? v : fallback;
  };
  const action = <T extends readonly [string, ...string[]]>(values: T, actionKey: string, targetKey: string, fallback: T[number]) => {
    const act = pick(values, data[actionKey], fallback);
    const t = data[targetKey] as { Id?: unknown } | null | undefined;
    const id = typeof t?.Id === 'string' ? t.Id : undefined;
    let forwardTo: string | undefined;
    if (id && act !== 'Queue' && act !== 'Disconnect' && act !== 'DisconnectWithBusy') {
      forwardTo = id.toLowerCase().startsWith('tel:') ? stripTel(id) : (ctx.personOf?.(id) ?? ctx.appOf?.(id)?.name ?? id);
    }
    return { action: act, ...(forwardTo ? { forwardTo: forwardTo.slice(0, 200) } : {}) };
  };
  const answers = {
    languageId: typeof data.LanguageId === 'string' && data.LanguageId ? data.LanguageId : 'en-US',
    agents,
    routingMethod: pick(CALL_QUEUE_ROUTING_METHODS, data.RoutingMethod, 'Attendant'),
    presenceBasedRouting: typeof data.PresenceBasedRouting === 'boolean' ? data.PresenceBasedRouting : true,
    agentAlertTime: clamp(data.AgentAlertTime, 15, 180, 30),
    overflowThreshold: clamp(data.OverflowThreshold, 0, 200, 50),
    overflow: action(CALL_QUEUE_OVERFLOW_ACTIONS, 'OverflowAction', 'OverflowActionTarget', 'DisconnectWithBusy'),
    timeoutThreshold: clamp(data.TimeoutThreshold, 0, 2700, 1200),
    timeout: action(CALL_QUEUE_TIMEOUT_ACTIONS, 'TimeoutAction', 'TimeoutActionTarget', 'Disconnect'),
    noAgents: action(CALL_QUEUE_NO_AGENT_ACTIONS, 'NoAgentAction', 'NoAgentActionTarget', 'Queue'),
    noAgentsApplyTo: pick(CALL_QUEUE_NO_AGENT_APPLY_TO, data.NoAgentApplyTo, 'AllCalls'),
  };
  const parsed = callQueueWizardAnswersSchema.safeParse(answers);
  if (!parsed.success) return { answers: null, notes: [...notes, 'The settings could not be shown in the wizard.'] };
  return { answers: parsed.data, notes };
}
