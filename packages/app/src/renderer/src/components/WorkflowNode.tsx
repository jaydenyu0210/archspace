import { memo } from 'react';
import { Handle, Position, type NodeProps } from '@xyflow/react';
import { isNodeDrifted } from '../drift';
import { useStore, type AppNode } from '../store';
import { portColorVar } from '../ports';
import { resolvePromotions } from '@archspace/node-sdk/promotion';

/**
 * The canvas node — drawn like an architectural title block: status stripe,
 * caps label, mono type id, labeled port rows.
 */
export const WorkflowNode = memo(function WorkflowNode({ id, data, selected }: NodeProps<AppNode>) {
  const manifest = useStore((s) => s.manifestByType[data.typeId]);
  const status = useStore((s) => s.run.nodeStatus[id]);
  // The whole map rather than one lookup, because `isNodeDrifted` is the one
  // authority on what drift means (drift.ts) and a second inline comparison
  // here is exactly how two answers to the same question start to disagree.
  const schemaHashes = useStore((s) => s.schemaHashes);
  const driftedNode = isNodeDrifted({ id, data }, schemaHashes);

  if (!manifest) {
    // Placeholder behavior (§4): unknown types render, never destroy data.
    return (
      <div className={`node node-placeholder${selected ? ' selected' : ''}`}>
        <div className="node-head">
          <span className="node-label">Unknown node</span>
        </div>
        <div className="node-typeid">{data.typeId}</div>
        <div className="node-placeholder-note">Type not installed — run blocked, data preserved.</div>
      </div>
    );
  }

  // Derived AFTER the early return, so an uninstalled type never reaches it —
  // a placeholder node has no manifest to resolve promotions against, and
  // ADR-0017 decision 10 says promotion validation is suppressed there for the
  // same reason port validation already is.
  const { inputs: effectiveInputs, promotedIds } = resolvePromotions(manifest, data.promoted);

  const phase = status?.phase;
  const statusText =
    phase === 'complete' && status?.cached ? 'complete · cached'
    : phase === 'running' && status?.retrying ? `retrying (${status.attempt})`
    : phase === 'skipped' ? `skipped · ${status?.skipReason ?? ''}`
    : phase ?? '';

  return (
    <div className={`node${selected ? ' selected' : ''}${phase ? ` status-${phase}` : ''}`}>
      <div className="node-stripe" />
      <div className="node-head">
        <span className="node-label">{manifest.label}</span>
        {phase && <span className={`node-chip chip-${phase}`}>{statusText}</span>}
      </div>
      <div className="node-typeid">{manifest.type} · v{manifest.version}</div>
      {driftedNode && (
        <div className="node-drift" title="The tool's schema changed since this node was added. Select it to review.">
          tool schema changed — review
        </div>
      )}

      <div className="node-ports">
        <div className="ports-in">
          {/* Effective inputs: declared ports plus this instance's promoted
              params (ADR-0017). The same derivation the engine and the
              connection check use — a card that drew a different set would let
              a user wire an edge the engine refuses. */}
          {effectiveInputs.map((port) => (
            <div key={port.id} className={`port-row${promotedIds.has(port.id) ? ' port-promoted' : ''}`}>
              <Handle
                id={port.id}
                type="target"
                position={Position.Left}
                className={`port-handle${promotedIds.has(port.id) ? ' handle-promoted' : ''}`}
                style={{ background: portColorVar(port.type) }}
              />
              <span
                className="port-name"
                title={
                  `${port.type}${port.required === false ? ' · optional' : ''}${port.variadic ? ' · variadic' : ''}` +
                  (promotedIds.has(port.id) ? ' · promoted param — the wire overrides the configured value' : '')
                }
              >
                {port.label ?? port.id}
                {port.required === false ? ' °' : ''}
              </span>
            </div>
          ))}
        </div>
        <div className="ports-out">
          {manifest.outputs.map((port) => (
            <div key={port.id} className="port-row out">
              <span className="port-name" title={port.type}>{port.label ?? port.id}</span>
              <Handle
                id={port.id}
                type="source"
                position={Position.Right}
                className="port-handle"
                style={{ background: portColorVar(port.type) }}
              />
            </div>
          ))}
        </div>
      </div>

      {phase === 'running' && (
        <div className="node-progress">
          <div
            className={`node-progress-bar${status?.progress === undefined ? ' indeterminate' : ''}`}
            style={status?.progress !== undefined ? { width: `${Math.round(status.progress * 100)}%` } : undefined}
          />
        </div>
      )}
      {phase === 'failed' && status?.error && (
        <div className="node-error" title={status.error}>{status.error}</div>
      )}
    </div>
  );
});
