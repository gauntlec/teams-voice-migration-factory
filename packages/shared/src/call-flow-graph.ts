/**
 * Pure call-flow graph builder (Workstream 6 of the "reverse-engineer
 * OVP012" plan) - turns either data source into the same generic node/edge
 * shape, so one renderer (apps/web/src/components/CallFlowDiagram.tsx)
 * serves both:
 *
 * - buildCallFlowGraphFromDesign: Design & Build's structured
 *   build_auto_attendants/build_call_queues columns (the "as-designed" view).
 * - buildCallFlowGraphFromLive: Discovery's raw tenant_objects shape (the
 *   "as-is" view), via aa-live-parse.ts's pure parsers plus the same
 *   CallHandlingAssociations walk BuildService.populateStructuredFromLive
 *   already does server-side, done here client-side with no DB.
 *
 * The graph is shallow but can cycle (e.g. a Directory AA's DTMF0 points
 * back to the Main Number AA it came from) - CallFlowDiagram.tsx lays it out
 * with dagre rather than assuming a tree.
 */
import {
  parseLiveCallFlow,
  parseLiveCallTarget,
  type LiveCallableEntityRef,
  type LiveCallFlow,
  type LiveMenuOption,
} from './aa-live-parse';
import type {
  AutoAttendantCallableEntity,
  AutoAttendantCallFlow,
  AutoAttendantHolidayCallFlow,
  AutoAttendantMenuOption,
  AutoAttendantSchedule,
  CallQueueActionSettings,
} from './deployment';

export type CallFlowNodeKind =
  | 'auto_attendant'
  | 'call_queue'
  | 'person'
  | 'external_number'
  | 'voicemail'
  | 'shared_voicemail'
  | 'operator'
  | 'disconnect';

export interface CallFlowNode {
  id: string;
  kind: CallFlowNodeKind;
  label: string;
  sublabel?: string;
}

/** Which schedule branch an edge belongs to - 'operator' is the AA-level -Operator link, not schedule-tied. */
export type CallFlowBranch = 'business_hours' | 'after_hours' | 'holiday' | 'operator' | 'overflow' | 'timeout' | 'no_agent';

export interface CallFlowEdge {
  id: string;
  source: string;
  target: string;
  /** DTMF digit ("1".."9", "0", "Automatic") or the branch's own short label (Overflow/Timeout/No agents/Operator). */
  label: string;
  branch: CallFlowBranch;
  /** e.g. a holiday's own name, when branch is 'holiday'. */
  branchLabel?: string;
}

export interface CallFlowGraph {
  nodes: CallFlowNode[];
  edges: CallFlowEdge[];
}

/** Accumulates nodes (deduped by id) and edges while a graph is built - shared by both adapters below. */
class GraphBuilder {
  private nodes = new Map<string, CallFlowNode>();
  private edges: CallFlowEdge[] = [];

  ensureNode(node: CallFlowNode): string {
    if (!this.nodes.has(node.id)) this.nodes.set(node.id, node);
    return node.id;
  }

  hasNode(id: string): boolean {
    return this.nodes.has(id);
  }

  addEdge(source: string, target: string, label: string, branch: CallFlowBranch, branchLabel?: string): void {
    this.edges.push({ id: `e${this.edges.length}:${source}->${target}`, source, target, label, branch, branchLabel });
  }

  build(): CallFlowGraph {
    return { nodes: [...this.nodes.values()], edges: this.edges };
  }
}

const DTMF_LABEL: Record<string, string> = { Automatic: 'no input' };
function dtmfLabel(dtmf: string): string {
  return DTMF_LABEL[dtmf] ?? dtmf.replace(/^Tone/, '');
}

/* ============================ Design & Build ============================ */

export interface DesignAutoAttendantInput {
  buildId: string;
  name: string;
  operator: AutoAttendantCallableEntity | null;
  defaultCallFlow: AutoAttendantCallFlow | null;
  afterHoursCallFlow: AutoAttendantCallFlow | null;
  schedule: AutoAttendantSchedule | null;
  holidayCallFlows: AutoAttendantHolidayCallFlow[];
}

export interface DesignCallQueueInput {
  buildId: string;
  name: string;
  overflow: CallQueueActionSettings | null;
  timeout: CallQueueActionSettings | null;
  noAgentAction: CallQueueActionSettings | null;
}

