/**
 * Typed message protocols crossing the app's process boundaries.
 *
 *   renderer ⇄ engine child : MessagePort pair (run/cancel/events/manifests,
 *                             plus MCP and plugin status pushes)
 *   main     ⇄ engine child : MessagePort pair (the CONTROL channel: config
 *                             push, secret resolution, OAuth relay)
 *   renderer ⇄ main         : contextBridge IPC (files, dialogs, menu,
 *                             settings, secrets, plugin install)
 *
 * Everything here must survive structured clone.
 *
 * Why the split: main owns the filesystem, the OS keychain (safeStorage) and
 * the browser (`shell.openExternal`); the engine child owns the node registry,
 * the MCP client pool, the plugin host and the AI gateway (ARCHITECTURE §3.2,
 * §9.2). Settings therefore travel renderer → main (persisted) → engine
 * (applied), and status travels engine → renderer directly. Secret VALUES only
 * ever exist in main and the engine child — never in the renderer.
 */
import type { AssetRef, NodeManifest } from '@archspace/node-sdk';
import type { EngineGraph, RunEvent, ValidationIssue } from '@archspace/engine';
import type { DocIssue, WorkflowDoc } from '@archspace/document';
import type { AiGatewayConfig, ProfileProbeResult, ProfileStatus } from '@archspace/ai-gateway';
import type { McpConfig, McpServerStatus } from '@archspace/mcp-host';
import type { InstalledPluginInfo } from '@archspace/plugin-host';
import type { AutodeskCapability, McpServerPreset } from '@archspace/autodesk';

// ---- renderer → engine child ----------------------------------------------

export type EngineRequest =
  | { t: 'hello' }
  | { t: 'run'; runId: string; graph: EngineGraph }
  | { t: 'cancel'; runId: string }
  | { t: 'validate'; requestId: number; graph: EngineGraph }
  /** Connect / disconnect one MCP server by logical name. */
  | { t: 'mcp-connect'; requestId: number; name: string }
  | { t: 'mcp-disconnect'; requestId: number; name: string }
  /** Re-read tools/list from a connected server (drift check, manual refresh). */
  | { t: 'mcp-refresh'; requestId: number; name: string }
  | { t: 'mcp-status' }
  /** Enable / disable an installed plugin, or reload the plugin set. */
  | { t: 'plugin-set-enabled'; requestId: number; id: string; enabled: boolean }
  | { t: 'plugin-reload'; requestId: number }
  | { t: 'plugin-status' }
  /** Probe one AI model profile end to end (a real, minimal provider call). */
  | { t: 'ai-probe'; requestId: number; profile: string }
  | { t: 'ai-status' };

// ---- engine child → renderer ----------------------------------------------

export type EngineResponse =
  /**
   * The registry as it stands, plus the schema hash of every MCP tool node in
   * it (`nodeType` → hash). The hashes ride along with the manifests because
   * they change together and for the same reason — a `tools/list` that came
   * back different — so delivering them apart would let the renderer pin a
   * hash against a manifest it no longer has (ADR-0009 §5).
   */
  | { t: 'manifests'; manifests: NodeManifest[]; schemaHashes: Record<string, string> }
  | { t: 'event'; runId: string; event: RunEvent }
  | { t: 'run-rejected'; runId: string; issues: ValidationIssue[] }
  | { t: 'validated'; requestId: number; issues: ValidationIssue[] }
  /** Pushed whenever any server's state changes, and in reply to mcp-status. */
  | { t: 'mcp-status'; servers: McpServerStatus[] }
  | { t: 'mcp-result'; requestId: number; ok: boolean; error?: string }
  /** Pushed whenever the plugin set changes, and in reply to plugin-status. */
  | { t: 'plugin-status'; plugins: InstalledPluginInfo[] }
  | { t: 'plugin-result'; requestId: number; ok: boolean; error?: string }
  | { t: 'ai-status'; profiles: ProfileStatus[] }
  | { t: 'ai-probe-result'; requestId: number; result: ProfileProbeResult };

// ---- main ⇄ engine child (control channel) --------------------------------

