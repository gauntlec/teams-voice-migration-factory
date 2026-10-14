/**
 * The assistants Voxshift ships (docs/BUILTIN-AGENTS.md): Triage, Diagnose and Comms. They are ordinary agents
 * (own identity, per-customer autonomy policy, claims, proposals, audit) whose "brain" is rules and templates, so
 * they work with no outside AI service and say exactly why they did what they did. This file is the pure part: what
 * they are, what they conclude from an incident, and the words they use. The runner is
 * `apps/api/src/modules/incidents/builtin-agents.service.ts`.
 */
import type { AgentAutonomy, AgentKind } from './agents';
import type { DiagFinding, DiagResult } from './diagnostics';
import { DIAG_RUNBOOKS } from './diagnostics';
import type { IncHoldReason, IncPriority, IncStatus } from './incidents';

export const BUILTIN_AGENT_KEYS = ['triage', 'diagnose', 'comms'] as const;
export type BuiltinAgentKey = (typeof BUILTIN_AGENT_KEYS)[number];

export interface BuiltinAgentDef {
  key: BuiltinAgentKey;
  name: string;
  kind: AgentKind;
  description: string;
  modelLabel: string;
  /** What it does, one line each, for the admin page. */
  does: string[];
  /** The autonomy worth starting with once you trust it. Nothing is applied for you. */
  suggestedAutonomy: AgentAutonomy;
}

export const BUILTIN_AGENTS: Record<BuiltinAgentKey, BuiltinAgentDef> = {
  triage: {
    key: 'triage',
    name: 'Voxshift Triage',
    kind: 'triage',
    description: 'Looks at every new, unassigned incident: matches known errors, spots likely duplicates and wider problems, and leaves an internal note.',
    modelLabel: 'Built in (rules)',
    does: [
      'Leaves an internal note with what it found: known error and workaround, similar open incidents, a possible wider problem',
      'Proposes linking a matching known error, and marking a likely duplicate (never closes anything itself)',
      'Acknowledges the incident (at "act alone"), or proposes it',
    ],
    suggestedAutonomy: { triage: 3, internal_note: 3 },
  },
  diagnose: {
    key: 'diagnose',
    name: 'Voxshift Diagnose',
    kind: 'diagnostic',
    description: 'Runs the read-only checks an incident points at (user, number, queue, routes, emergency setup, recent changes) and writes up what it found.',
    modelLabel: 'Built in (rules)',
    does: [
      'Runs the suggested checks on incidents nobody has picked up yet (at "act alone"), or proposes them for approval (at "act with approval")',
      'Hands over with what it tried, what it found and what it recommends, so an engineer starts with the facts',
      'Looks at Discovery and the design only, never the live tenant',
    ],
    suggestedAutonomy: { triage: 3, internal_note: 3, diagnostic_read: 3 },
  },
  comms: {
    key: 'comms',
    name: 'Voxshift Comms',
    kind: 'comms',
    description: 'Drafts the next customer update on urgent incidents when one is due. A person always approves it before the customer sees it.',
    modelLabel: 'Built in (templates)',
    does: [
      'Proposes a plain, templated update to the customer on P1 and P2 incidents when no update has gone out for a while',
      'Says only what the incident record says: no guesses, no causes, no promises about fixes',
      'Customer-visible text is always approved by a person first',
    ],
    suggestedAutonomy: { customer_update: 2 },
  },
};

export const isBuiltinKey = (k: string): k is BuiltinAgentKey => (BUILTIN_AGENT_KEYS as readonly string[]).includes(k);

/* ------------------------------ timings ------------------------------ */

/** A new incident is left alone this long first, so the customer can finish adding detail and a person can get there first. */
export const BUILTIN_SETTLE_SECONDS = 45;
/** The lease a built-in assistant takes while it works one incident. */
export const BUILTIN_LEASE_SECONDS = 300;
/** At most this many incidents per customer per pass. */
export const BUILTIN_BATCH = 5;
/** Incidents this recent at the same place, of the same kind, are likely the same thing. */
export const BUILTIN_DUPLICATE_MINUTES = 30;
/** This many similar open incidents at one site suggest something wider than one person's problem. */
export const BUILTIN_WIDER_COUNT = 3;
/** Minutes between customer updates on an urgent incident. */
export const COMMS_CADENCE_MINUTES: Partial<Record<IncPriority, number>> = { p1: 30, p2: 120 };

