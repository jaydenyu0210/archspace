/**
 * aec.review.filter_findings: narrows a review by severity, discipline and
 * rule prefix, and the thing it hands on is still a well-formed review whose
 * summary agrees with the findings beside it.
 */
import { describe, expect, it } from 'vitest';
import type { Value } from '@archspace/node-sdk';
import { runNode, type RunNodeResult } from '@archspace/node-sdk/testkit';
import { toValue } from '@archspace/nodes-core/util';
import type { MergedReviewResult, ReviewResult, TableValue } from '@archspace/nodes-core/shapes';
import { accessibilityReviewNode } from '../src/accessibility-review.js';
import { codeComplianceReviewNode } from '../src/compliance-review.js';
import { filterFindingsNode } from '../src/filter-findings.js';
import { mergeFindingsNode } from '../src/merge-findings.js';
import { zoningReviewNode } from '../src/zoning-review.js';
import { buildPlan, buildSite, SMALL_BRIEF } from './fixtures.js';

/**
 * One merged review carrying all three severities and three disciplines —
 * the shape the filter is actually wired behind in a fan-out/fan-in run.
 */
async function mergedReview(): Promise<{ value: Value; result: MergedReviewResult }> {
  const fixture = await buildPlan(SMALL_BRIEF);
  const site = await buildSite(fixture.briefValue, { max_far: 0.5, max_lot_coverage_pct: 10 }, {
    wireConstraintsToMassing: false,
  });
  const code = await runNode(codeComplianceReviewNode, {
    params: { mock_latency_ms: 0 },
    inputs: { floor_plan: fixture.planValue, bim_summary: fixture.bimSummaryValue },
    assets: fixture.assets,
  });
  const accessibility = await runNode(accessibilityReviewNode, {
    params: { mock_latency_ms: 0, min_door_clear_mm: 1000 },
    inputs: { floor_plan: fixture.planValue, bim_summary: fixture.bimSummaryValue },
    assets: fixture.assets,
  });
  const zoning = await runNode(zoningReviewNode, {
    params: { mock_latency_ms: 0 },
    inputs: {
      constraints: site.constraintsValue,
      massing: site.massingValue,
      brief: fixture.briefValue,
    },
  });
  const merged = await runNode(mergeFindingsNode, {
    inputs: {
      reviews: [code.outputs.result, accessibility.outputs.result, zoning.outputs.result],
    },
  });
  return {
    value: merged.outputs.result,
    result: merged.outputs.result as unknown as MergedReviewResult,
  };
}

async function filter(review: Value, params: Record<string, unknown> = {}): Promise<RunNodeResult<unknown>> {
  return runNode(filterFindingsNode, { params, inputs: { review } });
}

const filtered = (run: RunNodeResult<unknown>): ReviewResult =>
  run.outputs.result as unknown as ReviewResult;

