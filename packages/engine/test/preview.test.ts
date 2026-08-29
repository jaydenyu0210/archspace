/** Previews (§7.6): size caps, kinds by port type and value, log/progress caps. */
import { describe, expect, it } from 'vitest';
import { MemoryAssetStore, type Value } from '@archspace/node-sdk';
import { createVirtualScheduler, startRun, type ValuePreview } from '../src/index.js';
import { eventsOf, finish, graph, mod, nodeSpec, ofType, reg } from './helpers.js';

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

describe('a table preview is budgeted by bytes, not only by rows', () => {
  /** N rows, each carrying `cellChars` characters of text. */
  const tableOf = (rows: number, cellChars: number) => ({
    columns: [{ id: 'c', label: 'Cell' }],
    rows: Array.from({ length: rows }, (_, i) => ({ c: `${i}:${'x'.repeat(cellChars)}` })),
  });

  const previewOf = async (table: unknown) => {
    const module = mod({
      type: 'test.bigtable',
      outputs: [{ id: 'out', type: 'table' }],
      execute: async () => ({ out: table as Value }),
    });
    const { events } = await runSingle(module);
    return ofType(events, 'node:succeeded')[0].outputPreviews[0].preview as {
      kind: string;
      rows: Record<string, Value>[];
      totalRows: number;
    };
  };

  it('carries every row of a small table', async () => {
    const preview = await previewOf(tableOf(10, 20));
    expect(preview.kind).toBe('table');
    expect(preview.rows).toHaveLength(10);
    expect(preview.totalRows).toBe(10);
  });

  it('stops at 50 rows when the rows are short', async () => {
    const preview = await previewOf(tableOf(500, 10));
    expect(preview.rows).toHaveLength(50);
    expect(preview.totalRows).toBe(500);
  });

  it('stops well before 50 rows when the cells are large', async () => {
    // The gap this closes: fifty rows of short cells and fifty rows of a
    // megabyte each are the same number of rows, and §7.6 is a promise about
    // bytes. The preview rides on every `node:succeeded` event.
    const preview = await previewOf(tableOf(50, 5_000));
    expect(preview.rows.length).toBeLessThan(50);
    expect(preview.totalRows).toBe(50);
    const bytes = JSON.stringify(preview.rows).length;
    expect(bytes).toBeLessThan(25_000);
  });

  it('always carries at least one row, however large it is', async () => {
    // A preview that can decline to show anything is not a preview — the same
    // rule the plan budget follows for its first storey.
    const preview = await previewOf(tableOf(3, 200_000));
    expect(preview.rows).toHaveLength(1);
    expect(preview.totalRows).toBe(3);
  });

  it('keeps rows whole, never half of one', async () => {
    // A budget that truncated a cell would produce a preview that looks like
    // data and is not. Each surviving row must be byte-for-byte the row the
    // node produced.
    const source = tableOf(40, 2_000);
    const preview = await previewOf(source);
    expect(preview.rows.length).toBeGreaterThan(0);
    preview.rows.forEach((row, i) => {
      expect(row).toEqual(source.rows[i]);
    });
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

describe('plan previews', () => {
  /** The shape aec.generate_floor_plan actually emits, trimmed to one level. */
  const PLAN = {
    planId: 'plan_abc',
    units: 'mm',
    site: { widthMm: 48000, depthMm: 32000 },
    metrics: { efficiency: 0.62 },
    levels: [
      {
        level: 0,
        elevationMm: 0,
        rooms: [{ id: 'r0', name: 'Corridor', function: 'circulation', areaM2: 86.4, polygon: [[0, 15100], [48000, 15100], [48000, 16900], [0, 16900]] }],
        walls: [{ id: 'w0', start: [0, 0], end: [48000, 0], thicknessMm: 200, kind: 'exterior' }],
        doors: [{ id: 'd0', roomId: 'r0', position: [2400, 15100], widthMm: 900 }],
        exits: [{ id: 'e0', kind: 'stair', position: [0, 16000] }],
      },
      { level: 1, elevationMm: 3500, rooms: [], walls: [], doors: [], exits: [] },
    ],
  } as unknown as Value;

  function planModule(value: Value) {
    return mod({
      type: 'test.plan',
      outputs: [{ id: 'out', type: 'json', preview: 'plan' }],
      execute: async () => ({ out: value }),
    });
  }

  it('draws geometry out of a plan instead of dumping its JSON', async () => {
    const { events } = await runSingle(planModule(PLAN));
    const preview = ofType(events, 'node:succeeded')[0].outputPreviews[0].preview;

    expect(preview.kind).toBe('plan');
    const plan = preview as Extract<ValuePreview, { kind: 'plan' }>;
    expect(plan.levelCount).toBe(2);
    expect(plan.site).toEqual({ widthMm: 48000, depthMm: 32000 });
    // The second level is empty, so nothing drawable came off it and it is not
    // carried — the level *count* is what tells the UI it exists.
    expect(plan.levels).toHaveLength(1);
    expect(plan.levels[0]?.rooms).toEqual([
      { name: 'Corridor', polygon: [[0, 15100], [48000, 15100], [48000, 16900], [0, 16900]] },
    ]);
    // Walls and doors are flattened tuples: at ~640 walls a plan, the key names
    // cost more than the numbers do.
    expect(plan.levels[0]?.walls).toEqual([[0, 0, 48000, 0, 200]]);
    expect(plan.levels[0]?.doors).toEqual([[2400, 15100, 900]]);
    expect(plan.levels[0]?.exits).toEqual([[0, 16000]]);
  });

  it('is dramatically smaller than the JSON it replaces', async () => {
    // The point of the whole exercise: a six-storey plan is 261,000 characters
    // of JSON, so the generic preview showed its leading 6%, cut mid-structure.
    const { events } = await runSingle(planModule(PLAN));
    const preview = ofType(events, 'node:succeeded')[0].outputPreviews[0].preview;
    const asPlan = JSON.stringify(preview).length;
    const asJson = JSON.stringify(PLAN, null, 2).length;
    expect(asPlan).toBeLessThan(asJson);
  });

  it('falls back to JSON when the hint is right but the value is not a plan', async () => {
    // The hint says what the port is meant to carry; it cannot promise what
    // arrived. A preview that threw here would take the whole run's event
    // stream with it.
    for (const value of [
      { levels: [], site: {} },
      { levels: [{ level: 0, rooms: [], walls: [] }], site: { widthMm: 1, depthMm: 1 } },
      { nothing: 'like a plan' },
      [1, 2, 3],
      'a string',
      42,
    ] as Value[]) {
      const { events } = await runSingle(planModule(value));
      const preview = ofType(events, 'node:succeeded')[0].outputPreviews[0].preview;
      expect(preview.kind, JSON.stringify(value).slice(0, 40)).toBe('json');
    }
  });

  it('drops malformed rooms rather than the whole plan', async () => {
    const damaged = {
      ...(PLAN as Record<string, unknown>),
      levels: [
        {
          ...((PLAN as Record<string, unknown>).levels as Record<string, unknown>[])[0],
          rooms: [
            { name: 'Good', polygon: [[0, 0], [100, 0], [100, 100]] },
            { name: 'Too few points', polygon: [[0, 0], [1, 1]] },
            { name: 'Not coordinates', polygon: ['a', 'b', 'c'] },
            'not even an object',
          ],
        },
      ],
    } as unknown as Value;

    const { events } = await runSingle(planModule(damaged));
    const preview = ofType(events, 'node:succeeded')[0].outputPreviews[0].preview;
    expect(preview.kind).toBe('plan');
    expect((preview as Extract<ValuePreview, { kind: 'plan' }>).levels[0]?.rooms.map((r) => r.name)).toEqual(['Good']);
  });

  it('carries every storey it can, so the panel can offer a switcher', async () => {
    // The first cut sent only the ground floor, which showed a sixth of a
    // six-storey building and implied the rest did not exist.
    const storeys = (n: number): Value => ({
      site: { widthMm: 48000, depthMm: 32000 },
      levels: Array.from({ length: n }, (_, i) => ({
        level: i,
        rooms: [{ name: `Room ${i}`, areaM2: 10, polygon: [[0, 0], [5000, 0], [5000, 4000], [0, 4000]] }],
        walls: [{ id: `w${i}`, start: [0, 0], end: [5000, 0], thicknessMm: 200, kind: 'exterior' }],
        doors: [],
        exits: [],
      })),
    }) as unknown as Value;

    const { events } = await runSingle(planModule(storeys(6)));
    const plan = ofType(events, 'node:succeeded')[0].outputPreviews[0].preview as Extract<ValuePreview, { kind: 'plan' }>;
    expect(plan.levels).toHaveLength(6);
    expect(plan.levelCount).toBe(6);
    expect(plan.levels.map((l) => l.level)).toEqual([0, 1, 2, 3, 4, 5]);
  });

  it('stops at a budget, and says how many storeys the plan really has', async () => {
    // The preview rides on every node:succeeded event. Six storeys of the real
    // example are ~34 KB; a hundred-storey tower must not be ~570 KB, and the
    // UI must not present the storeys it did get as the whole building.
    const tall = {
      site: { widthMm: 48000, depthMm: 32000 },
      levels: Array.from({ length: 200 }, (_, i) => ({
        level: i,
        rooms: Array.from({ length: 20 }, (_, r) => ({
          name: `Room ${r}`,
          areaM2: 10,
          polygon: [[0, 0], [5000, 0], [5000, 4000], [0, 4000]],
        })),
        walls: Array.from({ length: 40 }, () => ({ start: [0, 0], end: [5000, 0], thicknessMm: 200 })),
        doors: [],
        exits: [],
      })),
    } as unknown as Value;

    const { events } = await runSingle(planModule(tall));
    const plan = ofType(events, 'node:succeeded')[0].outputPreviews[0].preview as Extract<ValuePreview, { kind: 'plan' }>;
    expect(plan.levelCount).toBe(200);
    expect(plan.levels.length).toBeLessThan(200);
    expect(plan.levels.length).toBeGreaterThan(0);
    // Bounded in bytes, which is the thing that actually matters.
    expect(JSON.stringify(plan).length).toBeLessThan(200_000);
  });

  it('never budgets its way down to nothing', async () => {
    // One enormous storey still previews: a plan the user can see is worth more
    // than a byte count, and returning nothing here would fall back to JSON.
    const huge = {
      site: { widthMm: 48000, depthMm: 32000 },
      levels: [
        {
          level: 0,
          rooms: Array.from({ length: 4000 }, () => ({
            name: 'R',
            polygon: [[0, 0], [1, 0], [1, 1], [0, 1]],
          })),
          walls: [],
          doors: [],
          exits: [],
        },
        { level: 1, rooms: [{ name: 'Next', polygon: [[0, 0], [1, 0], [1, 1]] }], walls: [], doors: [], exits: [] },
      ],
    } as unknown as Value;

    const { events } = await runSingle(planModule(huge));
    const plan = ofType(events, 'node:succeeded')[0].outputPreviews[0].preview as Extract<ValuePreview, { kind: 'plan' }>;
    expect(plan.kind).toBe('plan');
    expect(plan.levels).toHaveLength(1);
    expect(plan.levelCount).toBe(2);
  });

  it('skips a storey with nothing on it rather than showing an empty plan', async () => {
    const withGap = {
      site: { widthMm: 48000, depthMm: 32000 },
      levels: [
        { level: 0, rooms: [], walls: [], doors: [], exits: [] },
        { level: 1, rooms: [{ name: 'Real', polygon: [[0, 0], [5000, 0], [5000, 4000]] }], walls: [], doors: [], exits: [] },
      ],
    } as unknown as Value;

    const { events } = await runSingle(planModule(withGap));
    const plan = ofType(events, 'node:succeeded')[0].outputPreviews[0].preview as Extract<ValuePreview, { kind: 'plan' }>;
    expect(plan.levels.map((l) => l.level)).toEqual([1]);
    expect(plan.levelCount).toBe(2);
  });

  it('ignores the hint on ports that carry something else entirely', async () => {
    // An asset is an asset whatever the port hints, because the ref is the only
    // thing that can be rendered and the only thing that can be saved.
    const module = mod({
      type: 'test.plan_asset',
      outputs: [{ id: 'out', type: 'asset<dxf>', preview: 'plan' }],
      execute: async (ctx) => ({ out: await ctx.assets.put(new TextEncoder().encode('x'), { mediaType: 'image/vnd.dxf' }) }),
    });
    const { events } = await runSingle(module);
    expect(ofType(events, 'node:succeeded')[0].outputPreviews[0].preview.kind).toBe('asset');
  });
});
