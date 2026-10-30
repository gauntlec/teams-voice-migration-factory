import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { applyNodeChanges, Background, BaseEdge, Controls, type Edge, getBezierPath, getNodesBounds, getViewportForBounds, Handle, MarkerType, MiniMap, type EdgeProps, type Node, type NodeProps, Panel, Position, ReactFlow, ReactFlowProvider, useNodesInitialized, useReactFlow } from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import dagre from 'dagre';
import { toPng } from 'html-to-image';
import { jsPDF } from 'jspdf';
import { Button, Text, Tooltip, tokens , makeStyles, shorthands } from '@fluentui/react-components';
import { ArrowDownloadRegular, ArrowDownRegular, ArrowRightRegular } from '@fluentui/react-icons';
import type { CallFlowBranch, CallFlowGraph, CallFlowNodeKind } from '@tvmf/shared';
import { useAuth } from '../auth';
import { useGroupNames } from '../hooks/useGroupNames';
import { MutedText } from './ui';

const useLocalStyles = makeStyles({
  flexColItemsFlexendGap4: { display: "flex", flexDirection: "column", alignItems: "flex-end", ...shorthands.gap('4px') },
  flexGap6: { display: "flex", ...shorthands.gap('6px') },
  flexGap4: { display: "flex", ...shorthands.gap('4px') },
  mt2: { fontSize: '10px', opacity: 0.7, marginTop: '2px' },
  inlineblockMt4ColoredFilledPad1px7: { display: "inline-block", marginTop: '4px', fontSize: '9px', fontWeight: 600, letterSpacing: '0.3px', textTransform: "uppercase", color: "#166534", backgroundColor: "#DCFCE7", ...shorthands.border("1px", "solid", "#86EFAC"), ...shorthands.borderRadius("999px"), ...shorthands.padding("1px", "7px") },
  agentsTitle: { fontSize: '11px', fontWeight: 700, color: '#047857', marginBottom: '2px' },
  gridGap8: { display: "grid", ...shorthands.gap('8px') },
  w120H80: { width: '120px', height: '80px' },
  flexWrapItemsCenterGap14: { display: "flex", ...shorthands.gap('14px'), flexWrap: "wrap", alignItems: "center" },
  detail: { fontSize: '10px', color: '#374151', marginTop: '2px', lineHeight: '14px' },
  flexItemsCenterGap4: { display: "flex", alignItems: "center", ...shorthands.gap('4px') },
});


type Direction = 'LR' | 'TB';

const NODE_WIDTH = 200;
/** Only until a box has been drawn and measured: the layout uses each box's real size (see FlowCanvas). */
const NODE_HEIGHT = 52;
/** The space between a call queue and the box of its agents under it. */
const AGENTS_GAP = 26;

const KIND_STYLE: Record<CallFlowNodeKind, { bg: string; border: string; icon: string; label: string }> = {
  auto_attendant: { bg: '#EEF2FF', border: '#4657D2', icon: '☎️', label: 'Auto attendant' },
  call_queue: { bg: '#F3E8FF', border: '#7C3AED', icon: '👥', label: 'Call queue' },
  person: { bg: '#ECFDF5', border: '#059669', icon: '🧑', label: 'Person' },
  external_number: { bg: '#F3F4F6', border: '#6B7280', icon: '📞', label: 'External number' },
  voicemail: { bg: '#FFF7ED', border: '#EA580C', icon: '📼', label: 'Voicemail' },
  shared_voicemail: { bg: '#FFF7ED', border: '#EA580C', icon: '📼', label: 'Shared voicemail' },
  operator: { bg: '#ECFEFF', border: '#0891B2', icon: '🎧', label: 'Operator' },
  announcement: { bg: '#F0F9FF', border: '#0284C7', icon: '📢', label: 'Announcement' },
  disconnect: { bg: '#FEF2F2', border: '#DC2626', icon: '⛔', label: 'Disconnect' },
};

