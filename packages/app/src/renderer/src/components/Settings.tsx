/**
 * The settings dialog: one modal over the drafting table, four tabs
 * (ARCHITECTURE §9.1 MCP bindings, §10 model profiles, §8 plugins, and the
 * Autodesk reach the `autodesk` package maps out).
 *
 * Modal, not a second window, because every section here binds something the
 * document behind it depends on — `mcp.yaml` says what the logical name `revit`
 * actually dials — and a separate window would put a window switch between the
 * workflow and the reason it cannot run. It is also the cheaper honest option:
 * a second BrowserWindow would need its own engine port, its own store and its
 * own copy of this state, and the two copies would drift.
 *
 * This file is the SHELL only: chrome, tabs, focus, and the one fact all four
 * panels need (`PlatformInfo` — real paths and real host facts, so a panel can
 * name the file it did not manage to write). The panels own their own content;
 * they read engine status from the store and call the preload bridge and
 * `engine-client` helpers themselves, the same way `Toolbar` does.
 *
 * `PlatformInfo` is fetched here, once per open, rather than in each panel: it
 * is one IPC round trip for a value all four want, and resolving it before the
 * body renders means a panel never has to render a "loading…" state for the
 * paths it is built around.
 */

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
} from 'react';
import { useStore, type SettingsTab } from '../store';
import { McpPanel } from './settings/McpPanel';
import { AiPanel } from './settings/AiPanel';
import { PluginsPanel } from './settings/PluginsPanel';
import { AutodeskPanel } from './settings/AutodeskPanel';
import type { PlatformInfo } from '../../../shared/protocol';


/** What every settings panel is handed. Panels take exactly this, no more. */
export interface SettingsPanelProps {
  /**
   * Host facts from main: real config paths for "edit it by hand", the actual
   * platform (the Autodesk story is platform-shaped), and whether the OS
   * keychain is backing `safeStorage` at all — a panel that offered to store a
   * secret on a machine that will refuse it would be lying.
   */
  platform: PlatformInfo;
}

interface TabSpec {
  id: SettingsTab;
  label: string;
}

const TABS: readonly TabSpec[] = [
  { id: 'mcp', label: 'MCP Servers' },
  { id: 'ai', label: 'AI Keys' },
  { id: 'plugins', label: 'Plugins' },
  { id: 'autodesk', label: 'Autodesk & Revit' },
];

const FOCUSABLE = [
  'button:not(:disabled)',
  '[href]',
  'input:not(:disabled)',
  'select:not(:disabled)',
  'textarea:not(:disabled)',
  '[tabindex]:not([tabindex="-1"])',
].join(', ');

function focusableWithin(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
    // `tabIndex >= 0` and not the selector alone: the tab bar keeps a roving
    // tabindex, so three of its four buttons are reachable by arrow key but are
    // NOT tab stops. Counting them here would put the end of the Tab cycle on
    // an element Tab can never actually land on.
    (el) => el.tabIndex >= 0 && (el.offsetParent !== null || el === document.activeElement),
  );
}

