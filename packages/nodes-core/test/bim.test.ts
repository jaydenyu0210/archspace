/**
 * BIM model: asset metadata, IFC text validity, GUID mapping, and geometry.
 *
 * The geometry cases exist because the whole of this suite passed for months
 * against a file in which every product had a null placement and a null
 * representation. It parsed as IFC4, the storey tree was correct, and it
 * rendered absolutely nothing. Counting entities does not detect that; only
 * asking what each product actually references does.
 *
 * Two of these assertions correspond to violations IfcOpenShell's schema
 * validator reported and this suite did not: GUIDs whose leading character was
 * drawn from all 64 base64 symbols rather than the four the encoding allows,
 * and IfcSpaces listed among an IfcRelContainedInSpatialStructure's related
 * elements rather than aggregated into their storey.
 */
import { describe, expect, it } from 'vitest';
import type { AssetRef } from '@archspace/node-sdk';
import type { BimModelSummary, FloorPlanResult } from '../src/index.js';
import { runPipeline, type PipelineRun } from './helpers.js';

// 22 base64 characters carry 132 bits and a UUID has 128, so the leading
// character holds only the top 2 bits: it can be 0, 1, 2 or 3 and nothing else.
const GUID_RE = /^[0-3][0-9A-Za-z_$]{21}$/;

/** One `#n=KEYWORD(args);` record. */
interface Step {
  ref: string;
  keyword: string;
  args: string;
}

/**
 * The DATA section as records, keyed by reference.
 *
 * Parsed rather than substring-matched for the same reason the DXF suite parses
 * its output: the interesting failures are structural — an attribute in the
 * wrong slot, a reference to an entity that is not what it should be — and a
 * substring test cannot see either.
 */
function parseStep(text: string): Map<string, Step> {
  const out = new Map<string, Step>();
  for (const line of text.split('\n')) {
    const m = /^#(\d+)=([A-Z0-9]+)\((.*)\);$/.exec(line.trim());
    if (m) out.set(m[1] as string, { ref: m[1] as string, keyword: m[2] as string, args: m[3] as string });
  }
  return out;
}

/** Split a STEP argument list on top-level commas, respecting () and ''. */
function splitArgs(args: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let quoted = false;
  let current = '';
  for (let i = 0; i < args.length; i++) {
    const ch = args[i] as string;
    if (quoted) {
      current += ch;
      if (ch === "'") quoted = args[i + 1] === "'";
      continue;
    }
    if (ch === "'") { quoted = true; current += ch; continue; }
    if (ch === '(') depth++;
    if (ch === ')') depth--;
    if (ch === ',' && depth === 0) { out.push(current); current = ''; continue; }
    current += ch;
  }
  out.push(current);
  return out;
}

const recordsOf = (steps: Map<string, Step>, keyword: string): Step[] =>
  [...steps.values()].filter((s) => s.keyword === keyword);

async function ifcText(run: PipelineRun): Promise<string> {
  const ref = run.bim.outputs.model as AssetRef;
  return new TextDecoder().decode(await run.assets.bytes(ref));
}

