/**
 * Assistants completing service requests (docs/INCIDENT-MANAGEMENT.md, chunk 7; docs/SERVICE-REQUEST-AGENTS.md).
 *
 * An assistant can carry a change or removal request from "Planned" to "Deployed" with ONE human approval, but only
 * where every step is mechanical and can be checked: the request has an automation profile (below), everything the
 * customer asked for maps cleanly onto Design & Build (nothing left for a person to decide), the What-If is clean, and
 * the exact commands a person approved are the commands that run. This file is the pure part: which requests qualify,
 * what an assistant may propose, and the What-If rules. The API enforces them (`sr-agent-api.service.ts`).
 */
import { z } from 'zod';
import type { DeploymentPreviewRow } from './index';
import { srChangePlan, type SrChangePlan } from './service-request-change';
import type { SrStatus, SrType } from './service-requests';

/* ------------------------------ which requests qualify ------------------------------ */

/**
 * Request types that have an automation profile. Everything here is a change or removal of something that already
 * exists in Design & Build, applied by `srChangePlan` (the same mapping an engineer's "Apply the request" uses). New
 * things (users, queues, attendants, sites, numbers) need design decisions and stay with people.
 */
export const SR_AUTOMATION_TYPES: readonly SrType[] = ['change_user', 'change_call_queue', 'change_auto_attendant', 'remove_user', 'remove_common_area_phone'];

/**
 * To-do lines `srChangePlan` leaves for an engineer that are only follow-ups AFTER the change, not decisions before
 * it. Any other line means a person has something to decide, so the request is not automatable.
 */
const FOLLOW_UPS: readonly RegExp[] = [/^Once it is deployed, clear the phone number/, /^Keep the number on the row for now/, /^Check the holiday closure/];

export interface SrAutomation {
  /** An assistant may apply, check and (with approval) deploy this request. */
  eligible: boolean;
  /** Why not, in plain words; empty when eligible. */
  reasons: string[];
  /** What the assistant will apply, in plain words. */
  applies: string[];
  /** Things a person should do after it is deployed (clearing a number, checking a holiday message). */
  followUps: string[];
}

function appliesText(a: SrChangePlan): string[] {
  const out: string[] = [];
  const x = a.apply;
  if (x.newNumber) out.push(`give it the number ${x.newNumber}`);
  if (x.voicemail !== undefined) out.push(`turn voicemail ${x.voicemail ? 'on' : 'off'}`);
  if (x.revoke) out.push('remove its number and Teams calling');
  if (x.addAgents?.length) out.push(`add ${x.addAgents.length} agent${x.addAgents.length === 1 ? '' : 's'}`);
  if (x.removeAgents?.length) out.push(`remove ${x.removeAgents.length} agent${x.removeAgents.length === 1 ? '' : 's'}`);
  if (x.routing) out.push(`set the routing to ${x.routing}`);
  if (x.greeting) out.push('change the greeting');
  if (x.holiday) out.push(`add the holiday closure "${x.holiday.name}"`);
  return out;
}

/**
 * Can an assistant do this request? `status` is the request's current status: only open requests qualify. The answer
 * says why not, so an engineer can see what is stopping it and an assistant knows to hand over.
 */
export function srAutomation(type: SrType, details: Record<string, unknown>, status: SrStatus): SrAutomation {
  const no = (...reasons: string[]): SrAutomation => ({ eligible: false, reasons, applies: [], followUps: [] });
  if (!SR_AUTOMATION_TYPES.includes(type)) return no('This kind of request needs a person to design it.');
  if (status === 'deployed' || status === 'cancelled' || status === 'declined') return no('This request is finished.');
  const mapped = srChangePlan(type, details);
  if (!mapped.ok) return no(mapped.error);
  const plan = mapped.plan;
  const blockers = plan.todo.filter((l) => !FOLLOW_UPS.some((re) => re.test(l)));
  const applies = appliesText(plan);
  if (!applies.length && !blockers.length) return no('Nothing in the request can be applied automatically.');
  if (blockers.length) return { eligible: false, reasons: blockers.map((b) => `A person has to decide: ${b}`), applies, followUps: [] };
  return { eligible: true, reasons: [], applies, followUps: plan.todo.filter((l) => FOLLOW_UPS.some((re) => re.test(l))) };
}

