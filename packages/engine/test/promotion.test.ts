/**
 * Param promotion at run time (ARCHITECTURE §5.1, ADR-0017).
 *
 * §5.1's sentence is three claims, and each one is a test here:
 *
 *   1. a promotable param **can be exposed** as an input port of the
 *      corresponding type — an instance-level choice, so two nodes of the same
 *      type in one graph must be able to disagree about it;
 *   2. **a wired value overrides the configured one** — the node's `execute`
 *      sees it as a *param*, because that is what it is; it is a param that
 *      happens to be wired, not an input that happens to have a default;
 *   3. an unwired promotion falls back to the configured value, which is what
 *      makes a promoted port optional rather than a missing input.
 *
 * The cache assertions are the ones worth reading. `run.ts` folds the wired
 * value into `params` strictly between `applySchemaDefaults` and `hashValue`,
 * and that placement is the whole correctness argument: a value that reached
 * `execute` without reaching the cache key would be memoized under a key that
 * does not describe it, and §7.3's "a cache entry is valid forever by
 * construction" would quietly stop being true. So wire-supplied V and
 * form-supplied V must produce the SAME key — not a collision, a correctness
 * result, since `execute` receives an identical `(inputs, params)` pair either
 * way — and a document with no promotions must hash exactly as it did before
 * this feature existed.
 */
import { describe, expect, it } from 'vitest';
import type { Value } from '@archspace/node-sdk';
import { GraphValidationError, createRunCache, createVirtualScheduler, startRun, type ValidationIssue } from '../src/index.js';
import { edge, eventsOf, finish, graph, mod, nodeSpec, ofType, reg, source } from './helpers.js';

/** A node whose only param is promotable, reporting exactly what it received. */
function sink(type = 'test.sink') {
  const seen: { params: Record<string, unknown>; inputKeys: string[] }[] = [];
  const module = mod({
    type,
    caching: 'pure',
    params: {
      type: 'object',
      properties: {
        greeting: { type: 'string', default: 'configured', 'x-archspace': { promotable: true } },
        // Not promotable, and used to prove the affordance is opt-in.
        locked: { type: 'string', default: 'locked', 'x-archspace': {} },
      },
    },
    outputs: [{ id: 'out', type: 'text' }],
    execute: async (_ctx, inputs, params) => {
      seen.push({
        params: params as Record<string, unknown>,
        inputKeys: Object.keys(inputs).sort(),
      });
      return { out: String((params as { greeting: string }).greeting) };
    },
  });
  return { module, seen, executions: () => seen.length };
}

function runOnce(g: ReturnType<typeof graph>, registry: ReturnType<typeof reg>, cache = createRunCache()) {
  const vs = createVirtualScheduler(2);
  const handle = startRun(g, { registry, scheduler: vs.hooks, runId: 'r', cache });
  const events = eventsOf(handle);
  return { vs, handle, events, cache };
}

/** Start a run and drive the virtual clock to the end of it. */
async function runToEnd(
  g: ReturnType<typeof graph>,
  registry: ReturnType<typeof reg>,
  cache = createRunCache(),
): Promise<ReturnType<typeof runOnce>> {
  const r = runOnce(g, registry, cache);
  await finish(r.vs, r.handle);
  return r;
}

describe('a promoted param is an input port', () => {
  it('accepts a wire, and the wired value arrives as the PARAM, not as an input', async () => {
    const src = source('test.src', 'text');
    const target = sink();
    const g = graph(
      [
        nodeSpec('a', 'test.src', { value: 'from the wire' }),
        { ...nodeSpec('b', 'test.sink', { greeting: 'from the form' }), promoted: ['greeting'] },
      ],
      [edge('a.out', 'b.greeting')],
    );
    const r = runOnce(g, reg(src.module, target.module));
    const result = await finish(r.vs, r.handle);

    expect(result.status).toBe('succeeded');
    expect(target.seen).toHaveLength(1);
    // §5.1: the wired value OVERRIDES the configured one...
    expect(target.seen[0].params.greeting).toBe('from the wire');
    // ...and the unpromoted param is untouched beside it.
    expect(target.seen[0].params.locked).toBe('locked');
    // ...and it is not ALSO delivered as an input. One value, one place.
    expect(target.seen[0].inputKeys).toEqual([]);
    expect(ofType(r.events, 'node:succeeded')).toHaveLength(2);
  });

  it('falls back to the configured value when the promotion is unwired', async () => {
    const target = sink();
    const g = graph([{ ...nodeSpec('b', 'test.sink', { greeting: 'from the form' }), promoted: ['greeting'] }]);
    const r = runOnce(g, reg(target.module));
    const result = await finish(r.vs, r.handle);

    // A promoted port is optional BY CONSTRUCTION — the param behind it is the
    // fallback — so an unwired promotion is a node ready to run, never a
    // `missing-input`.
    expect(result.status).toBe('succeeded');
    expect(target.seen[0].params.greeting).toBe('from the form');
  });

  it('falls back to the schema default when nothing is configured either', async () => {
    const target = sink();
    const g = graph([{ ...nodeSpec('b', 'test.sink'), promoted: ['greeting'] }]);
    const r = runOnce(g, reg(target.module));
    expect((await finish(r.vs, r.handle)).status).toBe('succeeded');
    expect(target.seen[0].params.greeting).toBe('configured');
  });

  it('is per-instance: two nodes of one type disagree about what is promoted', async () => {
    // The point §5.1 makes against Grasshopper's everything-is-a-port. If
    // promotion were a property of the TYPE, this graph could not exist.
    const src = source('test.src', 'text');
    const target = sink();
    const g = graph(
      [
        nodeSpec('a', 'test.src', { value: 'wired' }),
        { ...nodeSpec('b', 'test.sink', { greeting: 'b-form' }), promoted: ['greeting'] },
        nodeSpec('c', 'test.sink', { greeting: 'c-form' }),
      ],
      [edge('a.out', 'b.greeting')],
    );
    const r = runOnce(g, reg(src.module, target.module));
    expect((await finish(r.vs, r.handle)).status).toBe('succeeded');

    const greetings = target.seen.map((s) => s.params.greeting).sort();
    expect(greetings).toEqual(['c-form', 'wired']);
  });
});

