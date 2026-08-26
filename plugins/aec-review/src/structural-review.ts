/**
 * aec.review.structural — MOCK of a structural checking engine.
 * Every check is computed deterministically from the ACTUAL grid and plan
 * geometry — beam spans as framed, column positions against the rooms and
 * doors they would land in — so tweaking an upstream param genuinely changes
 * the findings. The ReviewResult shape (shapes.ts) is the contract a real
 * engine must return.
 */
import type { NodeModule, Value } from '@archspace/node-sdk';
import type {
  FloorPlanResult,
  PlanRoom,
  ReviewFinding,
  ReviewResult,
  StructuralGridResult,
  TableValue,
} from '@archspace/nodes-core/shapes';
import { fnv1a, hex8, mulberry32, requireInput, round2, sleep, toValue } from '@archspace/nodes-core/util';

export interface StructuralReviewParams {
  standard_version: string;
  max_span_mm: number;
  include_advisory: boolean;
  mock_latency_ms: number;
}

/** A beam this close to the limit is flagged as a warning, not a violation. */
const NEAR_LIMIT_FRACTION = 0.85;

/** A room below this area cannot absorb a column without losing its use. */
const SMALL_ROOM_M2 = 20;

/** Clear distance a column must keep from a door leaf. */
const DOOR_CLEARANCE_MM = 600;

/** Bay proportion beyond which the framing is advised to be squared up. */
const MAX_BAY_ASPECT = 1.5;

/**
 * General ray-casting point-in-polygon test. The mock plan happens to emit
 * rectangles, but the rule is written for the arbitrary polygons a real layout
 * backend would return.
 */
function pointInPolygon(point: [number, number], polygon: [number, number][]): boolean {
  const [x, y] = point;
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const [xi, yi] = polygon[i];
    const [xj, yj] = polygon[j];
    const straddles = yi > y !== yj > y;
    if (straddles && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function distanceMm(a: [number, number], b: [number, number]): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1]);
}