const BRANCH_STYLE: Record<CallFlowBranch, { color: string; dash?: string; label: string }> = {
  business_hours: { color: '#4657D2', label: 'Business hours' },
  after_hours: { color: '#EA580C', dash: '5,3', label: 'After hours' },
  holiday: { color: '#7C3AED', dash: '2,3', label: 'Holiday' },
  operator: { color: '#0891B2', label: 'Operator' },
  overflow: { color: '#DC2626', dash: '5,3', label: 'Overflow' },
  timeout: { color: '#DC2626', dash: '5,3', label: 'Timeout' },
  no_agent: { color: '#DC2626', dash: '5,3', label: 'No agents' },
};
/** The arrow from a call queue down to its agents: the queue offers its calls to them. */
const AGENTS_COLOR = '#059669';
const agentsBoxId = (queueId: string) => `${queueId}::agents`;

/** What an edge's label says (kept in one place so layout reserves exactly the room the drawn label needs). */
const edgeLabelText = (e: { label: string; branch: CallFlowBranch; branchLabel?: string }) => {
  // The line into a holiday's box says just "Holiday": the box itself carries the holiday's (often long) name, and a long label would widen the whole diagram.
  const label = e.branch === 'holiday' && e.label.startsWith('Holiday:') ? 'Holiday' : e.label;
  return e.branchLabel ? `${label} · ${e.branchLabel}` : label;
};

/** Rough size of an edge label as drawn (11px bold text plus its padding), so dagre can keep a clear gap for it between two boxes. */
const edgeLabelSize = (text: string) => ({ width: Math.ceil(text.length * 6.6) + 20, height: 24 });

type Size = { w: number; h: number };
type Point = { x: number; y: number };
type Route = { points: Point[]; label: Point };

/**
 * Where every box goes, from the boxes' MEASURED sizes (dagre only computes positions; xyflow draws). A call queue with agents takes a slot tall
 * enough for the queue and its agents' box under it, so nothing else is placed where the agents are. The first box (the front door) is then
 * centred across the diagram: vertically in landscape, horizontally in portrait.
 */
