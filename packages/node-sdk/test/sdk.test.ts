import { describe, expect, it } from 'vitest';
import {
  applySchemaDefaults,
  createMemoryAssetStore,
  createNodeRegistry,
  isAssetRef,
  isRetryableError,
  markRetryable,
  type NodeModule,
} from '../src/index.js';
import { runNode } from '../src/testkit.js';

const echo: NodeModule<{ prefix: string }> = {
  manifest: {
    type: 'test.util.echo',
    version: 1,
    label: 'Echo',
    description: 'prefixes its input',
    category: 'Test',
    params: {
      type: 'object',
      properties: { prefix: { type: 'string', default: '>> ' } },
    },
    inputs: [{ id: 'value', type: 'text' }],
    outputs: [{ id: 'result', type: 'text' }],
    caching: 'pure',
  },
  async execute(ctx, inputs, params) {
    ctx.log('info', 'echoing');
    ctx.progress(0.5, 'halfway');
    return { result: `${params.prefix}${inputs.value as string}` };
  },
};

describe('memory asset store', () => {
  it('content-addresses with b3: hashes and round-trips bytes', async () => {
    const store = createMemoryAssetStore();
    const data = new TextEncoder().encode('ISO-10303-21;');
    const ref = await store.put(data, { mediaType: 'model/ifc', format: 'ifc', name: 'model.ifc' });
    expect(ref.hash).toMatch(/^b3:[0-9a-f]{64}$/);
    expect(ref.size).toBe(data.byteLength);
    expect(isAssetRef(ref)).toBe(true);
    expect(await store.text(ref)).toBe('ISO-10303-21;');
    // Same content, same address.
    const again = await store.put(new TextEncoder().encode('ISO-10303-21;'), { mediaType: 'model/ifc' });
    expect(again.hash).toBe(ref.hash);
  });
});

describe('registry', () => {
  it('registers valid modules and lists manifests', () => {
    const reg = createNodeRegistry();
    reg.register(echo);
    expect(reg.has('test.util.echo')).toBe(true);
    expect(reg.manifests().map((m) => m.type)).toEqual(['test.util.echo']);
  });

  it('rejects duplicates, bad type ids, bad port types', () => {
    const reg = createNodeRegistry();
    reg.register(echo);
    expect(() => reg.register(echo)).toThrow(/duplicate/);
    expect(() => reg.register({
      ...echo,
      manifest: { ...echo.manifest, type: 'NotValid' },
    })).toThrow(/invalid node type/);
    expect(() => reg.register({
      ...echo,
      manifest: { ...echo.manifest, type: 'test.util.bad', inputs: [{ id: 'x', type: 'wat<' }] },
    })).toThrow(/invalid type/);
  });
});

describe('testkit', () => {
  it('runs a node with defaults applied and captures logs/progress', async () => {
    const result = await runNode(echo, { inputs: { value: 'hello' } });
    expect(result.outputs).toEqual({ result: '>> hello' });
    expect(result.logs).toEqual([{ level: 'info', message: 'echoing' }]);
    expect(result.progress).toEqual([{ fraction: 0.5, message: 'halfway' }]);
    expect(result.params).toEqual({ prefix: '>> ' });
  });

  it('explicit params override defaults', async () => {
    const result = await runNode(echo, { inputs: { value: 'x' }, params: { prefix: '! ' } });
    expect(result.outputs).toEqual({ result: '! x' });
  });

  it('unscripted ai rejects with guidance', async () => {
    const needsAi: NodeModule = {
      manifest: { ...echo.manifest, type: 'test.util.ai' },
      execute: async (ctx) => ({ text: (await ctx.ai.generateText({ prompt: 'hi' })).text }),
    };
    await expect(runNode(needsAi)).rejects.toThrow(/not scripted/);
  });
});

describe('retryable marking', () => {
  it('marks and detects', () => {
    const err = new Error('flaky');
    expect(isRetryableError(err)).toBe(false);
    expect(isRetryableError(markRetryable(err))).toBe(true);
  });
});

describe('applySchemaDefaults', () => {
  it('merges shallow defaults under config', () => {
    const schema = {
      type: 'object' as const,
      properties: { a: { type: 'number', default: 1 }, b: { type: 'string' } },
    };
    expect(applySchemaDefaults(schema, { b: 'x' })).toEqual({ a: 1, b: 'x' });
    expect(applySchemaDefaults(schema, { a: 5 })).toEqual({ a: 5 });
  });
});
