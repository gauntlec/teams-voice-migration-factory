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
 * A Call Queue is always a leaf (Teams has no "transfer from a queue to
 * another Auto Attendant/Call Queue" - only Overflow/Timeout/No-agent to a
 * person/voicemail/disconnect). An Auto Attendant menu option that transfers
 * to ANOTHER Auto Attendant is followed and fully expanded too - "show
 * everywhere the call could go" - guarded by a visited-set so a real cycle
 * (e.g. a Directory AA's DTMF0 pointing back to the Main Number AA it came
 * from) terminates instead of recursing forever; an AA already drawn is
 * just wired to with an edge, not redrawn.
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
  /** Short chip text, e.g. "Front door" for an Auto Attendant a resource account's phone number rings into directly. */
  badge?: string;
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

/**
 * Accumulates nodes (deduped by id) and edges while a graph is built -
 * shared by every builder below.
 *
 * ensureNode merges into an already-registered node rather than only
 * no-op'ing: a node is often first touched as a bare edge target (e.g. a
 * menu option resolves its own AA/CQ target to get an id for the edge)
 * before the AA itself is expanded and re-registers the same id with its
 * real badge/sublabel - the second call must be allowed to fill in what the
 * first one didn't know yet, and a still-unresolved placeholder label must
 * give way to a real one once one is available.
 *
 * Two edges between the same pair of nodes (e.g. a Call Queue's Overflow
 * and No-agent both routing to the same shared voicemail) render as one
 * bezier curve exactly on top of the other in xyflow, hiding all but the
 * last label - merged into a single "Overflow + No agents"-style edge
 * instead of a duplicate addEdge call.
 */
class GraphBuilder {
  private nodes = new Map<string, CallFlowNode>();
  private edges: CallFlowEdge[] = [];
  private edgeIndexByPair = new Map<string, number>();

  ensureNode(node: CallFlowNode): string {
    const existing = this.nodes.get(node.id);
    if (!existing) {
      this.nodes.set(node.id, node);
      return node.id;
    }
    if (existing.label === '(unresolved)' && node.label !== '(unresolved)') existing.label = node.label;
    if (node.badge && !existing.badge) existing.badge = node.badge;
    if (node.sublabel && !existing.sublabel) existing.sublabel = node.sublabel;
    return node.id;
  }

