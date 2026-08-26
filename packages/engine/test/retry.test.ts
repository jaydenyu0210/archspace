/** Required assertion 5: retry only for marked-transient errors, max 3
 *  attempts, exact virtual backoff of 500·2^(attempt−1) + seeded jitter. */
import { describe, expect, it } from 'vitest';
import { createVirtualScheduler, startRun } from '../src/index';
import { assertDiscipline, eventsOf, failOnAttempt, finish, graph, nodeSpec, ofType, reg } from './helpers';

const SEED = 42;

describe('retry policy', () => {
  it('retries a retryable failure and succeeds on attempt 2 after the exact backoff', async () => {
    const vs = createVirtualScheduler(SEED);
    const flaky = failOnAttempt('test.flaky', 1);
    const g = graph([nodeSpec('n', 'test.flaky')]);
    // Explicit runId so the engine's first random() draw is the first jitter.
    const handle = startRun(g, { registry: reg(flaky.module), scheduler: vs.hooks, runId: 'r1' });
    const events = eventsOf(handle);

    const result = await finish(vs, handle);

    expect(result.status).toBe('succeeded');
    expect(flaky.executions()).toBe(2);

    const started = ofType(events, 'node:started');
    const failed = ofType(events, 'node:failed');
    expect(started.map((e) => e.attempt)).toEqual([1, 2]);
    expect(failed).toHaveLength(1);
    expect(failed[0]).toMatchObject({ kind: 'error', willRetry: true, attempt: 1 });
    // failed(attempt 1) comes before started(attempt 2) in the stream.
    expect(failed[0].seq).toBeLessThan(started[1].seq);

    // Backoff is exactly 500·2^0 + seededRandom()·250 virtual ms.
    const reference = createVirtualScheduler(SEED);
    const expectedBackoff = 500 + reference.hooks.random() * 250;
    expect(started[1].at - failed[0].at).toBe(expectedBackoff);
    expect(vs.now()).toBe(expectedBackoff);
    assertDiscipline(events);
  });

  it('gives up after exactly 3 attempts when every attempt fails retryably', async () => {
    const vs = createVirtualScheduler(SEED);
    const doomed = failOnAttempt('test.doomed', 99);
    const g = graph([nodeSpec('n', 'test.doomed')]);
    const handle = startRun(g, { registry: reg(doomed.module), scheduler: vs.hooks, runId: 'r1' });
    const events = eventsOf(handle);

    const result = await finish(vs, handle);

    expect(result.status).toBe('failed');
    expect(doomed.executions()).toBe(3);

    const started = ofType(events, 'node:started');
    const failed = ofType(events, 'node:failed');
    expect(started.map((e) => e.attempt)).toEqual([1, 2, 3]);
    expect(failed.map((e) => [e.attempt, e.willRetry])).toEqual([
      [1, true],
      [2, true],
      [3, false],
    ]);

    // Backoff schedule exact: 500 + j1 then 1000 + j2 virtual ms.
    const reference = createVirtualScheduler(SEED);
    const backoff1 = 500 + reference.hooks.random() * 250;
    const backoff2 = 1000 + reference.hooks.random() * 250;
    expect(started[1].at).toBe(backoff1);
    expect(started[2].at).toBe(backoff1 + backoff2);
    expect(failed[2].at).toBe(backoff1 + backoff2);
    expect(result.stats).toMatchObject({ total: 1, succeeded: 0, failed: 1, skipped: 0 });
  });

  it('fails fast on attempt 1 for non-retryable errors', async () => {
    const vs = createVirtualScheduler(SEED);
    const fatal = failOnAttempt('test.fatal', 99, { retryable: false });
    const g = graph([nodeSpec('n', 'test.fatal')]);
    const handle = startRun(g, { registry: reg(fatal.module), scheduler: vs.hooks, runId: 'r1' });
    const events = eventsOf(handle);

    const result = await finish(vs, handle);

    expect(result.status).toBe('failed');
    expect(fatal.executions()).toBe(1);
    expect(ofType(events, 'node:started')).toHaveLength(1);
    const failed = ofType(events, 'node:failed');
    expect(failed).toHaveLength(1);
    expect(failed[0]).toMatchObject({ kind: 'error', willRetry: false, attempt: 1 });
    expect(vs.now()).toBe(0); // no backoff was waited
  });
});
