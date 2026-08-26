/**
 * Renderer state: the open document as a live graph, edit history, the current
 * run folded from the engine event stream (§7.6 — events in, UI out), and the
 * settings surface.
 *
 * The three status arrays (`mcpServers`, `plugins`, `aiProfiles`) are MIRRORS,
 * not models: the engine child owns the MCP pool, the plugin host and the AI
 * gateway (§3.2), pushes a whole snapshot whenever any of them changes, and
 * this store only ever replaces what it was handed. Nothing here edits a
 * status in place after an action "succeeds" — an optimistic write would let
 * the panels claim a server is connected while the engine still says otherwise,
 * which is the same class of lie the honesty rule exists to prevent.
 */
import { create } from 'zustand';
import {
  applyEdgeChanges,
  applyNodeChanges,
  type Connection,
  type Edge,
  type EdgeChange,
  type Node,
  type NodeChange,
} from '@xyflow/react';
import { assignable } from '@archspace/types';
import type { NodeManifest } from '@archspace/node-sdk';
import type { ProfileStatus } from '@archspace/ai-gateway';
import type { McpServerStatus } from '@archspace/mcp-host';
import type { InstalledPluginInfo } from '@archspace/plugin-host';
import { generateNodeId, type DocIssue, type WorkflowDoc } from '@archspace/document';
import type { EngineGraph, RunEvent, RunStats, RunStatus, OutputPreview, ValidationIssue } from '@archspace/engine';

export type AppNodeData = {
  typeId: string;
  version: number;
  config: Record<string, unknown>;
  [key: string]: unknown;
};
export type AppNode = Node<AppNodeData>;
export type AppEdge = Edge;

export type NodePhase = 'pending' | 'running' | 'complete' | 'failed' | 'skipped';
export interface NodeRunStatus {
  phase: NodePhase;
  cached?: boolean;
  attempt?: number;
  retrying?: boolean;
  progress?: number;
  progressMessage?: string;
  error?: string;
  skipReason?: string;
}

export interface RunUiState {
  runId: string | null;
  running: boolean;
  status: RunStatus | null;
  startedAt: number | null;
  nodeStatus: Record<string, NodeRunStatus>;
  events: RunEvent[];
  previews: Record<string, OutputPreview[]>;
  stats: RunStats | null;
  rejectedIssues: ValidationIssue[];
}

export interface Notice {
  id: number;
  kind: 'info' | 'warn' | 'error';
  text: string;
}

/** The four settings sections, in tab order. Also the four native menu items. */
export type SettingsTab = 'mcp' | 'ai' | 'plugins' | 'autodesk';

interface Snapshot {
  nodes: AppNode[];
  edges: AppEdge[];
  meta: { name: string; description?: string };
}

const MAX_HISTORY = 100;
const EVENT_LOG_CAP = 3000;

let clipboard: { nodes: AppNode[]; edges: AppEdge[] } | null = null;
let noticeSeq = 0;

const emptyRun = (): RunUiState => ({
  runId: null,
  running: false,
  status: null,
  startedAt: null,
  nodeStatus: {},
  events: [],
  previews: {},
  stats: null,
  rejectedIssues: [],
});

function edgeId(source: string, sourceHandle: string, target: string, targetHandle: string): string {
  return `${source}.${sourceHandle} -> ${target}.${targetHandle}`;
}

function snap(state: { nodes: AppNode[]; edges: AppEdge[]; meta: Snapshot['meta'] }): Snapshot {
  return structuredClone({ nodes: state.nodes, edges: state.edges, meta: state.meta });
}

export interface StoreState {
  manifests: NodeManifest[];
  manifestByType: Record<string, NodeManifest>;
  engineReady: boolean;

  /** Engine-owned status, mirrored (see the file header). Empty until pushed. */
  mcpServers: McpServerStatus[];
  plugins: InstalledPluginInfo[];
  aiProfiles: ProfileStatus[];

  settingsOpen: boolean;
  settingsTab: SettingsTab;