/* ------------------------------ triage ------------------------------ */

export interface TriageContext {
  incident: { reference: string; title: string; priority: IncPriority; status: IncStatus; category: string; sitecode: string | null; created_at: string; problem_id: string | null; major: boolean };
  knownErrors: { id: string; reference: string; title: string; workaround: string }[];
  similar: { id: string; reference: string; title: string; status: IncStatus; priority: IncPriority; sitecode: string | null; created_at?: string }[];
  now?: Date;
}

export interface TriageProposal {
  kind: 'link_problem' | 'status_change';
  params: Record<string, unknown>;
  rationale: string;
  risk: 'low' | 'medium' | 'high';
}

export interface TriageOutcome {
  /** The internal note. */
  note: string;
  found: string[];
  tried: string[];
  recommendation: string;
  confidence: 'low' | 'medium' | 'high';
  proposals: TriageProposal[];
}

export function triageAnalysis(ctx: TriageContext): TriageOutcome {
  const now = (ctx.now ?? new Date()).getTime();
  const i = ctx.incident;
  const found: string[] = [];
  const proposals: TriageProposal[] = [];
  const tried = ['Read the incident and the answers to its questions', 'Looked for known errors of this kind', 'Looked for similar open incidents'];

  const known = ctx.knownErrors[0];
  if (known) {
    found.push(`Matches known error ${known.reference} (${known.title}). Workaround: ${known.workaround.trim() || 'none recorded'}`);
    if (!i.problem_id) proposals.push({ kind: 'link_problem', params: { problemId: known.id }, rationale: `This looks like known error ${known.reference}. Linking it keeps the incident with the problem and shows the workaround.`, risk: 'low' });
  }

  const similar = ctx.similar.filter((s) => s.status !== 'duplicate');
  const sameSite = similar.filter((s) => i.sitecode && s.sitecode === i.sitecode);
  if (similar.length) found.push(`${similar.length} similar open incident${similar.length === 1 ? '' : 's'}: ${similar.map((s) => `${s.reference} (${s.status.replace('_', ' ')})`).join(', ')}`);
  if (sameSite.length + 1 >= BUILTIN_WIDER_COUNT) found.push(`${sameSite.length + 1} open incidents of this kind at ${i.sitecode}. This may be one problem affecting several people: consider a major incident.`);

  const recent = sameSite
    .filter((s) => s.created_at && new Date(s.created_at).getTime() >= now - BUILTIN_DUPLICATE_MINUTES * 60_000 && new Date(s.created_at).getTime() <= new Date(i.created_at).getTime())
    .sort((a, b) => new Date(a.created_at!).getTime() - new Date(b.created_at!).getTime());
  if (recent[0] && !i.major) {
    proposals.push({
      kind: 'status_change',
      params: { to: 'duplicate', duplicateOf: recent[0].id, note: `Same kind of problem at the same site, reported shortly before as ${recent[0].reference}.` },
      rationale: `${recent[0].reference} was raised at ${i.sitecode} within ${BUILTIN_DUPLICATE_MINUTES} minutes with the same category. A person should confirm it is the same problem before merging.`,
      risk: 'medium',
    });
    found.push(`Possibly the same problem as ${recent[0].reference}, raised shortly before at the same site.`);
  }
  if (!found.length) found.push('No known error or similar incident found. Nothing to go on yet.');

  const recommendation = known
    ? `Try the workaround for ${known.reference}, then check whether the cause is the known one.`
    : sameSite.length + 1 >= BUILTIN_WIDER_COUNT
      ? 'Treat as a possible wider problem: confirm with the other reporters and consider a major incident.'
      : 'Run the suggested checks, then work it as a new problem.';
  const confidence = known ? 'medium' : 'low';
  const note = [`Triage of ${i.reference} (${i.priority.toUpperCase()}, ${i.category.replace(/_/g, ' ')}${i.sitecode ? `, ${i.sitecode}` : ''}).`, ...found.map((f) => `- ${f}`), `Recommendation: ${recommendation}`, `Confidence: ${confidence}. I am an automated assistant working from rules, not a person.`].join('\n');
  return { note, found, tried, recommendation, confidence, proposals };
}

/* ------------------------------ diagnose ------------------------------ */