export const structuralReviewNode: NodeModule<StructuralReviewParams> = {
  manifest: {
    type: 'aec.review.structural',
    version: 1,
    label: 'Structural Review',
    description:
      'Mock structural checking engine: checks beam spans, column/room conflicts and bay proportion against the generated plan.',
    category: 'Review',
    keywords: ['structural', 'review', 'span', 'columns', 'mock'],
    caching: 'never',
    lane: 'ai',
    params: {
      type: 'object',
      properties: {
        standard_version: {
          type: 'string',
          title: 'Standard version',
          enum: ['2022', '2016'],
          default: '2022',
        },
        max_span_mm: {
          type: 'integer',
          title: 'Maximum beam span (mm)',
          default: 9000,
          minimum: 3000,
          maximum: 20000,
        },
        include_advisory: {
          type: 'boolean',
          title: 'Include advisory findings',
          default: true,
        },
        mock_latency_ms: {
          type: 'integer',
          title: 'Mock latency (ms)',
          default: 900,
          minimum: 0,
        },
      },
    },
    inputs: [
      { id: 'grid', type: 'json', label: 'Structural grid', required: true },
      { id: 'floor_plan', type: 'json', label: 'Floor plan', required: true },
    ],
    outputs: [
      { id: 'result', type: 'json', label: 'Result' },
      { id: 'findings', type: 'table', label: 'Findings' },
    ],
  },

  async execute(ctx, inputs, params) {
    const grid = requireInput<StructuralGridResult>(inputs, 'grid', 'aec.review.structural');
    const plan = requireInput<FloorPlanResult>(inputs, 'floor_plan', 'aec.review.structural');

    let checked = 0;
    const findings: ReviewFinding[] = [];
    const addFinding = (
      ruleId: string,
      title: string,
      severity: ReviewFinding['severity'],
      message: string,
      level: number | null,
      elementIds: string[],
    ): void => {
      findings.push({
        id: `f_${String(findings.length + 1).padStart(3, '0')}`,
        ruleId,
        title,
        severity,
        message,
        level,
        discipline: 'structural',
        elementIds,
        // No BIM summary reaches this node, so findings carry plan ids only.
        elementGuids: [],
      });
    };

    ctx.progress(0.15, `checking ${grid.beams.length} beam spans`);
    await sleep(params.mock_latency_ms / 3, ctx.signal);

    // STR-SPAN-1 / STR-SPAN-2 — beam span against the allowed maximum.
    const nearLimitMm = params.max_span_mm * NEAR_LIMIT_FRACTION;
    for (const beam of grid.beams) {
      checked++;
      if (beam.spanMm > params.max_span_mm) {
        addFinding(
          'STR-SPAN-1',
          'Beam span exceeds the limit',
          'violation',
          `Beam ${beam.id} on level ${beam.level} spans ${beam.spanMm} mm; the ${grid.system} framing limit in use is ${params.max_span_mm} mm.`,
          beam.level,
          [beam.id],
        );
      } else if (beam.spanMm >= nearLimitMm) {
        addFinding(
          'STR-SPAN-2',
          'Beam span near the limit',
          'warning',
          `Beam ${beam.id} on level ${beam.level} spans ${beam.spanMm} mm, within 15% of the ${params.max_span_mm} mm limit (${round2(nearLimitMm)} mm); confirm deflection at ${beam.depthMm} mm deep.`,
          beam.level,
          [beam.id],
        );
      }
    }

    ctx.progress(0.5, `checking ${grid.columns.length} columns against the plan`);
    await sleep(params.mock_latency_ms / 3, ctx.signal);

    // STR-COL-1 — a column landing inside a small non-circulation room. A
    // column is carried by every level, so the levels are scanned in order and
    // the first room it spoils is reported; one finding per column keeps the
    // result actionable instead of repeating the same clash storey by storey.
    for (const column of grid.columns) {
      checked++;
      let clash: { level: number; room: PlanRoom } | undefined;
      for (const level of plan.levels) {
        const room = level.rooms.find(
          (r) =>
            r.function !== 'circulation' &&
            r.areaM2 < SMALL_ROOM_M2 &&
            pointInPolygon(column.position, r.polygon),
        );
        if (room) {
          clash = { level: level.level, room };
          break;
        }
      }
      if (clash) {
        addFinding(
          'STR-COL-1',
          'Column inside a small room',
          'violation',
          `Column ${column.id} (grid ${column.gridRef}) at ${column.position[0]}, ${column.position[1]} mm stands inside room ${clash.room.id} "${clash.room.name}" on level ${clash.level}, which is ${clash.room.areaM2} m²; rooms under ${SMALL_ROOM_M2} m² cannot absorb a column.`,
          clash.level,
          [column.id, clash.room.id],
        );
      }
    }

    // STR-COL-2 — a column crowding a door. The nearest door across the stack
    // is reported, again one finding per column.
    for (const column of grid.columns) {
      checked++;
      let nearest: { level: number; doorId: string; distanceMm: number } | undefined;
      for (const level of plan.levels) {
        for (const door of level.doors) {
          const d = distanceMm(column.position, door.position);
          if (d <= DOOR_CLEARANCE_MM && (nearest === undefined || d < nearest.distanceMm)) {
            nearest = { level: level.level, doorId: door.id, distanceMm: d };
          }
        }
      }
      if (nearest) {
        addFinding(
          'STR-COL-2',
          'Column crowds a door',
          'warning',
          `Column ${column.id} (grid ${column.gridRef}) is ${round2(nearest.distanceMm)} mm from door ${nearest.doorId} on level ${nearest.level}; at least ${DOOR_CLEARANCE_MM} mm of clearance is expected.`,
          nearest.level,
          [column.id, nearest.doorId],
        );
      }
    }

    // STR-BAY-1 — bay proportion. Advisory: long thin bays frame badly but
    // break nothing.
    if (params.include_advisory) {
      checked++;
      const longMm = Math.max(grid.bay.widthMm, grid.bay.depthMm);
      const shortMm = Math.min(grid.bay.widthMm, grid.bay.depthMm);
      const ratio = round2(longMm / shortMm);
      if (ratio > MAX_BAY_ASPECT) {
        addFinding(
          'STR-BAY-1',
          'Bay aspect ratio',
          'advisory',
          `The ${grid.bay.widthMm} × ${grid.bay.depthMm} mm bay has an aspect ratio of ${ratio} (over ${MAX_BAY_ASPECT}); squarer bays frame more efficiently in ${grid.system}.`,
          null,
          [],
        );
      }
    }

    await sleep(params.mock_latency_ms / 3, ctx.signal);
    ctx.progress(1, 'review complete');

    const advisories = findings.filter((f) => f.severity === 'advisory').length;
    const warnings = findings.filter((f) => f.severity === 'warning').length;
    const violations = findings.filter((f) => f.severity === 'violation').length;

    const result: ReviewResult = {
      reviewId: `rev_${hex8(mulberry32(fnv1a(`${plan.planId}:structural`)))}`,
      discipline: 'structural',
      engine: { name: 'mock-structural-review', version: '1.0.0' },
      standard: { name: 'AISC/ACI concept check', version: params.standard_version },
      summary: {
        checked,
        passed: checked - findings.length,
        advisories,
        warnings,
        violations,
      },
      findings,
    };

    const findingsTable: TableValue = {
      columns: [
        { id: 'id', label: 'ID' },
        { id: 'rule_id', label: 'Rule' },
        { id: 'severity', label: 'Severity' },
        { id: 'title', label: 'Title' },
        { id: 'level', label: 'Level' },
        { id: 'elements', label: 'Elements' },
        { id: 'message', label: 'Message' },
      ],
      rows: findings.map(
        (f): Record<string, Value> => ({
          id: f.id,
          rule_id: f.ruleId,
          severity: f.severity,
          title: f.title,
          level: f.level,
          elements: f.elementIds.join(', '),
          message: f.message,
        }),
      ),
    };

    return { result: toValue(result), findings: toValue(findingsTable) };
  },
};