function resolveDesignTarget(b: GraphBuilder, entity: AutoAttendantCallableEntity | undefined): string | undefined {
  if (!entity) return undefined;
  switch (entity.kind) {
    case 'auto_attendant':
      return entity.buildId ? b.ensureNode({ id: `aa:${entity.buildId}`, kind: 'auto_attendant', label: '(unresolved)' }) : undefined;
    case 'call_queue':
      return entity.buildId ? b.ensureNode({ id: `cq:${entity.buildId}`, kind: 'call_queue', label: '(unresolved)' }) : undefined;
    case 'user':
      return entity.upn ? b.ensureNode({ id: `user:${entity.upn.toLowerCase()}`, kind: 'person', label: entity.upn }) : undefined;
    case 'external':
      return entity.number ? b.ensureNode({ id: `ext:${entity.number}`, kind: 'external_number', label: entity.number }) : undefined;
    case 'voicemail':
      return b.ensureNode({ id: 'voicemail', kind: 'voicemail', label: 'Voicemail' });
    case 'shared_voicemail':
      return b.ensureNode({ id: 'shared_voicemail', kind: 'shared_voicemail', label: 'Shared voicemail' });
  }
}

/** Note: ensureNode with a placeholder label is a no-op once the real node (from the input lists, registered up front) already exists - the placeholder only "wins" for a genuinely dangling reference, which is exactly what should be visible rather than silently dropped. */
function walkDesignMenuOption(
  b: GraphBuilder,
  sourceId: string,
  opt: AutoAttendantMenuOption,
  operator: AutoAttendantCallableEntity | null,
  branch: CallFlowBranch,
  branchLabel: string | undefined,
) {
  const label = dtmfLabel(opt.dtmf);
  if (opt.action === 'DisconnectCall') {
    b.addEdge(sourceId, b.ensureNode({ id: 'disconnect', kind: 'disconnect', label: 'Disconnect' }), label, branch, branchLabel);
  } else if (opt.action === 'TransferCallToOperator') {
    const targetId = resolveDesignTarget(b, operator ?? undefined) ?? b.ensureNode({ id: 'operator', kind: 'operator', label: 'Operator (not configured)' });
    b.addEdge(sourceId, targetId, label, branch, branchLabel);
  } else if (opt.action === 'TransferCallToTarget') {
    const targetId = resolveDesignTarget(b, opt.target);
    if (targetId) b.addEdge(sourceId, targetId, label, branch, branchLabel);
  }
}

function walkDesignCallFlow(b: GraphBuilder, sourceId: string, cf: AutoAttendantCallFlow | null, operator: AutoAttendantCallableEntity | null, branch: CallFlowBranch, branchLabel?: string) {
  if (!cf) return;
  for (const opt of cf.menu.options) walkDesignMenuOption(b, sourceId, opt, operator, branch, branchLabel);
}

/** The "as-designed" graph, from Design & Build's structured columns. */
export function buildCallFlowGraphFromDesign(input: { autoAttendants: DesignAutoAttendantInput[]; callQueues: DesignCallQueueInput[] }): CallFlowGraph {
  const b = new GraphBuilder();
  for (const aa of input.autoAttendants) b.ensureNode({ id: `aa:${aa.buildId}`, kind: 'auto_attendant', label: aa.name });
  for (const cq of input.callQueues) b.ensureNode({ id: `cq:${cq.buildId}`, kind: 'call_queue', label: cq.name });

  for (const aa of input.autoAttendants) {
    const sourceId = `aa:${aa.buildId}`;
    walkDesignCallFlow(b, sourceId, aa.defaultCallFlow, aa.operator, 'business_hours');
    walkDesignCallFlow(b, sourceId, aa.afterHoursCallFlow, aa.operator, 'after_hours');
    for (const holiday of aa.holidayCallFlows) walkDesignCallFlow(b, sourceId, holiday.callFlow, aa.operator, 'holiday', holiday.name);
  }

  const cqAction = (b: GraphBuilder, sourceId: string, settings: CallQueueActionSettings | null, branch: CallFlowBranch, label: string) => {
    if (!settings?.action) return;
    if (settings.action === 'Queue') return; // stays in queue - nothing to draw
    if ((settings.action === 'Forward' || settings.action === 'SharedVoicemail') && settings.target) {
      // target is a UPN when resolvable, or a raw Entra/Exchange id when it
      // isn't (an M365 group - see build.service.ts's targetOf and the
      // "SharedVoicemail target shows a raw GUID" bug report) - either way,
      // shown as a person/shared-voicemail node rather than guessed further.
      const looksLikeUpn = settings.target.includes('@');
      const targetId = settings.action === 'SharedVoicemail' && !looksLikeUpn
        ? b.ensureNode({ id: `group:${settings.target}`, kind: 'shared_voicemail', label: 'Shared voicemail (group)', sublabel: settings.target })
        : b.ensureNode({ id: `user:${settings.target.toLowerCase()}`, kind: 'person', label: settings.target });
      b.addEdge(sourceId, targetId, label, branch);
    } else if (settings.action === 'SharedVoicemail') {
      b.addEdge(sourceId, b.ensureNode({ id: 'shared_voicemail', kind: 'shared_voicemail', label: 'Shared voicemail' }), label, branch);
    } else if (settings.action === 'Voicemail') {
      b.addEdge(sourceId, b.ensureNode({ id: 'voicemail', kind: 'voicemail', label: 'Voicemail' }), label, branch);
    } else if (settings.action === 'Disconnect' || settings.action === 'DisconnectWithBusy') {
      b.addEdge(sourceId, b.ensureNode({ id: 'disconnect', kind: 'disconnect', label: 'Disconnect' }), label, branch);
    }
  };
  for (const cq of input.callQueues) {
    const sourceId = `cq:${cq.buildId}`;
    cqAction(b, sourceId, cq.overflow, 'overflow', 'Overflow');
    cqAction(b, sourceId, cq.timeout, 'timeout', 'Timeout');
    cqAction(b, sourceId, cq.noAgentAction, 'no_agent', 'No agents');
  }

  return b.build();
}

