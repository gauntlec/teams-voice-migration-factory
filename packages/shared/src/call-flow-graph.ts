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
  parseLiveSchedule,
  type LiveCallableEntityRef,
  type LiveCallFlow,
  type LiveMenuOption,
} from './aa-live-parse';
import {
  decodeCallQueueEnum,
  type AutoAttendantCallableEntity,
  type AutoAttendantCallFlow,
  type AutoAttendantMenuOption,
  type AutoAttendantSchedule,
  liveCallQueueActionExtras,
  type CallQueueActionSettings,
} from './deployment';
import { CALL_QUEUE_NO_AGENT_ACTIONS, CALL_QUEUE_OVERFLOW_ACTIONS, CALL_QUEUE_TIMEOUT_ACTIONS } from './domain';
import { decodeUserNameExtension } from './voice-app-access';

export type CallFlowNodeKind =
  | 'auto_attendant'
  | 'call_queue'
  | 'person'
  | 'external_number'
  | 'voicemail'
  | 'shared_voicemail'
  | 'operator'
  | 'announcement'
  | 'disconnect';

export interface CallFlowNode {
  id: string;
  kind: CallFlowNodeKind;
  label: string;
  sublabel?: string;
  /** Short chip text, e.g. "Front door" for an Auto Attendant a resource account's phone number rings into directly. */
  badge?: string;
  /** Extra lines under the label: a front door's resource account and number, a business-hours box's opening times. */
  details?: string[];
  /** A call queue's agents (name or sign-in address), listed in one box drawn directly under the queue. */
  agents?: string[];
  /** Things the design should look at again (a long menu, a loop, a queue with its own number): drawn in the box, and listed on the PDF's cover. */
  warnings?: string[];
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
    if (node.details?.length && !existing.details?.length) existing.details = node.details;
    if (node.agents?.length && !existing.agents?.length) existing.agents = node.agents;
    for (const w of node.warnings ?? []) if (!existing.warnings?.includes(w)) existing.warnings = [...(existing.warnings ?? []), w];
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

  /** Adds a whole graph built elsewhere (nodes deduped by id, edges merged like any other). */
  merge(g: CallFlowGraph): void {
    for (const n of g.nodes) this.ensureNode(n);
    for (const e of g.edges) this.addEdge(e.source, e.target, e.label, e.branch, e.branchLabel);
  }

  build(): CallFlowGraph {
    const graph = { nodes: [...this.nodes.values()], edges: this.edges };
    addRouteWarnings(graph);
    return graph;
  }
}

/** Teams disconnects a call after this many moves between auto attendants and call queues (Microsoft Learn, "Design call flows"). */
export const MAX_VOICE_APP_TRANSITIONS = 25;
/** A route this many moves deep is flagged: well before the limit, but deep enough that a loop or a mistake there is easy to miss. */
const DEEP_ROUTE_WARN = 10;
/** Microsoft recommends five menu options or fewer: callers struggle to remember more (use a nested auto attendant instead). */
export const MAX_RECOMMENDED_MENU_OPTIONS = 5;

/** An auto attendant or call queue itself (not one of an auto attendant's Business hours / After hours / Holiday boxes). */
const isVoiceApp = (n: CallFlowNode) => (n.kind === 'auto_attendant' || n.kind === 'call_queue') && /^(aa|cq|app):[^:]+$/.test(n.id);

/**
 * Flags, on the graph's own boxes, a route that can come back to an auto attendant or queue it already passed (a loop: each pass counts towards the
 * limit of MAX_VOICE_APP_TRANSITIONS moves, after which Teams disconnects the call) and a route that is unusually deep.
 */
function addRouteWarnings(graph: CallFlowGraph): void {
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const out = new Map<string, string[]>();
  for (const e of graph.edges) out.set(e.source, [...(out.get(e.source) ?? []), e.target]);
  const warn = (id: string, w: string) => {
    const n = byId.get(id);
    if (n && !n.warnings?.includes(w)) n.warnings = [...(n.warnings ?? []), w];
  };
  const root = graph.nodes[0];
  if (!root) return;
  const onPath = new Set<string>();
  const done = new Set<string>();
  let deepest = { id: '', depth: 0 };
  const walk = (id: string, depth: number) => {
    onPath.add(id);
    const node = byId.get(id)!;
    const here = depth + (isVoiceApp(node) && id !== root.id ? 1 : 0);
    if (here > deepest.depth) deepest = { id, depth: here };
    for (const next of out.get(id) ?? []) {
      if (onPath.has(next)) {
        const back = byId.get(next);
        const from = isVoiceApp(node) ? node.label : (graph.nodes.find((n) => isVoiceApp(n) && id.startsWith(`${n.id}:`))?.label ?? node.label);
        if (back) warn(next, `⚠ Calls can loop back here from ${from}. Each pass counts: Teams disconnects a call after ${MAX_VOICE_APP_TRANSITIONS} moves between auto attendants and queues.`);
        continue;
      }
      if (!done.has(next)) walk(next, here);
    }
    onPath.delete(id);
    done.add(id);
  };
  walk(root.id, 0);
  if (deepest.depth >= DEEP_ROUTE_WARN) warn(deepest.id, `⚠ A call reaches this after ${deepest.depth} moves between auto attendants and queues (Teams disconnects after ${MAX_VOICE_APP_TRANSITIONS}).`);
}

/** The warning on a menu with more options than callers can remember. */
function longMenuWarning(options: { dtmf: string }[]): string | undefined {
  const keys = options.filter((o) => o.dtmf !== 'Automatic').length;
  return keys > MAX_RECOMMENDED_MENU_OPTIONS ? `⚠ ${keys} menu options: Microsoft recommends ${MAX_RECOMMENDED_MENU_OPTIONS} or fewer. Move some into a nested auto attendant.` : undefined;
}

