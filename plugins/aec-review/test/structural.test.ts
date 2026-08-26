/**
 * aec.review.structural: beam spans, column/room and column/door conflicts and
 * bay proportion, all measured against the grid and plan the generators
 * actually produced — one finding per column, never one per storey.
 */
import { describe, expect, it } from 'vitest';
import type { Value } from '@archspace/node-sdk';
import { runNode, type RunNodeResult } from '@archspace/node-sdk/testkit';
import type { GridBeam, ReviewResult, TableValue } from '@archspace/nodes-core/shapes';
import { structuralReviewNode } from '../src/structural-review.js';
import { buildGrid, buildPlan, SMALL_BRIEF } from './fixtures.js';

async function review(
  gridValue: Value,
  planValue: Value,
  params: Record<string, unknown> = {},
): Promise<RunNodeResult<unknown>> {
  return runNode(structuralReviewNode, {
    params: { mock_latency_ms: 0, ...params },
    inputs: { grid: gridValue, floor_plan: planValue },
  });
}

function result(run: RunNodeResult<unknown>): ReviewResult {
  return run.outputs.result as unknown as ReviewResult;
}

function rule(res: ReviewResult, ruleId: string) {
  return res.findings.filter((f) => f.ruleId === ruleId);
}

/** A long thin bay: 3:1, well past the 1.5 the node advises on. */
const THIN_BAY: Record<string, unknown> = { bay_width_mm: 12000, bay_depth_mm: 4000 };

