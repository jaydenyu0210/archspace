/**
 * Structural grid: lines, columns and framing measured against the plan the
 * upstream floor-plan node actually produces — never against a hand-faked one.
 */
import { describe, expect, it } from 'vitest';
import { runNode, type RunNodeResult } from '@archspace/node-sdk/testkit';
import { isValueOfType } from '@archspace/types';
import { generateFloorPlanNode } from '../src/floor-plan.js';
import { projectBriefNode } from '../src/project-brief.js';
import { spaceProgramNode } from '../src/space-program.js';
import { generateStructuralGridNode } from '../src/structural-grid.js';
import type { FloorPlanResult, StructuralGridResult, TableValue } from '../src/shapes.js';

/** Run brief → program → floor plan, so the grid is laid over a real plan. */
async function makePlan(briefParams: Record<string, unknown> = {}): Promise<FloorPlanResult> {
  const brief = await runNode(projectBriefNode, { params: briefParams });
  const program = await runNode(spaceProgramNode, { inputs: { brief: brief.outputs.brief } });
  const plan = await runNode(generateFloorPlanNode, {
    params: { backend: 'mock' as const, mock_latency_ms: 0 },
    inputs: { brief: brief.outputs.brief, program: program.outputs.program },
  });
  return plan.outputs.floor_plan as unknown as FloorPlanResult;
}

async function runGrid(
  plan: FloorPlanResult,
  params: Record<string, unknown> = {},
): Promise<RunNodeResult<unknown>> {
  return runNode(generateStructuralGridNode, {
    params: { mock_latency_ms: 0, ...params },
    inputs: { floor_plan: plan as never },
  });
}

function grid(run: RunNodeResult<unknown>): StructuralGridResult {
  return run.outputs.grid as unknown as StructuralGridResult;
}

/** The positions the node is expected to lay on one axis, computed independently. */
function expectedPositions(sizeMm: number, spacingMm: number): number[] {
  const out = [0];
  for (let p = spacingMm; p < sizeMm; p += spacingMm) out.push(p);
  out.push(sizeMm);
  return out;
}

