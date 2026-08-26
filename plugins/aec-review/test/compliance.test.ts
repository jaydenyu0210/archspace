/**
 * aec.review.code_compliance: geometry-driven IBC findings react to upstream
 * params, severities land where the rules say, and the findings table agrees
 * with the result beside it. Ported from the nodes-core suite the node left
 * behind when it moved to this plugin (ADR-0008).
 */
import { describe, expect, it } from 'vitest';
import { runNode, type RunNodeResult } from '@archspace/node-sdk/testkit';
import { toValue } from '@archspace/nodes-core/util';
import type {
  ComplianceReviewResult,
  FloorPlanResult,
  TableValue,
} from '@archspace/nodes-core/shapes';
import { codeComplianceReviewNode } from '../src/compliance-review.js';
import { buildPlan, SMALL_BRIEF, type PlanFixture } from './fixtures.js';

/** IFC GUIDs are 22 characters of the IFC base64 alphabet. */
const GUID_RE = /^[0-9A-Za-z_$]{22}$/;

async function review(
  fixture: PlanFixture,
  params: Record<string, unknown> = {},
  options: { withBim?: boolean; withModel?: boolean } = {},
): Promise<RunNodeResult<unknown>> {
  return runNode(codeComplianceReviewNode, {
    params: { mock_latency_ms: 0, ...params },
    inputs: {
      floor_plan: fixture.planValue,
      bim_summary: options.withBim === false ? undefined : fixture.bimSummaryValue,
      model: options.withModel === true ? fixture.modelValue : undefined,
    },
    assets: fixture.assets,
  });
}

function result(run: RunNodeResult<unknown>): ComplianceReviewResult {
  return run.outputs.result as unknown as ComplianceReviewResult;
}

