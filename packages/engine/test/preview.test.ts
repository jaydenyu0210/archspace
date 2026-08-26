/** Previews (§7.6): size caps, kinds by port type and value, log/progress caps. */
import { describe, expect, it } from 'vitest';
import { MemoryAssetStore, type Value } from '@archspace/node-sdk';
import { createVirtualScheduler, startRun } from '../src/index';
import { eventsOf, finish, graph, mod, nodeSpec, ofType, reg } from './helpers';

async function runSingle(module: ReturnType<typeof mod>, config?: Record<string, unknown>, assets?: MemoryAssetStore) {
  const vs = createVirtualScheduler(1);
  const handle = startRun(graph([nodeSpec('n', module.manifest.type, config)]), {
    registry: reg(module),
    scheduler: vs.hooks,
    runId: 'r1',
    ...(assets ? { assets } : {}),
  });
  const events = eventsOf(handle);
  const result = await finish(vs, handle);
  return { events, result };
}

describe('output previews', () => {
  it('truncates text previews at 16000 chars and flags it', async () => {
    const long = 'x'.repeat(20_000);
    const module = mod({
      type: 'test.longtext',
      outputs: [{ id: 'out', type: 'text' }],
      execute: async () => ({ out: long }),
    });
    const { events } = await runSingle(module);
    const preview = ofType(events, 'node:succeeded')[0].outputPreviews[0].preview;
    expect(preview.kind).toBe('text');
    const text = preview as { text: string; truncated: boolean };
    expect(text.text).toHaveLength(16_000);
    expect(text.truncated).toBe(true);
  });

  it('short text previews are not flagged truncated', async () => {
    const module = mod({
      type: 'test.shorttext',
      outputs: [{ id: 'out', type: 'text' }],
      execute: async () => ({ out: 'short' }),
    });
    const { events } = await runSingle(module);
    expect(ofType(events, 'node:succeeded')[0].outputPreviews[0].preview).toEqual({
      kind: 'text',
      text: 'short',
      truncated: false,
    });
  });

  it('caps table previews at the first 50 rows and reports totalRows', async () => {
    const rows = Array.from({ length: 60 }, (_, i) => ({ n: i }));
    const module = mod({
      type: 'test.table',
      outputs: [{ id: 'out', type: 'table' }],
      execute: async () => ({ out: { columns: [{ id: 'n', label: 'N' }], rows } }),
    });
    const { events } = await runSingle(module);
    const preview = ofType(events, 'node:succeeded')[0].outputPreviews[0].preview;
    expect(preview.kind).toBe('table');
    const table = preview as { columns: { id: string; label?: string }[]; rows: Record<string, Value>[]; totalRows: number };
    expect(table.columns).toEqual([{ id: 'n', label: 'N' }]);
    expect(table.rows).toHaveLength(50);
    expect(table.rows[0]).toEqual({ n: 0 });
    expect(table.totalRows).toBe(60);
  });

  it('previews an AssetRef value as an asset preview', async () => {
    const assets = new MemoryAssetStore();
    const module = mod({
      type: 'test.asset',
      outputs: [{ id: 'out', type: 'asset<csv>' }],
      execute: async (ctx) => ({
        out: await ctx.assets.put(new TextEncoder().encode('a,b\n1,2\n'), { mediaType: 'text/csv', format: 'csv' }),
      }),
    });
    const { events } = await runSingle(module, undefined, assets);
    const preview = ofType(events, 'node:succeeded')[0].outputPreviews[0].preview;
    expect(preview.kind).toBe('asset');
    const ref = (preview as { ref: { hash: string; mediaType: string } }).ref;
    expect(ref.mediaType).toBe('text/csv');
    expect(ref.hash).toMatch(/^b3:/);
  });

  it('previews null as empty and other values as pretty-printed JSON', async () => {
    const module = mod({
      type: 'test.mixed',
      outputs: [
        { id: 'nothing', type: 'json' },
        { id: 'data', type: 'json' },
      ],
      execute: async () => ({ nothing: null, data: { b: 2, a: [1, 2] } }),
    });
    const { events } = await runSingle(module);
    const previews = ofType(events, 'node:succeeded')[0].outputPreviews;
    expect(previews[0].preview).toEqual({ kind: 'empty' });
    expect(previews[1].preview.kind).toBe('json');
    const json = previews[1].preview as { json: string; truncated: boolean };
    expect(json.json).toBe(JSON.stringify({ b: 2, a: [1, 2] }, null, 2)); // 2-space pretty print
    expect(json.truncated).toBe(false);
  });

  it('truncates JSON previews at 16000 chars', async () => {
    const module = mod({
      type: 'test.bigjson',
      outputs: [{ id: 'out', type: 'json' }],
      execute: async () => ({ out: { text: 'y'.repeat(20_000) } }),
    });
    const { events } = await runSingle(module);
    const preview = ofType(events, 'node:succeeded')[0].outputPreviews[0].preview as { json: string; truncated: boolean };
    expect(preview.json).toHaveLength(16_000);
    expect(preview.truncated).toBe(true);
  });
});

describe('node:log and node:progress', () => {
  it('includes log data only when its canonicalJson is <= 8000 chars', async () => {
    const module = mod({
      type: 'test.logger',
      outputs: [{ id: 'out', type: 'text' }],
      execute: async (ctx) => {
        ctx.log('info', 'small', { ok: true });
        ctx.log('warn', 'big', { blob: 'z'.repeat(9_000) });
        ctx.log('debug', 'none');
        return { out: 'done' };
      },
    });
    const { events } = await runSingle(module);
    const logs = ofType(events, 'node:log');
    expect(logs).toHaveLength(3);
    expect(logs[0]).toMatchObject({ level: 'info', message: 'small', data: { ok: true } });
    expect(logs[1].data).toBeUndefined(); // oversized data dropped, event kept
    expect(logs[1].message).toBe('big');
    expect(logs[2].data).toBeUndefined();
  });

  it('clamps progress fractions to [0, 1]', async () => {
    const module = mod({
      type: 'test.progress',
      outputs: [{ id: 'out', type: 'text' }],
      execute: async (ctx) => {
        ctx.progress(-0.5, 'under');
        ctx.progress(0.25);
        ctx.progress(1.5, 'over');
        ctx.progress(undefined, 'indeterminate');
        return { out: 'done' };
      },
    });
    const { events } = await runSingle(module);
    const progress = ofType(events, 'node:progress');
    expect(progress.map((e) => [e.fraction, e.message])).toEqual([
      [0, 'under'],
      [0.25, undefined],
      [1, 'over'],
      [undefined, 'indeterminate'],
    ]);
  });
});
