/** The virtual scheduler itself: timer ordering, abort, seeded determinism. */
import { describe, expect, it } from 'vitest';
import { createVirtualScheduler } from '../src/index';

describe('createVirtualScheduler', () => {
  it('fires due timers in order and advances the clock', async () => {
    const vs = createVirtualScheduler();
    const fired: string[] = [];
    void vs.hooks.delay(30).then(() => fired.push(`b@${vs.now()}`));
    void vs.hooks.delay(10).then(() => fired.push(`a@${vs.now()}`));
    void vs.hooks.delay(50).then(() => fired.push(`c@${vs.now()}`));

    await vs.advance(30);
    expect(fired).toEqual(['a@10', 'b@30']);
    expect(vs.now()).toBe(30);

    await vs.runAll();
    expect(fired).toEqual(['a@10', 'b@30', 'c@50']);
    expect(vs.now()).toBe(50);
  });

  it('breaks same-due ties by scheduling order', async () => {
    const vs = createVirtualScheduler();
    const fired: string[] = [];
    void vs.hooks.delay(10).then(() => fired.push('first'));
    void vs.hooks.delay(10).then(() => fired.push('second'));
    await vs.runAll();
    expect(fired).toEqual(['first', 'second']);
  });

  it('drains microtasks between timers: a timer scheduled by a timer still fires', async () => {
    const vs = createVirtualScheduler();
    const fired: number[] = [];
    void vs.hooks.delay(10).then(async () => {
      fired.push(vs.now());
      await vs.hooks.delay(10);
      fired.push(vs.now());
    });
    await vs.runAll();
    expect(fired).toEqual([10, 20]);
  });

  it('rejects delay with an AbortError on abort, and immediately when already aborted', async () => {
    const vs = createVirtualScheduler();
    const controller = new AbortController();
    const pending = vs.hooks.delay(100, controller.signal);
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });

    const already = vs.hooks.delay(100, controller.signal);
    await expect(already).rejects.toMatchObject({ name: 'AbortError' });
    await vs.runAll(); // the cancelled timer is gone; nothing to fire
    expect(vs.now()).toBe(0);
  });

  it('advance moves the clock even with no timers', async () => {
    const vs = createVirtualScheduler();
    await vs.advance(123);
    expect(vs.now()).toBe(123);
  });

  it('produces identical random sequences for identical seeds', () => {
    const a = createVirtualScheduler(99);
    const b = createVirtualScheduler(99);
    const c = createVirtualScheduler(100);
    const seqA = [a.hooks.random(), a.hooks.random(), a.hooks.random()];
    const seqB = [b.hooks.random(), b.hooks.random(), b.hooks.random()];
    const seqC = [c.hooks.random(), c.hooks.random(), c.hooks.random()];
    expect(seqA).toEqual(seqB);
    expect(seqA).not.toEqual(seqC);
    for (const r of seqA) {
      expect(r).toBeGreaterThanOrEqual(0);
      expect(r).toBeLessThan(1);
    }
  });

  it('hooks.now matches scheduler.now', async () => {
    const vs = createVirtualScheduler();
    expect(vs.hooks.now()).toBe(0);
    await vs.advance(42);
    expect(vs.hooks.now()).toBe(42);
  });
});
