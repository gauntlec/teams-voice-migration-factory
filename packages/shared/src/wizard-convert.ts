import type { AutoAttendantCallableEntity, AutoAttendantCallFlow, AutoAttendantMenuOption, AutoAttendantSchedule } from './deployment';
import type { BuildAutoAttendantCreateInput, BuildCallQueueCreateInput } from './dto';
import type { AutoAttendantWizardAnswers, CallQueueWizardAnswers, WizardCallFlow, WizardMenuOption, WizardTarget, WizardWeeklyHours } from './wizard';

/**
 * Converts the AA/CQ creation wizard's plain-language capture into a real,
 * deployable `build_auto_attendants`/`build_call_queues` row - the "Import
 * to Design & Build" action (Data Collection's Call flows tab). Pure and
 * DB-free by design: anything that needs a live lookup (matching a
 * free-text person's name to a synced user, or a department name to an
 * already-built Call Queue/Auto Attendant) is injected by the caller via
 * `WizardResolvers`, so this module stays testable and has no knowledge of
 * tenantDb.
 *
 * A person or department that doesn't match anything synced is never
 * dropped - it's carried through as typed (the wizard's whole point is to
 * let an engineer add someone who isn't synced yet), and flagged in the
 * returned `warnings` so it's easy to find and confirm/fix after import.
 * Only a genuinely empty/unset answer produces no destination.
 */

export interface WizardResolvers {
  /** Exact match against a synced tenant user (by UPN or display name) - returns their canonical UPN, or undefined if nothing matches. */
  resolvePerson: (label: string) => string | undefined;
  /** Exact match against this site's existing build_call_queues/build_auto_attendants (by name) - returns its kind + id, or undefined if nothing matches. */
  resolveTeam: (label: string) => { kind: 'call_queue' | 'auto_attendant'; buildId: string } | undefined;
  /** Resolves a specific Call flows capture (set via "Set up a new call queue", not typed) to its already-imported build row - undefined if that capture hasn't been imported yet. */
  resolveFlow: (flowId: string) => { kind: 'call_queue' | 'auto_attendant'; buildId: string } | undefined;
}
const NO_RESOLVERS: WizardResolvers = { resolvePerson: () => undefined, resolveTeam: () => undefined, resolveFlow: () => undefined };

const DTMF_BY_DIGIT: Record<string, AutoAttendantMenuOption['dtmf']> = {
  '0': 'Tone0',
  '1': 'Tone1',
  '2': 'Tone2',
  '3': 'Tone3',
  '4': 'Tone4',
  '5': 'Tone5',
  '6': 'Tone6',
  '7': 'Tone7',
  '8': 'Tone8',
  '9': 'Tone9',
};

const STANDARD_9_TO_5: WizardWeeklyHours = {
  monday: [{ start: '09:00', end: '17:00' }],
  tuesday: [{ start: '09:00', end: '17:00' }],
  wednesday: [{ start: '09:00', end: '17:00' }],
  thursday: [{ start: '09:00', end: '17:00' }],
  friday: [{ start: '09:00', end: '17:00' }],
  saturday: [],
  sunday: [],
};

