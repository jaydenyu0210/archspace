/**
 * aec.review.code_compliance — MOCK of a code-checking engine.
 * All checks are computed deterministically from the ACTUAL plan geometry, so
 * tweaking upstream params genuinely changes the findings. The
 * ComplianceReviewResult shape (shapes.ts) is the contract a real engine must
 * return.
 */
import type { NodeModule, Value } from '@archspace/node-sdk';
import type {
  BimModelSummary,
  ComplianceFinding,
  ComplianceReviewResult,
  FloorPlanLevel,
  FloorPlanResult,
  PlanRoom,
  TableValue,
} from '@archspace/nodes-core/shapes';
import { fnv1a, hex8, mulberry32, requireInput, round2, sleep, toValue } from '@archspace/nodes-core/util';

export interface CodeComplianceReviewParams {
  code_version: string;
  include_advisory: boolean;
  mock_latency_ms: number;
}

const OCCUPANT_AREA_M2 = 9.3;

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

/** Occupant load of a level, recomputed from room areas / 9.3 m² per person. */
function levelOccupantLoad(level: FloorPlanLevel): number {
  return level.rooms
    .filter((r) => r.function !== 'circulation')
    .reduce((sum, r) => sum + Math.ceil(r.areaM2 / OCCUPANT_AREA_M2), 0);
}

function nearestExitDistanceM(room: PlanRoom, level: FloorPlanLevel): number {
  const [cx, cy] = centroid(room.polygon);
  let best = Infinity;
  for (const exit of level.exits) {
    const dx = cx - exit.position[0];
    const dy = cy - exit.position[1];
    const d = Math.sqrt(dx * dx + dy * dy);
    if (d < best) best = d;
  }
  return best / 1000;
}