  meta: { name: string; description?: string };
  nodes: AppNode[];
  edges: AppEdge[];
  filePath: string | null;
  dirty: boolean;
  docIssues: DocIssue[];

  past: Snapshot[];
  future: Snapshot[];
  lastHistoryTag: string | null;
  lastHistoryAt: number;

  run: RunUiState;
  notices: Notice[];
  /** Node id whose outputs the execution panel is inspecting. */
  inspectedNodeId: string | null;

  setManifests(manifests: NodeManifest[]): void;
  setMcpServers(servers: McpServerStatus[]): void;
  setPlugins(plugins: InstalledPluginInfo[]): void;
  setAiProfiles(profiles: ProfileStatus[]): void;
  notify(kind: Notice['kind'], text: string): void;
  dismissNotice(id: number): void;

  openSettings(tab: SettingsTab): void;
  setSettingsTab(tab: SettingsTab): void;
  closeSettings(): void;

  pushHistory(tag?: string): void;
  undo(): void;
  redo(): void;

  onNodesChange(changes: NodeChange<AppNode>[]): void;
  onEdgesChange(changes: EdgeChange<AppEdge>[]): void;
  connect(conn: Connection): void;
  addNode(typeId: string, position: { x: number; y: number }): void;
  beforeDelete(): void;
  copySelection(): void;
  paste(): void;
  updateParam(nodeId: string, key: string, value: unknown): void;
  setMeta(meta: Partial<Snapshot['meta']>): void;

  loadDoc(path: string | null, doc: WorkflowDoc, issues: DocIssue[]): void;
  newDoc(): void;
  buildDoc(): WorkflowDoc;
  markSaved(path: string): void;

  buildGraph(): EngineGraph;
  applyRunEvent(runId: string, event: RunEvent): void;
  runStarted(runId: string): void;
  runRejected(runId: string, issues: ValidationIssue[]): void;
  engineDown(): void;
  setInspected(nodeId: string | null): void;
}

