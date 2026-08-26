/**
 * aec.review.accessibility: A117.1 clear widths, turning space and accessible
 * egress measured off the generated plan — including the cases where this
 * review deliberately disagrees with the IBC one about the same door.
 */
import { describe, expect, it } from 'vitest';
import { runNode, type RunNodeResult } from '@archspace/node-sdk/testkit';
import { toValue } from '@archspace/nodes-core/util';
import type { FloorPlanResult, PlanRoom, ReviewResult, TableValue } from '@archspace/nodes-core/shapes';
import { accessibilityReviewNode } from '../src/accessibility-review.js';
import { codeComplianceReviewNode } from '../src/compliance-review.js';
import { buildPlan, SMALL_BRIEF, type PlanFixture } from './fixtures.js';

/** Recomputed here rather than imported: the test must not share the node's arithmetic. */
function minBboxDimension(room: PlanRoom): number {
  const xs = room.polygon.map(([x]) => x);
  const ys = room.polygon.map(([, y]) => y);
  return Math.min(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys));
}

async function review(
  fixture: PlanFixture,
  params: Record<string, unknown> = {},
  options: { withBim?: boolean } = {},
): Promise<RunNodeResult<unknown>> {
  return runNode(accessibilityReviewNode, {
    params: { mock_latency_ms: 0, ...params },
    inputs: {
      floor_plan: fixture.planValue,
      bim_summary: options.withBim === false ? undefined : fixture.bimSummaryValue,
    },
    assets: fixture.assets,
  });
}

function result(run: RunNodeResult<unknown>): ReviewResult {
  return run.outputs.result as unknown as ReviewResult;
}

const TWO_STOREY: Record<string, unknown> = { ...SMALL_BRIEF, floors: 2, target_gross_area_m2: 300 };