describe('aec.generate_structural_grid', () => {
  it('runs on defaults and every output conforms to its declared port type', async () => {
    const plan = await makePlan();
    const run = await runGrid(plan);
    const result = grid(run);

    expect(isValueOfType(run.outputs.grid, 'json')).toBe(true);
    expect(isValueOfType(run.outputs.columns, 'table')).toBe(true);
    expect(result.gridId).toMatch(/^grid_[0-9a-f]{8}$/);
    expect(result.generator).toEqual({ name: 'mock-structure', version: '1.0.0', seed: 7 });
    expect(result.units).toBe('mm');
    expect(result.system).toBe('steel_frame');
    expect(result.bay).toEqual({ widthMm: 7500, depthMm: 7500 });
    expect(run.progress.some((p) => p.fraction === 1)).toBe(true);
    expect(run.progress.length).toBeGreaterThan(2);
  });

  it('lays grid lines that match the bay setting and the site size', async () => {
    const plan = await makePlan();
    const result = grid(await runGrid(plan, { bay_width_mm: 9000, bay_depth_mm: 8000 }));

    const xs = result.gridLines.filter((l) => l.axis === 'x');
    const ys = result.gridLines.filter((l) => l.axis === 'y');
    // 48 000 mm at 9 000 mm bays: 0…45 000 plus a 3 000 mm remainder bay.
    expect(xs.map((l) => l.positionMm)).toEqual(expectedPositions(plan.site.widthMm, 9000));
    expect(xs.map((l) => l.id)).toEqual(['A', 'B', 'C', 'D', 'E', 'F', 'G']);
    // 32 000 mm at 8 000 mm bays divides exactly — no duplicate edge line.
    expect(ys.map((l) => l.positionMm)).toEqual([0, 8000, 16000, 24000, 32000]);
    expect(ys.map((l) => l.id)).toEqual(['1', '2', '3', '4', '5']);
  });

  it('continues line ids past Z as AA, AB when the grid is that wide', async () => {
    const plan = await makePlan({ site_width_m: 100, site_depth_m: 32 });
    const result = grid(await runGrid(plan, { bay_width_mm: 3000 }));
    const xs = result.gridLines.filter((l) => l.axis === 'x').map((l) => l.id);
    expect(xs.length).toBe(35); // 0, 3 000 … 99 000, plus the 100 000 mm edge
    expect(xs[25]).toBe('Z');
    expect(xs[26]).toBe('AA');
    expect(xs[27]).toBe('AB');
  });

  it('puts one column on every line intersection inside the site', async () => {
    const plan = await makePlan();
    const result = grid(await runGrid(plan));

    const xs = result.gridLines.filter((l) => l.axis === 'x');
    const ys = result.gridLines.filter((l) => l.axis === 'y');
    const xById = new Map(xs.map((l) => [l.id, l.positionMm]));
    const yById = new Map(ys.map((l) => [l.id, l.positionMm]));

    expect(result.columns.length).toBe(xs.length * ys.length);
    expect(result.metrics.columnCount).toBe(result.columns.length);
    const seen = new Set<string>();
    result.columns.forEach((col, i) => {
      expect(col.id).toBe(`c_${String(i + 1).padStart(3, '0')}`);
      const [xId, yId] = col.gridRef.split('-');
      expect(xById.get(xId)).toBe(col.position[0]);
      expect(yById.get(yId)).toBe(col.position[1]);
      expect(col.position[0]).toBeGreaterThanOrEqual(0);
      expect(col.position[0]).toBeLessThanOrEqual(plan.site.widthMm);
      expect(col.position[1]).toBeGreaterThanOrEqual(0);
      expect(col.position[1]).toBeLessThanOrEqual(plan.site.depthMm);
      expect(col.levels).toEqual(plan.levels.map((l) => l.level));
      expect(seen.has(col.gridRef)).toBe(false);
      seen.add(col.gridRef);
    });
  });

  it('sizes columns inside the system range, larger for the loaded interior', async () => {
    const plan = await makePlan();
    const result = grid(await runGrid(plan));
    for (const col of result.columns) {
      expect(col.sizeMm.width).toBe(col.sizeMm.depth); // square sections
      expect(col.sizeMm.width).toBeGreaterThanOrEqual(300);
      expect(col.sizeMm.width).toBeLessThanOrEqual(450);
    }
    const corner = result.columns.find((c) => c.gridRef === 'A-1')!;
    const interior = result.columns.find((c) => c.gridRef === 'C-3')!;
    // The corner carries a quarter bay, the interior a full one.
    expect(interior.sizeMm.width).toBeGreaterThan(corner.sizeMm.width);
  });

  it('frames every level, and no beam spans more than the larger bay', async () => {
    const plan = await makePlan();
    const result = grid(await runGrid(plan, { bay_width_mm: 9000, bay_depth_mm: 6000 }));

    for (const level of plan.levels) {
      const onLevel = result.beams.filter((b) => b.level === level.level);
      expect(onLevel.length, `level ${level.level} is framed`).toBeGreaterThan(0);
      expect(onLevel[0].id).toBe(`b_${level.level}_001`);
    }
    expect(result.beams.length).toBe(result.metrics.beamCount);
    expect(result.beams.length % plan.levels.length).toBe(0);

    for (const beam of result.beams) {
      // Every beam is axis-aligned and its span is the centre-to-centre distance.
      const dx = Math.abs(beam.end[0] - beam.start[0]);
      const dy = Math.abs(beam.end[1] - beam.start[1]);
      expect(dx === 0 || dy === 0).toBe(true);
      expect(beam.spanMm).toBe(dx + dy);
      expect(beam.spanMm).toBeLessThanOrEqual(9000);
      expect(beam.depthMm).toBe(Math.round(beam.spanMm / 20 / 25) * 25); // steel: span/20
    }
    expect(result.metrics.maxSpanMm).toBe(Math.max(...result.beams.map((b) => b.spanMm)));
    expect(result.metrics.maxSpanMm).toBeLessThanOrEqual(9000);
  });

  it('a smaller bay_width_mm yields more columns and more steel', async () => {
    const plan = await makePlan();
    const wide = grid(await runGrid(plan, { bay_width_mm: 12000 }));
    const tight = grid(await runGrid(plan, { bay_width_mm: 5000 }));

    expect(tight.metrics.columnCount).toBeGreaterThan(wide.metrics.columnCount);
    expect(tight.metrics.beamCount).toBeGreaterThan(wide.metrics.beamCount);
    expect(tight.metrics.steelTonnes).toBeGreaterThan(wide.metrics.steelTonnes);
    // Shorter spans need shallower beams and a thinner deck.
    expect(tight.metrics.maxSpanMm).toBeLessThan(wide.metrics.maxSpanMm);
    expect(tight.metrics.slabDepthMm).toBeLessThan(wide.metrics.slabDepthMm);
  });

  it('a bigger site from the brief pushes more grid onto the plan', async () => {
    const small = grid(await runGrid(await makePlan()));
    const big = grid(await runGrid(await makePlan({ site_width_m: 72, site_depth_m: 48 })));
    expect(big.metrics.columnCount).toBeGreaterThan(small.metrics.columnCount);
  });

  it('each system changes slab depth, steel tonnage and the carbon sign', async () => {
    const plan = await makePlan();
    const steel = grid(await runGrid(plan, { system: 'steel_frame' }));
    const concrete = grid(await runGrid(plan, { system: 'concrete_flat_slab' }));
    const timber = grid(await runGrid(plan, { system: 'timber_clt' }));

    // maxSpan 7 500 mm: deck 7 500/50, flat slab 7 500/28, CLT panel 7 500/30.
    expect(steel.metrics.slabDepthMm).toBe(150);
    expect(concrete.metrics.slabDepthMm).toBe(275);
    expect(timber.metrics.slabDepthMm).toBe(250);

    // Steel is the whole frame; the others are reinforcement/fixings only.
    expect(steel.metrics.steelTonnes).toBeGreaterThan(concrete.metrics.steelTonnes);
    expect(concrete.metrics.steelTonnes).toBeGreaterThan(timber.metrics.steelTonnes);
    expect(steel.metrics.steelTonnes).toBe(
      Math.round((48 * 6 * 0.85 + 492 * 0.42) * 100) / 100,
    );

    // Carbon: steel from tonnage, concrete from slab volume, CLT sequesters.
    expect(steel.metrics.embodiedCarbonKgCo2e).toBe(
      Math.round(steel.metrics.steelTonnes * 1850 * 100) / 100,
    );
    expect(concrete.metrics.embodiedCarbonKgCo2e).toBeGreaterThan(0);
    expect(concrete.metrics.embodiedCarbonKgCo2e).toBeLessThan(
      steel.metrics.embodiedCarbonKgCo2e,
    );
    expect(timber.metrics.embodiedCarbonKgCo2e).toBeLessThan(0);

    // Column sections move with the system too.
    const size = (g: StructuralGridResult): number =>
      g.columns.find((c) => c.gridRef === 'C-3')!.sizeMm.width;
    expect(size(concrete)).toBeGreaterThan(size(steel));
    expect(size(timber)).toBeGreaterThan(size(steel));
  });

  it('the columns table agrees with the column array', async () => {
    const plan = await makePlan();
    const run = await runGrid(plan);
    const result = grid(run);
    const table = run.outputs.columns as unknown as TableValue;

    expect(table.columns.map((c) => c.id)).toEqual([
      'id',
      'grid_ref',
      'x_mm',
      'y_mm',
      'size_mm',
      'levels',
    ]);
    expect(table.columns.every((c) => typeof c.label === 'string')).toBe(true);
    expect(table.rows.length).toBe(result.columns.length);
    result.columns.forEach((col, i) => {
      expect(table.rows[i]).toEqual({
        id: col.id,
        grid_ref: col.gridRef,
        x_mm: col.position[0],
        y_mm: col.position[1],
        size_mm: `${col.sizeMm.width} × ${col.sizeMm.depth}`,
        levels: col.levels.length,
      });
    });
  });

  it('is deterministic, and the seed only moves the id and the jitter', async () => {
    const plan = await makePlan();
    const a = grid(await runGrid(plan));
    const b = grid(await runGrid(plan));
    expect(a).toEqual(b);

    const other = grid(await runGrid(plan, { seed: 99 }));
    expect(other.gridId).not.toBe(a.gridId);
    expect(other.columns.map((c) => c.position)).toEqual(a.columns.map((c) => c.position));
    expect(other.beams).toEqual(a.beams);
  });

  it('refuses a plan with no levels', async () => {
    const plan = await makePlan();
    await expect(runGrid({ ...plan, levels: [] })).rejects.toThrow(/no levels/);
  });
});
