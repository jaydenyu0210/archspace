/**
 * The AI floor-plan backend: the model picks the parti, the packer draws it.
 *
 * The point of these cases is that the drawing actually CHANGES. Before this
 * backend existed, every brief produced the same building — measured across an
 * office, a school and a residential block, each level had exactly two room
 * depths (the 1,800 mm corridor and one number for everything else) and the
 * corridor always ran the long axis. So the assertions below are about
 * topology, not tolerance: a transposed spine puts geometry on the other axis,
 * single loading puts every room on one side, and both must still land inside
 * the site.
 *
 * The refusals matter as much. `floor-plan.ts` packs rooms along a cursor it
 * never bounds — a level-skewed program runs it 31.7 m past the site with no
 * warning — so a sampled layout that does not fit has to be caught here or it
 * becomes an IFC of a building hanging off its own site.
 */
import { describe, expect, it } from 'vitest';
import { runNode } from '@archspace/node-sdk/testkit';
import { isRetryableError, type Value } from '@archspace/node-sdk';
import { generateFloorPlanNode } from '../src/index.js';
import type { FloorPlanResult, ProjectBrief, TableValue } from '../src/index.js';
import { validateLayoutPlan } from '../src/floor-plan-ai.js';

const BRIEF: ProjectBrief = {
  projectName: 'Layout Test',
  buildingType: 'office',
  code: { jurisdiction: 'IBC', version: 'IBC 2024' },
  site: { widthM: 60, depthM: 40, areaM2: 2400 },
  floors: 1,
  targetGrossAreaM2: 900,
  occupancyClass: 'B',
  notes: '',
};

/** Six 100 m² rooms on one level — 600 m² to place. */
const PROGRAM: TableValue = {
  columns: [{ id: 'space_id' }, { id: 'name' }, { id: 'function' }, { id: 'level' }, { id: 'area_m2' }],
  rows: Array.from({ length: 6 }, (_, i) => ({
    space_id: `s${i}`,
    name: `Room ${i}`,
    function: 'office',
    level: 0,
    area_m2: 100,
  })),
};

async function runAi(object: unknown) {
  return runNode(generateFloorPlanNode, {
    params: { backend: 'ai', mock_latency_ms: 0 },
    inputs: { brief: BRIEF as unknown as Value, program: PROGRAM as unknown as Value },
    ai: { generateObject: () => Promise.resolve({ object: object as Value }) },
  });
}

const SITE = { widthMm: 60_000, depthMm: 40_000 };

/** Every vertex of every room, wall and door, as site coordinates. */
function allPoints(level: FloorPlanResult['levels'][number]): [number, number][] {
  const points: [number, number][] = [];
  for (const room of level.rooms) points.push(...room.polygon);
  for (const wall of level.walls) points.push(wall.start, wall.end);
  for (const door of level.doors) points.push(door.position);
  return points;
}

describe('aec.generate_floor_plan on the ai backend', () => {
  it('turns the building through ninety degrees when the spine runs along depth', async () => {
    const across = await runAi({
      runAxis: 'width',
      loading: 'double',
      corridorWidthMm: 1800,
      roomDepthMm: 8000,
      rationale: '',
    });
    const along = await runAi({
      runAxis: 'depth',
      loading: 'double',
      corridorWidthMm: 1800,
      roomDepthMm: 8000,
      rationale: '',
    });

    const corridorOf = (run: typeof across): FloorPlanResult['levels'][number]['rooms'][number] => {
      const plan = run.outputs.floor_plan as unknown as FloorPlanResult;
      return plan.levels[0].rooms.find((r) => r.function === 'circulation')!;
    };

    // The corridor spans the full run: 60 m one way, 40 m the other. This is
    // the assertion that a brief can now change the SHAPE and not just the
    // numbers — the two schemes are different buildings, not the same comb.
    const widthRun = corridorOf(across).polygon.map(([x]) => x);
    const depthRun = corridorOf(along).polygon.map(([, y]) => y);
    expect(Math.max(...widthRun)).toBe(60_000);
    expect(Math.max(...depthRun)).toBe(40_000);
    // And the corridor is 1,800 mm the other way in each case.
    const widthBand = corridorOf(across).polygon.map(([, y]) => y);
    expect(Math.max(...widthBand) - Math.min(...widthBand)).toBe(1800);
  });

  it('keeps every point on the site, whichever way the spine runs', async () => {
    for (const runAxis of ['width', 'depth'] as const) {
      const run = await runAi({ runAxis, loading: 'double', corridorWidthMm: 1800, roomDepthMm: 8000, rationale: '' });
      const plan = run.outputs.floor_plan as unknown as FloorPlanResult;

      for (const [x, y] of allPoints(plan.levels[0])) {
        expect(x).toBeGreaterThanOrEqual(0);
        expect(y).toBeGreaterThanOrEqual(0);
        expect(x).toBeLessThanOrEqual(SITE.widthMm);
        expect(y).toBeLessThanOrEqual(SITE.depthMm);
      }
    }
  });

  it('puts every room on one side when the corridor is single-loaded', async () => {
    const run = await runAi({
      runAxis: 'width',
      loading: 'single',
      corridorWidthMm: 2000,
      roomDepthMm: 12_000,
      rationale: '',
    });
    const plan = run.outputs.floor_plan as unknown as FloorPlanResult;
    const rooms = plan.levels[0].rooms.filter((r) => r.function !== 'circulation');

    // Every room sits below the corridor, which starts at y = roomDepth.
    for (const room of rooms) {
      for (const [, y] of room.polygon) expect(y).toBeLessThanOrEqual(12_000);
    }
    expect(rooms).toHaveLength(6);
  });

  it('honours the corridor width and room depth it was given', async () => {
    const run = await runAi({
      runAxis: 'width',
      loading: 'double',
      corridorWidthMm: 2400,
      roomDepthMm: 9000,
      rationale: 'Wide spine for an assembly occupancy.',
    });
    const plan = run.outputs.floor_plan as unknown as FloorPlanResult;
    const corridor = plan.levels[0].rooms.find((r) => r.function === 'circulation')!;
    const ys = corridor.polygon.map(([, y]) => y);

    expect(Math.min(...ys)).toBe(9000);
    expect(Math.max(...ys) - Math.min(...ys)).toBe(2400);
    expect(run.logs.map((l) => l.message)).toContain('Wide spine for an assembly occupancy.');
  });
});