export interface DiagnoseOutcome {
  note: string;
  tried: string[];
  found: string[];
  recommendation: string;
  confidence: 'low' | 'medium' | 'high';
  /** There is something an engineer should look at: hand over with the packet. */
  hasProblem: boolean;
}

const bad = (f: DiagFinding) => f.status === 'fail' || f.status === 'warn';

export function diagnoseOutcome(reference: string, results: DiagResult[]): DiagnoseOutcome {
  const tried = results.map((r) => `${DIAG_RUNBOOKS[r.runbook].label}${r.subject && r.subject !== 'Routes and gateways' ? `: ${r.subject}` : ''}`);
  const found: string[] = [];
  for (const r of results) {
    for (const f of r.findings.filter((x) => x.status === 'fail')) found.push(`${r.subject}: ${f.title}${f.detail ? ` (${f.detail})` : ''}`);
  }
  for (const r of results) {
    for (const f of r.findings.filter((x) => x.status === 'warn' && !/Discovery/.test(x.title))) found.push(`${r.subject}: ${f.title}`);
  }
  const fails = results.filter((r) => r.status === 'fail').length;
  const stale = results.some((r) => r.findings.some((f) => bad(f) && /Discovery/.test(f.title)));
  const hasProblem = found.length > 0;
  const recommendation = fails
    ? `Start with: ${found[0]}.`
    : hasProblem
      ? `Nothing is clearly broken in what Voxshift knows, but look at: ${found[0]}.`
      : `Nothing wrong found in Discovery or the design${stale ? ', though the Discovery data is out of date' : ''}. Check the live tenant and the person's own experience.`;
  const confidence = fails ? 'high' : hasProblem ? 'medium' : 'low';
  const note = [
    `Diagnosis of ${reference}: ran ${results.length} check${results.length === 1 ? '' : 's'}.`,
    ...results.map((r) => `- ${DIAG_RUNBOOKS[r.runbook].label}: ${r.summary}`),
    `Recommendation: ${recommendation}`,
    stale ? 'The Discovery data behind this is more than 7 days old or missing; run a Discovery before relying on it.' : '',
    'These checks read Discovery and the design, not the live tenant. I am an automated assistant working from rules.',
  ]
    .filter(Boolean)
    .join('\n');
  return { note, tried, found: found.slice(0, 12), recommendation, confidence, hasProblem };
}

/* ------------------------------ comms ------------------------------ */

export interface CommsContext {
  priority: IncPriority;
  status: IncStatus;
  holdReason: IncHoldReason | null;
  major: boolean;
  createdAt: string;
  /** The last update the customer saw from the team (a public reply or a status change), if any. */
  lastPublicUpdateAt: string | null;
  title: string;
  now?: Date;
}

/** Is a customer update due on this incident? */
export function commsDue(c: CommsContext): boolean {
  const cadence = COMMS_CADENCE_MINUTES[c.priority];
  if (!cadence || c.major) return false;
  if (!['new', 'in_progress', 'on_hold'].includes(c.status)) return false;
  if (c.status === 'on_hold' && c.holdReason === 'customer') return false;
  const now = (c.now ?? new Date()).getTime();
  const since = new Date(c.lastPublicUpdateAt ?? c.createdAt).getTime();
  return now - since >= cadence * 60_000;
}

const HOLD_TEXT: Record<IncHoldReason, string> = {
  customer: 'We are waiting to hear from you',
  carrier: 'We are waiting on your carrier',
  microsoft: 'We are waiting on Microsoft',
  vendor: 'We are waiting on a supplier',
};

/** The draft update: plain, from the record, and nothing it cannot back up. */
export function commsDraft(c: CommsContext & { nextUpdateMinutes?: number }): string {
  const every = c.nextUpdateMinutes ?? COMMS_CADENCE_MINUTES[c.priority] ?? 120;
  const state =
    c.status === 'new'
      ? 'Your report has been received and an engineer is picking it up.'
      : c.status === 'on_hold' && c.holdReason
        ? `${HOLD_TEXT[c.holdReason]}, and we are chasing them.`
        : 'An engineer is working on it.';
  const within = every % 60 === 0 ? `${every / 60} hour${every === 60 ? '' : 's'}` : `${every} minutes`;
  return `An update on "${c.title}". ${state} We will update you again within ${within}, or sooner if anything changes. Reply here if anything changes at your end.`;
}
