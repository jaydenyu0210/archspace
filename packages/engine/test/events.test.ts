/** Required assertion 11: event stream discipline + a full golden event log
 *  for a small fixture graph (snapshot with `at` stripped). */
import { describe, expect, it } from 'vitest';
import { createVirtualScheduler, startRun, type RunEvent } from '../src/index';
import { assertDiscipline, edge, eventsOf, finish, graph, mod, nodeSpec, probe, reg, source } from './helpers';

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
