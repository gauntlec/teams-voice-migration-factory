import { useMemo } from 'react';
import { Background, Controls, MarkerType, MiniMap, ReactFlow, ReactFlowProvider } from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import dagre from 'dagre';
import { Text } from '@fluentui/react-components';
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

/** A greeting sublabel wraps over several lines, so a node showing one renders taller than NODE_HEIGHT - dagre needs that real height or it packs the next node in the same column right on top of it. */
function estimateNodeHeight(n: CallFlowNode): number {
  if (!n.sublabel) return NODE_HEIGHT;
  const charsPerLine = 32;
  const lines = Math.max(1, Math.ceil(n.sublabel.length / charsPerLine));
  return Math.max(NODE_HEIGHT, 30 + lines * 14 + 12);
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

/**
 * Renders a CallFlowGraph (packages/shared/src/call-flow-graph.ts) with
 * @xyflow/react - dagre auto-layout since the graph can cycle (a Directory
 * AA's DTMF0 pointing back to the Main Number AA it came from), so a
 * hand-rolled tree layout won't fit every real Auto Attendant/Call Queue
 * chain.
 */
export function CallFlowDiagram({ graph }: { graph: CallFlowGraph }) {
  const { nodes, edges } = useMemo(() => {
    const positions = layout(graph);
    const nodes = graph.nodes.map((n) => {
      const style = KIND_STYLE[n.kind];
      const pos = positions.get(n.id) ?? { x: 0, y: 0 };
      return {
        id: n.id,
        position: { x: pos.x - NODE_WIDTH / 2, y: pos.y - estimateNodeHeight(n) / 2 },
        data: {
          label: (
            <div>
              <div>
                {style.icon} {n.label}
              </div>
              {n.sublabel && <div style={{ fontSize: 10, opacity: 0.7, marginTop: 2 }}>{n.sublabel}</div>}
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
