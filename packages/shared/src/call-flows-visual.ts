/**
 * Call Flows (preview), step 1 of docs/CALL-FLOWS-WIZARD.md: the model the visual editor works on, in the words a customer uses
 * (a menu, a group of people, a person, voicemail, a forward), and its translation to and from the classic wizards' answers.
 *
 * The visual editor saves exactly what the classic wizards save: one Auto Attendant capture, plus one Call Queue capture per
 * group of people, linked by `flowId` as "Set up a new call queue" does. So import, deployment, diagrams and the handover pack
 * work unchanged. `toCaptures` and `fromCaptures` are each other's inverse for everything the visual editor can express; a
 * classic capture it can't express (holidays, an operator, a menu inside a menu) is reported, so the page can offer the classic
 * wizard instead of losing anything.
 */
import type { AutoAttendantWizardAnswers, CallQueueWizardAnswers, WizardCallFlow, WizardMenuOption, WizardTarget, WizardWeeklyHours } from './wizard';

/** How a group's phones ring: everyone at once, one after another in order, whoever has waited longest, or taking turns. */
export type VisualRinging = 'all' | 'in_order' | 'longest_idle' | 'take_turns';
const RINGING_TO_ROUTING = { all: 'Attendant', in_order: 'Serial', longest_idle: 'LongestIdle', take_turns: 'RoundRobin' } as const;
const ROUTING_TO_RINGING: Record<string, VisualRinging> = { Attendant: 'all', Serial: 'in_order', LongestIdle: 'longest_idle', RoundRobin: 'take_turns' };

/** Where a group sends a call it can't answer. */
export type VisualGroupEnd =
  | { kind: 'hangup'; message?: string }
  /** a person's own voicemail */
  | { kind: 'person_voicemail'; who: string }
  /** a shared voicemail (a Microsoft 365 group) */
  | { kind: 'shared_voicemail'; group: string }
  /** a person, or a phone number */
  | { kind: 'forward'; to: string };

/** A group of people who answer together: a call queue in Teams. `id` is its own capture's id (the `flowId` that links it). */
export interface VisualGroup {
  kind: 'group';
  id: string;
  name: string;
  people: string[];
  ringing: VisualRinging;
  /** seconds each person's phone rings before the next try (15-180) */
  ringSeconds: number;
  /** how long a caller waits at most, in seconds, then `ifNoAnswer` */
  maxWaitSeconds: number;
  ifNoAnswer: VisualGroupEnd;
  /** more callers waiting than this: `ifTooBusy` */
  maxWaiting: number;
  ifTooBusy: VisualGroupEnd;
  /** nobody signed in to take calls: `ifNobodyAvailable` (for new callers, or everyone waiting) */
  ifNobodyAvailable: VisualGroupEnd | { kind: 'keep_waiting' };
  nobodyAvailableAppliesTo: 'NewCalls' | 'AllCalls';
  /** route only to people whose presence says they're available */
  presenceBased: boolean;
  languageId: string;
}

/** What happens next: a group, a person, voicemail, a forward, hanging up, or another call flow on the site. */
export type VisualStep =
  | VisualGroup
  | { kind: 'person'; who: string }
  | { kind: 'shared_voicemail'; group: string }
  | { kind: 'forward'; number: string }
  | { kind: 'hangup' }
  /** another call flow on the site, by its capture id when picked from the list, or a name typed */
  | { kind: 'link'; flowId?: string; name: string };

/** A menu option: any step but hanging up, plus a message that plays and returns to the menu, or the operator. */
export type VisualOptionStep = Exclude<VisualStep, { kind: 'hangup' }> | { kind: 'announcement'; text: string } | { kind: 'operator' };

export interface VisualMenuOption {
  key: string;
  label: string;
  /** what a caller can say instead of pressing the key */
  say?: string;
  then: VisualOptionStep;
}

/** One path (business hours, or after hours): a greeting, then a menu or straight on to a step. */
export interface VisualPath {
  greeting?: string;
  then: { kind: 'menu'; prompt?: string; options: VisualMenuOption[]; dialByName?: boolean } | VisualStep;
}

export interface VisualCallFlow {
  name: string;
  languageId: string;
  timeZoneId: string;
  voiceInputs?: boolean;
  hours: { type: 'always' } | { type: 'standard' } | { type: 'custom'; weekly: WizardWeeklyHours };
  business: VisualPath;
  /** only when hours aren't 'always' */
  afterHours?: VisualPath;
}

export interface FlowCapture<A> {
  /** the capture's id: an existing one when editing, a new one otherwise */
  flowId: string;
  name: string;
  answers: A;
}

