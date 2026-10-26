import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import {
  AGENT_CONFIDENCE,
  AGENT_DOMAINS,
  AGENT_PROPOSAL_KINDS,
  AGENT_PROPOSAL_KIND_KEYS,
  AGENT_RISKS,
  DIAG_RUNBOOKS,
  DIAG_RUNBOOK_KEYS,
  INC_HOLD_REASONS,
  INC_ITEM_KINDS,
  INC_PRIORITIES,
  INC_STATUSES,
  type AgentDomain,
} from '@tvmf/shared';
import { AgentApiClient, VoxshiftError } from './client';

const tenantId = z.guid().describe('The customer id (tenant_id on every incident).');
const incidentId = z.guid().describe('The incident id.');
const idempotencyKey = z.string().max(200).optional().describe('Make a retry safe: the same key does the thing once. Left out, a fresh key is used.');
const expectedVersion = z.number().int().positive().optional().describe('The incident version you last read. The call is refused if it has moved since.');
const both = { tenantId, incidentId };

type Result = { content: { type: 'text'; text: string }[]; isError?: boolean };
const ok = (v: unknown): Result => ({ content: [{ type: 'text', text: typeof v === 'string' ? v : JSON.stringify(v, null, 2) }] });

/** What to tell the model when the API refuses: the message, and what to do about it. */
function failure(e: unknown): Result {
  if (e instanceof VoxshiftError) {
    const hint =
      e.code === 'wrong_area'
        ? ' This assistant was set up for a different area (see whoami). Do not retry: use only the tools you were given, and ask a person if you need the other area.'
        : e.code === 'propose_instead'
        ? ' Use propose_action instead: a person decides, and you carry it out if it is a step for you.'
        : e.code === 'taken_over'
          ? ' A person has taken this incident over. Stop changing it; you may still read it.'
          : e.code === 'stale'
            ? ' The incident changed since you read it. Call get_incident again and decide again.'
            : e.status === 401
              ? ' The token is wrong, expired or revoked.'
              : e.status === 403
                ? ' Not allowed: check the token scopes and this customer\'s autonomy for you (get_incident shows it).'
                : '';
    return { isError: true, content: [{ type: 'text', text: `${e.message}${e.code ? ` [${e.code}]` : ''}.${hint}` }] };
  }
  return { isError: true, content: [{ type: 'text', text: `Could not reach Voxshift: ${(e as Error).message}` }] };
}

async function run(fn: () => Promise<unknown>): Promise<Result> {
  try {
    return ok(await fn());
  } catch (e) {
    return failure(e);
  }
}

type Args = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
type ToolConfig = { title: string; description: string; inputSchema: Record<string, unknown>; annotations?: Record<string, unknown> };
type PromptConfig = { title: string; description: string; argsSchema: Record<string, unknown> };
type RegisterTool = (name: string, config: ToolConfig, handler: (a: Args) => Promise<Result>) => unknown;
type RegisterPrompt = (name: string, config: PromptConfig, handler: (a: Args) => unknown) => unknown;

const READ = { readOnlyHint: true, openWorldHint: false } as const;
const WRITE = { readOnlyHint: false, destructiveHint: false, openWorldHint: false } as const;

/**
 * The agent API as MCP tools (docs/MCP.md). Same operations, same limits: the token's scopes, the customer's autonomy for
 * the agent, the lease, and proposals for anything it may not do alone. The model is told in each description what the
 * call needs, and a refusal says what to do next.
 */
