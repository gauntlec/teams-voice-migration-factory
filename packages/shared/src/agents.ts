/**
 * AI agents working incidents alongside people (docs/INCIDENT-MANAGEMENT.md, section 7;
 * docs/AGENTS.md for the API). Pure rules and the DTOs the API validates with: what an
 * agent is, the action classes and autonomy levels (with the caps nobody can raise
 * past), what a proposal may be, the shape of a token, and the claim lease.
 */
import { z } from 'zod';
import { DIAG_RUNBOOK_KEYS } from './diagnostics';
import { INC_HOLD_REASONS, INC_ITEM_KINDS, INC_PRIORITIES, INC_STATUSES } from './incidents';

/* ------------------------------ identity ------------------------------ */

export const AGENT_KINDS = ['triage', 'diagnostic', 'resolver', 'comms', 'monitor', 'general'] as const;
export type AgentKind = (typeof AGENT_KINDS)[number];
export const AGENT_KIND_LABELS: Record<AgentKind, string> = {
  triage: 'Triage',
  diagnostic: 'Diagnostics',
  resolver: 'Resolver',
  comms: 'Communications',
  monitor: 'Monitoring',
  general: 'General',
};

/** paused: every write is refused; disabled: its tokens stop working. */
export const AGENT_STATUSES = ['active', 'paused', 'disabled'] as const;
export type AgentStatus = (typeof AGENT_STATUSES)[number];

/** Coarse endpoint groups a token may use. What an agent may actually do is its autonomy policy. */
export const AGENT_SCOPES = ['read', 'note', 'propose', 'act'] as const;
export type AgentScope = (typeof AGENT_SCOPES)[number];
export const AGENT_SCOPE_LABELS: Record<AgentScope, string> = {
  read: 'Read incidents and the events feed',
  note: 'Add internal notes',
  propose: 'Propose next steps for a person to approve',
  act: 'Act directly where its autonomy allows',
};
export const AGENT_DEFAULT_SCOPES: AgentScope[] = ['read', 'note', 'propose'];

/** The label shown wherever an agent's work appears. Customers see a generic one. */
export const AGENT_CUSTOMER_LABEL = 'Voxshift assistant';
export function agentLabel(name: string): string {
  return `${name} (AI)`;
}

/* ------------------------------ tokens ------------------------------ */

/** vxs_agent_<token id>_<secret>. The id finds the row; only a hash of the secret is stored. */
const TOKEN_RE = /^vxs_agent_([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})_([A-Za-z0-9_-]{32,64})$/;

export function parseAgentToken(token: string): { tokenId: string; secret: string } | null {
  const m = TOKEN_RE.exec(token.trim());
  return m ? { tokenId: m[1]!, secret: m[2]! } : null;
}
export function formatAgentToken(tokenId: string, secret: string): string {
  return `vxs_agent_${tokenId}_${secret}`;
}
/** What is shown after the token is created: enough to recognise it, never enough to use it. */
export function agentTokenHint(last4: string): string {
  return `vxs_agent_…${last4}`;
}

/** A token with no expiry set lasts this long. */
export const AGENT_TOKEN_DEFAULT_DAYS = 90;
export const AGENT_TOKEN_MAX_DAYS = 365;

/* ------------------------------ autonomy ------------------------------ */

/** The kinds of thing an agent does, each with its own level of freedom. */
export const AGENT_ACTION_CLASSES = ['triage', 'internal_note', 'customer_update', 'diagnostic_read', 'change_design', 'change_whatif', 'change_deploy', 'resolve'] as const;
export type AgentActionClass = (typeof AGENT_ACTION_CLASSES)[number];
export const AGENT_ACTION_CLASS_LABELS: Record<AgentActionClass, string> = {
  triage: 'Triage (acknowledge, assign, hold, link, change priority)',
  internal_note: 'Internal notes',
  customer_update: 'Customer-visible updates and questions',
  diagnostic_read: 'Read-only diagnostics',
  change_design: 'Applying a service request to the design',
  change_whatif: 'What-If on a change',
  change_deploy: 'Deploying a change',
  resolve: 'Restoring, resolving and closing',
};

