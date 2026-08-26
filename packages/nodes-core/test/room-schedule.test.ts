/** Room schedule: numbering, occupant loads, finishes, GUIDs, aggregates. */
import { describe, expect, it } from 'vitest';
import { createMemoryAssetStore, type MemoryAssetStore, type Value } from '@archspace/node-sdk';
import { runNode } from '@archspace/node-sdk/testkit';
import { isValueOfType } from '@archspace/types';
import { projectBriefNode } from '../src/project-brief.js';
import { spaceProgramNode } from '../src/space-program.js';
import { generateFloorPlanNode } from '../src/floor-plan.js';
import { generateBimModelNode } from '../src/bim-model.js';
import { generateRoomScheduleNode } from '../src/room-schedule.js';
import type {
  BimModelSummary,
  FloorPlanResult,
  RoomScheduleSummary,
  TableValue,
} from '../src/shapes.js';

const GUID_RE = /^[0-9A-Za-z_$]{22}$/;

interface Upstream {
  assets: MemoryAssetStore;
  floorPlan: Value;
  bimSummary: Value;
  plan: FloorPlanResult;
  bim: BimModelSummary;
}

/** Real upstream data: brief → program → floor plan → BIM model. */
async function upstream(
  overrides: { brief?: Record<string, unknown>; plan?: Record<string, unknown> } = {},
): Promise<Upstream> {
  const assets = createMemoryAssetStore();
  const brief = await runNode(projectBriefNode, { params: overrides.brief, assets });
  const program = await runNode(spaceProgramNode, { inputs: { brief: brief.outputs.brief }, assets });
  const plan = await runNode(generateFloorPlanNode, {
    params: { mock_latency_ms: 0, ...overrides.plan },
    inputs: { brief: brief.outputs.brief, program: program.outputs.program },
    assets,
  });
  const bim = await runNode(generateBimModelNode, {
    params: { mock_latency_ms: 0 },
    inputs: { floor_plan: plan.outputs.floor_plan },
    assets,
  });
  return {
    assets,
    floorPlan: plan.outputs.floor_plan,
    bimSummary: bim.outputs.summary,
    plan: plan.outputs.floor_plan as unknown as FloorPlanResult,
    bim: bim.outputs.summary as unknown as BimModelSummary,
  };
}

async function schedule(
  up: Upstream,
  params: Record<string, unknown> = {},
  withBim = true,
): Promise<{ table: TableValue; summary: RoomScheduleSummary; outputs: Record<string, Value> }> {
  const run = await runNode(generateRoomScheduleNode, {
    params,
    inputs: {
      floor_plan: up.floorPlan,
      ...(withBim ? { bim_summary: up.bimSummary } : {}),
    },
    assets: up.assets,
  });
  return {
    table: run.outputs.schedule as unknown as TableValue,
    summary: run.outputs.summary as unknown as RoomScheduleSummary,
    outputs: run.outputs,
  };
}

