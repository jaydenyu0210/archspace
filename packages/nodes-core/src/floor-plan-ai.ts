/**
 * The AI backend for `aec.generate_floor_plan` — the model picks the PARTI,
 * the packer draws it (ARCHITECTURE §10 / ADR-0010).
 *
 * **Why the model is not asked for the plan.** A `FloorPlanResult` is roughly
 * 95 KB and some five thousand numbers — every room polygon, every wall
 * endpoint, every door position — governed by invariants nothing in this repo
 * validates: walls lying on room edges, doors on a boundary, rooms not
 * overlapping, ids agreeing across three arrays. A model asked for that
 * returns something that parses, renders, and is quietly wrong in ways only an
 * IFC viewer three nodes later reveals. So it is asked for the handful of
 * decisions that actually determine what a plan LOOKS like, and the existing
 * deterministic packer turns those into geometry that is correct by
 * construction.
 *
 * **Why this changes anything.** Before this, every plan the app produced was
 * the same building: a corridor down the long axis, 1,800 mm wide, with rooms
 * of one single depth combed off both sides. Measured across an office, a
 * school and a residential block, the only things a brief could change were
 * the room count and that one depth — three briefs, three combs. The four
 * fields below are the ones that break that: which way the corridor runs,
 * whether it is loaded on one side or two, how wide it is, and how deep the
 * rooms are. They are small enough for a model to get right and large enough
 * that the drawing is visibly a different building.
 *
 * **The gate.** A layout is refused when it cannot be built: a corridor
 * outside the width the node's own params allow, rooms shallower than a room
 * can be, bands that do not fit across the site, or a level whose program
 * cannot fit along the run. That last one is the important one — the packer
 * has no bound of its own and will happily walk rooms off the end of the site
 * (measured: a level-skewed program runs 31.7 m past the boundary with no
 * warning), so the AI path checks the fit the deterministic path never has.
 */
import type { JsonSchemaObject } from '@archspace/node-sdk';
import type { ProjectBrief } from './shapes.js';

/** Which site axis the corridor runs along. */
export type RunAxis = 'width' | 'depth';

/** Rooms on both sides of the corridor, or only one. */
export type Loading = 'double' | 'single';

/** Everything the model is allowed to decide about a level's layout. */
export interface LayoutPlan {
  runAxis: RunAxis;
  loading: Loading;
  corridorWidthMm: number;
  roomDepthMm: number;
  rationale: string;
}

export const LAYOUT_PLAN_SCHEMA: JsonSchemaObject = {
  type: 'object',
  properties: {
    runAxis: {
      type: 'string',
      enum: ['width', 'depth'],
      description:
        'The site axis the circulation spine runs along. "width" runs it left-to-right; "depth" runs it front-to-back, which turns the building through ninety degrees.',
    },
    loading: {
      type: 'string',
      enum: ['double', 'single'],
      description:
        'double: rooms on both sides of the corridor — efficient, but inner rooms are deep. single: rooms on one side only, so every room reaches a facade, at the cost of twice the corridor per room.',
    },
    corridorWidthMm: {
      type: 'integer',
      description: 'Clear corridor width in millimetres. Egress usually wants 1500-2400.',
    },
    roomDepthMm: {
      type: 'integer',
      description:
        'How deep each room is, measured from the corridor to the facade, in millimetres. Daylight reaches roughly 6000-7000 mm from a window, so anything past about 12000 leaves a dark core.',
    },
    rationale: {
      type: 'string',
      description: 'One sentence on why this parti suits the brief.',
    },
  },
  required: ['runAxis', 'loading', 'corridorWidthMm', 'roomDepthMm', 'rationale'],
};

export function layoutPrompt(
  brief: ProjectBrief,
  widthMm: number,
  depthMm: number,
  largestLevelAreaM2: number,
  roomsOnLargestLevel: number,
): string {
  return [
    `Choose the circulation parti for ${brief.projectName}, a ${brief.buildingType.replace('_', ' ')} building.`,
    '',
    `Site: ${(widthMm / 1000).toFixed(1)} m wide by ${(depthMm / 1000).toFixed(1)} m deep.`,
    `Storeys: ${brief.floors}. The busiest level holds ${roomsOnLargestLevel} rooms totalling ${largestLevelAreaM2.toFixed(0)} m².`,
    `Occupancy ${brief.occupancyClass} under ${brief.code.version}.`,
    brief.notes.trim() === '' ? '' : `Brief notes: ${brief.notes.trim()}`,
    '',
    'The rooms are packed as a row along the corridor, each one as deep as you specify and as wide as its area requires. So your four choices decide the shape of the building:',
    '- Running the spine along the shorter axis makes a deeper, more compact block.',
    '- Single loading gives every room a facade; double loading fits far more area on a level.',
    '- Room depth trades daylight against how far the rooms stretch along the corridor.',
    '',
    'The rooms must fit: (corridor + rooms across the site) has to be no wider than the across-axis, and the total room width has to fit along the run.',
  ]
    .filter((line) => line !== '')
    .join('\n');
}