export function Settings() {
  const tab = useStore((s) => s.settingsTab);
  const setTab = useStore((s) => s.setSettingsTab);
  const close = useStore((s) => s.closeSettings);

  const modalRef = useRef<HTMLDivElement>(null);
  const tabRefs = useRef(new Map<SettingsTab, HTMLButtonElement>());
  const restoreFocusRef = useRef<Element | null>(null);

  const [platform, setPlatform] = useState<PlatformInfo | null>(null);
  const [platformError, setPlatformError] = useState<string | null>(null);

  const loadPlatform = useCallback(() => {
    setPlatformError(null);
    void window.archspace
      .platform()
      .then(setPlatform)
      .catch((err: unknown) => setPlatformError(err instanceof Error ? err.message : String(err)));
  }, []);

  useEffect(() => {
    loadPlatform();
  }, [loadPlatform]);

  // Focus into the dialog on open and hand it back on close — the menu item
  // that opened this took focus from the canvas, and a dialog that dropped it
  // on the floor leaves a keyboard user nowhere.
  useEffect(() => {
    restoreFocusRef.current = document.activeElement;
    modalRef.current?.focus();
    return () => {
      const previous = restoreFocusRef.current;
      if (previous instanceof HTMLElement) previous.focus();
    };
  }, []);

  const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Escape') {
      // Stop here: the canvas listens on window for its own shortcuts, and
      // Escape should close this dialog and nothing else.
      e.stopPropagation();
      close();
      return;
    }
    if (e.key !== 'Tab') return;

    // Trap Tab. Without this, tabbing walks out of the modal into the canvas
    // behind it, which is still there and still interactive.
    const modal = modalRef.current;
    if (!modal) return;
    const items = focusableWithin(modal);
    if (items.length === 0) {
      e.preventDefault();
      modal.focus();
      return;
    }
    const first = items[0];
    const last = items[items.length - 1];
    const active = document.activeElement;
    if (e.shiftKey && (active === first || active === modal)) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && active === last) {
      e.preventDefault();
      first.focus();
    }
  };

  // WAI-ARIA tabs pattern: arrows move between tabs, the tablist holds exactly
  // one tab stop (roving tabindex), so Tab lands in the panel, not on tab five.
  const onTabsKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    const index = TABS.findIndex((t) => t.id === tab);
    let next: SettingsTab | null = null;
    if (e.key === 'ArrowRight') next = TABS[(index + 1) % TABS.length].id;
    else if (e.key === 'ArrowLeft') next = TABS[(index - 1 + TABS.length) % TABS.length].id;
    else if (e.key === 'Home') next = TABS[0].id;
    else if (e.key === 'End') next = TABS[TABS.length - 1].id;
    if (next === null) return;
    e.preventDefault();
    setTab(next);
    tabRefs.current.get(next)?.focus();
  };

  // Only a press that both started and ended on the backdrop closes: a drag
  // that began inside a text field and happened to end out here is a selection
  // gesture, not a dismissal.
  const onBackdropMouseDown = (e: ReactMouseEvent<HTMLDivElement>) => {
    if (e.target === e.currentTarget) close();
  };

  function body() {
    if (platformError !== null) {
      return (
        <div className="settings-section">
          <div className="settings-note settings-note--error">
            Could not read host information from the app: {platformError}. The panels below need it
            to name the files they read, so none of them are shown.
          </div>
          <div className="settings-actions">
            <button className="settings-btn settings-btn--small" onClick={loadPlatform}>
              Try again
            </button>
          </div>
        </div>
      );
    }
    if (platform === null) {
      return (
        <div className="settings-loading">
          <span className="settings-spinner" /> Reading host information…
        </div>
      );
    }
    switch (tab) {
      case 'mcp':
        return <McpPanel platform={platform} />;
      case 'ai':
        return <AiPanel platform={platform} />;
      case 'plugins':
        return <PluginsPanel platform={platform} />;
      case 'autodesk':
        return <AutodeskPanel platform={platform} />;
    }
  }

  return (
    <div className="settings-backdrop" onMouseDown={onBackdropMouseDown} onKeyDown={onKeyDown}>
      <div
        className="settings-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="settings-title"
        tabIndex={-1}
        ref={modalRef}
      >
        <header className="settings-head">
          <h2 className="settings-title" id="settings-title">
            Settings
          </h2>
          <span className="settings-subtitle">Machine-local — never saved into a workflow</span>
          <div className="settings-head-spacer" />
          <button className="settings-close" onClick={close} aria-label="Close settings" title="Close (Esc)">
            ✕
          </button>
        </header>

        <div className="settings-tabs" role="tablist" aria-label="Settings sections" onKeyDown={onTabsKeyDown}>
          {TABS.map((t) => (
            <button
              key={t.id}
              ref={(el) => {
                if (el) tabRefs.current.set(t.id, el);
                else tabRefs.current.delete(t.id);
              }}
              className={`settings-tab${t.id === tab ? ' is-active' : ''}`}
              role="tab"
              id={`settings-tab-${t.id}`}
              aria-selected={t.id === tab}
              aria-controls={`settings-panel-${t.id}`}
              tabIndex={t.id === tab ? 0 : -1}
              onClick={() => setTab(t.id)}
            >
              {t.label}
            </button>
          ))}
        </div>

        <div
          className="settings-body"
          role="tabpanel"
          id={`settings-panel-${tab}`}
          aria-labelledby={`settings-tab-${tab}`}
          tabIndex={0}
        >
          {body()}
        </div>
      </div>
    </div>
  );
}