const QUEUE_NUMBER_WARNING =
  '⚠ Has its own phone number: a queue cannot route out-of-hours or holiday calls. Unless it is open 24/7, give the number to an auto attendant that redirects here.';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/**
 * A holiday's dates as people read them: "Fri 25 Dec 2026", "Fri 25 Dec 2026 – Mon 28 Dec 2026", or with times when it does not cover whole days.
 * Teams' ranges end at the start of the day AFTER the last one, so an end at midnight shows the day before. Wall-clock values, never converted.
 */
export function formatHolidayDates(ranges: { start: string; end: string }[] | undefined): string[] {
  const parse = (v: string) => {
    const m = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}))?/.exec(v);
    return m ? { ms: Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!, +(m[4] ?? 0), +(m[5] ?? 0)), midnight: !m[4] || (m[4] === '00' && m[5] === '00') } : null;
  };
  const day = (ms: number) => {
    const d = new Date(ms);
    return `${WEEKDAYS[d.getUTCDay()]} ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
  };
  const time = (ms: number) => new Date(ms).toISOString().slice(11, 16);
  const lines: string[] = [];
  for (const r of ranges ?? []) {
    const a = parse(r.start);
    const b = parse(r.end);
    if (!a) continue;
    if (a.midnight && (!b || b.midnight)) {
      const last = b ? b.ms - 86_400_000 : a.ms;
      lines.push(last <= a.ms ? day(a.ms) : `${day(a.ms)} – ${day(last)}`);
    } else {
      lines.push(b ? `${day(a.ms)} ${time(a.ms)} – ${b.ms - a.ms < 86_400_000 && new Date(a.ms).getUTCDate() === new Date(b.ms).getUTCDate() ? '' : `${day(b.ms)} `}${time(b.ms)}` : `${day(a.ms)} ${time(a.ms)}`);
    }
  }
  return lines.length > 6 ? [...lines.slice(0, 5), `and ${lines.length - 5} more dates`] : lines;
}

/** The label on the line from an auto attendant to one of its schedule boxes: Teams checks holidays first, then business hours, and otherwise it is after hours. */
const SCHEDULE_ORDER = { holiday: 1, business_hours: 2, after_hours: 3 } as const;
const scheduleEdgeLabel = (branch: 'holiday' | 'business_hours' | 'after_hours') =>
  `${SCHEDULE_ORDER[branch]}. ${branch === 'holiday' ? 'Holiday' : branch === 'business_hours' ? 'Business hours' : 'After hours'}`;

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

/** A resource account as the diagram shows it. */
export interface CallFlowResourceAccount {
  name?: string | null;
  upn?: string | null;
  number?: string | null;
}

const DAY_ORDER = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'] as const;
const DAY_SHORT: Record<(typeof DAY_ORDER)[number], string> = { monday: 'Mon', tuesday: 'Tue', wednesday: 'Wed', thursday: 'Thu', friday: 'Fri', saturday: 'Sat', sunday: 'Sun' };

/**
 * "Mon–Fri 09:00–17:00" lines for a weekly schedule: consecutive days with the same hours share a line, and days with no hours are
 * left out. A schedule saved without Complement lists the hours the attendant is NOT in business hours, so those are labelled.
 */
export function formatWeeklyHours(weekly: {
  monday: { start: string; end: string }[];
  tuesday: { start: string; end: string }[];
  wednesday: { start: string; end: string }[];
  thursday: { start: string; end: string }[];
  friday: { start: string; end: string }[];
  saturday: { start: string; end: string }[];
  sunday: { start: string; end: string }[];
  complement?: boolean;
}): string[] {
  const text = (day: (typeof DAY_ORDER)[number]) => weekly[day].map((r) => `${r.start}–${r.end}`).join(', ');
  const lines: string[] = [];
  let i = 0;
  while (i < DAY_ORDER.length) {
    const t = text(DAY_ORDER[i]!);
    let j = i;
    while (j + 1 < DAY_ORDER.length && text(DAY_ORDER[j + 1]!) === t) j++;
    if (t) lines.push(`${i === j ? DAY_SHORT[DAY_ORDER[i]!] : `${DAY_SHORT[DAY_ORDER[i]!]}–${DAY_SHORT[DAY_ORDER[j]!]}`} ${t}`);
    i = j + 1;
  }
  if (lines.length === 0) return ['No hours set'];
  return weekly.complement === false ? ['Closed during:', ...lines] : lines;
}

/** The PowerShell-only settings of one queue exception (overflow, time-out, no agents) that change what a caller meets on the way out. */
interface ActionExtras {
  /** Call priority 1-5 when the call is forwarded (-<X>ActionCallPriority). */
  priority?: number;
  /** What the caller hears (text to speech) before being put through to a person or a personal voicemail. */
  prompt?: string;
  /** The audio file played instead (its name, or "Audio file" when only Teams' own id is known). */
  audio?: string;
}

/**
 * The line from a queue's exception to where the call goes, with the PowerShell-only extras drawn: the call priority is written on the
 * line, and what the caller hears first is a box between the queue and the target ("Caller hears" - spoken text, and/or an audio file).
 * No extras: the plain line, exactly as before.
 */
function addActionEdge(b: GraphBuilder, sourceId: string, targetId: string, label: string, branch: CallFlowBranch, extras: ActionExtras): void {
  const edgeLabel = extras.priority != null ? `${label} (priority ${extras.priority})` : label;
  if (!extras.prompt && !extras.audio) {
    b.addEdge(sourceId, targetId, edgeLabel, branch);
    return;
  }
  const heardId = b.ensureNode({
    id: `${sourceId}:redirect:${branch}`,
    kind: 'announcement',
    label: 'Caller hears',
    sublabel: extras.prompt ? snippet([extras.prompt], false) : `🔊 ${extras.audio}`,
    details: extras.prompt && extras.audio ? [`🔊 ${extras.audio}`] : undefined,
  });
  b.addEdge(sourceId, heardId, edgeLabel, branch);
  b.addEdge(heardId, targetId, 'then', branch);
}

/** "Dial by name also says: Department" - the PowerShell-only -UserNameExtension of an auto attendant (None adds nothing to say). */
function dialByNameDetails(extension: string | null | undefined): string[] {
  return extension === 'Office' || extension === 'Department' ? [`Dial by name also says: ${extension}`] : [];
}

/** The lines under a front door: each resource account's name and number. */
function resourceAccountDetails(accounts: CallFlowResourceAccount[] | undefined): string[] {
  const out: string[] = [];
  for (const ra of accounts ?? []) {
    const who = ra.name || ra.upn;
    if (who) out.push(`Resource account: ${who}`);
    if (ra.number) out.push(`Number: ${ra.number.replace(/^tel:/i, '')}`);
  }
  return out;
}

/* ============================ Design & Build ============================ */

export interface DesignAutoAttendantInput {
  buildId: string;
  name: string;
  operator: AutoAttendantCallableEntity | null;
  defaultCallFlow: AutoAttendantCallFlow | null;
  afterHoursCallFlow: AutoAttendantCallFlow | null;
  holidayCallFlows: { name: string; callFlow: AutoAttendantCallFlow; schedule?: AutoAttendantSchedule | null }[];
  /** Set when this AA's resource account has a phone number attached - the real front door a caller dials, vs. an AA only reachable via another AA's menu. */
  hasPhoneNumber?: boolean;
  /** This AA's resource accounts, with the numbers a caller dials. */
  resourceAccounts?: CallFlowResourceAccount[];
  /** The weekly business hours (with Complement) - drawn on the Business hours box. */
  schedule?: AutoAttendantSchedule | null;
  timeZone?: string | null;
  /** -UserNameExtension (None, Office, Department): what dial-by-name adds after a name two people share. null = not managed. */
  userNameExtension?: string | null;
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
  /** Agent UPNs - listed in one box under the queue (the queue offers its calls to them), not just counted in the sublabel. */
  agents?: string[];
  /** The queue's own resource accounts, with any number that rings it directly. */
  resourceAccounts?: CallFlowResourceAccount[];
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

function designActionExtras(s: CallQueueActionSettings): ActionExtras {
  const toPerson = s.action === 'Forward';
  const toVoicemail = s.action === 'Voicemail';
  return {
    priority: toPerson ? s.priority : undefined,
    prompt: toPerson || toVoicemail ? s.redirectPrompt?.trim() || undefined : undefined,
    audio: toPerson || toVoicemail ? s.redirectAudio?.filename : undefined,
  };
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
      const looksLikeNumber = /^(tel:)?\+?[\d\s()-]+$/i.test(settings.target.trim());
      const targetId =
        settings.action === 'SharedVoicemail' && !looksLikeUpn
          ? b.ensureNode({ id: `group:${settings.target}`, kind: 'shared_voicemail', label: 'Shared voicemail (group)', sublabel: settings.target })
          : looksLikeNumber
            ? b.ensureNode({ id: `ext:${settings.target}`, kind: 'external_number', label: settings.target.replace(/^tel:/i, '') })
            : b.ensureNode({ id: `user:${settings.target.toLowerCase()}`, kind: 'person', label: settings.target });
      addActionEdge(b, sourceId, targetId, label, branch, designActionExtras(settings));
    } else if (settings.action === 'SharedVoicemail') {
      b.addEdge(sourceId, b.ensureNode({ id: 'shared_voicemail', kind: 'shared_voicemail', label: 'Shared voicemail' }), label, branch);
    } else if (settings.action === 'Voicemail') {
      // "Voicemail (personal)" - the target is whose mailbox receives it.
      const targetId = settings.target
        ? b.ensureNode({ id: `voicemail:${settings.target.toLowerCase()}`, kind: 'voicemail', label: 'Voicemail', sublabel: settings.target })
        : b.ensureNode({ id: 'voicemail', kind: 'voicemail', label: 'Voicemail (no person set)' });
      addActionEdge(b, sourceId, targetId, label, branch, designActionExtras(settings));
    } else if (settings.action === 'Disconnect' || settings.action === 'DisconnectWithBusy') {
      b.addEdge(sourceId, b.ensureNode({ id: 'disconnect', kind: 'disconnect', label: 'Disconnect' }), label, branch);
    }
  };
  action(cq.overflow, 'overflow', 'Overflow');
  action(cq.timeout, 'timeout', 'Timeout');
  action(cq.noAgentAction, 'no_agent', 'No agents');
}

/**
 * What the queue's own box carries: its agents (drawn as one box under it - "28 agents" as a count isn't the same as seeing who they are), its
 * resource accounts and numbers, and a warning when a number rings the queue directly.
 */
function designCqAgents(b: GraphBuilder, cq: DesignCallQueueInput): void {
  const agents = (cq.agents ?? []).filter((upn): upn is string => !!upn);
  const accounts = cq.resourceAccounts ?? [];
  const details = resourceAccountDetails(accounts);
  const numbered = accounts.some((ra) => !!ra.number);
  if (agents.length || details.length) {
    b.ensureNode({ id: `cq:${cq.buildId}`, kind: 'call_queue', label: '(unresolved)', agents: agents.length ? agents : undefined, details: details.length ? details : undefined, warnings: numbered ? [QUEUE_NUMBER_WARNING] : undefined });
  }
}

/** The "as-designed" graph for one Call Queue, from Design & Build's structured columns. */
export function buildCallQueueFlowGraphFromDesign(cq: DesignCallQueueInput): CallFlowGraph {
  const b = new GraphBuilder();
  b.ensureNode({ id: `cq:${cq.buildId}`, kind: 'call_queue', label: cq.name, sublabel: designCqSublabel(cq) });
  designCqAgents(b, cq);
  designCqActionEdges(b, cq);
  return b.build();
}

/**
 * The "as-designed" graph for one Auto Attendant, from Design & Build's
 * structured columns - starting from `aa` (typically the front-door AA a
 * phone number rings into), following every menu option that transfers to
 * another Auto Attendant and expanding it fully in turn (a real chain: a
 * Language AA hands off to a Main Number AA, which hands off to further
 * AAs), and expanding one hop into any target Call Queue's own agents and
 * Overflow/Timeout/No-agent routing. `allAutoAttendants`/`allCallQueues`
 * are this site's full lists (not all of them necessarily drawn) - needed
 * to look up a transfer target's own configuration and real name.
 */
export function buildAutoAttendantFlowGraphFromDesign(
  aa: DesignAutoAttendantInput,
  allAutoAttendants: DesignAutoAttendantInput[],
  allCallQueues: DesignCallQueueInput[],
  /** What Teams has, for a menu option that transfers to a voice app outside this site (kept by its Teams id): drawn, with its agents and routing, from the discovered data. */
  live?: LiveVoiceApps,
): CallFlowGraph {
  const b = new GraphBuilder();
  const aaById = new Map(allAutoAttendants.map((a) => [a.buildId, a]));
  const cqById = new Map(allCallQueues.map((cq) => [cq.buildId, cq]));
  const visitedAa = new Set<string>();
  const visitedCq = new Set<string>();

  /** A voice app that is in Teams but not on this site: drawn from the discovered data, with its own agents and routing. */
  const resolveLiveTarget = (entity: AutoAttendantCallableEntity): string | undefined => {
    const key = entity.liveId?.toLowerCase();
    if (!key) return undefined;
    const identityOf = (o: { data: Record<string, unknown> }) => (typeof o.data.Identity === 'string' ? o.data.Identity.toLowerCase() : undefined);
    const cq = live?.callQueues.find((o) => identityOf(o) === key);
    if (cq) {
      b.merge(buildCallQueueFlowGraphFromLive(cq, live!.usersByEntraId, { autoAttendants: live!.autoAttendants, callQueues: live!.callQueues }));
      return `cq:${String(cq.data.Identity)}`;
    }
    const aaLive = live?.autoAttendants.find((o) => identityOf(o) === key);
    if (aaLive) {
      b.merge(buildAutoAttendantFlowGraphFromLive(aaLive, live!.autoAttendants, live!.callQueues, live!.schedules, live!.usersByEntraId, live!.resourceAccountsByObjectId));
      return `aa:${String(aaLive.data.Identity)}`;
    }
    return b.ensureNode({ id: `${entity.kind === 'call_queue' ? 'cq' : 'aa'}:${key}`, kind: entity.kind === 'call_queue' ? 'call_queue' : 'auto_attendant', label: `Voice app in Teams (${key.slice(0, 8)}…)` });
  };

  const resolveTarget = (entity: AutoAttendantCallableEntity | undefined): string | undefined => {
    if (!entity) return undefined;
    switch (entity.kind) {
      case 'auto_attendant': {
        if (!entity.buildId) return entity.liveId ? resolveLiveTarget(entity) : undefined;
        const target = aaById.get(entity.buildId);
        return b.ensureNode({
          id: `aa:${entity.buildId}`,
          kind: 'auto_attendant',
          label: target?.name ?? '(unresolved)',
          badge: target?.hasPhoneNumber ? FRONT_DOOR_BADGE : undefined,
        });
      }
      case 'call_queue':
        return entity.buildId ? b.ensureNode({ id: `cq:${entity.buildId}`, kind: 'call_queue', label: cqById.get(entity.buildId)?.name ?? '(unresolved)' }) : entity.liveId ? resolveLiveTarget(entity) : undefined;
      case 'user':
        return entity.upn ? b.ensureNode({ id: `user:${entity.upn.toLowerCase()}`, kind: 'person', label: entity.upn }) : undefined;
      case 'external':
        return entity.number ? b.ensureNode({ id: `ext:${entity.number}`, kind: 'external_number', label: entity.number }) : undefined;
      case 'voicemail':
        return b.ensureNode({ id: 'voicemail', kind: 'voicemail', label: 'Voicemail' });
      case 'shared_voicemail':
        return entity.groupId
          ? b.ensureNode({ id: `group:${entity.groupId}`, kind: 'shared_voicemail', label: 'Shared voicemail (group)', sublabel: entity.groupId })
          : b.ensureNode({ id: 'shared_voicemail', kind: 'shared_voicemail', label: 'Shared voicemail' });
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
    if (opt.action === 'Announcement') {
      const text = opt.prompt?.type === 'Text' ? opt.prompt.text : undefined;
      b.addEdge(sourceId, b.ensureNode({ id: `${sourceId}:announce:${opt.dtmf}`, kind: 'announcement', label: 'Announcement', sublabel: text ? snippet([text], false) : undefined }), label, branch);
      return;
    }
    if (opt.action === 'TransferCallToTarget') {
      const targetId = resolveTarget(opt.target);
      if (!targetId) return;
      b.addEdge(sourceId, targetId, label, branch);
      if (opt.target?.kind === 'call_queue' && opt.target.buildId && !visitedCq.has(opt.target.buildId)) {
        visitedCq.add(opt.target.buildId);
        const cq = cqById.get(opt.target.buildId);
        if (cq) {
          designCqAgents(b, cq);
          designCqActionEdges(b, cq);
        }
      } else if (opt.target?.kind === 'auto_attendant' && opt.target.buildId) {
        const target = aaById.get(opt.target.buildId);
        if (target) expandAa(target);
      }
    }
  };

  function expandAa(a: DesignAutoAttendantInput): void {
    if (visitedAa.has(a.buildId)) return;
    visitedAa.add(a.buildId);
    const rootId = b.ensureNode({
      id: `aa:${a.buildId}`,
      kind: 'auto_attendant',
      label: a.name,
      badge: a.hasPhoneNumber ? FRONT_DOOR_BADGE : undefined,
      details: [...resourceAccountDetails(a.resourceAccounts), ...dialByNameDetails(a.userNameExtension)],
    });
    const hoursDetails = [...(a.schedule?.weekly ? formatWeeklyHours(a.schedule.weekly) : []), ...(a.timeZone ? [`Time zone: ${a.timeZone}`] : [])];
    const addBranch = (cf: AutoAttendantCallFlow | null, key: string, branchLabel: string, branch: 'business_hours' | 'after_hours' | 'holiday', details?: string[]) => {
      if (!cf) return;
      const tooLong = longMenuWarning(cf.menu.options);
      const branchId = b.ensureNode({
        id: `${rootId}:${key}`,
        kind: 'auto_attendant',
        label: branchLabel,
        sublabel: designGreeting(cf),
        details: key === 'business_hours' ? hoursDetails : details?.length ? details : undefined,
        warnings: tooLong ? [tooLong] : undefined,
      });
      b.addEdge(rootId, branchId, scheduleEdgeLabel(branch), branch);
      for (const opt of cf.menu.options) walkMenuOption(branchId, opt, a, branch);
    };
    // In the order Teams checks them: a holiday first, then business hours; any other time is after hours.
    a.holidayCallFlows.forEach((h, i) => addBranch(h.callFlow, `holiday${i}`, `Holiday: ${h.name}`, 'holiday', formatHolidayDates(h.schedule?.fixed?.ranges)));
    addBranch(a.defaultCallFlow, 'business_hours', 'Business hours', 'business_hours');
    addBranch(a.afterHoursCallFlow, 'after_hours', 'After hours', 'after_hours');
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
/** The discovered voice apps a design diagram may need, for a transfer to one that is not part of the site. */
export interface LiveVoiceApps {
  autoAttendants: LiveAutoAttendantInput[];
  callQueues: LiveCallQueueInput[];
  schedules: LiveScheduleInput[];
  usersByEntraId?: Map<string, string>;
  resourceAccountsByObjectId?: Map<string, CallFlowResourceAccount>;
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
/** The parameter prefix Get-CsCallQueue / Set-CsCallQueue use for each exception (-OverflowActionCallPriority, -NoAgentRedirectPerson…). */
const CQ_PREFIX = { overflow: 'Overflow', timeout: 'Timeout', no_agent: 'NoAgent' } as const;
/** The call priority Teams uses when none is set (1 highest to 5 lowest). */
const DEFAULT_CALL_PRIORITY = 3;

/** The queue's agents, listed on the queue itself (drawn as one box under it). Get-CsCallQueue's Agents entries carry `.ObjectId`, the same tenant_users.entra_id key as every other live person reference. */
function liveCqAgents(b: GraphBuilder, cq: LiveCallQueueInput, usersByEntraId?: Map<string, string>): void {
  const identity = typeof cq.data.Identity === 'string' ? cq.data.Identity : cq.name;
  const raw = Array.isArray(cq.data.Agents) ? (cq.data.Agents as Record<string, unknown>[]) : [];
  const agents = raw
    .map((agent) => (typeof agent.ObjectId === 'string' ? agent.ObjectId : undefined))
    .filter((id): id is string => !!id)
    .map((objectId) => usersByEntraId?.get(objectId.toLowerCase()) ?? `User (${objectId.slice(0, 8)}…)`);
  const numbered = liveHasPhoneNumber(cq.data);
  if (agents.length || numbered) b.ensureNode({ id: `cq:${identity}`, kind: 'call_queue', label: '(unresolved)', agents: agents.length ? agents : undefined, warnings: numbered ? [QUEUE_NUMBER_WARNING] : undefined });
}

/**
 * Get-CsCallQueue's …ActionTarget.Type, read from MicrosoftTeams 8.0.0's own
 * assembly (Microsoft.Rtc.Management.Hosted.HuntGroup.Models.TargetType):
 * UnResolved=0, User=1, ApplicationEndpoint=2, ApplicationInstance=3,
 * Phone=4, MailBox=5. ConvertTo-Json writes it as the number, not the name.
 */
const CQ_TARGET_TYPES = ['UnResolved', 'User', 'ApplicationEndpoint', 'ApplicationInstance', 'Phone', 'MailBox'] as const;
const CQ_ACTIONS = { overflow: CALL_QUEUE_OVERFLOW_ACTIONS, timeout: CALL_QUEUE_TIMEOUT_ACTIONS, no_agent: CALL_QUEUE_NO_AGENT_ACTIONS } as const;

/**
 * Overflow/Timeout/No-agent edges for a live queue, driven by the decoded
 * action (not just whether a target exists): Disconnect draws a disconnect,
 * Voicemail a personal voicemail, SharedVoicemail a group, Forward a person,
 * phone number or - via `resolveVoiceApp` (the caller's AA/CQ lookup) -
 * another voice app. `usersByEntraId` (tenant_users.entra_id, lowercased ->
 * UPN) names a person target when the caller has that user loaded.
 */
function liveCqActionEdges(
  b: GraphBuilder,
  cq: LiveCallQueueInput,
  usersByEntraId?: Map<string, string>,
  resolveVoiceApp?: (id: string) => string | undefined,
): void {
  const identity = typeof cq.data.Identity === 'string' ? cq.data.Identity : cq.name;
  const sourceId = `cq:${identity}`;
  const personLabel = (id: string) => usersByEntraId?.get(id.toLowerCase()) ?? `User (${id.slice(0, 8)}…)`;
  for (const [actionKey, targetKey, branch] of [
    ['OverflowAction', 'OverflowActionTarget', 'overflow'],
    ['TimeoutAction', 'TimeoutActionTarget', 'timeout'],
    ['NoAgentAction', 'NoAgentActionTarget', 'no_agent'],
  ] as const) {
    const action = decodeCallQueueEnum(cq.data[actionKey], CQ_ACTIONS[branch]);
    if (!action || action === 'Queue') continue;
    const targetObj = cq.data[targetKey] as { Id?: unknown; Type?: unknown } | null | undefined;
    const id = typeof targetObj?.Id === 'string' ? targetObj.Id : undefined;
    const type = decodeCallQueueEnum(targetObj?.Type, CQ_TARGET_TYPES);
    let nodeId: string | undefined;
    if (action === 'Disconnect' || action === 'DisconnectWithBusy') {
      nodeId = b.ensureNode({ id: 'disconnect', kind: 'disconnect', label: 'Disconnect' });
    } else if (action === 'SharedVoicemail') {
      nodeId = id
        ? b.ensureNode({ id: `group:${id}`, kind: 'shared_voicemail', label: 'Shared voicemail (group)', sublabel: id })
        : b.ensureNode({ id: 'shared_voicemail', kind: 'shared_voicemail', label: 'Shared voicemail' });
    } else if (action === 'Voicemail') {
      nodeId = id
        ? b.ensureNode({ id: `voicemail:${id.toLowerCase()}`, kind: 'voicemail', label: 'Voicemail', sublabel: personLabel(id) })
        : b.ensureNode({ id: 'voicemail', kind: 'voicemail', label: 'Voicemail' });
    } else if (action === 'Forward' && id) {
      if (id.toLowerCase().startsWith('tel:') || type === 'Phone') {
        nodeId = b.ensureNode({ id: `ext:${id}`, kind: 'external_number', label: id.replace(/^tel:/i, '') });
      } else if (type === 'ApplicationEndpoint' || type === 'ApplicationInstance') {
        nodeId = resolveVoiceApp?.(id) ?? b.ensureNode({ id: `app:${id}`, kind: 'call_queue', label: `Voice app (${id.slice(0, 8)}…)` });
      } else {
        nodeId = resolveVoiceApp?.(id) ?? b.ensureNode({ id: `user:${id}`, kind: 'person', label: personLabel(id) });
      }
    }
    if (nodeId) {
      const live = liveCallQueueActionExtras(CQ_PREFIX[branch], cq.data, action);
      addActionEdge(b, sourceId, nodeId, CQ_ACTION_LABEL[branch], branch, {
        // Teams reports its default priority (3) on every forward to another queue or attendant, whether or not anyone chose it: only a different one is worth writing on the line.
        priority: live.priority === DEFAULT_CALL_PRIORITY ? undefined : live.priority,
        prompt: live.redirectPrompt,
        audio: live.redirectAudioId ? 'Audio file' : undefined,
      });
    }
  }
}

/** Resolves a live AA/CQ Identity, or one of their resource-account object ids, to that AA/CQ's node - shared by the live AA and CQ graphs. */
function liveVoiceAppResolver(b: GraphBuilder, allAutoAttendants: LiveAutoAttendantInput[], allCallQueues: LiveCallQueueInput[]): (id: string) => string | undefined {
  const byKey = new Map<string, { identity: string; name: string; kind: 'auto_attendant' | 'call_queue'; data: Record<string, unknown> }>();
  for (const [list, kind] of [
    [allAutoAttendants, 'auto_attendant'],
    [allCallQueues, 'call_queue'],
  ] as const) {
    for (const o of list) {
      const identity = typeof o.data.Identity === 'string' ? o.data.Identity : undefined;
      if (!identity) continue;
      const entry = { identity, name: o.name, kind, data: o.data };
      byKey.set(identity.toLowerCase(), entry);
      for (const i of Array.isArray(o.data.ApplicationInstances) ? (o.data.ApplicationInstances as unknown[]) : []) {
        if (typeof i === 'string') byKey.set(i.toLowerCase(), entry);
      }
    }
  }
  return (id) => {
    const hit = byKey.get(id.toLowerCase());
    if (!hit) return undefined;
    return b.ensureNode({
      id: `${hit.kind === 'call_queue' ? 'cq' : 'aa'}:${hit.identity}`,
      kind: hit.kind,
      label: hit.name,
      badge: hit.kind === 'auto_attendant' && liveHasPhoneNumber(hit.data) ? FRONT_DOOR_BADGE : undefined,
    });
  };
}

/** The "as-is" graph for one Call Queue, straight from Discovery's live tenant_objects snapshot. `siblings` (every live AA/CQ) lets a Forward to another voice app show its real name. */
export function buildCallQueueFlowGraphFromLive(
  cq: LiveCallQueueInput,
  usersByEntraId?: Map<string, string>,
  siblings?: { autoAttendants: LiveAutoAttendantInput[]; callQueues: LiveCallQueueInput[] },
): CallFlowGraph {
  const b = new GraphBuilder();
  const identity = typeof cq.data.Identity === 'string' ? cq.data.Identity : cq.name;
  b.ensureNode({ id: `cq:${identity}`, kind: 'call_queue', label: cq.name, sublabel: liveCqSublabel(cq.data) });
  liveCqAgents(b, cq, usersByEntraId);
  liveCqActionEdges(b, cq, usersByEntraId, siblings ? liveVoiceAppResolver(b, siblings.autoAttendants, siblings.callQueues) : undefined);
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
 * schedule name. `usersByEntraId` (tenant_users.entra_id, lowercased -> UPN
 * - the same key Get-CsAutoAttendant/Get-CsCallQueue's own CallTarget/Agent
 * ObjectId fields use) resolves a person target to a real UPN when loaded,
 * else falls back to a truncated id.
 */
export function buildAutoAttendantFlowGraphFromLive(
  aa: LiveAutoAttendantInput,
  allAutoAttendants: LiveAutoAttendantInput[],
  allCallQueues: LiveCallQueueInput[],
  schedules: LiveScheduleInput[],
  usersByEntraId?: Map<string, string>,
  /** tenant resource accounts by object id (what an AA's ApplicationInstances hold), so the front door can name its account and number. */
  resourceAccountsByObjectId?: Map<string, CallFlowResourceAccount>,
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
  // A transfer to a resource account (ApplicationEndpoint) reaches whichever
  // AA/CQ that account is associated with - its ApplicationInstances.
  const ownerByInstance = new Map<string, string>();
  for (const o of [...allAutoAttendants, ...allCallQueues]) {
    const identity = typeof o.data.Identity === 'string' ? o.data.Identity : undefined;
    const instances = Array.isArray(o.data.ApplicationInstances) ? (o.data.ApplicationInstances as unknown[]) : [];
    if (identity) for (const i of instances) if (typeof i === 'string') ownerByInstance.set(i.toLowerCase(), identity);
  }
  const resolveVoiceAppNode = liveVoiceAppResolver(b, allAutoAttendants, allCallQueues);
  const voiceAppIdentity = (ref: LiveCallableEntityRef | undefined): string | undefined => {
    if (!ref?.liveId) return undefined;
    if (ref.kind === 'voice_app') return ref.liveId;
    if (ref.kind === 'resource_account') return ownerByInstance.get(ref.liveId.toLowerCase());
    return undefined;
  };

  const resolveTarget = (ref: LiveCallableEntityRef | undefined): string | undefined => {
    if (!ref) return undefined;
    if (ref.kind === 'external' && ref.number) return b.ensureNode({ id: `ext:${ref.number}`, kind: 'external_number', label: ref.number });
    if (ref.kind === 'user' && ref.liveId) {
      const upn = usersByEntraId?.get(ref.liveId.toLowerCase());
      return b.ensureNode({ id: `user:${ref.liveId}`, kind: 'person', label: upn ?? `User (${ref.liveId.slice(0, 8)}…)` });
    }
    if (ref.kind === 'shared_voicemail' && ref.liveId) {
      return b.ensureNode({ id: `group:${ref.liveId}`, kind: 'shared_voicemail', label: 'Shared voicemail (group)', sublabel: ref.liveId });
    }
    const appIdentity = voiceAppIdentity(ref);
    if (appIdentity) {
      const key = appIdentity.toLowerCase();
      const known = nameByIdentity.get(key);
      if (!known) return undefined;
      const aData = known.kind === 'auto_attendant' ? aaByIdentity.get(key)?.data : undefined;
      return b.ensureNode({
        id: `${known.kind === 'call_queue' ? 'cq' : 'aa'}:${appIdentity}`,
        kind: known.kind,
        label: known.name,
        badge: aData && liveHasPhoneNumber(aData) ? FRONT_DOOR_BADGE : undefined,
      });
    }
    return undefined;
  };

  const walkMenuOption = (sourceId: string, opt: LiveMenuOption, owner: LiveAutoAttendantInput, branch: CallFlowBranch) => {
    const label = dtmfLabel(opt.dtmf);
    if (opt.action === 'DisconnectCall') {
      b.addEdge(sourceId, b.ensureNode({ id: 'disconnect', kind: 'disconnect', label: 'Disconnect' }), label, branch);
      return;
    }
    if (opt.action === 'TransferCallToOperator') {
      const targetId = resolveTarget(parseLiveCallTarget(owner.data.Operator)) ?? b.ensureNode({ id: 'operator', kind: 'operator', label: 'Operator (not configured)' });
      b.addEdge(sourceId, targetId, label, branch);
      return;
    }
    if (opt.action === 'Announcement') {
      const text = opt.prompt?.type === 'Text' ? opt.prompt.text : undefined;
      b.addEdge(sourceId, b.ensureNode({ id: `${sourceId}:announce:${opt.dtmf}`, kind: 'announcement', label: 'Announcement', sublabel: text ? snippet([text], false) : undefined }), label, branch);
      return;
    }
    const targetId = resolveTarget(opt.target);
    if (!targetId) return;
    b.addEdge(sourceId, targetId, label, branch);
    const appIdentity = voiceAppIdentity(opt.target);
    if (!appIdentity) return;
    const key = appIdentity.toLowerCase();
    const cq = cqByIdentity.get(key);
    if (cq && !visitedCq.has(key)) {
      visitedCq.add(key);
      liveCqAgents(b, cq, usersByEntraId);
      liveCqActionEdges(b, cq, usersByEntraId, resolveVoiceAppNode);
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
    const instances = Array.isArray(a.data.ApplicationInstances) ? (a.data.ApplicationInstances as unknown[]) : [];
    const accounts = instances.flatMap((i) => (typeof i === 'string' ? [resourceAccountsByObjectId?.get(i.toLowerCase())] : [])).filter((x): x is CallFlowResourceAccount => !!x);
    const rootId = b.ensureNode({
      id: `aa:${identity}`,
      kind: 'auto_attendant',
      label: a.name,
      badge: liveHasPhoneNumber(a.data) ? FRONT_DOOR_BADGE : undefined,
      details: [...resourceAccountDetails(accounts), ...dialByNameDetails(decodeUserNameExtension(a.data.UserNameExtension))],
    });
    // The business hours are the weekly schedule of the After hours association (its Complement is what makes the rest "after hours").
    const associations = Array.isArray(a.data.CallHandlingAssociations) ? (a.data.CallHandlingAssociations as Record<string, unknown>[]) : [];
    const afterHoursAssoc = associations.find((cha) => cha.Type === 0 && typeof cha.ScheduleId === 'string');
    const hoursSchedule = afterHoursAssoc ? parseLiveSchedule(scheduleByKey.get(afterHoursAssoc.ScheduleId as string)) : undefined;
    const hoursDetails = [
      ...(hoursSchedule?.weekly ? formatWeeklyHours(hoursSchedule.weekly) : []),
      ...(typeof a.data.TimeZoneId === 'string' && a.data.TimeZoneId ? [`Time zone: ${a.data.TimeZoneId}`] : []),
    ];
    const addBranch = (cf: LiveCallFlow | undefined, branchKey: string, branchLabel: string, branch: 'business_hours' | 'after_hours' | 'holiday', details?: string[]) => {
      if (!cf) return;
      const tooLong = longMenuWarning(cf.menu.options);
      const branchId = b.ensureNode({
        id: `${rootId}:${branchKey}`,
        kind: 'auto_attendant',
        label: branchLabel,
        sublabel: liveGreeting(cf),
        details: branchKey === 'business_hours' ? hoursDetails : details?.length ? details : undefined,
        warnings: tooLong ? [tooLong] : undefined,
      });
      b.addEdge(rootId, branchId, scheduleEdgeLabel(branch), branch);
      for (const opt of cf.menu.options) walkMenuOption(branchId, opt, a, branch);
    };

    // In the order Teams checks them: holidays first, then business hours; any other time is after hours.
    const callFlowsById = new Map((Array.isArray(a.data.CallFlows) ? (a.data.CallFlows as Record<string, unknown>[]) : []).map((cf) => [cf.Id as string, cf]));
    const handled = (Array.isArray(a.data.CallHandlingAssociations) ? (a.data.CallHandlingAssociations as Record<string, unknown>[]) : []).flatMap((cha) => {
      const cfRaw = typeof cha.CallFlowId === 'string' ? callFlowsById.get(cha.CallFlowId) : undefined;
      const parsedCf = cfRaw ? parseLiveCallFlow(cfRaw) : undefined;
      return parsedCf ? [{ cha, cfRaw, parsedCf }] : [];
    });
    let holidayIdx = 0;
    for (const { cha, cfRaw, parsedCf } of handled) {
      if (cha.Type !== 1) continue;
      const scheduleRaw = typeof cha.ScheduleId === 'string' ? scheduleByKey.get(cha.ScheduleId) : undefined;
      const scheduleName = typeof scheduleRaw?.Name === 'string' ? scheduleRaw.Name : typeof cfRaw?.Name === 'string' ? (cfRaw.Name as string) : 'Holiday';
      addBranch(parsedCf, `holiday${holidayIdx}`, `Holiday: ${scheduleName}`, 'holiday', formatHolidayDates(parseLiveSchedule(scheduleRaw)?.fixed?.ranges));
      holidayIdx++;
    }
    addBranch(parseLiveCallFlow(a.data.DefaultCallFlow), 'business_hours', 'Business hours', 'business_hours');
    for (const { cha, parsedCf } of handled) if (cha.Type === 0) addBranch(parsedCf, 'after_hours', 'After hours', 'after_hours');

    const operatorRef = parseLiveCallTarget(a.data.Operator);
    if (operatorRef) {
      const targetId = resolveTarget(operatorRef);
      if (targetId) b.addEdge(rootId, targetId, 'Operator', 'operator');
    }
  }

  expandAa(aa);
  return b.build();
}

/* ============================== PDF cover ============================== */

/** What the PDF's cover page lists, read off a built graph: the key facts Microsoft's design guidance says a call flow should record. */
export interface CallFlowSummary {
  /** The numbers callers dial and the resource account behind each (front doors, and any queue with its own number). */
  numbers: { name: string; resourceAccount: string; number: string }[];
  /** Each auto attendant's business hours. */
  hours: { name: string; lines: string[] }[];
  holidays: { name: string; owner: string; dates: string[] }[];
  queues: { name: string; agents: number; routing: string }[];
  warnings: { where: string; text: string }[];
}

export function callFlowSummary(graph: CallFlowGraph): CallFlowSummary {
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const ownerOf = (n: CallFlowNode) => {
    const i = n.id.lastIndexOf(':');
    return byId.get(n.id.slice(0, i))?.label ?? '';
  };
  const out: CallFlowSummary = { numbers: [], hours: [], holidays: [], queues: [], warnings: [] };
  for (const n of graph.nodes) {
    if (isVoiceApp(n)) {
      let current: { name: string; resourceAccount: string; number: string } | undefined;
      for (const d of n.details ?? []) {
        if (d.startsWith('Resource account: ')) out.numbers.push((current = { name: n.label, resourceAccount: d.slice(18), number: '' }));
        else if (d.startsWith('Number: ')) {
          if (current && !current.number) current.number = d.slice(8);
          else out.numbers.push({ name: n.label, resourceAccount: '', number: d.slice(8) });
        }
      }
    }
    if (n.id.endsWith(':business_hours') && n.details?.length) out.hours.push({ name: ownerOf(n), lines: n.details });
    if (/:holiday\d+$/.test(n.id)) out.holidays.push({ name: n.label.replace(/^Holiday: /, ''), owner: ownerOf(n), dates: n.details ?? [] });
    if (n.kind === 'call_queue' && isVoiceApp(n)) out.queues.push({ name: n.label, agents: n.agents?.length ?? 0, routing: n.sublabel ?? '' });
    for (const w of n.warnings ?? []) out.warnings.push({ where: n.label, text: w.replace(/^⚠\s*/, '') });
  }
  return out;
}