describe('aec.review.structural', () => {
  it('reports its engine, the standard version asked for, and a coherent summary', async () => {
    const fixture = await buildPlan(SMALL_BRIEF);
    const grid = await buildGrid(fixture.planValue);
    const run = await review(grid.gridValue, fixture.planValue, { standard_version: '2016' });
    const res = result(run);

    expect(res.discipline).toBe('structural');
    expect(res.engine).toEqual({ name: 'mock-structural-review', version: '1.0.0' });
    expect(res.standard).toEqual({ name: 'AISC/ACI concept check', version: '2016' });
    expect(res.summary.passed).toBe(res.summary.checked - res.findings.length);
    // Every beam, then every column twice (room clash and door clearance),
    // then the bay proportion.
    expect(res.summary.checked).toBe(grid.grid.beams.length + grid.grid.columns.length * 2 + 1);
    // No BIM summary reaches this node, so findings carry plan ids only.
    expect(res.findings.every((f) => f.elementGuids.length === 0)).toBe(true);
    expect(res.findings.every((f) => f.discipline === 'structural')).toBe(true);
    expect(run.progress.at(-1)).toEqual({ fraction: 1, message: 'review complete' });
  });

  it('grades every beam against the limit in use: over it, near it, or silent', async () => {
    const fixture = await buildPlan(SMALL_BRIEF);
    const grid = await buildGrid(fixture.planValue, THIN_BAY);
    const maxSpanMm = 9000;
    const nearLimitMm = maxSpanMm * 0.85;
    const over = grid.grid.beams.filter((b) => b.spanMm > maxSpanMm);
    const near = grid.grid.beams.filter((b) => b.spanMm <= maxSpanMm && b.spanMm >= nearLimitMm);
    const clear = grid.grid.beams.filter((b) => b.spanMm < nearLimitMm);
    expect([over.length, near.length, clear.length].every((n) => n > 0)).toBe(true);

    const res = result(await review(grid.gridValue, fixture.planValue, { max_span_mm: maxSpanMm }));

    const violations = rule(res, 'STR-SPAN-1');
    expect(violations.map((f) => f.elementIds[0])).toEqual(over.map((b: GridBeam) => b.id));
    expect(violations.every((f) => f.severity === 'violation')).toBe(true);
    expect(violations[0].message).toContain(`spans ${over[0].spanMm} mm`);
    expect(violations[0].message).toContain(`limit in use is ${maxSpanMm} mm`);
    expect(violations[0].level).toBe(over[0].level);

    const warnings = rule(res, 'STR-SPAN-2');
    expect(warnings.map((f) => f.elementIds[0])).toEqual(near.map((b: GridBeam) => b.id));
    expect(warnings.every((f) => f.severity === 'warning')).toBe(true);
    expect(warnings[0].message).toContain(`within 15% of the ${maxSpanMm} mm limit (${nearLimitMm} mm)`);
    expect(warnings[0].message).toContain(`${near[0].depthMm} mm deep`);

    const flagged = new Set([...violations, ...warnings].map((f) => f.elementIds[0]));
    for (const beam of clear) expect(flagged.has(beam.id)).toBe(false);
  });

  it('raising the limit clears the span rules without touching the others', async () => {
    const fixture = await buildPlan(SMALL_BRIEF);
    const grid = await buildGrid(fixture.planValue, THIN_BAY);
    const tight = result(await review(grid.gridValue, fixture.planValue, { max_span_mm: 9000 }));
    const loose = result(await review(grid.gridValue, fixture.planValue, { max_span_mm: 20000 }));

    expect(rule(tight, 'STR-SPAN-1').length).toBeGreaterThan(0);
    expect(rule(loose, 'STR-SPAN-1')).toEqual([]);
    expect(rule(loose, 'STR-SPAN-2')).toEqual([]);
    expect(rule(loose, 'STR-COL-1').map((f) => f.elementIds)).toEqual(
      rule(tight, 'STR-COL-1').map((f) => f.elementIds),
    );
    // `checked` is a property of the grid, not of the threshold.
    expect(loose.summary.checked).toBe(tight.summary.checked);
  });

  it('reports a column standing inside a small room once, naming both', async () => {
    const fixture = await buildPlan(SMALL_BRIEF);
    const grid = await buildGrid(fixture.planValue);
    const res = result(await review(grid.gridValue, fixture.planValue));

    const clashes = rule(res, 'STR-COL-1');
    expect(clashes.length).toBeGreaterThan(0);
    expect(clashes.every((f) => f.severity === 'violation')).toBe(true);
    // One finding per column, never one per storey the column passes through.
    const columnIds = clashes.map((f) => f.elementIds[0]);
    expect(new Set(columnIds).size).toBe(columnIds.length);

    for (const finding of clashes) {
      const [columnId, roomId] = finding.elementIds;
      const column = grid.grid.columns.find((c) => c.id === columnId);
      const level = fixture.plan.levels.find((l) => l.level === finding.level);
      const room = level!.rooms.find((r) => r.id === roomId);
      expect(column && room).toBeTruthy();
      expect(room!.areaM2).toBeLessThan(20);
      expect(room!.function).not.toBe('circulation');
      expect(finding.message).toContain(`grid ${column!.gridRef}`);
      expect(finding.message).toContain(`${room!.areaM2} m²`);
      expect(finding.message).toContain('rooms under 20 m² cannot absorb a column');
    }
  });

  it('warns about a column crowding a door, quoting the measured clearance', async () => {
    // The default six-storey scheme is the one whose grid lands near doors.
    const fixture = await buildPlan();
    const grid = await buildGrid(fixture.planValue);
    const res = result(await review(grid.gridValue, fixture.planValue));

    const crowded = rule(res, 'STR-COL-2');
    expect(crowded.length).toBeGreaterThan(0);
    expect(crowded.every((f) => f.severity === 'warning')).toBe(true);
    const columnIds = crowded.map((f) => f.elementIds[0]);
    expect(new Set(columnIds).size).toBe(columnIds.length);

    for (const finding of crowded) {
      const [columnId, doorId] = finding.elementIds;
      const column = grid.grid.columns.find((c) => c.id === columnId)!;
      const level = fixture.plan.levels.find((l) => l.level === finding.level)!;
      const door = level.doors.find((d) => d.id === doorId)!;
      const distanceMm = Math.hypot(
        column.position[0] - door.position[0],
        column.position[1] - door.position[1],
      );
      expect(distanceMm).toBeLessThanOrEqual(600);
      expect(finding.message).toContain(`is ${Math.round(distanceMm * 100) / 100} mm from door ${doorId}`);
      expect(finding.message).toContain('at least 600 mm of clearance is expected');
    }
  });

  it('advises on a long thin bay, and only when advisories are on', async () => {
    const fixture = await buildPlan(SMALL_BRIEF);
    const square = await buildGrid(fixture.planValue);
    expect(square.grid.bay.widthMm).toBe(square.grid.bay.depthMm);
    expect(rule(result(await review(square.gridValue, fixture.planValue)), 'STR-BAY-1')).toEqual([]);

    const thin = await buildGrid(fixture.planValue, THIN_BAY);
    const on = result(await review(thin.gridValue, fixture.planValue, { max_span_mm: 20000 }));
    const advisory = rule(on, 'STR-BAY-1');
    expect(advisory).toHaveLength(1);
    expect(advisory[0].severity).toBe('advisory');
    expect(advisory[0].level).toBeNull();
    expect(advisory[0].elementIds).toEqual([]);
    expect(advisory[0].message).toContain(
      `The ${thin.grid.bay.widthMm} × ${thin.grid.bay.depthMm} mm bay has an aspect ratio of 3`,
    );
    expect(advisory[0].message).toContain(thin.grid.system);

    const off = result(
      await review(thin.gridValue, fixture.planValue, { max_span_mm: 20000, include_advisory: false }),
    );
    expect(rule(off, 'STR-BAY-1')).toEqual([]);
    expect(off.summary.checked).toBe(on.summary.checked - 1);
  });

  it('emits a findings table that mirrors the result row for row', async () => {
    const fixture = await buildPlan(SMALL_BRIEF);
    const grid = await buildGrid(fixture.planValue, THIN_BAY);
    const run = await review(grid.gridValue, fixture.planValue, { max_span_mm: 9000 });
    const res = result(run);
    const table = run.outputs.findings as unknown as TableValue;
    expect(table.rows).toHaveLength(res.findings.length);
    expect(table.rows.length).toBeGreaterThan(4);
    res.findings.forEach((f, i) => {
      expect(table.rows[i].id).toBe(f.id);
      expect(table.rows[i].severity).toBe(f.severity);
      expect(table.rows[i].elements).toBe(f.elementIds.join(', '));
    });
  });

  it('refuses to review without a grid or without a floor plan', async () => {
    const fixture = await buildPlan(SMALL_BRIEF);
    const grid = await buildGrid(fixture.planValue);
    await expect(
      runNode(structuralReviewNode, {
        params: { mock_latency_ms: 0 },
        inputs: { floor_plan: fixture.planValue },
      }),
    ).rejects.toThrow('aec.review.structural: required input "grid" is missing');
    await expect(
      runNode(structuralReviewNode, { params: { mock_latency_ms: 0 }, inputs: { grid: grid.gridValue } }),
    ).rejects.toThrow('aec.review.structural: required input "floor_plan" is missing');
  });
});
