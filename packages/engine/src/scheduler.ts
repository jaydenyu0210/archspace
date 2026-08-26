/** Scheduler hooks — the engine's only sources of time, delay, and randomness.
 *  The real hooks use the wall clock and timers; the virtual scheduler is the
 *  deterministic test mode required by ADR-0013 (built in, not bolted on). */

export interface SchedulerHooks {
  now(): number;
  /** Resolves after `ms`; rejects with an AbortError when `signal` aborts. */
  delay(ms: number, signal?: AbortSignal): Promise<void>;
  /** [0, 1) — used for retry jitter and generated run ids. */
  random(): number;
}

function abortError(): Error {
  const err = new Error('The operation was aborted');
  err.name = 'AbortError';
  return err;
}

export function createRealSchedulerHooks(): SchedulerHooks {
  return {
    now: () => Date.now(),
    delay: (ms, signal) =>
      new Promise<void>((resolve, reject) => {
        if (signal?.aborted) {
          reject(abortError());
          return;
        }
        const onAbort = () => {
          clearTimeout(timer);
          reject(abortError());
        };
        const timer = setTimeout(() => {
          signal?.removeEventListener('abort', onAbort);
          resolve();
        }, ms);
        signal?.addEventListener('abort', onAbort, { once: true });
      }),
    random: () => Math.random(),
  };
}

// ---------------------------------------------------------------------------
// Virtual scheduler (deterministic test mode)
// ---------------------------------------------------------------------------

export interface VirtualScheduler {
  hooks: SchedulerHooks;
  now(): number;
  /** Fire due timers in order, draining microtasks between them. */
  advance(ms: number): Promise<void>;
  /** Advance until no timers remain. */
  runAll(): Promise<void>;
}

/** mulberry32 — tiny seedable PRNG, plenty for jitter determinism. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function createVirtualScheduler(seed = 1): VirtualScheduler {
  interface VTimer {
    due: number;
    id: number;
    fire(): void;
  }

  let time = 0;
  let nextId = 1;
  const timers = new Set<VTimer>();
  const random = mulberry32(seed);

  /** Let every settled promise chain run to quiescence (setImmediate runs
   *  after the whole microtask queue drains). */
  const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

  function earliest(): VTimer | undefined {
    let best: VTimer | undefined;
    for (const t of timers) {
      if (!best || t.due < best.due || (t.due === best.due && t.id < best.id)) best = t;
    }
    return best;
  }

  const hooks: SchedulerHooks = {
    now: () => time,
    random,
    delay: (ms, signal) =>
      new Promise<void>((resolve, reject) => {
        if (signal?.aborted) {
          reject(abortError());
          return;
        }
        const timer: VTimer = {
          due: time + Math.max(0, ms),
          id: nextId++,
          fire() {
            timers.delete(timer);
            signal?.removeEventListener('abort', onAbort);
            resolve();
          },
        };
        const onAbort = () => {
          timers.delete(timer);
          reject(abortError());
        };
        timers.add(timer);
        signal?.addEventListener('abort', onAbort, { once: true });
      }),
  };

  return {
    hooks,
    now: () => time,
    async advance(ms: number): Promise<void> {
      const target = time + ms;
      await flush();
      for (;;) {
        const timer = earliest();
        if (!timer || timer.due > target) break;
        time = Math.max(time, timer.due);
        timer.fire();
        await flush();
      }
      time = Math.max(time, target);
      await flush();
    },
    async runAll(): Promise<void> {
      await flush();
      for (;;) {
        const timer = earliest();
        if (!timer) break;
        time = Math.max(time, timer.due);
        timer.fire();
        await flush();
      }
      await flush();
    },
  };
}