/* ================================ Discovery =============================== */

export interface LiveAutoAttendantInput {
  /** tenant_objects.display_name (or object_key if unnamed). */
  name: string;
  /** tenant_objects.data - the raw Get-CsAutoAttendant object. */
  data: Record<string, unknown>;
}
export interface LiveCallQueueInput {
  name: string;
  data: Record<string, unknown>;
}
export interface LiveScheduleInput {
  /** tenant_objects.object_key - matches a CallHandlingAssociation's ScheduleId. */
  key: string;
  data: Record<string, unknown>;
}

function resolveLiveTarget(b: GraphBuilder, ref: LiveCallableEntityRef | undefined, liveIdIndex: Map<string, string>): string | undefined {
  if (!ref) return undefined;
  if (ref.kind === 'external' && ref.number) return b.ensureNode({ id: `ext:${ref.number}`, kind: 'external_number', label: ref.number });
  if (ref.kind === 'user' && ref.liveId) return b.ensureNode({ id: `user:${ref.liveId}`, kind: 'person', label: `User (${ref.liveId.slice(0, 8)}…)` });
  if (ref.kind === 'voice_app' && ref.liveId) {
    const nodeId = liveIdIndex.get(ref.liveId.toLowerCase());
    return nodeId ? b.ensureNode({ id: nodeId, kind: nodeId.startsWith('cq:') ? 'call_queue' : 'auto_attendant', label: '(unresolved)' }) : undefined;
  }
  return undefined;
}

function walkLiveMenuOption(b: GraphBuilder, sourceId: string, opt: LiveMenuOption, liveIdIndex: Map<string, string>, branch: CallFlowBranch, branchLabel?: string) {
  const label = dtmfLabel(opt.dtmf);
  if (opt.action === 'DisconnectCall') {
    b.addEdge(sourceId, b.ensureNode({ id: 'disconnect', kind: 'disconnect', label: 'Disconnect' }), label, branch, branchLabel);
    return;
  }
  const targetId = resolveLiveTarget(b, opt.target, liveIdIndex);
  if (targetId) b.addEdge(sourceId, targetId, label, branch, branchLabel);
}

function walkLiveCallFlow(b: GraphBuilder, sourceId: string, cf: LiveCallFlow | undefined, liveIdIndex: Map<string, string>, branch: CallFlowBranch, branchLabel?: string) {
  if (!cf) return;
  for (const opt of cf.menu.options) walkLiveMenuOption(b, sourceId, opt, liveIdIndex, branch, branchLabel);
}

/**
 * The "as-is" graph, straight from Discovery's live tenant_objects snapshot -
 * no Design & Build populate step needed. Mirrors
 * BuildService.populateStructuredFromLive's own CallHandlingAssociations
 * walk (server-side), done here client-side with the same aa-live-parse.ts
 * parsers.
 */