function arrange(graph: CallFlowGraph, direction: Direction, size: (id: string) => Size) {
  const g = new dagre.graphlib.Graph();
  // With edge labels dagre puts each label in a rank of its own between the two boxes and halves ranksep, so this is the room either side of it.
  g.setGraph({ rankdir: direction, nodesep: 18, ranksep: 48, edgesep: 12 });
  g.setDefaultEdgeLabel(() => ({}));
  for (const n of graph.nodes) {
    const own = size(n.id);
    const agents = n.agents?.length ? size(agentsBoxId(n.id)) : null;
    g.setNode(n.id, agents ? { width: Math.max(own.w, agents.w), height: own.h + AGENTS_GAP + agents.h } : { width: own.w, height: own.h });
  }
  // The label's size is passed in so the layout keeps that space free: without it a label is drawn wherever the line's middle falls, often behind a box.
  for (const e of graph.edges) g.setEdge(e.source, e.target, { ...edgeLabelSize(edgeLabelText(e)), labelpos: 'c' });
  dagre.layout(g);

  // dagre centres each box on its row; in portrait a row is then ragged (a queue with its agents is tall), so every box in a row starts at the
  // top of the row's tallest one instead.
  const rowTop = new Map<number, number>();
  if (direction === 'TB') {
    for (const n of graph.nodes) {
      const slot = g.node(n.id);
      const row = Math.round(slot.y);
      rowTop.set(row, Math.min(rowTop.get(row) ?? Infinity, slot.y - slot.height / 2));
    }
  }
  const positions = new Map<string, { x: number; y: number }>();
  for (const n of graph.nodes) {
    const slot = g.node(n.id);
    const own = size(n.id);
    const top = rowTop.get(Math.round(slot.y)) ?? slot.y - slot.height / 2;
    positions.set(n.id, { x: slot.x - own.w / 2, y: top });
    if (n.agents?.length) positions.set(agentsBoxId(n.id), { x: slot.x - size(agentsBoxId(n.id)).w / 2, y: top + own.h + AGENTS_GAP });
  }
  // Each line's route as dagre planned it: the bends between the two boxes (round other boxes, through the gap kept for its label) and the label's
  // place on it. The line is drawn through these points, so its label sits on it.
  const routes = new Map<string, Route>();
  for (const e of graph.edges) {
    const r = g.edge({ v: e.source, w: e.target }) as unknown as { x?: number; y?: number; points?: Point[] } | undefined;
    if (r && typeof r.x === 'number' && typeof r.y === 'number') routes.set(e.id, { points: (r.points ?? []).slice(1, -1), label: { x: r.x, y: r.y } });
  }
  // In portrait a queue's own lines (overflow, time-out, no agents) leave from its side and must clear its agents' box: they run down beside it first.
  if (direction === 'TB') {
    const outCount = new Map<string, number>();
    for (const e of graph.edges) {
      const route = routes.get(e.id);
      const agentsPos = positions.get(agentsBoxId(e.source));
      if (!route || !agentsPos) continue;
      const i = outCount.get(e.source) ?? 0;
      outCount.set(e.source, i + 1);
      const agents = size(agentsBoxId(e.source));
      const queue = positions.get(e.source)!;
      const side = Math.max(agentsPos.x + agents.w, queue.x + size(e.source).w) + 14 + i * 6;
      route.points.unshift({ x: side, y: agentsPos.y + agents.h + 8 });
    }
  }

  // The front door in the middle of its column (landscape) or row (portrait), rather than level with the first of its branches.
  const root = graph.nodes[0];
  if (root && graph.nodes.length > 1) {
    const rootIds = new Set([root.id, agentsBoxId(root.id)]);
    let min = Infinity;
    let max = -Infinity;
    for (const [id, p] of positions) {
      if (rootIds.has(id)) continue;
      const s = size(id);
      min = Math.min(min, direction === 'LR' ? p.y : p.x);
      max = Math.max(max, direction === 'LR' ? p.y + s.h : p.x + s.w);
    }
    const slot = g.node(root.id);
    const shift = (min + max) / 2 - (direction === 'LR' ? slot.y : slot.x);
    if (Number.isFinite(shift)) {
      for (const id of rootIds) {
        const p = positions.get(id);
        if (p) positions.set(id, direction === 'LR' ? { x: p.x, y: p.y + shift } : { x: p.x + shift, y: p.y });
      }
      // its lines were routed from where it was: they are drawn as plain curves instead, with the label in the middle
      for (const e of graph.edges) if (e.source === root.id || e.target === root.id) routes.delete(e.id);
    }
  }
  return { positions, routes };
}

const HIDDEN_HANDLE = { opacity: 0, width: 1, height: 1, minWidth: 0, minHeight: 0, border: 0, background: 'transparent' } as const;

interface BoxData extends Record<string, unknown> {
  content: ReactNode;
  bg: string;
  border: string;
  inPos?: Position;
  outPos?: Position;
  /** A call queue with agents: the arrow down to them leaves from the bottom. */
  down?: boolean;
  /** The agents' box: the arrow from its queue arrives at the top. */
  top?: boolean;
}

/**
 * One box. Its height comes from its text (nothing is cut off or spills out), and the layout is worked out from the measured size afterwards.
 * The handles are invisible: they only say where lines leave and arrive.
 */