export interface LayoutSite {
  widthMm: number;
  depthMm: number;
  /** Area of the busiest level, which is the one that has to fit. */
  largestLevelAreaMm2: number;
  /** The node's own param bounds, so the model cannot escape them. */
  minCorridorMm: number;
  maxCorridorMm: number;
}

export type LayoutVerdict = { ok: true; layout: LayoutPlan } | { ok: false; why: string };

/** A room shallower than this is a cupboard, not a room. */
const MIN_ROOM_DEPTH_MM = 2000;

/**
 * Everything that must hold before a layout becomes geometry.
 *
 * The fit check is the one with teeth. `floor-plan.ts` packs rooms along a
 * cursor it never bounds, so a layout whose rooms need more run than the site
 * has does not fail — it draws a building hanging off the edge of its own
 * site, and the IFC, the DXF and the review all accept it. Refusing here is
 * the only thing standing between a sampled layout and that outcome.
 */
export function validateLayoutPlan(raw: unknown, site: LayoutSite): LayoutVerdict {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { ok: false, why: 'the model did not return an object' };
  }
  const rec = raw as Record<string, unknown>;

  const runAxis = rec['runAxis'];
  if (runAxis !== 'width' && runAxis !== 'depth') {
    return { ok: false, why: `runAxis ${JSON.stringify(runAxis)} is not "width" or "depth"` };
  }
  const loading = rec['loading'];
  if (loading !== 'double' && loading !== 'single') {
    return { ok: false, why: `loading ${JSON.stringify(loading)} is not "double" or "single"` };
  }

  const corridorWidthMm = rec['corridorWidthMm'];
  if (typeof corridorWidthMm !== 'number' || !Number.isFinite(corridorWidthMm)) {
    return { ok: false, why: 'corridorWidthMm is not a number' };
  }
  if (corridorWidthMm < site.minCorridorMm || corridorWidthMm > site.maxCorridorMm) {
    return {
      ok: false,
      why: `a ${corridorWidthMm} mm corridor is outside the ${site.minCorridorMm}–${site.maxCorridorMm} mm this node allows`,
    };
  }

  const roomDepthMm = rec['roomDepthMm'];
  if (typeof roomDepthMm !== 'number' || !Number.isFinite(roomDepthMm)) {
    return { ok: false, why: 'roomDepthMm is not a number' };
  }
  if (roomDepthMm < MIN_ROOM_DEPTH_MM) {
    return { ok: false, why: `a ${roomDepthMm} mm deep room is not a room` };
  }

  const runMm = runAxis === 'width' ? site.widthMm : site.depthMm;
  const acrossMm = runAxis === 'width' ? site.depthMm : site.widthMm;
  const lanes = loading === 'double' ? 2 : 1;

  const neededAcross = corridorWidthMm + lanes * roomDepthMm;
  if (neededAcross > acrossMm) {
    return {
      ok: false,
      why:
        `${lanes === 2 ? 'two rows' : 'one row'} of ${roomDepthMm} mm rooms plus a ${corridorWidthMm} mm corridor ` +
        `needs ${neededAcross} mm across a site that is ${acrossMm} mm deep on that axis`,
    };
  }

  // The busiest level has to fit along the run, split between the lanes.
  const neededRun = site.largestLevelAreaMm2 / roomDepthMm / lanes;
  if (neededRun > runMm) {
    return {
      ok: false,
      why:
        `the busiest level needs ${Math.round(neededRun / 1000)} m of corridor at ${roomDepthMm} mm deep ` +
        `${lanes === 2 ? 'on each side' : 'on one side'}, but the run is only ${Math.round(runMm / 1000)} m — ` +
        'deepen the rooms, use double loading, or run the spine the other way',
    };
  }

  return {
    ok: true,
    layout: {
      runAxis,
      loading,
      corridorWidthMm: Math.round(corridorWidthMm),
      roomDepthMm: Math.round(roomDepthMm),
      rationale: typeof rec['rationale'] === 'string' ? rec['rationale'] : '',
    },
  };
}
