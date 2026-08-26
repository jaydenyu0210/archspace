/**
 * aec.review.energy_performance: the EUI is recomputed here from the node's
 * own documented coefficients and compared number for number, so a silent
 * change to the mock simulation cannot pass as a change to the plan.
 */
import { describe, expect, it } from 'vitest';
import type { Value } from '@archspace/node-sdk';
import { runNode, type RunNodeResult } from '@archspace/node-sdk/testkit';
import { toValue } from '@archspace/nodes-core/util';
import type {
  EnergyMetrics,
  FloorPlanResult,
  ReviewResult,
  TableValue,
} from '@archspace/nodes-core/shapes';
import { energyPerformanceReviewNode } from '../src/energy-review.js';
import { buildPlan, buildSite, SMALL_BRIEF, type PlanFixture } from './fixtures.js';

/** The node's MOCK COEFFICIENTS, restated so the test is an independent check. */
const CLIMATE: Record<string, { heatingWM2: number; coolingWM2: number }> = {
  '3B': { heatingWM2: 8, coolingWM2: 26 },
  '4A': { heatingWM2: 14, coolingWM2: 20 },
  '5A': { heatingWM2: 18, coolingWM2: 17 },
  '6A': { heatingWM2: 24, coolingWM2: 13 },
};
const LIGHTING_W_M2 = 9;
const EQUIPMENT_W_M2 = 12;
const EFLH = { heating: 1200, cooling: 900, lighting: 2500, equipment: 3000 };
const CARBON_KG_PER_KWH = 0.233;
const ASSUMED_STOREY_HEIGHT_M = 3.5;

const round2 = (n: number): number => Math.round(n * 100) / 100;

/** The whole simulation, worked independently of the node under test. */
function expectedMetrics(
  plan: FloorPlanResult,
  opts: { zone?: string; wwr?: number; envelopeAreaM2?: number } = {},
): Omit<EnergyMetrics, 'targetEuiKwhM2Yr' | 'byEndUse'> {
  const zone = opts.zone ?? '4A';
  const wwr = opts.wwr ?? 0.4;
  const conditionedAreaM2 = round2(
    plan.levels.flatMap((l) => l.rooms).reduce((sum, room) => sum + room.areaM2, 0),
  );
  const perimeterM = 2 * (plan.site.widthMm / 1000 + plan.site.depthMm / 1000);
  const envelopeAreaM2 =
    opts.envelopeAreaM2 ?? round2(perimeterM * plan.levels.length * ASSUMED_STOREY_HEIGHT_M);
  const penalty = 1 + Math.max(0, wwr - 0.4) * 1.5;
  const heatingKw = round2((envelopeAreaM2 * CLIMATE[zone].heatingWM2 * penalty) / 1000);
  const coolingKw = round2((envelopeAreaM2 * CLIMATE[zone].coolingWM2 * penalty) / 1000);
  const lightingKw = round2((conditionedAreaM2 * LIGHTING_W_M2) / 1000);
  const equipmentKw = round2((conditionedAreaM2 * EQUIPMENT_W_M2) / 1000);
  const annualEnergyKwh = round2(
    heatingKw * EFLH.heating +
      coolingKw * EFLH.cooling +
      lightingKw * EFLH.lighting +
      equipmentKw * EFLH.equipment,
  );
  return {
    euiKwhM2Yr: round2(annualEnergyKwh / conditionedAreaM2),
    windowToWallRatio: wwr,
    envelopeAreaM2,
    conditionedAreaM2,
    loads: { heatingKw, coolingKw, lightingKw, equipmentKw },
    annualEnergyKwh,
    carbonKgCo2eYr: round2(annualEnergyKwh * CARBON_KG_PER_KWH),
  };
}

async function review(
  fixture: PlanFixture,
  params: Record<string, unknown> = {},
  massingValue?: Value,
): Promise<RunNodeResult<unknown>> {
  return runNode(energyPerformanceReviewNode, {
    params: { mock_latency_ms: 0, ...params },
    inputs: { floor_plan: fixture.planValue, massing: massingValue },
  });
}

const result = (run: RunNodeResult<unknown>): ReviewResult =>
  run.outputs.result as unknown as ReviewResult;
const metrics = (run: RunNodeResult<unknown>): EnergyMetrics =>
  run.outputs.metrics as unknown as EnergyMetrics;
const rule = (res: ReviewResult, ruleId: string) => res.findings.filter((f) => f.ruleId === ruleId);