describe('aec.generate_room_schedule', () => {
  it('runs with defaults and conforms to its declared port types', async () => {
    const up = await upstream();
    const { table, summary, outputs } = await schedule(up);

    expect(isValueOfType(outputs.schedule, 'table')).toBe(true);
    expect(isValueOfType(outputs.summary, 'json')).toBe(true);

    expect(table.columns.map((c) => c.id)).toEqual([
      'number',
      'name',
      'function',
      'level',
      'area_m2',
      'occupant_load',
      'finish_floor',
      'finish_ceiling',
      'guid',
    ]);
    for (const column of table.columns) expect(typeof column.label).toBe('string');

    expect(summary.scheduleId).toMatch(/^sch_[0-9a-f]{8}$/);
    expect(summary.rowCount).toBeGreaterThan(0);
    expect(table.rows).toHaveLength(summary.rowCount);
    expect(summary.byLevel).toHaveLength(up.plan.levels.length);
  });

  it('is deterministic — two identical runs are byte-identical', async () => {
    const up = await upstream();
    const a = await schedule(up);
    const b = await schedule(up);
    expect(a.outputs).toEqual(b.outputs);
  });

  it('takes a 22-char IFC GUID per row from the BIM summary, and null without it', async () => {
    const up = await upstream();
    const withBim = await schedule(up);
    const guidsInModel = new Set(up.bim.spaces.map((s) => s.guid));
    for (const row of withBim.table.rows) {
      expect(row.guid).toMatch(GUID_RE);
      expect(guidsInModel.has(row.guid as string)).toBe(true);
    }

    const withoutBim = await schedule(up, {}, false);
    for (const row of withoutBim.table.rows) expect(row.guid).toBeNull();
    // Only the GUID column differs when the BIM summary is unwired.
    expect(withoutBim.table.rows.map((r) => r.number)).toEqual(withBim.table.rows.map((r) => r.number));
  });

  it('include_circulation adds exactly the corridor rows and their area', async () => {
    const up = await upstream();
    const without = await schedule(up, { include_circulation: false });
    const with_ = await schedule(up, { include_circulation: true });

    const corridors = up.plan.levels.flatMap((l) => l.rooms.filter((r) => r.function === 'circulation'));
    expect(corridors.length).toBe(up.plan.levels.length);

    expect(with_.summary.rowCount - without.summary.rowCount).toBe(corridors.length);
    const corridorArea = corridors.reduce((s, r) => s + r.areaM2, 0);
    expect(with_.summary.totalAreaM2 - without.summary.totalAreaM2).toBeCloseTo(corridorArea, 1);

    expect(without.table.rows.some((r) => r.function === 'circulation')).toBe(false);
    expect(with_.table.rows.filter((r) => r.function === 'circulation')).toHaveLength(corridors.length);
    expect(without.summary.byFunction.some((f) => f.function === 'circulation')).toBe(false);
    expect(with_.summary.byFunction.some((f) => f.function === 'circulation')).toBe(true);
  });

  it('numbers rows "LL-NN" per level, contiguously, with an optional prefix', async () => {
    const up = await upstream();
    const { table } = await schedule(up);

    const seenPerLevel = new Map<number, number>();
    for (const row of table.rows) {
      const number = row.number as string;
      expect(number).toMatch(/^\d{2}-\d{2}$/);
      const [levelPart, seqPart] = number.split('-');
      const level = row.level as number;
      expect(levelPart).toBe(String(level + 1).padStart(2, '0'));
      const expectedSeq = (seenPerLevel.get(level) ?? 0) + 1;
      seenPerLevel.set(level, expectedSeq);
      expect(seqPart).toBe(String(expectedSeq).padStart(2, '0'));
    }

    const prefixed = await schedule(up, { number_prefix: 'A' });
    expect(prefixed.table.rows[0].number).toBe(`A-${table.rows[0].number as string}`);
    for (const row of prefixed.table.rows) expect(row.number).toMatch(/^A-\d{2}-\d{2}$/);
  });

  it('computes occupant load as ceil(area / avg_area_per_person_m2)', async () => {
    const up = await upstream();
    const base = await schedule(up);
    for (const row of base.table.rows) {
      expect(row.occupant_load).toBe(Math.ceil((row.area_m2 as number) / 9.3));
    }

    const dense = await schedule(up, { avg_area_per_person_m2: 4.65 });
    for (const row of dense.table.rows) {
      expect(row.occupant_load).toBe(Math.ceil((row.area_m2 as number) / 4.65));
    }
    const baseTotal = base.table.rows.reduce((s, r) => s + (r.occupant_load as number), 0);
    const denseTotal = dense.table.rows.reduce((s, r) => s + (r.occupant_load as number), 0);
    expect(denseTotal).toBeGreaterThan(baseTotal);
  });

  it('schedules finishes from the room function, with a shell fallback for unknown ones', async () => {
    const up = await upstream();
    const { table } = await schedule(up, { include_circulation: true });

    const byFunction = new Map(table.rows.map((r) => [r.function as string, r]));
    expect(byFunction.get('open_workspace')?.finish_floor).toBe('Carpet tile');
    expect(byFunction.get('open_workspace')?.finish_ceiling).toBe('Suspended acoustic');
    expect(byFunction.get('service')?.finish_floor).toBe('Sealed concrete');
    expect(byFunction.get('service')?.finish_ceiling).toBe('Exposed structure');
    expect(byFunction.get('amenity')?.finish_floor).toBe('Vinyl plank');
    expect(byFunction.get('support')?.finish_floor).toBe('Vinyl sheet');
    expect(byFunction.get('circulation')?.finish_floor).toBe('Polished concrete');

    // An unknown function still schedules a finish rather than a blank cell.
    const mutated = structuredClone(up.plan);
    mutated.levels[0].rooms[1].function = 'wine_cellar';
    const odd = await runNode(generateRoomScheduleNode, {
      inputs: { floor_plan: mutated as unknown as Value },
      assets: up.assets,
    });
    const oddTable = odd.outputs.schedule as unknown as TableValue;
    const oddRow = oddTable.rows.find((r) => r.function === 'wine_cellar');
    expect(oddRow).toBeDefined();
    expect(oddRow?.finish_floor).toBe('Sealed concrete');
    expect(oddRow?.finish_ceiling).toBe('Painted plasterboard');
  });

  it('aggregates by level and by function, sorted, summing to the totals', async () => {
    const up = await upstream();
    const { table, summary } = await schedule(up, { include_circulation: true });

    expect(summary.byLevel.map((l) => l.level)).toEqual(
      [...summary.byLevel.map((l) => l.level)].sort((a, b) => a - b),
    );
    expect(summary.byFunction.map((f) => f.function)).toEqual(
      [...summary.byFunction.map((f) => f.function)].sort(),
    );

    expect(summary.byLevel.reduce((s, l) => s + l.rooms, 0)).toBe(summary.rowCount);
    expect(summary.byFunction.reduce((s, f) => s + f.rooms, 0)).toBe(summary.rowCount);
    expect(summary.byLevel.reduce((s, l) => s + l.areaM2, 0)).toBeCloseTo(summary.totalAreaM2, 1);
    expect(summary.byFunction.reduce((s, f) => s + f.areaM2, 0)).toBeCloseTo(summary.totalAreaM2, 1);

    const tableArea = table.rows.reduce((s, r) => s + (r.area_m2 as number), 0);
    expect(summary.totalAreaM2).toBeCloseTo(tableArea, 1);
  });

  it('a smaller upstream brief produces a smaller schedule', async () => {
    const big = await upstream();
    const small = await upstream({ brief: { target_gross_area_m2: 3800 } });
    const bigSchedule = await schedule(big);
    const smallSchedule = await schedule(small);

    expect(smallSchedule.summary.rowCount).toBeLessThan(bigSchedule.summary.rowCount);
    expect(smallSchedule.summary.totalAreaM2).toBeLessThan(bigSchedule.summary.totalAreaM2);
    expect(smallSchedule.summary.scheduleId).not.toBe(bigSchedule.summary.scheduleId);
    // Still six storeys of schedule, just fewer rooms on each.
    expect(smallSchedule.summary.byLevel).toHaveLength(6);
  });
});
