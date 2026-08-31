/**
 * Renderer side of the renderer ⇄ engine MessagePort channel.
 * Main brokers the port; after that, events stream here directly.
 *
 * Two shapes of traffic share this one port, and they are handled differently:
 *
 *  - **Pushes** — `manifests`, `event`, `mcp-status`, `plugin-status`,
 *    `ai-status`. Unsolicited whole snapshots. They land in the store and the
 *    UI re-renders; nothing waits on them. The engine re-pushes on every change
 *    it makes, so the store stays a mirror of the engine's truth rather than a
 *    second copy the renderer maintains (§7.6 — events in, UI out).
 *  - **Requests** — `mcp-connect`, `plugin-set-enabled`, `ai-probe` and their
 *    siblings, each carrying a `requestId` the engine echoes back. A settings
 *    panel has to know whether its "Connect" button worked and, when it did
 *    not, why; a pending map turns that correlation into ordinary promises so
 *    the panels can `await` and `catch` like any other async call.
 *
 * Deliberately NOT here: a timeout on pending requests. Connecting a remote MCP
 * server can open the browser for an OAuth 2.1 flow (§9.2) and legitimately
 * take minutes, so a timer would report a false failure over a flow that is
 * still running. Pending requests are instead rejected the moment an answer
 * becomes impossible — when the port they were sent on dies.
 */
import type { EngineGraph } from '@archspace/engine';
import type { ProfileProbeResult } from '@archspace/ai-gateway';
import { ENGINE_PORT_MESSAGE } from '../../shared/protocol';
import { explainRejection } from './rejection';
import type { EngineRequest, EngineResponse } from '../../shared/protocol';
import { useStore } from './store';

let port: MessagePort | null = null;

function send(msg: EngineRequest): void {
  if (!port) {
    useStore.getState().notify('error', 'Engine is not connected yet.');
    return;
  }
  port.postMessage(msg);
}

// ---------------------------------------------------------------------------
// Request/response correlation
// ---------------------------------------------------------------------------

interface Pending<T> {
  resolve(value: T): void;
  reject(reason: Error): void;
}

/**
 * One counter for every kind of request. The protocol scopes `requestId` per
 * message kind, but a single sequence costs nothing and removes the only way
 * this file could ever settle the wrong promise.
 */
let requestSeq = 0;

/** `mcp-result` / `plugin-result`: an acknowledgement, or an error to raise. */
const pendingAck = new Map<number, Pending<void>>();
/** `ai-probe-result`: always a result object, never a rejection (see below). */
const pendingProbe = new Map<number, Pending<ProfileProbeResult>>();

function request<T>(map: Map<number, Pending<T>>, build: (requestId: number) => EngineRequest): Promise<T> {
  const live = port;
  if (!live) return Promise.reject(new Error('The engine is not connected yet.'));
  const requestId = ++requestSeq;
  // The executor runs synchronously, so the entry is registered before the
  // message goes out and a same-tick reply cannot arrive unclaimed.
  const promise = new Promise<T>((resolve, reject) => map.set(requestId, { resolve, reject }));
  live.postMessage(build(requestId));
  return promise;
}

/** The engine child that owed these answers is gone; nothing will ever reply. */
function failPending(reason: string): void {
  const err = new Error(reason);
  for (const pending of pendingAck.values()) pending.reject(err);
  for (const pending of pendingProbe.values()) pending.reject(err);
  pendingAck.clear();
  pendingProbe.clear();
}

function settleAck(requestId: number, ok: boolean, error?: string): void {
  const pending = pendingAck.get(requestId);
  if (!pending) return;
  pendingAck.delete(requestId);
  if (ok) pending.resolve();
  else pending.reject(new Error(error ?? 'the engine did not say why'));
}

// ---------------------------------------------------------------------------
// Inbound
// ---------------------------------------------------------------------------

function handleResponse(msg: EngineResponse): void {
  const store = useStore.getState();
  switch (msg.t) {
    case 'manifests':
      store.setManifests(msg.manifests, msg.schemaHashes);
      // The registry only changes when the config lands, an MCP server's tools
      // change, or the plugin set changes — the same moments the status panels
      // care about. Asking again here is what fills the plugins panel at all:
      // at `hello` time the engine's plugin host does not exist yet (main
      // creates it by pushing `config` down the control channel), so the
      // hello-time plugin push is skipped entirely. Neither request causes a
      // manifests push, so there is no loop.
      requestEngineStatus();
      break;
    case 'event':
      store.applyRunEvent(msg.runId, msg.event);
      break;
    case 'run-rejected':
      store.runRejected(msg.runId, msg.issues);
      // Not just the engine's verdict: when the missing node type belongs to a
      // plugin that is installed but not enabled — which is the state a fresh
      // install is in, with the bundled example open — say so and name the
      // screen that fixes it. See rejection.ts.
      store.notify('error', `Run refused: ${explainRejection(msg.issues, store.nodes, store.plugins)}`);
      break;
    case 'validated':
      break;
    case 'mcp-status':
      store.setMcpServers(msg.servers);
      break;
    case 'plugin-status':
      store.setPlugins(msg.plugins);
      break;
    case 'ai-status':
      store.setAiProfiles(msg.profiles);
      break;
    case 'mcp-result':
    case 'plugin-result':
      settleAck(msg.requestId, msg.ok, msg.error);
      break;
    case 'ai-probe-result':
      // A probe that failed is a RESULT, not a broken call: `ok: false` with an
      // error the panel shows next to the profile. Only a dead engine rejects.
      pendingProbe.get(msg.requestId)?.resolve(msg.result);
      pendingProbe.delete(msg.requestId);
      break;
  }
}