/**
 * The captures a visual flow saves. The number answers the first one (`top`): an auto attendant, or, when the flow is only ever
 * "ring this group" (no hours, no greeting, no menu) and `attendantInFront` is off, the group's own call queue.
 */
export interface VisualCaptures {
  top: { kind: 'auto_attendant'; capture: FlowCapture<AutoAttendantWizardAnswers> } | { kind: 'call_queue'; capture: FlowCapture<CallQueueWizardAnswers> };
  /** every other group, as a call queue capture the attendant links to by flowId */
  queues: FlowCapture<CallQueueWizardAnswers>[];
}

/* ------------------------------- visual -> captures ------------------------------- */

function groupEnd(e: VisualGroupEnd, hangup: 'Disconnect' | 'DisconnectWithBusy'): { action: string; forwardTo?: string; message?: string } {
  switch (e.kind) {
    case 'hangup':
      return e.message ? { action: hangup, message: e.message } : { action: hangup };
    case 'person_voicemail':
      return { action: 'Voicemail', forwardTo: e.who };
    case 'shared_voicemail':
      return { action: 'SharedVoicemail', forwardTo: e.group };
    case 'forward':
      return { action: 'Forward', forwardTo: e.to };
  }
}

export function groupToQueueAnswers(g: VisualGroup): CallQueueWizardAnswers {
  return {
    languageId: g.languageId,
    agents: [...g.people],
    routingMethod: RINGING_TO_ROUTING[g.ringing],
    presenceBasedRouting: g.presenceBased,
    agentAlertTime: g.ringSeconds,
    overflowThreshold: g.maxWaiting,
    overflow: groupEnd(g.ifTooBusy, 'DisconnectWithBusy'),
    timeoutThreshold: g.maxWaitSeconds,
    timeout: groupEnd(g.ifNoAnswer, 'Disconnect'),
    noAgents: g.ifNobodyAvailable.kind === 'keep_waiting' ? { action: 'Queue' } : groupEnd(g.ifNobodyAvailable, 'Disconnect'),
    noAgentsApplyTo: g.nobodyAvailableAppliesTo,
  } as CallQueueWizardAnswers;
}

function stepTarget(s: VisualOptionStep | VisualStep, groups: VisualGroup[]): WizardTarget {
  switch (s.kind) {
    case 'group':
      groups.push(s);
      return { kind: 'call_queue', label: s.name, flowId: s.id };
    case 'person':
      return { kind: 'person', label: s.who };
    case 'shared_voicemail':
      return { kind: 'voicemail', label: s.group };
    case 'forward':
      return { kind: 'external', label: s.number };
    case 'link':
      return s.flowId ? { kind: 'team', label: s.name, flowId: s.flowId } : { kind: 'team', label: s.name };
    case 'announcement':
      return { kind: 'message', label: s.text };
    case 'operator':
      return { kind: 'operator' };
    case 'hangup':
      // a path that hangs up is mode 'disconnect' (pathToCallFlow), and a menu option can't hang up
      throw new Error('hang up is not a destination');
  }
}

function pathToCallFlow(p: VisualPath, groups: VisualGroup[]): WizardCallFlow {
  const greeting = p.greeting?.trim() || undefined;
  const t = p.then;
  if (t.kind === 'menu') {
    const options: WizardMenuOption[] = t.options.map((o) => ({
      key: o.key,
      label: o.label,
      target: stepTarget(o.then, groups),
      ...(o.say !== undefined ? { voiceCommand: o.say } : {}),
    }));
    return {
      mode: 'menu',
      ...(greeting ? { greeting } : {}),
      ...(t.prompt?.trim() ? { menuPrompt: t.prompt.trim() } : {}),
      options,
      ...(t.dialByName !== undefined ? { allowDialByName: t.dialByName } : {}),
    };
  }
  if (t.kind === 'hangup') return { mode: 'disconnect', ...(greeting ? { greeting } : {}) };
  return { mode: 'direct', ...(greeting ? { greeting } : {}), target: stepTarget(t, groups) };
}

/** Whether the flow is nothing but "ring this group", so the number can go straight to its call queue. */
export function onlyRingsAGroup(f: VisualCallFlow): VisualGroup | null {
  return f.hours.type === 'always' && !f.business.greeting?.trim() && f.business.then.kind === 'group' ? f.business.then : null;
}

/**
 * The captures to save. `attendantFlowId`: the auto attendant's capture id (existing when editing, new otherwise).
 * `attendantInFront`: always answer with an auto attendant, even for "just ring this group" (docs/CALL-FLOWS-WIZARD.md decision 1).
 */