/* ------------------------------ What-If ------------------------------ */

export interface SrWhatIfVerdict {
  /** Clean and worth deploying: something to do, nothing to warn about. */
  ok: boolean;
  rows: number;
  calls: number;
  warnings: string[];
  /** Why it is not ok, in plain words. */
  reasons: string[];
}

/** Judges a What-If (the preview of what a deployment would do). Zero warnings and at least one change, or it is not ok. */
export function srWhatIfVerdict(rows: Pick<DeploymentPreviewRow, 'upn' | 'calls' | 'warnings'>[]): SrWhatIfVerdict {
  const calls = rows.reduce((n, r) => n + r.calls.length, 0);
  const warnings = rows.flatMap((r) => r.warnings.map((w) => `${r.upn}: ${w}`));
  const reasons: string[] = [];
  if (!rows.length) reasons.push('There is nothing designed for this request.');
  else if (!calls && !warnings.length) reasons.push('Nothing would change: what the request asks for is already in place.');
  if (warnings.length) reasons.push(`${warnings.length === 1 ? 'The What-If has a warning' : `The What-If has ${warnings.length} warnings`}: ${warnings.slice(0, 3).join('; ')}`);
  return { ok: reasons.length === 0, rows: rows.length, calls, warnings, reasons };
}

/**
 * The canonical text of a plan: every row and the exact commands it would run. Hashed by the API into the fingerprint a
 * person approves, so what runs is what was approved, command for command.
 */
export function srPlanText(rows: Pick<DeploymentPreviewRow, 'rowId' | 'objectType' | 'renderedCommands'>[]): string {
  return [...rows]
    .sort((a, b) => a.rowId.localeCompare(b.rowId))
    .map((r) => `# ${r.objectType} ${r.rowId}\n${r.renderedCommands.join('\n')}`)
    .join('\n\n');
}

/* ------------------------------ proposals ------------------------------ */

const body = z.string().trim().min(1).max(4000);

/**
 * What an assistant may propose on a request. `server` kinds are carried out by the platform when a person approves
 * (as the assistant); `external` steps are carried out by the assistant afterwards (apply the request, What-If, deploy).
 * There is no decline, cancel or send-back: an assistant that is stuck hands over.
 */
export const SR_PROPOSAL_KINDS = {
  comment: { label: 'Reply to the customer', server: true, params: z.object({ body }).strict() },
  status: { label: 'Move the request on', server: true, params: z.object({ to: z.enum(['planned', 'built']), note: z.string().trim().max(2000).optional() }).strict() },
  external: {
    label: 'A step the assistant will carry out',
    server: false,
    params: z
      .object({
        actionClass: z.enum(['change_design', 'change_whatif', 'change_deploy']),
        title: z.string().trim().min(3).max(200),
        detail: z.string().trim().max(4000).optional(),
        /** The plan the proposal is about, filled in by the API for a deploy: `{ fingerprint, commands }`. Not taken from the assistant. */
        args: z.record(z.unknown()).optional(),
      })
      .strict(),
  },
} as const;
export type SrProposalKind = keyof typeof SR_PROPOSAL_KINDS;
export const SR_PROPOSAL_KIND_KEYS = Object.keys(SR_PROPOSAL_KINDS) as [SrProposalKind, ...SrProposalKind[]];

