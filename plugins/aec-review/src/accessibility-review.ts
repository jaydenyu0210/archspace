/**
 * aec.review.accessibility — MOCK of an accessibility-checking engine.
 * Every check is computed deterministically from the ACTUAL plan geometry
 * (door widths, room bounding boxes, exit kinds), so tweaking an upstream param
 * genuinely changes the findings. The ReviewResult shape (shapes.ts) is the
 * contract a real ANSI A117.1 checker must return.
 *
 * The thresholds here deliberately differ from the IBC ones in
 * compliance-review.ts: a door that merely warns under IBC egress rules can be
 * a hard accessibility violation, so the two reviews disagree in useful ways on
 * the very same plan.
 */
import type { NodeModule, Value } from '@archspace/node-sdk';
import type {
  BimModelSummary,
  FloorPlanLevel,
  FloorPlanResult,
  ReviewFinding,
  ReviewResult,
  TableValue,
} from '@archspace/nodes-core/shapes';
import { fnv1a, hex8, mulberry32, requireInput, sleep, toValue } from '@archspace/nodes-core/util';

export interface AccessibilityReviewParams {
  standard_version: string;
  min_door_clear_mm: number;
  include_advisory: boolean;
  mock_latency_ms: number;
}

/** A117.1 turning space: a 1525 mm diameter circle must fit in the space. */
const TURNING_SPACE_MM = 1525;
/** A117.1 accessible route minimum clear width. */
const ROUTE_MIN_WIDTH_MM = 915;
/** Clear width at which two wheelchairs can pass — recommended, not required. */
const ROUTE_PASSING_WIDTH_MM = 1120;
/** Clear door width recommended on a primary accessible route. */
const DOOR_RECOMMENDED_MM = 915;

/** Minimum bounding-box dimension of a polygon, in the polygon's own units. */
function minBboxDimension(polygon: [number, number][]): number {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const [x, y] of polygon) {
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  }
  return Math.min(maxX - minX, maxY - minY);
}

/** True when the storey has at least one stair — the accessible egress anchor. */
function hasStairExit(level: FloorPlanLevel): boolean {
  return level.exits.some((exit) => exit.kind === 'stair');
}

