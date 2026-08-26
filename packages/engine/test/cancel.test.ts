/** Required assertion 7: cancellation — no starts after cancel, queued nodes
 *  skipped, in-flight AbortError → kind cancelled, completed results cached. */
import { describe, expect, it } from 'vitest';
import { createRunCache, createVirtualScheduler, startRun } from '../src/index.js';
import { assertDiscipline, eventsOf, failOnAttempt, finish, graph, nodeSpec, ofType, reg, sleeper, source } from './helpers.js';

describe('cancellation (§7.4)', () => {
  it('cancel mid-run: skips queued nodes, aborts in-flight, keeps completed results', async () => {
    const vs = createVirtualScheduler(1);
    const cache = createRunCache();
    const pure = source('test.pure', 'number'); // completes instantly at t=0
    const obedient = sleeper('test.obedient', 100, vs.hooks, { lane: 'io' });
    const stubborn = sleeper('test.stubborn', 100, vs.hooks, { lane: 'io', useSignal: false });
    const queuedUp = sleeper('test.queued', 100, vs.hooks, { lane: 'io' });
    const g = graph([
      nodeSpec('p', 'test.pure', { value: 5 }),
      nodeSpec('s1', 'test.obedient'),
      nodeSpec('s2', 'test.stubborn'),
      nodeSpec('s3', 'test.queued'),
    ]);
    const handle = startRun(g, {
      registry: reg(pure.module, obedient.module, stubborn.module, queuedUp.module),
      scheduler: vs.hooks,
      runId: 'r1',
      cache,
      laneCaps: { io: 2 }, // s1 + s2 in flight, s3 stays queued
    });
    const events = eventsOf(handle);

    await vs.advance(10); // p succeeded at 0; s1, s2 sleeping until 100; s3 waiting on the io lane
    handle.cancel();
    const result = await finish(vs, handle);

    expect(result.status).toBe('cancelled'); // cancellation wins even though nodes succeeded
    assertDiscipline(events);

    // No node starts after cancel.
    const started = ofType(events, 'node:started').map((e) => e.nodeId);
    expect(started.sort()).toEqual(['p', 's1', 's2']);
    expect(queuedUp.executions()).toBe(0);

    // Queued/ready nodes are skipped with reason "cancelled".
    const skipped = ofType(events, 'node:skipped');
    expect(skipped.map((e) => [e.nodeId, e.reason])).toEqual([['s3', 'cancelled']]);

    // In-flight signal-respecting sleeper rejects with AbortError → kind cancelled.
    const failed = ofType(events, 'node:failed');
    expect(failed).toHaveLength(1);
    expect(failed[0]).toMatchObject({ nodeId: 's1', kind: 'cancelled', willRetry: false });
    expect(failed[0].at).toBe(10); // aborted at cancel time, not at its due time

    // An in-flight node that resolves successfully still emits node:succeeded.
    const succeeded = ofType(events, 'node:succeeded').map((e) => e.nodeId);
    expect(succeeded).toContain('p');
    expect(succeeded).toContain('s2');
    expect(ofType(events, 'node:succeeded').find((e) => e.nodeId === 's2')!.at).toBe(100);

    expect(result.stats).toMatchObject({ total: 4, succeeded: 2, cached: 0, failed: 1, skipped: 1 });

    // Completed-before-cancel results of pure nodes are in the cache.
    expect(cache.size).toBe(1);
    const vs2 = createVirtualScheduler(2);
    const handle2 = startRun(graph([nodeSpec('p', 'test.pure', { value: 5 })]), {
      registry: reg(source('test.pure', 'number').module),
      scheduler: vs2.hooks,
      runId: 'r2',
      cache,
    });
    const events2 = eventsOf(handle2);
    const rerun = await finish(vs2, handle2);
    expect(rerun.status).toBe('succeeded');
    expect(ofType(events2, 'node:succeeded')[0].cached).toBe(true);
  });

  it('cancelling during retry backoff stops the retry with a cancelled failure', async () => {
    const vs = createVirtualScheduler(1);
    const flaky = failOnAttempt('test.flaky', 99);
    const handle = startRun(graph([nodeSpec('n', 'test.flaky')]), { registry: reg(flaky.module), scheduler: vs.hooks, runId: 'r1' });
    const events = eventsOf(handle);

    await vs.advance(100); // attempt 1 failed; node is waiting out the backoff
    expect(flaky.executions()).toBe(1);
    handle.cancel();
    const result = await finish(vs, handle);

    expect(result.status).toBe('cancelled');
    expect(flaky.executions()).toBe(1); // never re-attempted
    const failed = ofType(events, 'node:failed');
    expect(failed.map((e) => [e.kind, e.willRetry])).toEqual([
      ['error', true],
      ['cancelled', false],
    ]);
  });

  it('cancel after finish is a no-op', async () => {
    const vs = createVirtualScheduler(1);
    const pure = source('test.pure', 'number');
    const handle = startRun(graph([nodeSpec('p', 'test.pure', { value: 1 })]), {
      registry: reg(pure.module),
      scheduler: vs.hooks,
      runId: 'r1',
    });
    const events = eventsOf(handle);
    const result = await finish(vs, handle);
    expect(result.status).toBe('succeeded');

    handle.cancel();
    await vs.runAll();
    expect(events[events.length - 1].type).toBe('run:finished');
    expect(events).toHaveLength(result.events.length); // nothing new was emitted
  });

  it('unsubscribe stops event delivery', async () => {
    const vs = createVirtualScheduler(1);
    const pure = source('test.pure', 'number');
    const handle = startRun(graph([nodeSpec('p', 'test.pure', { value: 1 })]), {
      registry: reg(pure.module),
      scheduler: vs.hooks,
      runId: 'r1',
    });
    const seen: string[] = [];
    const unsubscribe = handle.onEvent((e) => seen.push(e.type));
    const replayedCount = seen.length; // late subscriber replays the buffer first
    expect(replayedCount).toBeGreaterThan(0);
    unsubscribe();
    const result = await finish(vs, handle);
    expect(seen).toHaveLength(replayedCount); // no live events after unsubscribe
    expect(result.status).toBe('succeeded');
  });
});