/** 0 observe, 1 suggest, 2 act with approval, 3 act alone. */
export const AGENT_LEVELS = [0, 1, 2, 3] as const;
export type AgentLevel = (typeof AGENT_LEVELS)[number];
export const AGENT_LEVEL_LABELS: Record<AgentLevel, string> = {
  0: 'Observe',
  1: 'Suggest',
  2: 'Act with approval',
  3: 'Act alone',
};
export const AGENT_LEVEL_HELP: Record<AgentLevel, string> = {
  0: 'Reads incidents and the events feed; writes nothing.',
  1: 'Adds internal notes and proposes next steps; a person approves each one.',
  2: 'As Suggest, and does the approved steps it carries out itself (diagnostics, What-If, deployments).',
  3: 'Does these things directly, without waiting.',
};

/**
 * The most freedom an action class can ever have. Customer-visible text stays with a person's approval
 * until templates are approved (and always for P1 and P2); a deployment is never unattended.
 */
export const AGENT_LEVEL_CAPS: Record<AgentActionClass, AgentLevel> = {
  triage: 3,
  internal_note: 3,
  customer_update: 2,
  diagnostic_read: 3,
  change_design: 3,
  change_whatif: 3,
  change_deploy: 2,
  resolve: 3,
};

/** A new policy starts here: suggest only, and no changes. */
export const AGENT_DEFAULT_AUTONOMY: Record<AgentActionClass, AgentLevel> = {
  triage: 1,
  internal_note: 1,
  customer_update: 1,
  diagnostic_read: 1,
  change_design: 0,
  change_whatif: 0,
  change_deploy: 0,
  resolve: 1,
};

export type AgentAutonomy = Partial<Record<AgentActionClass, AgentLevel>>;

/** The level in force: what the customer's policy says (or the default), never above the cap. */
export function agentLevel(autonomy: AgentAutonomy | null | undefined, actionClass: AgentActionClass): AgentLevel {
  const set = autonomy?.[actionClass] ?? AGENT_DEFAULT_AUTONOMY[actionClass];
  return Math.min(set, AGENT_LEVEL_CAPS[actionClass]) as AgentLevel;
}
/** Every class with its level in force - what the admin page and the agent API show. */
export function agentEffectiveAutonomy(autonomy: AgentAutonomy | null | undefined): Record<AgentActionClass, AgentLevel> {
  return Object.fromEntries(AGENT_ACTION_CLASSES.map((c) => [c, agentLevel(autonomy, c)])) as Record<AgentActionClass, AgentLevel>;
}

/** What each level lets an agent do with an action class. */
export const agentMayNote = (level: AgentLevel) => level >= 1;
export const agentMayPropose = (level: AgentLevel) => level >= 1;
export const agentMayActDirectly = (level: AgentLevel) => level >= 3;
/** Carries out the steps it proposed itself, once a person has approved them (diagnostics, What-If, deploy). */
export const agentMayExecuteApproved = (level: AgentLevel) => level >= 2;

/* ------------------------------ claims ------------------------------ */

/** An agent working an incident holds a lease and renews it while it works. */
export const AGENT_CLAIM_DEFAULT_SECONDS = 600;
export const AGENT_CLAIM_MAX_SECONDS = 3600;
export const AGENT_CLAIM_MIN_SECONDS = 60;

/* ------------------------------ proposals ------------------------------ */

export const AGENT_PROPOSAL_STATES = ['proposed', 'approved', 'rejected', 'running', 'done', 'failed', 'expired'] as const;
export type AgentProposalState = (typeof AGENT_PROPOSAL_STATES)[number];
export const AGENT_PROPOSAL_STATE_LABELS: Record<AgentProposalState, string> = {
  proposed: 'Waiting for a decision',
  approved: 'Approved',
  rejected: 'Rejected',
  running: 'Running',
  done: 'Done',
  failed: 'Failed',
  expired: 'Expired',
};
/** A proposal that has been settled and will not change again. */
export const AGENT_PROPOSAL_FINAL: readonly AgentProposalState[] = ['rejected', 'done', 'failed', 'expired'];

