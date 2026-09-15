import { useMemo, useState } from 'react';
import { Background, Controls, getNodesBounds, getViewportForBounds, MarkerType, MiniMap, type Node, Panel, ReactFlow, ReactFlowProvider, useReactFlow } from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import dagre from 'dagre';
import { toPng } from 'html-to-image';
import { jsPDF } from 'jspdf';
import { Button, Text, Tooltip } from '@fluentui/react-components';
import { ArrowDownloadRegular, ArrowDownRegular, ArrowRightRegular } from '@fluentui/react-icons';
import type { CallFlowBranch, CallFlowGraph, CallFlowNode, CallFlowNodeKind } from '@tvmf/shared';

type Direction = 'LR' | 'TB';

const NODE_WIDTH = 210;
const NODE_HEIGHT = 52;
const GROUP_PAD_X = 24;
const GROUP_PAD_TOP = 30;
const GROUP_PAD_BOTTOM = 14;

const KIND_STYLE: Record<CallFlowNodeKind, { bg: string; border: string; icon: string; label: string }> = {
  auto_attendant: { bg: '#EEF2FF', border: '#4657D2', icon: '☎️', label: 'Auto attendant' },
  call_queue: { bg: '#F3E8FF', border: '#7C3AED', icon: '👥', label: 'Call queue' },
  person: { bg: '#ECFDF5', border: '#059669', icon: '🧑', label: 'Person' },
  external_number: { bg: '#F3F4F6', border: '#6B7280', icon: '📞', label: 'External number' },
  voicemail: { bg: '#FFF7ED', border: '#EA580C', icon: '📼', label: 'Voicemail' },
  shared_voicemail: { bg: '#FFF7ED', border: '#EA580C', icon: '📼', label: 'Shared voicemail' },
  operator: { bg: '#ECFEFF', border: '#0891B2', icon: '🎧', label: 'Operator' },
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
  agent: { color: '#059669', label: 'Agent' },
};

/** A greeting sublabel wraps over several lines, and a badge chip adds its own row - both render taller than NODE_HEIGHT, so dagre needs that real height or it packs the next node in the same column right on top of it. */
function estimateNodeHeight(n: CallFlowNode): number {
  let height = NODE_HEIGHT;
  if (n.sublabel) {
    const charsPerLine = 32;
    const lines = Math.max(1, Math.ceil(n.sublabel.length / charsPerLine));
    height = Math.max(height, 30 + lines * 14 + 12);
  }
  if (n.badge) height += 18;
  return height;
}

/** dagre only computes positions - it's not rendered itself, xyflow does the actual drawing. */
function layout(graph: CallFlowGraph, direction: Direction) {
  const g = new dagre.graphlib.Graph();
  g.setGraph({ rankdir: direction, nodesep: 40, ranksep: 90 });
  g.setDefaultEdgeLabel(() => ({}));
  for (const n of graph.nodes) g.setNode(n.id, { width: NODE_WIDTH, height: estimateNodeHeight(n) });
  for (const e of graph.edges) g.setEdge(e.source, e.target);
  dagre.layout(g);
  return new Map(graph.nodes.map((n) => [n.id, g.node(n.id)]));
}

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
  const dataUrl = await toPng(viewportEl, {
    backgroundColor: '#ffffff',
    width,
    height,
    pixelRatio,
    style: { width: `${width}px`, height: `${height}px`, transform: `translate(${viewport.x}px, ${viewport.y}px) scale(${viewport.zoom})` },
  });
  // width/height here are the diagram's logical (CSS) size, not the PNG's
  // actual raster size (which is pixelRatio times larger) - a PDF page
  // built from these keeps the same physical page size while the image data
  // embedded in it carries the extra resolution, so zooming into the PDF
  // reveals real detail instead of just enlarging blur.
  return { dataUrl, width, height };
}

