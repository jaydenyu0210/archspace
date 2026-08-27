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
import { writeDxf, type DxfDrawing } from '../src/dxf.js';

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
  const lines = text.split('\n');
  // The file ends with a newline, so the final split element is an empty tail.
  if (lines.at(-1) === '') lines.pop();
  expect(lines.length % 2, 'DXF must be an even number of lines (code/value pairs)').toBe(0);

  const pairs: Pair[] = [];
  for (let i = 0; i < lines.length; i += 2) {
    const raw = lines[i] as string;
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

// ------------------------------------------------------------- fixtures ----

interface Exported {
  text: string;
  pairs: Pair[];
  plan: FloorPlanResult;
  outputs: Record<string, unknown>;
  ref: AssetRef;
}

/** brief → program → plan → dxf, returning both the plan and the parsed file. */
async function exportPlan(params: Record<string, unknown> = {}): Promise<Exported> {
  const assets = createMemoryAssetStore();
  const brief = await runNode(projectBriefNode, { assets });
  const program = await runNode(spaceProgramNode, {
    inputs: { brief: brief.outputs.brief },
    assets,
  });
  const planRun = await runNode(generateFloorPlanNode, {
    params: { mock_latency_ms: 0 },
    inputs: { brief: brief.outputs.brief, program: program.outputs.program },
    assets,
  });
  const dxf = await runNode(exportDxfNode, {
    params,
    inputs: { floor_plan: planRun.outputs.floor_plan },
    assets,
  });

  const ref = dxf.outputs.dxf as AssetRef;
  const text = new TextDecoder().decode(await assets.bytes(ref));
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
    expect(sections).toEqual(['HEADER', 'TABLES', 'ENTITIES']);

    expect(pairs.at(-1)).toEqual([0, 'EOF']);
    expect(headerVar(pairs, '$ACADVER')).toEqual([[1, 'AC1009']]);
    // Millimetres. A plan drawn in mm and read as inches is off by 25.4×.
    expect(headerVar(pairs, '$INSUNITS')).toEqual([[70, '4']]);
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
      expect(code(t, 72)).toBe('1');
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
    // ASCII, deliberately: see roomLabel in export-dxf.ts.
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

  it('never emits a byte above ASCII, whatever it is handed', () => {
    const out = writeDxf({
      layers: [{ name: 'Café', color: 7 }],
      entities: [{ kind: 'text', layer: 'Café', at: [0, 0], height: 10, text: '会議室 — 12 m² … ✓' }],
    });
    // The whole point, stated as bytes rather than characters: a reader
    // decoding R12 in its own single-byte codepage sees exactly what we meant,
    // because every codepage agrees on the bytes below 0x7f.
    const bytes = [...new TextEncoder().encode(out)];
    expect(bytes.filter((b) => b > 0x7e)).toEqual([]);
    expect(bytes.filter((b) => b < 0x20 && b !== 0x0a)).toEqual([]);
  });

  it('escapes non-ASCII the way AutoCAD does when saving to R12', () => {
    expect(labelFor('12 m²')).toBe('12 m\\U+00B2');
    expect(labelFor('Café — B')).toBe('Caf\\U+00E9 \\U+2014 B');
    // Astral characters become their surrogate pair, as AutoCAD writes them.
    expect(labelFor('\u{1F600}')).toBe('\\U+D83D\\U+DE00');
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

  it('sanitises a layer name identically wherever it appears', () => {
    // A layer defined under one spelling and referenced under another is a
    // dangling reference, which is worse than either spelling alone.
    const pairs = parse(
      writeDxf({
        layers: [{ name: 'Zone\nÉ', color: 7 }],
        entities: [{ kind: 'circle', layer: 'Zone\nÉ', centre: [0, 0], radius: 1 }],
      }),
    );
    const defined = entities(section(pairs, 'TABLES'))
      .filter((e) => e.type === 'LAYER')
      .map((e) => code(e, 2));
    const used = entities(section(pairs, 'ENTITIES')).map((e) => code(e, 8));
    expect(defined).toEqual(['Zone \\U+00C9']);
    expect(used).toEqual(defined);
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