function FlowBox({ data }: NodeProps) {
  const d = data as BoxData;
  return (
    <div style={{ width: NODE_WIDTH, boxSizing: 'border-box', background: d.bg, border: `2px solid ${d.border}`, borderRadius: 8, padding: 8, fontSize: 12, lineHeight: '16px', color: '#242424', textAlign: 'center', whiteSpace: 'normal', overflowWrap: 'anywhere' }}>
      {d.inPos && <Handle type="target" id="in" position={d.inPos} style={HIDDEN_HANDLE} isConnectable={false} />}
      {d.top && <Handle type="target" id="top" position={Position.Top} style={HIDDEN_HANDLE} isConnectable={false} />}
      {d.content}
      {d.outPos && <Handle type="source" id="out" position={d.outPos} style={HIDDEN_HANDLE} isConnectable={false} />}
      {d.down && <Handle type="source" id="down" position={Position.Bottom} style={HIDDEN_HANDLE} isConnectable={false} />}
    </div>
  );
}

const NODE_TYPES = { box: FlowBox };

/** A line through every point: straight runs joined by small rounded corners, so it never bulges past a point (the label's point included). */
function smoothPath(pts: Point[]): string {
  let d = `M ${pts[0]!.x},${pts[0]!.y}`;
  for (let i = 1; i < pts.length - 1; i++) {
    const prev = pts[i - 1]!;
    const at = pts[i]!;
    const next = pts[i + 1]!;
    const lenIn = Math.hypot(at.x - prev.x, at.y - prev.y);
    const lenOut = Math.hypot(next.x - at.x, next.y - at.y);
    const r = Math.min(14, lenIn / 2, lenOut / 2);
    if (r < 1) {
      d += ` L ${at.x},${at.y}`;
      continue;
    }
    const a = { x: at.x - ((at.x - prev.x) / lenIn) * r, y: at.y - ((at.y - prev.y) / lenIn) * r };
    const b = { x: at.x + ((next.x - at.x) / lenOut) * r, y: at.y + ((next.y - at.y) / lenOut) * r };
    d += ` L ${a.x},${a.y} Q ${at.x},${at.y} ${b.x},${b.y}`;
  }
  const last = pts[pts.length - 1]!;
  return `${d} L ${last.x},${last.y}`;
}

/** A short step out of (or into) a box in the direction its handle faces, so a line leaves and arrives square to the box. */
const stepFrom = (p: Point, side: Position, by = 14): Point =>
  side === Position.Right ? { x: p.x + by, y: p.y } : side === Position.Left ? { x: p.x - by, y: p.y } : side === Position.Bottom ? { x: p.x, y: p.y + by } : { x: p.x, y: p.y - by };

/**
 * A line with its label ON it. When the layout planned a route (the bends round other boxes and the gap kept for the label), the line is drawn
 * through it and the label sits at its planned place on it; otherwise (the front door's lines, a queue's arrow to its agents) a plain curve, labelled
 * in the middle.
 */
function FlowEdge({ id, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, markerEnd, style, data }: EdgeProps) {
  const d = (data ?? {}) as { text?: string; color?: string; route?: Route };
  let path: string;
  let labelX: number;
  let labelY: number;
  if (d.route) {
    const source = { x: sourceX, y: sourceY };
    const target = { x: targetX, y: targetY };
    path = smoothPath([source, stepFrom(source, sourcePosition), ...d.route.points, stepFrom(target, targetPosition), target]);
    labelX = d.route.label.x;
    labelY = d.route.label.y;
  } else {
    [path, labelX, labelY] = getBezierPath({ sourceX, sourceY, sourcePosition, targetX, targetY, targetPosition });
  }
  return (
    <BaseEdge
      id={id}
      path={path}
      markerEnd={markerEnd}
      style={style}
      label={d.text}
      labelX={labelX}
      labelY={labelY}
      labelStyle={{ fontSize: 11, fontWeight: 600, fill: d.color }}
      labelShowBg
      labelBgStyle={{ fill: '#ffffff', fillOpacity: 1, stroke: d.color, strokeWidth: 0.75 }}
      labelBgPadding={[6, 3]}
      labelBgBorderRadius={4}
    />
  );
}