export function buildCallFlowGraphFromLive(input: { autoAttendants: LiveAutoAttendantInput[]; callQueues: LiveCallQueueInput[]; schedules: LiveScheduleInput[] }): CallFlowGraph {
  const b = new GraphBuilder();
  const liveIdIndex = new Map<string, string>(); // live Identity (lowercased) -> graph node id

  for (const aa of input.autoAttendants) {
    const identity = typeof aa.data.Identity === 'string' ? aa.data.Identity : undefined;
    const nodeId = b.ensureNode({ id: `aa:${identity ?? aa.name}`, kind: 'auto_attendant', label: aa.name });
    if (identity) liveIdIndex.set(identity.toLowerCase(), nodeId);
  }
  for (const cq of input.callQueues) {
    const identity = typeof cq.data.Identity === 'string' ? cq.data.Identity : undefined;
    const nodeId = b.ensureNode({ id: `cq:${identity ?? cq.name}`, kind: 'call_queue', label: cq.name });
    if (identity) liveIdIndex.set(identity.toLowerCase(), nodeId);
  }
  const scheduleByKey = new Map(input.schedules.map((s) => [s.key, s.data]));

  for (const aa of input.autoAttendants) {
    const identity = typeof aa.data.Identity === 'string' ? aa.data.Identity : aa.name;
    const sourceId = `aa:${identity}`;
    const defaultCf = parseLiveCallFlow(aa.data.DefaultCallFlow);
    walkLiveCallFlow(b, sourceId, defaultCf, liveIdIndex, 'business_hours');

    const operatorRef = parseLiveCallTarget(aa.data.Operator);
    const callFlowsById = new Map(
      (Array.isArray(aa.data.CallFlows) ? (aa.data.CallFlows as Record<string, unknown>[]) : []).map((cf) => [cf.Id as string, cf]),
    );
    for (const cha of Array.isArray(aa.data.CallHandlingAssociations) ? (aa.data.CallHandlingAssociations as Record<string, unknown>[]) : []) {
      const cfRaw = typeof cha.CallFlowId === 'string' ? callFlowsById.get(cha.CallFlowId) : undefined;
      const parsedCf = cfRaw ? parseLiveCallFlow(cfRaw) : undefined;
      if (!parsedCf) continue;
      const scheduleRaw = typeof cha.ScheduleId === 'string' ? scheduleByKey.get(cha.ScheduleId) : undefined;
      const scheduleName = typeof scheduleRaw?.Name === 'string' ? scheduleRaw.Name : undefined;
      if (cha.Type === 0) walkLiveCallFlow(b, sourceId, parsedCf, liveIdIndex, 'after_hours');
      else if (cha.Type === 1) walkLiveCallFlow(b, sourceId, parsedCf, liveIdIndex, 'holiday', scheduleName ?? (typeof cfRaw?.Name === 'string' ? cfRaw.Name : undefined));
    }
    if (operatorRef) {
      const targetId = resolveLiveTarget(b, operatorRef, liveIdIndex);
      if (targetId) b.addEdge(sourceId, targetId, 'Operator', 'operator');
    }
  }

  const numOr = (v: unknown): number | undefined => (typeof v === 'number' ? v : undefined);
  const CQ_ACTION_LABEL: Record<CallFlowBranch, string> = { overflow: 'Overflow', timeout: 'Timeout', no_agent: 'No agents' } as Record<CallFlowBranch, string>;
  for (const cq of input.callQueues) {
    const identity = typeof cq.data.Identity === 'string' ? cq.data.Identity : cq.name;
    const sourceId = `cq:${identity}`;
    for (const [actionKey, targetKey, branch] of [
      ['OverflowAction', 'OverflowActionTarget', 'overflow'],
      ['TimeoutAction', 'TimeoutActionTarget', 'timeout'],
      ['NoAgentAction', 'NoAgentActionTarget', 'no_agent'],
    ] as const) {
      const action = numOr(cq.data[actionKey]);
      if (action == null) continue;
      const targetObj = cq.data[targetKey] as { Id?: string; Type?: string } | undefined;
      if (!targetObj?.Id) continue;
      const nodeId =
        targetObj.Type === 'MailBox'
          ? b.ensureNode({ id: `group:${targetObj.Id}`, kind: 'shared_voicemail', label: 'Shared voicemail (group)', sublabel: targetObj.Id })
          : b.ensureNode({ id: `user:${targetObj.Id}`, kind: 'person', label: `User (${targetObj.Id.slice(0, 8)}…)` });
      b.addEdge(sourceId, nodeId, CQ_ACTION_LABEL[branch], branch);
    }
  }

  return b.build();
}
