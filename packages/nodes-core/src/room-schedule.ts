/**
 * aec.generate_room_schedule — the room schedule a floor plan implies.
 *
 * Pure and instant (no mock latency): every value is derived from the plan's
 * ACTUAL room geometry, so changing an upstream param genuinely changes the
 * schedule. Finishes come from a fixed lookup keyed by the room's `function`;
 * IFC GUIDs are picked up from the BIM summary when a model was authored.
 * The RoomScheduleRow / RoomScheduleSummary shapes (shapes.ts) are the
 * contract a real scheduling backend must return.
 */
import type { NodeModule, Value } from '@archspace/node-sdk';
import type {
  BimModelSummary,
  FloorPlanResult,
  RoomScheduleRow,
  RoomScheduleSummary,
  TableValue,
} from './shapes.js';
import { fnv1a, hex8, mulberry32, requireInput, round2, toValue } from './util.js';

export interface GenerateRoomScheduleParams {
  include_circulation: boolean;
  avg_area_per_person_m2: number;
  number_prefix: string;
}

interface Finishes {
  floor: string;
  ceiling: string;
}

/**
 * Finish schedule by room function. The keys cover every function the space
 * program templates emit for the four building types (office, residential,
 * school, mixed_use); anything else falls back to FALLBACK_FINISHES.
 */
const FINISHES: Record<string, Finishes> = {
  // Office
  open_workspace: { floor: 'Carpet tile', ceiling: 'Suspended acoustic' },
  enclosed_office: { floor: 'Carpet tile', ceiling: 'Suspended acoustic' },
  meeting: { floor: 'Carpet tile', ceiling: 'Suspended acoustic' },
  amenity: { floor: 'Vinyl plank', ceiling: 'Painted plasterboard' },
  support: { floor: 'Vinyl sheet', ceiling: 'Painted plasterboard' },
  service: { floor: 'Sealed concrete', ceiling: 'Exposed structure' },
  circulation: { floor: 'Polished concrete', ceiling: 'Suspended acoustic' },
  // Residential / mixed use
  unit: { floor: 'Engineered timber', ceiling: 'Painted plasterboard' },
  retail: { floor: 'Porcelain tile', ceiling: 'Exposed painted structure' },
  // School
  classroom: { floor: 'Linoleum sheet', ceiling: 'Suspended acoustic' },
  lab: { floor: 'Epoxy resin', ceiling: 'Washable suspended acoustic' },
  admin: { floor: 'Carpet tile', ceiling: 'Suspended acoustic' },
  assembly: { floor: 'Sprung hardwood', ceiling: 'Acoustic baffles' },
};

/** Shell finishes for a function the lookup does not know — never a blank cell. */
const FALLBACK_FINISHES: Finishes = { floor: 'Sealed concrete', ceiling: 'Painted plasterboard' };