describe('promotion and the cache key (§7.3)', () => {
  it('hashes the wired value: changing it upstream re-executes the node', async () => {
    const cache = createRunCache();
    const target = sink();
    const src = source('test.src', 'text');
    const registry = reg(src.module, target.module);
    const build = (value: string) =>
      graph(
        [
          nodeSpec('a', 'test.src', { value }),
          { ...nodeSpec('b', 'test.sink', { greeting: 'unused' }), promoted: ['greeting'] },
        ],
        [edge('a.out', 'b.greeting')],
      );

    await runToEnd(build('one'), registry, cache);
    expect(target.executions()).toBe(1);

    // Same graph, same everything: fully cached.
    await runToEnd(build('one'), registry, cache);
    expect(target.executions()).toBe(1);

    // A different wired value MUST reach the key, or the second run would
    // serve a memo of the first and quietly return the wrong answer.
    await runToEnd(build('two'), registry, cache);
    expect(target.executions()).toBe(2);
    expect(target.seen[1].params.greeting).toBe('two');
  });

  it('gives a wired value and the same configured value ONE key, not two', async () => {
    // Not a collision — a correctness result. `execute` receives an identical
    // `(inputs, params)` pair either way, so a pure node's answer is identical
    // and one memo is the right number of memos.
    const cache = createRunCache();
    const target = sink();
    const src = source('test.src', 'text');
    const registry = reg(src.module, target.module);

    const wired = graph(
      [
        nodeSpec('a', 'test.src', { value: 'same' }),
        { ...nodeSpec('b', 'test.sink', { greeting: 'irrelevant' }), promoted: ['greeting'] },
      ],
      [edge('a.out', 'b.greeting')],
    );
    await runToEnd(wired, registry, cache);
    expect(target.executions()).toBe(1);

    // No promotion, no edge — the value typed into the form instead.
    const configured = graph([nodeSpec('b', 'test.sink', { greeting: 'same' })]);
    const r = await runToEnd(configured, registry, cache);
    expect(target.executions()).toBe(1);
    expect(ofType(r.events, 'node:succeeded')[0].cached).toBe(true);
  });

  it('leaves a document with no promotions hashing exactly as before', async () => {
    // The compatibility claim: `promoted` is absent from the key's input when
    // it is empty, so every workflow written before ADR-0017 keeps its memos.
    const cache = createRunCache();
    const target = sink();
    const registry = reg(target.module);
    const plain = graph([nodeSpec('b', 'test.sink', { greeting: 'x' })]);

    await runToEnd(plain, registry, cache);
    expect(target.executions()).toBe(1);

    // Promoting a param the user has NOT wired changes no value the node sees,
    // so it must not invalidate the memo either.
    const promotedButUnwired = graph([{ ...nodeSpec('b', 'test.sink', { greeting: 'x' }), promoted: ['greeting'] }]);
    const r = await runToEnd(promotedButUnwired, registry, cache);
    expect(target.executions()).toBe(1);
    expect(ofType(r.events, 'node:succeeded')[0].cached).toBe(true);
  });
});

describe('a promoted port carries the port type §9.3 assigns it', () => {
  it('refuses a wire whose type cannot reach the param’s type', async () => {
    const src = source('test.jsonsrc', 'json');
    const target = sink();
    const g = graph(
      [
        nodeSpec('a', 'test.jsonsrc', { value: { deep: true } as unknown as Value }),
        { ...nodeSpec('b', 'test.sink', { greeting: 'x' }), promoted: ['greeting'] },
      ],
      [edge('a.out', 'b.greeting')],
    );
    // `greeting` is `type: 'string'`, so §9.3 gives the port `text`, and
    // json -> text is not assignable. The refusal is the type system doing its
    // job on a port that exists only because of promotion.
    // Asserted on the CODE, not on prose: a regex over the message would pass
    // just as happily if the run were refused for some unrelated reason.
    let issues: ValidationIssue[] = [];
    try {
      runOnce(g, reg(src.module, target.module));
      expect.unreachable('a json wire into a text port must not validate');
    } catch (err) {
      expect(err).toBeInstanceOf(GraphValidationError);
      issues = (err as GraphValidationError).issues;
    }
    expect(issues.map((i) => i.code)).toEqual(['type-mismatch']);
  });
});