/** Export-to-PNG/PDF buttons - a child of ReactFlow so useReactFlow can read the laid-out node positions/sizes. */
function ExportControls({ filename }: { filename: string }) {
  const { getNodes } = useReactFlow();
  const [busy, setBusy] = useState(false);

  const runExport = async (kind: 'png' | 'pdf') => {
    setBusy(true);
    try {
      const shot = await captureDiagramPng(getNodes());
      if (!shot) return;
      if (kind === 'png') {
        downloadDataUrl(shot.dataUrl, `${filename}.png`);
      } else {
        const pdf = new jsPDF({ orientation: shot.width >= shot.height ? 'landscape' : 'portrait', unit: 'px', format: [shot.width, shot.height] });
        pdf.addImage(shot.dataUrl, 'PNG', 0, 0, shot.width, shot.height);
        pdf.save(`${filename}.pdf`);
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <Panel position="top-right">
      <div style={{ display: 'flex', gap: 6 }}>
        <Tooltip content="Export this diagram as a PNG image" relationship="label">
          <Button size="small" icon={<ArrowDownloadRegular />} disabled={busy} onClick={() => runExport('png')}>
            PNG
          </Button>
        </Tooltip>
        <Tooltip content="Export this diagram as a PDF" relationship="label">
          <Button size="small" icon={<ArrowDownloadRegular />} disabled={busy} onClick={() => runExport('pdf')}>
            PDF
          </Button>
        </Tooltip>
      </div>
    </Panel>
  );
}

/** Left-to-right / top-to-bottom layout toggle. */
function DirectionControls({ direction, onChange }: { direction: Direction; onChange: (d: Direction) => void }) {
  return (
    <Panel position="top-left">
      <div style={{ display: 'flex', gap: 4 }}>
        <Tooltip content="Lay out left to right" relationship="label">
          <Button size="small" appearance={direction === 'LR' ? 'primary' : 'secondary'} icon={<ArrowRightRegular />} onClick={() => onChange('LR')} />
        </Tooltip>
        <Tooltip content="Lay out top to bottom" relationship="label">
          <Button size="small" appearance={direction === 'TB' ? 'primary' : 'secondary'} icon={<ArrowDownRegular />} onClick={() => onChange('TB')} />
        </Tooltip>
      </div>
    </Panel>
  );
}

/**
 * Renders a CallFlowGraph (packages/shared/src/call-flow-graph.ts) with
 * @xyflow/react - dagre auto-layout since the graph can cycle (a Directory
 * AA's DTMF0 pointing back to the Main Number AA it came from), so a
 * hand-rolled tree layout won't fit every real Auto Attendant/Call Queue
 * chain.
 */
export function CallFlowDiagram({ graph, exportFilename }: { graph: CallFlowGraph; exportFilename?: string }) {
  const [direction, setDirection] = useState<Direction>('LR');

  const { nodes, edges } = useMemo(() => {
    const positions = layout(graph, direction);

    const nodes = graph.nodes.map((n) => {
      const style = KIND_STYLE[n.kind];
      const pos = positions.get(n.id) ?? { x: 0, y: 0 };
      const height = estimateNodeHeight(n);
      return {
        id: n.id,
        position: { x: pos.x - NODE_WIDTH / 2, y: pos.y - height / 2 },
        width: NODE_WIDTH,
        height,
        data: {
          label: (
            <div>
              <div>
                {style.icon} {n.label}
              </div>
              {n.sublabel && <div style={{ fontSize: 10, opacity: 0.7, marginTop: 2 }}>{n.sublabel}</div>}
              {n.badge && (
                <div
                  style={{
                    display: 'inline-block',
                    marginTop: 4,
                    fontSize: 9,
                    fontWeight: 600,
                    letterSpacing: 0.3,
                    textTransform: 'uppercase',
                    color: '#166534',
                    background: '#DCFCE7',
                    border: '1px solid #86EFAC',
                    borderRadius: 999,
                    padding: '1px 7px',
                  }}
                >
                  {n.badge}
                </div>
              )}
            </div>
          ),
        },
        style: {
          background: style.bg,
          border: `2px solid ${style.border}`,
          borderRadius: 8,
          padding: 8,
          width: NODE_WIDTH,
          fontSize: 12,
        },
      };
    });

    // A dashed frame behind every Call Queue's agent cluster (agent -> queue
    // edges), so "28 agents" reads as one labeled group instead of a loose
    // pile of boxes that happens to be near the queue.
    const agentSourcesByTarget = new Map<string, string[]>();
    for (const e of graph.edges) {
      if (e.branch !== 'agent') continue;
      const arr = agentSourcesByTarget.get(e.target) ?? [];
      arr.push(e.source);
      agentSourcesByTarget.set(e.target, arr);
    }
    const groupNodes = [...agentSourcesByTarget.entries()].flatMap(([targetId, agentIds]) => {
      const rects = agentIds.map((id) => positions.get(id)).filter((p): p is NonNullable<typeof p> => !!p);
      if (rects.length === 0) return [];
      const minX = Math.min(...rects.map((p) => p.x - NODE_WIDTH / 2)) - GROUP_PAD_X;
      const maxX = Math.max(...rects.map((p) => p.x + NODE_WIDTH / 2)) + GROUP_PAD_X;
      const minY = Math.min(...rects.map((p) => p.y - NODE_HEIGHT / 2)) - GROUP_PAD_TOP;
      const maxY = Math.max(...rects.map((p) => p.y + NODE_HEIGHT / 2)) + GROUP_PAD_BOTTOM;
      return [
        {
          id: `agent-group:${targetId}`,
          position: { x: minX, y: minY },
          width: maxX - minX,
          height: maxY - minY,
          zIndex: -1,
          draggable: false,
          selectable: false,
          connectable: false,
          data: {
            label: (
              <div style={{ position: 'absolute', top: 7, left: 12, fontSize: 10, fontWeight: 700, color: '#059669', letterSpacing: 0.4, textTransform: 'uppercase' as const }}>
                Agents ({agentIds.length})
              </div>
            ),
          },
          style: {
            width: maxX - minX,
            height: maxY - minY,
            background: 'rgba(5, 150, 105, 0.05)',
            border: '1.5px dashed #059669',
            borderRadius: 12,
            padding: 0,
          },
        },
      ];
    });

    const edges = graph.edges.map((e) => {
      const bs = BRANCH_STYLE[e.branch];
      return {
        id: e.id,
        source: e.source,
        target: e.target,
        label: e.branchLabel ? `${e.label} · ${e.branchLabel}` : e.label,
        style: { stroke: bs.color, strokeWidth: 1.5, strokeDasharray: bs.dash },
        labelStyle: { fontSize: 10, fill: bs.color },
        labelBgStyle: { fillOpacity: 0.85 },
        markerEnd: { type: MarkerType.ArrowClosed, color: bs.color },
      };
    });
    return { nodes: [...groupNodes, ...nodes], edges };
  }, [graph, direction]);

  if (graph.nodes.length === 0) {
    return (
      <Text size={200} style={{ color: '#616161' }}>
        Nothing to draw yet.
      </Text>
    );
  }

  return (
    <div style={{ display: 'grid', gap: 8 }}>
      <div style={{ height: '75vh', minHeight: 480, border: '1px solid #E1E1E1', borderRadius: 8 }}>
        <ReactFlowProvider>
          <ReactFlow
            nodes={nodes}
            edges={edges}
            fitView
            minZoom={0.05}
            nodesDraggable={false}
            nodesConnectable={false}
            edgesFocusable={false}
            proOptions={{ hideAttribution: true }}
          >
            <Background />
            <Controls showInteractive={false} />
            <MiniMap pannable zoomable style={{ width: 120, height: 80 }} />
            <DirectionControls direction={direction} onChange={setDirection} />
            <ExportControls filename={exportFilename ?? 'call-flow'} />
          </ReactFlow>
        </ReactFlowProvider>
      </div>
      <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', alignItems: 'center' }}>
        {Object.entries(BRANCH_STYLE).map(([key, bs]) => (
          <div key={key} style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
            <span style={{ display: 'inline-block', width: 18, height: 0, borderTop: `2px ${bs.dash ? 'dashed' : 'solid'} ${bs.color}` }} />
            <Text size={200}>{bs.label}</Text>
          </div>
        ))}
      </div>
    </div>
  );
}