export const useStore = create<StoreState>((set, get) => ({
  manifests: [],
  manifestByType: {},
  engineReady: false,

  mcpServers: [],
  plugins: [],
  aiProfiles: [],

  settingsOpen: false,
  settingsTab: 'mcp',

  meta: { name: 'Untitled workflow' },
  nodes: [],
  edges: [],
  filePath: null,
  dirty: false,
  docIssues: [],

  past: [],
  future: [],
  lastHistoryTag: null,
  lastHistoryAt: 0,

  run: emptyRun(),
  notices: [],
  inspectedNodeId: null,

  setManifests: (manifests) =>
    set({
      manifests,
      manifestByType: Object.fromEntries(manifests.map((m) => [m.type, m])),
      engineReady: true,
    }),

  setMcpServers: (mcpServers) => set({ mcpServers }),
  setPlugins: (plugins) => set({ plugins }),
  setAiProfiles: (aiProfiles) => set({ aiProfiles }),

  // Re-opening on a different tab keeps whatever the panels have already
  // fetched; the dialog is unmounted on close, so panel-local state is not
  // stale, only the engine mirrors above survive — and those are live.
  openSettings: (settingsTab) => set({ settingsOpen: true, settingsTab }),
  setSettingsTab: (settingsTab) => set({ settingsTab }),
  closeSettings: () => set({ settingsOpen: false }),

  notify: (kind, text) => {
    const id = ++noticeSeq;
    set((s) => ({ notices: [...s.notices.slice(-3), { id, kind, text }] }));
    setTimeout(() => get().dismissNotice(id), 5000);
  },
  dismissNotice: (id) => set((s) => ({ notices: s.notices.filter((n) => n.id !== id) })),

  pushHistory: (tag) => {
    const s = get();
    const now = Date.now();
    // Collapse rapid same-tagged edits (typing in a param field) into one undo step.
    if (tag && tag === s.lastHistoryTag && now - s.lastHistoryAt < 900) {
      set({ lastHistoryAt: now });
      return;
    }
    set({
      past: [...s.past.slice(-(MAX_HISTORY - 1)), snap(s)],
      future: [],
      lastHistoryTag: tag ?? null,
      lastHistoryAt: now,
    });
  },

  undo: () => {
    const s = get();
    const prev = s.past[s.past.length - 1];
    if (!prev) return;
    set({
      past: s.past.slice(0, -1),
      future: [...s.future, snap(s)],
      nodes: prev.nodes,
      edges: prev.edges,
      meta: prev.meta,
      dirty: true,
      lastHistoryTag: null,
    });
  },

  redo: () => {
    const s = get();
    const next = s.future[s.future.length - 1];
    if (!next) return;
    set({
      future: s.future.slice(0, -1),
      past: [...s.past, snap(s)],
      nodes: next.nodes,
      edges: next.edges,
      meta: next.meta,
      dirty: true,
      lastHistoryTag: null,
    });
  },

  onNodesChange: (changes) => {
    const structural = changes.some((c) => c.type === 'remove');
    set((s) => ({
      nodes: applyNodeChanges(changes, s.nodes),
      dirty: s.dirty || structural || changes.some((c) => c.type === 'position'),
    }));
  },

  onEdgesChange: (changes) => {
    const structural = changes.some((c) => c.type === 'remove');
    set((s) => ({
      edges: applyEdgeChanges(changes, s.edges),
      dirty: s.dirty || structural,
    }));
  },

  connect: (conn) => {
    const s = get();
    if (!conn.source || !conn.target || !conn.sourceHandle || !conn.targetHandle) return;
    if (conn.source === conn.target) {
      s.notify('warn', 'A node cannot feed itself.');
      return;
    }
    const sourceNode = s.nodes.find((n) => n.id === conn.source);
    const targetNode = s.nodes.find((n) => n.id === conn.target);
    if (!sourceNode || !targetNode) return;
    const sourceManifest = s.manifestByType[sourceNode.data.typeId];
    const targetManifest = s.manifestByType[targetNode.data.typeId];
    if (!sourceManifest || !targetManifest) {
      s.notify('warn', 'Cannot connect a node whose type is not installed.');
      return;
    }
    const outPort = sourceManifest.outputs.find((p) => p.id === conn.sourceHandle);
    const inPort = targetManifest.inputs.find((p) => p.id === conn.targetHandle);
    if (!outPort || !inPort) return;

    // One source of truth per non-variadic input (§6.2).
    const existing = s.edges.filter((e) => e.target === conn.target && e.targetHandle === conn.targetHandle);
    if (existing.length > 0 && !inPort.variadic) {
      s.notify('warn', `Input "${inPort.label ?? inPort.id}" already has a connection.`);
      return;
    }

    const verdict = assignable(outPort.type, inPort.type);
    if (!verdict.ok) {
      s.notify('warn', `Type mismatch: ${verdict.reason}.`);
      return;
    }

    // Refuse cycle-forming edges at creation (§6.2: checked at edge creation).
    const downstream = new Map<string, string[]>();
    for (const e of s.edges) {
      downstream.set(e.source, [...(downstream.get(e.source) ?? []), e.target]);
    }
    const seen = new Set<string>();
    const stack = [conn.target];
    let cycles = false;
    while (stack.length > 0) {
      const cur = stack.pop() as string;
      if (cur === conn.source) {
        cycles = true;
        break;
      }
      if (seen.has(cur)) continue;
      seen.add(cur);
      stack.push(...(downstream.get(cur) ?? []));
    }
    if (cycles) {
      s.notify('warn', 'That connection would create a cycle — workflows are DAGs.');
      return;
    }

    s.pushHistory();
    const id = edgeId(conn.source, conn.sourceHandle, conn.target, conn.targetHandle);
    set((st) => ({
      edges: [
        ...st.edges,
        {
          id,
          source: conn.source,
          sourceHandle: conn.sourceHandle,
          target: conn.target,
          targetHandle: conn.targetHandle,
          className: verdict.kind === 'unchecked' ? 'edge-unchecked' : `edge-${verdict.kind}`,
        },
      ],
      dirty: true,
    }));
  },

  addNode: (typeId, position) => {
    const s = get();
    const manifest = s.manifestByType[typeId];
    if (!manifest) return;
    s.pushHistory();
    const id = generateNodeId(s.nodes.map((n) => n.id));
    set((st) => ({
      nodes: [
        ...st.nodes.map((n) => ({ ...n, selected: false })),
        {
          id,
          type: 'archnode',
          position,
          selected: true,
          data: { typeId, version: manifest.version, config: {} },
        },
      ],
      dirty: true,
    }));
  },

  beforeDelete: () => get().pushHistory(),

  copySelection: () => {
    const s = get();
    const nodes = s.nodes.filter((n) => n.selected);
    if (nodes.length === 0) return;
    const ids = new Set(nodes.map((n) => n.id));
    const edges = s.edges.filter((e) => ids.has(e.source) && ids.has(e.target));
    clipboard = structuredClone({ nodes, edges });
    s.notify('info', `Copied ${nodes.length} node${nodes.length > 1 ? 's' : ''}.`);
  },

  paste: () => {
    const s = get();
    if (!clipboard || clipboard.nodes.length === 0) return;
    s.pushHistory();
    const taken = s.nodes.map((n) => n.id);
    const idMap = new Map<string, string>();
    const newNodes = clipboard.nodes.map((n) => {
      const id = generateNodeId([...taken, ...idMap.values()]);
      idMap.set(n.id, id);
      return {
        ...structuredClone(n),
        id,
        position: { x: n.position.x + 36, y: n.position.y + 36 },
        selected: true,
      };
    });
    const newEdges = clipboard.edges.map((e) => {
      const source = idMap.get(e.source) as string;
      const target = idMap.get(e.target) as string;
      return {
        ...structuredClone(e),
        id: edgeId(source, e.sourceHandle ?? '', target, e.targetHandle ?? ''),
        source,
        target,
        selected: false,
      };
    });
    set((st) => ({
      nodes: [...st.nodes.map((n) => ({ ...n, selected: false })), ...newNodes],
      edges: [...st.edges, ...newEdges],
      dirty: true,
    }));
  },

  updateParam: (nodeId, key, value) => {
    get().pushHistory(`param:${nodeId}:${key}`);
    set((s) => ({
      nodes: s.nodes.map((n) =>
        n.id === nodeId ? { ...n, data: { ...n.data, config: { ...n.data.config, [key]: value } } } : n,
      ),
      dirty: true,
    }));
  },

  setMeta: (meta) => {
    get().pushHistory('meta');
    set((s) => ({ meta: { ...s.meta, ...meta }, dirty: true }));
  },

  loadDoc: (path, doc, issues) => {
    const nodes: AppNode[] = doc.nodes.map((n, i) => ({
      id: n.id,
      type: 'archnode',
      position: doc.layout[n.id] ?? { x: 120 + (i % 4) * 300, y: 120 + Math.floor(i / 4) * 220 },
      data: { typeId: n.type, version: n.version, config: structuredClone(n.config) },
    }));
    const edges: AppEdge[] = doc.edges.map((e) => ({
      id: edgeId(e.from.node, e.from.port, e.to.node, e.to.port),
      source: e.from.node,
      sourceHandle: e.from.port,
      target: e.to.node,
      targetHandle: e.to.port,
    }));
    set({
      meta: { name: doc.meta.name, ...(doc.meta.description ? { description: doc.meta.description } : {}) },
      nodes,
      edges,
      filePath: path,
      dirty: false,
      docIssues: issues,
      past: [],
      future: [],
      run: emptyRun(),
      inspectedNodeId: null,
    });
  },

  newDoc: () => {
    set({
      meta: { name: 'Untitled workflow' },
      nodes: [],
      edges: [],
      filePath: null,
      dirty: false,
      docIssues: [],
      past: [],
      future: [],
      run: emptyRun(),
      inspectedNodeId: null,
    });
  },

  buildDoc: () => {
    const s = get();
    return {
      meta: { name: s.meta.name || 'Untitled workflow', ...(s.meta.description ? { description: s.meta.description } : {}) },
      requires: { mcp: [], ai: [], plugins: [] }, // derived by the serializer on save
      nodes: s.nodes.map((n) => ({
        id: n.id,
        type: n.data.typeId,
        version: n.data.version,
        config: structuredClone(n.data.config),
      })),
      edges: s.edges.map((e) => ({
        from: { node: e.source, port: e.sourceHandle ?? '' },
        to: { node: e.target, port: e.targetHandle ?? '' },
      })),
      layout: Object.fromEntries(
        s.nodes.map((n) => [n.id, { x: Math.round(n.position.x), y: Math.round(n.position.y) }]),
      ),
    };
  },

  markSaved: (path) => set({ filePath: path, dirty: false }),

  buildGraph: () => {
    const s = get();
    return {
      nodes: s.nodes.map((n) => ({
        id: n.id,
        type: n.data.typeId,
        version: n.data.version,
        config: structuredClone(n.data.config),
      })),
      edges: s.edges.map((e) => ({
        from: { node: e.source, port: e.sourceHandle ?? '' },
        to: { node: e.target, port: e.targetHandle ?? '' },
      })),
    };
  },

  runStarted: (runId) =>
    set({
      run: { ...emptyRun(), runId, running: true, startedAt: Date.now() },
    }),

  runRejected: (runId, issues) =>
    set((s) =>
      s.run.runId === runId
        ? { run: { ...s.run, running: false, status: 'failed', rejectedIssues: issues } }
        : {},
    ),

  applyRunEvent: (runId, event) => {
    const s = get();
    if (s.run.runId !== runId) return;
    const run = { ...s.run };
    run.events = [...run.events.slice(-(EVENT_LOG_CAP - 1)), event];
    const setNode = (nodeId: string, status: NodeRunStatus) => {
      run.nodeStatus = { ...run.nodeStatus, [nodeId]: status };
    };
    switch (event.type) {
      case 'run:started':
        break;
      case 'node:queued':
        setNode(event.nodeId, { phase: 'pending' });
        break;
      case 'node:started':
        setNode(event.nodeId, { phase: 'running', attempt: event.attempt, retrying: event.attempt > 1 });
        break;
      case 'node:progress': {
        const cur = run.nodeStatus[event.nodeId] ?? { phase: 'running' as const };
        setNode(event.nodeId, {
          ...cur,
          ...(event.fraction !== undefined ? { progress: event.fraction } : {}),
          ...(event.message !== undefined ? { progressMessage: event.message } : {}),
        });
        break;
      }
      case 'node:log':
        break;
      case 'node:succeeded':
        setNode(event.nodeId, { phase: 'complete', cached: event.cached });
        run.previews = { ...run.previews, [event.nodeId]: event.outputPreviews };
        break;
      case 'node:failed':
        if (event.willRetry) {
          setNode(event.nodeId, { phase: 'running', attempt: event.attempt, retrying: true, error: event.message });
        } else {
          setNode(event.nodeId, { phase: 'failed', error: event.message, attempt: event.attempt });
        }
        break;
      case 'node:skipped':
        setNode(event.nodeId, { phase: 'skipped', skipReason: event.reason });
        break;
      case 'run:finished':
        run.running = false;
        run.status = event.status;
        run.stats = event.stats;
        break;
    }
    set({ run });
  },

  engineDown: () => {
    const s = get();
    // Everything these arrays described — open MCP sessions, running plugin
    // children, a configured gateway — belonged to the process that just died.
    // Keeping the last snapshot on screen would draw a dead server as
    // "connected"; the replacement child pushes a fresh snapshot on `hello`.
    set({ mcpServers: [], plugins: [], aiProfiles: [] });
    if (s.run.running) {
      set({ run: { ...s.run, running: false, status: 'failed' } });
      s.notify('error', 'The engine process crashed and was restarted. The run was aborted.');
    }
  },

  setInspected: (nodeId) => set({ inspectedNodeId: nodeId }),
}));
