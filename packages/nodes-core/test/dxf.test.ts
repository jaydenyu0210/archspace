/**
 * DXF export: format validity, geometry fidelity, and the traps.
 *
 * Every assertion here goes through `parse()`, which reads the output back into
 * group-code pairs, rather than matching substrings. A DXF file is nothing but
 * code/value line pairs, so parsing it is cheap — and a substring test would
 * pass on a file whose pairs are misaligned by one line, which is precisely the
 * failure mode a hand-rolled writer has. The point of the exercise is to catch
 * the writer being wrong, not to confirm it wrote something.
 *
 * The specific traps under test, each of which produces a file that opens
 * without complaint and shows the wrong thing:
 *   - TEXT with code 72 set but no 11/21 point stacks every label at the origin
 *   - POLYLINE without 66/1 drops all its vertices
 *   - a layer referenced before the LAYER table defines it
 *   - $EXTMIN/$EXTMAX not covering the geometry, so "zoom extents" finds nothing
 */
import { describe, expect, it } from 'vitest';
import { createMemoryAssetStore } from '@archspace/node-sdk';
import { runNode } from '@archspace/node-sdk/testkit';
import type { AssetRef } from '@archspace/node-sdk';
import {
  exportDxfNode,
  generateFloorPlanNode,
  projectBriefNode,
  spaceProgramNode,
  type FloorPlanResult,
} from '../src/index.js';
import { polygonCentroid, wallOutline } from '../src/export-dxf.js';
import { encodeCp1252, writeDxf, type DxfDrawing } from '../src/dxf.js';

/**
 * cp1252 bytes back to characters.
 *
 * `TextDecoder` only speaks UTF-8 here, and decoding a cp1252 file as UTF-8 is
 * precisely the mistake the writer exists to avoid — a test that made it would
 * be validating the writer against its own error.
 */
const CP1252_HIGH = '\u20AC\u0081\u201A\u0192\u201E\u2026\u2020\u2021\u02C6\u2030\u0160\u2039\u0152\u008D\u017D\u008F'
  + '\u0090\u2018\u2019\u201C\u201D\u2022\u2013\u2014\u02DC\u2122\u0161\u203A\u0153\u009D\u017E\u0178';

function decodeCp1252(bytes: Uint8Array): string {
  let out = '';
  for (const b of bytes) {
    out += b >= 0x80 && b <= 0x9f ? (CP1252_HIGH[b - 0x80] as string) : String.fromCharCode(b);
  }
  return out;
}

// ---------------------------------------------------------------- parsing ---

type Pair = [number, string];

/**
 * A DXF file back into the pairs it is made of.
 *
 * This is strict on purpose: an odd number of lines, or a code line that is not
 * an integer, means the writer emitted half a record, and that is exactly the
 * bug worth failing on rather than tolerating.
 */
function parse(text: string): Pair[] {
  // CRLF is the record separator, and a bare LF anywhere would mean a value
  // line carrying a stray CR into whatever reads it.
  expect(text.replace(/\r\n/g, ''), 'no bare LF outside a CRLF pair').not.toContain('\n');
  const lines = text.split('\r\n');
  // The file ends with a separator, so the final split element is an empty tail.
  if (lines.at(-1) === '') lines.pop();
  expect(lines.length % 2, 'DXF must be an even number of lines (code/value pairs)').toBe(0);

  const pairs: Pair[] = [];
  for (let i = 0; i < lines.length; i += 2) {
    const raw = lines[i] as string;
    // Codes are right-justified in three columns; value lines must never be,
    // because leading whitespace there is part of the string.
    expect(raw, `line ${i + 1}: group code padded to three columns`).toMatch(/^ *\d+$/);
    expect(lines[i + 1] as string, `line ${i + 2}: value not padded`).not.toMatch(/^ /);
    const code = Number(raw.trim());
    expect(Number.isInteger(code), `line ${i + 1}: group code "${raw}" is not an integer`).toBe(true);
    pairs.push([code, lines[i + 1] as string]);
  }
  return pairs;
}

/** The pairs between `0/SECTION`, `2/<name>` and the matching `0/ENDSEC`. */
function section(pairs: Pair[], name: string): Pair[] {
  const start = pairs.findIndex(
    ([c, v], i) => c === 0 && v === 'SECTION' && pairs[i + 1]?.[0] === 2 && pairs[i + 1]?.[1] === name,
  );
  expect(start, `section ${name} present`).toBeGreaterThanOrEqual(0);
  const end = pairs.findIndex(([c, v], i) => i > start && c === 0 && v === 'ENDSEC');
  expect(end, `section ${name} closed`).toBeGreaterThan(start);
  return pairs.slice(start + 2, end);
}

/** Entities as records: the `0/<TYPE>` marker plus everything up to the next one. */
interface Entity {
  type: string;
  pairs: Pair[];
}