describe('the gate refuses a layout that cannot be built', () => {
  const cases: { name: string; object: unknown; why: RegExp }[] = [
    {
      name: 'a corridor wider than the node allows',
      object: { runAxis: 'width', loading: 'double', corridorWidthMm: 9000, roomDepthMm: 8000, rationale: '' },
      why: /outside the 600–4000 mm/,
    },
    {
      name: 'rooms too shallow to be rooms',
      object: { runAxis: 'width', loading: 'double', corridorWidthMm: 1800, roomDepthMm: 900, rationale: '' },
      why: /is not a room/,
    },
    {
      name: 'bands that do not fit across the site',
      object: { runAxis: 'width', loading: 'double', corridorWidthMm: 1800, roomDepthMm: 25_000, rationale: '' },
      why: /needs \d+ mm across a site/,
    },
    {
      name: 'a program that will not fit along the run',
      // 600 m² single-loaded at 2 m deep needs 300 m of corridor; the run is 60.
      object: { runAxis: 'width', loading: 'single', corridorWidthMm: 1800, roomDepthMm: 2000, rationale: '' },
      why: /the run is only 60 m/,
    },
    {
      name: 'an axis outside the vocabulary',
      object: { runAxis: 'diagonal', loading: 'double', corridorWidthMm: 1800, roomDepthMm: 8000, rationale: '' },
      why: /is not "width" or "depth"/,
    },
    {
      name: 'something that is not an object',
      object: 'a nice open plan',
      why: /did not return an object/,
    },
  ];

  for (const { name, object, why } of cases) {
    it(`rejects ${name}, retryably`, async () => {
      const error = await runAi(object).catch((err: unknown) => err);

      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toMatch(why);
      expect(isRetryableError(error)).toBe(true);
    });
  }
});

describe('validateLayoutPlan', () => {
  const site = { widthMm: 60_000, depthMm: 40_000, largestLevelAreaMm2: 600e6, minCorridorMm: 600, maxCorridorMm: 4000 };

  it('accepts a deep double-loaded block that fits on both axes', () => {
    const verdict = validateLayoutPlan(
      { runAxis: 'width', loading: 'double', corridorWidthMm: 1800, roomDepthMm: 15_000, rationale: '' },
      site,
    );
    expect(verdict.ok).toBe(true);
  });

  it('lets a layout that is too long on one axis fit on the other', () => {
    // 600 m² single-loaded at 10 m deep needs 60 m of run. Along the width
    // (60 m) that just fits; along the depth (40 m) it does not — which is the
    // trade the prompt asks the model to make, so the gate has to see it.
    const wide = { runAxis: 'width' as const, loading: 'single' as const, corridorWidthMm: 1800, roomDepthMm: 10_000, rationale: '' };
    expect(validateLayoutPlan(wide, site).ok).toBe(true);
    expect(validateLayoutPlan({ ...wide, runAxis: 'depth' }, site).ok).toBe(false);
  });

  it('rounds the numbers it accepts, so the packer never sees a fraction', () => {
    const verdict = validateLayoutPlan(
      { runAxis: 'width', loading: 'double', corridorWidthMm: 1800.6, roomDepthMm: 8000.4, rationale: '' },
      site,
    );
    expect(verdict.ok).toBe(true);
    if (verdict.ok) {
      expect(verdict.layout.corridorWidthMm).toBe(1801);
      expect(verdict.layout.roomDepthMm).toBe(8000);
    }
  });
});
