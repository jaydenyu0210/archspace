/** The run loop: demand-driven, laned, memoized, cancellable, event-sourced
 *  (ARCHITECTURE §7 / ADR-0007). Everything executes in-process in this build —
 *  nodes are plain async functions; there is no worker pool yet. */
import { mkdtemp, rm } from 'node:fs/promises';
import { availableParallelism, tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  MemoryAssetStore,
  applySchemaDefaults,
  isRetryableError,
  markRetryable,
  type AiGateway,
  type AssetStore,
  type Inputs,
  type LogLevel,
  type NodeContext,
  type NodeManifest,
  type NodeRegistry,
  type Outputs,
  type PortDecl,
  type Value,
} from '@archspace/node-sdk';
import { applyAssignability, assignable, isValueOfType, parsePortType } from '@archspace/types';
import { canonicalJson, hashValue } from './canonical';
import { createRunCache, type RunCache } from './cache';
import { edgeLabel, type EngineEdgeSpec, type EngineGraph, type EngineNodeSpec } from './graph';
import { outputPreviews, type OutputPreview } from './preview';
import { createRealSchedulerHooks, type SchedulerHooks } from './scheduler';
import { GraphValidationError, validateGraph, type ValidationIssue } from './validate';

// ---------------------------------------------------------------------------
// Public run types
// ---------------------------------------------------------------------------

export type NodeFailureKind = 'invalid-input' | 'error' | 'timeout' | 'cancelled';
export type RunStatus = 'succeeded' | 'failed' | 'partial' | 'cancelled';

export interface RunStats {
  total: number;
  succeeded: number;
  cached: number;
  failed: number;
  skipped: number;
  durationMs: number;
}

type RunEventBody =
  | { type: 'run:started'; runId: string; targets: string[] }
  | { type: 'node:queued'; nodeId: string }
  | { type: 'node:started'; nodeId: string; attempt: number }
  | { type: 'node:progress'; nodeId: string; fraction?: number; message?: string }
  | { type: 'node:log'; nodeId: string; level: LogLevel; message: string; data?: Value }
  | { type: 'node:succeeded'; nodeId: string; cached: boolean; durationMs: number; outputPreviews: OutputPreview[] }
  | { type: 'node:failed'; nodeId: string; kind: NodeFailureKind; message: string; willRetry: boolean; attempt: number }
  | { type: 'node:skipped'; nodeId: string; reason: string } // "upstream failed" | "cancelled"
  | { type: 'run:finished'; status: RunStatus; stats: RunStats };

export type RunEvent = { v: 1; seq: number; at: number } & RunEventBody;

export interface RunOptions {
  registry: NodeRegistry;
  runId?: string;
  targets?: string[]; // node ids; default = every node in the graph
  assets?: AssetStore; // default: fresh MemoryAssetStore
  cache?: RunCache; // pass the same instance across runs to get memoization
  ai?: AiGateway; // default: stub whose methods throw
  laneCaps?: Record<string, number>; // override lane concurrency caps
  scheduler?: SchedulerHooks; // default: real clock/timers/Math.random
}

export interface RunResult {
  status: RunStatus;
  events: RunEvent[];
  stats: RunStats;
}

export interface RunHandle {
  runId: string;
  onEvent(cb: (e: RunEvent) => void): () => void;
  cancel(): void;
  done: Promise<RunResult>;
}

// ---------------------------------------------------------------------------
// Constants & small helpers
// ---------------------------------------------------------------------------

const ENGINE_ABI = 1;
const MAX_ATTEMPTS = 3;
const BACKOFF_BASE_MS = 500;
const JITTER_MS = 250;
const LOG_DATA_CAP = 8_000;
const AI_STUB_MESSAGE = 'AI gateway is not configured in this build';

function createAiStub(): AiGateway {
  const fail = (): never => {
    throw new Error(AI_STUB_MESSAGE);
  };
  return {
    generateText: async () => fail(),
    generateObject: async () => fail(),
    embed: async () => fail(),
  };
}