export const codeComplianceReviewNode: NodeModule<CodeComplianceReviewParams> = {
  manifest: {
    type: 'aec.review.code_compliance',
    version: 1,
    label: 'Code Compliance Review',
    description:
      'Mock code-checking engine: runs deterministic IBC egress and room-geometry checks against the generated floor plan.',
    category: 'Review',
    keywords: ['code', 'compliance', 'ibc', 'egress', 'mock'],
    caching: 'never',
    lane: 'ai',
    params: {
      type: 'object',
      properties: {
        code_version: {
          type: 'string',
          title: 'Code version',
          enum: ['IBC 2024', 'IBC 2021'],
          default: 'IBC 2024',
        },
        include_advisory: {
          type: 'boolean',
          title: 'Include advisory findings',
          default: true,
        },
        mock_latency_ms: {
          type: 'integer',
          title: 'Mock latency (ms)',
          default: 1400,
          minimum: 0,
        },
      },
    },
    inputs: [
      { id: 'floor_plan', type: 'json', label: 'Floor plan', required: true },
      { id: 'bim_summary', type: 'json', label: 'BIM summary', required: true },
      { id: 'model', type: 'asset<ifc>', label: 'IFC model', required: false },
    ],
    outputs: [
      { id: 'result', type: 'json', label: 'Result' },
      { id: 'findings', type: 'table', label: 'Findings' },
    ],
  },

  async execute(ctx, inputs, params) {
    const plan = requireInput<FloorPlanResult>(inputs, 'floor_plan', 'aec.review.code_compliance');
    const bim = inputs.bim_summary as unknown as BimModelSummary | undefined;
    if (inputs.model === undefined) {
      ctx.log('info', 'reviewing without the IFC file — plan geometry and BIM summary only');
    }

    const spaceGuids = new Map((bim?.spaces ?? []).map((s) => [s.roomId, s.guid]));
    const doorGuids = new Map((bim?.doors ?? []).map((d) => [d.doorId, d.guid]));

    ctx.progress(0.1, 'checking room geometry');
    await sleep(params.mock_latency_ms / 3, ctx.signal);

    let checked = 0;
    const findings: ComplianceFinding[] = [];
    const addFinding = (
      ruleId: string,
      title: string,
      severity: ComplianceFinding['severity'],
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
        discipline: 'code',
        elementIds,
        elementGuids: elementIds
          .map((id) => spaceGuids.get(id) ?? doorGuids.get(id))
          .filter((g): g is string => g !== undefined),
      });
    };

    for (const level of plan.levels) {
      const load = levelOccupantLoad(level);
      const roomsById = new Map(level.rooms.map((r) => [r.id, r]));

      // IBC-1207.3 — minimum room area (non-circulation, non-service rooms).
      for (const room of level.rooms) {
        if (room.function === 'circulation' || room.function === 'service') continue;
        checked++;
        if (room.areaM2 < 7) {
          addFinding(
            'IBC-1207.3',
            'Minimum room area',
            'violation',
            `Room ${room.id} "${room.name}" on level ${level.level} is ${room.areaM2} m²; habitable rooms require at least 7 m².`,
            level.level,
            [room.id],
          );
        }
      }

      // IBC-1010.1.1 — door clear width.
      for (const door of level.doors) {
        checked++;
        const room = roomsById.get(door.roomId);
        const where = room ? `door ${door.id} (room ${room.id} "${room.name}")` : `door ${door.id}`;
        if (door.widthMm < 813) {
          addFinding(
            'IBC-1010.1.1',
            'Door clear width',
            'violation',
            `Egress ${where} on level ${level.level} has a clear width of ${door.widthMm} mm; at least 813 mm is required.`,
            level.level,
            [door.id],
          );
        } else if (door.widthMm <= 914) {
          addFinding(
            'IBC-1010.1.1',
            'Door clear width',
            'warning',
            `Egress ${where} on level ${level.level} has a clear width of ${door.widthMm} mm; 914 mm is recommended for accessible egress.`,
            level.level,
            [door.id],
          );
        }
      }

      // IBC-1020.3 — corridor width (min dimension) under occupant load ≥ 50.
      const corridor = level.rooms.find((r) => r.function === 'circulation');
      if (corridor) {
        checked++;
        const b = bbox(corridor.polygon);
        const minDimMm = Math.min(b.maxX - b.minX, b.maxY - b.minY);
        if (minDimMm < 1120 && load >= 50) {
          addFinding(
            'IBC-1020.3',
            'Corridor width',
            'violation',
            `Corridor ${corridor.id} on level ${level.level} is ${minDimMm} mm wide; corridors serving an occupant load of ${load} (≥ 50) require at least 1120 mm.`,
            level.level,
            [corridor.id],
          );
        }
      }

      // IBC-1006.3.2 — exits per storey.
      checked++;
      if (load > 49 && level.exits.length < 2) {
        addFinding(
          'IBC-1006.3.2',
          'Exits per storey',
          'violation',
          `Level ${level.level} has an occupant load of ${load} (> 49) but only ${level.exits.length} exit(s); at least 2 exits are required.`,
          level.level,
          level.exits.map((x) => x.id),
        );
      }

      // IBC-1017.2 — exit access travel distance (straight-line, centroid → nearest exit).
      for (const room of level.rooms) {
        if (room.function === 'circulation') continue;
        checked++;
        const distM = round2(nearestExitDistanceM(room, level));
        if (distM > 91) {
          addFinding(
            'IBC-1017.2',
            'Exit access travel distance',
            'violation',
            `Room ${room.id} "${room.name}" on level ${level.level} is ${distM} m from the nearest exit; the 91 m maximum is exceeded.`,
            level.level,
            [room.id],
          );
        } else if (distM > 61) {
          addFinding(
            'IBC-1017.2',
            'Exit access travel distance',
            'warning',
            `Room ${room.id} "${room.name}" on level ${level.level} is ${distM} m from the nearest exit; distances over 61 m warrant sprinkler confirmation.`,
            level.level,
            [room.id],
          );
        }
      }
    }

    ctx.progress(0.6, 'checking egress and efficiency');
    await sleep(params.mock_latency_ms / 3, ctx.signal);

    // Advisory — plan efficiency.
    if (params.include_advisory) {
      checked++;
      if (plan.metrics.efficiency < 0.6) {
        addFinding(
          'AEC-EFF-1',
          'Low plan efficiency',
          'advisory',
          `Plan efficiency is ${plan.metrics.efficiency} net-to-gross (below 0.6); consider tightening circulation.`,
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

    const result: ComplianceReviewResult = {
      reviewId: `rev_${hex8(mulberry32(fnv1a(plan.planId)))}`,
      discipline: 'code',
      engine: { name: 'mock-code-review', version: '1.0.0' },
      standard: { name: 'IBC', version: params.code_version },
      code: { jurisdiction: 'IBC', version: params.code_version },
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