describe('aec.review.energy_performance', () => {
  it('reports its engine, the standard version asked for, and a coherent summary', async () => {
    const run = await review(await buildPlan(SMALL_BRIEF), { standard_version: '2019' });
    const res = result(run);
    expect(res.discipline).toBe('energy');
    expect(res.engine).toEqual({ name: 'mock-energy-review', version: '1.0.0' });
    expect(res.standard).toEqual({ name: 'ASHRAE 90.1', version: '2019' });
    expect(res.summary.passed).toBe(res.summary.checked - res.findings.length);
    // Whole-building results: nothing is anchored to an element.
    expect(res.findings.every((f) => f.elementIds.length === 0 && f.elementGuids.length === 0)).toBe(true);
    expect(res.findings.every((f) => f.discipline === 'energy' && f.level === null)).toBe(true);
    expect(run.progress.at(-1)).toEqual({
      fraction: 1,
      message: `simulation complete — ${metrics(run).euiKwhM2Yr} kWh/m²·yr`,
    });
  });

  it('estimates the envelope from the plan perimeter when no massing is wired', async () => {
    const fixture = await buildPlan(SMALL_BRIEF);
    const run = await review(fixture);
    const expected = expectedMetrics(fixture.plan);

    expect(metrics(run)).toMatchObject(expected);
    expect(metrics(run).euiKwhM2Yr).toBe(117.22);
    expect(metrics(run).envelopeAreaM2).toBe(224);
    expect(metrics(run).conditionedAreaM2).toBe(133.08);
    expect(metrics(run).targetEuiKwhM2Yr).toBe(95);
    expect(run.logs).toContainEqual({
      level: 'info',
      message: 'no massing wired — envelope estimated from the plan perimeter (64 m)',
    });
  });

  it('takes the envelope straight from the massing when one is wired', async () => {
    const fixture = await buildPlan(SMALL_BRIEF);
    const site = await buildSite(fixture.briefValue);
    const run = await review(fixture, {}, site.massingValue);

    expect(metrics(run).envelopeAreaM2).toBe(round2(site.massing.metrics.facadeAreaM2));
    expect(metrics(run)).toMatchObject(
      expectedMetrics(fixture.plan, { envelopeAreaM2: round2(site.massing.metrics.facadeAreaM2) }),
    );
    expect(run.logs).toContainEqual({
      level: 'info',
      message: `envelope from massing ${site.massing.massingId}: ${round2(site.massing.metrics.facadeAreaM2)} m² of facade`,
    });
  });

  it('splits the annual energy into end-use fractions that sum to exactly 1', async () => {
    const fixture = await buildPlan(SMALL_BRIEF);
    for (const params of [{}, { climate_zone: '3B' }, { climate_zone: '6A' }, { window_to_wall_ratio: 0.85 }]) {
      const run = await review(fixture, params);
      const byEndUse = metrics(run).byEndUse;
      expect(Object.keys(byEndUse).sort()).toEqual(['cooling', 'equipment', 'heating', 'lighting']);
      // The equipment term absorbs the rounding so the split is never 0.999.
      const total = Object.values(byEndUse).reduce((a, b) => a + b, 0);
      expect(total).toBe(1);
    }
  });

  it('lets the climate zone decide whether the building is heating or cooling dominated', async () => {
    const fixture = await buildPlan(SMALL_BRIEF);
    const hotDry = metrics(await review(fixture, { climate_zone: '3B' }));
    const cold = metrics(await review(fixture, { climate_zone: '6A' }));

    expect(hotDry.byEndUse.cooling).toBeGreaterThan(hotDry.byEndUse.heating);
    expect(cold.byEndUse.heating).toBeGreaterThan(cold.byEndUse.cooling);
    expect(hotDry.loads.coolingKw).toBeGreaterThan(cold.loads.coolingKw);
    expect(cold.loads.heatingKw).toBeGreaterThan(hotDry.loads.heatingKw);
    // Lighting and equipment are floor-area loads and do not move with climate.
    expect(hotDry.loads.lightingKw).toBe(cold.loads.lightingKw);
    expect(hotDry.loads.equipmentKw).toBe(cold.loads.equipmentKw);
  });

  it('grades the EUI against the target with a 15% tolerance band', async () => {
    const fixture = await buildPlan(SMALL_BRIEF);
    const eui = metrics(await review(fixture)).euiKwhM2Yr;

    const met = result(await review(fixture, { target_eui_kwh_m2_yr: 150 }));
    expect(rule(met, 'ASH-EUI-1')).toEqual([]);

    // 117.22 over a 110 target is 6.6% over — inside the tolerance.
    const warned = result(await review(fixture, { target_eui_kwh_m2_yr: 110 }));
    const warning = rule(warned, 'ASH-EUI-1');
    expect(warning).toHaveLength(1);
    expect(warning[0].severity).toBe('warning');
    expect(warning[0].message).toContain(`${round2(eui - 110)} over, within the 15% tolerance`);

    const failed = result(await review(fixture, { target_eui_kwh_m2_yr: 95 }));
    const violation = rule(failed, 'ASH-EUI-1');
    expect(violation).toHaveLength(1);
    expect(violation[0].severity).toBe('violation');
    expect(violation[0].message).toContain(`Modelled EUI is ${eui} kWh/m²·yr`);
    expect(violation[0].message).toContain(`the 15% tolerance (${round2(95 * 1.15)}) is exceeded`);
  });

  it('penalises glazing above the prescriptive ratio, in the findings and in the loads', async () => {
    const fixture = await buildPlan(SMALL_BRIEF);
    const atLimit = await review(fixture, { window_to_wall_ratio: 0.4 });
    expect(rule(result(atLimit), 'ASH-WWR-1')).toEqual([]);

    const glassy = await review(fixture, { window_to_wall_ratio: 0.8 });
    const warning = rule(result(glassy), 'ASH-WWR-1');
    expect(warning).toHaveLength(1);
    expect(warning[0].severity).toBe('warning');
    expect(warning[0].message).toContain('Window-to-wall ratio is 0.8');
    expect(warning[0].message).toContain('caps it at 0.4');
    expect(warning[0].message).toContain('1.6× penalty');

    // The penalty is a real multiplier on envelope loads, not just prose.
    expect(metrics(glassy).loads.heatingKw).toBe(round2(metrics(atLimit).loads.heatingKw * 1.6));
    expect(metrics(glassy).loads.lightingKw).toBe(metrics(atLimit).loads.lightingKw);
    expect(metrics(glassy).euiKwhM2Yr).toBeGreaterThan(metrics(atLimit).euiKwhM2Yr);
  });

  it('advises on an exposed form and a deep plate, and only when advisories are on', async () => {
    const small = await buildPlan(SMALL_BRIEF);
    const on = result(await review(small));
    const exposed = rule(on, 'ASH-ENV-1');
    expect(exposed).toHaveLength(1);
    expect(exposed[0].severity).toBe('advisory');
    expect(exposed[0].message).toContain('Envelope-to-floor-area ratio is 1.68');
    // 20 × 12 m is 1.67:1 — nowhere near the 3:1 the plate rule cares about.
    expect(rule(on, 'ASH-ORI-1')).toEqual([]);

    const wide = await buildPlan({
      floors: 1,
      site_width_m: 300,
      site_depth_m: 40,
      target_gross_area_m2: 4000,
    });
    const deep = rule(result(await review(wide)), 'ASH-ORI-1');
    expect(deep).toHaveLength(1);
    expect(deep[0].severity).toBe('advisory');
    expect(deep[0].message).toContain('Plan aspect ratio is 7.5:1 (300 m × 40 m)');

    const off = result(await review(small, { include_advisory: false }));
    expect(off.findings.every((f) => f.severity !== 'advisory')).toBe(true);
    // Two advisory checks stop being run, so `checked` drops by two.
    expect(off.summary.checked).toBe(on.summary.checked - 2);
    expect(off.summary.checked).toBe(2);
  });

  it('refuses to simulate a plan with no conditioned area', async () => {
    const fixture = await buildPlan(SMALL_BRIEF);
    const empty: FloorPlanResult = {
      ...fixture.plan,
      levels: fixture.plan.levels.map((level) => ({ ...level, rooms: [] })),
    };
    await expect(
      runNode(energyPerformanceReviewNode, {
        params: { mock_latency_ms: 0 },
        inputs: { floor_plan: toValue(empty) },
      }),
    ).rejects.toThrow('the floor plan has no conditioned area');
  });

  it('emits a findings table that mirrors the result row for row', async () => {
    const run = await review(await buildPlan(SMALL_BRIEF), { window_to_wall_ratio: 0.8 });
    const res = result(run);
    const table = run.outputs.findings as unknown as TableValue;
    expect(table.rows).toHaveLength(res.findings.length);
    expect(table.rows.length).toBeGreaterThan(2);
    res.findings.forEach((f, i) => {
      expect(table.rows[i].id).toBe(f.id);
      expect(table.rows[i].rule_id).toBe(f.ruleId);
      expect(table.rows[i].level).toBeNull();
      expect(table.rows[i].elements).toBe('');
    });
  });

  it('refuses to review without a floor plan', async () => {
    await expect(
      runNode(energyPerformanceReviewNode, { params: { mock_latency_ms: 0 }, inputs: {} }),
    ).rejects.toThrow('aec.review.energy_performance: required input "floor_plan" is missing');
  });
});
