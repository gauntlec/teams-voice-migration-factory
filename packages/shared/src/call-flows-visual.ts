/**
 * Call Flows (preview), step 1 of docs/CALL-FLOWS-WIZARD.md: the model the visual editor works on, in the words a customer uses
 * (a menu, a group of people, a person, voicemail, a forward), and its translation to and from the classic wizards' answers.
 *
 * The visual editor saves exactly what the classic wizards save: one Auto Attendant capture, plus one Call Queue capture per
 * group of people, linked by `flowId` as "Set up a new call queue" does. So import, deployment, diagrams and the handover pack
 * work unchanged. `toCaptures` and `fromCaptures` are each other's inverse for everything the visual editor can express; a
 * classic capture it can't express (an operator, a menu inside a menu) is reported, so the page can offer the classic
 * wizard instead of losing anything.
 */
import { z } from 'zod';
import { AA_SUPPORTED_LANGUAGES, AA_TIME_ZONES } from './domain';
import { wizardWeeklyHoursSchema, type AutoAttendantWizardAnswers, type CallQueueWizardAnswers, type WizardCallFlow, type WizardMenuOption, type WizardTarget, type WizardWeeklyHours } from './wizard';

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
  /** a shared voicemail: the Microsoft 365 group picked from the customer's (`groupId`), typed, or one still to be made (`newGroup`) */
  | { kind: 'shared_voicemail'; group: string; groupId?: string; newGroup?: boolean }
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
  /** days handled differently (docs/CALL-FLOWS-WIZARD.md step 5): Teams checks these first, whatever the hours */
  holidays?: VisualHoliday[];
}