/** Deterministic ascending compare on JS code units — never locale-dependent. */
function byString(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export const generateRoomScheduleNode: NodeModule<GenerateRoomScheduleParams> = {
  manifest: {
    type: 'aec.generate_room_schedule',
    version: 1,
    label: 'Generate Room Schedule',
    description:
      'The room schedule a plan implies — numbers, areas, occupant loads and finishes, with IFC GUIDs when a model was authored.',
    category: 'Report',
    keywords: ['schedule', 'rooms', 'areas', 'finishes', 'occupancy'],
    caching: 'pure',
    lane: 'cpu',
    params: {
      type: 'object',
      properties: {
        include_circulation: {
          type: 'boolean',
          title: 'Include circulation',
          description: 'Schedule the corridor rooms alongside the occupiable ones.',
          default: false,
        },
        avg_area_per_person_m2: {
          type: 'number',
          title: 'Average area per person (m²)',
          default: 9.3,
          minimum: 2,
          maximum: 100,
        },
        number_prefix: {
          type: 'string',
          title: 'Room number prefix',
          description: 'Prepended to the level-based number ("A" ⇒ "A-02-14"). Empty ⇒ level-based numbering only.',
          default: '',
          'x-archspace': { placeholder: 'A' },
        },
      },
    },
    inputs: [
      { id: 'floor_plan', type: 'json', label: 'Floor plan', required: true },
      { id: 'bim_summary', type: 'json', label: 'BIM summary', required: false },
    ],
    outputs: [
      { id: 'schedule', type: 'table', label: 'Schedule' },
      { id: 'summary', type: 'json', label: 'Summary' },
    ],
  },

  async execute(ctx, inputs, params) {
    const plan = requireInput<FloorPlanResult>(inputs, 'floor_plan', 'aec.generate_room_schedule');
    const bim = inputs.bim_summary as unknown as BimModelSummary | undefined;
    if (bim === undefined) {
      ctx.log('info', 'no BIM summary wired — schedule rows carry a null IFC GUID');
    }

    const guidByRoom = new Map((bim?.spaces ?? []).map((s) => [s.roomId, s.guid] as const));

    // Levels ascending, then the plan's own room order within each level.
    const levels = [...plan.levels].sort((a, b) => a.level - b.level);

    const rows: RoomScheduleRow[] = [];
    for (const level of levels) {
      // The sequence numbers the rows this schedule actually emits, so a
      // schedule is always contiguous (01-01, 01-02, …) rather than showing
      // gaps where excluded circulation rooms would have sat.
      let seqOnLevel = 0;
      for (const room of level.rooms) {
        if (!params.include_circulation && room.function === 'circulation') continue;
        seqOnLevel++;
        const finishes = FINISHES[room.function] ?? FALLBACK_FINISHES;
        const number = `${String(level.level + 1).padStart(2, '0')}-${String(seqOnLevel).padStart(2, '0')}`;
        rows.push({
          roomId: room.id,
          number: params.number_prefix === '' ? number : `${params.number_prefix}-${number}`,
          name: room.name,
          function: room.function,
          level: level.level,
          areaM2: room.areaM2,
          occupantLoad: Math.ceil(room.areaM2 / params.avg_area_per_person_m2),
          finishFloor: finishes.floor,
          finishCeiling: finishes.ceiling,
          guid: guidByRoom.get(room.id) ?? null,
        });
      }
    }

    // Aggregates. Both are built from the emitted rows and then explicitly
    // sorted (level ascending, function alphabetical) so output never depends
    // on Map insertion order.
    const levelTotals = new Map<number, { rooms: number; areaM2: number }>();
    const functionTotals = new Map<string, { rooms: number; areaM2: number }>();
    let totalAreaM2 = 0;
    for (const row of rows) {
      totalAreaM2 += row.areaM2;
      const lvl = levelTotals.get(row.level) ?? { rooms: 0, areaM2: 0 };
      lvl.rooms++;
      lvl.areaM2 += row.areaM2;
      levelTotals.set(row.level, lvl);
      const fn = functionTotals.get(row.function) ?? { rooms: 0, areaM2: 0 };
      fn.rooms++;
      fn.areaM2 += row.areaM2;
      functionTotals.set(row.function, fn);
    }

    const summary: RoomScheduleSummary = {
      // Content-addressed, not plan-addressed: two plans can share a planId
      // (it is derived from the generator seed) while scheduling different
      // rooms, so the id folds in what this schedule actually contains.
      scheduleId: `sch_${hex8(
        mulberry32(
          fnv1a(
            `${plan.planId}:room-schedule:${rows.length}:${round2(totalAreaM2)}:` +
              rows.map((r) => `${r.number}/${r.function}/${round2(r.areaM2)}`).join(','),
          ),
        ),
      )}`,
      rowCount: rows.length,
      totalAreaM2: round2(totalAreaM2),
      byLevel: [...levelTotals.entries()]
        .map(([level, t]) => ({ level, rooms: t.rooms, areaM2: round2(t.areaM2) }))
        .sort((a, b) => a.level - b.level),
      byFunction: [...functionTotals.entries()]
        .map(([fn, t]) => ({ function: fn, rooms: t.rooms, areaM2: round2(t.areaM2) }))
        .sort((a, b) => byString(a.function, b.function)),
    };

    const schedule: TableValue = {
      columns: [
        { id: 'number', label: 'Number' },
        { id: 'name', label: 'Name' },
        { id: 'function', label: 'Function' },
        { id: 'level', label: 'Level' },
        { id: 'area_m2', label: 'Area (m²)' },
        { id: 'occupant_load', label: 'Occupant load' },
        { id: 'finish_floor', label: 'Floor finish' },
        { id: 'finish_ceiling', label: 'Ceiling finish' },
        { id: 'guid', label: 'IFC GUID' },
      ],
      rows: rows.map(
        (r): Record<string, Value> => ({
          number: r.number,
          name: r.name,
          function: r.function,
          level: r.level,
          area_m2: r.areaM2,
          occupant_load: r.occupantLoad,
          finish_floor: r.finishFloor,
          finish_ceiling: r.finishCeiling,
          guid: r.guid,
        }),
      ),
    };

    return { schedule: toValue(schedule), summary: toValue(summary) };
  },
};