export function createMcpServer(api: AgentApiClient, info: { name?: string; version?: string } = {}, worksOn: readonly AgentDomain[] = AGENT_DOMAINS): McpServer {
  const server = new McpServer({ name: info.name ?? 'voxshift-incidents', version: info.version ?? '0.1.0' });
  // The SDK's generic inference over zod shapes is very expensive for this many tools; the shapes are checked by zod at
  // run time and by the tests, so the registration helpers take them loosely.
  const tool = (name: string, config: ToolConfig, handler: (a: Args) => Promise<Result>) => (server.registerTool as unknown as RegisterTool).call(server, name, config, handler);
  const prompt = (name: string, config: PromptConfig, handler: (a: Args) => unknown) => (server.registerPrompt as unknown as RegisterPrompt).call(server, name, config, handler);
  // An assistant is set up for incidents, service requests, or both (docs/AGENTS.md). It is only given the tools for those, so a bot
  // for one area never even sees the other's.
  const inIncidents = worksOn.includes('incidents');
  const inRequests = worksOn.includes('service_requests');
  const incTool: typeof tool = (n, c, h) => (inIncidents ? tool(n, c, h) : undefined);
  const reqTool: typeof tool = (n, c, h) => (inRequests ? tool(n, c, h) : undefined);
  const incPrompt: typeof prompt = (n, c, h) => (inIncidents ? prompt(n, c, h) : undefined);
  const reqPrompt: typeof prompt = (n, c, h) => (inRequests ? prompt(n, c, h) : undefined);

  tool(
    'whoami',
    {
      title: 'Who am I',
      description: 'This assistant\'s name, where it works (incidents, service requests, or both), its token scopes, and for each customer it is allowed on, the autonomy levels that apply to it. Call it first: it tells you what you may do before you try.',
      inputSchema: {},
      annotations: READ,
    },
    () => run(() => api.me()),
  );

  incTool(
    'list_incidents',
    {
      title: 'List incidents',
      description: 'Incidents at every customer you are allowed on, most urgent first. Use assigned="unassigned" to see the queue nobody has picked up, or "me" for what you hold.',
      inputSchema: { status: z.enum(['open', 'all', ...INC_STATUSES]).default('open').describe('"open" = not finished.'), assigned: z.enum(['me', 'unassigned']).optional(), tenantId: tenantId.optional(), limit: z.number().int().min(1).max(200).optional() },
      annotations: READ,
    },
    (a: Args) => run(() => api.listIncidents(a)),
  );

  incTool(
    'get_incident',
    {
      title: 'Read an incident',
      description: 'Everything to work an incident: the record, the whole timeline (internal notes too), linked items, known errors (with workarounds), similar open incidents, checks already run and checks worth running, any claim, your proposals, and YOUR autonomy for this customer (what you may do alone). Read this before acting.',
      inputSchema: both,
      annotations: READ,
    },
    (a: Args) => run(() => api.getIncident(a.tenantId, a.incidentId)),
  );

  incTool(
    'claim_incident',
    {
      title: 'Take an incident on',
      description: 'Take a lease on the incident (and become its assignee). You need one to change anything. It lapses after ttlSeconds (default 600): renew it with renew_claim while you work. Fails if someone else holds it or a person took it over.',
      inputSchema: { ...both, ttlSeconds: z.number().int().min(60).max(3600).optional(), note: z.string().max(500).optional(), idempotencyKey },
      annotations: WRITE,
    },
    (a: Args) => run(() => api.claim(a.tenantId, a.incidentId, { ttlSeconds: a.ttlSeconds, note: a.note }, a.idempotencyKey)),
  );

  incTool(
    'renew_claim',
    { title: 'Renew your lease', description: 'Extend your lease on an incident you hold.', inputSchema: { ...both, ttlSeconds: z.number().int().min(60).max(3600).optional() }, annotations: WRITE },
    (a: Args) => run(() => api.heartbeat(a.tenantId, a.incidentId, { ttlSeconds: a.ttlSeconds })),
  );

  incTool(
    'release_incident',
    { title: 'Let go of an incident', description: 'Give up your lease. The incident goes back to the queue (you are no longer its assignee). Use hand_off instead when you have something to tell the next person.', inputSchema: both, annotations: WRITE },
    (a: Args) => run(() => api.release(a.tenantId, a.incidentId)),
  );

  incTool(
    'add_internal_note',
    {
      title: 'Add an internal note',
      description: 'A note only the MSP team sees. Needs the "note" scope and internal-notes autonomy of at least Suggest. Say what you found and why; the note is labelled as yours.',
      inputSchema: { ...both, body: z.string().min(1).max(4000), expectedVersion, idempotencyKey },
      annotations: WRITE,
    },
    (a: Args) => run(() => api.note(a.tenantId, a.incidentId, { body: a.body, expectedVersion: a.expectedVersion }, a.idempotencyKey)),
  );

  incTool(
    'change_status',
    {
      title: 'Change status',
      description: 'Acknowledge (in_progress), hold, restore, resolve, close, mark duplicate. Needs the "act" scope, a held lease and "act alone" autonomy for that kind of change (resolving needs the resolve class). If refused with propose_instead, use propose_action with kind "status_change". on_hold needs holdReason; duplicate needs duplicateOf.',
      inputSchema: { ...both, to: z.enum(INC_STATUSES), note: z.string().max(4000).optional(), holdReason: z.enum(INC_HOLD_REASONS).optional(), duplicateOf: z.guid().optional(), expectedVersion, idempotencyKey },
      annotations: WRITE,
    },
    (a: Args) => run(() => api.status(a.tenantId, a.incidentId, { to: a.to, note: a.note, holdReason: a.holdReason, duplicateOf: a.duplicateOf, expectedVersion: a.expectedVersion }, a.idempotencyKey)),
  );

  incTool(
    'set_priority',
    { title: 'Change priority', description: 'Needs a held lease and "act alone" triage autonomy; otherwise propose_action kind "set_priority". The reason stays internal.', inputSchema: { ...both, priority: z.enum(INC_PRIORITIES), reason: z.string().min(3).max(1000), expectedVersion, idempotencyKey }, annotations: WRITE },
    (a: Args) => run(() => api.priority(a.tenantId, a.incidentId, { priority: a.priority, reason: a.reason, expectedVersion: a.expectedVersion }, a.idempotencyKey)),
  );

  incTool(
    'link_item',
    { title: 'Link an affected item', description: 'Record a user, number, queue, site ... the incident is about. Needs a held lease and triage autonomy.', inputSchema: { ...both, kind: z.enum(INC_ITEM_KINDS), ref: z.string().min(1).max(200), label: z.string().max(200).optional(), idempotencyKey }, annotations: WRITE },
    (a: Args) => run(() => api.linkItem(a.tenantId, a.incidentId, { kind: a.kind, ref: a.ref, label: a.label }, a.idempotencyKey)),
  );

  incTool(
    'list_runbooks',
    {
      title: 'List diagnostic checks',
      description: 'The read-only checks run_diagnostic can run, and what each needs. They look at the last Discovery and the design, never the live tenant.',
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async () => ok(Object.values(DIAG_RUNBOOKS)),
  );

  incTool(
    'run_diagnostic',
    {
      title: 'Run a diagnostic check',
      description: 'A read-only check (see list_runbooks) with a result you can rely on and cite: findings with ok/warn/fail, and how old the data is. Needs a held lease. At "act alone" diagnostics autonomy it runs directly; at "act with approval" it must be an approved propose_action of kind "external" (actionClass "diagnostic_read"), named in proposalId.',
      inputSchema: { ...both, runbook: z.enum(DIAG_RUNBOOK_KEYS), input: z.string().max(200).optional().describe('What to check: an email address, a phone number or a queue name, depending on the check.'), proposalId: z.guid().optional(), idempotencyKey },
      annotations: WRITE,
    },
    (a: Args) => run(() => api.diagnostic(a.tenantId, a.incidentId, { runbook: a.runbook, input: a.input, proposalId: a.proposalId }, a.idempotencyKey)),
  );

  incTool(
    'list_diagnostics',
    { title: 'Checks already run', description: 'Checks run on this incident so far, and the checks worth running.', inputSchema: both, annotations: READ },
    (a: Args) => run(() => api.diagnostics(a.tenantId, a.incidentId)),
  );

  const kinds = AGENT_PROPOSAL_KIND_KEYS.map((k) => `${k} (${AGENT_PROPOSAL_KINDS[k].label})`).join('; ');
  incTool(
    'propose_action',
    {
      title: 'Propose a next step',
      description: `Put a step in front of a person to approve. Kinds: ${kinds}. For server kinds the platform carries it out on approval; for "external" you do it after approval and report with report_proposal_result. customer_update and ask_customer are the only way to say something to the customer, and a person always approves it. At most 5 open proposals per assistant.`,
      inputSchema: {
        ...both,
        kind: z.enum(AGENT_PROPOSAL_KIND_KEYS),
        params: z.record(z.string(), z.unknown()).default({}).describe('Depends on kind: customer_update {body}; status_change {to, note?, holdReason?, duplicateOf?}; set_priority {priority, reason}; assign_user {userId}; declare_major {leadId, commsId?, intervalMinutes?, summary}; link_problem {problemId}; link_item {kind, ref, label?}; external {actionClass, title, detail?, args?}.'),
        rationale: z.string().min(3).max(4000).describe('Why. The person deciding reads this.'),
        risk: z.enum(AGENT_RISKS).default('low'),
        expiresInMinutes: z.number().int().min(5).optional(),
        idempotencyKey,
      },
      annotations: WRITE,
    },
    (a: Args) => run(() => api.propose(a.tenantId, a.incidentId, { kind: a.kind, params: a.params, rationale: a.rationale, risk: a.risk, expiresInMinutes: a.expiresInMinutes }, a.idempotencyKey)),
  );

  incTool(
    'list_proposals',
    { title: 'My proposals', description: 'Your proposals on this incident and what became of them (proposed, approved, rejected, running, done, failed, expired).', inputSchema: both, annotations: READ },
    (a: Args) => run(() => api.proposals(a.tenantId, a.incidentId)),
  );

  incTool(
    'report_proposal_result',
    {
      title: 'Report on an approved step',
      description: 'After you carry out an approved "external" proposal: running, done or failed, with a result or error.',
      inputSchema: { ...both, proposalId: z.guid(), state: z.enum(['running', 'done', 'failed']), result: z.record(z.string(), z.unknown()).optional(), error: z.string().max(2000).optional() },
      annotations: WRITE,
    },
    (a: Args) => run(() => api.proposalResult(a.tenantId, a.incidentId, a.proposalId, { state: a.state, result: a.result, error: a.error })),
  );

  incTool(
    'hand_off',
    {
      title: 'Hand over to the team',
      description: 'You cannot or should not go further: release your lease and give the next person what you tried, what you found, evidence, a recommendation and how sure you are. It goes back to the queue (or to toUserId) and the team is told. If your confidence is low, hand off rather than guess.',
      inputSchema: {
        ...both,
        to: z.enum(['human', 'queue']).default('queue'),
        toUserId: z.guid().optional(),
        summary: z.object({
          tried: z.array(z.string().max(500)).max(20).default([]),
          found: z.array(z.string().max(500)).max(20).default([]),
          recommendation: z.string().min(3).max(2000),
          confidence: z.enum(AGENT_CONFIDENCE),
          evidence: z.array(z.object({ label: z.string().max(200), url: z.string().max(500).optional() })).max(20).default([]),
        }),
        idempotencyKey,
      },
      annotations: WRITE,
    },
    (a: Args) => run(() => api.handoff(a.tenantId, a.incidentId, { to: a.to, toUserId: a.toUserId, summary: a.summary }, a.idempotencyKey)),
  );

  tool(
    'get_events',
    { title: 'Events feed', description: 'What happened since the last event you saw (new incidents, messages, assignments, SLA warnings, decisions on your proposals, a person taking over, a request to look at an incident). Pass the previous "next" as after; start at 0.', inputSchema: { after: z.number().int().min(0).default(0), limit: z.number().int().min(1).max(500).optional() }, annotations: READ },
    (a: Args) => run(() => api.events(a.after, a.limit)),
  );

  /* ------------------------------ service requests ------------------------------ */

  const requestId = z.guid().describe('The service request id.');
  const reqBoth = { tenantId, requestId };

  reqTool(
    'list_service_requests',
    {
      title: 'List service requests',
      description: 'Service requests at every customer you are allowed on. Each says whether an assistant could carry it through (`automatable`): only change and removal requests that map completely onto Design & Build qualify. Use automatable=true to see just those.',
      inputSchema: { status: z.enum(['open', 'all', 'new', 'planned', 'built', 'deployed', 'cancelled', 'declined']).default('open'), assigned: z.enum(['me', 'unassigned']).optional(), automatable: z.boolean().optional(), type: z.string().optional(), tenantId: tenantId.optional(), limit: z.number().int().min(1).max(200).optional() },
      annotations: READ,
    },
    (a: Args) => run(() => api.listRequests(a)),
  );

  reqTool(
    'get_service_request',
    {
      title: 'Read a service request',
      description: 'The request and its timeline, the design so far, whether it can be automated and what it would do (`automation`), the current What-If (verdict, the exact commands, and a fingerprint of them), recent deployment runs, the claim, your proposals, and YOUR autonomy for this customer. Read this before acting.',
      inputSchema: reqBoth,
      annotations: READ,
    },
    (a: Args) => run(() => api.getRequest(a.tenantId, a.requestId)),
  );

  reqTool(
    'claim_request',
    { title: 'Take a request on', description: 'Take a lease on the request (and become its assignee). You need one to change anything. Renew it with renew_request_claim while you work. Fails if someone else holds it or a person took it over.', inputSchema: { ...reqBoth, ttlSeconds: z.number().int().min(60).max(3600).optional(), note: z.string().max(500).optional(), idempotencyKey }, annotations: WRITE },
    (a: Args) => run(() => api.claimRequest(a.tenantId, a.requestId, { ttlSeconds: a.ttlSeconds, note: a.note }, a.idempotencyKey)),
  );
  reqTool('renew_request_claim', { title: 'Renew your lease on a request', description: 'Extend your lease.', inputSchema: { ...reqBoth, ttlSeconds: z.number().int().min(60).max(3600).optional() }, annotations: WRITE }, (a: Args) => run(() => api.heartbeatRequest(a.tenantId, a.requestId, { ttlSeconds: a.ttlSeconds })));
  reqTool('release_request', { title: 'Let go of a request', description: 'Give up your lease; the request goes back to the queue. Use hand_off_request when you have something to tell the next person.', inputSchema: reqBoth, annotations: WRITE }, (a: Args) => run(() => api.releaseRequest(a.tenantId, a.requestId)));

  reqTool(
    'add_request_note',
    { title: 'Add an internal note to a request', description: 'A note only the MSP team sees. Needs the "note" scope and internal-notes autonomy of at least Suggest.', inputSchema: { ...reqBoth, body: z.string().min(1).max(4000), idempotencyKey }, annotations: WRITE },
    (a: Args) => run(() => api.requestNote(a.tenantId, a.requestId, { body: a.body }, a.idempotencyKey)),
  );

  reqTool(
    'move_request',
    {
      title: 'Move a request to Planned or Designed & built',
      description: 'Only on a request an assistant can carry through (see automation). "planned" needs "act alone" for triage; "built" signs the design off and needs "act alone" for the design step, the design done and a held lease. Anything else (decline, cancel, send back) is for a person: hand over instead. If refused with propose_instead, use propose_request_action.',
      inputSchema: { ...reqBoth, to: z.enum(['planned', 'built']), note: z.string().max(2000).optional(), idempotencyKey },
      annotations: WRITE,
    },
    (a: Args) => run(() => api.requestStatus(a.tenantId, a.requestId, { to: a.to, note: a.note }, a.idempotencyKey)),
  );

  reqTool(
    'apply_request',
    {
      title: 'Apply the request to the design',
      description: 'Maps what the customer asked for onto the Design & Build rows linked to the request (the same as an engineer\'s "Apply the request"). Reversible and not live. The request must be Planned and held by you. At "act alone" it runs directly; at "act with approval" it must be an approved propose_request_action of kind "external" (actionClass "change_design"), named in proposalId.',
      inputSchema: { ...reqBoth, proposalId: z.guid().optional(), idempotencyKey },
      annotations: WRITE,
    },
    (a: Args) => run(() => api.applyRequest(a.tenantId, a.requestId, { proposalId: a.proposalId }, a.idempotencyKey)),
  );

  reqTool(
    'what_if_request',
    {
      title: 'Run a What-If on a request',
      description: 'The exact commands a deployment of this request would run, whether that is clean (something to do, zero warnings), and a fingerprint of the commands. Recorded on the request. Nothing touches the tenant. Same permission shape as apply_request (actionClass "change_whatif").',
      inputSchema: { ...reqBoth, proposalId: z.guid().optional(), idempotencyKey },
      annotations: WRITE,
    },
    (a: Args) => run(() => api.requestWhatIf(a.tenantId, a.requestId, { proposalId: a.proposalId }, a.idempotencyKey)),
  );

  reqTool(
    'deploy_request',
    {
      title: 'Deploy an approved change',
      description: 'Deploys a change to the customer\'s live Teams tenant, ONLY as a person approved it: propose it first (propose_request_action kind "external", actionClass "change_deploy"; the server records the exact commands), a person approves it onto their own tenant session, then call this with proposalId. The platform re-checks the approval, that the plan is unchanged, a clean What-If, the change window and the approval of the customer, and refuses otherwise. Afterwards the live tenant is re-read and must match the design before the request is marked Deployed: read the request to see how it went. Needs "act with approval" or better for change_deploy.',
      inputSchema: { ...reqBoth, proposalId: z.guid(), idempotencyKey },
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    },
    (a: Args) => run(() => api.deployRequest(a.tenantId, a.requestId, { proposalId: a.proposalId }, a.idempotencyKey)),
  );

  reqTool(
    'propose_request_action',
    {
      title: 'Propose a next step on a request',
      description: 'Put a step in front of a person. kind "comment" {body} replies to the customer (a person always approves it); "status" {to: planned|built}; "external" {actionClass: change_design|change_whatif|change_deploy, title, detail?} is a step you carry out after approval (apply_request, what_if_request, deploy_request). For a deploy the server fills in the plan from the live What-If and ignores anything you put in args. At most 5 open proposals per request.',
      inputSchema: { ...reqBoth, kind: z.enum(['comment', 'status', 'external']), params: z.record(z.string(), z.unknown()).default({}), rationale: z.string().min(3).max(4000), risk: z.enum(['low', 'medium', 'high']).default('low'), expiresInMinutes: z.number().int().min(5).optional(), idempotencyKey },
      annotations: WRITE,
    },
    (a: Args) => run(() => api.proposeOnRequest(a.tenantId, a.requestId, { kind: a.kind, params: a.params, rationale: a.rationale, risk: a.risk, expiresInMinutes: a.expiresInMinutes }, a.idempotencyKey)),
  );
  reqTool('list_request_proposals', { title: 'My proposals on a request', description: 'Your proposals on this request and what became of them.', inputSchema: reqBoth, annotations: READ }, (a: Args) => run(() => api.requestProposals(a.tenantId, a.requestId)));
  reqTool(
    'report_request_proposal_result',
    { title: 'Report on an approved step', description: 'After carrying out an approved design or What-If step yourself: running, done or failed. (A deployment reports its own outcome.)', inputSchema: { ...reqBoth, proposalId: z.guid(), state: z.enum(['running', 'done', 'failed']), result: z.record(z.string(), z.unknown()).optional(), error: z.string().max(2000).optional() }, annotations: WRITE },
    (a: Args) => run(() => api.requestProposalResult(a.tenantId, a.requestId, a.proposalId, { state: a.state, result: a.result, error: a.error })),
  );
  reqTool(
    'hand_off_request',
    {
      title: 'Hand a request over to the team',
      description: 'You cannot or should not go further: release your lease and give the next person what you tried, found, recommend and how sure you are. If anything needs a person to decide, hand off rather than guess.',
      inputSchema: {
        ...reqBoth,
        to: z.enum(['human', 'queue']).default('queue'),
        toUserId: z.guid().optional(),
        summary: z.object({ tried: z.array(z.string().max(500)).max(20).default([]), found: z.array(z.string().max(500)).max(20).default([]), recommendation: z.string().min(3).max(2000), confidence: z.enum(AGENT_CONFIDENCE), evidence: z.array(z.object({ label: z.string().max(200), url: z.string().max(500).optional() })).max(20).default([]) }),
        idempotencyKey,
      },
      annotations: WRITE,
    },
    (a: Args) => run(() => api.handoffRequest(a.tenantId, a.requestId, { to: a.to, toUserId: a.toUserId, summary: a.summary }, a.idempotencyKey)),
  );

  incPrompt(
    'work_incident',
    {
      title: 'Work an incident',
      description: 'A safe way to triage and diagnose one incident as an assistant.',
      argsSchema: { tenantId: z.guid(), incidentId: z.guid() },
    },
    (a: Args) => ({
      messages: [
        {
          role: 'user',
          content: {
            type: 'text',
            text: [
              `Work Voxshift incident ${a.incidentId} (customer ${a.tenantId}) as an assistant, carefully:`,
              '1. get_incident. Note your autonomy for this customer: it limits what you may do alone.',
              '2. claim_incident, and renew_claim while you work. Never change an incident you do not hold.',
              '3. Run the checks worth running (run_diagnostic). They read Discovery and the design, not the live tenant: say so in what you write, and mention how old the data is.',
              '4. add_internal_note with what you found, why, and how sure you are.',
              '5. For anything you may not do alone (customer-visible text, priority, status, major incidents) use propose_action with a clear rationale. Never tell the customer anything yourself.',
              '6. If you cannot help, or your confidence is low, hand_off with what you tried, found and recommend. Do not guess.',
              'If a call says a person took the incident over, stop. If it says the incident changed, read it again.',
            ].join('\n'),
          },
        },
      ],
    }),
  );

  reqPrompt(
    'work_service_request',
    {
      title: 'Carry a change request through',
      description: 'A safe order of work for one change or removal request: prepare it, and propose the deployment for one person to approve.',
      argsSchema: { tenantId: z.guid(), requestId: z.guid() },
    },
    (a: Args) => ({
      messages: [
        {
          role: 'user',
          content: {
            type: 'text',
            text: [
              `Work Voxshift service request ${a.requestId} (customer ${a.tenantId}) as an assistant, carefully:`,
              '1. get_service_request. Check `automation.eligible`: if it is false, add a note and hand_off_request; do not try to force it. Note your autonomy: it limits what you may do alone.',
              '2. claim_request, and renew_request_claim while you work. Never change a request you do not hold.',
              '3. move_request to planned, apply_request, then move_request to built once the design has no blockers. Read the design after applying and check it is what the customer asked for.',
              '4. what_if_request. It must be clean (something to do, no warnings). If it is not, hand_off_request with the reasons.',
              '5. propose_request_action kind "external", actionClass "change_deploy". A person approves exactly those commands onto their own tenant session. Do not look for ways around that.',
              '6. Once it is approved, deploy_request with the proposalId. The platform refuses if anything changed. Then read the request: it is only Deployed once the live tenant matches the design.',
              'Never tell the customer anything yourself (propose a comment). If a call says a person took the request over, stop. If anything surprises you, hand over with what you found.',
            ].join('\n'),
          },
        },
      ],
    }),
  );

  return server;
}
