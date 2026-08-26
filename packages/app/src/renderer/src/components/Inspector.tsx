/**
 * The properties panel: the selected node's params, or the document's own.
 *
 * The form is generated from `manifest.params`, a JSON Schema subset, and
 * never hand-written per node type (ARCHITECTURE §5.2). That is the whole
 * reason a plugin author gets a working editor for free — `ParamField` reads
 * the schema, so a node type this app has never heard of still renders.
 *
 * The unknown-node branch is the important one. A node whose type is not
 * installed still shows its id and type and says plainly that its config is
 * preserved and will save intact — because the document format keeps unknown
 * entries verbatim (ADR-0004), and a user opening a colleague's workflow needs
 * to know that missing a plugin has not silently eaten their data.
 */
import { driftedNodeIds } from '../drift';
import { useStore } from '../store';
import { ParamField } from './ParamField';

export function Inspector() {
  const selected = useStore((s) => s.nodes.filter((n) => n.selected));
  const manifestByType = useStore((s) => s.manifestByType);
  const updateParam = useStore((s) => s.updateParam);
  const meta = useStore((s) => s.meta);
  const setMeta = useStore((s) => s.setMeta);
  const docIssues = useStore((s) => s.docIssues);
  const rejectedIssues = useStore((s) => s.run.rejectedIssues);
  const nodes = useStore((s) => s.nodes);
  const schemaHashes = useStore((s) => s.schemaHashes);
  const drifted = driftedNodeIds(nodes, schemaHashes);

  if (selected.length === 1) {
    const node = selected[0];
    const manifest = manifestByType[node.data.typeId];
    return (
      <aside className="inspector">
        <div className="panel-title">Properties</div>
        {manifest ? (
          <>
            <div className="insp-node-label">{manifest.label}</div>
            <div className="insp-node-meta mono">
              {manifest.type} v{manifest.version} · {node.id}
            </div>
            <div className="insp-node-desc">{manifest.description}</div>
            {drifted.has(node.id) && (
              // Detected, not absorbed (ADR-0009 §5). The params below were
              // filled in against the older schema, so they are shown exactly
              // as saved and nothing is re-mapped for the user.
              <div className="issue issue-warning">
                The tool this node calls has changed its schema since the node was added.
                Its parameters are shown as saved — check them against the fields below,
                and re-save to accept the new schema.
              </div>
            )}
            <div className="insp-divider" />
            {Object.entries(manifest.params.properties ?? {}).map(([key, prop]) => (
              <ParamField
                key={key}
                name={key}
                schema={prop}
                value={node.data.config[key]}
                onChange={(value) => updateParam(node.id, key, value)}
              />
            ))}
            {Object.keys(manifest.params.properties ?? {}).length === 0 && (
              <div className="panel-hint">This node has no parameters.</div>
            )}
          </>
        ) : (
          <>
            <div className="insp-node-label">Unknown node</div>
            <div className="insp-node-meta mono">{node.data.typeId} · {node.id}</div>
            <div className="panel-hint">
              This node's type is not installed. Its configuration is preserved and will save intact.
            </div>
          </>
        )}
      </aside>
    );
  }

  if (selected.length > 1) {
    return (
      <aside className="inspector">
        <div className="panel-title">Properties</div>
        <div className="panel-hint">{selected.length} nodes selected.</div>
      </aside>
    );
  }

  return (
    <aside className="inspector">
      <div className="panel-title">Workflow</div>
      <div className="field">
        <label className="field-label">Name</label>
        <input className="field-input" value={meta.name} onChange={(e) => setMeta({ name: e.target.value })} />
      </div>
      <div className="field">
        <label className="field-label">Description</label>
        <textarea
          className="field-input field-textarea"
          rows={3}
          value={meta.description ?? ''}
          onChange={(e) => setMeta({ description: e.target.value })}
        />
      </div>
      {docIssues.length > 0 && (
        <>
          <div className="insp-divider" />
          <div className="panel-subtitle">Document notes</div>
          {docIssues.map((issue, i) => (
            <div key={i} className={`issue issue-${issue.severity}`}>{issue.message}</div>
          ))}
        </>
      )}
      {rejectedIssues.length > 0 && (
        <>
          <div className="insp-divider" />
          <div className="panel-subtitle">Run validation</div>
          {rejectedIssues.map((issue, i) => (
            <div key={i} className={`issue issue-${issue.severity}`}>{issue.message}</div>
          ))}
        </>
      )}
      <div className="insp-divider" />
      <div className="panel-hint">Select a node to edit its parameters.</div>
    </aside>
  );
}