function entities(pairs: Pair[]): Entity[] {
  const out: Entity[] = [];
  for (const pair of pairs) {
    if (pair[0] === 0) out.push({ type: pair[1], pairs: [] });
    else out.at(-1)?.pairs.push(pair);
  }
  return out;
}

/** The first value for a group code within one entity. */
function code(e: Entity, c: number): string | undefined {
  return e.pairs.find(([k]) => k === c)?.[1];
}

/** A header variable's values: everything after `9/$NAME` up to the next `9`. */
function headerVar(pairs: Pair[], name: string): Pair[] {
  const at = pairs.findIndex(([c, v]) => c === 9 && v === name);
  expect(at, `header variable ${name} present`).toBeGreaterThanOrEqual(0);
  const rest = pairs.slice(at + 1);
  // Stop at the next variable (9) *or* at ENDSEC (0) — the last variable in the
  // section has no 9 after it, and without the 0 guard it would swallow the
  // rest of the file.
  const next = rest.findIndex(([c]) => c === 9 || c === 0);
  return next === -1 ? rest : rest.slice(0, next);
}

/**
 * The x-extent actually drawn for each storey, keyed by level.
 *
 * Two R12 traps make a naive scan report nonsense, and both were hit while
 * writing this: a POLYLINE's own group 10 is a dummy `(0, 0)` with the real
 * points in the VERTEX entities that follow it, and a justified TEXT parks a
 * placeholder in 10 with its true insertion point in 11. Reading every 10 in
 * the file therefore reports a minimum of zero for every storey and hides the
 * exact overlap this exists to catch.
 */
function storeyXSpans(pairs: Pair[]): Map<number, { min: number; max: number }> {
  const spans = new Map<number, { min: number; max: number }>();
  let level: number | null = null;
  let kind = '';
  for (const [c, v] of section(pairs, 'ENTITIES')) {
    if (c === 0) {
      kind = v;
      continue;
    }
    if (c === 8) {
      const m = /-L(\d+)$/.exec(v);
      level = m ? Number(m[1]) : null;
      continue;
    }
    if (level === null) continue;
    const positional = kind === 'TEXT' ? c === 11 : (kind === 'VERTEX' || kind === 'LINE' || kind === 'CIRCLE') && c === 10;
    if (!positional) continue;
    const x = Number(v);
    if (!Number.isFinite(x)) continue;
    const span = spans.get(level) ?? { min: Infinity, max: -Infinity };
    spans.set(level, { min: Math.min(span.min, x), max: Math.max(span.max, x) });
  }
  return spans;
}

// ------------------------------------------------------------- fixtures ----

interface Exported {
  text: string;
  pairs: Pair[];
  plan: FloorPlanResult;
  outputs: Record<string, unknown>;
  ref: AssetRef;
}

/** brief → program → plan → dxf, returning both the plan and the parsed file. */
async function exportPlan(
  params: Record<string, unknown> = {},
  briefParams: Record<string, unknown> = {},
): Promise<Exported> {
  const assets = createMemoryAssetStore();
  const brief = await runNode(projectBriefNode, { assets, ...(Object.keys(briefParams).length > 0 ? { params: briefParams } : {}) });
  const program = await runNode(spaceProgramNode, {
    inputs: { brief: brief.outputs.brief },
    assets,
  });
  const planRun = await runNode(generateFloorPlanNode, {
    params: { backend: 'mock' as const, mock_latency_ms: 0 },
    inputs: { brief: brief.outputs.brief, program: program.outputs.program },
    assets,
  });
  const dxf = await runNode(exportDxfNode, {
    params,
    inputs: { floor_plan: planRun.outputs.floor_plan },
    assets,
  });

  const ref = dxf.outputs.dxf as AssetRef;
  const text = decodeCp1252(await assets.bytes(ref));
  return {
    text,
    pairs: parse(text),
    plan: planRun.outputs.floor_plan as unknown as FloorPlanResult,
    outputs: dxf.outputs as unknown as Record<string, unknown>,
    ref,
  };
}

// ------------------------------------------------------------ structure ----

