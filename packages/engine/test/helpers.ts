/** Shared test fixtures: tiny simulated node modules + event helpers
 *  (ADR-0013 deterministic engine suite). */
import { expect } from 'vitest';
import {
  createNodeRegistry,
  markRetryable,
  type JsonSchemaObject,
  type Lane,
  type NodeModule,
  type NodeRegistry,
  type PortDecl,
  type Value,
} from '@archspace/node-sdk';
import type {
  EngineEdgeSpec,
  EngineGraph,
  EngineNodeSpec,
  RunEvent,
  RunHandle,
  RunResult,
  SchedulerHooks,
  VirtualScheduler,
} from '../src/index';

// ---------------------------------------------------------------------------
// Module factories
// ---------------------------------------------------------------------------

interface ModSpec {
  type: string;
  lane?: Lane;
  caching?: 'pure' | 'never';
  inputs?: PortDecl[];
  outputs?: PortDecl[];
  params?: JsonSchemaObject;
  execute: NodeModule['execute'];
}

export function mod(spec: ModSpec): NodeModule {
  return {
    manifest: {
      type: spec.type,
      version: 1,
      label: spec.type,
      description: 'simulated test node',
      category: 'test',
      params: spec.params ?? { type: 'object', properties: {} },
      inputs: spec.inputs ?? [],
      outputs: spec.outputs ?? [],
      caching: spec.caching ?? 'never',
      ...(spec.lane !== undefined ? { lane: spec.lane } : {}),
    },
    execute: spec.execute,
  };
}

/** Pure (by default) source node: emits its `value` param on port `out`. */
export function source(type: string, outType: string, caching: 'pure' | 'never' = 'pure') {
  let count = 0;
  const module = mod({
    type,
    caching,
    params: { type: 'object', properties: { value: {} } },
    outputs: [{ id: 'out', type: outType }],
    execute: async (_ctx, _inputs, params) => {
      count++;
      return { out: (params as { value: Value }).value };
    },
  });
  return { module, executions: () => count };
}

/** Node that awaits `hooks.delay(ms)`; wired to ctx.signal unless told not to. */
export function sleeper(
  type: string,
  ms: number,
  hooks: SchedulerHooks,
  opts: { lane?: Lane; useSignal?: boolean; caching?: 'pure' | 'never' } = {},
) {
  let count = 0;
  const module = mod({
    type,
    lane: opts.lane,
    caching: opts.caching,
    outputs: [{ id: 'out', type: 'text' }],
    execute: async (ctx) => {
      count++;
      await hooks.delay(ms, opts.useSignal === false ? undefined : ctx.signal);
      return { out: 'slept' };
    },
  });
  return { module, executions: () => count };
}

/** Fails its first `failures` executions (retryably marked by default). */
export function failOnAttempt(type: string, failures: number, opts: { retryable?: boolean } = {}) {
  let count = 0;
  const module = mod({
    type,
    outputs: [{ id: 'out', type: 'text' }],
    execute: async () => {
      count++;
      if (count <= failures) {
        const err = new Error(`boom on execution ${count}`);
        if (opts.retryable !== false) markRetryable(err);
        throw err;
      }
      return { out: 'recovered' };
    },
  });
  return { module, executions: () => count };
}

/** Pure transform that counts executions — the cacheProbe of ADR-0013. */
export function probe(
  type: string,
  inType: string,
  outType: string,
  fn: (v: Value) => Value,
  caching: 'pure' | 'never' = 'pure',
) {
  let count = 0;
  const module = mod({
    type,
    caching,
    inputs: [{ id: 'in', type: inType }],
    outputs: [{ id: 'out', type: outType }],
    execute: async (_ctx, inputs) => {
      count++;
      return { out: fn(inputs.in as Value) };
    },
  });
  return { module, executions: () => count };
}

/** Records the inputs it receives, for coercion/lift/variadic assertions. */
export function recorder(type: string, inputs: PortDecl[]) {
  const seen: Array<Record<string, Value | undefined>> = [];
  const module = mod({
    type,
    inputs,
    outputs: [{ id: 'out', type: 'json' }],
    execute: async (_ctx, ins) => {
      seen.push({ ...ins });
      return { out: null };
    },
  });
  return { module, seen };
}

// ---------------------------------------------------------------------------
// Graph builders
// ---------------------------------------------------------------------------

export function reg(...mods: NodeModule[]): NodeRegistry {
  const registry = createNodeRegistry();
  for (const m of mods) registry.register(m);
  return registry;
}

export function nodeSpec(id: string, type: string, config?: Record<string, unknown>): EngineNodeSpec {
  return { id, type, version: 1, ...(config !== undefined ? { config } : {}) };
}

export function edge(from: string, to: string): EngineEdgeSpec {
  const [fromNode, fromPort] = from.split('.');
  const [toNode, toPort] = to.split('.');
  return { from: { node: fromNode, port: fromPort }, to: { node: toNode, port: toPort } };
}

export function graph(nodes: EngineNodeSpec[], edges: EngineEdgeSpec[] = []): EngineGraph {
  return { nodes, edges };
}

// ---------------------------------------------------------------------------
// Event helpers
// ---------------------------------------------------------------------------

export function eventsOf(handle: RunHandle): RunEvent[] {
  const out: RunEvent[] = [];
  handle.onEvent((e) => out.push(e));
  return out;
}

export async function finish(vs: VirtualScheduler, handle: RunHandle): Promise<RunResult> {
  await vs.runAll();
  return handle.done;
}

export function ofType<K extends RunEvent['type']>(events: RunEvent[], type: K): Extract<RunEvent, { type: K }>[] {
  return events.filter((e): e is Extract<RunEvent, { type: K }> => e.type === type);
}

/** Event stream discipline (§7.6): gapless seq, started first, finished last. */
export function assertDiscipline(events: RunEvent[]): void {
  events.forEach((e, i) => {
    expect(e.v).toBe(1);
    expect(e.seq).toBe(i);
  });
  expect(events[0].type).toBe('run:started');
  expect(events[events.length - 1].type).toBe('run:finished');
  expect(ofType(events, 'run:started')).toHaveLength(1);
  expect(ofType(events, 'run:finished')).toHaveLength(1);
}