/**
 * Absolute paths the engine child cannot work out for itself: in development
 * they point into the workspace, in a packaged app into `resourcesPath`, and
 * only main knows which of those it is.
 */
export interface EnginePaths {
  /** Read-only directories of first-party plugins shipped inside the app. */
  bundledPluginDirs: string[];
  /** Where user-installed plugins live and where installs land. */
  userPluginsDir: string;
  /** The built plugin child script the plugin host forks per plugin. */
  pluginChildEntry: string;
  /** Electron binary path; forked as Node via ELECTRON_RUN_AS_NODE. */
  execPath: string;
}

/** main → engine. Config is pushed on connect and on every settings change. */
export type EngineControlRequest =
  | { t: 'init'; paths: EnginePaths }
  | { t: 'config'; mcp: McpConfig; ai: AiGatewayConfig; pluginConsent: PluginConsentState }
  /**
   * Read one asset's bytes out of the engine's store, so main can write them
   * to a file the user picked, or hand them to the 3D preview panel.
   *
   * This is the one request that flows main → engine rather than the other way
   * round, and it goes over the control channel rather than the renderer's
   * because of §7.6: the renderer⇄engine port carries the event stream and its
   * size-capped previews, never bulk data. Two consumers sit behind it: Save,
   * where main writes the bytes to disk and the renderer sees only the path,
   * and the ADR-0003 IFC viewer, where main forwards them to the renderer —
   * bounded by MAX_VIEWER_ASSET_BYTES and validated against the ref, because
   * that hop is the deliberate, fenced exception to §7.6 rather than a leak.
   */
  | { t: 'asset-read'; requestId: number; ref: AssetRef }
  /** Reply to an engine-issued secret request (value present only on success). */
  | { t: 'secret-result'; requestId: number; value?: string; error?: string }
  /** Reply to an engine-issued OAuth authorization request. */
  | { t: 'oauth-result'; requestId: number; ok: boolean; code?: string; state?: string; error?: string }
  /** Reply to an engine-issued OAuth token-store read/write. */
  | { t: 'oauth-store-result'; requestId: number; ok: boolean; json?: string; error?: string };

/** engine → main. */
export type EngineControlEvent =
  | { t: 'ready' }
  /** Resolve a secret by KEY. The value never leaves main and the engine. */
  | { t: 'secret-request'; requestId: number; key: string }
  /** Ask main to run the OAuth 2.1 + PKCE browser flow for an MCP server. */
  | { t: 'oauth-request'; requestId: number; server: string; authorizationUrl: string; redirectUri: string }
  /** Persisted OAuth client registration + tokens, keyed per server. */
  | { t: 'oauth-store-read'; requestId: number; server: string; slot: OAuthStoreSlot }
  | { t: 'oauth-store-write'; requestId: number; server: string; slot: OAuthStoreSlot; json: string | null }
  /** Reply to `asset-read`. */
  | { t: 'asset-data'; requestId: number; ok: boolean; bytes?: Uint8Array; error?: string }
  /** Mirrored to the renderer by main when no renderer port is live yet. */
  | { t: 'mcp-status'; servers: McpServerStatus[] }
  | { t: 'plugin-status'; plugins: InstalledPluginInfo[] };

export type OAuthStoreSlot = 'client-information' | 'tokens' | 'code-verifier';

/** Which permissions the user has granted each plugin, by plugin id. */
export type PluginConsentState = Record<string, { enabled: boolean; permissions: string[] }>;

// ---- renderer ⇄ main (via preload bridge) ---------------------------------

export interface OpenedWorkflow {
  path: string;
  doc: WorkflowDoc;
  issues: DocIssue[];
}

export type OpenResult =
  | { ok: true; workflow: OpenedWorkflow }
  | { ok: false; error: string; issues?: DocIssue[] }
  | { ok: false; cancelled: true };

export type SaveResult =
  | { ok: true; path: string }
  | { ok: false; error: string }
  | { ok: false; cancelled: true };