export const AGENT_PROPOSAL_DEFAULT_MINUTES = 24 * 60;
export const AGENT_PROPOSAL_MAX_MINUTES = 7 * 24 * 60;
/** Two failed attempts on one incident and the agent is taken off it. */
export const AGENT_MAX_FAILURES = 2;

export const AGENT_RISKS = ['low', 'medium', 'high'] as const;

const body = z.string().trim().min(1).max(4000);

/**
 * Proposal kinds. `server: true` kinds are carried out by the platform when a person approves them
 * (as the agent, so the timeline shows it). The rest - `external` - are for the agent to carry out and
 * report on once approved (diagnostics, What-If, a change).
 */
export const AGENT_PROPOSAL_KINDS = {
  customer_update: { label: 'Update the customer', server: true, params: z.object({ body }).strict() },
  ask_customer: { label: 'Ask the customer a question and wait for the reply', server: true, params: z.object({ body }).strict() },
  status_change: {
    label: 'Move the incident on',
    server: true,
    params: z
      .object({
        to: z.enum(INC_STATUSES),
        note: z.string().trim().max(4000).optional(),
        holdReason: z.enum(INC_HOLD_REASONS).optional(),
        duplicateOf: z.string().uuid().optional(),
      })
      .strict(),
  },
  set_priority: { label: 'Change the priority', server: true, params: z.object({ priority: z.enum(INC_PRIORITIES), reason: z.string().trim().min(3).max(1000) }).strict() },
  assign_user: { label: 'Assign to a person', server: true, params: z.object({ userId: z.string().uuid() }).strict() },
  declare_major: {
    label: 'Declare a major incident',
    server: true,
    params: z.object({ leadId: z.string().uuid(), commsId: z.string().uuid().optional(), intervalMinutes: z.number().int().min(10).max(480).optional(), summary: z.string().trim().min(5).max(4000) }).strict(),
  },
  link_problem: { label: 'Link to a problem', server: true, params: z.object({ problemId: z.string().uuid() }).strict() },
  link_item: { label: 'Link an affected item', server: true, params: z.object({ kind: z.enum(INC_ITEM_KINDS), ref: z.string().trim().min(1).max(200), label: z.string().trim().max(200).optional() }).strict() },
  external: {
    label: 'A step the assistant will carry out',
    server: false,
    params: z
      .object({
        /** Which kind of step, so its autonomy can be checked: diagnostics, a What-If, or a change. */
        actionClass: z.enum(['diagnostic_read', 'change_whatif', 'change_deploy']),
        title: z.string().trim().min(3).max(200),
        detail: z.string().trim().max(4000).optional(),
        /** Free-form arguments for the agent's own use (a runbook name and its inputs). */
        args: z.record(z.unknown()).optional(),
      })
      .strict(),
  },
} as const;
export type AgentProposalKind = keyof typeof AGENT_PROPOSAL_KINDS;
export const AGENT_PROPOSAL_KIND_KEYS = Object.keys(AGENT_PROPOSAL_KINDS) as [AgentProposalKind, ...AgentProposalKind[]];

/** The action class a proposal belongs to - what must be allowed for the agent to propose it. */
export function agentProposalClass(kind: AgentProposalKind, params: Record<string, unknown>): AgentActionClass {
  switch (kind) {
    case 'customer_update':
    case 'ask_customer':
      return 'customer_update';
    case 'status_change':
      return ['restored', 'resolved', 'closed'].includes(String(params.to)) ? 'resolve' : 'triage';
    case 'external':
      return params.actionClass as AgentActionClass;
    default:
      return 'triage';
  }
}

/** Validates a proposal's params for its kind. */
export function agentParseProposal(kind: AgentProposalKind, params: unknown): { ok: true; params: Record<string, unknown> } | { ok: false; error: string } {
  const r = AGENT_PROPOSAL_KINDS[kind].params.safeParse(params);
  return r.success ? { ok: true, params: r.data as Record<string, unknown> } : { ok: false, error: r.error.issues.map((i) => `${i.path.join('.') || 'params'}: ${i.message}`).join('; ') };
}