export const accessibilityReviewNode: NodeModule<AccessibilityReviewParams> = {
  manifest: {
    type: 'aec.review.accessibility',
    version: 1,
    label: 'Accessibility Review',
    description:
      'Mock accessibility check: clear widths, turning space and accessible egress, judged against the generated plan.',
    category: 'Review',
    keywords: ['accessibility', 'a117', 'ada', 'clear width', 'mock'],
    caching: 'never',
    lane: 'ai',
    params: {
      type: 'object',
      properties: {
        standard_version: {
          type: 'string',
          title: 'Standard version',
          enum: ['2017', '2009'],
          default: '2017',
        },
        min_door_clear_mm: {
          type: 'integer',
          title: 'Minimum door clear width (mm)',
          default: 815,
          minimum: 700,
          maximum: 1200,
        },
        include_advisory: {
          type: 'boolean',
          title: 'Include advisory findings',
          default: true,
        },
        mock_latency_ms: {
          type: 'integer',
          title: 'Mock latency (ms)',
          default: 1100,
          minimum: 0,
        },
      },
    },
    inputs: [
      { id: 'floor_plan', type: 'json', label: 'Floor plan', required: true },
      { id: 'bim_summary', type: 'json', label: 'BIM summary', required: false },
    ],
    outputs: [
      { id: 'result', type: 'json', label: 'Result' },
      { id: 'findings', type: 'table', label: 'Findings' },
    ],
  },

  async execute(ctx, inputs, params) {
    const plan = requireInput<FloorPlanResult>(inputs, 'floor_plan', 'aec.review.accessibility');
    const bim = inputs.bim_summary as unknown as BimModelSummary | undefined;
    if (bim === undefined) {
      ctx.log('info', 'no BIM summary supplied — findings will carry plan ids but no IFC GUIDs');
    }

    const spaceGuids = new Map((bim?.spaces ?? []).map((s) => [s.roomId, s.guid]));
    const doorGuids = new Map((bim?.doors ?? []).map((d) => [d.doorId, d.guid]));

    ctx.progress(0.1, 'checking clear widths');
    await sleep(params.mock_latency_ms / 3, ctx.signal);

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
        discipline: 'accessibility',
        elementIds,
        elementGuids: elementIds
          .map((id) => spaceGuids.get(id) ?? doorGuids.get(id))
          .filter((g): g is string => g !== undefined),
      });
    };

    for (const level of plan.levels) {
      const roomsById = new Map(level.rooms.map((r) => [r.id, r]));

      // A117-304.3 — wheelchair turning space inside every occupiable room.
      for (const room of level.rooms) {
        if (room.function === 'circulation') continue;
        checked++;
        const minDimMm = minBboxDimension(room.polygon);
        if (minDimMm < TURNING_SPACE_MM) {
          addFinding(
            'A117-304.3',
            'Wheelchair turning space',
            'violation',
            `Room ${room.id} "${room.name}" on level ${level.level} has a minimum clear dimension of ` +
              `${minDimMm} mm; a ${TURNING_SPACE_MM} mm turning space is required for wheelchair maneuvering.`,
            level.level,
            [room.id],
          );
        }
      }

      // A117-404.2.3 — door clear width (threshold is a param: jurisdictions vary).
      for (const door of level.doors) {
        checked++;
        const room = roomsById.get(door.roomId);
        const where = room ? `door ${door.id} (room ${room.id} "${room.name}")` : `door ${door.id}`;
        if (door.widthMm < params.min_door_clear_mm) {
          addFinding(
            'A117-404.2.3',
            'Door clear width',
            'violation',
            `Accessible ${where} on level ${level.level} has a clear width of ${door.widthMm} mm; ` +
              `at least ${params.min_door_clear_mm} mm is required.`,
            level.level,
            [door.id],
          );
        } else if (door.widthMm < DOOR_RECOMMENDED_MM) {
          addFinding(
            'A117-404.2.3',
            'Door clear width',
            'warning',
            `Accessible ${where} on level ${level.level} has a clear width of ${door.widthMm} mm; ` +
              `${DOOR_RECOMMENDED_MM} mm is recommended on a primary accessible route.`,
            level.level,
            [door.id],
          );
        }
      }

      // A117-403.5 — clear width of the accessible route (the corridor itself).
      const route = level.rooms.find((r) => r.function === 'circulation');
      if (route) {
        checked++;
        const minDimMm = minBboxDimension(route.polygon);
        if (minDimMm < ROUTE_MIN_WIDTH_MM) {
          addFinding(
            'A117-403.5',
            'Accessible route clear width',
            'violation',
            `Circulation route ${route.id} on level ${level.level} is ${minDimMm} mm wide; ` +
              `accessible routes require at least ${ROUTE_MIN_WIDTH_MM} mm of clear width.`,
            level.level,
            [route.id],
          );
        } else if (minDimMm < ROUTE_PASSING_WIDTH_MM) {
          addFinding(
            'A117-403.5',
            'Accessible route clear width',
            'warning',
            `Circulation route ${route.id} on level ${level.level} is ${minDimMm} mm wide; ` +
              `${ROUTE_PASSING_WIDTH_MM} mm is recommended so two wheelchairs can pass.`,
            level.level,
            [route.id],
          );
        }
      }

      // A117-206.2.4 — accessible means of egress from every storey above grade.
      if (level.level > 0) {
        checked++;
        if (!hasStairExit(level)) {
          addFinding(
            'A117-206.2.4',
            'Accessible means of egress',
            'violation',
            `Level ${level.level} has ${level.exits.length} exit(s) and none of them is a stair; ` +
              `at least one accessible means of egress is required from every storey above grade.`,
            level.level,
            level.exits.map((x) => x.id),
          );
        }
      }
    }

    ctx.progress(0.6, 'checking accessible routes between storeys');
    await sleep(params.mock_latency_ms / 3, ctx.signal);

    // A117-206.2 advisory — the mock plan models no elevator, so a multi-storey
    // scheme cannot yet demonstrate a vertical accessible route.
    if (params.include_advisory && plan.levels.length > 1) {
      checked++;
      addFinding(
        'A117-206.2',
        'Vertical accessible route',
        'advisory',
        `No elevator is modelled in this ${plan.levels.length}-storey plan; the accessible route ` +
          `between storeys must be confirmed before the scheme can be assessed as compliant.`,
        null,
        [],
      );
    }

    await sleep(params.mock_latency_ms / 3, ctx.signal);
    ctx.progress(1, 'review complete');

    const advisories = findings.filter((f) => f.severity === 'advisory').length;
    const warnings = findings.filter((f) => f.severity === 'warning').length;
    const violations = findings.filter((f) => f.severity === 'violation').length;

    const result: ReviewResult = {
      reviewId: `rev_${hex8(mulberry32(fnv1a(`${plan.planId}:accessibility`)))}`,
      discipline: 'accessibility',
      engine: { name: 'mock-accessibility-review', version: '1.0.0' },
      standard: { name: 'ANSI A117.1', version: params.standard_version },
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