describe('aec.review.filter_findings', () => {
  it('keeps violations and warnings but not advisories by default', async () => {
    const { value, result } = await mergedReview();
    expect(result.summary.advisories).toBeGreaterThan(0);
    expect(result.summary.warnings).toBeGreaterThan(0);
    expect(result.summary.violations).toBeGreaterThan(0);

    const run = await filter(value);
    const res = filtered(run);
    expect(res.findings.map((f) => f.id)).toEqual(
      result.findings.filter((f) => f.severity !== 'advisory').map((f) => f.id),
    );
    expect(res.summary.advisories).toBe(0);
    expect(res.summary.violations).toBe(result.summary.violations);
    expect(res.summary.warnings).toBe(result.summary.warnings);
    expect(run.outputs.kept_count).toBe(res.findings.length);
    expect(run.outputs.dropped_count).toBe(result.findings.length - res.findings.length);
    expect(run.progress.at(-1)).toEqual({
      fraction: 1,
      message: `kept ${res.findings.length} of ${result.findings.length} finding(s)`,
    });
  });

  it('filters by each severity independently', async () => {
    const { value, result } = await mergedReview();
    const cases: [Record<string, unknown>, 'violation' | 'warning' | 'advisory'][] = [
      [{ include_warnings: false, include_advisories: false }, 'violation'],
      [{ include_violations: false, include_advisories: false }, 'warning'],
      [{ include_violations: false, include_warnings: false, include_advisories: true }, 'advisory'],
    ];
    for (const [params, severity] of cases) {
      const run = await filter(value, params);
      const res = filtered(run);
      const expected = result.findings.filter((f) => f.severity === severity);
      expect(res.findings.map((f) => f.id), severity).toEqual(expected.map((f) => f.id));
      expect(res.findings.every((f) => f.severity === severity), severity).toBe(true);
      expect(run.outputs.kept_count, severity).toBe(expected.length);
      expect(run.outputs.dropped_count, severity).toBe(result.findings.length - expected.length);
    }
  });

  it('filters by discipline, tolerating spacing and case in the allowlist', async () => {
    const { value, result } = await mergedReview();
    const codeOnly = filtered(await filter(value, { disciplines: 'code', include_advisories: true }));
    expect(codeOnly.findings.every((f) => f.discipline === 'code')).toBe(true);
    expect(codeOnly.findings).toHaveLength(
      result.findings.filter((f) => f.discipline === 'code').length,
    );

    const two = filtered(
      await filter(value, { disciplines: ' Code , ZONING ', include_advisories: true }),
    );
    expect(new Set(two.findings.map((f) => f.discipline))).toEqual(new Set(['code', 'zoning']));
    expect(two.findings).toHaveLength(
      result.findings.filter((f) => f.discipline === 'code' || f.discipline === 'zoning').length,
    );

    // Empty means "every discipline", not "none".
    const all = filtered(await filter(value, { disciplines: '   ', include_advisories: true }));
    expect(all.findings).toHaveLength(result.findings.length);
  });

  it('filters by rule id prefix', async () => {
    const { value, result } = await mergedReview();
    const a117 = filtered(await filter(value, { rule_prefix: 'A117-', include_advisories: true }));
    const expected = result.findings.filter((f) => f.ruleId.startsWith('A117-'));
    expect(expected.length).toBeGreaterThan(0);
    expect(a117.findings.map((f) => f.ruleId)).toEqual(expected.map((f) => f.ruleId));

    // A prefix that matches nothing keeps nothing — and still returns a review.
    const none = await filter(value, { rule_prefix: 'NOPE-' });
    expect(filtered(none).findings).toEqual([]);
    expect(none.outputs.kept_count).toBe(0);
    expect(none.outputs.dropped_count).toBe(result.findings.length);
  });

  it('combines severity, discipline and prefix as an AND', async () => {
    const { value, result } = await mergedReview();
    const run = await filter(value, {
      include_warnings: false,
      disciplines: 'zoning',
      rule_prefix: 'ZON-',
    });
    const expected = result.findings.filter(
      (f) => f.severity === 'violation' && f.discipline === 'zoning' && f.ruleId.startsWith('ZON-'),
    );
    expect(expected.length).toBeGreaterThan(0);
    expect(filtered(run).findings.map((f) => f.id)).toEqual(expected.map((f) => f.id));
  });

  it('keeps the original ids for traceability unless asked to renumber', async () => {
    const { value, result } = await mergedReview();
    const params = { disciplines: 'zoning', include_advisories: true };
    const traced = filtered(await filter(value, params));

    // Every kept finding still answers to the id the merged review gave it,
    // so it can be traced back to that run.
    const sourceIds = result.findings.filter((f) => f.discipline === 'zoning').map((f) => f.id);
    expect(sourceIds.length).toBeGreaterThan(1);
    expect(traced.findings.map((f) => f.id)).toEqual(sourceIds);
    // Which means the numbering is deliberately gappy: the zoning findings did
    // not start at f_001 in the merged set and do not start at f_001 here.
    expect(traced.findings[0].id).not.toBe('f_001');

    const renumbered = filtered(await filter(value, { ...params, renumber: true }));
    expect(renumbered.findings.map((f) => f.id)).toEqual(
      renumbered.findings.map((_f, i) => `f_${String(i + 1).padStart(3, '0')}`),
    );
    // Renumbering changes ids and nothing else.
    expect(renumbered.findings.map((f) => f.message)).toEqual(traced.findings.map((f) => f.message));
    expect(renumbered.findings.map(({ id: _id, ...rest }) => rest)).toEqual(
      traced.findings.map(({ id: _id, ...rest }) => rest),
    );
  });

  it('recomputes the summary against the kept set, carrying `checked` through', async () => {
    const { value, result } = await mergedReview();
    for (const params of [{}, { include_warnings: false }, { disciplines: 'zoning' }]) {
      const res = filtered(await filter(value, params));
      // `checked` is a property of the review that ran, not of this filter.
      expect(res.summary.checked).toBe(result.summary.checked);
      expect(res.summary.passed).toBe(res.summary.checked - res.findings.length);
      expect(res.summary.violations).toBe(res.findings.filter((f) => f.severity === 'violation').length);
      expect(res.summary.warnings).toBe(res.findings.filter((f) => f.severity === 'warning').length);
      expect(res.summary.advisories).toBe(res.findings.filter((f) => f.severity === 'advisory').length);
    }
  });

  it('preserves everything about the review except its findings and summary', async () => {
    const { value, result } = await mergedReview();
    const res = filtered(await filter(value)) as MergedReviewResult;
    expect(res.reviewId).toBe(result.reviewId);
    expect(res.discipline).toBe(result.discipline);
    expect(res.engine).toEqual(result.engine);
    expect(res.standard).toEqual(result.standard);
    // Merge-specific fields survive: a filtered merge is still a merge.
    expect(res.sources).toEqual(result.sources);
  });

  it('hands on something the merge node will accept again', async () => {
    const { value } = await mergedReview();
    const once = await filter(value, { include_warnings: false });
    const remerged = await runNode(mergeFindingsNode, { inputs: { reviews: [once.outputs.result] } });
    const res = remerged.outputs.result as unknown as MergedReviewResult;

    // Nothing was skipped as malformed — the filtered review round-tripped.
    expect(remerged.logs.filter((l) => l.level === 'warn')).toEqual([]);
    expect(res.sources).toHaveLength(1);
    expect(res.findings.map((f) => f.message)).toEqual(
      filtered(once).findings.map((f) => f.message),
    );
  });

  it('warns rather than silently emptying the review when every severity is off', async () => {
    const { value, result } = await mergedReview();
    const run = await filter(value, { include_violations: false, include_warnings: false });
    expect(filtered(run).findings).toEqual([]);
    expect(run.outputs.kept_count).toBe(0);
    expect(run.outputs.dropped_count).toBe(result.findings.length);
    expect(filtered(run).summary.passed).toBe(result.summary.checked);
    expect(run.logs).toContainEqual({
      level: 'warn',
      message: 'every severity is switched off — this filter keeps nothing',
    });
  });

  it('emits a findings table that mirrors the kept set row for row', async () => {
    const { value } = await mergedReview();
    const run = await filter(value, { include_warnings: false });
    const res = filtered(run);
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
      expect(table.rows[i].severity).toBe(f.severity);
      expect(table.rows[i].elements).toBe(f.elementIds.join(', '));
    });
  });

  it('rejects a missing review and anything that is not one', async () => {
    await expect(runNode(filterFindingsNode, { inputs: {} })).rejects.toThrow(
      'aec.review.filter_findings: required input "review" is missing',
    );
    for (const notAReview of [toValue({ findings: 'none' }), toValue([1, 2, 3]), toValue('review')]) {
      await expect(filter(notAReview)).rejects.toThrow(
        'aec.review.filter_findings: input "review" is not a review result',
      );
    }
  });
});