function convertTarget(t: WizardTarget | undefined, resolvers: WizardResolvers, warnings: string[], where: string): AutoAttendantCallableEntity | undefined {
  if (!t) return undefined;
  switch (t.kind) {
    case 'person': {
      const label = (t.label ?? '').trim();
      if (!label) {
        warnings.push(`${where}: no name or email was entered.`);
        return { kind: 'user', upn: undefined };
      }
      const upn = resolvers.resolvePerson(label);
      if (!upn) warnings.push(`${where}: "${label}" doesn't match a synced user yet - carried through as typed, confirm it's a valid UPN/email after import.`);
      return { kind: 'user', upn: upn ?? label };
    }
    case 'team': {
      const label = (t.label ?? '').trim();
      // A pick from the picker's "planned" suggestions carries flowId, a
      // hard link resolved by id (immune to renames); a typed/freeform name
      // falls back to the existing name-match against already-built rows.
      const match = t.flowId ? resolvers.resolveFlow(t.flowId) : label ? resolvers.resolveTeam(label) : undefined;
      if (match) return { kind: match.kind, buildId: match.buildId };
      warnings.push(
        t.flowId
          ? `${where}: routes to "${label || 'a planned capture'}", which hasn't been imported to Design & Build yet - import it, then re-import this Auto Attendant to link it.`
          : `${where}: routes to "${label || 'a department'}" - link it to the right Auto Attendant or Call Queue after import.`,
      );
      return { kind: 'call_queue' };
    }
    case 'message':
      warnings.push(`${where}: playing a recorded message isn't supported for a menu option yet - configure this destination manually after import.`);
      return undefined;
    case 'voicemail':
      warnings.push(`${where}: routes to Voicemail, which Teams can't deploy directly - it will disconnect the call until this is changed after import.`);
      return { kind: 'voicemail' };
    case 'external':
      if (!t.label) {
        warnings.push(`${where}: no outside number was entered.`);
        return undefined;
      }
      return { kind: 'external', number: t.label };
    case 'operator':
      // Handled by the caller (menu options: action becomes TransferCallToOperator with no target object). Meaningless at the AA's own -Operator field.
      return undefined;
    case 'call_queue': {
      const match = t.flowId ? resolvers.resolveFlow(t.flowId) : undefined;
      if (match) return { kind: match.kind, buildId: match.buildId };
      warnings.push(
        `${where}: routes to a call queue${t.label ? ` ("${t.label}")` : ''} created via the wizard, which hasn't been imported to Design & Build yet - import it, then re-import this Auto Attendant to link it.`,
      );
      return { kind: 'call_queue' };
    }
  }
}

function convertMenuOption(opt: WizardMenuOption, resolvers: WizardResolvers, warnings: string[], flowLabel: string): AutoAttendantMenuOption {
  const dtmf = DTMF_BY_DIGIT[opt.key] ?? 'Automatic';
  if (opt.target.kind === 'operator') return { dtmf, action: 'TransferCallToOperator' };
  const target = convertTarget(opt.target, resolvers, warnings, `${flowLabel}, option "${opt.label}"`);
  return target ? { dtmf, action: 'TransferCallToTarget', target } : { dtmf, action: 'DisconnectCall' };
}

function convertCallFlow(cf: WizardCallFlow, resolvers: WizardResolvers, warnings: string[], label: string): AutoAttendantCallFlow {
  const greetings = cf.greeting ? [{ type: 'Text' as const, text: cf.greeting }] : [];
  if (cf.mode === 'menu') {
    const options = (cf.options ?? []).map((o) => convertMenuOption(o, resolvers, warnings, label));
    if (!options.length) warnings.push(`${label}: no menu options were added, so callers will hear the greeting and then be disconnected.`);
    return { greetings, menu: { enableDialByName: cf.allowDialByName, options } };
  }
  // 'direct' and 'voicemail' both collapse to a single catch-all menu option
  // (DTMF 'Automatic', Teams' own sentinel for "no key pressed") - the
  // existing deploy machinery has no separate "redirect with no menu"
  // shape, this is how a plain forward is already represented.
  if (cf.mode === 'voicemail') {
    warnings.push(`${label}: routes straight to Voicemail, which Teams can't deploy directly - it will disconnect the call until this is changed after import.`);
    return { greetings, menu: { options: [{ dtmf: 'Automatic', action: 'TransferCallToTarget', target: { kind: 'voicemail' } }] } };
  }
  const target = convertTarget(cf.target, resolvers, warnings, label);
  if (!target) warnings.push(`${label}: no destination was chosen - calls will be disconnected until this is set.`);
  return {
    greetings,
    menu: { options: [target ? { dtmf: 'Automatic', action: 'TransferCallToTarget', target } : { dtmf: 'Automatic', action: 'DisconnectCall' }] },
  };
}