describe('DXF file structure', () => {
  it('is well-formed R12 with sections in order and EOF last', async () => {
    const { pairs } = await exportPlan();

    const sections = pairs
      .map(([c, v], i) => (c === 0 && v === 'SECTION' ? pairs[i + 1]?.[1] : undefined))
      .filter((s): s is string => s !== undefined);
    expect(sections).toEqual(['HEADER', 'TABLES', 'BLOCKS', 'ENTITIES']);

    expect(pairs.at(-1)).toEqual([0, 'EOF']);
    expect(headerVar(pairs, '$ACADVER')).toEqual([[1, 'AC1009']]);
    // Millimetres. A plan drawn in mm and read as inches is off by 25.4×.
    expect(headerVar(pairs, '$INSUNITS')).toEqual([[70, '4']]);
    expect(headerVar(pairs, '$MEASUREMENT')).toEqual([[70, '1']]);
    // The codepage the bytes are actually in — see the encoding tests below.
    expect(headerVar(pairs, '$DWGCODEPAGE')).toEqual([[3, 'ANSI_1252']]);
  });

  it('defines STANDARD, which every unstyled TEXT resolves to', () => {
    // Same hazard as an undefined linetype: AutoCAD refuses a file that
    // references an undefined symbol, while lenient readers substitute a
    // default and a local test proves nothing.
    const pairs = parse(writeDxf({ layers: [], entities: [] }));
    const styles = entities(section(pairs, 'TABLES')).filter((e) => e.type === 'STYLE');
    expect(styles.map((e) => code(e, 2))).toEqual(['STANDARD']);
    // A non-zero fixed height here silently overrides every TEXT's own height.
    expect(code(styles[0] as Entity, 40)).toBe('0.0');
    // The big-font name is an empty value line, not an omitted one; omitting it
    // shifts every following record onto the wrong side of the pairing.
    expect(code(styles[0] as Entity, 4)).toBe('');
  });

  it('declares extents that actually contain the geometry', async () => {
    const { pairs, plan } = await exportPlan({ level: '0' });
    const min = headerVar(pairs, '$EXTMIN');
    const max = headerVar(pairs, '$EXTMAX');

    const [minX, minY] = [Number(min[0]?.[1]), Number(min[1]?.[1])];
    const [maxX, maxY] = [Number(max[0]?.[1]), Number(max[1]?.[1])];
    expect(maxX).toBeGreaterThan(minX);
    expect(maxY).toBeGreaterThan(minY);

    // Every room vertex on the exported level must fall inside the box, or
    // "zoom extents" lands the user on empty space.
    const level = plan.levels.find((l) => l.level === 0);
    for (const room of level?.rooms ?? []) {
      for (const [x, y] of room.polygon) {
        expect(x).toBeGreaterThanOrEqual(minX);
        expect(x).toBeLessThanOrEqual(maxX);
        expect(y).toBeGreaterThanOrEqual(minY);
        expect(y).toBeLessThanOrEqual(maxY);
      }
    }
  });

  it('defines CONTINUOUS before any layer references it', async () => {
    const { pairs } = await exportPlan();
    const tables = section(pairs, 'TABLES');
    const ltype = tables.findIndex(([c, v]) => c === 0 && v === 'LTYPE');
    const firstLayer = tables.findIndex(([c, v]) => c === 0 && v === 'LAYER');
    expect(ltype).toBeGreaterThanOrEqual(0);
    expect(firstLayer).toBeGreaterThan(ltype);
  });

  it('defines every layer an entity draws on, and no layer it does not', async () => {
    const { pairs } = await exportPlan();

    const defined = new Set(
      entities(section(pairs, 'TABLES'))
        .filter((e) => e.type === 'LAYER')
        .map((e) => code(e, 2) as string),
    );
    const used = new Set(
      entities(section(pairs, 'ENTITIES'))
        .map((e) => code(e, 8))
        .filter((l): l is string => l !== undefined),
    );

    expect(used.size).toBeGreaterThan(0);
    for (const layer of used) expect(defined, `layer ${layer} defined`).toContain(layer);
    // The reverse direction: an empty layer advertises content that is not there.
    for (const layer of defined) expect(used, `layer ${layer} used`).toContain(layer);

    // The declared table count must match what follows it, or a reader that
    // trusts the count reads past the end of the table.
    const declared = Number(
      section(pairs, 'TABLES').find(([c, v], i) => {
        const prev = section(pairs, 'TABLES')[i - 1];
        return c === 70 && prev?.[0] === 2 && prev?.[1] === 'LAYER' && v !== undefined;
      })?.[1],
    );
    expect(declared).toBe(defined.size);
  });

  it('names layers with the AIA convention and a storey suffix', async () => {
    const { pairs } = await exportPlan({ level: '1' });
    const layers = entities(section(pairs, 'TABLES'))
      .filter((e) => e.type === 'LAYER')
      .map((e) => code(e, 2));

    expect(layers).toContain('A-WALL-EXTR-L1');
    expect(layers).toContain('A-AREA-BDRY-L1');
    for (const name of layers) expect(name).toMatch(/^A-[A-Z-]+-L\d+$/);
  });
});

// -------------------------------------------------------------- entities ---

