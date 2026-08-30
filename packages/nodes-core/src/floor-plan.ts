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
import type { NodeContext, NodeModule } from '@archspace/node-sdk';
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
import { describeProfile, MODEL_PROFILE_PARAM, requestedProfile } from './ai-common.js';
import {
  LAYOUT_PLAN_SCHEMA,
  layoutPrompt,
  validateLayoutPlan,
  type LayoutPlan,
  type Loading,
  type RunAxis,
} from './floor-plan-ai.js';

export interface GenerateFloorPlanParams {
  backend: 'mock' | 'ai';
  profile: string;
  seed: number;
  corridor_width_mm: number;
  door_width_mm: number;
  mock_latency_ms: number;
}

/** Fixed mock storey height used for plan elevations (BIM has its own param). */
const PLAN_STOREY_HEIGHT_MM = 3500;

/**
 * Ask the model for a circulation parti, and refuse one that cannot be built.
 *
 * The busiest level is what the fit check is run against, because that is the
 * level that has to fit: a layout sized for the average one draws the rest off
 * the edge of the site. Refusal is `ctx.retryable` — a bad sample's remedy is
 * another sample, and §7.5 gives that decision to the engine's policy rather
 * than to a loop here.
 */
async function proposeLayout(
  ctx: NodeContext,
  params: GenerateFloorPlanParams,
  brief: ProjectBrief,
  widthMm: number,
  depthMm: number,
  rowsByLevel: TableValue['rows'][],
): Promise<LayoutPlan> {
  let largestLevelAreaM2 = 0;
  let roomsOnLargestLevel = 0;
  for (const rows of rowsByLevel) {
    const area = rows.reduce((sum, row) => sum + (row.area_m2 as number), 0);
    if (area > largestLevelAreaM2) {
      largestLevelAreaM2 = area;
      roomsOnLargestLevel = rows.length;
    }
  }

  const profile = requestedProfile(params.profile);
  ctx.progress(0, `asking ${describeProfile(profile)} for a circulation parti`);

  const { object } = await ctx.ai.generateObject({
    schema: LAYOUT_PLAN_SCHEMA,
    system:
      'You are an architect choosing the circulation strategy for a concept plan. Answer with the parti only — the rooms are packed for you from the program.',
    prompt: layoutPrompt(brief, widthMm, depthMm, largestLevelAreaM2, roomsOnLargestLevel),
    signal: ctx.signal,
    ...(profile !== undefined ? { profile } : {}),
  });

  const verdict = validateLayoutPlan(object, {
    widthMm,
    depthMm,
    largestLevelAreaMm2: largestLevelAreaM2 * 1e6,
    minCorridorMm: 600,
    maxCorridorMm: 4000,
  });
  if (!verdict.ok) {
    throw ctx.retryable(
      new Error(`aec.generate_floor_plan: the model's layout was not buildable — ${verdict.why}`),
    );
  }
  return verdict.layout;
}

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
        backend: {
          type: 'string',
          title: 'Backend',
          enum: ['mock', 'ai'],
          default: 'mock',
          description:
            'mock: a double-loaded corridor down the long axis, as this node has always drawn. ai: the model bound to the profile below chooses the circulation parti — which way the spine runs, single or double loaded, corridor width and room depth — and the packer draws it.',
        },
        profile: MODEL_PROFILE_PARAM,
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

    const rowsByLevel: TableValue['rows'][] = [];
    for (let i = 0; i < brief.floors; i++) rowsByLevel.push([]);
    for (const row of program.rows) {
      const level = row.level as number;
      if (Number.isInteger(level) && level >= 0 && level < brief.floors) {
        rowsByLevel[level].push(row);
      }
    }

    // The four decisions that determine what the building LOOKS like. On the
    // mock backend they are the constants this node has always used; on the ai
    // backend a model picks them and `validateLayoutPlan` refuses one that
    // cannot be built. Everything downstream is the same packing either way.
    const layout =
      params.backend === 'ai'
        ? await proposeLayout(ctx, params, brief, widthMm, depthMm, rowsByLevel)
        : {
            // Historically: the long site axis, a double-loaded corridor of the
            // configured width, and rooms filling whatever depth is left.
            runAxis: (widthMm >= depthMm ? 'width' : 'depth') as RunAxis,
            loading: 'double' as Loading,
            corridorWidthMm: params.corridor_width_mm,
            roomDepthMm: Math.floor((Math.min(widthMm, depthMm) - params.corridor_width_mm) / 2),
            rationale: '',
          };

    if (params.backend === 'ai' && layout.rationale !== '') ctx.log('info', layout.rationale);

    const runMm = layout.runAxis === 'width' ? widthMm : depthMm;
    const acrossMm = layout.runAxis === 'width' ? depthMm : widthMm;
    const lanes = layout.loading === 'double' ? 2 : 1;
    const corridorMm = layout.corridorWidthMm;
    const sideDepthMm = layout.roomDepthMm;
    // The corridor sits between the lanes when there are two, and against the
    // far side when there is one, so a single-loaded row still fronts a facade.
    const corridorY0 = sideDepthMm;
    const corridorY1 = sideDepthMm + corridorMm;

    /**
     * Layout space (u along the corridor, v across it) → site coordinates.
     *
     * A transpose rather than a rotation: running the spine along the site's
     * depth means the plan's u axis IS the site's y. Written as one function so
     * every polygon, wall, door and exit below is generated once, in the frame
     * the packing logic is natural in, and lands on the site correctly whichever
     * way the building runs.
     */
    const place = (u: number, v: number): [number, number] =>
      layout.runAxis === 'width' ? [u, v] : [v, u];

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

      // Boundary in LAYOUT space, before `place` maps it onto the site: an
      // edge is exterior when it lies on the run's ends or the across extremes.
      const onBoundary = (a: [number, number], b: [number, number]): boolean =>
        (a[0] === 0 && b[0] === 0) ||
        (a[0] === runMm && b[0] === runMm) ||
        (a[1] === 0 && b[1] === 0) ||
        (a[1] === acrossMm && b[1] === acrossMm);

      const addWalls = (u0: number, v0: number, u1: number, v1: number): void => {
        const corners: [number, number][] = [
          [u0, v0],
          [u1, v0],
          [u1, v1],
          [u0, v1],
        ];
        for (let e = 0; e < 4; e++) {
          const start = corners[e];
          const end = corners[(e + 1) % 4];
          const kind = onBoundary(start, end) ? 'exterior' : 'interior';
          walls.push({
            id: `w_${level}_${wallN++}`,
            start: place(start[0], start[1]),
            end: place(end[0], end[1]),
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
          place(0, corridorY0),
          place(runMm, corridorY0),
          place(runMm, corridorY1),
          place(0, corridorY1),
        ],
        areaM2: round2((runMm * corridorMm) / 1e6),
      });
      addWalls(0, corridorY0, runMm, corridorY1);

      // Pack this level's rooms along both sides of the corridor, in order.
      const cursors: [number, number] = [0, 0];
      rowsByLevel[level].forEach((row, i) => {
        // With a single-loaded corridor every room is on one side.
        const side = lanes === 2 ? i % 2 : 0;
        const areaM2 = row.area_m2 as number;
        const jitter = 0.98 + rng() * 0.04; // small seeded jitter only
        const roomWidthMm = Math.max(1, Math.round(((areaM2 * 1e6) / sideDepthMm) * jitter));
        const x0 = cursors[side];
        const x1 = x0 + roomWidthMm;
        cursors[side] = x1;
        const y0 = side === 0 ? 0 : corridorY1;
        const y1 = side === 0 ? corridorY0 : corridorY1 + sideDepthMm;

        const id = `r_${level}_${roomN++}`;
        rooms.push({
          id,
          spaceId: cellText(row.space_id),
          name: cellText(row.name),
          function: cellText(row.function),
          polygon: [
            place(x0, y0),
            place(x1, y0),
            place(x1, y1),
            place(x0, y1),
          ],
          areaM2: round2(((x1 - x0) * (y1 - y0)) / 1e6),
        });
        addWalls(x0, y0, x1, y1);

        // Every room gets a door onto the corridor.
        doors.push({
          id: `d_${level}_${doorN++}`,
          roomId: id,
          position: place(Math.round((x0 + x1) / 2), side === 0 ? corridorY0 : corridorY1),
          widthMm: params.door_width_mm,
        });
      });

      // Two stair exits at opposite corridor ends when floors > 1, else one door.
      const midY = Math.round(acrossMm / 2);
      const exits: PlanExit[] =
        brief.floors > 1
          ? [
              { id: `x_${level}_0`, kind: 'stair', position: place(500, midY) },
              { id: `x_${level}_1`, kind: 'stair', position: place(runMm - 500, midY) },
            ]
          : [{ id: `x_${level}_0`, kind: 'door', position: place(500, midY) }];

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