export function convertAutoAttendantWizard(
  answers: AutoAttendantWizardAnswers,
  opts: { siteId: string; name: string; resolvers?: WizardResolvers },
): { value: BuildAutoAttendantCreateInput; warnings: string[] } {
  const warnings: string[] = [];
  const resolvers = opts.resolvers ?? NO_RESOLVERS;

  const default_call_flow = convertCallFlow(answers.businessFlow, resolvers, warnings, 'Business hours');

  let after_hours_call_flow: AutoAttendantCallFlow | null = null;
  let schedule: AutoAttendantSchedule | null = null;
  if (answers.hoursType !== 'always' && answers.afterHoursFlow) {
    after_hours_call_flow = convertCallFlow(answers.afterHoursFlow, resolvers, warnings, 'After hours');
    // The schedule marks BUSINESS hours; `complement: true` fires the
    // after-hours flow outside them - see autoAttendantScheduleSchema's
    // own comment in dto.ts.
    const weekly = answers.hoursType === 'custom' && answers.customHours ? answers.customHours : STANDARD_9_TO_5;
    schedule = { type: 'weekly', weekly: { ...weekly, complement: true } };
  }

  const holiday_call_flows = answers.holidaysEnabled
    ? (answers.holidays ?? []).map((h) => ({
        name: h.name,
        callFlow: convertCallFlow(h.flow, resolvers, warnings, `Holiday "${h.name}"`),
        schedule: { type: 'fixed' as const, fixed: { ranges: [{ start: h.dateRange.start, end: h.dateRange.end }] } },
      }))
    : [];

  const operator = answers.operator ? (convertTarget(answers.operator, resolvers, warnings, 'Operator') ?? null) : null;

  return {
    value: {
      site_id: opts.siteId,
      name: opts.name,
      language_id: answers.languageId,
      time_zone_id: answers.timeZoneId,
      voice_response_enabled: false,
      operator,
      default_call_flow,
      after_hours_call_flow,
      holiday_call_flows,
      schedule,
    },
    warnings,
  };
}

export function convertCallQueueWizard(
  answers: CallQueueWizardAnswers,
  opts: { siteId: string; name: string; resolvers?: WizardResolvers },
): { value: BuildCallQueueCreateInput; warnings: string[] } {
  const warnings: string[] = [];
  const resolvers = opts.resolvers ?? NO_RESOLVERS;

  // Every non-blank name the customer typed ends up in `agents` - matched
  // to their canonical UPN when possible, carried through as typed
  // otherwise, never silently dropped (a typed-but-unmatched name used to
  // vanish from the created queue entirely - confirmed live this session).
  const agents: string[] = [];
  for (const a of answers.agents) {
    const label = a.trim();
    if (!label) continue;
    const upn = resolvers.resolvePerson(label);
    if (upn) agents.push(upn);
    else {
      agents.push(label);
      warnings.push(`Agent "${label}" doesn't match a synced user yet - carried through as typed, confirm it's a valid UPN/email after import.`);
    }
  }

  // Shaped to match buildCallQueueWritable's callQueueActionSchema exactly
  // (target: string | undefined, never null) - deployment.ts's own
  // CallQueueActionSettings allows `null` for a resolved-but-empty target,
  // which the create DTO doesn't accept.
  const actionSettings = (a: { action: string; forwardTo?: string }, label: string, threshold?: number) => {
    if (a.action === 'Forward' && !a.forwardTo) warnings.push(`${label}: "Forward" was chosen but no destination was entered - set one after import.`);
    return { action: a.action, ...(threshold !== undefined ? { threshold } : {}), target: a.action === 'Forward' ? a.forwardTo : undefined };
  };

  return {
    value: {
      site_id: opts.siteId,
      name: opts.name,
      routing_method: answers.routingMethod,
      agent_alert_time: answers.agentAlertTime,
      presence_based_routing: answers.presenceBasedRouting,
      agents,
      overflow: actionSettings(answers.overflow, 'When too many calls are waiting', answers.overflowThreshold),
      timeout: actionSettings(answers.timeout, 'When someone waits too long', answers.timeoutThreshold),
      // No live NoAgentThreshold exists in Teams' own model - see CallQueueLiveState's comment in deployment.ts.
      no_agent_action: actionSettings(answers.noAgents, 'When nobody is available'),
      no_agent_apply_to: answers.noAgentsApplyTo,
      language_id: answers.languageId,
    },
    warnings,
  };
}