describe('DXF entities', () => {
  it('draws one closed polyline per room, at the plan coordinates', async () => {
    const { pairs, plan } = await exportPlan({ level: '0', include_labels: false });
    const level = plan.levels.find((l) => l.level === 0);
    const rooms = level?.rooms ?? [];
    expect(rooms.length).toBeGreaterThan(0);

    const drawn = entities(section(pairs, 'ENTITIES'));
    const boundaries = drawn.filter((e) => e.type === 'POLYLINE' && code(e, 8) === 'A-AREA-BDRY-L0');
    expect(boundaries.length).toBe(rooms.length);

    // The vertices belonging to the first room polyline, read back as numbers.
    const start = drawn.indexOf(boundaries[0] as Entity);
    const verts: Array<[number, number]> = [];
    for (let i = start + 1; drawn[i]?.type === 'VERTEX'; i++) {
      const e = drawn[i] as Entity;
      verts.push([Number(code(e, 10)), Number(code(e, 20))]);
    }
    expect(verts).toEqual(rooms[0]?.polygon);
  });

  it('gives every polyline the 66 flag and a matching SEQEND', async () => {
    const { pairs } = await exportPlan();
    const drawn = entities(section(pairs, 'ENTITIES'));

    const polylines = drawn.filter((e) => e.type === 'POLYLINE');
    expect(polylines.length).toBeGreaterThan(0);
    // Without 66/1 a reader treats the POLYLINE as having no vertices and the
    // room simply is not there — a valid file that draws nothing.
    for (const p of polylines) expect(code(p, 66)).toBe('1');
    // Every room and wall outline is a closed shape.
    for (const p of polylines) expect(code(p, 70)).toBe('1');

    expect(drawn.filter((e) => e.type === 'SEQEND').length).toBe(polylines.length);

    // Vertices must be enclosed: each VERTEX follows a POLYLINE and precedes
    // its SEQEND, never floating between entities.
    let open = false;
    for (const e of drawn) {
      if (e.type === 'POLYLINE') open = true;
      else if (e.type === 'SEQEND') open = false;
      else if (e.type === 'VERTEX') expect(open, 'VERTEX inside a POLYLINE group').toBe(true);
    }
    expect(open).toBe(false);
  });

  it('positions labels with BOTH alignment points, not just 10/20', async () => {
    const { pairs } = await exportPlan({ level: '0', text_height_mm: 250 });
    const texts = entities(section(pairs, 'ENTITIES')).filter((e) => e.type === 'TEXT');
    expect(texts.length).toBeGreaterThan(0);

    for (const t of texts) {
      expect(code(t, 40)).toBe('250.000000');
      // Centred both ways, so the label sits on the centroid rather than
      // resting its baseline there.
      expect(code(t, 72)).toBe('1');
      expect(code(t, 73)).toBe('2');
      // The trap: with 72 non-zero, 10/20 is ignored and 11/21 positions the
      // text. Omit 11/21 and every label lands on the origin in a heap.
      expect(code(t, 11)).toBe(code(t, 10));
      expect(code(t, 21)).toBe(code(t, 20));
    }

    // Labels are not all in the same place — the centroid is per-room.
    const positions = new Set(texts.map((t) => `${code(t, 11)},${code(t, 21)}`));
    expect(positions.size).toBe(texts.length);
  });

  it('labels each room with its name and area', async () => {
    const { pairs, plan } = await exportPlan({ level: '0' });
    const labels = entities(section(pairs, 'ENTITIES'))
      .filter((e) => e.type === 'TEXT')
      .map((e) => code(e, 1) as string);

    const rooms = plan.levels.find((l) => l.level === 0)?.rooms ?? [];
    expect(labels.length).toBe(rooms.length);
    for (const room of rooms) {
      expect(labels.some((l) => l.startsWith(`${room.name} `))).toBe(true);
    }
    // ASCII, deliberately: see roomLabel in export-dxf.ts. The writer could
    // carry "m²" through cp1252 now, but a label this node composes itself has
    // no reason to depend on the codepage at all.
    for (const label of labels) expect(label).toMatch(/ - [\d.]+ m2$/);
    for (const label of labels) expect(label).toMatch(/^[\x20-\x7e]*$/);
  });

  it('draws walls as their thickness, not as hairlines', async () => {
    const { pairs, plan } = await exportPlan({ level: '0', include_labels: false });
    const level = plan.levels.find((l) => l.level === 0);
    const walls = level?.walls ?? [];
    expect(walls.length).toBeGreaterThan(0);

    const drawn = entities(section(pairs, 'ENTITIES'));
    const wallLayers = ['A-WALL-EXTR-L0', 'A-WALL-INTR-L0'];
    const outlines = drawn.filter(
      (e) => e.type === 'POLYLINE' && wallLayers.includes(code(e, 8) ?? ''),
    );
    expect(outlines.length).toBe(walls.length);

    // Each wall outline is a rectangle: four vertices, not two.
    for (const outline of outlines) {
      const start = drawn.indexOf(outline);
      let count = 0;
      for (let i = start + 1; drawn[i]?.type === 'VERTEX'; i++) count++;
      expect(count).toBe(4);
    }

    // Exterior and interior walls land on different layers. Counting POLYLINE
    // records specifically, because VERTEX and SEQEND carry a layer code too —
    // a bare layer filter counts six records per wall.
    const exterior = walls.filter((w) => w.kind === 'exterior').length;
    const onExterior = drawn.filter((e) => e.type === 'POLYLINE' && code(e, 8) === 'A-WALL-EXTR-L0');
    expect(onExterior.length).toBe(exterior);
    expect(exterior).toBeGreaterThan(0);
    expect(exterior).toBeLessThan(walls.length);
  });

  it('draws a circle per door at the door width, and none when turned off', async () => {
    const { pairs, plan } = await exportPlan({ level: '0', include_labels: false });
    const level = plan.levels.find((l) => l.level === 0);
    const doors = level?.doors ?? [];
    expect(doors.length).toBeGreaterThan(0);

    const circles = entities(section(pairs, 'ENTITIES')).filter(
      (e) => e.type === 'CIRCLE' && code(e, 8) === 'A-DOOR-L0',
    );
    expect(circles.length).toBe(doors.length);
    expect(Number(code(circles[0] as Entity, 40))).toBe((doors[0]?.widthMm ?? 0) / 2);

    const off = await exportPlan({ level: '0', include_doors: false });
    const layers = new Set(
      entities(section(off.pairs, 'ENTITIES')).map((e) => code(e, 8)),
    );
    expect(layers.has('A-DOOR-L0')).toBe(false);
    // …and the door layer is not declared either.
    expect(off.text).not.toContain('A-DOOR-L0');
  });

  it('emits nothing but geometry — no stray entity types', async () => {
    const { pairs } = await exportPlan();
    const seen = new Set(entities(section(pairs, 'ENTITIES')).map((e) => e.type));
    expect([...seen].sort()).toEqual(['CIRCLE', 'POLYLINE', 'SEQEND', 'TEXT', 'VERTEX']);
  });
});

