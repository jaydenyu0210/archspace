import { useCallback, useEffect, useRef } from 'react';
import { Toolbar } from './components/Toolbar';
import { NodeLibrary } from './components/NodeLibrary';
import { Canvas } from './components/Canvas';
import { Inspector } from './components/Inspector';
import { ExecutionPanel } from './components/ExecutionPanel';
import { Notices } from './components/Notices';
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
  const savingRef = useRef(false);

  const doSave = useCallback(async (saveAs: boolean) => {
    if (savingRef.current) return;
    savingRef.current = true;
    try {
      const store = useStore.getState();
      const result = await window.archspace.save(saveAs ? null : store.filePath, store.buildDoc());
      if (result.ok) {
        store.markSaved(result.path);
        store.notify('info', `Saved ${result.path.split('/').pop()}`);
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
      }
    });
  }, [doNew, doOpen, doSave]);

  // Keyboard: copy/paste are ours (menu roles handle text fields).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isEditingText(e.target)) return;
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
      <ExecutionPanel />
      <Notices />
    </div>
  );
}