/** A public holiday or closure: its name, its first and last day (inclusive, YYYY-MM-DD), and what happens on it. */
export interface VisualHoliday {
  name: string;
  start: string;
  end: string;
  path: VisualPath;
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
      return { kind: 'voicemail', label: s.group, ...(s.groupId ? { groupId: s.groupId } : {}), ...(s.newGroup ? { newGroup: true } : {}) };
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
  return f.hours.type === 'always' && !f.holidays?.length && !f.business.greeting?.trim() && f.business.then.kind === 'group' ? f.business.then : null;
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
    holidaysEnabled: !!f.holidays?.length,
    ...(f.holidays?.length ? { holidays: f.holidays.map((h) => ({ name: h.name, dateRange: { start: h.start, end: h.end }, flow: pathToCallFlow(h.path, groups) })) } : {}),
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

function voicemailStep(t: WizardTarget | undefined): VisualStep {
  return { kind: 'shared_voicemail', group: t?.label ?? '', ...(t?.groupId ? { groupId: t.groupId } : {}), ...(t?.newGroup ? { newGroup: true } : {}) };
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
      return voicemailStep(t);
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
      return { ...greeting, then: voicemailStep(cf.target) };
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
  if (a.operator) reasons.push('It names an operator, which the preview doesn’t show yet.');
  const byId = new Map(queues.map((q) => [q.flowId, q]));
  const business = callFlowToPath(a.businessFlow, byId, reasons, 'Business hours');
  const afterHours = a.hoursType !== 'always' && a.afterHoursFlow ? callFlowToPath(a.afterHoursFlow, byId, reasons, 'After hours') : undefined;
  const holidays: VisualHoliday[] = a.holidaysEnabled ? (a.holidays ?? []).map((h) => ({ name: h.name, start: h.dateRange.start, end: h.dateRange.end, path: callFlowToPath(h.flow, byId, reasons, `Holiday "${h.name}"`) })) : [];
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
      ...(holidays.length ? { holidays } : {}),
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

/* ------------------------------- step 2: saving, checking, defaults, words ------------------------------- */

/** Every group in the flow, in the order a caller meets them (a group reached from two places appears twice). */
export function visualFlowGroups(f: VisualCallFlow): VisualGroup[] {
  const out: VisualGroup[] = [];
  for (const p of [f.business, f.afterHours, ...(f.holidays ?? []).map((h) => h.path)]) {
    if (!p) continue;
    if (p.then.kind === 'group') out.push(p.then);
    if (p.then.kind === 'menu') for (const o of p.then.options) if (o.then.kind === 'group') out.push(o.then);
  }
  return out;
}

/** The flow with every group replaced by `fn(group)`: the server gives each group its saved capture's id this way. */
export function mapVisualGroups(f: VisualCallFlow, fn: (g: VisualGroup) => VisualGroup): VisualCallFlow {
  const path = (p: VisualPath): VisualPath => {
    const t = p.then;
    if (t.kind === 'group') return { ...p, then: fn(t) };
    if (t.kind === 'menu') return { ...p, then: { ...t, options: t.options.map((o) => (o.then.kind === 'group' ? { ...o, then: fn(o.then) } : o)) } };
    return p;
  };
  return {
    ...f,
    business: path(f.business),
    ...(f.afterHours ? { afterHours: path(f.afterHours) } : {}),
    ...(f.holidays ? { holidays: f.holidays.map((h) => ({ ...h, path: path(h.path) })) } : {}),
  };
}

const text = (max: number) => z.string().trim().max(max);
const need = (max: number) => text(max).min(1);

const groupEndShapes = [
  z.object({ kind: z.literal('hangup'), message: text(1000).optional() }).strict(),
  z.object({ kind: z.literal('person_voicemail'), who: need(200) }).strict(),
  z.object({ kind: z.literal('shared_voicemail'), group: need(200) }).strict(),
  z.object({ kind: z.literal('forward'), to: need(200) }).strict(),
] as const;
const groupEndSchema = z.discriminatedUnion('kind', [...groupEndShapes]);

export const visualGroupSchema = z
  .object({
    kind: z.literal('group'),
    /** the editor's own key for the group; the server gives it its saved capture's id */
    id: need(64),
    name: need(200),
    people: z.array(need(200)).max(50),
    ringing: z.enum(['all', 'in_order', 'longest_idle', 'take_turns']),
    ringSeconds: z.number().int().min(15).max(180),
    maxWaitSeconds: z.number().int().min(0).max(2700),
    ifNoAnswer: groupEndSchema,
    maxWaiting: z.number().int().min(0).max(200),
    ifTooBusy: groupEndSchema,
    ifNobodyAvailable: z.discriminatedUnion('kind', [...groupEndShapes, z.object({ kind: z.literal('keep_waiting') }).strict()]),
    nobodyAvailableAppliesTo: z.enum(['NewCalls', 'AllCalls']),
    presenceBased: z.boolean(),
    languageId: need(20),
  })
  .strict();

const stepShapes = [
  visualGroupSchema,
  z.object({ kind: z.literal('person'), who: need(200) }).strict(),
  z.object({ kind: z.literal('shared_voicemail'), group: need(200), groupId: z.guid().optional(), newGroup: z.boolean().optional() }).strict(),
  z.object({ kind: z.literal('forward'), number: need(200) }).strict(),
  z.object({ kind: z.literal('link'), flowId: z.guid().optional(), name: need(200) }).strict(),
] as const;
const hangupShape = z.object({ kind: z.literal('hangup') }).strict();

const menuShape = z
  .object({
    kind: z.literal('menu'),
    prompt: text(1000).optional(),
    options: z
      .array(
        z
          .object({
            key: need(4),
            label: need(100),
            say: text(256).optional(),
            then: z.discriminatedUnion('kind', [...stepShapes, z.object({ kind: z.literal('announcement'), text: need(1000) }).strict(), z.object({ kind: z.literal('operator') }).strict()]),
          })
          .strict(),
      )
      .max(12),
    dialByName: z.boolean().optional(),
  })
  .strict();

const visualPathSchema = z.object({ greeting: text(1000).optional(), then: z.discriminatedUnion('kind', [menuShape, ...stepShapes, hangupShape]) }).strict();

export const visualCallFlowSchema = z
  .object({
    name: need(200),
    languageId: need(20),
    timeZoneId: need(80),
    voiceInputs: z.boolean().optional(),
    hours: z.discriminatedUnion('type', [
      z.object({ type: z.literal('always') }).strict(),
      z.object({ type: z.literal('standard') }).strict(),
      z.object({ type: z.literal('custom'), weekly: wizardWeeklyHoursSchema }).strict(),
    ]),
    business: visualPathSchema,
    afterHours: visualPathSchema.optional(),
    holidays: z
      .array(z.object({ name: need(160), start: text(10), end: text(10), path: visualPathSchema }).strict())
      .max(10)
      .optional(),
  })
  .strict();

/** POST .../discovery/call-flows: a call flow made in Call Flows (preview), answered by one of the site's spare numbers. */
export const saveVisualCallFlowSchema = z
  .object({
    site_id: z.guid(),
    phone_number_id: z.guid(),
    flow: visualCallFlowSchema,
    /** the number goes straight to the flow's one group (a call queue), with no auto attendant in front (decided 10 Nov 2026: in front by default) */
    straight_to_queue: z.boolean().optional(),
  })
  .strict();
export type SaveVisualCallFlowInput = z.infer<typeof saveVisualCallFlowSchema>;

/** Which wizard made a Call flow capture: 'call-flows' = Call Flows (preview), so it can reopen there. null = a classic wizard. */
export const FLOW_EDITORS = ['call-flows'] as const;
export type FlowEditor = (typeof FLOW_EDITORS)[number];

function endProblem(e: VisualGroupEnd | { kind: 'keep_waiting' }, where: string): string | null {
  if (e.kind === 'person_voicemail' && !e.who.trim()) return `${where}: choose whose voicemail.`;
  if (e.kind === 'shared_voicemail' && !e.group.trim()) return `${where}: choose the voicemail group.`;
  if (e.kind === 'forward' && !e.to.trim()) return `${where}: type the person or number calls go to.`;
  return null;
}

function stepProblem(s: VisualOptionStep | VisualStep, where: string): string | null {
  switch (s.kind) {
    case 'group': {
      const name = s.name.trim();
      if (!name) return `${where}: give the group a name, for example "Sales".`;
      if (!s.people.some((p) => p.trim())) return `${where}: add at least one person to the group "${name}".`;
      return endProblem(s.ifNoAnswer, `${name}, if nobody answers`) ?? endProblem(s.ifTooBusy, `${name}, if too many are waiting`) ?? endProblem(s.ifNobodyAvailable, `${name}, if nobody is available`);
    }
    case 'person':
      return s.who.trim() ? null : `${where}: choose the person.`;
    case 'shared_voicemail':
      return s.group.trim() ? null : `${where}: choose the voicemail group, or type the name of a new one.`;
    case 'forward':
      return s.number.trim() ? null : `${where}: type the number calls are forwarded to.`;
    case 'link':
      return s.name.trim() ? null : `${where}: choose the call flow.`;
    case 'announcement':
      return s.text.trim() ? null : `${where}: type the message callers hear.`;
    default:
      return null;
  }
}

/** What's missing from one path (business hours, or after hours), in words, or null: each screen of the preview checks its own. */
export function visualPathProblem(p: VisualPath | undefined, where: string): string | null {
  if (!p) return `${where}: choose what happens.`;
  const t = p.then;
  if (t.kind === 'hangup') return p.greeting?.trim() ? null : `${where}: type the message callers hear before the call ends.`;
  if (t.kind !== 'menu') return stepProblem(t, where);
  if (t.options.length === 0) return `${where}: add at least one menu option.`;
  for (const [i, o] of t.options.entries()) {
    const button = `${where}, button ${o.key.trim() || i + 1}`;
    if (!o.key.trim()) return `${where}: choose which button option ${i + 1} uses.`;
    if (!o.label.trim()) return `${button}: give it a name, for example "Sales".`;
    const step = stepProblem(o.then, button);
    if (step) return step;
  }
  const keys = t.options.map((o) => o.key.trim());
  const dup = keys.find((k, i) => keys.indexOf(k) !== i);
  return dup ? `${where}: button ${dup} is used twice. Give each option its own button.` : null;
}

/** The first thing missing from a visual flow, in words, or null. The wizard checks each screen with this, and the server once more. */
export function visualCallFlowProblem(f: VisualCallFlow): string | null {
  if (!f.name.trim()) return 'Give the call flow a name, for example "Main Line".';
  const always = f.hours.type === 'always';
  if (f.hours.type === 'custom' && !Object.values(f.hours.weekly).some((d) => d.length > 0)) return 'Choose at least one day the business is open.';
  // holidays first, as Teams checks them first and the canvas draws them first
  return (
    (f.holidays ?? []).reduce<string | null>((found, h, i) => found ?? visualHolidayProblem(h, i) ?? visualPathProblem(h.path, holidayWhere(h, i)), null) ??
    visualPathProblem(f.business, always ? 'When someone calls' : 'During business hours') ??
    (always ? null : visualPathProblem(f.afterHours, 'After hours'))
  );
}

const holidayWhere = (h: VisualHoliday, i: number) => (h.name.trim() ? `Holiday "${h.name.trim()}"` : `Holiday ${i + 1}`);
const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

/** What's missing from a holiday's name and dates (not what happens on it), in words, or null. */
export function visualHolidayProblem(h: VisualHoliday, i: number): string | null {
  if (!h.name.trim()) return `Give holiday ${i + 1} a name, for example "Christmas Day".`;
  const where = holidayWhere(h, i);
  if (!ISO_DAY.test(h.start) || !ISO_DAY.test(h.end)) return `${where}: choose the first and last day.`;
  if (h.end < h.start) return `${where}: the last day is before the first day.`;
  return null;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/** "25 Dec 2026", or "24 Dec 2026 to 2 Jan 2027". */
export function visualHolidayDates(h: Pick<VisualHoliday, 'start' | 'end'>): string {
  const day = (d: string) => (ISO_DAY.test(d) ? `${Number(d.slice(8, 10))} ${MONTHS[Number(d.slice(5, 7)) - 1]} ${d.slice(0, 4)}` : 'no date');
  return !h.end || h.end === h.start ? day(h.start) : `${day(h.start)} to ${day(h.end)}`;
}

/* defaults from the site: the plan's "language and time zone from the site's country and address" */

const US_ZONES: Record<string, string> = {
  ...Object.fromEntries(['CA', 'WA', 'OR', 'NV'].map((s) => [s, 'Pacific Standard Time'])),
  ...Object.fromEntries(['CO', 'UT', 'NM', 'WY', 'MT', 'ID'].map((s) => [s, 'Mountain Standard Time'])),
  AZ: 'US Mountain Standard Time',
  ...Object.fromEntries(['TX', 'IL', 'MN', 'WI', 'IA', 'MO', 'AR', 'LA', 'MS', 'AL', 'OK', 'KS', 'NE', 'SD', 'ND', 'TN'].map((s) => [s, 'Central Standard Time'])),
  AK: 'Alaskan Standard Time',
  HI: 'Hawaiian Standard Time',
};
/** A state written out in an address ("West Valley City, Utah, 84119"), by its two-letter code. */
const US_STATE_NAMES: Record<string, string> = {
  alabama: 'AL', alaska: 'AK', arizona: 'AZ', arkansas: 'AR', california: 'CA', colorado: 'CO', connecticut: 'CT', delaware: 'DE', florida: 'FL', georgia: 'GA',
  hawaii: 'HI', idaho: 'ID', illinois: 'IL', indiana: 'IN', iowa: 'IA', kansas: 'KS', kentucky: 'KY', louisiana: 'LA', maine: 'ME', maryland: 'MD',
  massachusetts: 'MA', michigan: 'MI', minnesota: 'MN', mississippi: 'MS', missouri: 'MO', montana: 'MT', nebraska: 'NE', nevada: 'NV', 'new hampshire': 'NH',
  'new jersey': 'NJ', 'new mexico': 'NM', 'new york': 'NY', 'north carolina': 'NC', 'north dakota': 'ND', ohio: 'OH', oklahoma: 'OK', oregon: 'OR',
  pennsylvania: 'PA', 'rhode island': 'RI', 'south carolina': 'SC', 'south dakota': 'SD', tennessee: 'TN', texas: 'TX', utah: 'UT', vermont: 'VT',
  virginia: 'VA', washington: 'WA', 'west virginia': 'WV', wisconsin: 'WI', wyoming: 'WY', 'district of columbia': 'DC',
};

const US_STATES = new Set([...Object.keys(US_ZONES), 'NY', 'NJ', 'PA', 'MA', 'CT', 'RI', 'NH', 'VT', 'ME', 'DE', 'MD', 'DC', 'VA', 'WV', 'NC', 'SC', 'GA', 'FL', 'OH', 'MI', 'IN', 'KY']);

const COUNTRY_DEFAULTS: [RegExp, string, string][] = [
  [/^(gb|uk|united kingdom|great britain|england|scotland|wales|northern ireland)$/, 'en-GB', 'GMT Standard Time'],
  [/^(ie|ireland|republic of ireland)$/, 'en-IE', 'GMT Standard Time'],
  [/^(au|australia)$/, 'en-AU', 'AUS Eastern Standard Time'],
  [/^(ca|canada)$/, 'en-CA', 'Eastern Standard Time'],
  [/^(in|india)$/, 'en-IN', 'India Standard Time'],
  [/^(za|south africa)$/, 'en-ZA', 'South Africa Standard Time'],
  [/^(nz|new zealand)$/, 'en-GB', 'New Zealand Standard Time'],
  [/^(fr|france)$/, 'fr-FR', 'Romance Standard Time'],
  [/^(de|germany|deutschland)$/, 'de-DE', 'W. Europe Standard Time'],
  [/^(nl|netherlands|the netherlands)$/, 'nl-NL', 'W. Europe Standard Time'],
  [/^(es|spain)$/, 'es-ES', 'Romance Standard Time'],
  [/^(it|italy)$/, 'it-IT', 'W. Europe Standard Time'],
];

/**
 * The language and time zone a new call flow starts with, from the site's country and (in the US) the state in its address. Anything
 * not recognised gets US English and Eastern time, as the classic wizard does; the review screen shows both and they can be changed.
 */
export function callFlowDefaultsForSite(site: { country?: string | null; address?: string | null }): { languageId: string; timeZoneId: string } {
  const country = (site.country ?? '').trim().toLowerCase().replace(/\./g, '');
  const known = (lang: string, tz: string) => ({
    languageId: AA_SUPPORTED_LANGUAGES.some((l) => l.code === lang) ? lang : 'en-US',
    timeZoneId: AA_TIME_ZONES.some((z) => z.id === tz) ? tz : 'Eastern Standard Time',
  });
  for (const [re, lang, tz] of COUNTRY_DEFAULTS) if (re.test(country)) return known(lang, tz);
  if (!country || /^(us|usa|united states|united states of america|america)$/.test(country)) {
    // "…, Austin, TX 78701" or "…, Austin, TX": the address in words; a state's two capitals just before a ZIP, else the last ones
    const words = (site.address ?? '').split(/[^A-Za-z0-9-]+/).filter(Boolean);
    const isState = (w: string | undefined): w is string => !!w && w.length === 2 && w === w.toUpperCase() && US_STATES.has(w);
    let state: string | undefined;
    for (let i = 1; i < words.length; i++) if (/^\d{5}(-\d{4})?$/.test(words[i]!) && isState(words[i - 1])) state = words[i - 1];
    state ??= words.filter(isState).at(-1);
    // else a state written out: the last part of the address that is one ("…, West Virginia, 25301" is not Virginia)
    if (!state) {
      const parts = (site.address ?? '').toLowerCase().split(/[,\n]/).map((x) => x.replace(/[^a-z ]/g, ' ').replace(/ +/g, ' ').trim());
      for (const part of parts) {
        const named = Object.keys(US_STATE_NAMES).filter((n) => part === n || part.endsWith(` ${n}`) || part.startsWith(`${n} `));
        const longest = named.sort((a, b) => b.length - a.length)[0];
        if (longest) state = US_STATE_NAMES[longest];
      }
    }
    return known('en-US', (state && US_ZONES[state]) || 'Eastern Standard Time');
  }
  return known('en-US', 'Eastern Standard Time');
}

/* the review screen's words */

const RINGING_WORDS: Record<VisualRinging, string> = {
  all: 'everyone at once',
  in_order: 'one after another, in order',
  longest_idle: 'whoever has been free longest first',
  take_turns: 'taking turns',
};

function endWords(e: VisualGroupEnd | { kind: 'keep_waiting' }): string {
  switch (e.kind) {
    case 'hangup':
      return e.message?.trim() ? `plays "${e.message.trim()}" and hangs up` : 'hangs up';
    case 'person_voicemail':
      return `goes to ${e.who}'s voicemail`;
    case 'shared_voicemail':
      return `goes to the shared voicemail "${e.group}"`;
    case 'forward':
      return `is forwarded to ${e.to}`;
    case 'keep_waiting':
      return 'keeps waiting';
  }
}

export function visualStepWords(s: VisualOptionStep | VisualStep): string {
  switch (s.kind) {
    case 'group': {
      const n = s.people.filter((p) => p.trim()).length;
      return `rings the group "${s.name}" (${n} ${n === 1 ? 'person' : 'people'}, ${RINGING_WORDS[s.ringing]}); if nobody answers, the call ${endWords(s.ifNoAnswer)}`;
    }
    case 'person':
      return `rings ${s.who}`;
    case 'shared_voicemail':
      return `goes to the shared voicemail "${s.group}"${s.newGroup ? ' (a group still to be made)' : ''}`;
    case 'forward':
      return `is forwarded to ${s.number}`;
    case 'link':
      return `goes to the call flow "${s.name}"`;
    case 'announcement':
      return `plays "${s.text}", then the menu again`;
    case 'operator':
      return 'goes to the operator';
    case 'hangup':
      return 'hangs up';
  }
}

const DAY_ORDER: (keyof WizardWeeklyHours)[] = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];
const DAY_NAMES: Record<keyof WizardWeeklyHours, string> = { monday: 'Monday', tuesday: 'Tuesday', wednesday: 'Wednesday', thursday: 'Thursday', friday: 'Friday', saturday: 'Saturday', sunday: 'Sunday' };

export function visualHoursWords(h: VisualCallFlow['hours']): string {
  if (h.type === 'always') return 'It works the same way all the time.';
  if (h.type === 'standard') return 'Business hours are Monday to Friday, 9:00 to 17:00.';
  const open = DAY_ORDER.filter((d) => h.weekly[d].length);
  if (open.length === 0) return 'No business hours are set.';
  const span = (d: keyof WizardWeeklyHours) => h.weekly[d].map((r) => `${r.start} to ${r.end}`).join(' and ');
  const weekdays = DAY_ORDER.slice(0, 5);
  if (weekdays.every((d) => h.weekly[d].length && span(d) === span('monday'))) {
    const rest = open.filter((d) => !weekdays.includes(d)).map((d) => `${DAY_NAMES[d]} ${span(d)}`);
    return `Business hours are Monday to Friday, ${span('monday')}${rest.length ? `; ${rest.join('; ')}` : ''}.`;
  }
  return `Business hours are ${open.map((d) => `${DAY_NAMES[d]} ${span(d)}`).join('; ')}.`;
}

function pathWords(p: VisualPath, heading: string): string[] {
  const lines: string[] = [];
  const greet = p.greeting?.trim() ? `plays "${p.greeting.trim()}", then ` : '';
  const t = p.then;
  if (t.kind === 'menu') {
    lines.push(`${heading}: ${greet}offers a menu${t.prompt?.trim() ? ` ("${t.prompt.trim()}")` : ''}:`);
    for (const o of t.options) lines.push(`  · press ${o.key}${o.say?.trim() ? ` or say "${o.say.trim()}"` : ''} for ${o.label}: the call ${visualStepWords(o.then)}`);
  } else if (t.kind === 'hangup') {
    lines.push(`${heading}: plays "${p.greeting?.trim() ?? ''}" and hangs up.`);
  } else {
    lines.push(`${heading}: ${greet}the call ${visualStepWords(t)}.`);
  }
  return lines;
}

/** The written summary on the review screen, like the handover pack's. */
export function visualFlowSummary(f: VisualCallFlow, number: string | null): string[] {
  const always = f.hours.type === 'always';
  return [
    `"${f.name}"${number ? ` answers calls to ${number}` : ''}.`,
    visualHoursWords(f.hours),
    ...pathWords(f.business, always ? 'When someone calls' : 'During business hours'),
    ...(!always && f.afterHours ? pathWords(f.afterHours, 'After hours') : []),
    ...(f.holidays ?? []).flatMap((h, i) => pathWords(h.path, `${holidayWhere(h, i)} (${visualHolidayDates(h)})`)),
  ];
}

/** What Voxshift will create, in plain words with the Teams name alongside. */
export function visualFlowCreates(f: VisualCallFlow, opts: { straightToQueue?: boolean; number?: string | null } = {}): { plain: string; teams: string; name: string }[] {
  const straight = opts.straightToQueue ? onlyRingsAGroup(f) : null;
  const top = straight ? straight.name : f.name;
  const out = [{ plain: opts.number ? `The number ${opts.number}, answered for the call flow` : 'The number, answered for the call flow', teams: 'resource account', name: top }];
  if (!straight) out.push({ plain: 'A phone menu that answers the number', teams: 'auto attendant', name: f.name });
  const seen = new Set<string>();
  for (const g of straight ? [straight] : visualFlowGroups(f)) {
    if (seen.has(g.id)) continue;
    seen.add(g.id);
    out.push({ plain: 'A group of people who answer together', teams: 'call queue', name: g.name });
  }
  return out;
}

/* ------------------------------- step 3: the canvas ------------------------------- */

/**
 * Where a box on the canvas points in the flow, so clicking it opens the right panel:
 * - 'front': the number and the flow's name (or, straight to a group, that group: see `front`'s address);
 * - 'business' / 'after': a path's greeting and its menu or its one step;
 * - 'business.then' / 'after.then': a path's one step (not a menu);
 * - 'business.o2' / 'after.o0': a menu option (its button, its words, and what it does).
 */
export type VisualPathKey = 'business' | 'after' | `h${number}`;
export type VisualAddress = 'front' | VisualPathKey | `${VisualPathKey}.then` | `${VisualPathKey}.o${number}`;

/** What can follow a box, offered as a + on it. */
export type VisualPlus = { kind: 'choose'; label: string } | { kind: 'add_option'; label: string } | { kind: 'if_no_answer'; label: string } | { kind: 'add_holiday'; label: string };

export interface VisualCanvas {
  graph: import('./call-flow-graph').CallFlowGraph;
  /** each box's address (the agents box under a group is its group's) */
  addressOf: Record<string, VisualAddress>;
  /** boxes with a + on them */
  plus: Record<string, VisualPlus>;
  /** what is still missing, box by box, in the order the checks find it (the first is visualCallFlowProblem's) */
  problems: { nodeId: string; message: string }[];
  /** the boxes as a list, in order, for the keyboard and screen readers: what leads to each box, and how deep it is */
  outline: { nodeId: string; text: string; depth: number }[];
}

const clip = (s: string | undefined, n = 80) => {
  const t = (s ?? '').trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t || undefined;
};

/**
 * The flow drawn as the Call flows tab and the handover pack draw one (the same CallFlowGraph, the same renderer), with each box's
 * address in the flow and the + offered where something can follow. A group is one box however many options reach it.
 */
export function visualFlowCanvas(f: VisualCallFlow, opts: { number?: string | null; straightToQueue?: boolean } = {}): VisualCanvas {
  type Node = import('./call-flow-graph').CallFlowNode;
  type Edge = import('./call-flow-graph').CallFlowEdge;
  type Branch = import('./call-flow-graph').CallFlowBranch;
  const nodes: Node[] = [];
  const edges: Edge[] = [];
  const addressOf: Record<string, VisualAddress> = {};
  const plus: Record<string, VisualPlus> = {};
  const problems: { nodeId: string; message: string }[] = [];
  const problem = (nodeId: string, message: string | null) => {
    if (!message) return;
    problems.push({ nodeId, message });
    const n = nodes.find((x) => x.id === nodeId);
    // on the box, the words after "where:" (the box says where)
    const short = message.includes(': ') ? message.slice(message.indexOf(': ') + 2) : message;
    if (n && !n.warnings?.includes(short)) n.warnings = [...(n.warnings ?? []), short.charAt(0).toUpperCase() + short.slice(1)];
  };
  const node = (n: Node, address: VisualAddress) => {
    if (!nodes.some((x) => x.id === n.id)) nodes.push(n);
    addressOf[n.id] ??= address;
    return n.id;
  };
  const edge = (source: string, target: string, label: string, branch: Branch) => {
    const id = `${source}->${target}`;
    const same = edges.find((e) => e.id === id);
    if (same) {
      if (!same.label.split(' + ').includes(label)) same.label = `${same.label} + ${label}`;
    } else edges.push({ id, source, target, label, branch });
  };

  const endNode = (groupId: string, which: string, e: VisualGroupEnd, address: VisualAddress): string => {
    const id = `${groupId}:${which}`;
    switch (e.kind) {
      case 'hangup':
        return node({ id, kind: 'disconnect', label: 'Hang up', sublabel: clip(e.message) }, address);
      case 'person_voicemail':
        return node({ id, kind: 'voicemail', label: 'Voicemail', sublabel: e.who || undefined }, address);
      case 'shared_voicemail':
        return node({ id, kind: 'shared_voicemail', label: 'Shared voicemail', sublabel: e.group || 'Choose the group' }, address);
      case 'forward':
        return node({ id, kind: e.to.trim().includes('@') ? 'person' : 'external_number', label: e.to.trim() || 'Choose where to forward' }, address);
    }
  };

  const groupNode = (g: VisualGroup, address: VisualAddress, extra: Partial<Node> = {}): string => {
    const people = g.people.map((p) => p.trim()).filter(Boolean);
    const id = node(
      {
        id: `group:${g.id}`,
        kind: 'call_queue',
        label: g.name.trim() || 'New group',
        sublabel: `${RINGING_WORDS[g.ringing][0]!.toUpperCase()}${RINGING_WORDS[g.ringing].slice(1)} · ${g.ringSeconds}s each`,
        agents: people.length ? people : undefined,
        ...extra,
      },
      address,
    );
    edge(id, endNode(`group:${g.id}`, 'timeout', g.ifNoAnswer, address), 'Nobody answers', 'timeout');
    if (!(g.ifTooBusy.kind === 'hangup' && !g.ifTooBusy.message)) edge(id, endNode(`group:${g.id}`, 'overflow', g.ifTooBusy, address), `More than ${g.maxWaiting} waiting`, 'overflow');
    if (g.ifNobodyAvailable.kind !== 'keep_waiting') edge(id, endNode(`group:${g.id}`, 'no_agent', g.ifNobodyAvailable, address), 'Nobody signed in', 'no_agent');
    if (g.ifNoAnswer.kind === 'hangup') plus[id] = { kind: 'if_no_answer', label: 'If nobody answers' };
    return id;
  };

  const stepNode = (s: VisualStep | VisualOptionStep, id: string, address: VisualAddress): string => {
    switch (s.kind) {
      case 'group':
        return groupNode(s, address);
      case 'person':
        return node({ id, kind: 'person', label: s.who.trim() || 'Choose the person' }, address);
      case 'shared_voicemail':
        return node({ id, kind: 'shared_voicemail', label: 'Shared voicemail', sublabel: s.group.trim() || 'Choose the group' }, address);
      case 'forward':
        return node({ id, kind: 'external_number', label: s.number.trim() || 'Choose the number' }, address);
      case 'link':
        return node({ id, kind: 'auto_attendant', label: s.name.trim() || 'Choose the call flow', sublabel: 'Another call flow' }, address);
      case 'announcement':
        return node({ id, kind: 'announcement', label: 'Plays a message', sublabel: clip(s.text) ?? 'Type the message', details: ['Then the menu again'] }, address);
      case 'operator':
        return node({ id, kind: 'operator', label: 'Operator' }, address);
      case 'hangup':
        return node({ id, kind: 'disconnect', label: 'Hang up' }, address);
    }
  };

  const always = f.hours.type === 'always';
  const straight = opts.straightToQueue ? onlyRingsAGroup({ ...f, business: { then: f.business.then } }) : null;
  const numberLine = opts.number ? [opts.number] : ['No number chosen'];
  if (straight) {
    const id = groupNode(straight, 'business.then', { badge: 'Front door', details: numberLine });
    problem(id, stepProblem(straight, 'When someone calls'));
    return { graph: { nodes, edges }, addressOf, plus, problems, outline: outlineOf(nodes, edges) };
  }

  const front = node({ id: 'front', kind: 'auto_attendant', label: f.name.trim() || 'New call flow', badge: 'Front door', details: [...numberLine, ...(always ? [] : [visualHoursWords(f.hours).replace(/^Business hours are /, 'Open ').replace(/\.$/, '')])] }, 'front');
  if (!f.name.trim()) problem(front, 'Give the call flow a name, for example "Main Line".');
  if (f.hours.type === 'custom' && !Object.values(f.hours.weekly).some((d) => d.length > 0)) problem(front, 'Choose at least one day the business is open.');
  if ((f.holidays?.length ?? 0) < 10) plus[front] = { kind: 'add_holiday', label: 'Add a holiday' };
  // Teams checks a holiday first, so holidays are drawn first
  const paths: [VisualPathKey, VisualPath | undefined, string, Branch, string, string[]?][] = (f.holidays ?? []).map((h, i) => [
    `h${i}` as VisualPathKey,
    h.path,
    h.name.trim() ? `Holiday: ${h.name.trim()}` : `Holiday ${i + 1}`,
    'holiday' as Branch,
    holidayWhere(h, i),
    [visualHolidayDates(h)],
  ]);
  paths.push(['business', f.business, always ? 'Every call' : 'Business hours', 'business_hours', always ? 'When someone calls' : 'During business hours']);
  if (!always) paths.push(['after', f.afterHours, 'After hours', 'after_hours', 'After hours']);
  for (const [key, p, label, branch, where, details] of paths) {
    const pathId = node({ id: key, kind: 'auto_attendant', label, sublabel: p?.greeting?.trim() ? `"${clip(p.greeting, 60)}"` : undefined, details }, key);
    edge(front, pathId, branch === 'holiday' ? 'Holiday' : label, branch);
    if (branch === 'holiday') problem(pathId, visualHolidayProblem(f.holidays![Number(key.slice(1))]!, Number(key.slice(1))));
    if (!p) {
      plus[pathId] = { kind: 'choose', label: 'Choose what happens' };
      problem(pathId, `${where}: choose what happens.`);
      continue;
    }
    const t = p.then;
    if (t.kind === 'menu') {
      const n = nodes.find((x) => x.id === pathId)!;
      n.details = [...(details ?? []), t.options.length ? `Menu: ${t.options.length} option${t.options.length === 1 ? '' : 's'}` : 'Menu: no options yet'];
      if (t.options.length < 10) plus[pathId] = { kind: 'add_option', label: 'Add an option' };
      if (!t.options.length) problem(pathId, `${where}: add at least one menu option.`);
      const keys = t.options.map((o) => o.key.trim());
      t.options.forEach((o, i) => {
        const address = `${key}.o${i}` as VisualAddress;
        const target = stepNode(o.then, `${key}:o${i}`, address);
        edge(pathId, target, `Press ${o.key}${o.label.trim() ? `: ${clip(o.label, 24)}` : ''}`, branch);
        const button = `${where}, button ${o.key.trim() || i + 1}`;
        if (!o.label.trim()) problem(target, `${button}: give it a name, for example "Sales".`);
        problem(target, stepProblem(o.then, button));
        if (keys.indexOf(o.key.trim()) !== i) problem(target, `${where}: button ${o.key.trim()} is used twice. Give each option its own button.`);
      });
    } else if (t.kind === 'hangup') {
      edge(pathId, node({ id: `${key}:hangup`, kind: 'disconnect', label: 'Hang up' }, `${key}.then`), 'Then', branch);
      if (!p.greeting?.trim()) problem(pathId, `${where}: type the message callers hear before the call ends.`);
    } else {
      const target = stepNode(t, `${key}:then`, `${key}.then`);
      edge(pathId, target, 'Then', branch);
      problem(target, stepProblem(t, where));
    }
  }
  return { graph: { nodes, edges }, addressOf, plus, problems, outline: outlineOf(nodes, edges) };
}

/** The boxes in order, each with the line that leads to it ("Press 1: Sales") and how far from the front door it is. */
function outlineOf(nodes: import('./call-flow-graph').CallFlowNode[], edges: import('./call-flow-graph').CallFlowEdge[]): VisualCanvas['outline'] {
  const depth = new Map<string, number>();
  return nodes.map((n) => {
    const into = edges.find((e) => e.target === n.id && depth.has(e.source));
    const d = into ? depth.get(into.source)! + 1 : 0;
    depth.set(n.id, d);
    const what = [n.badge === 'Front door' ? 'Front door' : null, n.label, n.sublabel].filter(Boolean).join(', ');
    // the line's words, unless the box already starts with them ("Business hours", "Holiday: Christmas")
    const text = into && !n.label.startsWith(into.label) ? `${into.label}: ${what}` : what;
    return { nodeId: n.id, text: n.warnings?.length ? `${text} (still to do)` : text, depth: d };
  });
}

/* ------------------------------- step 4: reopening ------------------------------- */

/** PUT .../discovery/call-flows/:flowId: a call flow made in Call Flows (preview), changed there. The number stays as it is. */
export const updateVisualCallFlowSchema = z
  .object({
    flow: visualCallFlowSchema,
    /** must match how it was saved: straight to the group, or an auto attendant in front */
    straight_to_queue: z.boolean().optional(),
  })
  .strict();
export type UpdateVisualCallFlowInput = z.infer<typeof updateVisualCallFlowSchema>;

/** The Call flow captures an auto attendant's answers point at by id (its menu options and direct steps, every path). */
export function attendantFlowIds(a: AutoAttendantWizardAnswers): string[] {
  const ids = new Set<string>();
  const flows = [a.businessFlow, a.afterHoursFlow, ...(a.holidays ?? []).map((h) => h.flow)];
  for (const cf of flows) {
    if (!cf) continue;
    if (cf.target?.flowId) ids.add(cf.target.flowId);
    for (const o of cf.options ?? []) if (o.target.flowId) ids.add(o.target.flowId);
  }
  if (a.operator?.flowId) ids.add(a.operator.flowId);
  return [...ids];
}

/** A saved Call flow row, as the list and the server read it. */
export interface VisualFlowRow {
  id: string;
  kind: string;
  name: string;
  wizard_answers: unknown;
  editor?: string | null;
  resource_account_id?: string | null;
}

/**
 * The saved flow a preview capture belongs to, read back into the preview: an auto attendant with the groups it made, or a group the number
 * goes straight to. A group the preview made inside an auto attendant opens that auto attendant. Only the preview's own captures are
 * groups to edit; any other capture an option points at stays a link to "another call flow".
 */
export function visualFlowFromRows(
  row: VisualFlowRow,
  rows: VisualFlowRow[],
  site: { timeZoneId: string },
): (FromCapturesResult & { top: VisualFlowRow; straightToQueue: boolean }) | { ok: false; reasons: string[]; top: VisualFlowRow | null } {
  let top: VisualFlowRow | undefined = row;
  if (row.kind === 'call_queue' && !row.resource_account_id) {
    top = rows.find((r) => r.kind === 'auto_attendant' && r.editor === 'call-flows' && !!r.wizard_answers && attendantFlowIds(r.wizard_answers as AutoAttendantWizardAnswers).includes(row.id));
    if (!top) return { ok: false, top: null, reasons: ['This group isn’t part of a call flow made in the preview.'] };
  }
  if (!top.wizard_answers) return { ok: false, top, reasons: ['It has no answers saved.'] };
  if (top.kind === 'call_queue') {
    const r = fromCaptures({ kind: 'call_queue', capture: { flowId: top.id, name: top.name, answers: top.wizard_answers as CallQueueWizardAnswers } }, [], site);
    return { ...r, top, straightToQueue: true };
  }
  const answers = top.wizard_answers as AutoAttendantWizardAnswers;
  const ids = new Set(attendantFlowIds(answers));
  const queues = rows
    .filter((r) => ids.has(r.id) && r.kind === 'call_queue' && r.editor === 'call-flows' && !!r.wizard_answers)
    .map((r) => ({ flowId: r.id, name: r.name, answers: r.wizard_answers as CallQueueWizardAnswers }));
  const r = fromCaptures({ kind: 'auto_attendant', capture: { flowId: top.id, name: top.name, answers } }, queues, site);
  return { ...r, top, straightToQueue: false };
}