const EDGE_TYPES = { flow: FlowEdge };

function downloadDataUrl(dataUrl: string, filename: string) {
  const a = document.createElement('a');
  a.href = dataUrl;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
}

/** A browser canvas gets unreliable (or refuses outright) past roughly this many pixels on a side, so the requested pixel ratio is capped to stay under it rather than requested unconditionally. */
const MAX_CAPTURE_DIM = 6000;
const EXPORT_PIXEL_RATIO = 3;

/**
 * Captures the whole diagram (not just what's currently visible/panned-to)
 * as a PNG data URL, sized to fit every node - the same technique xyflow's
 * own "download image" example uses. `pixelRatio` renders at that many
 * device pixels per CSS pixel (html-to-image's own option) - without it,
 * the raster is exactly the on-screen CSS size, which reads fine at a
 * glance but turns to mud the moment a viewer zooms in on the PNG/PDF, since
 * there's no extra pixel data to zoom into.
 *
 * getViewportForBounds's own `padding` argument is a RATIO, not pixels
 * (0.1 means 10% of the frame) - passing a pixel value like 48 there (as an
 * earlier version of this function did) is read as "pad by 4800%", which
 * shrinks the actual content to a sliver in the middle of a mostly-blank
 * frame. The margin here is added once, directly into `width`/`height`
 * before layout, so `getViewportForBounds` gets 0 - no second, mis-scaled
 * padding pass.
 */
async function captureDiagramPng(nodes: Node[]): Promise<{ dataUrl: string; width: number; height: number } | null> {
  if (nodes.length === 0) return null;
  const viewportEl = document.querySelector('.react-flow__viewport') as HTMLElement | null;
  if (!viewportEl) return null;
  const bounds = getNodesBounds(nodes);
  const margin = 48;
  const width = Math.max(400, Math.ceil(bounds.width) + margin * 2);
  const height = Math.max(300, Math.ceil(bounds.height) + margin * 2);
  const viewport = getViewportForBounds(bounds, width, height, 0.1, 2, 0);
  const pixelRatio = Math.max(1, Math.min(EXPORT_PIXEL_RATIO, MAX_CAPTURE_DIM / width, MAX_CAPTURE_DIM / height));
  const capture = toPng(viewportEl, {
    backgroundColor: '#ffffff',
    width,
    height,
    pixelRatio,
    // html-to-image otherwise scans every stylesheet on the page for
    // @font-face rules and fetches each one to embed - with none of this
    // diagram's text actually depending on a custom webfont, that fetch has
    // nothing useful to do and, if any of those requests never settles
    // (blocked by an extension, offline, CORS), the whole export hangs
    // forever with no error - skipping it removes the failure mode entirely.
    skipFonts: true,
    style: { width: `${width}px`, height: `${height}px`, transform: `translate(${viewport.x}px, ${viewport.y}px) scale(${viewport.zoom})` },
  });
  const timeout = new Promise<never>((_, reject) => setTimeout(() => reject(new Error('Rendering the export timed out.')), 20000));
  const dataUrl = await Promise.race([capture, timeout]);
  // width/height here are the diagram's logical (CSS) size, not the PNG's
  // actual raster size (which is pixelRatio times larger) - a PDF page
  // built from these keeps the same physical page size while the image data
  // embedded in it carries the extra resolution, so zooming into the PDF
  // reveals real detail instead of just enlarging blur.
  return { dataUrl, width, height };
}

/** A4 in millimetres, and the margin left round the diagram on the page. */
const A4 = { short: 210, long: 297, margin: 10 };

/**
 * Export-to-PNG/PDF buttons - a child of ReactFlow so useReactFlow can read the laid-out node positions/sizes. The PDF is one A4 page, portrait for
 * the portrait (top to bottom) layout and landscape for the landscape one, with the diagram scaled to fit inside the margins: it prints as it is.
 */
