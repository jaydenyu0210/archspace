/**
 * aec.apply_plan_fixes — MOCK of a design-assistant backend.
 *
 * Closes the review loop: it walks the findings a review produced, applies the
 * mechanical fixes it knows how to make to a deep clone of the plan, and
 * reports exactly what it changed and what it declined to touch. The revised
 * plan is a fully valid FloorPlanResult, so aec.generate_bim_model and
 * aec.code_compliance_review consume it unchanged and the workflow can
 * re-review its own repair.
 *
 * Every edit is computed from the ACTUAL plan geometry (the measured door
 * width, the corridor's real narrow axis, the room's real polygon), never from
 * constants, and every finding ends up in exactly one of `applied` or
 * `unresolved` — a finding is never silently dropped. The PlanFixResult shape
 * (shapes.ts) is the contract a real design-assistant backend must return.
 */
import type { NodeModule, Value } from '@archspace/node-sdk';
import type {
  FloorPlanLevel,
  FloorPlanResult,
  PlanChange,
  PlanDoor,
  PlanExit,
  PlanFixAction,
  PlanFixResult,
  PlanRoom,
  ReviewFinding,
  ReviewResult,
  TableValue,
  UnresolvedFinding,
} from './shapes.js';
import { fnv1a, hex8, mulberry32, requireInput, round2, round3, sleep, toValue } from './util.js';

export interface ApplyPlanFixesParams {
  fix_door_width: boolean;
  fix_corridor_width: boolean;
  add_missing_exits: boolean;
  enlarge_small_rooms: boolean;
  min_door_width_mm: number;
  min_corridor_width_mm: number;
  min_room_area_m2: number;
  mock_latency_ms: number;
}

/** ANSI A117.1 §304.3 — minimum clear floor dimension for a turning space. */
const ACCESSIBLE_MIN_DIM_MM = 1525;

/** How far from the corridor end a newly added stair core is placed. */
const EXIT_INSET_MM = 500;

type FixSwitch = keyof Pick<
  ApplyPlanFixesParams,
  'fix_door_width' | 'fix_corridor_width' | 'add_missing_exits' | 'enlarge_small_rooms'
>;

interface FixRule {
  action: PlanFixAction;
  /** The param that has to be on for this rule to be acted on. */
  gate: FixSwitch;
}

/**
 * The rules this fixer knows how to repair. Anything not listed here is
 * reported as unresolved with "no automatic fix" — the fixer never guesses.
 * A117-* ids come from the accessibility review; IBC-* from the code review.
 */
const FIX_RULES: Record<string, FixRule> = {
  'IBC-1010.1.1': { action: 'widen_door', gate: 'fix_door_width' },
  'A117-404.2.3': { action: 'widen_door', gate: 'fix_door_width' },
  'IBC-1020.3': { action: 'widen_corridor', gate: 'fix_corridor_width' },
  'A117-403.5': { action: 'widen_corridor', gate: 'fix_corridor_width' },
  'IBC-1006.3.2': { action: 'add_exit', gate: 'add_missing_exits' },
  'IBC-1207.3': { action: 'enlarge_room', gate: 'enlarge_small_rooms' },
  'A117-304.3': { action: 'enlarge_room', gate: 'enlarge_small_rooms' },
};

function bbox(polygon: [number, number][]): { minX: number; minY: number; maxX: number; maxY: number } {
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
  return { minX, minY, maxX, maxY };
}

function centroid(polygon: [number, number][]): [number, number] {
  let sx = 0;
  let sy = 0;
  for (const [x, y] of polygon) {
    sx += x;
    sy += y;
  }
  return [sx / polygon.length, sy / polygon.length];
}

/** Shoelace area of a mm polygon, in m². */
function polygonAreaM2(polygon: [number, number][]): number {
  let sum = 0;
  for (let i = 0; i < polygon.length; i++) {
    const [x0, y0] = polygon[i];
    const [x1, y1] = polygon[(i + 1) % polygon.length];
    sum += x0 * y1 - x1 * y0;
  }
  return Math.abs(sum) / 2 / 1e6;
}

function minDimensionMm(polygon: [number, number][]): number {
  const b = bbox(polygon);
  return Math.min(b.maxX - b.minX, b.maxY - b.minY);
}

