import { useMemo, useState } from 'react';
import { Background, Controls, getNodesBounds, getViewportForBounds, MarkerType, MiniMap, type Node, Panel, ReactFlow, ReactFlowProvider, useReactFlow } from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import dagre from 'dagre';
import { toPng } from 'html-to-image';
import { jsPDF } from 'jspdf';
import { Button, Text, Tooltip } from '@fluentui/react-components';
import { ArrowDownloadRegular } from '@fluentui/react-icons';
import type { CallFlowBranch, CallFlowGraph, CallFlowNode, CallFlowNodeKind } from '@tvmf/shared';

const NODE_WIDTH = 210;
const NODE_HEIGHT = 52;

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
function layout(graph: CallFlowGraph) {
  const g = new dagre.graphlib.Graph();
  g.setGraph({ rankdir: 'LR', nodesep: 40, ranksep: 90 });
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

/** Captures the whole diagram (not just what's currently visible/panned-to) as a PNG data URL, sized to fit every node - the same technique xyflow's own "download image" example uses. */
async function captureDiagramPng(nodes: Node[]): Promise<{ dataUrl: string; width: number; height: number } | null> {
  if (nodes.length === 0) return null;
  const viewportEl = document.querySelector('.react-flow__viewport') as HTMLElement | null;
  if (!viewportEl) return null;
  const bounds = getNodesBounds(nodes);
  const padding = 48;
  const width = Math.max(400, Math.ceil(bounds.width) + padding * 2);
  const height = Math.max(300, Math.ceil(bounds.height) + padding * 2);
  const viewport = getViewportForBounds(bounds, width, height, 0.1, 2, padding);
  const dataUrl = await toPng(viewportEl, {
    backgroundColor: '#ffffff',
    width,
    height,
    style: { width: `${width}px`, height: `${height}px`, transform: `translate(${viewport.x}px, ${viewport.y}px) scale(${viewport.zoom})` },
  });
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

/**
 * Renders a CallFlowGraph (packages/shared/src/call-flow-graph.ts) with
 * @xyflow/react - dagre auto-layout since the graph can cycle (a Directory
 * AA's DTMF0 pointing back to the Main Number AA it came from), so a
 * hand-rolled tree layout won't fit every real Auto Attendant/Call Queue
 * chain.
 */
export function CallFlowDiagram({ graph, exportFilename }: { graph: CallFlowGraph; exportFilename?: string }) {
  const { nodes, edges } = useMemo(() => {
    const positions = layout(graph);
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
    return { nodes, edges };
  }, [graph]);

  if (graph.nodes.length === 0) {
    return (
      <Text size={200} style={{ color: '#616161' }}>
        Nothing to draw yet.
      </Text>
    );
  }

  return (
    <div style={{ display: 'grid', gap: 8 }}>
      <div style={{ height: 560, border: '1px solid #E1E1E1', borderRadius: 8 }}>
        <ReactFlowProvider>
          <ReactFlow nodes={nodes} edges={edges} fitView nodesDraggable={false} nodesConnectable={false} edgesFocusable={false} proOptions={{ hideAttribution: true }}>
            <Background />
            <Controls showInteractive={false} />
            <MiniMap pannable zoomable style={{ width: 120, height: 80 }} />
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