function ExportControls({ filename, direction }: { filename: string; direction: Direction }) {
  const ls = useLocalStyles();
  const { getNodes } = useReactFlow();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const runExport = async (kind: 'png' | 'pdf') => {
    setBusy(true);
    setError(null);
    try {
      const shot = await captureDiagramPng(getNodes());
      if (!shot) return;
      if (kind === 'png') {
        downloadDataUrl(shot.dataUrl, `${filename}.png`);
      } else {
        const portrait = direction === 'TB';
        const pdf = new jsPDF({ orientation: portrait ? 'portrait' : 'landscape', unit: 'mm', format: 'a4' });
        const pageW = portrait ? A4.short : A4.long;
        const pageH = portrait ? A4.long : A4.short;
        const scale = Math.min((pageW - 2 * A4.margin) / shot.width, (pageH - 2 * A4.margin) / shot.height);
        const w = shot.width * scale;
        const h = shot.height * scale;
        pdf.addImage(shot.dataUrl, 'PNG', (pageW - w) / 2, A4.margin, w, h);
        pdf.save(`${filename}.pdf`);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Export failed.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Panel position="top-right">
      <div className={ls.flexColItemsFlexendGap4}>
        <div className={ls.flexGap6}>
          <Tooltip content="Export this diagram as a PNG image" relationship="label">
            <Button size="small" icon={<ArrowDownloadRegular />} disabled={busy} onClick={() => runExport('png')}>
              PNG
            </Button>
          </Tooltip>
          <Tooltip content={`Export this diagram as an A4 ${direction === 'TB' ? 'portrait' : 'landscape'} PDF`} relationship="label">
            <Button size="small" icon={<ArrowDownloadRegular />} disabled={busy} onClick={() => runExport('pdf')}>
              PDF
            </Button>
          </Tooltip>
        </div>
        {error && (
          <Text size={200} style={{ color: tokens.colorPaletteRedForeground1, background: tokens.colorPaletteRedBackground1, border: `1px solid ${tokens.colorPaletteRedBorder1}`, borderRadius: 4, padding: '2px 8px' }}>
            {error}
          </Text>
        )}
      </div>
    </Panel>
  );
}

/** Portrait (top to bottom) / landscape (left to right) layout toggle. */
function DirectionControls({ direction, onChange }: { direction: Direction; onChange: (d: Direction) => void }) {
  const ls = useLocalStyles();
  return (
    <Panel position="top-left">
      <div className={ls.flexGap4}>
        <Tooltip content="Portrait: top to bottom (fits an A4 portrait page)" relationship="label">
          <Button size="small" appearance={direction === 'TB' ? 'primary' : 'secondary'} icon={<ArrowDownRegular />} onClick={() => onChange('TB')} />
        </Tooltip>
        <Tooltip content="Landscape: left to right" relationship="label">
          <Button size="small" appearance={direction === 'LR' ? 'primary' : 'secondary'} icon={<ArrowRightRegular />} onClick={() => onChange('LR')} />
        </Tooltip>
      </div>
    </Panel>
  );
}

/** The boxes and lines, not yet placed: each box is drawn (hidden) first so its real size can be measured. */
function buildElements(graph: CallFlowGraph, direction: Direction, ls: ReturnType<typeof useLocalStyles>): { nodes: Node[]; edges: Edge[] } {
  const inPos = direction === 'LR' ? Position.Left : Position.Top;
  const outPos = direction === 'LR' ? Position.Right : Position.Bottom;
  const nodes: Node[] = [];
  const edges: Edge[] = [];
  for (const n of graph.nodes) {
    const style = KIND_STYLE[n.kind];
    const hasAgents = !!n.agents?.length;
    nodes.push({
      id: n.id,
      type: 'box',
      position: { x: 0, y: 0 },
      style: { visibility: 'hidden' },
      data: {
        bg: style.bg,
        border: style.border,
        inPos,
        // In portrait the agents sit where a queue's other lines would leave from, so those leave from its side instead.
        outPos: hasAgents && direction === 'TB' ? Position.Right : outPos,
        down: hasAgents,
        content: (
          <div>
            <div>
              {style.icon} {n.label}
            </div>
            {n.sublabel && <div className={ls.mt2}>{n.sublabel}</div>}
            {n.details?.map((d, i) => (
              <div key={i} className={ls.detail}>
                {d}
              </div>
            ))}
            {n.badge && <div className={ls.inlineblockMt4ColoredFilledPad1px7}>{n.badge}</div>}
          </div>
        ),
      } satisfies BoxData,
    });
    if (hasAgents) {
      const agents = n.agents!;
      nodes.push({
        id: agentsBoxId(n.id),
        type: 'box',
        position: { x: 0, y: 0 },
        style: { visibility: 'hidden' },
        data: {
          bg: KIND_STYLE.person.bg,
          border: KIND_STYLE.person.border,
          top: true,
          content: (
            <div>
              <div className={ls.agentsTitle}>
                {KIND_STYLE.person.icon} Agents ({agents.length})
              </div>
              {agents.map((a, i) => (
                <div key={i} className={ls.detail}>
                  {a}
                </div>
              ))}
            </div>
          ),
        } satisfies BoxData,
      });
      edges.push({
        id: `agents:${n.id}`,
        source: n.id,
        sourceHandle: 'down',
        target: agentsBoxId(n.id),
        targetHandle: 'top',
        type: 'flow',
        hidden: true,
        data: { color: AGENTS_COLOR },
        style: { stroke: AGENTS_COLOR, strokeWidth: 1.5 },
        markerEnd: { type: MarkerType.ArrowClosed, color: AGENTS_COLOR },
      });
    }
  }
  for (const e of graph.edges) {
    const bs = BRANCH_STYLE[e.branch];
    edges.push({
      id: e.id,
      source: e.source,
      sourceHandle: 'out',
      target: e.target,
      targetHandle: 'in',
      type: 'flow',
      hidden: true,
      data: { text: edgeLabelText(e), color: bs.color },
      style: { stroke: bs.color, strokeWidth: 1.5, strokeDasharray: bs.dash },
      markerEnd: { type: MarkerType.ArrowClosed, color: bs.color },
    });
  }
  return { nodes, edges };
}

/**
 * Draws the boxes hidden, measures them once xyflow has, then places them (arrange) and shows them. Placing from the real sizes is what keeps
 * every word inside its box and no box on top of another: a size guessed from the length of the text was wrong as often as not.
 */
function FlowCanvas({ graph, direction, onDirection, filename }: { graph: CallFlowGraph; direction: Direction; onDirection: (d: Direction) => void; filename: string }) {
  const ls = useLocalStyles();
  const base = useMemo(() => buildElements(graph, direction, ls), [graph, direction, ls]);
  const [nodes, setNodes] = useState<Node[]>(base.nodes);
  const [edges, setEdges] = useState<Edge[]>(base.edges);
  const [placedFor, setPlacedFor] = useState<typeof base | null>(null);
  const initialized = useNodesInitialized();
  const { getInternalNode, fitView } = useReactFlow();

  useEffect(() => {
    setNodes(base.nodes);
    setEdges(base.edges);
    setPlacedFor(null);
  }, [base]);

  useEffect(() => {
    if (!initialized || placedFor === base) return;
    const size = (id: string): Size => {
      const m = getInternalNode(id)?.measured;
      return { w: m?.width ?? NODE_WIDTH, h: m?.height ?? NODE_HEIGHT };
    };
    const { positions, routes } = arrange(graph, direction, size);
    setNodes((ns) => ns.map((n) => ({ ...n, position: positions.get(n.id) ?? n.position, style: { ...n.style, visibility: 'visible' } })));
    setEdges((es) => es.map((e) => ({ ...e, hidden: false, data: { ...e.data, route: routes.get(e.id) } })));
    setPlacedFor(base);
    requestAnimationFrame(() => void fitView({ padding: 0.06 }));
  }, [initialized, placedFor, base, graph, direction, getInternalNode, fitView]);

  return (
    <ReactFlow
      nodes={nodes}
      edges={edges}
      nodeTypes={NODE_TYPES}
      edgeTypes={EDGE_TYPES}
      onNodesChange={(changes) => setNodes((ns) => applyNodeChanges(changes, ns))}
      fitView
      minZoom={0.05}
      nodesDraggable={false}
      nodesConnectable={false}
      edgesFocusable={false}
      proOptions={{ hideAttribution: true }}
    >
      <Background />
      <Controls showInteractive={false} />
      <MiniMap pannable zoomable className={ls.w120H80} nodeColor={(n) => String((n.data as BoxData).border ?? '#999')} />
      <DirectionControls direction={direction} onChange={onDirection} />
      <ExportControls filename={filename} direction={direction} />
    </ReactFlow>
  );
}

/**
 * Renders a CallFlowGraph (packages/shared/src/call-flow-graph.ts) with
 * @xyflow/react - dagre auto-layout since the graph can cycle (a Directory
 * AA's DTMF0 pointing back to the Main Number AA it came from), so a
 * hand-rolled tree layout won't fit every real Auto Attendant/Call Queue
 * chain. Portrait (top to bottom) by default: it fits an A4 page.
 */
export function CallFlowDiagram({ graph: drawn, exportFilename }: { graph: CallFlowGraph; exportFilename?: string }) {
  const ls = useLocalStyles();
  const [direction, setDirection] = useState<Direction>('TB');
  // A "Shared voicemail (group)" box carries the group's Object ID; show the group's name when this customer's group list has it.
  const { activeTenantId } = useAuth();
  const groupNames = useGroupNames(activeTenantId, drawn.nodes.filter((n) => n.id.startsWith('group:')).map((n) => n.id.slice('group:'.length)));
  const graph = useMemo(
    () => ({ ...drawn, nodes: drawn.nodes.map((n) => (n.id.startsWith('group:') && groupNames[n.id.slice('group:'.length).toLowerCase()] ? { ...n, sublabel: groupNames[n.id.slice('group:'.length).toLowerCase()] } : n)) }),
    [drawn, groupNames],
  );

  if (graph.nodes.length === 0) {
    return (
      <MutedText size={200}>
        Nothing to draw yet.
      </MutedText>
    );
  }

  return (
    <div className={ls.gridGap8}>
      {/* A diagram is a page of paper: it stays light (and its text dark) in the dark theme, like the PNG and PDF exports. */}
      <div style={{ height: '75vh', minHeight: 480, border: `1px solid ${tokens.colorNeutralStroke2}`, borderRadius: 8, background: '#ffffff', color: '#242424' }}>
        <ReactFlowProvider>
          <FlowCanvas graph={graph} direction={direction} onDirection={setDirection} filename={exportFilename ?? 'call-flow'} />
        </ReactFlowProvider>
      </div>
      <div className={ls.flexWrapItemsCenterGap14}>
        {Object.entries(BRANCH_STYLE).map(([key, bs]) => (
          <div key={key} className={ls.flexItemsCenterGap4}>
            <span style={{ display: 'inline-block', width: 18, height: 0, borderTop: `2px ${bs.dash ? 'dashed' : 'solid'} ${bs.color}` }} />
            <Text size={200}>{bs.label}</Text>
          </div>
        ))}
        <div className={ls.flexItemsCenterGap4}>
          <span style={{ display: 'inline-block', width: 18, height: 0, borderTop: `2px solid ${AGENTS_COLOR}` }} />
          <Text size={200}>Offered to the queue&apos;s agents</Text>
        </div>
      </div>
    </div>
  );
}