/** Uniform scale about the polygon's centroid, snapped back to whole mm. */
function scaleAboutCentroid(polygon: [number, number][], factor: number): [number, number][] {
  const [cx, cy] = centroid(polygon);
  return polygon.map(([x, y]): [number, number] => [
    Math.round(cx + (x - cx) * factor),
    Math.round(cy + (y - cy) * factor),
  ]);
}

/** Stretch a polygon along its narrow axis until that axis measures targetMm. */
function widenNarrowAxis(polygon: [number, number][], targetMm: number): [number, number][] {
  const b = bbox(polygon);
  const width = b.maxX - b.minX;
  const depth = b.maxY - b.minY;
  const horizontalIsNarrow = width <= depth;
  const current = horizontalIsNarrow ? width : depth;
  const centre = horizontalIsNarrow ? (b.minX + b.maxX) / 2 : (b.minY + b.maxY) / 2;
  const factor = targetMm / current;
  return polygon.map(([x, y]): [number, number] =>
    horizontalIsNarrow
      ? [Math.round(centre + (x - centre) * factor), y]
      : [x, Math.round(centre + (y - centre) * factor)],
  );
}

/** The finding's own level first, then the rest — findings may carry no level. */
function levelsInSearchOrder(plan: FloorPlanResult, level: number | null): FloorPlanLevel[] {
  if (level === null) return plan.levels;
  return [
    ...plan.levels.filter((l) => l.level === level),
    ...plan.levels.filter((l) => l.level !== level),
  ];
}

function locateDoor(
  plan: FloorPlanResult,
  finding: ReviewFinding,
): { level: FloorPlanLevel; door: PlanDoor } | null {
  for (const level of levelsInSearchOrder(plan, finding.level)) {
    for (const id of finding.elementIds) {
      const door = level.doors.find((d) => d.id === id);
      if (door) return { level, door };
    }
  }
  return null;
}

function locateRoom(
  plan: FloorPlanResult,
  finding: ReviewFinding,
): { level: FloorPlanLevel; room: PlanRoom } | null {
  for (const level of levelsInSearchOrder(plan, finding.level)) {
    for (const id of finding.elementIds) {
      const room = level.rooms.find((r) => r.id === id);
      if (room) return { level, room };
    }
  }
  return null;
}

/** The circulation room the finding names, else the one on the finding's level. */
function locateCorridor(
  plan: FloorPlanResult,
  finding: ReviewFinding,
): { level: FloorPlanLevel; room: PlanRoom } | null {
  const named = locateRoom(plan, finding);
  if (named && named.room.function === 'circulation') return named;
  for (const level of levelsInSearchOrder(plan, finding.level)) {
    if (finding.level !== null && level.level !== finding.level) break;
    const room = level.rooms.find((r) => r.function === 'circulation');
    if (room) return { level, room };
  }
  return null;
}

/** The level a level-scoped finding (e.g. "exits per storey") refers to. */
function locateLevel(plan: FloorPlanResult, finding: ReviewFinding): FloorPlanLevel | null {
  if (finding.level !== null) return plan.levels.find((l) => l.level === finding.level) ?? null;
  for (const level of plan.levels) {
    if (level.exits.some((x) => finding.elementIds.includes(x.id))) return level;
  }
  return null;
}

/** Next free `x_<level>_<n>` on this storey — continues the existing numbering. */
function nextExitId(level: FloorPlanLevel): string {
  let maxN = -1;
  for (const exit of level.exits) {
    const m = /^x_\d+_(\d+)$/.exec(exit.id);
    if (m) maxN = Math.max(maxN, Number(m[1]));
  }
  return `x_${level.level}_${Math.max(maxN + 1, level.exits.length)}`;
}

/** The corridor end farthest from the exits that already exist. */
function farEndOfCorridor(corridor: PlanRoom, exits: PlanExit[]): [number, number] {
  const b = bbox(corridor.polygon);
  const horizontal = b.maxX - b.minX >= b.maxY - b.minY;
  const midX = Math.round((b.minX + b.maxX) / 2);
  const midY = Math.round((b.minY + b.maxY) / 2);
  const ends: [number, number][] = horizontal
    ? [
        [b.minX + EXIT_INSET_MM, midY],
        [b.maxX - EXIT_INSET_MM, midY],
      ]
    : [
        [midX, b.minY + EXIT_INSET_MM],
        [midX, b.maxY - EXIT_INSET_MM],
      ];
  let best = ends[ends.length - 1];
  let bestDistance = -1;
  for (const end of ends) {
    let nearest = Number.MAX_VALUE;
    for (const exit of exits) {
      const dx = end[0] - exit.position[0];
      const dy = end[1] - exit.position[1];
      nearest = Math.min(nearest, Math.sqrt(dx * dx + dy * dy));
    }
    // '>=' so that, with no exits at all, the far end wins the tie.
    if (nearest >= bestDistance) {
      bestDistance = nearest;
      best = end;
    }
  }
  return best;
}

