/**
 * Pure call-flow graph builder (Workstream 6 of the "reverse-engineer
 * OVP012" plan) - turns either data source into the same generic node/edge
 * shape, so one renderer (apps/web/src/components/CallFlowDiagram.tsx)
 * serves both:
 *
 * - buildAutoAttendantFlowGraphFromDesign / buildCallQueueFlowGraphFromDesign:
 *   Design & Build's structured build_auto_attendants/build_call_queues
 *   columns (the "as-designed" view).
 * - buildAutoAttendantFlowGraphFromLive / buildCallQueueFlowGraphFromLive:
 *   Discovery's raw tenant_objects shape (the "as-is" view), via
 *   aa-live-parse.ts's pure parsers plus the same CallHandlingAssociations
 *   walk BuildService.populateStructuredFromLive already does server-side,
 *   done here client-side with no DB.
 *
 * Each of the four functions builds a graph scoped to ONE Auto Attendant or
 * Call Queue, not the whole site/tenant - a real org's AA/CQ web is too
 * dense to read in one diagram. A menu option that transfers to another Auto
 * Attendant is shown as a single leaf box (open THAT AA's own call flow to
 * see its routing); a menu option or Overflow/Timeout/No-agent action that
 * transfers to a Call Queue is expanded one hop further, so "what happens
 * after it hits a call queue" is visible without leaving the AA's diagram.
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
  AutoAttendantMenuOption,
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
  /** "Press 1"/"No input" or the branch's own short label (Business hours/Overflow/Timeout/No agents/Operator). */
  label: string;
  branch: CallFlowBranch;
  /** e.g. a holiday's own name, when branch is 'holiday'. */
  branchLabel?: string;
}

export interface CallFlowGraph {
  nodes: CallFlowNode[];
  edges: CallFlowEdge[];
}

/** Accumulates nodes (deduped by id) and edges while a graph is built - shared by every builder below. */
class GraphBuilder {
  private nodes = new Map<string, CallFlowNode>();
  private edges: CallFlowEdge[] = [];

  ensureNode(node: CallFlowNode): string {
    if (!this.nodes.has(node.id)) this.nodes.set(node.id, node);
    return node.id;
  }

  addEdge(source: string, target: string, label: string, branch: CallFlowBranch, branchLabel?: string): void {
    this.edges.push({ id: `e${this.edges.length}:${source}->${target}`, source, target, label, branch, branchLabel });
  }

  build(): CallFlowGraph {
    return { nodes: [...this.nodes.values()], edges: this.edges };
  }
}

function dtmfLabel(dtmf: string): string {
  return dtmf === 'Automatic' ? 'No input' : `Press ${dtmf.replace(/^Tone/, '')}`;
}

const GREETING_SNIPPET_MAX = 160;
function snippet(texts: string[], hasAudio: boolean): string | undefined {
  if (texts.length === 0) return hasAudio ? '🔊 Audio greeting' : undefined;
  const joined = texts.join(' ');
  return joined.length > GREETING_SNIPPET_MAX ? `${joined.slice(0, GREETING_SNIPPET_MAX)}…` : joined;
}

/* ============================ Design & Build ============================ */

export interface DesignAutoAttendantInput {
  buildId: string;
  name: string;
  operator: AutoAttendantCallableEntity | null;
  defaultCallFlow: AutoAttendantCallFlow | null;
  afterHoursCallFlow: AutoAttendantCallFlow | null;
  holidayCallFlows: { name: string; callFlow: AutoAttendantCallFlow }[];
}

export interface DesignCallQueueInput {
  buildId: string;
  name: string;
  overflow: CallQueueActionSettings | null;
  timeout: CallQueueActionSettings | null;
  noAgentAction: CallQueueActionSettings | null;
  routingMethod?: string | null;
  agentAlertTime?: number;
  agentCount?: number;
}

