/**
 * aec.review.zoning: the massing scheme judged against the site's real FAR,
 * height, storey, coverage and setback limits — every message quoting the
 * measured value and the limit it broke.
 */
import { describe, expect, it } from 'vitest';
import type { Value } from '@archspace/node-sdk';
import { runNode, type RunNodeResult } from '@archspace/node-sdk/testkit';
import type { ReviewResult, TableValue } from '@archspace/nodes-core/shapes';
import { zoningReviewNode } from '../src/zoning-review.js';
import { buildPlan, buildSite, SMALL_BRIEF, type SiteFixture } from './fixtures.js';

/** Zoning limits tight enough that a scheme sized to the brief breaks them all. */
const TIGHT_LIMITS: Record<string, unknown> = {
  max_far: 0.5,
  max_height_m: 5,
  max_storeys: 2,
  max_lot_coverage_pct: 10,
};

const FOUR_STOREY: Record<string, unknown> = {
  ...SMALL_BRIEF,
  floors: 4,
  target_gross_area_m2: 400,
};

async function review(
  site: SiteFixture,
  briefValue?: Value,
  params: Record<string, unknown> = {},
): Promise<RunNodeResult<unknown>> {
  return runNode(zoningReviewNode, {
    params: { mock_latency_ms: 0, ...params },
    inputs: {
      constraints: site.constraintsValue,
      massing: site.massingValue,
      brief: briefValue,
    },
  });
}

function result(run: RunNodeResult<unknown>): ReviewResult {
  return run.outputs.result as unknown as ReviewResult;
}

function rule(res: ReviewResult, ruleId: string) {
  return res.findings.filter((f) => f.ruleId === ruleId);
}