describe('aec.generate_bim_model', () => {
  it('stores an asset<ifc> ref with model/ifc media type', async () => {
    const run = await runPipeline();
    const ref = run.bim.outputs.model as AssetRef;
    expect(ref.kind).toBe('asset');
    expect(ref.mediaType).toBe('model/ifc');
    expect(ref.format).toBe('ifc');
    expect(ref.name).toMatch(/^plan_[0-9a-f]{8}\.ifc$/);
  });

  it('writes syntactically plausible SPF with the right entity counts', async () => {
    const run = await runPipeline();
    const text = await ifcText(run);
    const plan = run.plan.outputs.floor_plan as unknown as FloorPlanResult;

    expect(text.startsWith('ISO-10303-21;')).toBe(true);
    expect(text).toContain("FILE_SCHEMA(('IFC4'))");
    expect(text).toContain('END-ISO-10303-21;');

    const storeys = text.match(/=IFCBUILDINGSTOREY\(/g)?.length ?? 0;
    expect(storeys).toBe(plan.levels.length);

    const totalRooms = plan.levels.reduce((s, l) => s + l.rooms.length, 0);
    const spaces = text.match(/=IFCSPACE\(/g)?.length ?? 0;
    expect(spaces).toBe(totalRooms);
  });

  it('uses unique #n= entity ids', async () => {
    const run = await runPipeline();
    const text = await ifcText(run);
    const ids = [...text.matchAll(/^#(\d+)=/gm)].map((m) => m[1]);
    expect(ids.length).toBeGreaterThan(0);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('declares units and a representation context, without which nothing draws', async () => {
    const steps = parseStep(await ifcText(await runPipeline()));

    const units = recordsOf(steps, 'IFCSIUNIT').map((u) => u.args);
    expect(units).toContain('*,.LENGTHUNIT.,.MILLI.,.METRE.');

    // IfcProject's last two attributes are RepresentationContexts and
    // UnitsInContext. Geometry with no context is geometry a viewer has no
    // frame to interpret, so it draws nothing and reports no error.
    const project = recordsOf(steps, 'IFCPROJECT')[0];
    const args = splitArgs(project?.args ?? '');
    const contexts = args[7] as string;
    const unitAssignment = args[8] as string;
    expect(contexts).toMatch(/^\(#\d+\)$/);
    expect(steps.get(contexts.replace(/[()#]/g, ''))?.keyword).toBe('IFCGEOMETRICREPRESENTATIONCONTEXT');
    expect(steps.get(unitAssignment.replace('#', ''))?.keyword).toBe('IFCUNITASSIGNMENT');
  });

  it('places and shapes every physical element', async () => {
    const run = await runPipeline();
    const steps = parseStep(await ifcText(run));
    const plan = run.plan.outputs.floor_plan as unknown as FloorPlanResult;

    // Attribute slots 6 and 7 (0-indexed 5 and 6) are ObjectPlacement and
    // Representation on every rooted product.
    for (const keyword of ['IFCWALL', 'IFCSPACE', 'IFCDOOR']) {
      const records = recordsOf(steps, keyword);
      expect(records.length, keyword).toBeGreaterThan(0);
      for (const record of records) {
        const args = splitArgs(record.args);
        const placement = steps.get((args[5] as string).replace('#', ''));
        const shape = steps.get((args[6] as string).replace('#', ''));
        expect(placement?.keyword, `${keyword} ${record.ref} placement`).toBe('IFCLOCALPLACEMENT');
        expect(shape?.keyword, `${keyword} ${record.ref} shape`).toBe('IFCPRODUCTDEFINITIONSHAPE');
      }
    }

    // One swept solid per element, and the counts follow the plan.
    const solids = recordsOf(steps, 'IFCEXTRUDEDAREASOLID').length;
    const totals = plan.levels.reduce(
      (n, l) => n + l.rooms.length + l.walls.length + l.doors.length,
      0,
    );
    expect(solids).toBe(totals);
  });

  it('extrudes each wall as its own length and thickness', async () => {
    const run = await runPipeline();
    const steps = parseStep(await ifcText(run));
    const plan = run.plan.outputs.floor_plan as unknown as FloorPlanResult;
    const walls = new Map(plan.levels.flatMap((l) => l.walls).map((w) => [w.id, w]));

    for (const record of recordsOf(steps, 'IFCWALL')) {
      const args = splitArgs(record.args);
      const wall = walls.get((args[2] as string).replace(/'/g, ''));
      expect(wall).toBeDefined();

      const shape = steps.get((args[6] as string).replace('#', '')) as Step;
      const shapeRep = steps.get(splitArgs(shape.args)[2]?.replace(/[()#]/g, '') as string) as Step;
      const solid = steps.get(splitArgs(shapeRep.args)[3]?.replace(/[()#]/g, '') as string) as Step;
      const profile = steps.get(splitArgs(solid.args)[0]?.replace('#', '') as string) as Step;

      expect(profile.keyword).toBe('IFCRECTANGLEPROFILEDEF');
      const [, , , xdim, ydim] = splitArgs(profile.args);
      const length = Math.hypot(
        (wall?.end[0] ?? 0) - (wall?.start[0] ?? 0),
        (wall?.end[1] ?? 0) - (wall?.start[1] ?? 0),
      );
      expect(Number(xdim), `${wall?.id} length`).toBeCloseTo(length, 6);
      expect(Number(ydim), `${wall?.id} thickness`).toBe(wall?.thicknessMm);
    }
  });

  it('aggregates spaces into their storey instead of containing them', async () => {
    // IfcSpace is a spatial structure element, so it belongs in the
    // decomposition tree. Listing it under IfcRelContainedInSpatialStructure
    // breaks that relationship's WR31 and leaves the space failing
    // IfcSpatialStructureElement.WR41 — both invisible in a viewer.
    const steps = parseStep(await ifcText(await runPipeline()));
    const spaceRefs = new Set(recordsOf(steps, 'IFCSPACE').map((s) => `#${s.ref}`));
    expect(spaceRefs.size).toBeGreaterThan(0);

    for (const rel of recordsOf(steps, 'IFCRELCONTAINEDINSPATIALSTRUCTURE')) {
      const related = (splitArgs(rel.args)[4] as string).replace(/[()]/g, '').split(',');
      for (const ref of related) expect(spaceRefs.has(ref), `${ref} contained, not aggregated`).toBe(false);
    }

    const aggregated = new Set(
      recordsOf(steps, 'IFCRELAGGREGATES').flatMap((rel) =>
        (splitArgs(rel.args)[5] as string).replace(/[()]/g, '').split(','),
      ),
    );
    for (const ref of spaceRefs) expect(aggregated.has(ref), `${ref} aggregated`).toBe(true);
  });

  it('puts each storey at its own elevation', async () => {
    const run = await runPipeline();
    const steps = parseStep(await ifcText(run));

    const elevations = recordsOf(steps, 'IFCBUILDINGSTOREY').map((storey) => {
      const args = splitArgs(storey.args);
      const placement = steps.get((args[5] as string).replace('#', '')) as Step;
      const axis = steps.get(splitArgs(placement.args)[1]?.replace('#', '') as string) as Step;
      const point = steps.get(splitArgs(axis.args)[0]?.replace('#', '') as string) as Step;
      const z = Number(point.args.replace(/[()]/g, '').split(',')[2]);
      // The placement must agree with the declared Elevation attribute; if they
      // disagree the tree says one thing and the geometry does another.
      return [Number(args[9]), z];
    });

    expect(elevations.length).toBeGreaterThan(1);
    for (const [declared, placed] of elevations) expect(placed).toBe(declared);
    expect(elevations.map(([d]) => d)).toEqual([0, 3500, 7000, 10500, 14000, 17500]);
  });

  it('maps every room id to a unique 22-char IFC guid in the summary', async () => {
    const run = await runPipeline();
    const plan = run.plan.outputs.floor_plan as unknown as FloorPlanResult;
    const summary = run.bim.outputs.summary as unknown as BimModelSummary;

    expect(summary.schema).toBe('IFC4');
    expect(summary.storeys).toBe(plan.levels.length);

    const guidByRoom = new Map(summary.spaces.map((s) => [s.roomId, s.guid]));
    for (const level of plan.levels) {
      for (const room of level.rooms) {
        const guid = guidByRoom.get(room.id);
        expect(guid, `guid for ${room.id}`).toBeDefined();
        expect(guid).toMatch(GUID_RE);
      }
    }
    for (const door of summary.doors) expect(door.guid).toMatch(GUID_RE);

    const allGuids = [...summary.spaces.map((s) => s.guid), ...summary.doors.map((d) => d.guid)];
    expect(new Set(allGuids).size).toBe(allGuids.length);
  });
});
