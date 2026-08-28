/**
 * The renderer root: layout, the document lifecycle, and the two input
 * surfaces that are not React's (ARCHITECTURE §3.2).
 *
 * `doSave` / `doOpen` / `doNew` live here rather than in `Toolbar` because the
 * native menu and the toolbar must reach the same implementation — a ⌘S and a
 * click on Save cannot be allowed to diverge — and only a common parent can
 * hand both the same function.
 *
 * The menu switch ends in `const unhandled: never = action`, which is
 * load-bearing rather than decorative. Four settings actions were once sent by
 * main and dropped here in silence because the switch had no case and no
 * default, so the menu items simply did nothing. That is now a compile error,
 * and if one ever escapes the type system the user is told rather than left
 * clicking a dead control.
 *
 * Copy and paste are handled by hand because the graph is not text: the menu's
 * built-in roles serve text fields correctly and cannot know about selected
 * nodes. `isEditingText` and the `settingsOpen` check are what keep the two
 * meanings apart — inside a form field, or with the settings dialog owning the
 * screen, ⌘C must copy characters and not the canvas behind it.
 *
 * `Settings` is mounted only while open so that focus capture, focus restore
 * and each panel's fetches happen per opening rather than once per launch.
 */
import { useCallback, useEffect, useRef } from 'react';
import { Toolbar } from './components/Toolbar';
import { NodeLibrary } from './components/NodeLibrary';
import { Canvas } from './components/Canvas';
import { Inspector } from './components/Inspector';
import { ExecutionPanel } from './components/ExecutionPanel';
import { ExecPanelDivider } from './components/ExecPanelDivider';
import { Notices } from './components/Notices';
import { Settings } from './components/Settings';
import { useStore } from './store';
import { cancelWorkflowRun, startWorkflowRun } from './engine-client';
import type { MenuAction } from '../../shared/protocol';

function isEditingText(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLElement &&
    (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)
  );
}

export default function App() {
  const dirty = useStore((s) => s.dirty);
  const settingsOpen = useStore((s) => s.settingsOpen);
  const savingRef = useRef(false);

  const doSave = useCallback(async (saveAs: boolean) => {
    if (savingRef.current) return;
    savingRef.current = true;
    try {
      const store = useStore.getState();
      const result = await window.archspace.save(saveAs ? null : store.filePath, store.buildDoc());
      if (result.ok) {
        store.markSaved(result.path);
        // Both separators: ADR-0014 ships Windows, where `split('/')` finds
        // nothing in `C:\Users\me\plan.archspace.yaml` and `.pop()` hands back
        // the whole path — so the toast that exists to say "saved, and it is
        // the file you meant" showed a line of path instead of a name.
        store.notify('info', `Saved ${result.path.split(/[\\/]/).pop() ?? result.path}`);
      } else if (!('cancelled' in result)) {
        store.notify('error', `Save failed: ${result.error}`);
      }
    } finally {
      savingRef.current = false;
    }
  }, []);

  const doOpen = useCallback(async () => {
    const store = useStore.getState();
    if (store.dirty && !window.confirm('Discard unsaved changes?')) return;
    const result = await window.archspace.openDialog();
    if (result.ok) {
      store.loadDoc(result.workflow.path, result.workflow.doc, result.workflow.issues);
    } else if (!('cancelled' in result)) {
      store.notify('error', result.error);
    }
  }, []);

  const doNew = useCallback(() => {
    const store = useStore.getState();
    if (store.dirty && !window.confirm('Discard unsaved changes?')) return;
    store.newDoc();
  }, []);

  // Boot: the example workflow ships as the default document (copied into
  // user data on first launch, then opened like any file).
  useEffect(() => {
    void window.archspace.openDefault().then((result) => {
      const store = useStore.getState();
      if (result.ok) {
        store.loadDoc(result.workflow.path, result.workflow.doc, result.workflow.issues);
      } else if (!('cancelled' in result)) {
        store.notify('error', `Could not open the example workflow: ${result.error}`);
      }
    });
  }, []);

  // Native menu → renderer actions.
  useEffect(() => {
    window.archspace.onMenu((action: MenuAction) => {
      const store = useStore.getState();
      switch (action) {
        case 'new': doNew(); break;
        case 'open': void doOpen(); break;
        case 'save': void doSave(false); break;
        case 'save-as': void doSave(true); break;
        case 'undo': store.undo(); break;
        case 'redo': store.redo(); break;
        case 'run': startWorkflowRun(); break;
        case 'cancel-run': cancelWorkflowRun(); break;
        case 'settings-mcp': store.openSettings('mcp'); break;
        case 'settings-ai': store.openSettings('ai'); break;
        case 'settings-plugins': store.openSettings('plugins'); break;
        case 'settings-autodesk': store.openSettings('autodesk'); break;
        default: {
          // Not decoration. The four settings items above shipped in the native
          // menu with no case here, so choosing them did nothing at all and
          // said nothing about it — a menu item that silently no-ops reads as a
          // broken app. The `never` makes the compiler refuse a new MenuAction
          // that nobody wired up, and the notice makes it visible if one ever
          // reaches a user anyway.
          const unhandled: never = action;
          store.notify('warn', `The menu action "${String(unhandled)}" is not wired up in this window.`);
          break;
        }
      }
    });
  }, [doNew, doOpen, doSave]);

  // Keyboard: copy/paste are ours (menu roles handle text fields).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isEditingText(e.target)) return;
      // While settings is open it owns the screen: ⌘C there means "copy this
      // text", not "copy the selected nodes on the canvas behind me".
      if (useStore.getState().settingsOpen) return;
      const mod = e.metaKey || e.ctrlKey;
      if (!mod) return;
      const store = useStore.getState();
      if (e.key === 'c') {
        store.copySelection();
        e.preventDefault();
      } else if (e.key === 'v') {
        store.paste();
        e.preventDefault();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // Reflect dirty state in the title bar (macOS document-edited dot).
  useEffect(() => {
    window.archspace.setDirty(dirty);
  }, [dirty]);

  return (
    <div className="app-shell">
      <Toolbar onSave={() => void doSave(false)} onOpen={() => void doOpen()} onNew={doNew} />
      <div className="app-main">
        <NodeLibrary />
        <Canvas />
        <Inspector />
      </div>
      <ExecPanelDivider />
      <ExecutionPanel />
      <Notices />
      {/* Mounted only while open, so focus capture/restore and the panels'
          own fetches run once per opening rather than once per app launch. */}
      {settingsOpen && <Settings />}
    </div>
  );
}