function generateRunId(random: () => number): string {
  const alphabet = '0123456789abcdefghjkmnpqrstvwxyz';
  let id = '';
  for (let i = 0; i < 12; i++) id += alphabet[Math.floor(random() * alphabet.length) % alphabet.length];
  return `run_${id}`;
}

function describeValue(value: unknown): string {
  if (value === undefined) return 'undefined';
  const json = canonicalJson(value);
  return json.length > 120 ? `${json.slice(0, 120)}…` : json;
}

class InvalidInputError extends Error {}

// ---------------------------------------------------------------------------
// startRun
// ---------------------------------------------------------------------------

export function startRun(graph: EngineGraph, opts: RunOptions): RunHandle {
  const registry = opts.registry;

  // Hard validation — refuse to start on any severity-'error' issue.
  const issues = validateGraph(graph, registry);
  if (issues.some((i) => i.severity === 'error')) throw new GraphValidationError(issues);

  const specById = new Map(graph.nodes.map((n) => [n.id, n] as const));

  // Targets: default = whole graph; unknown ids are a validation error too.
  const targets = [...new Set(opts.targets ?? graph.nodes.map((n) => n.id))];
  const targetIssues: ValidationIssue[] = targets
    .filter((t) => !specById.has(t))
    .map((t) => ({
      severity: 'error' as const,
      code: 'unknown-target',
      message: `run target "${t}" is not a node in the graph`,
    }));
  if (targetIssues.length > 0) throw new GraphValidationError([...issues, ...targetIssues]);

  // Graph shape indexes.
  const upstreamOf = new Map<string, Set<string>>();
  const downstreamOf = new Map<string, Set<string>>();
  for (const edge of graph.edges) {
    (upstreamOf.get(edge.to.node) ?? upstreamOf.set(edge.to.node, new Set()).get(edge.to.node)!).add(edge.from.node);
    (downstreamOf.get(edge.from.node) ?? downstreamOf.set(edge.from.node, new Set()).get(edge.from.node)!).add(edge.to.node);
  }

  // Demand: ancestor closure of the targets. Nodes outside emit no events.
  const demanded = new Set<string>();
  const wave = [...targets];
  while (wave.length > 0) {
    const id = wave.pop()!;
    if (demanded.has(id)) continue;
    demanded.add(id);
    for (const up of upstreamOf.get(id) ?? []) wave.push(up);
  }

  // Deterministic topological order over the demanded subgraph
  // (Kahn's algorithm; ties broken by graph order).
  const graphIndex = new Map(graph.nodes.map((n, i) => [n.id, i] as const));
  const demandedTopo: string[] = [];
  const topoIndex = new Map<string, number>();
  {
    const indeg = new Map<string, number>();
    for (const id of demanded) {
      indeg.set(id, [...(upstreamOf.get(id) ?? [])].filter((u) => demanded.has(u)).length);
    }
    const placed = new Set<string>();
    while (demandedTopo.length < demanded.size) {
      let pick: string | undefined;
      for (const id of demanded) {
        if (placed.has(id) || indeg.get(id)! > 0) continue;
        if (pick === undefined || graphIndex.get(id)! < graphIndex.get(pick)!) pick = id;
      }
      /* v8 ignore next -- unreachable: cycles were rejected at validation */
      if (pick === undefined) break;
      placed.add(pick);
      topoIndex.set(pick, demandedTopo.length);
      demandedTopo.push(pick);
      for (const down of downstreamOf.get(pick) ?? []) {
        if (demanded.has(down)) indeg.set(down, indeg.get(down)! - 1);
      }
    }
  }

  // Per-node incoming edges grouped by input port, in graph.edges order
  // (variadic delivery order is edge order).
  const incomingByPort = new Map<string, Map<string, EngineEdgeSpec[]>>();
  for (const edge of graph.edges) {
    if (!demanded.has(edge.to.node)) continue;
    let ports = incomingByPort.get(edge.to.node);
    if (!ports) incomingByPort.set(edge.to.node, (ports = new Map()));
    const list = ports.get(edge.to.port) ?? [];
    list.push(edge);
    ports.set(edge.to.port, list);
  }

  const manifestById = new Map<string, NodeManifest>();
  for (const id of demanded) manifestById.set(id, registry.get(specById.get(id)!.type)!.manifest);

  // Dependency bookkeeping for the ready set.
  const remainingDeps = new Map<string, number>();
  const dependents = new Map<string, Set<string>>();
  for (const id of demanded) {
    const ups = [...(upstreamOf.get(id) ?? [])].filter((u) => demanded.has(u));
    remainingDeps.set(id, ups.length);
    for (const up of ups) {
      (dependents.get(up) ?? dependents.set(up, new Set()).get(up)!).add(id);
    }
  }

  // Run services.
  const hooks: SchedulerHooks = opts.scheduler ?? createRealSchedulerHooks();
  const runId = opts.runId ?? generateRunId(hooks.random);
  const cache: RunCache = opts.cache ?? createRunCache();
  const assets: AssetStore = opts.assets ?? new MemoryAssetStore();
  const ai: AiGateway = opts.ai ?? createAiStub();
  const abort = new AbortController();
  const signal = abort.signal;
  const tempDirs: string[] = [];

  const defaultCpuCap = Math.max(1, Math.min(8, availableParallelism() - 1));
  function capFor(lane: string): number {
    const override = opts.laneCaps?.[lane];
    if (override !== undefined) return Math.max(1, Math.floor(override));
    if (lane === 'cpu') return defaultCpuCap;
    if (lane === 'io') return 16;
    if (lane === 'ai') return 4;
    return 1; // every mcp:* lane (and anything unknown) is serial by default
  }
  const laneOf = (id: string) => manifestById.get(id)!.lane ?? 'cpu';
  const laneRunning = new Map<string, number>();

  // Event stream.
  const events: RunEvent[] = [];
  const subscribers = new Set<(e: RunEvent) => void>();
  let seq = 0;
  function emit(body: RunEventBody): void {
    const event = { v: 1, seq: seq++, at: hooks.now(), ...body } as RunEvent;
    events.push(event);
    for (const cb of [...subscribers]) cb(event);
  }

  // Node state.
  type NodeState = 'pending' | 'running' | 'done';
  type NodeOutcome = 'succeeded' | 'cached' | 'failed' | 'skipped';
  const state = new Map<string, NodeState>();
  const outcome = new Map<string, NodeOutcome>();
  for (const id of demanded) state.set(id, 'pending');
  const outputsByNode = new Map<string, Outputs>();

  let cancelRequested = false;
  let finished = false;
  let resolveDone!: (result: RunResult) => void;
  const done = new Promise<RunResult>((resolve) => {
    resolveDone = resolve;
  });

  // -------------------------------------------------------------------------
  // Input assembly (§7 "input assembly")
  // -------------------------------------------------------------------------

  function deliverEdge(edge: EngineEdgeSpec, toPort: PortDecl): Value {
    const fromManifest = manifestById.get(edge.from.node)!;
    const fromPort = fromManifest.outputs.find((p) => p.id === edge.from.port)!;
    const value = outputsByNode.get(edge.from.node)![edge.from.port] as Value;
    const a = assignable(fromPort.type, toPort.type);
    /* v8 ignore next -- unreachable: edges were validated before the run */
    if (!a.ok) throw new InvalidInputError(`edge ${edgeLabel(edge)}: ${a.reason}`);
    if (a.kind === 'unchecked') {
      if (!isValueOfType(value, toPort.type)) {
        throw new InvalidInputError(
          `edge ${edgeLabel(edge)} delivered a value that does not match the expected type ` +
            `"${toPort.type}": got ${describeValue(value)}`,
        );
      }
      return value;
    }
    return applyAssignability(value, a) as Value;
  }

  function assembleInputs(nodeId: string, manifest: NodeManifest): Record<string, Value | undefined> {
    const inputs: Record<string, Value | undefined> = {};
    const ports = incomingByPort.get(nodeId);
    for (const port of manifest.inputs) {
      const edges = ports?.get(port.id) ?? [];
      if (port.variadic) {
        inputs[port.id] = edges.length > 0 ? edges.map((e) => deliverEdge(e, port)) : undefined;
      } else if (edges.length === 1) {
        inputs[port.id] = deliverEdge(edges[0], port);
      } else {
        inputs[port.id] = undefined; // optional and unconnected
      }
    }
    return inputs;
  }

  // -------------------------------------------------------------------------
  // Output contract (§7 "execution")
  // -------------------------------------------------------------------------

  function checkOutputs(manifest: NodeManifest, out: unknown): asserts out is Outputs {
    if (typeof out !== 'object' || out === null || Array.isArray(out)) {
      throw new Error(`node returned ${describeValue(out)} instead of an outputs object`);
    }
    const record = out as Record<string, unknown>;
    for (const port of manifest.outputs) {
      if (!(port.id in record) || record[port.id] === undefined) {
        throw new Error(`node did not produce declared output "${port.id}"`);
      }
      const parsed = parsePortType(port.type);
      if (parsed?.kind === 'primitive' && parsed.name === 'number') {
        const value = record[port.id];
        if (typeof value !== 'number' || !Number.isFinite(value)) {
          throw new Error(`output "${port.id}" must be a finite number, got ${describeValue(value)}`);
        }
      }
    }
  }

  // -------------------------------------------------------------------------
  // NodeContext
  // -------------------------------------------------------------------------

  function makeContext(nodeId: string): NodeContext {
    let temp: string | undefined;
    return {
      signal,
      runId,
      nodeId,
      log(level, message, data) {
        const body: Extract<RunEventBody, { type: 'node:log' }> = { type: 'node:log', nodeId, level, message };
        if (data !== undefined && canonicalJson(data).length <= LOG_DATA_CAP) body.data = data;
        emit(body);
      },
      progress(fraction, message) {
        const body: Extract<RunEventBody, { type: 'node:progress' }> = { type: 'node:progress', nodeId };
        if (typeof fraction === 'number' && Number.isFinite(fraction)) {
          body.fraction = Math.min(1, Math.max(0, fraction));
        }
        if (message !== undefined) body.message = message;
        emit(body);
      },
      assets,
      secrets: {
        get: async () => {
          throw new Error('secrets are not available in this build');
        },
      },
      ai,
      tempDir: async () => {
        if (!temp) {
          temp = await mkdtemp(join(tmpdir(), 'archspace-'));
          tempDirs.push(temp);
        }
        return temp;
      },
      retryable: markRetryable,
    };
  }

  // -------------------------------------------------------------------------
  // Scheduling: ready-set worklist bounded per lane
  // -------------------------------------------------------------------------

  let pumping = false;
  let repump = false;
  function pump(): void {
    if (finished) return;
    if (pumping) {
      repump = true;
      return;
    }
    pumping = true;
    do {
      repump = false;
      if (!cancelRequested) {
        for (const id of demandedTopo) {
          if (state.get(id) !== 'pending' || remainingDeps.get(id)! > 0) continue;
          const lane = laneOf(id);
          const running = laneRunning.get(lane) ?? 0;
          if (running >= capFor(lane)) continue;
          laneRunning.set(lane, running + 1);
          state.set(id, 'running');
          executeNode(id).catch((err: unknown) => {
            /* v8 ignore start -- defensive: executeNode settles on every intended path */
            if (state.get(id) === 'done') return;
            emit({
              type: 'node:failed',
              nodeId: id,
              kind: 'error',
              message: `engine error: ${err instanceof Error ? err.message : String(err)}`,
              willRetry: false,
              attempt: 1,
            });
            settle(id, 'failed');
            /* v8 ignore stop */
          });
        }
      }
    } while (repump);
    pumping = false;
    checkFinished();
  }

  function settle(id: string, result: 'succeeded' | 'cached' | 'failed'): void {
    state.set(id, 'done');
    outcome.set(id, result);
    const lane = laneOf(id);
    laneRunning.set(lane, (laneRunning.get(lane) ?? 0) - 1);
    if (result === 'failed') {
      skipDescendants(id);
    } else {
      for (const dep of dependents.get(id) ?? []) {
        remainingDeps.set(dep, remainingDeps.get(dep)! - 1);
      }
    }
    pump();
  }

  /** A (finally) failed node marks every demanded descendant skipped —
   *  transitively — while independent branches keep running. */
  function skipDescendants(failedId: string): void {
    const toSkip: string[] = [];
    const seen = new Set<string>([failedId]);
    const wave2 = [failedId];
    while (wave2.length > 0) {
      const current = wave2.pop()!;
      for (const down of downstreamOf.get(current) ?? []) {
        if (!demanded.has(down) || seen.has(down)) continue;
        seen.add(down);
        wave2.push(down);
        if (state.get(down) === 'pending') toSkip.push(down);
      }
    }
    toSkip.sort((a, b) => topoIndex.get(a)! - topoIndex.get(b)!);
    for (const id of toSkip) {
      state.set(id, 'done');
      outcome.set(id, 'skipped');
      emit({ type: 'node:skipped', nodeId: id, reason: 'upstream failed' });
    }
  }

  function computeStats(): RunStats {
    let succeeded = 0;
    let cached = 0;
    let failed = 0;
    let skipped = 0;
    for (const id of demandedTopo) {
      switch (outcome.get(id)) {
        case 'succeeded':
          succeeded++;
          break;
        case 'cached':
          succeeded++;
          cached++;
          break;
        case 'failed':
          failed++;
          break;
        case 'skipped':
          skipped++;
          break;
      }
    }
    return { total: demandedTopo.length, succeeded, cached, failed, skipped, durationMs: hooks.now() - runStartAt };
  }

  function checkFinished(): void {
    if (finished) return;
    for (const id of demandedTopo) {
      if (state.get(id) !== 'done') return;
    }
    finished = true;
    const stats = computeStats();
    const status: RunStatus = cancelRequested
      ? 'cancelled' // cancellation wins
      : stats.failed > 0
        ? stats.succeeded > 0
          ? 'partial'
          : 'failed'
        : 'succeeded';
    emit({ type: 'run:finished', status, stats });
    resolveDone({ status, events: events.slice(), stats });
    // Temp dirs are cleaned up after the run; the run result never waits on I/O.
    if (tempDirs.length > 0) {
      void Promise.allSettled(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
    }
  }

  // -------------------------------------------------------------------------
  // Node execution: cache check, attempts, retry with backoff (§7.3, §7.5)
  // -------------------------------------------------------------------------

  async function executeNode(id: string): Promise<void> {
    const spec = specById.get(id)!;
    const mod = registry.get(spec.type)!;
    const manifest = mod.manifest;

    let inputs: Record<string, Value | undefined>;
    try {
      inputs = assembleInputs(id, manifest);
    } catch (err) {
      // A runtime type violation on an unchecked edge fails the RECEIVING node.
      emit({ type: 'node:started', nodeId: id, attempt: 1 });
      emit({
        type: 'node:failed',
        nodeId: id,
        kind: 'invalid-input',
        message: err instanceof Error ? err.message : String(err),
        willRetry: false,
        attempt: 1,
      });
      settle(id, 'failed');
      return;
    }

    const params = applySchemaDefaults(manifest.params, spec.config);

    // Memoization: only 'pure' manifests participate; effectful nodes always run.
    let cacheKey: string | undefined;
    if (manifest.caching === 'pure') {
      const inputHashes: Record<string, string> = {};
      for (const [portId, value] of Object.entries(inputs)) {
        if (value !== undefined) inputHashes[portId] = hashValue(value);
      }
      cacheKey = hashValue({
        engineAbi: ENGINE_ABI,
        type: spec.type,
        version: spec.version,
        params,
        inputs: inputHashes,
      } as Value);
      const hit = cache.get(cacheKey);
      if (hit !== undefined) {
        outputsByNode.set(id, hit);
        emit({
          type: 'node:succeeded',
          nodeId: id,
          cached: true,
          durationMs: 0,
          outputPreviews: outputPreviews(manifest, hit),
        });
        settle(id, 'cached');
        return;
      }
    }

    const ctx = makeContext(id);
    const frozenInputs: Inputs = inputs;

    for (let attempt = 1; ; attempt++) {
      /* v8 ignore start -- belt-and-braces: the backoff delay already rejects on abort */
      if (cancelRequested) {
        emit({ type: 'node:failed', nodeId: id, kind: 'cancelled', message: 'run was cancelled', willRetry: false, attempt });
        settle(id, 'failed');
        return;
      }
      /* v8 ignore stop */
      emit({ type: 'node:started', nodeId: id, attempt });
      const startedAt = hooks.now();
      try {
        const out: unknown = await mod.execute(ctx, frozenInputs, params);
        checkOutputs(manifest, out);
        const durationMs = hooks.now() - startedAt;
        if (cacheKey !== undefined) cache.set(cacheKey, out); // completed results stay valid, even after cancel
        outputsByNode.set(id, out);
        emit({
          type: 'node:succeeded',
          nodeId: id,
          cached: false,
          durationMs,
          outputPreviews: outputPreviews(manifest, out),
        });
        settle(id, 'succeeded');
        return;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const abortish = (err instanceof Error && err.name === 'AbortError') || signal.aborted;
        if (abortish) {
          emit({ type: 'node:failed', nodeId: id, kind: 'cancelled', message, willRetry: false, attempt });
          settle(id, 'failed');
          return;
        }
        const willRetry = attempt < MAX_ATTEMPTS && isRetryableError(err);
        emit({ type: 'node:failed', nodeId: id, kind: 'error', message, willRetry, attempt });
        if (!willRetry) {
          settle(id, 'failed');
          return;
        }
        const backoff = BACKOFF_BASE_MS * 2 ** (attempt - 1) + hooks.random() * JITTER_MS;
        try {
          await hooks.delay(backoff, signal);
        } catch {
          // Cancelled while waiting to retry.
          emit({
            type: 'node:failed',
            nodeId: id,
            kind: 'cancelled',
            message: 'run was cancelled during retry backoff',
            willRetry: false,
            attempt,
          });
          settle(id, 'failed');
          return;
        }
      }
    }
  }

  // -------------------------------------------------------------------------
  // Cancellation (§7.4)
  // -------------------------------------------------------------------------

  function cancel(): void {
    if (finished || cancelRequested) return;
    cancelRequested = true;
    // No node starts after cancel: everything still pending is skipped now.
    for (const id of demandedTopo) {
      if (state.get(id) === 'pending') {
        state.set(id, 'done');
        outcome.set(id, 'skipped');
        emit({ type: 'node:skipped', nodeId: id, reason: 'cancelled' });
      }
    }
    // In-flight nodes get the signal and are awaited (no force-kill in-process).
    abort.abort();
    checkFinished();
  }

  // -------------------------------------------------------------------------
  // Kick off
  // -------------------------------------------------------------------------

  emit({ type: 'run:started', runId, targets: targets.slice() });
  const runStartAt = events[0].at;
  for (const id of demandedTopo) emit({ type: 'node:queued', nodeId: id });
  pump();

  return {
    runId,
    onEvent(cb) {
      for (const event of events.slice()) cb(event); // late subscribers replay first
      subscribers.add(cb);
      return () => {
        subscribers.delete(cb);
      };
    },
    cancel,
    done,
  };
}
