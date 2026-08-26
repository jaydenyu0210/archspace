/**
 * The run log and output previews — the engine's event stream, rendered
 * (ARCHITECTURE §7).
 *
 * `eventLine` returns `null` for the events worth suppressing, rather than the
 * panel filtering the stream upstream: one place decides what a run *reads*
 * like. Note its `default: return null` — a run event added to the engine is
 * silently invisible here until someone gives it a line, which is a real trap
 * and the first place to look when a new event "does not show up".
 *
 * Timestamps are relative to the run's start (`+1.21s`), not wall clock. A run
 * is read to answer "what took the time", and absolute times make the reader
 * do the subtraction. Previews are bounded and say when they were truncated,
 * because the wire-value invariant (§8.1) means large output is an `AssetRef`
 * and the panel must never look like it is showing the whole of something.
 */
import { useEffect, useRef } from 'react';
import { useStore } from '../store';
import type { RunEvent, OutputPreview } from '@archspace/engine';

function eventLine(e: RunEvent, startedAt: number | null, nodeLabel: (id: string) => string): string | null {
  const t = startedAt ? `+${((e.at - startedAt) / 1000).toFixed(2)}s` : '';
  switch (e.type) {
    case 'run:started': return `${t} run started (${e.runId})`;
    case 'node:started': return `${t} ${nodeLabel(e.nodeId)} started${e.attempt > 1 ? ` (attempt ${e.attempt})` : ''}`;
    case 'node:progress': return e.message ? `${t} ${nodeLabel(e.nodeId)} — ${e.message}` : null;
    case 'node:log': return `${t} ${nodeLabel(e.nodeId)} [${e.level}] ${e.message}`;
    case 'node:succeeded': return `${t} ${nodeLabel(e.nodeId)} complete${e.cached ? ' (cached)' : ''} in ${e.durationMs}ms`;
    case 'node:failed': return `${t} ${nodeLabel(e.nodeId)} failed (${e.kind})${e.willRetry ? ' — will retry' : ''}: ${e.message}`;
    case 'node:skipped': return `${t} ${nodeLabel(e.nodeId)} skipped (${e.reason})`;
    case 'run:finished': return `${t} run finished: ${e.status} — ${e.stats.succeeded} complete (${e.stats.cached} cached), ${e.stats.failed} failed, ${e.stats.skipped} skipped`;
    default: return null;
  }
}

/**
 * A table cell as text. Cells are `Value`, so one can legitimately hold an
 * object or a list — an MCP tool's structured result routinely does. `String()`
 * renders those as "[object Object]", which in a preview is indistinguishable
 * from a node that genuinely produced that string. JSON is wrong-looking in a
 * way the reader can act on.
 */
function cellText(v: unknown): string {
  if (v === undefined || v === null) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  return JSON.stringify(v);
}

function eventClass(e: RunEvent): string {
  switch (e.type) {
    case 'node:failed': return 'log-err';
    case 'node:skipped': return 'log-skip';
    case 'node:succeeded': return 'log-ok';
    case 'run:finished': return 'log-final';
    case 'node:log': return e.level === 'error' ? 'log-err' : e.level === 'warn' ? 'log-warn' : 'log-dim';
    default: return 'log-dim';
  }
}

function PreviewBlock({ preview }: { preview: OutputPreview }) {
  const p = preview.preview;
  return (
    <div className="preview-block">
      <div className="preview-port mono">
        {preview.port} <span className="preview-type">{preview.type}</span>
      </div>
      {p.kind === 'text' && (
        <pre className="preview-pre">{p.text}{p.truncated ? '\n… (truncated)' : ''}</pre>
      )}
      {p.kind === 'json' && (
        <pre className="preview-pre">{p.json}{p.truncated ? '\n… (truncated)' : ''}</pre>
      )}
      {p.kind === 'table' && (
        <div className="preview-table-wrap">
          <table className="preview-table">
            <thead>
              <tr>{p.columns.map((c) => <th key={c.id}>{c.label ?? c.id}</th>)}</tr>
            </thead>
            <tbody>
              {p.rows.map((row, i) => (
                <tr key={i}>{p.columns.map((c) => <td key={c.id}>{cellText(row[c.id])}</td>)}</tr>
              ))}
            </tbody>
          </table>
          {p.totalRows > p.rows.length && (
            <div className="preview-note">{p.rows.length} of {p.totalRows} rows</div>
          )}
        </div>
      )}
      {p.kind === 'asset' && (
        <div className="preview-asset">
          <div className="asset-name">{p.ref.name ?? 'asset'}</div>
          <div className="asset-meta mono">
            {p.ref.mediaType} · {(p.ref.size / 1024).toFixed(1)} KB
          </div>
          <div className="asset-hash mono" title={p.ref.hash}>{p.ref.hash.slice(0, 24)}…</div>
        </div>
      )}
      {p.kind === 'empty' && <div className="preview-note">no value</div>}
    </div>
  );
}

export function ExecutionPanel() {
  const run = useStore((s) => s.run);
  const nodes = useStore((s) => s.nodes);
  const manifestByType = useStore((s) => s.manifestByType);
  const inspectedNodeId = useStore((s) => s.inspectedNodeId);
  const logRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight });
  }, [run.events.length]);

  const nodeLabel = (id: string): string => {
    const node = nodes.find((n) => n.id === id);
    return node ? (manifestByType[node.data.typeId]?.label ?? node.data.typeId) : id;
  };

  const statusText = run.running
    ? 'Running'
    : run.status
      ? { succeeded: 'Succeeded', failed: 'Failed', partial: 'Partial', cancelled: 'Cancelled' }[run.status]
      : 'Idle';

  const inspected = inspectedNodeId ? run.previews[inspectedNodeId] : undefined;
  const inspectedStatus = inspectedNodeId ? run.nodeStatus[inspectedNodeId] : undefined;

  return (
    <section className="exec-panel">
      <div className="exec-head">
        <span className={`status-light ${run.running ? 'running' : (run.status ?? 'idle')}`} />
        <span className="exec-status">{statusText}</span>
        {run.stats && (
          <span className="exec-stats mono">
            {run.stats.succeeded}✓ {run.stats.cached > 0 ? `(${run.stats.cached} cached) ` : ''}
            {run.stats.failed}✗ {run.stats.skipped}⤼ · {(run.stats.durationMs / 1000).toFixed(2)}s
          </span>
        )}
        <span className="exec-spacer" />
        <span className="panel-title-inline">Execution</span>
      </div>
      <div className="exec-body">
        <div className="exec-log" ref={logRef}>
          {run.events.length === 0 && (
            <div className="panel-hint">Run the workflow (⌘R) to see live per-node execution here.</div>
          )}
          {run.events.map((e) => {
            const line = eventLine(e, run.startedAt, nodeLabel);
            return line ? (
              <div key={e.seq} className={`log-line ${eventClass(e)}`}>{line}</div>
            ) : null;
          })}
        </div>
        <div className="exec-preview">
          {inspectedNodeId ? (
            <>
              <div className="preview-head">
                {nodeLabel(inspectedNodeId)}
                {inspectedStatus?.error && <span className="preview-error"> — {inspectedStatus.error}</span>}
              </div>
              {inspected && inspected.length > 0 ? (
                inspected.map((p) => <PreviewBlock key={p.port} preview={p} />)
              ) : (
                <div className="panel-hint">
                  {inspectedStatus ? 'No outputs yet for this node.' : 'This node has not run.'}
                </div>
              )}
            </>
          ) : (
            <div className="panel-hint">Select a node to inspect its outputs.</div>
          )}
        </div>
      </div>
    </section>
  );
}