function designGreeting(cf: AutoAttendantCallFlow | null): string | undefined {
  if (!cf) return undefined;
  const texts = cf.greetings.filter((g) => g.type === 'Text' && g.text).map((g) => g.text as string);
  return snippet(texts, cf.greetings.some((g) => g.type === 'AudioFile'));
}

function designCqSublabel(cq: DesignCallQueueInput): string | undefined {
  const parts: string[] = [];
  if (cq.routingMethod) parts.push(cq.routingMethod);
  if (cq.agentCount != null) parts.push(`${cq.agentCount} agent${cq.agentCount === 1 ? '' : 's'}`);
  if (cq.agentAlertTime != null) parts.push(`${cq.agentAlertTime}s alert`);
  return parts.length ? parts.join(' · ') : undefined;
}

function designCqActionEdges(b: GraphBuilder, cq: DesignCallQueueInput): void {
  const sourceId = `cq:${cq.buildId}`;
  const action = (settings: CallQueueActionSettings | null, branch: CallFlowBranch, label: string) => {
    if (!settings?.action || settings.action === 'Queue') return;
    if ((settings.action === 'Forward' || settings.action === 'SharedVoicemail') && settings.target) {
      // target is a UPN when resolvable, or a raw Entra/Exchange id when it
      // isn't (an M365 group - see build.service.ts's targetOf and the
      // "SharedVoicemail target shows a raw GUID" bug report) - either way,
      // shown as a person/shared-voicemail node rather than guessed further.
      const looksLikeUpn = settings.target.includes('@');
      const targetId =
        settings.action === 'SharedVoicemail' && !looksLikeUpn
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
  action(cq.overflow, 'overflow', 'Overflow');
  action(cq.timeout, 'timeout', 'Timeout');
  action(cq.noAgentAction, 'no_agent', 'No agents');
}

/** The "as-designed" graph for one Call Queue, from Design & Build's structured columns. */
export function buildCallQueueFlowGraphFromDesign(cq: DesignCallQueueInput): CallFlowGraph {
  const b = new GraphBuilder();
  b.ensureNode({ id: `cq:${cq.buildId}`, kind: 'call_queue', label: cq.name, sublabel: designCqSublabel(cq) });
  designCqActionEdges(b, cq);
  return b.build();
}

/**
 * The "as-designed" graph for one Auto Attendant, from Design & Build's
 * structured columns. `allAutoAttendants`/`allCallQueues` are this site's
 * full lists (not walked themselves) - used only to label a menu-option
 * target with its real name, and to expand one hop into a target Call
 * Queue's own Overflow/Timeout/No-agent routing.
 */
export function buildAutoAttendantFlowGraphFromDesign(
  aa: DesignAutoAttendantInput,
  allAutoAttendants: DesignAutoAttendantInput[],
  allCallQueues: DesignCallQueueInput[],
): CallFlowGraph {
  const b = new GraphBuilder();
  const nameOfAa = new Map(allAutoAttendants.map((a) => [a.buildId, a.name]));
  const cqById = new Map(allCallQueues.map((cq) => [cq.buildId, cq]));
  const expandedCq = new Set<string>();

  const resolveTarget = (entity: AutoAttendantCallableEntity | undefined): string | undefined => {
    if (!entity) return undefined;
    switch (entity.kind) {
      case 'auto_attendant':
        return entity.buildId ? b.ensureNode({ id: `aa:${entity.buildId}`, kind: 'auto_attendant', label: nameOfAa.get(entity.buildId) ?? '(unresolved)' }) : undefined;
      case 'call_queue':
        return entity.buildId ? b.ensureNode({ id: `cq:${entity.buildId}`, kind: 'call_queue', label: cqById.get(entity.buildId)?.name ?? '(unresolved)' }) : undefined;
      case 'user':
        return entity.upn ? b.ensureNode({ id: `user:${entity.upn.toLowerCase()}`, kind: 'person', label: entity.upn }) : undefined;
      case 'external':
        return entity.number ? b.ensureNode({ id: `ext:${entity.number}`, kind: 'external_number', label: entity.number }) : undefined;
      case 'voicemail':
        return b.ensureNode({ id: 'voicemail', kind: 'voicemail', label: 'Voicemail' });
      case 'shared_voicemail':
        return b.ensureNode({ id: 'shared_voicemail', kind: 'shared_voicemail', label: 'Shared voicemail' });
    }
  };

  const walkMenuOption = (sourceId: string, opt: AutoAttendantMenuOption, branch: CallFlowBranch) => {
    const label = dtmfLabel(opt.dtmf);
    if (opt.action === 'DisconnectCall') {
      b.addEdge(sourceId, b.ensureNode({ id: 'disconnect', kind: 'disconnect', label: 'Disconnect' }), label, branch);
      return;
    }
    if (opt.action === 'TransferCallToOperator') {
      const targetId = resolveTarget(aa.operator ?? undefined) ?? b.ensureNode({ id: 'operator', kind: 'operator', label: 'Operator (not configured)' });
      b.addEdge(sourceId, targetId, label, branch);
      return;
    }
    if (opt.action === 'TransferCallToTarget') {
      const targetId = resolveTarget(opt.target);
      if (!targetId) return;
      b.addEdge(sourceId, targetId, label, branch);
      if (opt.target?.kind === 'call_queue' && opt.target.buildId && !expandedCq.has(opt.target.buildId)) {
        expandedCq.add(opt.target.buildId);
        const cq = cqById.get(opt.target.buildId);
        if (cq) designCqActionEdges(b, cq);
      }
    }
  };

  const rootId = b.ensureNode({ id: `aa:${aa.buildId}`, kind: 'auto_attendant', label: aa.name });
  const addBranch = (cf: AutoAttendantCallFlow | null, key: string, branchLabel: string, branch: CallFlowBranch) => {
    if (!cf) return;
    const branchId = b.ensureNode({ id: `${rootId}:${key}`, kind: 'auto_attendant', label: branchLabel, sublabel: designGreeting(cf) });
    b.addEdge(rootId, branchId, branchLabel, branch);
    for (const opt of cf.menu.options) walkMenuOption(branchId, opt, branch);
  };
  addBranch(aa.defaultCallFlow, 'business_hours', 'Business hours', 'business_hours');
  addBranch(aa.afterHoursCallFlow, 'after_hours', 'After hours', 'after_hours');
  aa.holidayCallFlows.forEach((h, i) => addBranch(h.callFlow, `holiday${i}`, `Holiday: ${h.name}`, 'holiday'));

  if (aa.operator) {
    const targetId = resolveTarget(aa.operator);
    if (targetId) b.addEdge(rootId, targetId, 'Operator', 'operator');
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

function liveGreeting(cf: LiveCallFlow | undefined): string | undefined {
  if (!cf) return undefined;
  const texts = cf.greetings.filter((g) => g.type === 'Text' && g.text).map((g) => g.text as string);
  return snippet(texts, cf.greetings.some((g) => g.type === 'AudioFile'));
}

function liveCqSublabel(data: Record<string, unknown>): string | undefined {
  const parts: string[] = [];
  if (typeof data.RoutingMethod === 'string') parts.push(data.RoutingMethod);
  if (Array.isArray(data.Agents)) parts.push(`${data.Agents.length} agent${data.Agents.length === 1 ? '' : 's'}`);
  if (typeof data.AgentAlertTime === 'number') parts.push(`${data.AgentAlertTime}s alert`);
  return parts.length ? parts.join(' · ') : undefined;
}

const CQ_ACTION_LABEL: Record<'overflow' | 'timeout' | 'no_agent', string> = { overflow: 'Overflow', timeout: 'Timeout', no_agent: 'No agents' };

function liveCqActionEdges(b: GraphBuilder, cq: LiveCallQueueInput): void {
  const identity = typeof cq.data.Identity === 'string' ? cq.data.Identity : cq.name;
  const sourceId = `cq:${identity}`;
  for (const [actionKey, targetKey, branch] of [
    ['OverflowAction', 'OverflowActionTarget', 'overflow'],
    ['TimeoutAction', 'TimeoutActionTarget', 'timeout'],
    ['NoAgentAction', 'NoAgentActionTarget', 'no_agent'],
  ] as const) {
    const action = cq.data[actionKey];
    if (typeof action !== 'number') continue;
    const targetObj = cq.data[targetKey] as { Id?: string; Type?: string } | undefined;
    if (!targetObj?.Id) continue;
    const nodeId =
      targetObj.Type === 'MailBox'
        ? b.ensureNode({ id: `group:${targetObj.Id}`, kind: 'shared_voicemail', label: 'Shared voicemail (group)', sublabel: targetObj.Id })
        : b.ensureNode({ id: `user:${targetObj.Id}`, kind: 'person', label: `User (${targetObj.Id.slice(0, 8)}…)` });
    b.addEdge(sourceId, nodeId, CQ_ACTION_LABEL[branch], branch);
  }
}

/** The "as-is" graph for one Call Queue, straight from Discovery's live tenant_objects snapshot. */
export function buildCallQueueFlowGraphFromLive(cq: LiveCallQueueInput): CallFlowGraph {
  const b = new GraphBuilder();
  const identity = typeof cq.data.Identity === 'string' ? cq.data.Identity : cq.name;
  b.ensureNode({ id: `cq:${identity}`, kind: 'call_queue', label: cq.name, sublabel: liveCqSublabel(cq.data) });
  liveCqActionEdges(b, cq);
  return b.build();
}

/**
 * The "as-is" graph for one Auto Attendant, straight from Discovery's live
 * tenant_objects snapshot - no Design & Build populate step needed. Mirrors
 * BuildService.populateStructuredFromLive's own CallHandlingAssociations
 * walk (server-side), done here client-side with the same aa-live-parse.ts
 * parsers. `allAutoAttendants`/`allCallQueues`/`schedules` are the tenant's
 * full live snapshot (not walked themselves) - used only to label a
 * menu-option target with its real name, resolve a holiday's schedule name,
 * and expand one hop into a target Call Queue's own routing.
 */
export function buildAutoAttendantFlowGraphFromLive(
  aa: LiveAutoAttendantInput,
  allAutoAttendants: LiveAutoAttendantInput[],
  allCallQueues: LiveCallQueueInput[],
  schedules: LiveScheduleInput[],
): CallFlowGraph {
  const b = new GraphBuilder();
  const nameByIdentity = new Map<string, { name: string; kind: 'auto_attendant' | 'call_queue' }>();
  for (const a of allAutoAttendants) {
    const identity = typeof a.data.Identity === 'string' ? a.data.Identity : undefined;
    if (identity) nameByIdentity.set(identity.toLowerCase(), { name: a.name, kind: 'auto_attendant' });
  }
  const cqByIdentity = new Map<string, LiveCallQueueInput>();
  for (const cq of allCallQueues) {
    const identity = typeof cq.data.Identity === 'string' ? cq.data.Identity : undefined;
    if (identity) {
      nameByIdentity.set(identity.toLowerCase(), { name: cq.name, kind: 'call_queue' });
      cqByIdentity.set(identity.toLowerCase(), cq);
    }
  }
  const scheduleByKey = new Map(schedules.map((s) => [s.key, s.data]));
  const expandedCq = new Set<string>();

  const resolveTarget = (ref: LiveCallableEntityRef | undefined): string | undefined => {
    if (!ref) return undefined;
    if (ref.kind === 'external' && ref.number) return b.ensureNode({ id: `ext:${ref.number}`, kind: 'external_number', label: ref.number });
    if (ref.kind === 'user' && ref.liveId) return b.ensureNode({ id: `user:${ref.liveId}`, kind: 'person', label: `User (${ref.liveId.slice(0, 8)}…)` });
    if (ref.kind === 'voice_app' && ref.liveId) {
      const known = nameByIdentity.get(ref.liveId.toLowerCase());
      if (!known) return undefined;
      return b.ensureNode({ id: `${known.kind === 'call_queue' ? 'cq' : 'aa'}:${ref.liveId}`, kind: known.kind, label: known.name });
    }
    return undefined;
  };

  const walkMenuOption = (sourceId: string, opt: LiveMenuOption, branch: CallFlowBranch) => {
    const label = dtmfLabel(opt.dtmf);
    if (opt.action === 'DisconnectCall') {
      b.addEdge(sourceId, b.ensureNode({ id: 'disconnect', kind: 'disconnect', label: 'Disconnect' }), label, branch);
      return;
    }
    const targetId = resolveTarget(opt.target);
    if (!targetId) return;
    b.addEdge(sourceId, targetId, label, branch);
    if (opt.target?.kind === 'voice_app' && opt.target.liveId) {
      const key = opt.target.liveId.toLowerCase();
      const cq = cqByIdentity.get(key);
      if (cq && !expandedCq.has(key)) {
        expandedCq.add(key);
        liveCqActionEdges(b, cq);
      }
    }
  };

  const identity = typeof aa.data.Identity === 'string' ? aa.data.Identity : aa.name;
  const rootId = b.ensureNode({ id: `aa:${identity}`, kind: 'auto_attendant', label: aa.name });
  const addBranch = (cf: LiveCallFlow | undefined, key: string, branchLabel: string, branch: CallFlowBranch) => {
    if (!cf) return;
    const branchId = b.ensureNode({ id: `${rootId}:${key}`, kind: 'auto_attendant', label: branchLabel, sublabel: liveGreeting(cf) });
    b.addEdge(rootId, branchId, branchLabel, branch);
    for (const opt of cf.menu.options) walkMenuOption(branchId, opt, branch);
  };

  addBranch(parseLiveCallFlow(aa.data.DefaultCallFlow), 'business_hours', 'Business hours', 'business_hours');

  const callFlowsById = new Map((Array.isArray(aa.data.CallFlows) ? (aa.data.CallFlows as Record<string, unknown>[]) : []).map((cf) => [cf.Id as string, cf]));
  let holidayIdx = 0;
  for (const cha of Array.isArray(aa.data.CallHandlingAssociations) ? (aa.data.CallHandlingAssociations as Record<string, unknown>[]) : []) {
    const cfRaw = typeof cha.CallFlowId === 'string' ? callFlowsById.get(cha.CallFlowId) : undefined;
    const parsedCf = cfRaw ? parseLiveCallFlow(cfRaw) : undefined;
    if (!parsedCf) continue;
    if (cha.Type === 0) {
      addBranch(parsedCf, 'after_hours', 'After hours', 'after_hours');
    } else if (cha.Type === 1) {
      const scheduleRaw = typeof cha.ScheduleId === 'string' ? scheduleByKey.get(cha.ScheduleId) : undefined;
      const scheduleName = typeof scheduleRaw?.Name === 'string' ? scheduleRaw.Name : typeof cfRaw?.Name === 'string' ? (cfRaw.Name as string) : 'Holiday';
      addBranch(parsedCf, `holiday${holidayIdx}`, `Holiday: ${scheduleName}`, 'holiday');
      holidayIdx++;
    }
  }

  const operatorRef = parseLiveCallTarget(aa.data.Operator);
  if (operatorRef) {
    const targetId = resolveTarget(operatorRef);
    if (targetId) b.addEdge(rootId, targetId, 'Operator', 'operator');
  }

  return b.build();
}