/** One line for the approval card: what approving would do. */
export function agentProposalSummary(kind: AgentProposalKind, p: Record<string, unknown>): string {
  switch (kind) {
    case 'customer_update':
      return `Tell the customer: ${String(p.body ?? '')}`;
    case 'ask_customer':
      return `Ask the customer: ${String(p.body ?? '')}`;
    case 'status_change':
      return `Move the incident to ${String(p.to).replace('_', ' ')}${p.holdReason ? ` (${String(p.holdReason)})` : ''}${p.note ? `: ${String(p.note)}` : ''}`;
    case 'set_priority':
      return `Change the priority to ${String(p.priority).toUpperCase()}: ${String(p.reason ?? '')}`;
    case 'assign_user':
      return 'Assign the incident to a person';
    case 'declare_major':
      return `Declare a major incident: ${String(p.summary ?? '')}`;
    case 'link_problem':
      return 'Link the incident to a problem';
    case 'link_item':
      return `Link ${String(p.kind)} ${String(p.label ?? p.ref ?? '')}`;
    case 'external':
      return `${String(p.title ?? 'A step')}${p.detail ? ` - ${String(p.detail)}` : ''}`;
  }
}

/* ------------------------------ events feed ------------------------------ */

export const AGENT_EVENT_KINDS = [
  'incident.created',
  'incident.updated',
  'incident.message',
  'incident.assigned',
  'incident.major_declared',
  'claim.revoked',
  'claim.expired',
  'proposal.decided',
  'proposal.expired',
  'sla.at_risk',
  'sla.breached',
  'incident.assist_requested',
  'sr.created',
  'sr.updated',
  'sr.assigned',
  'sr.message',
  'sr.proposal.decided',
  'sr.claim.revoked',
  'sr.claim.expired',
] as const;
export type AgentEventKind = (typeof AGENT_EVENT_KINDS)[number];

/** Kept this long; an agent that has been away longer re-reads the queue instead of the feed. */
export const AGENT_EVENT_RETENTION_DAYS = 14;

/* ------------------------------ handoff ------------------------------ */

export const AGENT_CONFIDENCE = ['low', 'medium', 'high'] as const;

/** A structured summary written when an agent hands an incident to a person (or back). */
export const agentHandoffSchema = z
  .object({
    to: z.enum(['human', 'queue']).default('queue'),
    /** A specific person; otherwise it goes back to the unassigned queue. */
    toUserId: z.string().uuid().optional(),
    summary: z
      .object({
        tried: z.array(z.string().trim().min(1).max(500)).max(20).default([]),
        found: z.array(z.string().trim().min(1).max(500)).max(20).default([]),
        recommendation: z.string().trim().min(3).max(2000),
        confidence: z.enum(AGENT_CONFIDENCE),
        evidence: z.array(z.object({ label: z.string().trim().min(1).max(200), url: z.string().trim().max(500).optional() }).strict()).max(20).default([]),
      })
      .strict(),
    expectedVersion: z.number().int().positive().optional(),
  })
  .strict();
export type AgentHandoffInput = z.infer<typeof agentHandoffSchema>;

/* ------------------------------ agent API DTOs ------------------------------ */

const expectedVersion = z.number().int().positive().optional();

export const agentIncidentsQuerySchema = z
  .object({
    tenantId: z.string().uuid().optional(),
    status: z.enum([...INC_STATUSES, 'open', 'all'] as [string, ...string[]]).default('open'),
    /** 'me' = assigned to this agent; 'unassigned' = nobody (person or agent) has it. */
    assigned: z.enum(['me', 'unassigned']).optional(),
    limit: z.coerce.number().int().min(1).max(200).default(50),
  })
  .strict();
export type AgentIncidentsQuery = z.infer<typeof agentIncidentsQuerySchema>;

export const agentNoteSchema = z.object({ body, expectedVersion }).strict();
export type AgentNoteInput = z.infer<typeof agentNoteSchema>;

export const agentStatusSchema = z
  .object({
    to: z.enum(INC_STATUSES),
    note: z.string().trim().max(4000).optional(),
    holdReason: z.enum(INC_HOLD_REASONS).optional(),
    duplicateOf: z.string().uuid().optional(),
    expectedVersion,
  })
  .strict();
