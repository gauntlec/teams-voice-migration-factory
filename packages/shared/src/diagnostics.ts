/**
 * Diagnostic runbooks for incidents (docs/INCIDENT-MANAGEMENT.md, chunk 6; docs/DIAGNOSTICS.md).
 *
 * A runbook is a read-only check of one thing a Teams voice incident is usually about: a user's voice setup,
 * a phone number, a call queue or auto attendant, the routes and gateways, emergency calling, recent changes.
 * They run against what Voxshift already knows (the last tenant Discovery and the customer's design), never
 * against the live tenant, so they are instant, safe for anyone (or any assistant) to run, and always say how
 * old the data is. This file is the pure part: the catalogue, the shape of a result, and the evaluators that turn
 * facts into findings. The API gathers the facts (`apps/api/src/modules/incidents/incident-diagnostics.service.ts`).
 */
import { z } from 'zod';
import type { IncItemKind } from './incidents';

export const DIAG_STATUSES = ['ok', 'warn', 'fail', 'info'] as const;
export type DiagStatus = (typeof DIAG_STATUSES)[number];
/** A whole result: the worst finding, or "unknown" when there was nothing to check. */
export type DiagOutcome = 'ok' | 'warn' | 'fail' | 'unknown';

export const DIAG_RUNBOOK_KEYS = ['user_voice', 'number_check', 'queue_check', 'routing_check', 'emergency_check', 'recent_changes'] as const;
export type DiagRunbookKey = (typeof DIAG_RUNBOOK_KEYS)[number];

/** What a runbook needs: a person, a number, the name of a queue or attendant, or nothing (the whole customer). */
export type DiagInputKind = 'user' | 'number' | 'name' | 'none';

export interface DiagRunbookDef {
  key: DiagRunbookKey;
  label: string;
  help: string;
  input: DiagInputKind;
  inputLabel?: string;
  /** Incident items that can supply the input. */
  itemKinds: readonly IncItemKind[];
}

export const DIAG_RUNBOOKS: Record<DiagRunbookKey, DiagRunbookDef> = {
  user_voice: {
    key: 'user_voice',
    label: 'User voice setup',
    help: 'Account, Enterprise Voice, number, phone licence and the calling policies a person has, against the design.',
    input: 'user',
    inputLabel: 'Email address or name',
    itemKinds: ['user', 'cap'],
  },
  number_check: {
    key: 'number_check',
    label: 'Phone number',
    help: 'Where a number is in the tenant, who or what it is assigned to, and whether the tenant and the design agree.',
    input: 'number',
    inputLabel: 'Phone number',
    itemKinds: ['number'],
  },
  queue_check: {
    key: 'queue_check',
    label: 'Call queue or auto attendant',
    help: 'Agents and targets still exist and can take calls, the resource account has a number, and the live setup matches the design.',
    input: 'name',
    inputLabel: 'Name of the call queue or auto attendant',
    itemKinds: ['call_queue', 'auto_attendant'],
  },
  routing_check: {
    key: 'routing_check',
    label: 'Calling routes and gateways',
    help: 'Every voice route points at a gateway that exists and is enabled, and uses PSTN usages that exist.',
    input: 'none',
    itemKinds: [],
  },
  emergency_check: {
    key: 'emergency_check',
    label: 'Emergency calling setup',
    help: 'Emergency locations and addresses exist, and how many people have an emergency calling policy.',
    input: 'none',
    itemKinds: [],
  },
  recent_changes: {
    key: 'recent_changes',
    label: 'Recent changes',
    help: 'What changed in the last 7 days: tenant objects, deployments and service requests.',
    input: 'none',
    itemKinds: [],
  },
};

export interface DiagFinding {
  status: DiagStatus;
  title: string;
  detail?: string;
}

export interface DiagResult {
  runbook: DiagRunbookKey;
  /** What was checked, as a short phrase ("anna@contoso.com", "+441234567890"). */
  subject: string;
  status: DiagOutcome;
  summary: string;
  findings: DiagFinding[];
  /** When the Discovery behind it finished; null when there has never been one. */
  dataAsOf: string | null;
}

/** A Discovery older than this is called stale. */
export const DIAG_STALE_DAYS = 7;
export const DIAG_RECENT_DAYS = 7;