describe('aec.review.accessibility', () => {
  it('reports its engine, the standard version asked for, and a coherent summary', async () => {
    const run = await review(await buildPlan(SMALL_BRIEF), { standard_version: '2009' });
    const res = result(run);
    expect(res.discipline).toBe('accessibility');
    expect(res.engine).toEqual({ name: 'mock-accessibility-review', version: '1.0.0' });
    expect(res.standard).toEqual({ name: 'ANSI A117.1', version: '2009' });
    expect(res.summary.passed).toBe(res.summary.checked - res.findings.length);
    expect(run.progress.at(-1)).toEqual({ fraction: 1, message: 'review complete' });
  });

  it('enumerates every finding on the small scheme: one warning per 900 mm door', async () => {
    const fixture = await buildPlan(SMALL_BRIEF);
    const res = result(await review(fixture));
    const level = fixture.plan.levels[0];

    // 6 turning-space checks + 6 doors + 1 accessible route = 13.
    expect(res.summary).toEqual({
      checked: 13,
      passed: 7,
      advisories: 0,
      warnings: 6,
      violations: 0,
    });
    expect(res.findings.map((f) => f.ruleId)).toEqual(Array(6).fill('A117-404.2.3'));
    expect(res.findings.map((f) => f.severity)).toEqual(Array(6).fill('warning'));
    expect(res.findings.map((f) => f.elementIds)).toEqual(level.doors.map((d) => [d.id]));
    expect(res.findings.every((f) => f.discipline === 'accessibility')).toBe(true);
    expect(res.findings[0].message).toContain('900 mm');
    expect(res.findings[0].message).toContain('915 mm is recommended');
  });

  it('treats the door width threshold as a param, because jurisdictions differ', async () => {
    const fixture = await buildPlan(SMALL_BRIEF);
    const strict = result(await review(fixture, { min_door_clear_mm: 1000 }));
    expect(strict.summary.violations).toBe(6);
    expect(strict.summary.warnings).toBe(0);
    expect(strict.findings[0].message).toContain('at least 1000 mm is required');

    const lenient = result(await review(await buildPlan(SMALL_BRIEF, { door_width_mm: 915 })));
    expect(lenient.findings.filter((f) => f.ruleId === 'A117-404.2.3')).toEqual([]);
  });

  it('calls an 814 mm door a violation where the IBC review only warns', async () => {
    // The two reviews are supposed to disagree on the same plan: 814 mm clears
    // the 813 mm IBC egress minimum but not the 815 mm A117 clear width.
    const fixture = await buildPlan(SMALL_BRIEF, { door_width_mm: 814 });
    const access = result(await review(fixture));
    const code = await runNode(codeComplianceReviewNode, {
      params: { mock_latency_ms: 0 },
      inputs: { floor_plan: fixture.planValue, bim_summary: fixture.bimSummaryValue },
      assets: fixture.assets,
    });
    const codeRes = code.outputs.result as unknown as ReviewResult;

    expect(access.findings.filter((f) => f.ruleId === 'A117-404.2.3' && f.severity === 'violation'))
      .toHaveLength(6);
    expect(codeRes.findings.filter((f) => f.ruleId === 'IBC-1010.1.1' && f.severity === 'warning'))
      .toHaveLength(6);
    expect(codeRes.summary.violations).toBe(0);
  });

  it('grades the accessible route by its own clear width', async () => {
    const wide = result(await review(await buildPlan(SMALL_BRIEF)));
    expect(wide.findings.filter((f) => f.ruleId === 'A117-403.5')).toEqual([]);

    const passing = result(await review(await buildPlan(SMALL_BRIEF, { corridor_width_mm: 1000 })));
    const warned = passing.findings.filter((f) => f.ruleId === 'A117-403.5');
    expect(warned).toHaveLength(1);
    expect(warned[0].severity).toBe('warning');
    expect(warned[0].message).toContain('1000 mm');
    expect(warned[0].message).toContain('1120 mm is recommended');

    const narrow = result(await review(await buildPlan(SMALL_BRIEF, { corridor_width_mm: 600 })));
    const blocked = narrow.findings.filter((f) => f.ruleId === 'A117-403.5');
    expect(blocked).toHaveLength(1);
    expect(blocked[0].severity).toBe('violation');
    expect(blocked[0].elementIds).toEqual(['r_0_0']);
    expect(blocked[0].message).toContain('at least 915 mm');
  });

  it('flags exactly the rooms with no room to turn a wheelchair around', async () => {
    const fixture = await buildPlan(SMALL_BRIEF, { corridor_width_mm: 600 });
    const res = result(await review(fixture));
    const level = fixture.plan.levels[0];

    // Independently recomputed: every occupiable room under 1525 mm in its
    // narrow direction, and no others.
    const expected = level.rooms
      .filter((r) => r.function !== 'circulation' && minBboxDimension(r) < 1525)
      .map((r) => r.id);
    expect(expected.length).toBeGreaterThan(0);
    const flagged = res.findings.filter((f) => f.ruleId === 'A117-304.3');
    expect(flagged.map((f) => f.elementIds[0])).toEqual(expected);
    expect(flagged.every((f) => f.severity === 'violation')).toBe(true);
    expect(flagged[0].message).toContain(`${minBboxDimension(level.rooms.find((r) => r.id === expected[0])!)} mm`);
    expect(flagged[0].message).toContain('1525 mm turning space is required');
  });

  it('requires an accessible means of egress from every storey above grade', async () => {
    const fixture = await buildPlan(TWO_STOREY);
    // As generated, every exit is a stair, so the rule passes.
    expect(fixture.plan.levels.every((l) => l.exits.some((x) => x.kind === 'stair'))).toBe(true);
    expect(result(await review(fixture)).findings.filter((f) => f.ruleId === 'A117-206.2.4')).toEqual([]);

    // Derived from that real plan: turn every stair into a plain door.
    const doorsOnly: FloorPlanResult = {
      ...fixture.plan,
      levels: fixture.plan.levels.map((level) => ({
        ...level,
        exits: level.exits.map((exit) => ({ ...exit, kind: 'door' as const })),
      })),
    };
    const run = await runNode(accessibilityReviewNode, {
      params: { mock_latency_ms: 0 },
      inputs: { floor_plan: toValue(doorsOnly) },
    });
    const flagged = result(run).findings.filter((f) => f.ruleId === 'A117-206.2.4');
    // Level 0 is at grade and exempt; level 1 is not.
    expect(flagged).toHaveLength(1);
    expect(flagged[0].level).toBe(1);
    expect(flagged[0].severity).toBe('violation');
    expect(flagged[0].elementIds).toEqual(doorsOnly.levels[1].exits.map((x) => x.id));
  });

  it('advises on the vertical route only for multi-storey schemes, and only when asked', async () => {
    const single = result(await review(await buildPlan(SMALL_BRIEF)));
    expect(single.findings.filter((f) => f.ruleId === 'A117-206.2')).toEqual([]);

    const two = await buildPlan(TWO_STOREY);
    const on = result(await review(two));
    const advisory = on.findings.filter((f) => f.ruleId === 'A117-206.2');
    expect(advisory).toHaveLength(1);
    expect(advisory[0].severity).toBe('advisory');
    expect(advisory[0].level).toBeNull();
    expect(advisory[0].message).toContain('2-storey plan');

    const off = result(await review(two, { include_advisory: false }));
    expect(off.findings.filter((f) => f.ruleId === 'A117-206.2')).toEqual([]);
    expect(off.summary.checked).toBe(on.summary.checked - 1);
  });

  it('carries plan ids but no GUIDs when no BIM summary is wired, and says so', async () => {
    const fixture = await buildPlan(SMALL_BRIEF);
    const withBim = result(await review(fixture));
    expect(withBim.findings.every((f) => f.elementGuids.length === 1)).toBe(true);

    const run = await review(fixture, {}, { withBim: false });
    expect(result(run).findings.every((f) => f.elementGuids.length === 0)).toBe(true);
    expect(result(run).findings.every((f) => f.elementIds.length === 1)).toBe(true);
    expect(run.logs).toContainEqual({
      level: 'info',
      message: 'no BIM summary supplied — findings will carry plan ids but no IFC GUIDs',
    });
  });

  it('emits a findings table that mirrors the result row for row', async () => {
    const run = await review(await buildPlan(SMALL_BRIEF, { corridor_width_mm: 600 }));
    const res = result(run);
    const table = run.outputs.findings as unknown as TableValue;
    expect(table.columns.map((c) => c.id)).toEqual([
      'id',
      'rule_id',
      'severity',
      'title',
      'level',
      'elements',
      'message',
    ]);
    expect(table.rows).toHaveLength(res.findings.length);
    // Guard the loop below: without this the mirror assertions are vacuous
    // the moment the fixture stops producing findings.
    expect(res.findings.length).toBeGreaterThan(0);
    res.findings.forEach((f, i) => {
      expect(table.rows[i].id).toBe(f.id);
      expect(table.rows[i].rule_id).toBe(f.ruleId);
      expect(table.rows[i].elements).toBe(f.elementIds.join(', '));
    });
  });

  it('refuses to review without a floor plan', async () => {
    await expect(
      runNode(accessibilityReviewNode, { params: { mock_latency_ms: 0 }, inputs: {} }),
    ).rejects.toThrow('aec.review.accessibility: required input "floor_plan" is missing');
  });
});