export function toCaptures(f: VisualCallFlow, opts: { attendantFlowId: string; attendantInFront?: boolean }): VisualCaptures {
  const only = opts.attendantInFront ? null : onlyRingsAGroup(f);
  if (only) return { top: { kind: 'call_queue', capture: { flowId: only.id, name: only.name, answers: groupToQueueAnswers(only) } }, queues: [] };

  const groups: VisualGroup[] = [];
  const answers: AutoAttendantWizardAnswers = {
    languageId: f.languageId,
    timeZoneId: f.timeZoneId,
    ...(f.voiceInputs !== undefined ? { voiceInputs: f.voiceInputs } : {}),
    hoursType: f.hours.type,
    ...(f.hours.type === 'custom' ? { customHours: f.hours.weekly } : {}),
    businessFlow: pathToCallFlow(f.business, groups),
    ...(f.hours.type !== 'always' && f.afterHours ? { afterHoursFlow: pathToCallFlow(f.afterHours, groups) } : {}),
    holidaysEnabled: false,
  };
  // one capture per group, even if it's reached from more than one place
  const seen = new Set<string>();
  const queues = groups.filter((g) => !seen.has(g.id) && seen.add(g.id)).map((g) => ({ flowId: g.id, name: g.name, answers: groupToQueueAnswers(g) }));
  return { top: { kind: 'auto_attendant', capture: { flowId: opts.attendantFlowId, name: f.name, answers } }, queues };
}

/* ------------------------------- captures -> visual ------------------------------- */

export type FromCapturesResult = { ok: true; flow: VisualCallFlow; attendantFlowId: string | null } | { ok: false; reasons: string[] };

function endFromAnswer(a: { action: string; forwardTo?: string; message?: string }, reasons: string[], where: string): VisualGroupEnd {
  switch (a.action) {
    case 'Disconnect':
    case 'DisconnectWithBusy':
      return a.message ? { kind: 'hangup', message: a.message } : { kind: 'hangup' };
    case 'Voicemail':
      return { kind: 'person_voicemail', who: a.forwardTo ?? '' };
    case 'SharedVoicemail':
      return { kind: 'shared_voicemail', group: a.forwardTo ?? '' };
    case 'Forward':
      return { kind: 'forward', to: a.forwardTo ?? '' };
    default:
      reasons.push(`${where}: "${a.action}" can't be shown here.`);
      return { kind: 'hangup' };
  }
}

export function queueAnswersToGroup(c: FlowCapture<CallQueueWizardAnswers>, reasons: string[] = []): VisualGroup {
  const a = c.answers;
  const ringing = ROUTING_TO_RINGING[a.routingMethod];
  if (!ringing) reasons.push(`${c.name}: rings "${a.routingMethod}", which can't be shown here.`);
  return {
    kind: 'group',
    id: c.flowId,
    name: c.name,
    people: [...a.agents],
    ringing: ringing ?? 'all',
    ringSeconds: a.agentAlertTime,
    maxWaitSeconds: a.timeoutThreshold,
    ifNoAnswer: endFromAnswer(a.timeout, reasons, `${c.name}, no answer`),
    maxWaiting: a.overflowThreshold,
    ifTooBusy: endFromAnswer(a.overflow, reasons, `${c.name}, too busy`),
    ifNobodyAvailable: a.noAgents.action === 'Queue' ? { kind: 'keep_waiting' } : endFromAnswer(a.noAgents, reasons, `${c.name}, nobody available`),
    nobodyAvailableAppliesTo: a.noAgentsApplyTo,
    presenceBased: a.presenceBasedRouting,
    languageId: a.languageId,
  };
}

function targetToStep(t: WizardTarget | undefined, queues: Map<string, FlowCapture<CallQueueWizardAnswers>>, reasons: string[], where: string, inMenu: boolean): VisualOptionStep | VisualStep {
  if (!t) {
    reasons.push(`${where}: has no destination.`);
    return { kind: 'hangup' };
  }
  switch (t.kind) {
    case 'call_queue':
    case 'team': {
      const q = t.flowId ? queues.get(t.flowId) : undefined;
      if (q) return queueAnswersToGroup(q, reasons);
      return t.flowId ? { kind: 'link', flowId: t.flowId, name: t.label ?? '' } : { kind: 'link', name: t.label ?? '' };
    }
    case 'person':
      return { kind: 'person', who: t.label ?? '' };
    case 'voicemail':
      return { kind: 'shared_voicemail', group: t.label ?? '' };
    case 'external':
      return { kind: 'forward', number: t.label ?? '' };
    case 'message':
      if (inMenu) return { kind: 'announcement', text: t.label ?? '' };
      reasons.push(`${where}: plays a message, which only a menu option can do.`);
      return { kind: 'hangup' };
    case 'operator':
      if (inMenu) return { kind: 'operator' };
      reasons.push(`${where}: goes to the operator, which only a menu option can do.`);
      return { kind: 'hangup' };
  }
}

