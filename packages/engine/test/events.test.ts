/** Required assertion 11: event stream discipline + a full golden event log
 *  for a small fixture graph (snapshot with `at` stripped). */
import { describe, expect, it } from 'vitest';
import { createRunCache, createVirtualScheduler, startRun, type RunEvent } from '../src/index.js';
import { assertDiscipline, edge, eventsOf, finish, graph, mod, nodeSpec, probe, reg, source } from './helpers.js';

const stripAt = (events: RunEvent[]) => events.map(({ at: _at, ...rest }) => rest);

describe('event stream discipline (§7.6)', () => {
  it('emits the exact golden event log for a two-node fixture graph', async () => {
    const vs = createVirtualScheduler(7);
    const src = source('test.const', 'text', 'never');
    const upper = probe('test.upper', 'text', 'text', (v) => (v as string).toUpperCase(), 'never');
    const g = graph(
      [nodeSpec('a', 'test.const', { value: 'hello' }), nodeSpec('b', 'test.upper')],
      [edge('a.out', 'b.in')],
    );
    const handle = startRun(g, { registry: reg(src.module, upper.module), scheduler: vs.hooks, runId: 'run_fixture' });
    const events = eventsOf(handle);

    const result = await finish(vs, handle);

    expect(handle.runId).toBe('run_fixture');
    expect(result.events).toEqual(events);
    expect(stripAt(events)).toEqual([
      { v: 1, seq: 0, type: 'run:started', runId: 'run_fixture', targets: ['a', 'b'] },
      { v: 1, seq: 1, type: 'node:queued', nodeId: 'a' },
      { v: 1, seq: 2, type: 'node:queued', nodeId: 'b' },
      { v: 1, seq: 3, type: 'node:started', nodeId: 'a', attempt: 1 },
      {
        v: 1,
        seq: 4,
        type: 'node:succeeded',
        nodeId: 'a',
        cached: false,
        durationMs: 0,
        outputPreviews: [{ port: 'out', type: 'text', preview: { kind: 'text', text: 'hello', truncated: false } }],
      },
      { v: 1, seq: 5, type: 'node:started', nodeId: 'b', attempt: 1 },
      {
        v: 1,
        seq: 6,
        type: 'node:succeeded',
        nodeId: 'b',
        cached: false,
        durationMs: 0,
        outputPreviews: [{ port: 'out', type: 'text', preview: { kind: 'text', text: 'HELLO', truncated: false } }],
      },
      {
        v: 1,
        seq: 7,
        type: 'run:finished',
        status: 'succeeded',
        stats: { total: 2, succeeded: 2, cached: 0, failed: 0, skipped: 0, durationMs: 0 },
      },
    ]);
    assertDiscipline(events);
  });

  it('queues demanded nodes in deterministic topological order with graph-order tie-breaks', async () => {
    const vs = createVirtualScheduler(1);
    const src = source('test.src', 'number', 'never');
    const pass = probe('test.pass', 'number', 'number', (v) => v, 'never');
    // Graph order: sink first, then sources. The queue order must respect the
    // dependency (m before sink) and otherwise take the smallest graph index
    // among available nodes: m first (tie with k broken by graph order), then
    // sink (index 0 beats k), then k.
    const g = graph(
      [nodeSpec('sink', 'test.pass'), nodeSpec('m', 'test.src', { value: 1 }), nodeSpec('k', 'test.src', { value: 2 })],
      [edge('m.out', 'sink.in')],
    );
    const handle = startRun(g, { registry: reg(src.module, pass.module), scheduler: vs.hooks, runId: 'r1' });
    const events = eventsOf(handle);

    await finish(vs, handle);

    const queued = events.filter((e) => e.type === 'node:queued').map((e) => (e as { nodeId: string }).nodeId);
    expect(queued).toEqual(['m', 'sink', 'k']);
  });

  it('late subscribers replay buffered events first, then receive live events', async () => {
    const vs = createVirtualScheduler(1);
    const sleepMod = mod({
      type: 'test.sleep',
      outputs: [{ id: 'out', type: 'text' }],
      execute: async (ctx) => {
        await vs.hooks.delay(50, ctx.signal);
        return { out: 'done' };
      },
    });
    const handle = startRun(graph([nodeSpec('n', 'test.sleep')]), { registry: reg(sleepMod), scheduler: vs.hooks, runId: 'r1' });

    await vs.advance(10); // run:started, queued, started are already buffered
    const seen: string[] = [];
    handle.onEvent((e) => seen.push(e.type));
    expect(seen).toEqual(['run:started', 'node:queued', 'node:started']); // replayed synchronously

    await finish(vs, handle);
    expect(seen).toEqual(['run:started', 'node:queued', 'node:started', 'node:succeeded', 'run:finished']);
  });

  it('handle.done resolves only after run:finished has been delivered to subscribers', async () => {
    const vs = createVirtualScheduler(1);
    const src = source('test.src', 'number', 'never');
    const handle = startRun(graph([nodeSpec('a', 'test.src', { value: 1 })]), {
      registry: reg(src.module),
      scheduler: vs.hooks,
      runId: 'r1',
    });
    let finishedSeen = false;
    handle.onEvent((e) => {
      if (e.type === 'run:finished') finishedSeen = true;
    });
    const result = await finish(vs, handle);
    expect(finishedSeen).toBe(true);
    expect(result.events[result.events.length - 1].type).toBe('run:finished');
  });

  it('stamps every event with the scheduler clock', async () => {
    const vs = createVirtualScheduler(1);
    const sleepMod = mod({
      type: 'test.sleep',
      outputs: [{ id: 'out', type: 'text' }],
      execute: async (ctx) => {
        await vs.hooks.delay(75, ctx.signal);
        return { out: 'done' };
      },
    });
    const handle = startRun(graph([nodeSpec('n', 'test.sleep')]), { registry: reg(sleepMod), scheduler: vs.hooks, runId: 'r1' });
    const events = eventsOf(handle);
    const result = await finish(vs, handle);
    expect(events.map((e) => [e.type, e.at])).toEqual([
      ['run:started', 0],
      ['node:queued', 0],
      ['node:started', 0],
      ['node:succeeded', 75],
      ['run:finished', 75],
    ]);
    expect(result.stats.durationMs).toBe(75);
  });
});