export const applyPlanFixesNode: NodeModule<ApplyPlanFixesParams> = {
  manifest: {
    type: 'aec.apply_plan_fixes',
    version: 1,
    label: 'Apply Plan Fixes',
    description:
      'Mock design assistant: applies the mechanical fixes a review asked for — widening doors and corridors, adding exits, enlarging undersized rooms — and reports exactly what it changed and what it would not touch.',
    category: 'Modify',
    keywords: ['fix', 'repair', 'remediate', 'plan', 'mock'],
    caching: 'never',
    lane: 'ai',
    params: {
      type: 'object',
      properties: {
        fix_door_width: {
          type: 'boolean',
          title: 'Widen narrow doors',
          default: true,
        },
        fix_corridor_width: {
          type: 'boolean',
          title: 'Widen narrow corridors',
          default: true,
        },
        add_missing_exits: {
          type: 'boolean',
          title: 'Add missing exits',
          default: true,
        },
        enlarge_small_rooms: {
          type: 'boolean',
          title: 'Enlarge undersized rooms',
          default: true,
        },
        min_door_width_mm: {
          type: 'integer',
          title: 'Minimum door width (mm)',
          default: 915,
          minimum: 813,
          maximum: 1500,
        },
        min_corridor_width_mm: {
          type: 'integer',
          title: 'Minimum corridor width (mm)',
          default: 1200,
          minimum: 1120,
          maximum: 3000,
        },
        min_room_area_m2: {
          type: 'number',
          title: 'Minimum room area (m²)',
          default: 7,
          minimum: 1,
          maximum: 50,
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
      { id: 'review', type: 'json', label: 'Review', required: true },
    ],
    outputs: [
      { id: 'floor_plan', type: 'json', label: 'Revised floor plan' },
      { id: 'change_log', type: 'json', label: 'Change log' },
      { id: 'changes', type: 'table', label: 'Changes' },
    ],
  },

  async execute(ctx, inputs, params) {
    const plan = requireInput<FloorPlanResult>(inputs, 'floor_plan', 'aec.apply_plan_fixes');
    const review = requireInput<ReviewResult>(inputs, 'review', 'aec.apply_plan_fixes');

    // The plan is revised on a deep clone — the upstream value is never mutated.
    const revised: FloorPlanResult = structuredClone(plan);
    const findings = review.findings ?? [];

    // Both ids derive from content, never from the clock: same plan + same
    // review ⇒ same fix id ⇒ same revised plan id, run after run.
    const fixId = `fix_${hex8(mulberry32(fnv1a(`${plan.planId}:${review.reviewId}`)))}`;

    ctx.progress(0.1, `reading ${findings.length} finding(s) from ${review.reviewId}`);
    await sleep(params.mock_latency_ms / 3, ctx.signal);

    const applied: PlanChange[] = [];
    const unresolved: UnresolvedFinding[] = [];

    const record = (
      finding: ReviewFinding,
      action: PlanFixAction,
      targetId: string,
      level: number | null,
      before: Value,
      after: Value,
      description: string,
    ): void => {
      applied.push({
        id: `chg_${String(applied.length + 1).padStart(3, '0')}`,
        findingId: finding.id,
        ruleId: finding.ruleId,
        action,
        targetId,
        level,
        before,
        after,
        description,
      });
    };

    const skip = (finding: ReviewFinding, reason: string): void => {
      unresolved.push({
        findingId: finding.id,
        ruleId: finding.ruleId,
        severity: finding.severity,
        reason,
      });
    };

    // Findings are walked in order, so an earlier fix is visible to a later
    // finding on the same element (the second one becomes a no-op, not a
    // double edit).
    for (const finding of findings) {
      const rule = FIX_RULES[finding.ruleId];
      if (!rule) {
        skip(finding, `rule ${finding.ruleId} "${finding.title}" has no automatic fix in this fixer`);
        continue;
      }
      if (!params[rule.gate]) {
        skip(
          finding,
          `the ${rule.gate} switch is off, so the ${rule.action} fix for ${finding.ruleId} was not applied`,
        );
        continue;
      }

      switch (rule.action) {
        case 'widen_door': {
          const hit = locateDoor(revised, finding);
          if (!hit) {
            skip(
              finding,
              `no door matching element id(s) [${finding.elementIds.join(', ')}] was found in plan ${plan.planId}`,
            );
            break;
          }
          const { level, door } = hit;
          const beforeWidth = door.widthMm;
          const afterWidth = Math.max(beforeWidth, params.min_door_width_mm);
          if (afterWidth === beforeWidth) {
            skip(
              finding,
              `door ${door.id} on level ${level.level} is already ${beforeWidth} mm wide, at or above the ${params.min_door_width_mm} mm minimum`,
            );
            break;
          }
          door.widthMm = afterWidth;
          record(
            finding,
            'widen_door',
            door.id,
            level.level,
            beforeWidth,
            afterWidth,
            `Widened door ${door.id} (room ${door.roomId}) on level ${level.level} from ${beforeWidth} mm to ${afterWidth} mm.`,
          );
          break;
        }

        case 'widen_corridor': {
          const hit = locateCorridor(revised, finding);
          if (!hit) {
            skip(
              finding,
              `no circulation corridor was found for level ${finding.level === null ? '?' : finding.level} in plan ${plan.planId}`,
            );
            break;
          }
          const { level, room } = hit;
          const beforeWidth = minDimensionMm(room.polygon);
          const beforeArea = room.areaM2;
          if (beforeWidth >= params.min_corridor_width_mm) {
            skip(
              finding,
              `corridor ${room.id} on level ${level.level} is already ${beforeWidth} mm wide, at or above the ${params.min_corridor_width_mm} mm minimum`,
            );
            break;
          }
          room.polygon = widenNarrowAxis(room.polygon, params.min_corridor_width_mm);
          const afterWidth = minDimensionMm(room.polygon);
          room.areaM2 = round2(polygonAreaM2(room.polygon));
          record(
            finding,
            'widen_corridor',
            room.id,
            level.level,
            toValue({ widthMm: beforeWidth, areaM2: beforeArea }),
            toValue({ widthMm: afterWidth, areaM2: room.areaM2 }),
            `Widened corridor ${room.id} on level ${level.level} from ${beforeWidth} mm to ${afterWidth} mm across its narrow axis (${beforeArea} m² → ${room.areaM2} m²).`,
          );
          break;
        }

        case 'add_exit': {
          const level = locateLevel(revised, finding);
          if (!level) {
            skip(
              finding,
              `no level matching the finding (level ${finding.level === null ? '?' : finding.level}) was found in plan ${plan.planId}`,
            );
            break;
          }
          if (level.exits.length >= 2) {
            skip(
              finding,
              `level ${level.level} already has ${level.exits.length} exits; no additional exit was needed`,
            );
            break;
          }
          const corridor = level.rooms.find((r) => r.function === 'circulation');
          if (!corridor) {
            skip(
              finding,
              `level ${level.level} has no circulation corridor to anchor an additional exit to`,
            );
            break;
          }
          const beforeIds = level.exits.map((x) => x.id);
          const exit: PlanExit = {
            id: nextExitId(level),
            kind: 'stair',
            position: farEndOfCorridor(corridor, level.exits),
          };
          level.exits.push(exit);
          record(
            finding,
            'add_exit',
            exit.id,
            level.level,
            toValue({ exitCount: beforeIds.length, exitIds: beforeIds }),
            toValue({ exitCount: level.exits.length, exitIds: level.exits.map((x) => x.id) }),
            `Added stair exit ${exit.id} at the far end of corridor ${corridor.id} on level ${level.level}, taking the storey from ${beforeIds.length} to ${level.exits.length} exits.`,
          );
          break;
        }

        case 'enlarge_room': {
          const hit = locateRoom(revised, finding);
          if (!hit) {
            skip(
              finding,
              `no room matching element id(s) [${finding.elementIds.join(', ')}] was found in plan ${plan.planId}`,
            );
            break;
          }
          const { level, room } = hit;
          // A117-304.3 is about clear dimension, IBC-1207.3 about floor area:
          // both are met by scaling the room about its own centroid.
          const dimensionRule = finding.ruleId === 'A117-304.3';
          const beforeArea = room.areaM2;
          const beforeDim = minDimensionMm(room.polygon);
          const meets = (polygon: [number, number][]): boolean =>
            dimensionRule
              ? minDimensionMm(polygon) >= ACCESSIBLE_MIN_DIM_MM
              : round2(polygonAreaM2(polygon)) >= params.min_room_area_m2;
          if (meets(room.polygon)) {
            skip(
              finding,
              dimensionRule
                ? `room ${room.id} on level ${level.level} already measures ${beforeDim} mm across its narrow axis, at or above the ${ACCESSIBLE_MIN_DIM_MM} mm minimum`
                : `room ${room.id} on level ${level.level} is already ${beforeArea} m², at or above the ${params.min_room_area_m2} m² minimum`,
            );
            break;
          }
          let factor = dimensionRule
            ? ACCESSIBLE_MIN_DIM_MM / Math.max(1, beforeDim)
            : Math.sqrt(params.min_room_area_m2 / Math.max(0.000001, polygonAreaM2(room.polygon)));
          let polygon = scaleAboutCentroid(room.polygon, factor);
          // Snapping vertices to whole mm can land a hair short of the target;
          // nudge the factor until the rounded result actually complies.
          for (let attempt = 0; attempt < 8 && !meets(polygon); attempt++) {
            factor *= 1.002;
            polygon = scaleAboutCentroid(room.polygon, factor);
          }
          room.polygon = polygon;
          room.areaM2 = round2(polygonAreaM2(polygon));
          const afterDim = minDimensionMm(polygon);
          record(
            finding,
            'enlarge_room',
            room.id,
            level.level,
            toValue({ areaM2: beforeArea, minDimMm: beforeDim }),
            toValue({ areaM2: room.areaM2, minDimMm: afterDim }),
            dimensionRule
              ? `Enlarged room ${room.id} "${room.name}" on level ${level.level} from ${beforeDim} mm to ${afterDim} mm across its narrow axis (${beforeArea} m² → ${room.areaM2} m²).`
              : `Enlarged room ${room.id} "${room.name}" on level ${level.level} from ${beforeArea} m² to ${room.areaM2} m² (minimum ${params.min_room_area_m2} m²).`,
          );
          break;
        }
      }
    }

    ctx.progress(0.6, `applied ${applied.length} change(s), ${unresolved.length} unresolved`);
    await sleep(params.mock_latency_ms / 3, ctx.signal);

    // Metrics are recomputed from the revised rooms exactly the way
    // floor-plan.ts computes them, so the plan stays self-consistent.
    let netAreaM2 = 0;
    let grossAreaM2 = 0;
    for (const level of revised.levels) {
      for (const room of level.rooms) {
        grossAreaM2 += room.areaM2;
        if (room.function !== 'circulation') netAreaM2 += room.areaM2;
      }
    }
    netAreaM2 = round2(netAreaM2);
    grossAreaM2 = round2(grossAreaM2);

    revised.planId = `plan_${hex8(mulberry32(fnv1a(`${plan.planId}:${fixId}`)))}`;
    revised.metrics = {
      grossAreaM2,
      netAreaM2,
      efficiency: grossAreaM2 === 0 ? 0 : round3(netAreaM2 / grossAreaM2),
    };

    await sleep(params.mock_latency_ms / 3, ctx.signal);
    ctx.progress(1, `revised plan ${revised.planId} ready`);

    const changeLog: PlanFixResult = {
      fixId,
      fixer: { name: 'mock-plan-fixer', version: '1.0.0' },
      basePlanId: plan.planId,
      revisedPlanId: revised.planId,
      applied,
      unresolved,
      summary: {
        requested: findings.length,
        applied: applied.length,
        unresolved: unresolved.length,
      },
    };

    const changesTable: TableValue = {
      columns: [
        { id: 'id', label: 'ID' },
        { id: 'finding_id', label: 'Finding' },
        { id: 'rule_id', label: 'Rule' },
        { id: 'action', label: 'Action' },
        { id: 'target', label: 'Target' },
        { id: 'level', label: 'Level' },
        { id: 'description', label: 'Description' },
      ],
      rows: applied.map(
        (c): Record<string, Value> => ({
          id: c.id,
          finding_id: c.findingId,
          rule_id: c.ruleId,
          action: c.action,
          target: c.targetId,
          level: c.level,
          description: c.description,
        }),
      ),
    };

    return {
      floor_plan: toValue(revised),
      change_log: toValue(changeLog),
      changes: toValue(changesTable),
    };
  },
};