function callFlowToPath(cf: WizardCallFlow, queues: Map<string, FlowCapture<CallQueueWizardAnswers>>, reasons: string[], where: string): VisualPath {
  const greeting = cf.greeting?.trim() ? { greeting: cf.greeting } : {};
  switch (cf.mode) {
    case 'menu':
      return {
        ...greeting,
        then: {
          kind: 'menu',
          ...(cf.menuPrompt?.trim() ? { prompt: cf.menuPrompt.trim() } : {}),
          options: (cf.options ?? []).map((o) => ({
            key: o.key,
            label: o.label,
            ...(o.voiceCommand !== undefined ? { say: o.voiceCommand } : {}),
            then: targetToStep(o.target, queues, reasons, `${where}, option ${o.key}`, true) as VisualOptionStep,
          })),
          ...(cf.allowDialByName !== undefined ? { dialByName: cf.allowDialByName } : {}),
        },
      };
    case 'disconnect':
      return { ...greeting, then: { kind: 'hangup' } };
    case 'voicemail':
      return { ...greeting, then: { kind: 'shared_voicemail', group: cf.target?.label ?? '' } };
    case 'direct': {
      const step = targetToStep(cf.target, queues, reasons, where, false);
      return { ...greeting, then: step as VisualStep };
    }
  }
}

/**
 * Reads saved captures back into the visual model: an auto attendant with the call queue captures it links to, or a call queue
 * on its own. Anything the visual editor can't show is listed in `reasons` (open it in the classic wizard instead).
 */
export function fromCaptures(
  top: { kind: 'auto_attendant'; capture: FlowCapture<AutoAttendantWizardAnswers> } | { kind: 'call_queue'; capture: FlowCapture<CallQueueWizardAnswers> },
  queues: FlowCapture<CallQueueWizardAnswers>[] = [],
  /** a call queue on its own has no time zone; the site's is used */
  site: { timeZoneId: string } = { timeZoneId: '' },
): FromCapturesResult {
  const reasons: string[] = [];
  if (top.kind === 'call_queue') {
    const g = queueAnswersToGroup(top.capture, reasons);
    if (reasons.length) return { ok: false, reasons };
    return { ok: true, attendantFlowId: null, flow: { name: g.name, languageId: g.languageId, timeZoneId: site.timeZoneId, hours: { type: 'always' }, business: { then: g } } };
  }
  const a = top.capture.answers;
  if (a.holidaysEnabled && a.holidays?.length) reasons.push('It has holiday call handling, which the preview doesn’t show yet.');
  if (a.operator) reasons.push('It names an operator, which the preview doesn’t show yet.');
  const byId = new Map(queues.map((q) => [q.flowId, q]));
  const business = callFlowToPath(a.businessFlow, byId, reasons, 'Business hours');
  const afterHours = a.hoursType !== 'always' && a.afterHoursFlow ? callFlowToPath(a.afterHoursFlow, byId, reasons, 'After hours') : undefined;
  if (reasons.length) return { ok: false, reasons };
  const hours: VisualCallFlow['hours'] = a.hoursType === 'custom' ? { type: 'custom', weekly: a.customHours! } : { type: a.hoursType };
  return {
    ok: true,
    attendantFlowId: top.capture.flowId,
    flow: {
      name: top.capture.name,
      languageId: a.languageId,
      timeZoneId: a.timeZoneId,
      ...(a.voiceInputs !== undefined ? { voiceInputs: a.voiceInputs } : {}),
      hours,
      business,
      ...(afterHours ? { afterHours } : {}),
    },
  };
}

/** A new group with the defaults the plan names: everyone rings at once for 30 seconds, then voicemail is chosen by the person. */
export function newVisualGroup(id: string, name: string, languageId: string): VisualGroup {
  return {
    kind: 'group',
    id,
    name,
    people: [],
    ringing: 'all',
    ringSeconds: 30,
    maxWaitSeconds: 1200,
    ifNoAnswer: { kind: 'hangup' },
    maxWaiting: 50,
    ifTooBusy: { kind: 'hangup' },
    ifNobodyAvailable: { kind: 'keep_waiting' },
    nobodyAvailableAppliesTo: 'NewCalls',
    presenceBased: true,
    languageId,
  };
}
