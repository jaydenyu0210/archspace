/**
 * aec.review.energy_performance — MOCK of an energy simulation engine.
 * The EUI is computed from the ACTUAL plan (conditioned area, site proportions)
 * and the ACTUAL envelope (the massing's facade area when one is wired, else a
 * perimeter × height estimate), so upstream changes genuinely move the number.
 * The EnergyMetrics and ReviewResult shapes (shapes.ts) are the contract a real
 * simulation backend must return.
 */
import type { NodeModule, Value } from '@archspace/node-sdk';
import type {
  EnergyMetrics,
  FloorPlanResult,
  MassingResult,
  ReviewFinding,
  ReviewResult,
  TableValue,
} from '@archspace/nodes-core/shapes';
import { fnv1a, hex8, mulberry32, requireInput, round2, round3, sleep, toValue } from '@archspace/nodes-core/util';

export interface EnergyPerformanceReviewParams {
  standard_version: string;
  target_eui_kwh_m2_yr: number;
  window_to_wall_ratio: number;
  climate_zone: string;
  include_advisory: boolean;
  mock_latency_ms: number;
}

/**
 * MOCK COEFFICIENTS standing in for a real simulation. Heating and cooling
 * intensities are watts per m² of envelope at design conditions: a hot-dry zone
 * (3B) is cooling-dominated, a cold zone (6A) heating-dominated. A real backend
 * replaces this table with an hourly simulation; nothing outside execute()
 * changes when it does.
 */
const CLIMATE: Record<string, { heatingWM2: number; coolingWM2: number; label: string }> = {
  '3B': { heatingWM2: 8, coolingWM2: 26, label: 'hot-dry' },
  '4A': { heatingWM2: 14, coolingWM2: 20, label: 'mixed-humid' },
  '5A': { heatingWM2: 18, coolingWM2: 17, label: 'cool-humid' },
  '6A': { heatingWM2: 24, coolingWM2: 13, label: 'cold-humid' },
};

/** MOCK COEFFICIENTS: internal load densities, watts per m² of floor area. */
const LIGHTING_W_M2 = 9;
const EQUIPMENT_W_M2 = 12;

/** MOCK COEFFICIENTS: equivalent full-load hours per year, per end use. */
const EFLH = { heating: 1200, cooling: 900, lighting: 2500, equipment: 3000 };

/** Prescriptive window-to-wall ratio above which the envelope is penalised. */
const WWR_PRESCRIPTIVE = 0.4;
/** MOCK COEFFICIENT: envelope load multiplier per unit of WWR above the limit. */
const WWR_PENALTY_PER_UNIT = 1.5;

/** Grid carbon intensity, kg CO₂e per kWh — a single national-average figure. */
const CARBON_KG_PER_KWH = 0.233;

/** MOCK: storey height assumed when estimating an envelope without a massing. */
const ASSUMED_STOREY_HEIGHT_M = 3.5;

/** Envelope-to-floor-area ratio above which the form is thermally exposed. */
const EXPOSED_ENVELOPE_RATIO = 0.8;
/** Plan aspect ratio above which the plate is hard to daylight and condition. */
const DEEP_PLATE_ASPECT = 3;

