/**
 * The header strip: document identity, history, file actions, and Run.
 *
 * Every button here mirrors a native menu item rather than replacing one —
 * the menu is the accessible, discoverable surface (and the only one with
 * accelerators), so this is a shortcut for the mouse, not a second
 * implementation. That is why the file actions arrive as props from `App`:
 * both paths end in the same `doSave`/`doOpen`/`doNew`, so a toolbar click and
 * a ⌘S can never diverge.
 *
 * Run is the exception that swaps rather than disables: while a run is in
 * flight the button becomes Cancel, because a disabled Run would leave a user
 * with a running workflow and no visible way to stop it.
 */
import { useStore } from '../store';
import { cancelWorkflowRun, startWorkflowRun } from '../engine-client';

export function Toolbar(props: { onSave(): void; onOpen(): void; onNew(): void }) {
  const name = useStore((s) => s.meta.name);
  const dirty = useStore((s) => s.dirty);
  const running = useStore((s) => s.run.running);
  const engineReady = useStore((s) => s.engineReady);
  const canUndo = useStore((s) => s.past.length > 0);
  const canRedo = useStore((s) => s.future.length > 0);
  const undo = useStore((s) => s.undo);
  const redo = useStore((s) => s.redo);

  return (
    <header className="toolbar">
      <div className="wordmark">
        ARCH<span>SPACE</span>
      </div>
      <div className="toolbar-doc">
        <span className="doc-name">{name}</span>
        {dirty && <span className="doc-dirty" title="Unsaved changes" />}
      </div>
      <div className="toolbar-spacer" />
      <div className="toolbar-group">
        <button className="tb" onClick={undo} disabled={!canUndo} title="Undo (⌘Z)">↶</button>
        <button className="tb" onClick={redo} disabled={!canRedo} title="Redo (⇧⌘Z)">↷</button>
      </div>
      <div className="toolbar-group">
        <button className="tb" onClick={props.onNew} title="New workflow (⌘N)">New</button>
        <button className="tb" onClick={props.onOpen} title="Open… (⌘O)">Open</button>
        <button className="tb" onClick={props.onSave} title="Save (⌘S)">Save</button>
      </div>
      {running ? (
        <button className="tb-run cancel" onClick={cancelWorkflowRun} title="Cancel run (⌘.)">
          <span className="run-spinner" /> Cancel
        </button>
      ) : (
        <button
          className="tb-run"
          onClick={startWorkflowRun}
          disabled={!engineReady}
          title={engineReady ? 'Run workflow (⌘R)' : 'Engine starting…'}
        >
          ▶ Run
        </button>
      )}
    </header>
  );
}