export type AgentStatusInput = z.infer<typeof agentStatusSchema>;

export const agentPrioritySchema = z.object({ priority: z.enum(INC_PRIORITIES), reason: z.string().trim().min(3).max(1000), expectedVersion }).strict();
export type AgentPriorityInput = z.infer<typeof agentPrioritySchema>;

export const agentLinkItemSchema = z.object({ kind: z.enum(INC_ITEM_KINDS), ref: z.string().trim().min(1).max(200), label: z.string().trim().max(200).optional() }).strict();
export type AgentLinkItemInput = z.infer<typeof agentLinkItemSchema>;

export const agentClaimSchema = z
  .object({
    note: z.string().trim().max(500).optional(),
    ttlSeconds: z.number().int().min(AGENT_CLAIM_MIN_SECONDS).max(AGENT_CLAIM_MAX_SECONDS).default(AGENT_CLAIM_DEFAULT_SECONDS),
  })
  .strict();
export type AgentClaimInput = z.infer<typeof agentClaimSchema>;

export const agentHeartbeatSchema = z.object({ ttlSeconds: z.number().int().min(AGENT_CLAIM_MIN_SECONDS).max(AGENT_CLAIM_MAX_SECONDS).default(AGENT_CLAIM_DEFAULT_SECONDS) }).strict();
export type AgentHeartbeatInput = z.infer<typeof agentHeartbeatSchema>;

export const agentProposalSchema = z
  .object({
    kind: z.enum(AGENT_PROPOSAL_KIND_KEYS),
    params: z.record(z.unknown()).default({}),
    rationale: z.string().trim().min(3, 'Say why').max(4000),
    risk: z.enum(AGENT_RISKS).default('low'),
    expiresInMinutes: z.number().int().min(5).max(AGENT_PROPOSAL_MAX_MINUTES).default(AGENT_PROPOSAL_DEFAULT_MINUTES),
  })
  .strict()
  .superRefine((v, ctx) => {
    const r = agentParseProposal(v.kind, v.params);
    if (!r.ok) ctx.addIssue({ code: 'custom', path: ['params'], message: r.error });
  });
export type AgentProposalInput = z.infer<typeof agentProposalSchema>;

/** POST .../proposals/:id/result - the agent reports on a step it carried out after approval. */
export const agentProposalResultSchema = z
  .object({
    state: z.enum(['running', 'done', 'failed']),
    result: z.record(z.unknown()).optional(),
    error: z.string().trim().max(2000).optional(),
  })
  .strict();
export type AgentProposalResultInput = z.infer<typeof agentProposalResultSchema>;

/** POST .../diagnostics - run a read-only check. `proposalId` is the approved proposal this carries out (needed below "act alone"). */
export const agentDiagnosticSchema = z
  .object({ runbook: z.enum(DIAG_RUNBOOK_KEYS), input: z.string().trim().max(200).optional(), proposalId: z.string().uuid().optional() })
  .strict();
export type AgentDiagnosticInput = z.infer<typeof agentDiagnosticSchema>;

export const agentEventsQuerySchema = z.object({ after: z.coerce.number().int().min(0).default(0), limit: z.coerce.number().int().min(1).max(500).default(100) }).strict();
export type AgentEventsQuery = z.infer<typeof agentEventsQuerySchema>;

/** A person's decision on a proposal. */
export const proposalDecisionSchema = z.object({ decision: z.enum(['approve', 'reject']), note: z.string().trim().max(1000).optional() }).strict();
export type ProposalDecisionInput = z.infer<typeof proposalDecisionSchema>;

/** POST /incidents/:id/hand-back - give an incident back to an assistant after taking it over. */
export const handBackSchema = z.object({ agentId: z.string().uuid() }).strict();
export type HandBackInput = z.infer<typeof handBackSchema>;

/* ------------------------------ admin DTOs ------------------------------ */

export const createAgentSchema = z
  .object({
    name: z.string().trim().min(2, 'Give the agent a name').max(60),
    kind: z.enum(AGENT_KINDS).default('general'),
    description: z.string().trim().max(500).default(''),
    modelLabel: z.string().trim().max(120).default(''),
    mspId: z.string().uuid().nullable().optional(),
  })
  .strict();
