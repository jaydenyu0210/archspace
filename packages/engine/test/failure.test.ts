/** Required assertions 6 (partial failure / transitive skip), 12 (output
 *  contract), and 13 (AI stub). */
import { describe, expect, it } from 'vitest';
import { createVirtualScheduler, startRun } from '../src/index';
import { assertDiscipline, edge, eventsOf, finish, graph, mod, nodeSpec, ofType, probe, reg, source } from './helpers';

describe('partial failure (§7.5)', () => {
  it('failed middle node skips its descendants transitively while the independent branch completes', async () => {
    const vs = createVirtualScheduler(1);
    const src = source('test.src', 'number', 'never');
    const bad = mod({
      type: 'test.bad',
      inputs: [{ id: 'in', type: 'number' }],
      outputs: [{ id: 'out', type: 'number' }],
      execute: async () => {
        throw new Error('middle node exploded');
      },
    });
    const pass = probe('test.pass', 'number', 'number', (v) => v, 'never');
    const g = graph(
      [
        nodeSpec('a', 'test.src', { value: 1 }),
        nodeSpec('b', 'test.bad'),
        nodeSpec('c', 'test.pass'),
        nodeSpec('d', 'test.pass'),
        nodeSpec('f', 'test.pass'),
      ],
      [edge('a.out', 'b.in'), edge('a.out', 'c.in'), edge('b.out', 'd.in'), edge('d.out', 'f.in')],
    );
    const handle = startRun(g, { registry: reg(src.module, bad, pass.module), scheduler: vs.hooks, runId: 'r1' });
    const events = eventsOf(handle);

    const result = await finish(vs, handle);

    expect(result.status).toBe('partial');
    const failed = ofType(events, 'node:failed');
    expect(failed).toHaveLength(1);
    expect(failed[0]).toMatchObject({ nodeId: 'b', kind: 'error', willRetry: false });

    const skipped = ofType(events, 'node:skipped');
    expect(skipped.map((e) => [e.nodeId, e.reason])).toEqual([
      ['d', 'upstream failed'],
      ['f', 'upstream failed'], // transitive: a skipped node's descendants are skipped too
    ]);

    const succeeded = ofType(events, 'node:succeeded').map((e) => e.nodeId);
    expect(succeeded.sort()).toEqual(['a', 'c']); // the independent branch ran to completion
    expect(result.stats).toMatchObject({ total: 5, succeeded: 2, cached: 0, failed: 1, skipped: 2 });
    assertDiscipline(events);
  });

  it('failures with no successes yield status failed', async () => {
    const vs = createVirtualScheduler(1);
    const bad = mod({
      type: 'test.bad',
      outputs: [{ id: 'out', type: 'text' }],
      execute: async () => {
        throw new Error('nope');
      },
    });
    const result = await finish(vs, startRun(graph([nodeSpec('b', 'test.bad')]), { registry: reg(bad), scheduler: vs.hooks, runId: 'r1' }));
    expect(result.status).toBe('failed');
  });
});

describe('output contract', () => {
  it('a missing declared output fails the node with kind error', async () => {
    const vs = createVirtualScheduler(1);
    const partial = mod({
      type: 'test.partial',
      outputs: [
        { id: 'out', type: 'text' },
        { id: 'n', type: 'number' },
      ],
      execute: async () => ({ out: 'present' }), // 'n' is missing
    });
    const handle = startRun(graph([nodeSpec('p', 'test.partial')]), { registry: reg(partial), scheduler: vs.hooks, runId: 'r1' });
    const events = eventsOf(handle);

    const result = await finish(vs, handle);

    expect(result.status).toBe('failed');
    const failed = ofType(events, 'node:failed');
    expect(failed[0].kind).toBe('error');
    expect(failed[0].message).toContain('"n"');
    expect(failed[0].willRetry).toBe(false);
  });

  it('a NaN number output fails the node with kind error', async () => {
    const vs = createVirtualScheduler(1);
    const nan = mod({
      type: 'test.nan',
      outputs: [{ id: 'n', type: 'number' }],
      execute: async () => ({ n: NaN }),
    });
    const handle = startRun(graph([nodeSpec('p', 'test.nan')]), { registry: reg(nan), scheduler: vs.hooks, runId: 'r1' });
    const events = eventsOf(handle);

    const result = await finish(vs, handle);

    expect(result.status).toBe('failed');
    const failed = ofType(events, 'node:failed');
    expect(failed[0].kind).toBe('error');
    expect(failed[0].message).toContain('finite');
  });

  it('an Infinity number output fails the node too', async () => {
    const vs = createVirtualScheduler(1);
    const inf = mod({
      type: 'test.inf',
      outputs: [{ id: 'n', type: 'number' }],
      execute: async () => ({ n: Infinity }),
    });
    const result = await finish(vs, startRun(graph([nodeSpec('p', 'test.inf')]), { registry: reg(inf), scheduler: vs.hooks, runId: 'r1' }));
    expect(result.status).toBe('failed');
  });
});

describe('AI stub', () => {
  it('a node calling ctx.ai without opts.ai fails with the not-configured message', async () => {
    const vs = createVirtualScheduler(1);
    const wantsAi = mod({
      type: 'test.ai',
      outputs: [{ id: 'out', type: 'text' }],
      execute: async (ctx) => {
        const { text } = await ctx.ai.generateText({ prompt: 'hello' });
        return { out: text };
      },
    });
    const handle = startRun(graph([nodeSpec('n', 'test.ai')]), { registry: reg(wantsAi), scheduler: vs.hooks, runId: 'r1' });
    const events = eventsOf(handle);

    const result = await finish(vs, handle);

    expect(result.status).toBe('failed');
    const failed = ofType(events, 'node:failed');
    expect(failed[0].kind).toBe('error');
    expect(failed[0].message).toBe('AI gateway is not configured in this build');
  });

  it('a provided AiGateway is passed through to nodes', async () => {
    const vs = createVirtualScheduler(1);
    const wantsAi = mod({
      type: 'test.ai',
      outputs: [{ id: 'out', type: 'text' }],
      execute: async (ctx) => {
        const { text } = await ctx.ai.generateText({ prompt: 'hello' });
        return { out: text };
      },
    });
    const ai = {
      generateText: async () => ({ text: 'scripted' }),
      generateObject: async () => ({ object: null }),
      embed: async () => ({ embeddings: [] as number[][] }),
    };
    const result = await finish(vs, startRun(graph([nodeSpec('n', 'test.ai')]), { registry: reg(wantsAi), scheduler: vs.hooks, runId: 'r1', ai }));
    expect(result.status).toBe('succeeded');
  });

  it('ctx.secrets is unavailable in this build', async () => {
    const vs = createVirtualScheduler(1);
    const wantsSecret = mod({
      type: 'test.secret',
      outputs: [{ id: 'out', type: 'text' }],
      execute: async (ctx) => ({ out: await ctx.secrets.get('api_key') }),
    });
    const handle = startRun(graph([nodeSpec('n', 'test.secret')]), { registry: reg(wantsSecret), scheduler: vs.hooks, runId: 'r1' });
    const events = eventsOf(handle);
    const result = await finish(vs, handle);
    expect(result.status).toBe('failed');
    expect(ofType(events, 'node:failed')[0].message).toBe('secrets are not available in this build');
  });
});
