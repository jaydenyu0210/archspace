/** Required assertions 1–3 (branch overlap, lane caps, mcp default) and
 *  8 (demand closure). */
import { describe, expect, it } from 'vitest';
import { createVirtualScheduler, startRun } from '../src/index';
import { assertDiscipline, edge, eventsOf, finish, graph, nodeSpec, ofType, probe, reg, sleeper, source } from './helpers';

describe('laned concurrency', () => {
  it('runs two independent same-lane nodes concurrently: 100 virtual ms, not 200', async () => {
    const vs = createVirtualScheduler(1);
    const sleep = sleeper('test.sleep', 100, vs.hooks);
    const g = graph([nodeSpec('a', 'test.sleep'), nodeSpec('b', 'test.sleep')]);
    const handle = startRun(g, { registry: reg(sleep.module), scheduler: vs.hooks, runId: 'r1', laneCaps: { cpu: 4 } });
    const events = eventsOf(handle);

    const result = await finish(vs, handle);

    expect(result.status).toBe('succeeded');
    const started = ofType(events, 'node:started');
    const succeeded = ofType(events, 'node:succeeded');
    expect(started.map((e) => e.nodeId).sort()).toEqual(['a', 'b']);
    // Both started before either succeeded — true branch overlap.
    expect(Math.max(...started.map((e) => e.seq))).toBeLessThan(Math.min(...succeeded.map((e) => e.seq)));
    expect(started.every((e) => e.at === 0)).toBe(true);
    expect(succeeded.every((e) => e.durationMs === 100)).toBe(true);
    expect(result.stats.durationMs).toBe(100);
    expect(vs.now()).toBe(100);
    assertDiscipline(events);
  });

  it('serializes the same two nodes under laneCaps { cpu: 1 }: 200 virtual ms', async () => {
    const vs = createVirtualScheduler(1);
    const sleep = sleeper('test.sleep', 100, vs.hooks);
    const g = graph([nodeSpec('a', 'test.sleep'), nodeSpec('b', 'test.sleep')]);
    const handle = startRun(g, { registry: reg(sleep.module), scheduler: vs.hooks, runId: 'r1', laneCaps: { cpu: 1 } });
    const events = eventsOf(handle);

    const result = await finish(vs, handle);

    expect(result.status).toBe('succeeded');
    const started = ofType(events, 'node:started');
    expect(started.map((e) => [e.nodeId, e.at])).toEqual([
      ['a', 0],
      ['b', 100],
    ]);
    expect(result.stats.durationMs).toBe(200);
    expect(vs.now()).toBe(200);
  });

  it('defaults every mcp:* lane to a cap of 1 without an override', async () => {
    const vs = createVirtualScheduler(1);
    const sleep = sleeper('test.msleep', 100, vs.hooks, { lane: 'mcp:revit' });
    const g = graph([nodeSpec('a', 'test.msleep'), nodeSpec('b', 'test.msleep')]);
    const handle = startRun(g, { registry: reg(sleep.module), scheduler: vs.hooks, runId: 'r1' });
    const events = eventsOf(handle);

    const result = await finish(vs, handle);

    expect(result.status).toBe('succeeded');
    expect(ofType(events, 'node:started').map((e) => e.at)).toEqual([0, 100]);
    expect(result.stats.durationMs).toBe(200);
  });

  it('lets an mcp lane cap be raised via laneCaps', async () => {
    const vs = createVirtualScheduler(1);
    const sleep = sleeper('test.msleep', 100, vs.hooks, { lane: 'mcp:revit' });
    const g = graph([nodeSpec('a', 'test.msleep'), nodeSpec('b', 'test.msleep')]);
    const handle = startRun(g, {
      registry: reg(sleep.module),
      scheduler: vs.hooks,
      runId: 'r1',
      laneCaps: { 'mcp:revit': 2 },
    });

    const result = await finish(vs, handle);

    expect(result.stats.durationMs).toBe(100);
  });

  it('lanes are independent: a saturated lane does not block another lane', async () => {
    const vs = createVirtualScheduler(1);
    const cpuSleep = sleeper('test.cpusleep', 100, vs.hooks);
    const ioSleep = sleeper('test.iosleep', 100, vs.hooks, { lane: 'io' });
    const g = graph([nodeSpec('a', 'test.cpusleep'), nodeSpec('b', 'test.iosleep')]);
    const handle = startRun(g, { registry: reg(cpuSleep.module, ioSleep.module), scheduler: vs.hooks, runId: 'r1', laneCaps: { cpu: 1 } });
    const events = eventsOf(handle);

    const result = await finish(vs, handle);

    expect(ofType(events, 'node:started').map((e) => e.at)).toEqual([0, 0]);
    expect(result.stats.durationMs).toBe(100);
  });
});

describe('demand', () => {
  it('runs only the ancestor closure of targets; non-demanded nodes emit no events', async () => {
    const vs = createVirtualScheduler(1);
    const src = source('test.src', 'number');
    const double = probe('test.double', 'number', 'number', (v) => (v as number) * 2, 'never');
    const g = graph(
      [
        nodeSpec('a', 'test.src', { value: 1 }),
        nodeSpec('b', 'test.double'),
        nodeSpec('c', 'test.double'),
        nodeSpec('x', 'test.src', { value: 9 }),
      ],
      [edge('a.out', 'b.in'), edge('b.out', 'c.in')],
    );
    const handle = startRun(g, { registry: reg(src.module, double.module), scheduler: vs.hooks, runId: 'r1', targets: ['b'] });
    const events = eventsOf(handle);

    const result = await finish(vs, handle);

    expect(result.status).toBe('succeeded');
    expect(result.stats.total).toBe(2);
    const mentioned = new Set(events.flatMap((e) => ('nodeId' in e ? [e.nodeId] : [])));
    expect([...mentioned].sort()).toEqual(['a', 'b']); // no event at all for c or x
    expect(ofType(events, 'run:started')[0].targets).toEqual(['b']);
    expect(double.executions()).toBe(1);
    expect(src.executions()).toBe(1);
    assertDiscipline(events);
  });

  it('defaults targets to every node in the graph', async () => {
    const vs = createVirtualScheduler(1);
    const src = source('test.src', 'number');
    const g = graph([nodeSpec('a', 'test.src', { value: 1 }), nodeSpec('b', 'test.src', { value: 2 })]);
    const handle = startRun(g, { registry: reg(src.module), scheduler: vs.hooks, runId: 'r1' });
    const events = eventsOf(handle);

    const result = await finish(vs, handle);

    expect(result.stats.total).toBe(2);
    expect(ofType(events, 'run:started')[0].targets).toEqual(['a', 'b']);
  });
});
