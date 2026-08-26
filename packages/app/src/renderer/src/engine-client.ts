/**
 * Renderer side of the renderer ⇄ engine MessagePort channel.
 * Main brokers the port; after that, events stream here directly.
 */
import type { EngineGraph } from '@archspace/engine';
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

function handleResponse(msg: EngineResponse): void {
  const store = useStore.getState();
  switch (msg.t) {
    case 'manifests':
      store.setManifests(msg.manifests);
      break;
    case 'event':
      store.applyRunEvent(msg.runId, msg.event);
      break;
    case 'run-rejected':
      store.runRejected(msg.runId, msg.issues);
      store.notify('error', `Run refused: ${msg.issues[0]?.message ?? 'validation failed'}`);
      break;
    case 'validated':
      break;
  }
}

export function initEngineClient(): void {
  window.addEventListener('message', (e: MessageEvent) => {
    if (e.data?.type !== 'archspace:engine-port') return;
    const newPort = e.ports[0];
    if (!newPort) return;
    port?.close();
    port = newPort;
    port.onmessage = (ev) => handleResponse(ev.data as EngineResponse);
    port.postMessage({ t: 'hello' } satisfies EngineRequest);
  });

  window.archspace.onEngineRestarted(() => {
    useStore.getState().engineDown();
    port = null;
    window.archspace.requestEnginePort();
  });

  window.archspace.requestEnginePort();
}

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

export function cancelWorkflowRun(): void {
  const store = useStore.getState();
  if (store.run.runId && store.run.running) {
    send({ t: 'cancel', runId: store.run.runId });
  }
}