export function initEngineClient(): void {
  window.addEventListener('message', (e: MessageEvent) => {
    if (e.data?.type !== ENGINE_PORT_MESSAGE) return;
    const newPort = e.ports[0];
    if (!newPort) return;
    port?.close();
    failPending('The engine connection was replaced before this request was answered.');
    port = newPort;
    port.onmessage = (ev) => handleResponse(ev.data as EngineResponse);
    port.postMessage({ t: 'hello' } satisfies EngineRequest);
  });

  window.archspace.onEngineRestarted(() => {
    useStore.getState().engineDown();
    port = null;
    failPending('The engine process crashed before this request was answered.');
    window.archspace.requestEnginePort();
  });

  window.archspace.onEngineGaveUp((restarts) => {
    // The end of the road: main has stopped restarting. Requesting a port
    // again would hang forever, so the one useful thing left is to say so.
    useStore.getState().engineDown();
    port = null;
    failPending('The engine stopped and could not be restarted.');
    useStore
      .getState()
      .notify(
        'error',
        `The engine stopped ${restarts} times in a row and is no longer being restarted. ` +
          'Nothing can run until Archspace is reopened.',
      );
  });

  window.archspace.requestEnginePort();
}

// ---------------------------------------------------------------------------
// Runs
// ---------------------------------------------------------------------------

let runSeq = 0;

export function startWorkflowRun(): void {
  const store = useStore.getState();
  if (store.run.running) {
    store.notify('warn', 'A run is already active — cancel it first (one run at a time in v1).');
    return;
  }
  if (store.nodes.length === 0) {
    store.notify('warn', 'Nothing to run — the canvas is empty.');
    return;
  }
  const graph: EngineGraph = store.buildGraph();
  const runId = `run_${Date.now().toString(36)}_${(runSeq++).toString(36)}`;
  store.runStarted(runId);
  send({ t: 'run', runId, graph });
}

/**
 * Run a graph the renderer built rather than one the canvas holds.
 *
 * The design chat's entry point. It is deliberately the same `run` message and
 * the same single-run state as the canvas: the engine has one notion of a run
 * (§7.6), and giving the chat a private one would mean two things claiming the
 * status light. The caller keeps the returned id to recognise its own events.
 *
 * Returns null when a run is already active, which the caller reports in its
 * own words — the canvas says "cancel it first", and a chat should not.
 */
export function startGraphRun(graph: EngineGraph): string | null {
  const store = useStore.getState();
  if (store.run.running) return null;
  const runId = `run_${Date.now().toString(36)}_${(runSeq++).toString(36)}`;
  store.runStarted(runId);
  send({ t: 'run', runId, graph });
  return runId;
}

export function cancelWorkflowRun(): void {
  const store = useStore.getState();
  if (store.run.runId && store.run.running) {
    send({ t: 'cancel', runId: store.run.runId });
  }
}

// ---------------------------------------------------------------------------
// Settings surface
// ---------------------------------------------------------------------------

/**
 * Re-ask the engine for all three status snapshots.
 *
 * This is the settings-applied path. A panel writes settings through the
 * bridge; main persists the file and pushes the new `config` down the CONTROL
 * channel (`EngineControlRequest`), and the engine answers that with pushes of
 * its own. But those pushes cross a different port than this one, so nothing
 * orders them against the IPC reply the panel just awaited. Asking again costs
 * three small messages and removes the race.
 *
 * Silent when the engine is not connected: the panels already have `engineReady`
 * to say so once, in the UI, rather than raising a notice per attempt.
 */
export function requestEngineStatus(): void {
  if (!port) return;
  port.postMessage({ t: 'mcp-status' } satisfies EngineRequest);
  port.postMessage({ t: 'plugin-status' } satisfies EngineRequest);
  port.postMessage({ t: 'ai-status' } satisfies EngineRequest);
}

/** Dial one MCP server by logical name. Rejects with the engine's reason. */
export function connectMcpServer(name: string): Promise<void> {
  return request(pendingAck, (requestId) => ({ t: 'mcp-connect', requestId, name }));
}

/** Spec shutdown of one server's session; the binding stays configured. */
export function disconnectMcpServer(name: string): Promise<void> {
  return request(pendingAck, (requestId) => ({ t: 'mcp-disconnect', requestId, name }));
}

/** Re-read `tools/list` and re-check drift (ADR-0009 §5). */
export function refreshMcpServer(name: string): Promise<void> {
  return request(pendingAck, (requestId) => ({ t: 'mcp-refresh', requestId, name }));
}

/**
 * Enable/disable one installed plugin. Consent is main's to PERSIST — call
 * `window.archspace.setPluginConsent` for that; this only asks the engine to
 * apply the change now so the node library updates without a restart.
 */
export function setPluginEnabled(id: string, enabled: boolean): Promise<void> {
  return request(pendingAck, (requestId) => ({ t: 'plugin-set-enabled', requestId, id, enabled }));
}

/** Re-discover the plugin directories — after an install or an uninstall. */
export function reloadPlugins(): Promise<void> {
  return request(pendingAck, (requestId) => ({ t: 'plugin-reload', requestId }));
}

/**
 * Probe one AI profile end to end: a real, minimal provider call, whose sample
 * text is the proof it happened (ARCHITECTURE §10 — nothing in this UI may
 * claim a provider works without having called it). Resolves for a failed probe
 * too; read `result.ok` and `result.error`.
 */
export function probeAiProfile(profile: string): Promise<ProfileProbeResult> {
  return request(pendingProbe, (requestId) => ({ t: 'ai-probe', requestId, profile }));
}