describe('aec.review.zoning', () => {
  it('reports the jurisdiction as the standard, and anchors findings to the massing', async () => {
    const fixture = await buildPlan(SMALL_BRIEF);
    const site = await buildSite(fixture.briefValue);
    const run = await review(site, fixture.briefValue);
    const res = result(run);

    expect(res.discipline).toBe('zoning');
    expect(res.engine).toEqual({ name: 'mock-zoning-review', version: '1.0.0' });
    expect(res.standard).toEqual({
      name: site.constraints.zoningDistrict,
      version: site.constraints.jurisdiction,
    });
    expect(res.summary.passed).toBe(res.summary.checked - res.findings.length);
    // Zoning runs before any BIM model exists, so nothing can carry a GUID.
    expect(res.findings.every((f) => f.elementGuids.length === 0)).toBe(true);
    expect(res.findings.every((f) => f.discipline === 'zoning')).toBe(true);
    expect(res.findings.every((f) => f.level === null)).toBe(true);
    expect(run.progress.at(-1)).toEqual({ fraction: 1, message: 'review complete' });
  });

  it('passes a massing that was generated inside the very envelope it is judged against', async () => {
    const fixture = await buildPlan(SMALL_BRIEF);
    const site = await buildSite(fixture.briefValue);
    const res = result(await review(site, fixture.briefValue));

    // 4 bulk checks + one per footprint vertex + programme + parking.
    expect(res.summary.checked).toBe(4 + site.massing.footprint.polygon.length + 1 + 1);
    expect(res.summary.violations).toBe(0);
    // Parking is the one thing this mock never models, so it always advises.
    expect(res.findings.map((f) => f.ruleId)).toEqual(['ZON-PRK-1']);
  });

  it('breaks every bulk limit at once when the scheme ignores the envelope', async () => {
    const fixture = await buildPlan(FOUR_STOREY);
    const site = await buildSite(fixture.briefValue, TIGHT_LIMITS, {
      wireConstraintsToMassing: false,
    });
    const limits = site.constraints.limits;
    const metrics = site.massing.metrics;
    expect(metrics.far).toBeGreaterThan(limits.maxFar);
    expect(metrics.heightM).toBeGreaterThan(limits.maxHeightM);
    expect(site.massing.storeys.length).toBeGreaterThan(limits.maxStoreys);
    expect(metrics.lotCoveragePct).toBeGreaterThan(limits.maxLotCoveragePct);

    const res = result(await review(site, fixture.briefValue));

    const far = rule(res, 'ZON-FAR-1');
    expect(far).toHaveLength(1);
    expect(far[0].severity).toBe('violation');
    expect(far[0].message).toContain(`floor area ratio of ${metrics.far}`);
    expect(far[0].message).toContain(`allows at most ${limits.maxFar}`);
    expect(far[0].elementIds).toEqual([site.massing.massingId]);

    const height = rule(res, 'ZON-HGT-1');
    expect(height).toHaveLength(1);
    expect(height[0].severity).toBe('violation');
    expect(height[0].message).toContain(`is ${metrics.heightM} m tall`);
    expect(height[0].message).toContain(`at most ${limits.maxHeightM} m`);

    const storeys = rule(res, 'ZON-STY-1');
    expect(storeys).toHaveLength(1);
    expect(storeys[0].severity).toBe('violation');
    expect(storeys[0].message).toContain(`has ${site.massing.storeys.length} storeys`);
    // The offending storeys are named individually — the ones at or above the cap.
    expect(storeys[0].elementIds).toEqual(
      site.massing.storeys.filter((s) => s.level >= limits.maxStoreys).map((s) => `storey_${s.level}`),
    );

    const coverage = rule(res, 'ZON-COV-1');
    expect(coverage).toHaveLength(1);
    expect(coverage[0].severity).toBe('violation');
    expect(coverage[0].message).toContain(`covers ${metrics.lotCoveragePct}%`);
    expect(coverage[0].message).toContain(`at most ${limits.maxLotCoveragePct}%`);
  });

  it('names each footprint vertex that sits outside the buildable envelope', async () => {
    const fixture = await buildPlan(SMALL_BRIEF);
    // Setbacks applied to the constraints but not to the massing: the scheme
    // is drawn on the whole lot and then measured against the envelope.
    const site = await buildSite(fixture.briefValue, {}, { wireConstraintsToMassing: false });
    const buildable = site.constraints.buildable;
    const outside = site.massing.footprint.polygon
      .map(([x, y], index) => ({ index, x, y }))
      .filter((v) => v.x < -0.01 || v.y < -0.01 || v.x > buildable.widthM + 0.01 || v.y > buildable.depthM + 0.01);
    expect(outside.length).toBeGreaterThan(0);

    const res = result(await review(site, fixture.briefValue));
    const setbacks = rule(res, 'ZON-SET-1');
    expect(setbacks).toHaveLength(outside.length);
    expect(setbacks.every((f) => f.severity === 'violation')).toBe(true);
    setbacks.forEach((finding, i) => {
      expect(finding.message).toContain(`vertex ${outside[i].index} at (${outside[i].x}, ${outside[i].y}) m`);
      expect(finding.message).toContain(`${buildable.widthM} m × ${buildable.depthM} m`);
      expect(finding.message).toContain(`front ${site.constraints.setbacksM.front} m`);
    });
    // A vertex that sits exactly on the envelope line is inside it: the 10 mm
    // tolerance exists so float noise cannot invent an encroachment.
    expect(setbacks.length).toBeLessThan(site.massing.footprint.polygon.length);
  });

  it('warns when the brief itself cannot legally be built on the site', async () => {
    const fixture = await buildPlan(FOUR_STOREY);
    const site = await buildSite(fixture.briefValue, TIGHT_LIMITS, {
      wireConstraintsToMassing: false,
    });
    const res = result(await review(site, fixture.briefValue));

    const programme = rule(res, 'ZON-PRG-1');
    expect(programme).toHaveLength(1);
    // A warning, not a violation: the brief is the client's, not the design's.
    expect(programme[0].severity).toBe('warning');
    expect(programme[0].message).toContain(`asks for ${FOUR_STOREY.target_gross_area_m2} m² gross`);
    expect(programme[0].message).toContain(`caps this lot at ${site.constraints.maxGrossAreaM2} m²`);
  });

  it('skips the programme check and says so when no brief is wired', async () => {
    const fixture = await buildPlan(FOUR_STOREY);
    const site = await buildSite(fixture.briefValue, TIGHT_LIMITS, {
      wireConstraintsToMassing: false,
    });
    const withBrief = result(await review(site, fixture.briefValue));
    const run = await review(site);
    const without = result(run);

    expect(rule(without, 'ZON-PRG-1')).toEqual([]);
    expect(without.summary.checked).toBe(withBrief.summary.checked - 1);
    expect(run.logs).toContainEqual({
      level: 'info',
      message: 'no brief supplied — the programme-vs-envelope check (ZON-PRG-1) is skipped',
    });
  });

  it('always advises on the parking it never models, unless advisories are off', async () => {
    const fixture = await buildPlan(SMALL_BRIEF);
    const site = await buildSite(fixture.briefValue);
    const on = result(await review(site, fixture.briefValue));
    const parking = rule(on, 'ZON-PRK-1');
    expect(parking).toHaveLength(1);
    expect(parking[0].severity).toBe('advisory');
    const required = Math.ceil(
      (site.massing.metrics.grossAreaM2 / 100) * site.constraints.limits.minParkingPer100M2,
    );
    expect(parking[0].message).toContain(`needs ${required} parking space(s)`);

    const off = result(await review(site, fixture.briefValue, { include_advisory: false }));
    expect(rule(off, 'ZON-PRK-1')).toEqual([]);
    expect(off.summary.checked).toBe(on.summary.checked - 1);
  });

  it('emits a findings table that mirrors the result row for row', async () => {
    const fixture = await buildPlan(FOUR_STOREY);
    const site = await buildSite(fixture.briefValue, TIGHT_LIMITS, {
      wireConstraintsToMassing: false,
    });
    const run = await review(site, fixture.briefValue);
    const res = result(run);
    const table = run.outputs.findings as unknown as TableValue;
    expect(table.rows).toHaveLength(res.findings.length);
    expect(table.rows.length).toBeGreaterThan(4);
    res.findings.forEach((f, i) => {
      expect(table.rows[i].id).toBe(f.id);
      expect(table.rows[i].rule_id).toBe(f.ruleId);
      expect(table.rows[i].level).toBeNull();
      expect(table.rows[i].elements).toBe(f.elementIds.join(', '));
    });
  });

  it('refuses to review without constraints or without a massing', async () => {
    const fixture = await buildPlan(SMALL_BRIEF);
    const site = await buildSite(fixture.briefValue);
    await expect(
      runNode(zoningReviewNode, {
        params: { mock_latency_ms: 0 },
        inputs: { massing: site.massingValue },
      }),
    ).rejects.toThrow('aec.review.zoning: required input "constraints" is missing');
    await expect(
      runNode(zoningReviewNode, {
        params: { mock_latency_ms: 0 },
        inputs: { constraints: site.constraintsValue },
      }),
    ).rejects.toThrow('aec.review.zoning: required input "massing" is missing');
  });
});