/**
 * Reply to `readAsset` — the 3D viewer's byte fetch.
 *
 * A discriminated union rather than a thrown error because every failure here
 * is an expected state the UI must render, not a bug: the engine restarted and
 * the store died with it, the asset is over the viewer's size ceiling, the
 * bytes came back the wrong length. `error` is a full sentence for exactly the
 * reason saveAsset's messages are — the store is session-scoped, so the most
 * common failure ("run it again") needs explaining, not just reporting.
 */
export type ReadAssetResult =
  | { ok: true; bytes: Uint8Array }
  | { ok: false; error: string };

/**
 * The most bytes `readAsset` will hand a sandboxed window.
 *
 * The ceiling exists because a read is three whole-file copies in flight —
 * engine → main → renderer, each a structured clone — and because §7.6's
 * event-stream previews are size-capped precisely so the renderer's memory is
 * never hostage to an output's size. 64 MiB is far above any mock output
 * (the shipped example's IFC is ~500 KB) while still letting a real BIM
 * backend's model through; past it, the answer is Save and an external viewer,
 * which the error message says.
 */
export const MAX_VIEWER_ASSET_BYTES = 64 * 1024 * 1024;

export type MenuAction =
  | 'new'
  | 'open'
  | 'save'
  | 'save-as'
  | 'undo'
  | 'redo'
  | 'run'
  | 'cancel-run'
  | 'settings-mcp'
  | 'settings-ai'
  | 'settings-plugins'
  | 'settings-autodesk';

export type SettingsResult = { ok: true } | { ok: false; error: string };

/**
 * A hand-editable config file as main loaded it, plus whatever the validator
 * objected to on the way in.
 *
 * The issues travel WITH the config rather than as a separate notification,
 * because the two are only meaningful together. Both loaders fall back to a
 * generated default when a file is malformed, so a panel handed the config
 * alone renders invented profiles and servers as though the user had written
 * them — the file is broken, the screen looks fine, and nothing connects the
 * two. Main used to send these on a `settings:issue` channel that no renderer
 * ever subscribed to, which is the same failure with extra steps.
 */
export interface LoadedConfig<T> {
  config: T;
  issues: string[];
}

/** Secret keys are listed to the renderer; secret VALUES never are. */
export interface SecretKeyInfo {
  key: string;
  /** Set the first time this key was written, for the "configured" affordance. */
  createdAt: number;
}

export interface PluginInstallResult {
  ok: boolean;
  error?: string;
  /** Present on success — what was installed, so the UI can name it. */
  plugin?: { id: string; displayName: string; version: string; permissions: string[] };
  cancelled?: boolean;
}

/** Host platform facts the UI needs to tell the truth about availability. */
export interface PlatformInfo {
  platform: NodeJS.Platform;
  arch: string;
  appVersion: string;
  electronVersion: string;
  /** Absolute paths, shown in settings so users can find/edit files by hand. */
  paths: {
    userData: string;
    mcpConfig: string;
    aiConfig: string;
    userPlugins: string;
    workflows: string;
  };
  /** True when the OS keychain backs safeStorage; false ⇒ secrets are refused. */
  secretsAvailable: boolean;
}

/** Surface exposed on window.archspace by the preload script. */
export interface ArchspaceBridge {
  /** Ask main to open a file picker and parse the chosen workflow. */
  openDialog(): Promise<OpenResult>;
  /** Open (copying into user data on first launch) the bundled example. */
  openDefault(): Promise<OpenResult>;
  /** Save. Null path → save-as dialog. Returns the path actually written. */
  save(path: string | null, doc: WorkflowDoc): Promise<SaveResult>;
  /** Ask main for a fresh engine MessagePort (delivered via window message). */
  requestEnginePort(): void;
  onMenu(cb: (action: MenuAction) => void): void;
  /** Engine child crashed and was restarted; any in-flight run is dead. */
  onEngineRestarted(cb: () => void): void;
  /**
   * The engine died repeatedly and main has stopped restarting it.
   *
   * Distinct from `onEngineRestarted`, which means "it is coming back": this
   * one means it is not, and the app can do nothing further on its own. Said
   * once rather than looped, which is the whole reason the ceiling exists.
   */
  onEngineGaveUp(cb: (restarts: number) => void): void;
  setDirty(dirty: boolean): void;