// ------------------------------------------------------------- storeys -----

describe('storey selection', () => {
  it('draws every storey side by side by default', async () => {
    const all = await exportPlan();
    const plan = all.plan;
    expect(plan.levels.length).toBeGreaterThan(1);
    expect(all.outputs.levels_drawn).toBe(plan.levels.length);

    const layers = new Set(
      entities(section(all.pairs, 'ENTITIES')).map((e) => code(e, 8)),
    );
    for (const level of plan.levels) {
      expect(layers, `level ${level.level} drawn`).toContain(`A-AREA-BDRY-L${level.level}`);
    }

    // Side by side, so the drawing is wider than the site.
    const maxX = Number(headerVar(all.pairs, '$EXTMAX')[0]?.[1]);
    expect(maxX).toBeGreaterThan(plan.site.widthMm);
  });

  it('draws one storey at the plan coordinates, unshifted', async () => {
    const one = await exportPlan({ level: '1' });
    expect(one.outputs.levels_drawn).toBe(1);

    // Unshifted, so the drawing sits on the site. Not exactly the site width:
    // a wall on the boundary is drawn as a rectangle, so its outline overhangs
    // by half its thickness. One metre of slack covers that and still fails
    // loudly if the storey were shifted by a full site width.
    const maxX = Number(headerVar(one.pairs, '$EXTMAX')[0]?.[1]);
    expect(maxX).toBeLessThan(one.plan.site.widthMm + 1000);
    expect(Number(headerVar(one.pairs, '$EXTMIN')[0]?.[1])).toBeLessThan(1000);

    const layers = new Set(entities(section(one.pairs, 'ENTITIES')).map((e) => code(e, 8)));
    for (const layer of layers) expect(layer).toMatch(/-L1$/);
  });

  it('never overlaps two storeys, on a site deeper than it is wide', async () => {
    // The regression. `aec.generate_floor_plan` runs its corridor along the
    // LONG axis (floor-plan.ts:97), so a storey occupies `max(width, depth)`
    // in x — and the pitch between storeys was `site.widthMm`. On a site
    // deeper than it is wide, every storey was therefore wider than the
    // distance to the next one and they drew on top of each other: three
    // storeys of a 20 x 60 m site overlapped by 38.2 m of a 60.2 m span. It
    // survived because every shipped example is wider than it is deep, where
    // the wrong number happens to be the larger one and merely leaves a gap.
    //
    // Asserted on the storeys' own geometry rather than on `$EXTMAX`, because
    // a total extent is exactly what an overlap does not change.
    const deep = await exportPlan({ level: 'all' }, { site_width_m: 20, site_depth_m: 60, floors: 3, target_gross_area_m2: 2400 });
    expect(deep.plan.site.depthMm).toBeGreaterThan(deep.plan.site.widthMm);
    expect(deep.plan.levels.length).toBeGreaterThan(1);

    const spans = storeyXSpans(deep.pairs);
    expect(spans.size).toBe(deep.plan.levels.length);

    const ordered = [...spans.entries()].sort((a, b) => a[0] - b[0]);
    let previousMax = -Infinity;
    for (const [level, { min, max }] of ordered) {
      expect(min, `storey ${level} starts before storey ${level - 1} ends`).toBeGreaterThanOrEqual(previousMax);
      previousMax = max;
    }

    // And evenly: an irregular gutter reads as meaning rather than as packing.
    const widths = ordered.map(([, s]) => s.max - s.min);
    for (const w of widths) expect(w).toBeCloseTo(widths[0], 6);
  });

  it('refuses a storey the plan does not have, and says which it does', async () => {
    await expect(exportPlan({ level: '99' })).rejects.toThrow(/no level 99.*levels present: 0/s);
    await expect(exportPlan({ level: 'ground' })).rejects.toThrow(/storey number or "all"/);
  });
});