export const srProposalSchema = z
  .object({
    kind: z.enum(SR_PROPOSAL_KIND_KEYS),
    params: z.record(z.unknown()).default({}),
    rationale: z.string().trim().min(3, 'Say why').max(4000),
    risk: z.enum(['low', 'medium', 'high']).default('low'),
    expiresInMinutes: z.number().int().min(5).max(7 * 24 * 60).default(24 * 60),
  })
  .strict()
  .superRefine((v, ctx) => {
    const r = SR_PROPOSAL_KINDS[v.kind].params.safeParse(v.params);
    if (!r.success) ctx.addIssue({ code: 'custom', path: ['params'], message: r.error.issues.map((i) => `${i.path.join('.') || 'params'}: ${i.message}`).join('; ') });
  });
export type SrProposalInput = z.infer<typeof srProposalSchema>;

/** The autonomy class a proposal needs. */
export function srProposalClass(kind: SrProposalKind, params: Record<string, unknown>): 'customer_update' | 'triage' | 'change_design' | 'change_whatif' | 'change_deploy' {
  if (kind === 'comment') return 'customer_update';
  if (kind === 'status') return params.to === 'built' ? 'change_design' : 'triage';
  return params.actionClass as 'change_design' | 'change_whatif' | 'change_deploy';
}

export function srProposalSummary(kind: SrProposalKind, p: Record<string, unknown>): string {
  switch (kind) {
    case 'comment':
      return `Tell the customer: ${String(p.body ?? '')}`;
    case 'status':
      return `Move the request to ${p.to === 'built' ? 'Designed & built' : 'Planned'}${p.note ? `: ${String(p.note)}` : ''}`;
    case 'external':
      return `${String(p.title ?? 'A step')}${p.detail ? ` - ${String(p.detail)}` : ''}`;
  }
}

/** The request body for the agent endpoints that take a step. */
export const srAgentStepSchema = z.object({ proposalId: z.string().uuid().optional() }).strict();
export type SrAgentStepInput = z.infer<typeof srAgentStepSchema>;

export const srAgentStatusSchema = z.object({ to: z.enum(['planned', 'built']), note: z.string().trim().max(2000).optional() }).strict();
export type SrAgentStatusInput = z.infer<typeof srAgentStatusSchema>;

export const srAgentNoteSchema = z.object({ body }).strict();
export type SrAgentNoteInput = z.infer<typeof srAgentNoteSchema>;

export const srAgentListSchema = z
  .object({
    tenantId: z.string().uuid().optional(),
    status: z.enum(['open', 'all', 'new', 'planned', 'built', 'deployed', 'cancelled', 'declined']).default('open'),
    type: z.string().max(40).optional(),
    assigned: z.enum(['me', 'unassigned']).optional(),
    /** Only requests an assistant could carry through. */
    automatable: z.coerce.boolean().optional(),
    limit: z.coerce.number().int().min(1).max(200).default(50),
  })
  .strict();
export type SrAgentListInput = z.infer<typeof srAgentListSchema>;

/** A person approves or rejects an assistant's proposal on a request. A deploy needs the session it will run on. */
export const srProposalDecisionSchema = z
  .object({ decision: z.enum(['approve', 'reject']), note: z.string().trim().max(1000).optional(), connectionId: z.string().uuid().optional() })
  .strict();
export type SrProposalDecisionInput = z.infer<typeof srProposalDecisionSchema>;

/** Why an assistant's deploy was refused, for the guardrail checks to share. */
export const SR_DEPLOY_GUARDRAILS = [
  'The request has an automation profile and nothing in it needs a person to decide.',
  'A person approved this exact deploy, naming the tenant session it runs on.',
  'The What-If is clean (something to do, no warnings) and its commands are the ones approved, command for command.',
  'Only the request\'s own rows are in scope.',
  'The request is Designed & built, any customer approval is given, and the customer\'s change window is open.',
  'The tenant is not read-only, and no maintenance freeze is on.',
  'Afterwards the live tenant is re-read and must match the design before the request is marked Deployed.',
] as const;
