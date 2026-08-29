/** Required assertion 4: memoization — zero re-executes on an unchanged rerun,
 *  param edits re-execute only the affected subgraph, clones prevent poisoning. */
import { describe, expect, it } from 'vitest';
import type { Value } from '@archspace/node-sdk';
import { createRunCache, createVirtualScheduler, startRun } from '../src/index.js';
import { edge, eventsOf, finish, graph, mod, nodeSpec, ofType, probe, reg, source } from './helpers.js';

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

/**
 * The bound (§7.3).
 *
 * "Session-scoped" in the desktop app means the life of the process: the engine
 * child builds one cache at startup and every run shares it, so an unbounded
 * Map grew for as long as the app was open. And the entries are not small —
 * §7.6 sends bulk bytes as an `AssetRef`, but a floor plan is a `json` wire
 * value and a six-storey one is about 261,000 characters, so a handful of
 * parameter sweeps is megabytes of memo nobody will ask for again.
 *
 * LRU rather than FIFO because the whole point of the memo is the second press
 * of Run on a graph whose upstream did not change: the entries a user is
 * iterating on are exactly the ones they keep reading.
 */
describe('the cache is bounded', () => {
  const outputs = (v: string) => ({ out: v });

  it('evicts the least recently used entry, not the oldest one', () => {
    const cache = createRunCache(3);
    cache.set('a', outputs('a'));
    cache.set('b', outputs('b'));
    cache.set('c', outputs('c'));

    // Reading 'a' makes it the newest, so 'b' is now the least recent.
    expect(cache.get('a')).toEqual(outputs('a'));
    cache.set('d', outputs('d'));

    expect(cache.size).toBe(3);
    expect(cache.get('b')).toBeUndefined();
    expect(cache.get('a')).toEqual(outputs('a'));
    expect(cache.get('c')).toEqual(outputs('c'));
    expect(cache.get('d')).toEqual(outputs('d'));
  });

  it('never exceeds its limit, however many entries are written', () => {
    const cache = createRunCache(8);
    for (let i = 0; i < 500; i++) cache.set(`k${i}`, outputs(String(i)));
    expect(cache.size).toBe(8);
    // The most recent survive.
    expect(cache.get('k499')).toEqual(outputs('499'));
    expect(cache.get('k0')).toBeUndefined();
  });

  it('re-writing a key refreshes it rather than adding a second entry', () => {
    const cache = createRunCache(2);
    cache.set('a', outputs('1'));
    cache.set('b', outputs('b'));
    cache.set('a', outputs('2'));
    cache.set('c', outputs('c'));

    expect(cache.size).toBe(2);
    // 'b' was the least recent once 'a' was rewritten.
    expect(cache.get('b')).toBeUndefined();
    expect(cache.get('a')).toEqual(outputs('2'));
  });

  it('refuses a nonsensical limit rather than holding nothing', () => {
    for (const limit of [0, -5, 0.4]) {
      const cache = createRunCache(limit);
      cache.set('a', outputs('a'));
      expect(cache.get('a'), `limit ${limit}`).toEqual(outputs('a'));
      expect(cache.size, `limit ${limit}`).toBe(1);
    }
  });

  it('still isolates callers from what it holds, after an eviction pass', () => {
    // The clone-on-both-sides invariant must survive the LRU bookkeeping.
    const cache = createRunCache(2);
    const written = { out: 'v', nested: { n: 1 } };
    cache.set('a', written);
    written.nested.n = 99;
    const read = cache.get('a') as typeof written;
    expect(read.nested.n).toBe(1);
    read.nested.n = 42;
    expect((cache.get('a') as typeof written).nested.n).toBe(1);
  });
});