// -------------------------------------------------------------- the asset --

describe('the emitted asset', () => {
  it('is an asset<dxf> with the registered media type', async () => {
    const { ref, outputs } = await exportPlan({ file_name: 'tower.dxf' });
    expect(ref.kind).toBe('asset');
    expect(ref.format).toBe('dxf');
    expect(ref.mediaType).toBe('image/vnd.dxf');
    expect(ref.name).toBe('tower.dxf');
    expect(ref.size).toBeGreaterThan(0);
    expect(outputs.entity_count).toBeGreaterThan(0);
  });

  it('declares asset<dxf> on its output port', () => {
    const port = exportDxfNode.manifest.outputs.find((p) => p.id === 'dxf');
    expect(port?.type).toBe('asset<dxf>');
    expect(exportDxfNode.manifest.caching).toBe('pure');
  });

  it('is byte-identical across runs, so the store deduplicates it', async () => {
    const a = await exportPlan();
    const b = await exportPlan();
    expect(a.text).toBe(b.text);
    // Same bytes ⇒ same content hash ⇒ one copy in the CAS.
    expect(a.ref.hash).toBe(b.ref.hash);
  });
});

// ---------------------------------------------------------- pure helpers ---

describe('text values a reader will not mangle', () => {
  /** One TEXT entity's string, as it appears on the value line. */
  function labelFor(raw: string): string {
    const out = writeDxf({
      layers: [{ name: 'L', color: 7 }],
      entities: [{ kind: 'text', layer: 'L', at: [0, 0], height: 10, text: raw }],
    });
    const texts = entities(section(parse(out), 'ENTITIES')).filter((e) => e.type === 'TEXT');
    return code(texts[0] as Entity, 1) as string;
  }

  it('round-trips through cp1252, the codepage the header declares', () => {
    // The claim under test, stated as bytes: what the reader decodes is what
    // the writer meant. Writing UTF-8 into a file that declares ANSI_1252 is
    // how "Küche" arrives as "KÃ¼che", and a test that decoded as UTF-8 would
    // reproduce the writer's mistake rather than catch it.
    const label = 'Küche — 12 m² • “A”';
    // The layer name stays a plain R12 symbol; it is the text *value* that has
    // to survive the codepage, and only values carry user-typed characters.
    const out = writeDxf({
      layers: [{ name: 'A-AREA-IDEN', color: 7 }],
      entities: [{ kind: 'text', layer: 'A-AREA-IDEN', at: [0, 0], height: 10, text: label }],
    });
    const bytes = encodeCp1252(out);
    expect(bytes.length).toBe(out.length);
    expect(decodeCp1252(bytes)).toBe(out);

    const texts = entities(section(parse(decodeCp1252(bytes)), 'ENTITIES'));
    expect(code(texts[0] as Entity, 1)).toBe(label);
    // No control bytes beyond the CR and LF of the record separators.
    expect([...bytes].filter((b) => b < 0x20 && b !== 0x0a && b !== 0x0d)).toEqual([]);
  });

  it('escapes only what cp1252 cannot hold, the way AutoCAD does', () => {
    // Kept, because cp1252 has them — and a real byte beats an escape that
    // some readers show literally.
    expect(labelFor('12 m²')).toBe('12 m²');
    expect(labelFor('Café — B')).toBe('Café — B');
    // Outside cp1252 there is no byte to write, so the escape is the only
    // mechanism R12 offers.
    expect(labelFor('会議室')).toBe('\\U+4F1A\\U+8B70\\U+5BA4');
    // Astral characters become their surrogate pair, as AutoCAD writes them.
    expect(labelFor('\u{1F600}')).toBe('\\U+D83D\\U+DE00');
  });

  it('refuses to encode a character the declared codepage cannot represent', () => {
    // Unreachable through writeDxf, since text() escapes those first — this
    // guards the boundary against a future caller that bypasses it.
    expect(() => encodeCp1252('会')).toThrow(/cp1252/);
  });

  it('keeps a newline in a room name from corrupting the whole file', () => {
    // This is the sharp one. A value line containing a newline shifts every
    // following line onto the wrong side of the code/value pairing, so the file
    // is unrecoverable from that byte on — and nothing upstream forbids a
    // newline in a room name.
    const out = writeDxf({
      layers: [{ name: 'L', color: 7 }],
      entities: [
        { kind: 'text', layer: 'L', at: [0, 0], height: 10, text: 'Meeting\nRoom\r\n2' },
        // A second entity after it: if the pairing slipped, this is where a
        // structural parse fails rather than quietly reading garbage.
        { kind: 'circle', layer: 'L', centre: [5, 5], radius: 1 },
      ],
    });
    const drawn = entities(section(parse(out), 'ENTITIES'));
    expect(drawn.map((e) => e.type)).toEqual(['TEXT', 'CIRCLE']);
    expect(code(drawn[0] as Entity, 1)).toBe('Meeting Room  2');
  });

  it('spells a layer name identically in the table and on the entity', () => {
    // A layer defined under one spelling and referenced under another is a
    // dangling reference, which is worse than either spelling alone — so the
    // name goes through one function, used in both places.
    const pairs = parse(
      writeDxf({
        layers: [{ name: 'A-ZONE_2-L0', color: 7 }],
        entities: [{ kind: 'circle', layer: 'A-ZONE_2-L0', centre: [0, 0], radius: 1 }],
      }),
    );
    const defined = entities(section(pairs, 'TABLES'))
      .filter((e) => e.type === 'LAYER')
      .map((e) => code(e, 2));
    expect(defined).toEqual(['A-ZONE_2-L0']);
    expect(entities(section(pairs, 'ENTITIES')).map((e) => code(e, 8))).toEqual(defined);
  });

  it('rejects a layer name R12 cannot hold, rather than rewriting it', () => {
    // Symbol names are letters, digits, $ - _ and at most 31 characters. Silent
    // rewriting would desynchronise the table from the entities referring to it.
    const draw = (name: string): DxfDrawing => ({
      layers: [{ name, color: 7 }],
      entities: [{ kind: 'circle', layer: name, centre: [0, 0], radius: 1 }],
    });
    expect(() => writeDxf(draw('Zone É'))).toThrow(/valid R12 layer name/);
    expect(() => writeDxf(draw('has a space'))).toThrow(/valid R12 layer name/);
    expect(() => writeDxf(draw('x'.repeat(32)))).toThrow(/valid R12 layer name/);
    expect(() => writeDxf(draw(''))).toThrow(/valid R12 layer name/);
    expect(() => writeDxf(draw('x'.repeat(31)))).not.toThrow();
  });

  it('rejects a layer colour that would silently hide the layer', () => {
    // A negative 62 means "off": the file loads clean and draws nothing. A
    // decimal in an integer group code makes libdxfrw reject the entire file.
    const withColor = (color: number): DxfDrawing => ({ layers: [{ name: 'A-X', color }], entities: [] });
    expect(() => writeDxf(withColor(-7))).toThrow(/1\.\.255/);
    expect(() => writeDxf(withColor(0))).toThrow(/1\.\.255/);
    expect(() => writeDxf(withColor(7.5))).toThrow(/1\.\.255/);
    expect(() => writeDxf(withColor(256))).toThrow(/1\.\.255/);
  });

  it('rejects a text height of zero, which draws nothing and audits clean', () => {
    expect(() =>
      writeDxf({ layers: [], entities: [{ kind: 'text', layer: 'A-X', at: [0, 0], height: 0, text: 'x' }] }),
    ).toThrow(/positive height/);
  });
});

