/** Required assertion 4: memoization — zero re-executes on an unchanged rerun,
 *  param edits re-execute only the affected subgraph, clones prevent poisoning. */
import { describe, expect, it } from 'vitest';
import type { Value } from '@archspace/node-sdk';
import { createRunCache, createVirtualScheduler, startRun } from '../src/index';
import { edge, eventsOf, finish, graph, mod, nodeSpec, ofType, probe, reg, source } from './helpers';

describe('caching (pure nodes only)', () => {
  it('second run with the same RunCache executes nothing and marks every pure node cached', async () => {
    const cache = createRunCache();
    const src = source('test.src', 'number'); // pure
    const double = probe('test.double', 'number', 'number', (v) => (v as number) * 2); // pure
    const registry = reg(src.module, double.module);
    const g = graph(
      [nodeSpec('a', 'test.src', { value: 2 }), nodeSpec('b', 'test.double'), nodeSpec('d', 'test.src', { value: 7 })],
      [edge('a.out', 'b.in')],
    );

    const vs1 = createVirtualScheduler(1);
    const first = await finish(vs1, startRun(g, { registry, scheduler: vs1.hooks, runId: 'r1', cache }));
    expect(first.status).toBe('succeeded');
    expect(src.executions()).toBe(2); // a and d
    expect(double.executions()).toBe(1);
    expect(first.stats.cached).toBe(0);
    expect(cache.size).toBe(3);

    const vs2 = createVirtualScheduler(2);
    const handle2 = startRun(g, { registry, scheduler: vs2.hooks, runId: 'r2', cache });
    const events2 = eventsOf(handle2);
    const second = await finish(vs2, handle2);

    expect(second.status).toBe('succeeded');
    expect(src.executions()).toBe(2); // zero new executions
    expect(double.executions()).toBe(1);
    const succeeded2 = ofType(events2, 'node:succeeded');
    expect(succeeded2).toHaveLength(3);
    expect(succeeded2.every((e) => e.cached && e.durationMs === 0)).toBe(true);
    expect(ofType(events2, 'node:started')).toHaveLength(0); // execute never ran
    expect(second.stats).toMatchObject({ total: 3, succeeded: 3, cached: 3, failed: 0, skipped: 0 });
  });

  it('changing one param re-executes only the affected subgraph', async () => {
    const cache = createRunCache();
    const src = source('test.src', 'number');
    const double = probe('test.double', 'number', 'number', (v) => (v as number) * 2);
    const registry = reg(src.module, double.module);
    const before = graph(
      [nodeSpec('a', 'test.src', { value: 2 }), nodeSpec('b', 'test.double'), nodeSpec('d', 'test.src', { value: 7 })],
      [edge('a.out', 'b.in')],
    );

    const vs1 = createVirtualScheduler(1);
    await finish(vs1, startRun(before, { registry, scheduler: vs1.hooks, runId: 'r1', cache }));
    expect(src.executions()).toBe(2);
    expect(double.executions()).toBe(1);

    // Same graph, but a's param changed: a and its dependent b re-execute; d stays cached.
    const after = graph(
      [nodeSpec('a', 'test.src', { value: 3 }), nodeSpec('b', 'test.double'), nodeSpec('d', 'test.src', { value: 7 })],
      [edge('a.out', 'b.in')],
    );
    const vs2 = createVirtualScheduler(2);
    const handle2 = startRun(after, { registry, scheduler: vs2.hooks, runId: 'r2', cache });
    const events2 = eventsOf(handle2);
    const second = await finish(vs2, handle2);

    expect(src.executions()).toBe(3); // only a
    expect(double.executions()).toBe(2); // b re-ran because its input hash changed
    expect(second.stats.cached).toBe(1); // d
    const cachedNodes = ofType(events2, 'node:succeeded').filter((e) => e.cached).map((e) => e.nodeId);
    expect(cachedNodes).toEqual(['d']);
  });

  it('effectful (caching: never) nodes always execute even with a shared cache', async () => {
    const cache = createRunCache();
    const src = source('test.effect', 'number', 'never');
    const registry = reg(src.module);
    const g = graph([nodeSpec('a', 'test.effect', { value: 1 })]);

    const vs1 = createVirtualScheduler(1);
    await finish(vs1, startRun(g, { registry, scheduler: vs1.hooks, runId: 'r1', cache }));
    const vs2 = createVirtualScheduler(2);
    const second = await finish(vs2, startRun(g, { registry, scheduler: vs2.hooks, runId: 'r2', cache }));

    expect(src.executions()).toBe(2);
    expect(second.stats.cached).toBe(0);
    expect(cache.size).toBe(0);
  });

  it('mutating the outputs object a node returned does not poison the cache', async () => {
    const cache = createRunCache();
    let returned: { out: Value } | undefined;
    const module = mod({
      type: 'test.obj',
      caching: 'pure',
      outputs: [{ id: 'out', type: 'json' }],
      execute: async () => {
        returned = { out: { a: 1 } };
        return returned;
      },
    });
    const registry = reg(module);
    const g = graph([nodeSpec('n', 'test.obj')]);

    const vs1 = createVirtualScheduler(1);
    await finish(vs1, startRun(g, { registry, scheduler: vs1.hooks, runId: 'r1', cache }));
    expect(returned).toBeDefined();
    (returned!.out as { a: number }).a = 999; // consumer-side mutation after the run

    const vs2 = createVirtualScheduler(2);
    const handle2 = startRun(g, { registry, scheduler: vs2.hooks, runId: 'r2', cache });
    const events2 = eventsOf(handle2);
    const second = await finish(vs2, handle2);

    expect(second.stats.cached).toBe(1);
    const preview = ofType(events2, 'node:succeeded')[0].outputPreviews[0].preview;
    expect(preview.kind).toBe('json');
    expect(JSON.parse((preview as { json: string }).json)).toEqual({ a: 1 }); // not 999
  });
});