export type CreateAgentInput = z.infer<typeof createAgentSchema>;

export const updateAgentSchema = z
  .object({
    name: z.string().trim().min(2).max(60).optional(),
    kind: z.enum(AGENT_KINDS).optional(),
    description: z.string().trim().max(500).optional(),
    modelLabel: z.string().trim().max(120).optional(),
    status: z.enum(AGENT_STATUSES).optional(),
    mspId: z.string().uuid().nullable().optional(),
  })
  .strict();
export type UpdateAgentInput = z.infer<typeof updateAgentSchema>;

const ipOrCidr = z.string().trim().regex(/^[0-9a-fA-F:.]{3,45}(\/\d{1,3})?$/, 'Use an IP address or range, e.g. 203.0.113.7 or 203.0.113.0/24');

export const createAgentTokenSchema = z
  .object({
    name: z.string().trim().min(2).max(60),
    scopes: z.array(z.enum(AGENT_SCOPES)).min(1).default(AGENT_DEFAULT_SCOPES),
    expiresInDays: z.number().int().min(1).max(AGENT_TOKEN_MAX_DAYS).default(AGENT_TOKEN_DEFAULT_DAYS),
    ipAllow: z.array(ipOrCidr).max(20).default([]),
  })
  .strict();
export type CreateAgentTokenInput = z.infer<typeof createAgentTokenSchema>;

export const agentPolicySchema = z
  .object({
    enabled: z.boolean(),
    autonomy: z.object(Object.fromEntries(AGENT_ACTION_CLASSES.map((c) => [c, z.union([z.literal(0), z.literal(1), z.literal(2), z.literal(3)]).optional()])) as Record<AgentActionClass, z.ZodOptional<z.ZodUnion<[z.ZodLiteral<0>, z.ZodLiteral<1>, z.ZodLiteral<2>, z.ZodLiteral<3>]>>>).strict().default({}),
  })
  .strict();
export type AgentPolicyInput = z.infer<typeof agentPolicySchema>;

/** Webhooks must be https (http only for local development), so a signed event never crosses the internet in the clear. */
export const createAgentWebhookSchema = z
  .object({
    url: z
      .string()
      .trim()
      .url()
      .max(500)
      .refine((u) => u.startsWith('https://') || /^http:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?\//.test(u), 'Use an https:// address'),
    kinds: z.array(z.enum(AGENT_EVENT_KINDS)).default([]),
  })
  .strict();
export type CreateAgentWebhookInput = z.infer<typeof createAgentWebhookSchema>;

/** POST .../incidents/:id/ask - a person asks an assistant to look at an incident now. */
export const askAssistantSchema = z.object({ agentId: z.string().uuid(), question: z.string().trim().min(3, 'Say what you want it to look at').max(1000) }).strict();
export type AskAssistantInput = z.infer<typeof askAssistantSchema>;

/** POST /agents/builtin - add one of the assistants Voxshift ships. */
export const createBuiltinAgentSchema = z.object({ key: z.enum(['triage', 'diagnose', 'comms', 'changes']) }).strict();
export type CreateBuiltinAgentInput = z.infer<typeof createBuiltinAgentSchema>;

export const agentKillSwitchSchema = z.object({ allDisabled: z.boolean(), note: z.string().trim().max(500).optional() }).strict();
export type AgentKillSwitchInput = z.infer<typeof agentKillSwitchSchema>;

export const tenantAgentsSchema = z.object({ enabled: z.boolean() }).strict();
export type TenantAgentsInput = z.infer<typeof tenantAgentsSchema>;

/** Signature header on a webhook delivery: sha256=<hex of HMAC-SHA256(secret, `${timestamp}.${body}`)>. */
export const AGENT_WEBHOOK_SIGNATURE_HEADER = 'X-Voxshift-Signature';
export const AGENT_WEBHOOK_TIMESTAMP_HEADER = 'X-Voxshift-Timestamp';
/** After this many failed deliveries in a row a webhook is switched off. */
export const AGENT_WEBHOOK_MAX_FAILURES = 12;