export const energyPerformanceReviewNode: NodeModule<EnergyPerformanceReviewParams> = {
  manifest: {
    type: 'aec.review.energy_performance',
    version: 1,
    label: 'Energy Performance Review',
    description:
      "Mock energy simulation: estimates EUI from the plan's conditioned area and envelope, then checks it against a target.",
    category: 'Review',
    keywords: ['energy', 'eui', 'ashrae', 'carbon', 'mock'],
    caching: 'never',
    lane: 'ai',
    params: {
      type: 'object',
      properties: {
        standard_version: {
          type: 'string',
          title: 'Standard version',
          enum: ['2022', '2019'],
          default: '2022',
        },
        target_eui_kwh_m2_yr: {
          type: 'number',
          title: 'Target EUI (kWh/m²·yr)',
          default: 95,
          minimum: 10,
          maximum: 500,
        },
        window_to_wall_ratio: {
          type: 'number',
          title: 'Window-to-wall ratio',
          default: 0.4,
          minimum: 0.05,
          maximum: 0.95,
        },
        climate_zone: {
          type: 'string',
          title: 'Climate zone',
          enum: ['3B', '4A', '5A', '6A'],
          default: '4A',
        },
        include_advisory: {
          type: 'boolean',
          title: 'Include advisory findings',
          default: true,
        },
        mock_latency_ms: {
          type: 'integer',
          title: 'Mock latency (ms)',
          default: 1300,
          minimum: 0,
        },
      },
    },
    inputs: [
      { id: 'floor_plan', type: 'json', label: 'Floor plan', required: true },
      { id: 'massing', type: 'json', label: 'Massing', required: false },
    ],
    outputs: [
      { id: 'result', type: 'json', label: 'Result' },
      { id: 'findings', type: 'table', label: 'Findings' },
      { id: 'metrics', type: 'json', label: 'Metrics' },
    ],
  },

  async execute(ctx, inputs, params) {
    const plan = requireInput<FloorPlanResult>(inputs, 'floor_plan', 'aec.review.energy_performance');
    const massing = inputs.massing as unknown as MassingResult | undefined;

    const climate = CLIMATE[params.climate_zone] ?? CLIMATE['4A'];

    ctx.progress(0.1, `simulating envelope loads (zone ${params.climate_zone}, ${climate.label})`);
    await sleep(params.mock_latency_ms / 3, ctx.signal);

    // --- Areas -------------------------------------------------------------
    let conditionedAreaM2 = 0;
    for (const level of plan.levels) {
      for (const room of level.rooms) conditionedAreaM2 += room.areaM2;
    }
    conditionedAreaM2 = round2(conditionedAreaM2);
    if (conditionedAreaM2 <= 0) {
      throw new Error(
        'aec.review.energy_performance: the floor plan has no conditioned area — ' +
          'nothing to simulate. Check the upstream space program.',
      );
    }

    const widthM = plan.site.widthMm / 1000;
    const depthM = plan.site.depthMm / 1000;
    let envelopeAreaM2: number;
    if (massing !== undefined) {
      envelopeAreaM2 = round2(massing.metrics.facadeAreaM2);
      ctx.log('info', `envelope from massing ${massing.massingId}: ${envelopeAreaM2} m² of facade`);
    } else {
      // No massing wired: estimate the facade as site perimeter × total height.
      const perimeterM = 2 * (widthM + depthM);
      envelopeAreaM2 = round2(perimeterM * plan.levels.length * ASSUMED_STOREY_HEIGHT_M);
      ctx.log('info', `no massing wired — envelope estimated from the plan perimeter (${perimeterM} m)`);
    }

    // --- Loads -------------------------------------------------------------
    // Glazing above the prescriptive WWR drives both heating and cooling up.
    const wwrPenalty =
      1 + Math.max(0, params.window_to_wall_ratio - WWR_PRESCRIPTIVE) * WWR_PENALTY_PER_UNIT;
    const heatingKw = round2((envelopeAreaM2 * climate.heatingWM2 * wwrPenalty) / 1000);
    const coolingKw = round2((envelopeAreaM2 * climate.coolingWM2 * wwrPenalty) / 1000);
    const lightingKw = round2((conditionedAreaM2 * LIGHTING_W_M2) / 1000);
    const equipmentKw = round2((conditionedAreaM2 * EQUIPMENT_W_M2) / 1000);

    ctx.progress(0.55, 'aggregating annual energy by end use');
    await sleep(params.mock_latency_ms / 3, ctx.signal);

    const byEndUseKwh = {
      heating: heatingKw * EFLH.heating,
      cooling: coolingKw * EFLH.cooling,
      lighting: lightingKw * EFLH.lighting,
      equipment: equipmentKw * EFLH.equipment,
    };
    const annualEnergyKwh = round2(
      byEndUseKwh.heating + byEndUseKwh.cooling + byEndUseKwh.lighting + byEndUseKwh.equipment,
    );
    const euiKwhM2Yr = round2(annualEnergyKwh / conditionedAreaM2);
    const carbonKgCo2eYr = round2(annualEnergyKwh * CARBON_KG_PER_KWH);

    // Fractions must sum to exactly 1: the last term absorbs the rounding.
    const heatingFrac = round3(byEndUseKwh.heating / annualEnergyKwh);
    const coolingFrac = round3(byEndUseKwh.cooling / annualEnergyKwh);
    const lightingFrac = round3(byEndUseKwh.lighting / annualEnergyKwh);
    const byEndUse: Record<string, number> = {
      heating: heatingFrac,
      cooling: coolingFrac,
      lighting: lightingFrac,
      equipment: round3(1 - heatingFrac - coolingFrac - lightingFrac),
    };

    const metrics: EnergyMetrics = {
      euiKwhM2Yr,
      targetEuiKwhM2Yr: params.target_eui_kwh_m2_yr,
      windowToWallRatio: params.window_to_wall_ratio,
      envelopeAreaM2,
      conditionedAreaM2,
      loads: { heatingKw, coolingKw, lightingKw, equipmentKw },
      annualEnergyKwh,
      carbonKgCo2eYr,
      byEndUse,
    };

    // --- Rules -------------------------------------------------------------
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
        discipline: 'energy',
        elementIds,
        // Whole-building results: no BIM summary is wired into this review.
        elementGuids: [],
      });
    };

    // ASH-EUI-1 — measured EUI against the target.
    checked++;
    const target = params.target_eui_kwh_m2_yr;
    if (euiKwhM2Yr > target * 1.15) {
      addFinding(
        'ASH-EUI-1',
        'Energy use intensity',
        'violation',
        `Modelled EUI is ${euiKwhM2Yr} kWh/m²·yr over ${conditionedAreaM2} m² conditioned area; ` +
          `the target is ${target} kWh/m²·yr and the 15% tolerance (${round2(target * 1.15)}) is exceeded.`,
        null,
        [],
      );
    } else if (euiKwhM2Yr > target) {
      addFinding(
        'ASH-EUI-1',
        'Energy use intensity',
        'warning',
        `Modelled EUI is ${euiKwhM2Yr} kWh/m²·yr against a target of ${target} kWh/m²·yr ` +
          `(${round2(euiKwhM2Yr - target)} over, within the 15% tolerance).`,
        null,
        [],
      );
    }

    // ASH-WWR-1 — prescriptive glazing limit.
    checked++;
    if (params.window_to_wall_ratio > WWR_PRESCRIPTIVE) {
      addFinding(
        'ASH-WWR-1',
        'Window-to-wall ratio',
        'warning',
        `Window-to-wall ratio is ${params.window_to_wall_ratio}; ASHRAE ${params.standard_version} ` +
          `prescriptive compliance caps it at ${WWR_PRESCRIPTIVE}, so envelope loads carry a ` +
          `${round2(wwrPenalty)}× penalty in this run.`,
        null,
        [],
      );
    }

    if (params.include_advisory) {
      // ASH-ENV-1 — a thermally exposed form.
      checked++;
      const envelopeRatio = round2(envelopeAreaM2 / conditionedAreaM2);
      if (envelopeRatio > EXPOSED_ENVELOPE_RATIO) {
        addFinding(
          'ASH-ENV-1',
          'Thermally exposed form',
          'advisory',
          `Envelope-to-floor-area ratio is ${envelopeRatio} (${envelopeAreaM2} m² envelope over ` +
            `${conditionedAreaM2} m² floor); above ${EXPOSED_ENVELOPE_RATIO} the form loses heat faster ` +
            `than a compact one of the same area.`,
          null,
          [],
        );
      }

      // ASH-ORI-1 — deep/thin plate.
      checked++;
      const aspect = round2(Math.max(widthM, depthM) / Math.min(widthM, depthM));
      if (aspect > DEEP_PLATE_ASPECT) {
        addFinding(
          'ASH-ORI-1',
          'Plate proportion and orientation',
          'advisory',
          `Plan aspect ratio is ${aspect}:1 (${widthM} m × ${depthM} m); above ${DEEP_PLATE_ASPECT}:1 ` +
            `the plate is hard to daylight and condition evenly — review orientation and shading.`,
          null,
          [],
        );
      }
    }

    await sleep(params.mock_latency_ms / 3, ctx.signal);
    ctx.progress(1, `simulation complete — ${euiKwhM2Yr} kWh/m²·yr`);

    const advisories = findings.filter((f) => f.severity === 'advisory').length;
    const warnings = findings.filter((f) => f.severity === 'warning').length;
    const violations = findings.filter((f) => f.severity === 'violation').length;

    const result: ReviewResult = {
      reviewId: `rev_${hex8(mulberry32(fnv1a(`${plan.planId}:energy`)))}`,
      discipline: 'energy',
      engine: { name: 'mock-energy-review', version: '1.0.0' },
      standard: { name: 'ASHRAE 90.1', version: params.standard_version },
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

    return {
      result: toValue(result),
      findings: toValue(findingsTable),
      metrics: toValue(metrics),
    };
  },
};