  addEdge(source: string, target: string, label: string, branch: CallFlowBranch, branchLabel?: string): void {
    const key = `${source}->${target}`;
    const existingIdx = this.edgeIndexByPair.get(key);
    const existing = existingIdx != null ? this.edges[existingIdx] : undefined;
    if (existing) {
      if (!existing.label.split(' + ').includes(label)) existing.label = `${existing.label} + ${label}`;
      return;
    }
    this.edgeIndexByPair.set(key, this.edges.length);
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

const FRONT_DOOR_BADGE = 'Front door';

/* ============================ Design & Build ============================ */

export interface DesignAutoAttendantInput {
  buildId: string;
  name: string;
  operator: AutoAttendantCallableEntity | null;
  defaultCallFlow: AutoAttendantCallFlow | null;
  afterHoursCallFlow: AutoAttendantCallFlow | null;
  holidayCallFlows: { name: string; callFlow: AutoAttendantCallFlow }[];
  /** Set when this AA's resource account has a phone number attached - the real front door a caller dials, vs. an AA only reachable via another AA's menu. */
  hasPhoneNumber?: boolean;
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
 * structured columns - starting from `aa` (typically the front-door AA a
 * phone number rings into), following every menu option that transfers to
 * another Auto Attendant and expanding it fully in turn (a real chain: a
 * Language AA hands off to a Main Number AA, which hands off to further
 * AAs), and expanding one hop into any target Call Queue's own
 * Overflow/Timeout/No-agent routing. `allAutoAttendants`/`allCallQueues`
 * are this site's full lists (not all of them necessarily drawn) - needed
 * to look up a transfer target's own configuration and real name.
 */
export function buildAutoAttendantFlowGraphFromDesign(
  aa: DesignAutoAttendantInput,
  allAutoAttendants: DesignAutoAttendantInput[],
  allCallQueues: DesignCallQueueInput[],
): CallFlowGraph {
  const b = new GraphBuilder();
  const aaById = new Map(allAutoAttendants.map((a) => [a.buildId, a]));
  const cqById = new Map(allCallQueues.map((cq) => [cq.buildId, cq]));
  const visitedAa = new Set<string>();
  const visitedCq = new Set<string>();

  const resolveTarget = (entity: AutoAttendantCallableEntity | undefined): string | undefined => {
    if (!entity) return undefined;
    switch (entity.kind) {
      case 'auto_attendant': {
        if (!entity.buildId) return undefined;
        const target = aaById.get(entity.buildId);
        return b.ensureNode({
          id: `aa:${entity.buildId}`,
          kind: 'auto_attendant',
          label: target?.name ?? '(unresolved)',
          badge: target?.hasPhoneNumber ? FRONT_DOOR_BADGE : undefined,
        });
      }
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

  const walkMenuOption = (sourceId: string, opt: AutoAttendantMenuOption, owner: DesignAutoAttendantInput, branch: CallFlowBranch) => {
    const label = dtmfLabel(opt.dtmf);
    if (opt.action === 'DisconnectCall') {
      b.addEdge(sourceId, b.ensureNode({ id: 'disconnect', kind: 'disconnect', label: 'Disconnect' }), label, branch);
      return;
    }
    if (opt.action === 'TransferCallToOperator') {
      const targetId = resolveTarget(owner.operator ?? undefined) ?? b.ensureNode({ id: 'operator', kind: 'operator', label: 'Operator (not configured)' });
      b.addEdge(sourceId, targetId, label, branch);
      return;
    }
    if (opt.action === 'TransferCallToTarget') {
      const targetId = resolveTarget(opt.target);
      if (!targetId) return;
      b.addEdge(sourceId, targetId, label, branch);
      if (opt.target?.kind === 'call_queue' && opt.target.buildId && !visitedCq.has(opt.target.buildId)) {
        visitedCq.add(opt.target.buildId);
        const cq = cqById.get(opt.target.buildId);
        if (cq) designCqActionEdges(b, cq);
      } else if (opt.target?.kind === 'auto_attendant' && opt.target.buildId) {
        const target = aaById.get(opt.target.buildId);
        if (target) expandAa(target);
      }
    }
  };

  function expandAa(a: DesignAutoAttendantInput): void {
    if (visitedAa.has(a.buildId)) return;
    visitedAa.add(a.buildId);
    const rootId = b.ensureNode({ id: `aa:${a.buildId}`, kind: 'auto_attendant', label: a.name, badge: a.hasPhoneNumber ? FRONT_DOOR_BADGE : undefined });
    const addBranch = (cf: AutoAttendantCallFlow | null, key: string, branchLabel: string, branch: CallFlowBranch) => {
      if (!cf) return;
      const branchId = b.ensureNode({ id: `${rootId}:${key}`, kind: 'auto_attendant', label: branchLabel, sublabel: designGreeting(cf) });
      b.addEdge(rootId, branchId, branchLabel, branch);
      for (const opt of cf.menu.options) walkMenuOption(branchId, opt, a, branch);
    };
    addBranch(a.defaultCallFlow, 'business_hours', 'Business hours', 'business_hours');
    addBranch(a.afterHoursCallFlow, 'after_hours', 'After hours', 'after_hours');
    a.holidayCallFlows.forEach((h, i) => addBranch(h.callFlow, `holiday${i}`, `Holiday: ${h.name}`, 'holiday'));
    if (a.operator) {
      const targetId = resolveTarget(a.operator);
      if (targetId) b.addEdge(rootId, targetId, 'Operator', 'operator');
    }
  }

  expandAa(aa);
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

/** Get-CsAutoAttendant has real ApplicationInstances (a resource account's phone number) only on the AA a caller actually dials - the front door, vs. one only reachable via another AA's menu. */
function liveHasPhoneNumber(data: Record<string, unknown>): boolean {
  return Array.isArray(data.ApplicationInstances) && data.ApplicationInstances.length > 0;
}

const CQ_ACTION_LABEL: Record<'overflow' | 'timeout' | 'no_agent', string> = { overflow: 'Overflow', timeout: 'Timeout', no_agent: 'No agents' };

/** `usersByObjectId` (Entra object id, lowercased -> UPN) resolves a person target to a real UPN when the caller has that user loaded - otherwise falls back to a truncated id, same as an unresolved M365 group. */
function liveCqActionEdges(b: GraphBuilder, cq: LiveCallQueueInput, usersByObjectId?: Map<string, string>): void {
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
        : b.ensureNode({
            id: `user:${targetObj.Id}`,
            kind: 'person',
            label: usersByObjectId?.get(targetObj.Id.toLowerCase()) ?? `User (${targetObj.Id.slice(0, 8)}…)`,
          });
    b.addEdge(sourceId, nodeId, CQ_ACTION_LABEL[branch], branch);
  }
}

/** The "as-is" graph for one Call Queue, straight from Discovery's live tenant_objects snapshot. */
export function buildCallQueueFlowGraphFromLive(cq: LiveCallQueueInput, usersByObjectId?: Map<string, string>): CallFlowGraph {
  const b = new GraphBuilder();
  const identity = typeof cq.data.Identity === 'string' ? cq.data.Identity : cq.name;
  b.ensureNode({ id: `cq:${identity}`, kind: 'call_queue', label: cq.name, sublabel: liveCqSublabel(cq.data) });
  liveCqActionEdges(b, cq, usersByObjectId);
  return b.build();
}

/**
 * The "as-is" graph for one Auto Attendant, straight from Discovery's live
 * tenant_objects snapshot - no Design & Build populate step needed. Mirrors
 * BuildService.populateStructuredFromLive's own CallHandlingAssociations
 * walk (server-side), done here client-side with the same aa-live-parse.ts
 * parsers. Starting from `aa` (typically the front-door AA a phone number
 * rings into), every menu option that transfers to another Auto Attendant
 * is followed and expanded fully in turn (guarded against a real cycle by a
 * visited-set), and a target Call Queue is expanded one hop into its own
 * routing. `allAutoAttendants`/`allCallQueues`/`schedules` are the tenant's
 * full live snapshot (not all of them necessarily drawn) - needed to look
 * up a transfer target's own configuration, real name, and a holiday's
 * schedule name. `usersByObjectId` (Entra object id, lowercased -> UPN)
 * resolves a person target to a real UPN when loaded, else falls back to a
 * truncated id.
 */
export function buildAutoAttendantFlowGraphFromLive(
  aa: LiveAutoAttendantInput,
  allAutoAttendants: LiveAutoAttendantInput[],
  allCallQueues: LiveCallQueueInput[],
  schedules: LiveScheduleInput[],
  usersByObjectId?: Map<string, string>,
): CallFlowGraph {
  const b = new GraphBuilder();
  const aaByIdentity = new Map<string, LiveAutoAttendantInput>();
  const nameByIdentity = new Map<string, { name: string; kind: 'auto_attendant' | 'call_queue' }>();
  for (const a of allAutoAttendants) {
    const identity = typeof a.data.Identity === 'string' ? a.data.Identity : undefined;
    if (identity) {
      nameByIdentity.set(identity.toLowerCase(), { name: a.name, kind: 'auto_attendant' });
      aaByIdentity.set(identity.toLowerCase(), a);
    }
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
  const visitedAa = new Set<string>();
  const visitedCq = new Set<string>();

  const resolveTarget = (ref: LiveCallableEntityRef | undefined): string | undefined => {
    if (!ref) return undefined;
    if (ref.kind === 'external' && ref.number) return b.ensureNode({ id: `ext:${ref.number}`, kind: 'external_number', label: ref.number });
    if (ref.kind === 'user' && ref.liveId) {
      const upn = usersByObjectId?.get(ref.liveId.toLowerCase());
      return b.ensureNode({ id: `user:${ref.liveId}`, kind: 'person', label: upn ?? `User (${ref.liveId.slice(0, 8)}…)` });
    }
    if (ref.kind === 'voice_app' && ref.liveId) {
      const key = ref.liveId.toLowerCase();
      const known = nameByIdentity.get(key);
      if (!known) return undefined;
      const aData = known.kind === 'auto_attendant' ? aaByIdentity.get(key)?.data : undefined;
      return b.ensureNode({
        id: `${known.kind === 'call_queue' ? 'cq' : 'aa'}:${ref.liveId}`,
        kind: known.kind,
        label: known.name,
        badge: aData && liveHasPhoneNumber(aData) ? FRONT_DOOR_BADGE : undefined,
      });
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
    if (opt.target?.kind !== 'voice_app' || !opt.target.liveId) return;
    const key = opt.target.liveId.toLowerCase();
    const cq = cqByIdentity.get(key);
    if (cq && !visitedCq.has(key)) {
      visitedCq.add(key);
      liveCqActionEdges(b, cq, usersByObjectId);
      return;
    }
    const nextAa = aaByIdentity.get(key);
    if (nextAa) expandAa(nextAa);
  };

  function expandAa(a: LiveAutoAttendantInput): void {
    const identity = typeof a.data.Identity === 'string' ? a.data.Identity : a.name;
    const key = identity.toLowerCase();
    if (visitedAa.has(key)) return;
    visitedAa.add(key);
    const rootId = b.ensureNode({ id: `aa:${identity}`, kind: 'auto_attendant', label: a.name, badge: liveHasPhoneNumber(a.data) ? FRONT_DOOR_BADGE : undefined });
    const addBranch = (cf: LiveCallFlow | undefined, branchKey: string, branchLabel: string, branch: CallFlowBranch) => {
      if (!cf) return;
      const branchId = b.ensureNode({ id: `${rootId}:${branchKey}`, kind: 'auto_attendant', label: branchLabel, sublabel: liveGreeting(cf) });
      b.addEdge(rootId, branchId, branchLabel, branch);
      for (const opt of cf.menu.options) walkMenuOption(branchId, opt, branch);
    };

    addBranch(parseLiveCallFlow(a.data.DefaultCallFlow), 'business_hours', 'Business hours', 'business_hours');

    const callFlowsById = new Map((Array.isArray(a.data.CallFlows) ? (a.data.CallFlows as Record<string, unknown>[]) : []).map((cf) => [cf.Id as string, cf]));
    let holidayIdx = 0;
    for (const cha of Array.isArray(a.data.CallHandlingAssociations) ? (a.data.CallHandlingAssociations as Record<string, unknown>[]) : []) {
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

    const operatorRef = parseLiveCallTarget(a.data.Operator);
    if (operatorRef) {
      const targetId = resolveTarget(operatorRef);
      if (targetId) b.addEdge(rootId, targetId, 'Operator', 'operator');
    }
  }

  expandAa(aa);
  return b.build();
}
