/**
 * The node palette, grouped by the category each manifest declares.
 *
 * The list is built from `store.manifests` — what the engine actually
 * registered on this machine — not from a static catalogue. That is what makes
 * plugin and MCP nodes appear here without this file knowing they exist
 * (ARCHITECTURE §5.2, §9.3): the palette is a view of the registry, so a
 * connected MCP server's tools show up the moment the engine reports them.
 *
 * Two ways to place a node, for two habits: drag for position, double-click
 * for speed. The double-click path resolves the viewport centre through
 * `screenToFlowPosition` so a node lands where the user is looking rather than
 * at a fixed graph coordinate they may have panned far away from.
 */
import { useMemo } from 'react';
import { useReactFlow } from '@xyflow/react';
import { useStore } from '../store';
import type { NodeManifest } from '@archspace/node-sdk';

export function NodeLibrary() {
  const manifests = useStore((s) => s.manifests);
  const addNode = useStore((s) => s.addNode);
  const flow = useReactFlow();

  const groups = useMemo(() => {
    const byCategory = new Map<string, NodeManifest[]>();
    for (const m of manifests) {
      byCategory.set(m.category, [...(byCategory.get(m.category) ?? []), m]);
    }
    return [...byCategory.entries()];
  }, [manifests]);

  const addAtCenter = (typeId: string) => {
    const wrapper = document.querySelector('.react-flow');
    const rect = wrapper?.getBoundingClientRect();
    const center = rect
      ? flow.screenToFlowPosition({ x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 })
      : { x: 200, y: 200 };
    addNode(typeId, center);
  };

  return (
    <aside className="library">
      <div className="panel-title">Node Library</div>
      {manifests.length === 0 && <div className="panel-hint">Waiting for the engine…</div>}
      {groups.map(([category, items]) => (
        <section key={category} className="lib-group">
          <div className="lib-category">{category}</div>
          {items.map((m) => (
            <div
              key={m.type}
              className="lib-item"
              draggable
              title={`${m.description}\n(${m.type} v${m.version})`}
              onDragStart={(e) => {
                e.dataTransfer.setData('application/archspace-node', m.type);
                e.dataTransfer.effectAllowed = 'copy';
              }}
              onDoubleClick={() => addAtCenter(m.type)}
            >
              <div className="lib-item-name">{m.label}</div>
              <div className="lib-item-type">{m.type}</div>
            </div>
          ))}
        </section>
      ))}
      <div className="lib-footer">Drag onto the canvas, or double-click to place.</div>
    </aside>
  );
}