describe('aec.review.code_compliance', () => {
  it('reports its engine, standard and the code version it was asked for', async () => {
    const run = await review(await buildPlan(SMALL_BRIEF), { code_version: 'IBC 2021' });
    const res = result(run);
    expect(res.discipline).toBe('code');
    expect(res.engine).toEqual({ name: 'mock-code-review', version: '1.0.0' });
    expect(res.standard).toEqual({ name: 'IBC', version: 'IBC 2021' });
    expect(res.code).toEqual({ jurisdiction: 'IBC', version: 'IBC 2021' });
    expect(run.progress.at(-1)).toEqual({ fraction: 1, message: 'review complete' });
  });

  it('default upstream params produce zero door/corridor violations', async () => {
    const run = await review(await buildPlan());
    const res = result(run);
    const bad = res.findings.filter(
      (f) => f.severity === 'violation' && (f.ruleId === 'IBC-1010.1.1' || f.ruleId === 'IBC-1020.3'),
    );
    expect(bad).toEqual([]);
    expect(res.summary.checked).toBeGreaterThan(0);
    expect(res.summary.passed).toBe(res.summary.checked - res.findings.length);
  });

  it('enumerates every finding on the small scheme: one warning per 900 mm door', async () => {
    const fixture = await buildPlan(SMALL_BRIEF);
    const res = result(await review(fixture));
    const level = fixture.plan.levels[0];
    expect(fixture.plan.levels).toHaveLength(1);
    expect(level.doors).toHaveLength(6);
    expect(level.doors.every((d) => d.widthMm === 900)).toBe(true);

    // 900 mm clears the 813 mm minimum but not the 914 mm accessible-egress
    // recommendation, so every door warns and nothing else fires.
    expect(res.summary).toEqual({
      checked: 20,
      passed: 14,
      advisories: 0,
      warnings: 6,
      violations: 0,
    });
    expect(res.findings.map((f) => f.id)).toEqual(['f_001', 'f_002', 'f_003', 'f_004', 'f_005', 'f_006']);
    expect(res.findings.map((f) => f.ruleId)).toEqual(Array(6).fill('IBC-1010.1.1'));
    expect(res.findings.map((f) => f.severity)).toEqual(Array(6).fill('warning'));
    expect(res.findings.map((f) => f.elementIds)).toEqual(level.doors.map((d) => [d.id]));
    expect(res.findings.every((f) => f.discipline === 'code')).toBe(true);
    expect(res.findings.every((f) => f.level === 0)).toBe(true);
  });

  it('door_width_mm 800 raises an IBC-1010.1.1 violation naming a door', async () => {
    const run = await review(await buildPlan(SMALL_BRIEF, { door_width_mm: 800 }));
    const violations = result(run).findings.filter(
      (f) => f.ruleId === 'IBC-1010.1.1' && f.severity === 'violation',
    );
    expect(violations).toHaveLength(6);
    expect(violations[0].title).toBe('Door clear width');
    expect(violations[0].message).toMatch(/d_\d+_\d+/);
    expect(violations[0].message).toContain('800');
    expect(violations[0].message).toContain('813');
    // The whole door population moved from warning to violation.
    expect(result(run).summary.warnings).toBe(0);
    expect(result(run).summary.violations).toBe(6);
  });

  it('clears the door rule entirely once every leaf is wider than 914 mm', async () => {
    const res = result(await review(await buildPlan(SMALL_BRIEF, { door_width_mm: 915 })));
    expect(res.findings).toEqual([]);
    expect(res.summary).toEqual({
      checked: 20,
      passed: 20,
      advisories: 0,
      warnings: 0,
      violations: 0,
    });
  });

  it('corridor_width_mm 1000 with enough occupants raises an IBC-1020.3 violation', async () => {
    const run = await review(await buildPlan({}, { corridor_width_mm: 1000 }));
    const violations = result(run).findings.filter(
      (f) => f.ruleId === 'IBC-1020.3' && f.severity === 'violation',
    );
    expect(violations.length).toBeGreaterThan(0);
    expect(violations[0].message).toContain('1000');
    expect(violations[0].message).toContain('1120');
    // One per storey of the six-storey default scheme, each naming its corridor.
    expect(violations).toHaveLength(6);
    expect(violations.map((f) => f.level)).toEqual([0, 1, 2, 3, 4, 5]);
    expect(violations.map((f) => f.elementIds)).toEqual(
      [0, 1, 2, 3, 4, 5].map((level) => [`r_${level}_0`]),
    );
  });

  it('leaves the corridor rule alone when the occupant load stays under 50', async () => {
    // Same 1000 mm corridor, one small storey: the rule is load-gated, not a
    // bare width check.
    const res = result(await review(await buildPlan(SMALL_BRIEF, { corridor_width_mm: 1000 })));
    expect(res.findings.filter((f) => f.ruleId === 'IBC-1020.3')).toEqual([]);
  });

  it('flags a storey over 49 occupants with fewer than two exits', async () => {
    const wide = await buildPlan({
      floors: 1,
      site_width_m: 300,
      site_depth_m: 40,
      target_gross_area_m2: 4000,
    });
    expect(wide.plan.levels[0].exits).toHaveLength(1);
    const res = result(await review(wide));
    const exits = res.findings.filter((f) => f.ruleId === 'IBC-1006.3.2');
    expect(exits).toHaveLength(1);
    expect(exits[0].severity).toBe('violation');
    expect(exits[0].title).toBe('Exits per storey');
    expect(exits[0].message).toContain('only 1 exit(s)');
    expect(exits[0].message).toContain('at least 2 exits are required');
    expect(exits[0].elementIds).toEqual(['x_0_0']);

    // The same plan puts rooms past the 61 m sprinkler-confirmation distance
    // but inside the 91 m maximum — warnings, not violations.
    const travel = res.findings.filter((f) => f.ruleId === 'IBC-1017.2');
    expect(travel.length).toBeGreaterThan(0);
    expect(travel.every((f) => f.severity === 'warning')).toBe(true);
    for (const finding of travel) {
      const metres = Number(/is ([\d.]+) m from/.exec(finding.message)?.[1]);
      expect(metres).toBeGreaterThan(61);
      expect(metres).toBeLessThanOrEqual(91);
    }
  });

  it('flags a habitable room under 7 m², and exempts service and circulation', async () => {
    const fixture = await buildPlan(SMALL_BRIEF);
    // Derived from a real generated plan rather than a literal: only the two
    // areas under test are changed, everything else is what the layout backend
    // actually produced.
    const shrink = (ids: Record<string, number>): FloorPlanResult => ({
      ...fixture.plan,
      levels: fixture.plan.levels.map((level) => ({
        ...level,
        rooms: level.rooms.map((room) =>
          room.id in ids ? { ...room, areaM2: ids[room.id] } : room,
        ),
      })),
    });

    const meeting = fixture.plan.levels[0].rooms.find((r) => r.function === 'meeting');
    const service = fixture.plan.levels[0].rooms.find((r) => r.function === 'service');
    const corridor = fixture.plan.levels[0].rooms.find((r) => r.function === 'circulation');
    expect(meeting && service && corridor).toBeTruthy();

    const run = await runNode(codeComplianceReviewNode, {
      params: { mock_latency_ms: 0 },
      inputs: {
        floor_plan: toValue(shrink({ [meeting!.id]: 5.5, [service!.id]: 2, [corridor!.id]: 1 })),
        bim_summary: fixture.bimSummaryValue,
      },
      assets: fixture.assets,
    });
    const tiny = result(run).findings.filter((f) => f.ruleId === 'IBC-1207.3');
    expect(tiny).toHaveLength(1);
    expect(tiny[0].severity).toBe('violation');
    expect(tiny[0].elementIds).toEqual([meeting!.id]);
    expect(tiny[0].message).toContain('5.5 m²');
    expect(tiny[0].message).toContain('at least 7 m²');
  });

  it('raises the efficiency advisory only when advisories are switched on', async () => {
    // A 4 m corridor on a 12 m deep site drops net-to-gross under 0.6.
    const fat = await buildPlan(SMALL_BRIEF, { corridor_width_mm: 4000 });
    expect(fat.plan.metrics.efficiency).toBeLessThan(0.6);

    const on = result(await review(fat));
    const advisory = on.findings.filter((f) => f.ruleId === 'AEC-EFF-1');
    expect(advisory).toHaveLength(1);
    expect(advisory[0].severity).toBe('advisory');
    expect(advisory[0].level).toBeNull();
    expect(advisory[0].elementIds).toEqual([]);
    expect(advisory[0].message).toContain(String(fat.plan.metrics.efficiency));
    expect(on.summary.checked).toBe(20);
    expect(on.summary.advisories).toBe(1);

    const off = result(await review(fat, { include_advisory: false }));
    expect(off.findings.filter((f) => f.ruleId === 'AEC-EFF-1')).toEqual([]);
    // The check itself is no longer run, so `checked` drops with it.
    expect(off.summary.checked).toBe(19);
    expect(off.summary.advisories).toBe(0);
  });

  it('findings table row count and columns match result.findings', async () => {
    const run = await review(await buildPlan(SMALL_BRIEF, { door_width_mm: 800 }));
    const res = result(run);
    const table = run.outputs.findings as unknown as TableValue;
    expect(table.rows.length).toBe(res.findings.length);
    expect(table.columns.map((c) => c.id)).toEqual([
      'id',
      'rule_id',
      'severity',
      'title',
      'level',
      'elements',
      'message',
    ]);
    // Guard the loop below: without this the mirror assertions are vacuous
    // the moment the fixture stops producing findings.
    expect(res.findings.length).toBeGreaterThan(0);
    res.findings.forEach((f, i) => {
      expect(table.rows[i].id).toBe(f.id);
      expect(table.rows[i].rule_id).toBe(f.ruleId);
      expect(table.rows[i].severity).toBe(f.severity);
      expect(table.rows[i].level).toBe(f.level);
      expect(table.rows[i].message).toBe(f.message);
      expect(table.rows[i].elements).toBe(f.elementIds.join(', '));
    });
  });

  it('attaches IFC guids to findings when bim_summary is present', async () => {
    const fixture = await buildPlan(SMALL_BRIEF, { door_width_mm: 800 });
    const violation = result(await review(fixture)).findings.find(
      (f) => f.ruleId === 'IBC-1010.1.1' && f.severity === 'violation',
    );
    expect(violation).toBeDefined();
    expect(violation!.elementGuids.length).toBeGreaterThan(0);
    for (const guid of violation!.elementGuids) expect(guid).toMatch(GUID_RE);
    // The guid is the one the BIM node minted for that very door.
    const doorGuid = fixture.bimSummary.doors.find((d) => d.doorId === violation!.elementIds[0]);
    expect(violation!.elementGuids).toEqual([doorGuid!.guid]);
  });

  it('reviews plan geometry alone when no IFC file is wired, and says so', async () => {
    const fixture = await buildPlan(SMALL_BRIEF, { door_width_mm: 800 });
    const without = await review(fixture, {}, { withBim: false });
    expect(result(without).findings.every((f) => f.elementGuids.length === 0)).toBe(true);
    expect(without.logs).toContainEqual({
      level: 'info',
      message: 'reviewing without the IFC file — plan geometry and BIM summary only',
    });

    const withModel = await review(fixture, {}, { withModel: true });
    expect(withModel.logs).toEqual([]);
  });

  it('refuses to review without a floor plan', async () => {
    await expect(
      runNode(codeComplianceReviewNode, { params: { mock_latency_ms: 0 }, inputs: {} }),
    ).rejects.toThrow('aec.review.code_compliance: required input "floor_plan" is missing');
  });
});