describe('polygonCentroid', () => {
  it('is the area centroid, not the vertex mean', () => {
    // An L-shape: a 6×2 foot (area 12, centroid (3,1)) plus a 2×4 leg
    // (area 8, centroid (1,4)). The area centroid is therefore
    // (12·3 + 8·1)/20 = 2.2 in x and (12·1 + 8·4)/20 = 2.2 in y. The vertex
    // mean is 16/6 = 2.667 — further out, and in the notch.
    const l: Array<[number, number]> = [
      [0, 0],
      [6, 0],
      [6, 2],
      [2, 2],
      [2, 6],
      [0, 6],
    ];
    const [x, y] = polygonCentroid(l);
    expect(x).toBeCloseTo(2.2, 6);
    expect(y).toBeCloseTo(2.2, 6);
    expect(x).not.toBeCloseTo(16 / 6, 3);
  });

  it('centres a rectangle regardless of winding', () => {
    const cw: Array<[number, number]> = [
      [0, 0],
      [0, 4],
      [10, 4],
      [10, 0],
    ];
    expect(polygonCentroid(cw)).toEqual([5, 2]);
  });

  it('falls back to the vertex mean for degenerate polygons', () => {
    expect(polygonCentroid([])).toEqual([0, 0]);
    expect(polygonCentroid([[3, 7]])).toEqual([3, 7]);
    expect(polygonCentroid([[0, 0], [4, 8]])).toEqual([2, 4]);
    // Collinear: zero signed area, so the shoelace centroid is 0/0.
    const collinear: Array<[number, number]> = [[0, 0], [1, 1], [2, 2]];
    expect(polygonCentroid(collinear)).toEqual([1, 1]);
  });
});