export const diagInputSchema = z
  .object({
    runbook: z.enum(DIAG_RUNBOOK_KEYS),
    input: z.string().trim().max(200).optional(),
  })
  .strict();
export type DiagRunInput = z.infer<typeof diagInputSchema>;

/* ------------------------------ result helpers ------------------------------ */

const ok = (title: string, detail?: string): DiagFinding => ({ status: 'ok', title, detail });
const warn = (title: string, detail?: string): DiagFinding => ({ status: 'warn', title, detail });
const fail = (title: string, detail?: string): DiagFinding => ({ status: 'fail', title, detail });
const info = (title: string, detail?: string): DiagFinding => ({ status: 'info', title, detail });

export function diagOutcome(findings: DiagFinding[]): DiagOutcome {
  if (findings.some((f) => f.status === 'fail')) return 'fail';
  if (findings.some((f) => f.status === 'warn')) return 'warn';
  return findings.some((f) => f.status === 'ok') ? 'ok' : 'unknown';
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export function diagSummary(subject: string, findings: DiagFinding[]): string {
  const fails = findings.filter((f) => f.status === 'fail').length;
  const warns = findings.filter((f) => f.status === 'warn').length;
  if (fails || warns) {
    const parts = [fails ? plural(fails, 'problem') : '', warns ? plural(warns, 'thing to look at', 'things to look at') : ''].filter(Boolean);
    const first = findings.find((f) => f.status === 'fail') ?? findings.find((f) => f.status === 'warn');
    return `${subject}: ${parts.join(' and ')}. ${first?.title ?? ''}`.trim();
  }
  return findings.some((f) => f.status === 'ok') ? `${subject}: nothing wrong found.` : `${subject}: nothing to check.`;
}

/** Finishes a result: the data's age is itself a finding, then the outcome and the summary. */
export function diagFinish(runbook: DiagRunbookKey, subject: string, findings: DiagFinding[], dataAsOf: string | null, now: Date = new Date()): DiagResult {
  const out = [...findings];
  if (dataAsOf === null) {
    out.push(warn('There has been no Discovery of this customer yet', 'These checks run on what Voxshift knows from Discovery, so they cannot say anything about the live tenant.'));
  } else {
    const days = Math.floor((now.getTime() - new Date(dataAsOf).getTime()) / 86_400_000);
    if (days >= DIAG_STALE_DAYS) out.push(warn(`The last Discovery is ${plural(days, 'day')} old`, 'Things may have changed since. Run a Discovery to refresh before relying on this.'));
  }
  return { runbook, subject, status: diagOutcome(out), summary: diagSummary(subject, out), findings: out, dataAsOf };
}

/* ------------------------------ which runbooks for which incident ------------------------------ */

export interface DiagSuggestion {
  runbook: DiagRunbookKey;
  input: string;
  why: string;
}

const NUMBER_RE = /\+?\d[\d\s().-]{6,}\d/g;
// Lengths are bounded (RFC 5321: 64 before the @, 255 after) so text pasted into a request cannot make the match slow.
const EMAIL_RE = /[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9.-]{1,255}\.[A-Za-z]{2,24}/g;

/** Digits only, with a leading + kept: the comparison form of a phone number. */
export function diagNormaliseNumber(s: string): string {
  const t = s.trim().replace(/^tel:/i, '').split(';')[0] ?? '';
  const digits = t.replace(/[^\d+]/g, '');
  return digits.startsWith('00') ? `+${digits.slice(2)}` : digits;
}

/** True when two numbers are the same number, tolerating a missing + or country code on one side. */
export function diagSameNumber(a: string, b: string): boolean {
  const x = diagNormaliseNumber(a).replace(/^\+/, '');
  const y = diagNormaliseNumber(b).replace(/^\+/, '');
  if (!x || !y) return false;
  if (x === y) return true;
  const [short, long] = x.length <= y.length ? [x, y] : [y, x];
  return short.length >= 7 && long.endsWith(short.replace(/^0+/, ''));
}

/**
 * What to run for an incident: the checks its category points at, with the inputs its linked items and answers
 * give. Always at most one suggestion per runbook and input, most useful first.
 */
export function diagSuggest(args: {
  category: string;
  items: { kind: IncItemKind; ref: string; label: string | null }[];
  answers?: Record<string, unknown>;
  description?: string;
}): DiagSuggestion[] {
  const out: DiagSuggestion[] = [];
  const seen = new Set<string>();
  const add = (runbook: DiagRunbookKey, input: string, why: string) => {
    const k = `${runbook}|${input.toLowerCase()}`;
    if (seen.has(k) || out.length >= 8) return;
    seen.add(k);
    out.push({ runbook, input, why });
  };
  const text = (v: unknown) => (typeof v === 'string' ? v : '');
  const answers = args.answers ?? {};
  const blob = [args.description ?? '', ...Object.values(answers).map(text)].join(' ');

  const users = [...args.items.filter((i) => i.kind === 'user' || i.kind === 'cap').map((i) => i.ref), ...(blob.match(EMAIL_RE) ?? [])];
  const numbers = [...args.items.filter((i) => i.kind === 'number').map((i) => i.ref), ...(text(answers.numbers) + ' ' + text(answers.numbers_affected) + ' ' + text(answers.callback_number)).match(NUMBER_RE) ?? []];
  const queues = [...args.items.filter((i) => i.kind === 'call_queue' || i.kind === 'auto_attendant').map((i) => i.ref), text(answers.which)].filter(Boolean);

  const cat = args.category;
  const userWhy = 'The person is named on the incident.';
  const numberWhy = 'The number is named on the incident.';
  if (cat === 'queues_aa') for (const q of queues) add('queue_check', q, 'The incident is about this call queue or auto attendant.');
  if (cat === 'numbers') for (const n of numbers) add('number_check', n, numberWhy);
  if (cat === 'users' || cat === 'call_failure' || cat === 'devices') for (const u of users) add('user_voice', u, userWhy);
  if (cat === 'emergency') add('emergency_check', '', 'Emergency calling incidents start with the setup.');
  if (cat === 'direct_routing' || cat === 'call_failure') add('routing_check', '', 'Routes and gateways are the first thing to rule out.');
  // Whatever the category, named things are worth a look, and recent changes explain most "it was working yesterday".
  for (const q of queues) add('queue_check', q, 'A call queue or auto attendant is linked to the incident.');
  for (const n of numbers) add('number_check', n, numberWhy);
  for (const u of users) add('user_voice', u, userWhy);
  add('recent_changes', '', 'Something changed recently is the most common cause.');
  return out;
}

/* ------------------------------ user_voice ------------------------------ */

export interface DiagUserFacts {
  /** The lookup matched a tenant user (a name can match several: then `ambiguous` lists them). */
  found: boolean;
  ambiguous?: string[];
  upn?: string;
  displayName?: string | null;
  accountType?: string | null;
  accountEnabled?: boolean | null;
  enterpriseVoice?: boolean;
  lineUri?: string | null;
  featureTypes?: string[];
  assignedPlans?: unknown[];
  usageLocation?: string | null;
  policies?: Record<string, string | null>;
  removedAt?: string | null;
  /** The design row for this person (Design & Build), if any. */
  design?: { callingPolicy: string | null; requestedNumber: string | null; siteCode: string | null } | null;
  /** Other tenant users with the same line. */
  sameLineUsers?: string[];
  /** The tenant's own record for the number on their line, if it is in the number list. */
  numberRecord?: { assignmentStatus: string | null; activationState: string | null } | null;
}

const LIVE = new Set(['Enabled', 'Success', 'Active', 'Suspended']);

export function diagHasTeamsPhoneLicence(plans: unknown[] | undefined, featureTypes: string[] | undefined): boolean | null {
  const list = Array.isArray(plans) ? (plans as Record<string, unknown>[]) : [];
  if (!list.length && !(featureTypes && featureTypes.length)) return null;
  // MCOEV must be the START of the capability name; TEAMSPHONE and MCOPSTN may appear anywhere in it.
  const phoneCapability = (c: string) => /^MCOEV/i.test(c) || /TEAMSPHONE|MCOPSTN/i.test(c);
  if (list.some((p) => phoneCapability(String(p?.Capability ?? '')) && String(p?.CapabilityStatus ?? 'Enabled') !== 'Deleted')) return true;
  return list.length ? false : null;
}

export function evalUserVoice(subject: string, f: DiagUserFacts, dataAsOf: string | null, now?: Date): DiagResult {
  const out: DiagFinding[] = [];
  if (!f.found) {
    if (f.ambiguous?.length) out.push(warn(`"${subject}" matches ${f.ambiguous.length} people`, `Use an email address. Candidates: ${f.ambiguous.slice(0, 5).join(', ')}.`));
    else out.push(fail(`${subject} is not in the last Discovery`, 'Either the address is mistyped, the account is new (or was filtered out as not licensed for Teams), or Discovery needs running again.'));
    return diagFinish('user_voice', subject, out, dataAsOf, now);
  }
  const who = f.upn ?? subject;
  out.push(ok('Found in the tenant', `${f.displayName ?? who}${f.accountType ? `, ${f.accountType}` : ''}`));
  if (f.removedAt) out.push(fail('This account is gone from the tenant', `Last seen before ${f.removedAt.slice(0, 10)}.`));
  if (f.accountEnabled === false) out.push(fail('The account is disabled', 'A disabled account cannot sign in or take calls.'));
  else if (f.accountEnabled === true) out.push(ok('The account is enabled'));

  if (f.enterpriseVoice === false) out.push(fail('Enterprise Voice is off', 'Without Enterprise Voice a person has no PSTN calling. This is the usual reason for "no dial pad" and "calls do not connect".'));
  else out.push(ok('Enterprise Voice is on'));

  const lic = diagHasTeamsPhoneLicence(f.assignedPlans, f.featureTypes);
  if (lic === false) out.push(fail('No Teams Phone licence found', 'The account has plans but none of them is a phone plan.'));
  else if (lic === true) out.push(ok('Has a Teams Phone licence'));
  else out.push(info('Licence not recorded', 'Discovery did not capture licence data for this person.'));

  if (!f.usageLocation) out.push(warn('No usage location set', 'A usage location is needed before a phone licence or number can be assigned.'));

  if (!f.lineUri) out.push(f.enterpriseVoice ? fail('No phone number on the line', 'Enterprise Voice is on but no number is assigned, so there is nothing to ring.') : warn('No phone number assigned'));
  else {
    out.push(ok('Has a phone number', f.lineUri.replace(/^tel:/i, '')));
    if (f.sameLineUsers?.length) out.push(fail('Another account has the same number', f.sameLineUsers.join(', ')));
    if (f.numberRecord) {
      const st = f.numberRecord.assignmentStatus;
      if (st && /unassigned/i.test(st)) out.push(fail('The number list says this number is not assigned', 'The user has it as their line but the tenant number record is unassigned.'));
      const act = f.numberRecord.activationState;
      if (act && !/^activated$/i.test(act)) out.push(warn(`The number's activation state is ${act}`));
    }
  }

  const pol = f.policies ?? {};
  if (!pol.OnlineVoiceRoutingPolicy) out.push(warn('No voice routing policy assigned', 'Direct Routing calls need one. (Fine for Calling Plan users.)'));
  else out.push(ok('Voice routing policy', pol.OnlineVoiceRoutingPolicy));
  if (!pol.TeamsEmergencyCallingPolicy) out.push(info('No emergency calling policy assigned', 'The global policy applies.'));
  if (f.design?.callingPolicy) {
    const have = pol.TeamsCallingPolicy ?? null;
    if (!have) out.push(warn('No calling policy assigned', `The design says ${f.design.callingPolicy}.`));
    else if (have.toLowerCase() !== f.design.callingPolicy.toLowerCase()) out.push(warn('Calling policy differs from the design', `Tenant: ${have}. Design: ${f.design.callingPolicy}.`));
    else out.push(ok('Calling policy matches the design', have));
  } else if (f.design === null) out.push(info('Not in the design', 'There is no Design & Build row for this person.'));
  if (f.design?.requestedNumber && f.lineUri && !diagSameNumber(f.design.requestedNumber, f.lineUri)) {
    out.push(warn('The number differs from the design', `Tenant: ${f.lineUri.replace(/^tel:/i, '')}. Design: ${f.design.requestedNumber}.`));
  }
  return diagFinish('user_voice', who, out, dataAsOf, now);
}

/* ------------------------------ number_check ------------------------------ */

export interface DiagNumberFacts {
  /** The record in the tenant's number list. */
  record: { number: string; numberType: string | null; assignmentStatus: string | null; activationState: string | null; assignedTo: string | null; city: string | null } | null;
  /** Tenant users whose line is this number. */
  lineUsers: string[];
  /** Resource accounts (queues, attendants) holding it. */
  resourceAccounts: string[];
  /** Voxshift's own inventory: the range it belongs to and what it says the number is for. */
  inventory: { status: string; holderType: string | null; holder: string | null; range: string | null } | null;
  /** The design: someone was asked to have this number. */
  designHolders: string[];
}

export function evalNumber(subject: string, f: DiagNumberFacts, dataAsOf: string | null, now?: Date): DiagResult {
  const out: DiagFinding[] = [];
  const holders = [...f.lineUsers, ...f.resourceAccounts];
  if (f.record) {
    out.push(ok('In the tenant number list', `${f.record.numberType ?? 'number'}${f.record.city ? `, ${f.record.city}` : ''}`));
    const st = f.record.assignmentStatus;
    if (st && /unassigned/i.test(st) && !holders.length) out.push(warn('The number is in the tenant but not assigned to anyone', 'Calls to it will not reach a person or a queue.'));
    else if (st) out.push(ok(`Assignment: ${st}`, f.record.assignedTo ?? undefined));
    const act = f.record.activationState;
    if (act && !/^activated$/i.test(act)) out.push(fail(`Activation state is ${act}`, 'A number that is not activated does not ring.'));
  } else {
    out.push(holders.length ? info('Not in the tenant number list', 'Direct Routing numbers are not always listed; it is set on the user or resource account instead.') : fail('The tenant does not have this number', 'It is not in the number list and nobody has it as a line.'));
  }
  if (f.lineUsers.length === 1) out.push(ok('Assigned to a person', f.lineUsers[0]));
  if (f.lineUsers.length > 1) out.push(fail(`${f.lineUsers.length} people have this number`, f.lineUsers.join(', ')));
  if (f.resourceAccounts.length) out.push(ok(`Held by ${plural(f.resourceAccounts.length, 'resource account')}`, f.resourceAccounts.join(', ')));
  if (f.lineUsers.length && f.resourceAccounts.length) out.push(fail('The number is on a person and a resource account', 'Only one can hold it.'));

  if (f.inventory) {
    out.push(info(`Voxshift inventory: ${f.inventory.status}`, [f.inventory.range, f.inventory.holderType ? `${f.inventory.holderType}${f.inventory.holder ? ` ${f.inventory.holder}` : ''}` : ''].filter(Boolean).join(', ') || undefined));
    if (f.inventory.status === 'available' && holders.length) out.push(warn('Inventory says available but the tenant has it assigned', 'The inventory is out of date or someone assigned it outside Voxshift.'));
    if (f.inventory.status === 'assigned' && f.record && !holders.length) out.push(warn('Inventory says assigned but nobody has it in the tenant', 'The assignment may never have been deployed, or was removed.'));
  } else out.push(info('Not in Voxshift inventory', 'No number range here includes it.'));
  if (f.designHolders.length && !holders.length) out.push(warn('The design gives this number to someone who does not have it', f.designHolders.join(', ')));
  return diagFinish('number_check', subject, out, dataAsOf, now);
}

/* ------------------------------ queue_check ------------------------------ */

export interface DiagDirectoryUser {
  upn: string;
  displayName: string | null;
  accountEnabled: boolean | null;
  enterpriseVoice: boolean;
  removed: boolean;
}

export interface DiagQueueFacts {
  found: boolean;
  ambiguous?: string[];
  kind?: 'call_queue' | 'auto_attendant';
  name?: string;
  /** Agent ids -> who they are in the tenant (null = unknown id). */
  agents?: { id: string; user: DiagDirectoryUser | null }[];
  /** Where overflow, time-out and no-agents calls go: ids resolved to something real or not. */
  targets?: { label: string; kind: string | null; id: string | null; exists: boolean | null; detail?: string }[];
  /** Linked resource accounts and the numbers they hold. */
  resourceAccounts?: { name: string; number: string | null }[];
  /** Agents in the design for a queue of this name that the tenant does not have, and the other way round. */
  design?: { missingFromTenant: string[]; notInDesign: string[] } | null;
}

export function evalQueue(subject: string, f: DiagQueueFacts, dataAsOf: string | null, now?: Date): DiagResult {
  const out: DiagFinding[] = [];
  if (!f.found) {
    if (f.ambiguous?.length) out.push(warn(`"${subject}" matches ${f.ambiguous.length} queues or attendants`, `Use the exact name. Candidates: ${f.ambiguous.slice(0, 5).join(', ')}.`));
    else out.push(fail(`No call queue or auto attendant called "${subject}"`, 'It may be mistyped, new since the last Discovery, or removed.'));
    return diagFinish('queue_check', subject, out, dataAsOf, now);
  }
  const noun = f.kind === 'auto_attendant' ? 'auto attendant' : 'call queue';
  out.push(ok(`Found the ${noun}`, f.name));
  if (f.kind === 'call_queue') {
    const agents = f.agents ?? [];
    if (!agents.length) out.push(fail('The queue has no agents', 'Calls will go straight to overflow or time-out.'));
    else {
      const bad = agents.filter((a) => !a.user || a.user.removed || a.user.accountEnabled === false || !a.user.enterpriseVoice);
      const unknown = agents.filter((a) => !a.user);
      const named = (a: (typeof agents)[number]) => a.user?.displayName ?? a.user?.upn ?? a.id;
      if (bad.length === agents.length) out.push(fail('No agent can take calls', bad.map((a) => `${named(a)}${!a.user ? ' (not found)' : a.user.removed ? ' (removed)' : a.user.accountEnabled === false ? ' (disabled)' : ' (Enterprise Voice off)'}`).slice(0, 8).join(', ')));
      else if (bad.length) out.push(warn(`${bad.length} of ${agents.length} agents cannot take calls`, bad.map((a) => `${named(a)}${!a.user ? ' (not found)' : a.user.removed ? ' (removed)' : a.user.accountEnabled === false ? ' (disabled)' : ' (Enterprise Voice off)'}`).slice(0, 8).join(', ')));
      else out.push(ok(`${plural(agents.length, 'agent')}, all able to take calls`));
      if (unknown.length && unknown.length < bad.length) out.push(info(`${plural(unknown.length, 'agent')} not recognised`, 'Perhaps guests, or accounts Discovery filtered out.'));
    }
  }
  for (const t of f.targets ?? []) {
    if (t.exists === false) out.push(fail(`${t.label} goes to something that no longer exists`, `${t.kind ?? 'Target'}${t.id ? ` ${t.id}` : ''}`));
    else if (t.exists === true) out.push(ok(`${t.label}`, t.detail));
    else out.push(info(`${t.label}`, t.detail ?? 'Could not be checked.'));
  }
  const ras = f.resourceAccounts ?? [];
  if (!ras.length) out.push(fail('No resource account is linked', 'Without one, the number cannot reach it.'));
  else {
    const noNumber = ras.filter((r) => !r.number);
    if (noNumber.length === ras.length) out.push(warn('The resource account has no phone number', `${noNumber.map((r) => r.name).join(', ')}. Fine if it is only reached from another menu.`));
    else out.push(ok(`Resource account${ras.length > 1 ? 's' : ''} with a number`, ras.filter((r) => r.number).map((r) => `${r.name}: ${r.number}`).join(', ')));
  }
  if (f.design) {
    if (f.design.missingFromTenant.length) out.push(warn('Agents in the design who are not in the live queue', f.design.missingFromTenant.slice(0, 8).join(', ')));
    if (f.design.notInDesign.length) out.push(info('Agents in the live queue who are not in the design', f.design.notInDesign.slice(0, 8).join(', ')));
    if (!f.design.missingFromTenant.length && !f.design.notInDesign.length) out.push(ok('Agents match the design'));
  }
  return diagFinish('queue_check', f.name ?? subject, out, dataAsOf, now);
}

/* ------------------------------ routing_check ------------------------------ */

export interface DiagRoutingFacts {
  gateways: { fqdn: string; enabled: boolean | null }[];
  routes: { name: string; gateways: string[]; usages: string[]; pattern: string | null; priority: number | null }[];
  usages: string[];
}

/** A gateway list entry is "Fqdn" or "Identity" or "Microsoft.Rtc...:fqdn"; compare on the fqdn tail. */
const gw = (s: string) => s.replace(/^.*[:/]/, '').toLowerCase();

export function evalRouting(f: DiagRoutingFacts, dataAsOf: string | null, now?: Date): DiagResult {
  const out: DiagFinding[] = [];
  if (!f.gateways.length && !f.routes.length) {
    out.push(info('No Direct Routing configured', 'There are no gateways or voice routes in the last Discovery. Calling Plan customers do not need them.'));
    return diagFinish('routing_check', 'Routes and gateways', out, dataAsOf, now);
  }
  const byFqdn = new Map(f.gateways.map((g) => [gw(g.fqdn), g]));
  const disabled = f.gateways.filter((g) => g.enabled === false);
  if (!f.gateways.length) out.push(fail('There are voice routes but no gateways', 'Nothing can carry the calls.'));
  else if (disabled.length === f.gateways.length) out.push(fail('Every gateway is disabled', disabled.map((g) => g.fqdn).join(', ')));
  else if (disabled.length) out.push(warn(`${plural(disabled.length, 'gateway')} disabled`, disabled.map((g) => g.fqdn).join(', ')));
  else out.push(ok(`${plural(f.gateways.length, 'gateway')}, all enabled`, f.gateways.map((g) => g.fqdn).slice(0, 6).join(', ')));

  const usageSet = new Set(f.usages.map((u) => u.toLowerCase()));
  let broken = 0;
  for (const r of f.routes) {
    const missing = r.gateways.filter((g) => !byFqdn.has(gw(g)));
    const off = r.gateways.filter((g) => byFqdn.get(gw(g))?.enabled === false);
    const missingUsages = r.usages.filter((u) => usageSet.size && !usageSet.has(u.toLowerCase()));
    if (!r.gateways.length) {
      broken++;
      out.push(fail(`Route "${r.name}" has no gateway`, 'Calls matching it have nowhere to go.'));
    } else if (missing.length === r.gateways.length) {
      broken++;
      out.push(fail(`Route "${r.name}" points at gateways that do not exist`, missing.join(', ')));
    } else if (off.length === r.gateways.length) {
      broken++;
      out.push(fail(`Route "${r.name}" only uses disabled gateways`, off.join(', ')));
    } else if (missing.length || off.length) out.push(warn(`Route "${r.name}" lists a gateway that is missing or disabled`, [...missing, ...off].join(', ')));
    if (missingUsages.length) out.push(warn(`Route "${r.name}" uses a PSTN usage that does not exist`, missingUsages.join(', ')));
  }
  if (f.routes.length && !broken) out.push(ok(`${plural(f.routes.length, 'voice route')} checked`));
  if (!f.routes.length && f.gateways.length) out.push(warn('There are gateways but no voice routes', 'Calls cannot be routed to them.'));
  return diagFinish('routing_check', 'Routes and gateways', out, dataAsOf, now);
}

/* ------------------------------ emergency_check ------------------------------ */

export interface DiagEmergencyFacts {
  locations: { name: string; civicAddressId: string | null; validated: boolean | null }[];
  civicAddresses: number;
  enterpriseVoiceUsers: number;
  usersWithEmergencyPolicy: number;
  emergencyPolicies: string[];
  /** Sites in the design (with an address) that have no emergency location at all. */
  sitesWithoutLocation: string[];
}

export function evalEmergency(f: DiagEmergencyFacts, dataAsOf: string | null, now?: Date): DiagResult {
  const out: DiagFinding[] = [];
  if (!f.locations.length) out.push(fail('There are no emergency locations', 'Emergency calls cannot send a dispatchable location.'));
  else {
    out.push(ok(`${plural(f.locations.length, 'emergency location')}`, f.locations.slice(0, 5).map((l) => l.name).join(', ')));
    const unvalidated = f.locations.filter((l) => l.validated === false);
    if (unvalidated.length) out.push(warn(`${plural(unvalidated.length, 'location')} not validated`, unvalidated.map((l) => l.name).join(', ')));
    const noAddress = f.locations.filter((l) => !l.civicAddressId);
    if (noAddress.length) out.push(warn(`${plural(noAddress.length, 'location')} without a civic address`, noAddress.map((l) => l.name).join(', ')));
  }
  if (!f.civicAddresses) out.push(warn('There are no civic addresses'));
  if (f.sitesWithoutLocation.length) out.push(warn('Sites with no emergency location', f.sitesWithoutLocation.slice(0, 8).join(', ')));
  if (f.enterpriseVoiceUsers) {
    if (!f.usersWithEmergencyPolicy) out.push(info('Nobody has a named emergency calling policy', f.emergencyPolicies.length ? `Policies exist (${f.emergencyPolicies.slice(0, 4).join(', ')}) but none is assigned. The global policy applies.` : 'The global policy applies to everyone.'));
    else out.push(info(`${f.usersWithEmergencyPolicy} of ${f.enterpriseVoiceUsers} voice users have an emergency calling policy assigned`));
  }
  return diagFinish('emergency_check', 'Emergency calling', out, dataAsOf, now);
}

/* ------------------------------ recent_changes ------------------------------ */

export interface DiagChangesFacts {
  days: number;
  tenantChanges: { type: string; name: string | null; kind: string; at: string; fields: string[] }[];
  tenantChangeTotal: number;
  deployments: { id: string; mode: string; status: string; at: string; failedChanges: number; appliedChanges: number }[];
  serviceRequests: { reference: string; title: string; status: string; at: string }[];
  /** Words to prefer (a site code, a name): changes mentioning them are listed first. */
  focus?: string[];
}

export function evalChanges(f: DiagChangesFacts, dataAsOf: string | null, now?: Date): DiagResult {
  const out: DiagFinding[] = [];
  const when = (s: string) => s.slice(0, 16).replace('T', ' ');
  const failed = f.deployments.filter((d) => d.status === 'failed' || d.failedChanges > 0);
  const executed = f.deployments.filter((d) => d.mode === 'execute');
  if (failed.length) out.push(fail(`${plural(failed.length, 'deployment')} with failures`, failed.slice(0, 5).map((d) => `${when(d.at)} (${d.failedChanges} failed)`).join('; ')));
  if (executed.length) out.push(info(`${plural(executed.length, 'deployment')} run in the last ${f.days} days`, executed.slice(0, 5).map((d) => `${when(d.at)}: ${d.appliedChanges} applied, ${d.status}`).join('; ')));
  else out.push(ok(`No deployments in the last ${f.days} days`));
  if (f.serviceRequests.length) out.push(info(`${plural(f.serviceRequests.length, 'service request')} completed or changed in the last ${f.days} days`, f.serviceRequests.slice(0, 5).map((r) => `${r.reference} ${r.title} (${r.status})`).join('; ')));
  if (f.tenantChangeTotal) {
    const shown = f.tenantChanges.slice(0, 8).map((c) => `${when(c.at)} ${c.kind} ${c.type.replace(/_/g, ' ')} ${c.name ?? ''}${c.fields.length ? ` (${c.fields.slice(0, 3).join(', ')})` : ''}`.trim());
    out.push(info(`${plural(f.tenantChangeTotal, 'change')} seen in the tenant in the last ${f.days} days`, shown.join('; ') + (f.tenantChangeTotal > shown.length ? `; and ${f.tenantChangeTotal - shown.length} more` : '')));
    const removals = f.tenantChanges.filter((c) => c.kind === 'removed');
    if (removals.length) out.push(warn(`${plural(removals.length, 'object')} removed from the tenant`, removals.slice(0, 6).map((c) => `${c.type.replace(/_/g, ' ')} ${c.name ?? ''}`.trim()).join(', ')));
  } else out.push(ok(`No tenant changes seen in the last ${f.days} days`));
  return diagFinish('recent_changes', `Last ${f.days} days`, out, dataAsOf, now);
}
