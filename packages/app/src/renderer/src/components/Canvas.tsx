/**
 * The graph surface: React Flow wired to the store (ADR-0003).
 *
 * This component owns interaction, not truth. Nodes, edges, connection rules
 * and deletion policy all live in the store, so the canvas passes handlers
 * straight through — which is what lets the same graph be manipulated by the
 * menu, the keyboard and a drop from the palette without three code paths.
 *
 * `onBeforeDelete` is wired only to push an undo checkpoint: React Flow is
 * about to mutate the graph, and the snapshot has to be taken before it does,
 * not after. It is a hook rather than a guard — it never refuses a deletion.
 * The `fitView` on `filePath` change is the one piece of genuinely view-only
 * state here: a newly opened document should be framed, and nothing else knows
 * when that happened.
 */
import { useCallback, useEffect, useMemo } from 'react';
import {
  Background,
  BackgroundVariant,
  Controls,
  MiniMap,
  ReactFlow,
  useReactFlow,
  type Connection,
  type OnBeforeDelete,
} from '@xyflow/react';
import { useStore, type AppEdge, type AppNode } from '../store';
import { WorkflowNode } from './WorkflowNode';

const nodeTypes = { archnode: WorkflowNode };

export function Canvas() {
  const nodes = useStore((s) => s.nodes);
  const edges = useStore((s) => s.edges);
  const onNodesChange = useStore((s) => s.onNodesChange);
  const onEdgesChange = useStore((s) => s.onEdgesChange);
  const connect = useStore((s) => s.connect);
  const addNode = useStore((s) => s.addNode);
  const beforeDelete = useStore((s) => s.beforeDelete);
  const pushHistory = useStore((s) => s.pushHistory);
  const setInspected = useStore((s) => s.setInspected);
  const filePath = useStore((s) => s.filePath);
  const flow = useReactFlow();

  // Re-frame the graph whenever a different document is loaded.
  useEffect(() => {
    const raf = requestAnimationFrame(() => {
      void flow.fitView({ padding: 0.25, maxZoom: 1 });
    });
    return () => cancelAnimationFrame(raf);
  }, [filePath, flow]);

  const onConnect = useCallback((conn: Connection) => connect(conn), [connect]);

  const onDrop = useCallback(
    (e: React.DragEvent) => {
      const typeId = e.dataTransfer.getData('application/archspace-node');
      if (!typeId) return;
      e.preventDefault();
      addNode(typeId, flow.screenToFlowPosition({ x: e.clientX, y: e.clientY }));
    },
    [addNode, flow],
  );

  const onBeforeDelete: OnBeforeDelete<AppNode, AppEdge> = useCallback(
    async (args) => {
      beforeDelete();
      return args;
    },
    [beforeDelete],
  );

  const defaultEdgeOptions = useMemo(() => ({ type: 'default' as const }), []);

  return (
    <div className="canvas-wrap">
      <ReactFlow<AppNode, AppEdge>
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onConnect={onConnect}
        onBeforeDelete={onBeforeDelete}
        onNodeDragStart={() => pushHistory()}
        onSelectionDragStart={() => pushHistory()}
        onNodeClick={(_e, node) => setInspected(node.id)}
        onPaneClick={() => setInspected(null)}
        onDrop={onDrop}
        onDragOver={(e) => {
          e.preventDefault();
          e.dataTransfer.dropEffect = 'copy';
        }}
        deleteKeyCode={['Backspace', 'Delete']}
        multiSelectionKeyCode={['Meta', 'Control']}
        selectionKeyCode="Shift"
        fitView
        fitViewOptions={{ padding: 0.25, maxZoom: 1 }}
        minZoom={0.15}
        maxZoom={2.5}
        defaultEdgeOptions={defaultEdgeOptions}
        proOptions={{ hideAttribution: false }}
      >
        <Background id="fine" variant={BackgroundVariant.Lines} gap={24} color="var(--grid-fine)" />
        <Background id="coarse" variant={BackgroundVariant.Lines} gap={120} color="var(--grid-coarse)" />
        <Controls position="bottom-left" showInteractive={false} />
        <MiniMap
          position="bottom-right"
          pannable
          zoomable
          bgColor="var(--bg1)"
          maskColor="rgba(10, 13, 17, 0.72)"
          nodeColor="var(--bg3)"
          nodeStrokeColor="var(--line-strong)"
        />
      </ReactFlow>
    </div>
  );
}