  platform(): Promise<PlatformInfo>;

  /** MCP server bindings — machine-local settings, never the workflow file. */
  getMcpConfig(): Promise<LoadedConfig<McpConfig>>;
  setMcpConfig(config: McpConfig): Promise<SettingsResult>;
  /** Reveal mcp.yaml / ai.yaml in Finder for hand editing. */
  revealPath(path: string): Promise<void>;

  /** AI model profiles. Keys are stored by REFERENCE; values go to secrets. */
  getAiConfig(): Promise<LoadedConfig<AiGatewayConfig>>;
  setAiConfig(config: AiGatewayConfig): Promise<SettingsResult>;

  /** Secrets live in the OS keychain via safeStorage; values are write-only
   *  from the renderer's point of view. */
  listSecretKeys(): Promise<SecretKeyInfo[]>;
  setSecret(key: string, value: string): Promise<SettingsResult>;
  deleteSecret(key: string): Promise<SettingsResult>;

  /** Install a plugin from a directory or a packed .tgz chosen by the user. */
  installPlugin(): Promise<PluginInstallResult>;
  uninstallPlugin(id: string): Promise<SettingsResult>;
  /** Persisted enable/permission state; the engine applies it. */
  /**
   * The consent on file, plus anything in `plugins.json` that could not be
   * read. The issues travel WITH the value for the same reason the MCP and AI
   * config issues do: the panel that renders a config is the place a person is
   * actually looking when it matters. A consent record that silently reset
   * looks exactly like one they forgot they had granted.
   */
  getPluginConsent(): Promise<{ consent: PluginConsentState; issues: string[] }>;
  setPluginConsent(state: PluginConsentState): Promise<SettingsResult>;

  /** Autodesk/Revit capability map and the MCP presets that are real. */
  autodeskCapabilities(): Promise<AutodeskCapability[]>;
  autodeskPresets(): Promise<McpServerPreset[]>;

  /** Open an external URL (evidence links in the Autodesk panel). */
  openExternal(url: string): Promise<void>;

  /**
   * Write one of a run's output assets to a file the user picks.
   *
   * Takes the ref, not the bytes: for a save the renderer never needs them.
   * Main reads them from the engine and writes the file itself.
   */
  saveAsset(ref: AssetRef): Promise<SaveResult>;

  /**
   * Read one output asset's bytes into the renderer, for the ADR-0003 3D
   * preview panel.
   *
   * This is the single sanctioned exception to §7.6's "bulk data stops at the
   * engine": a viewer cannot exist without the model, and the file the mock
   * BIM node writes is exactly the thing worth looking at. The exception is
   * fenced rather than open-ended — main refuses refs over
   * MAX_VIEWER_ASSET_BYTES and bytes whose length disagrees with the
   * content-addressed ref, and the event-stream previews stay size-capped as
   * before. Callers must treat a failure as a state to render, not retry:
   * the store lives only as long as the engine child does.
   */
  readAsset(ref: AssetRef): Promise<ReadAssetResult>;
}

/**
 * The loopback redirect a native OAuth client must register before any flow
 * starts. Fixed (not ephemeral) so re-launching the app does not invalidate a
 * registration, and `127.0.0.1` rather than `localhost` so no DNS answer can
 * re-point it (the DNS-rebinding class the MCP spec guards against).
 */
export const OAUTH_REDIRECT_PORT = 33418;
export const OAUTH_REDIRECT_URI = `http://127.0.0.1:${OAUTH_REDIRECT_PORT}/callback`;

/**
 * Marker property on the window message that carries the engine MessagePort.
 *
 * Imported by BOTH sides — preload posts it, the renderer filters on it — which
 * is the entire reason it is a shared constant. Both used to spell the string
 * literally instead, so changing one would have silently stopped the port ever
 * arriving: no error, no failed IPC, just a canvas that never becomes ready.
 */
export const ENGINE_PORT_MESSAGE = 'archspace:engine-port';