/**
 * A subscriber's fault is never the run's fault (§7.6).
 *
 * Both real subscribers can throw for reasons that have nothing to do with the
 * graph: the engine child posts every event to a MessagePort that is gone the
 * moment the window closes, and the CLI writes to a stdout that raises EPIPE
 * the moment it is piped into something that stops reading. Unguarded, each
 * one changed what the run reported — and in two different ways, which is why
 * both paths are tested here rather than one standing in for the other.
 */
describe('a subscriber that throws', () => {
  const oneNode = () =>
    graph([nodeSpec('a', 'test.src', { value: 'v' })]);

  it('does not turn a succeeded node into a failed one', async () => {
    // `emit` is called from inside the attempt loop's `try`, so a throwing
    // subscriber was caught by the NODE's handler and the node was reported
    // failed — a run marked partial because a window closed.
    const src = source('test.src', 'text');
    const vs = createVirtualScheduler(2);
    const handle = startRun(oneNode(), { registry: reg(src.module), scheduler: vs.hooks, runId: 'r', cache: createRunCache() });

    const seen: RunEvent[] = [];
    handle.onEvent((e) => {
      seen.push(e);
      if (e.type === 'node:succeeded') throw new Error('the renderer port is closed');
    });

    const result = await finish(vs, handle);
    expect(result.status).toBe('succeeded');
    expect(result.stats).toMatchObject({ failed: 0, succeeded: 1 });
    // The throwing subscriber still received everything, including the events
    // after the one it threw on.
    expect(seen.some((e) => e.type === 'run:finished')).toBe(true);
  });

  it('does not come back out of onEvent at the caller', async () => {
    // A run has always emitted `run:started` by the time anyone can subscribe,
    // so EVERY subscriber takes the replay path — which makes this the case
    // that fires first, and it used to throw straight back at the caller.
    const src = source('test.src', 'text');
    const vs = createVirtualScheduler(2);
    const handle = startRun(oneNode(), { registry: reg(src.module), scheduler: vs.hooks, runId: 'r', cache: createRunCache() });

    expect(() =>
      handle.onEvent(() => {
        throw new Error('the renderer port is closed');
      }),
    ).not.toThrow();

    expect((await finish(vs, handle)).status).toBe('succeeded');
  });

  it('leaves every other subscriber receiving the same stream', async () => {
    const src = source('test.src', 'text');
    const vs = createVirtualScheduler(2);
    const handle = startRun(oneNode(), { registry: reg(src.module), scheduler: vs.hooks, runId: 'r', cache: createRunCache() });

    const good: RunEvent[] = [];
    handle.onEvent(() => {
      throw new Error('always');
    });
    handle.onEvent((e) => good.push(e));

    await finish(vs, handle);
    assertDiscipline(good);
  });
});
