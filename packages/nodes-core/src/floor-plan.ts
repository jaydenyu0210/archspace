/**
 * aec.generate_floor_plan — MOCK of a generative layout service.
 * The FloorPlanResult shape (shapes.ts) is the contract a real backend must
 * return; swapping in a real service is a change inside execute() only.
 *
 * Mock layout: per level, a central corridor runs the site's long axis; the
 * level's program rooms are packed along both sides as rectangles sized to
 * their area. The seeded PRNG is used only for the plan id and small width
 * jitter — same seed + inputs ⇒ byte-identical plans.
 */
import type { NodeModule } from '@archspace/node-sdk';
import type {
  FloorPlanLevel,
  FloorPlanResult,
  PlanDoor,
  PlanExit,
  PlanRoom,
  PlanWall,
  ProjectBrief,
  TableValue,
} from './shapes.js';
import { cellText, hex8, mulberry32, requireInput, round2, round3, sleep, toValue } from './util.js';

export interface GenerateFloorPlanParams {
  seed: number;
  corridor_width_mm: number;
  door_width_mm: number;
  mock_latency_ms: number;
}

/** Fixed mock storey height used for plan elevations (BIM has its own param). */
const PLAN_STOREY_HEIGHT_MM = 3500;

export const generateFloorPlanNode: NodeModule<GenerateFloorPlanParams> = {
  manifest: {
    type: 'aec.generate_floor_plan',
    version: 1,
    label: 'Generate Floor Plan',
    description:
      'Mock generative layout service: packs the space program into per-level corridor plans with rooms, walls, doors and exits.',
    category: 'Generate',
    keywords: ['floor plan', 'layout', 'generative', 'mock'],
    caching: 'never',
    lane: 'ai',
    params: {
      type: 'object',
      properties: {
        seed: { type: 'integer', title: 'Seed', default: 7, minimum: 0 },
        corridor_width_mm: {
          type: 'integer',
          title: 'Corridor width (mm)',
          default: 1800,
          minimum: 600,
          maximum: 4000,
        },
        door_width_mm: {
          type: 'integer',
          title: 'Door width (mm)',
          default: 900,
          minimum: 600,
          maximum: 1500,
        },
        mock_latency_ms: {
          type: 'integer',
          title: 'Mock latency (ms)',
          default: 1200,
          minimum: 0,
        },
      },
    },
    inputs: [
      { id: 'brief', type: 'json', label: 'Brief', required: true },
      { id: 'program', type: 'table', label: 'Program', required: true },
    ],
    outputs: [{ id: 'floor_plan', type: 'json', label: 'Floor plan', preview: 'plan' }],
  },

  async execute(ctx, inputs, params) {
    const brief = requireInput<ProjectBrief>(inputs, 'brief', 'aec.generate_floor_plan');
    const program = requireInput<TableValue>(inputs, 'program', 'aec.generate_floor_plan');

    // Deterministic, user-inducible capacity failure.
    const usableM2 = round2(brief.floors * brief.site.areaM2 * 0.85);
    if (brief.targetGrossAreaM2 > usableM2) {
      throw new Error(
        `Floor plan capacity exceeded: target gross area ${brief.targetGrossAreaM2} m² does not fit ` +
          `${brief.floors} floor(s) on a ${brief.site.areaM2} m² site (usable ${usableM2} m² at 85% coverage). ` +
          `Reduce target_gross_area_m2 or increase floors.`,
      );
    }

    const rng = mulberry32(params.seed);
    const planId = `plan_${hex8(rng)}`;

    const widthMm = Math.round(brief.site.widthM * 1000);
    const depthMm = Math.round(brief.site.depthM * 1000);
    const longMm = Math.max(widthMm, depthMm); // corridor runs the long axis (x)
    const shortMm = Math.min(widthMm, depthMm); // rooms flank it in y
    const corridorMm = params.corridor_width_mm;
    const sideDepthMm = Math.floor((shortMm - corridorMm) / 2);
    const corridorY0 = sideDepthMm;
    const corridorY1 = sideDepthMm + corridorMm;

    const rowsByLevel: TableValue['rows'][] = [];
    for (let i = 0; i < brief.floors; i++) rowsByLevel.push([]);
    for (const row of program.rows) {
      const level = row.level as number;
      if (Number.isInteger(level) && level >= 0 && level < brief.floors) {
        rowsByLevel[level].push(row);
      }
    }

    const levels: FloorPlanLevel[] = [];
    const chunkMs = params.mock_latency_ms / Math.max(1, brief.floors);
    for (let level = 0; level < brief.floors; level++) {
      ctx.progress(level / brief.floors, `laying out level ${level + 1}/${brief.floors}`);

      const rooms: PlanRoom[] = [];
      const walls: PlanWall[] = [];
      const doors: PlanDoor[] = [];
      let roomN = 0;
      let wallN = 0;
      let doorN = 0;

      const onBoundary = (a: [number, number], b: [number, number]): boolean =>
        (a[0] === 0 && b[0] === 0) ||
        (a[0] === longMm && b[0] === longMm) ||
        (a[1] === 0 && b[1] === 0) ||
        (a[1] === shortMm && b[1] === shortMm);

      const addWalls = (x0: number, y0: number, x1: number, y1: number): void => {
        const corners: [number, number][] = [
          [x0, y0],
          [x1, y0],
          [x1, y1],
          [x0, y1],
        ];
        for (let e = 0; e < 4; e++) {
          const start = corners[e];
          const end = corners[(e + 1) % 4];
          const kind = onBoundary(start, end) ? 'exterior' : 'interior';
          walls.push({
            id: `w_${level}_${wallN++}`,
            start,
            end,
            thicknessMm: kind === 'exterior' ? 200 : 100,
            kind,
          });
        }
      };

      // One 'circulation' corridor room per level.
      rooms.push({
        id: `r_${level}_${roomN++}`,
        spaceId: null,
        name: 'Corridor',
        function: 'circulation',
        polygon: [
          [0, corridorY0],
          [longMm, corridorY0],
          [longMm, corridorY1],
          [0, corridorY1],
        ],
        areaM2: round2((longMm * corridorMm) / 1e6),
      });
      addWalls(0, corridorY0, longMm, corridorY1);

      // Pack this level's rooms along both sides of the corridor, in order.
      const cursors: [number, number] = [0, 0];
      rowsByLevel[level].forEach((row, i) => {
        const side = i % 2;
        const areaM2 = row.area_m2 as number;
        const jitter = 0.98 + rng() * 0.04; // small seeded jitter only
        const roomWidthMm = Math.max(1, Math.round(((areaM2 * 1e6) / sideDepthMm) * jitter));
        const x0 = cursors[side];
        const x1 = x0 + roomWidthMm;
        cursors[side] = x1;
        const y0 = side === 0 ? 0 : corridorY1;
        const y1 = side === 0 ? corridorY0 : shortMm;

        const id = `r_${level}_${roomN++}`;
        rooms.push({
          id,
          spaceId: cellText(row.space_id),
          name: cellText(row.name),
          function: cellText(row.function),
          polygon: [
            [x0, y0],
            [x1, y0],
            [x1, y1],
            [x0, y1],
          ],
          areaM2: round2(((x1 - x0) * (y1 - y0)) / 1e6),
        });
        addWalls(x0, y0, x1, y1);

        // Every room gets a door onto the corridor.
        doors.push({
          id: `d_${level}_${doorN++}`,
          roomId: id,
          position: [Math.round((x0 + x1) / 2), side === 0 ? corridorY0 : corridorY1],
          widthMm: params.door_width_mm,
        });
      });

      // Two stair exits at opposite corridor ends when floors > 1, else one door.
      const midY = Math.round(shortMm / 2);
      const exits: PlanExit[] =
        brief.floors > 1
          ? [
              { id: `x_${level}_0`, kind: 'stair', position: [500, midY] },
              { id: `x_${level}_1`, kind: 'stair', position: [longMm - 500, midY] },
            ]
          : [{ id: `x_${level}_0`, kind: 'door', position: [500, midY] }];

      levels.push({
        level,
        elevationMm: level * PLAN_STOREY_HEIGHT_MM,
        rooms,
        walls,
        doors,
        exits,
      });

      await sleep(chunkMs, ctx.signal);
    }
    ctx.progress(1, 'floor plan complete');

    // Metrics from the actual generated areas.
    let netAreaM2 = 0;
    let grossAreaM2 = 0;
    for (const lvl of levels) {
      for (const room of lvl.rooms) {
        grossAreaM2 += room.areaM2;
        if (room.function !== 'circulation') netAreaM2 += room.areaM2;
      }
    }
    netAreaM2 = round2(netAreaM2);
    grossAreaM2 = round2(grossAreaM2);

    const result: FloorPlanResult = {
      planId,
      generator: { name: 'mock-floorplan', version: '1.0.0', seed: params.seed },
      units: 'mm',
      site: { widthMm, depthMm },
      levels,
      metrics: {
        grossAreaM2,
        netAreaM2,
        efficiency: round3(netAreaM2 / grossAreaM2),
      },
    };

    return { floor_plan: toValue(result) };
  },
};