describe('wallOutline', () => {
  it('offsets a horizontal wall by half its thickness on each side', () => {
    const out = wallOutline([0, 0], [1000, 0], 200);
    expect(out).toEqual([
      [0, 100],
      [1000, 100],
      [1000, -100],
      [0, -100],
    ]);
  });

  it('offsets a diagonal wall perpendicular to its run', () => {
    const out = wallOutline([0, 0], [100, 100], Math.SQRT2 * 2);
    expect(out?.[0]?.[0]).toBeCloseTo(-1, 6);
    expect(out?.[0]?.[1]).toBeCloseTo(1, 6);
    // Opposite corners are the full thickness apart.
    const [ax, ay] = out?.[0] as [number, number];
    const [bx, by] = out?.[3] as [number, number];
    expect(Math.hypot(ax - bx, ay - by)).toBeCloseTo(Math.SQRT2 * 2, 6);
  });

  it('refuses degenerate walls rather than drawing a sliver', () => {
    expect(wallOutline([5, 5], [5, 5], 200)).toBeNull();
    expect(wallOutline([0, 0], [100, 0], 0)).toBeNull();
    expect(wallOutline([0, 0], [100, 0], -50)).toBeNull();
  });
});

describe('writeDxf', () => {
  const empty: DxfDrawing = { layers: [], entities: [] };

  it('writes a valid file for an empty drawing', () => {
    const pairs = parse(writeDxf(empty));
    expect(pairs.at(-1)).toEqual([0, 'EOF']);
    expect(headerVar(pairs, '$EXTMIN')).toEqual([
      [10, '0.000000'],
      [20, '0.000000'],
    ]);
    expect(entities(section(pairs, 'ENTITIES'))).toEqual([]);
  });

  it('normalises negative zero so identical drawings are identical bytes', () => {
    const a = writeDxf({ layers: [], entities: [{ kind: 'line', layer: 'L', from: [0, 0], to: [1, 1] }] });
    const b = writeDxf({ layers: [], entities: [{ kind: 'line', layer: 'L', from: [-0, -0], to: [1, 1] }] });
    expect(a).toBe(b);
    expect(a).not.toContain('-0.000000');
  });

  it('never writes exponent notation, which readers reject', () => {
    // Both ends of the range where String() would reach for an exponent: tiny
    // values round to zero, huge ones spell out every digit.
    const text = writeDxf({
      layers: [],
      entities: [{ kind: 'circle', layer: 'L', centre: [1e-7, 1e20], radius: 1 }],
    });
    expect(text).not.toMatch(/e[+-]?\d/i);
    expect(text).toContain('0.000000');
    expect(text).toContain('100000000000000000000.000000');
  });

  it('refuses a coordinate too large for fixed notation', () => {
    // toFixed silently returns "1e+21" past this point, defeating the whole
    // purpose of formatting reals by hand.
    expect(() =>
      writeDxf({ layers: [], entities: [{ kind: 'circle', layer: 'L', centre: [1e21, 0], radius: 1 }] }),
    ).toThrow(/too large/);
  });

  it('refuses a non-finite coordinate instead of writing "NaN"', () => {
    const bad: DxfDrawing = {
      layers: [],
      entities: [{ kind: 'circle', layer: 'L', centre: [Number.NaN, 0], radius: 1 }],
    };
    expect(() => writeDxf(bad)).toThrow(/non-finite/);
    expect(() =>
      writeDxf({ layers: [], entities: [{ kind: 'line', layer: 'L', from: [0, 0], to: [Infinity, 0] }] }),
    ).toThrow(/non-finite/);
  });

  it('grows the extents to cover a circle, not just its centre', () => {
    const pairs = parse(
      writeDxf({ layers: [], entities: [{ kind: 'circle', layer: 'L', centre: [100, 100], radius: 40 }] }),
    );
    expect(headerVar(pairs, '$EXTMIN').map((p) => Number(p[1]))).toEqual([60, 60]);
    expect(headerVar(pairs, '$EXTMAX').map((p) => Number(p[1]))).toEqual([140, 140]);
  });
});
