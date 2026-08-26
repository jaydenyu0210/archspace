import { describe, expect, it } from 'vitest';
import { isValueOfType } from '@archspace/types';
import type { Value } from '@archspace/node-sdk';
import { runNode } from '@archspace/node-sdk/testkit';
import { parkingEstimateNode } from '../src/parking-estimate.js';
import { projectBriefNode } from '../src/project-brief.js';
import type { ParkingEstimate, TableValue } from '../src/shapes.js';

/**
 * The brief as it travels on a wire. Every caller below passes it straight into
 * another node's `inputs`, which take `Value` — so annotating it `ProjectBrief`
 * would buy nothing and cost a cast back at each use. The `as unknown as` view
 * the other suites use is for *reading* fields off an output; this is the
 * opposite direction.
 */
async function brief(params: Record<string, unknown> = {}): Promise<Value> {
  const run = await runNode(projectBriefNode, { params });
  return run.outputs.brief;
}

/** A minimal constraints stand-in — only the field this node reads. */
function constraintsWithRatio(minParkingPer100M2: number): Value {
  return { limits: { minParkingPer100M2 } };
}

describe('aec.parking_estimate', () => {
  it('runs with defaults and every output matches its declared port type', async () => {
    const run = await runNode(parkingEstimateNode, { inputs: { brief: await brief() } });
    const manifest = parkingEstimateNode.manifest;
    for (const port of manifest.outputs) {
      expect(isValueOfType(run.outputs[port.id], port.type), `${port.id}: ${port.type}`).toBe(true);
    }
  });

  it('derives the space count from the brief and the ratio', async () => {
    // 7600 m² at 1.5 per 100 m² = 114 spaces.
    const run = await runNode(parkingEstimateNode, {
      inputs: { brief: await brief({ target_gross_area_m2: 7600 }) },
    });
    expect(run.outputs.spaces_required).toBe(114);

    const bigger = await runNode(parkingEstimateNode, {
      inputs: { brief: await brief({ target_gross_area_m2: 15200 }) },
    });
    expect(bigger.outputs.spaces_required).toBe(228);
  });

  it('takes the ratio from constraints when the param is 0, and the param when it is not', async () => {
    const b = await brief({ target_gross_area_m2: 10000 });

    const fromConstraints = await runNode(parkingEstimateNode, {
      inputs: { brief: b, constraints: constraintsWithRatio(2.5) },
    });
    let estimate = fromConstraints.outputs.estimate as unknown as ParkingEstimate;
    expect(estimate.ratioSource).toBe('constraints');
    expect(estimate.ratioPer100M2).toBe(2.5);
    expect(fromConstraints.outputs.spaces_required).toBe(250);

    const fromParam = await runNode(parkingEstimateNode, {
      inputs: { brief: b, constraints: constraintsWithRatio(2.5) },
      params: { ratio_per_100_m2: 1 },
    });
    estimate = fromParam.outputs.estimate as unknown as ParkingEstimate;
    expect(estimate.ratioSource).toBe('param');
    expect(fromParam.outputs.spaces_required).toBe(100);
  });

  it('falls back to the documented default and logs when no ratio is available', async () => {
    const run = await runNode(parkingEstimateNode, { inputs: { brief: await brief() } });
    const estimate = run.outputs.estimate as unknown as ParkingEstimate;
    expect(estimate.ratioSource).toBe('default');
    expect(estimate.ratioPer100M2).toBe(1.5);
    expect(run.logs.some((l) => l.level === 'info' && l.message.includes('1.5'))).toBe(true);
  });

  it('splits the total into standard, accessible and EV-ready spaces', async () => {
    const run = await runNode(parkingEstimateNode, {
      inputs: { brief: await brief({ target_gross_area_m2: 10000 }) },
      params: { ratio_per_100_m2: 1, accessible_pct: 4, ev_ready_pct: 10 },
    });
    const estimate = run.outputs.estimate as unknown as ParkingEstimate;
    expect(estimate.spaces).toEqual({ total: 100, standard: 96, accessible: 4, evReady: 10 });
    expect(estimate.spaces.standard + estimate.spaces.accessible).toBe(estimate.spaces.total);
  });

  it('always provides at least one accessible space when any parking is required', async () => {
    const run = await runNode(parkingEstimateNode, {
      inputs: { brief: await brief({ target_gross_area_m2: 200 }) },
      params: { ratio_per_100_m2: 1, accessible_pct: 0 },
    });
    const estimate = run.outputs.estimate as unknown as ParkingEstimate;
    expect(estimate.spaces.total).toBe(2);
    expect(estimate.spaces.accessible).toBe(1);
  });

  it('reports the area the parking consumes', async () => {
    const run = await runNode(parkingEstimateNode, {
      inputs: { brief: await brief({ target_gross_area_m2: 10000 }) },
      params: { ratio_per_100_m2: 1, space_area_m2: 27.5 },
    });
    const estimate = run.outputs.estimate as unknown as ParkingEstimate;
    expect(estimate.areaM2).toBe(2750);
    expect(estimate.areaRatio).toBe(0.28);
  });

  it('breakdown rows agree with the estimate', async () => {
    const run = await runNode(parkingEstimateNode, { inputs: { brief: await brief() } });
    const estimate = run.outputs.estimate as unknown as ParkingEstimate;
    const table = run.outputs.breakdown as unknown as TableValue;
    const byCategory = new Map(table.rows.map((r) => [String(r.category), Number(r.spaces)]));
    expect(byCategory.get('Total')).toBe(estimate.spaces.total);
    expect(byCategory.get('Standard')).toBe(estimate.spaces.standard);
    expect(byCategory.get('Accessible')).toBe(estimate.spaces.accessible);
    expect(byCategory.get('EV-ready (of total)')).toBe(estimate.spaces.evReady);
  });

  it('is deterministic', async () => {
    const b = await brief();
    const a = await runNode(parkingEstimateNode, { inputs: { brief: b } });
    const c = await runNode(parkingEstimateNode, { inputs: { brief: b } });
    expect(a.outputs).toEqual(c.outputs);
  });
});
