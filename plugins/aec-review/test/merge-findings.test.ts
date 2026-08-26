/**
 * aec.review.merge_findings: four disciplines converge into one findings set,
 * every finding still attributed to the review that raised it, and one bad arm
 * never takes the fan-in down.
 */
import { describe, expect, it } from 'vitest';
import type { Value } from '@archspace/node-sdk';
import { runNode, type RunNodeResult } from '@archspace/node-sdk/testkit';
import { toValue } from '@archspace/nodes-core/util';
import type {
  MergedReviewResult,
  ReviewFinding,
  ReviewResult,
  TableValue,
} from '@archspace/nodes-core/shapes';
import { accessibilityReviewNode } from '../src/accessibility-review.js';
import { codeComplianceReviewNode } from '../src/compliance-review.js';
import { mergeFindingsNode } from '../src/merge-findings.js';
import { zoningReviewNode } from '../src/zoning-review.js';
import { buildPlan, buildSite, SMALL_BRIEF } from './fixtures.js';

interface Arms {
  code: Value;
  accessibility: Value;
  zoning: Value;
  results: ReviewResult[];
  values: Value[];
}

/**
 * Three real reviews of one scheme, tuned so each contributes a different
 * severity: warnings from the code review, violations from accessibility, and
 * the full spread from zoning.
 */
async function threeArms(): Promise<Arms> {
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
  const values = [code.outputs.result, accessibility.outputs.result, zoning.outputs.result];
  return {
    code: values[0],
    accessibility: values[1],
    zoning: values[2],
    values,
    results: values.map((v) => v as unknown as ReviewResult),
  };
}

async function merge(reviews: Value, params: Record<string, unknown> = {}): Promise<RunNodeResult<unknown>> {
  return runNode(mergeFindingsNode, { params, inputs: { reviews } });
}

const merged = (run: RunNodeResult<unknown>): MergedReviewResult =>
  run.outputs.result as unknown as MergedReviewResult;

/** The node's dedupe identity: same rule, same storey, same elements. */
const identityOf = (f: ReviewFinding): string =>
  `${f.ruleId}|${f.level}|${[...f.elementIds].sort().join(',')}`;

describe('aec.review.merge_findings', () => {
  it('folds several reviews into one well-formed merged result', async () => {
    const arms = await threeArms();
    const run = await merge(arms.values);
    const res = merged(run);

    expect(res.discipline).toBe('merged');
    expect(res.engine).toEqual({ name: 'mock-merge', version: '1.0.0' });
    expect(res.standard).toEqual({ name: 'multi-discipline', version: '3 reviews' });
    expect(res.reviewId).toMatch(/^rev_[0-9a-f]{8}$/);
    expect(res.summary.checked).toBe(arms.results.reduce((sum, r) => sum + r.summary.checked, 0));
    expect(res.summary.passed).toBe(res.summary.checked - res.findings.length);
    expect(res.summary.violations).toBe(res.findings.filter((f) => f.severity === 'violation').length);
    expect(run.outputs.violation_count).toBe(res.summary.violations);
    expect(run.progress.at(-1)).toEqual({
      fraction: 1,
      message: `merged ${res.findings.length} finding(s) from 3 review(s)`,
    });
  });

  it('records every contributing review as a source, in edge order', async () => {
    const arms = await threeArms();
    const res = merged(await merge(arms.values));
    expect(res.sources).toEqual(
      arms.results.map((r) => ({
        reviewId: r.reviewId,
        discipline: r.discipline,
        standard: r.standard,
        summary: r.summary,
      })),
    );
    expect(res.sources.map((s) => s.discipline)).toEqual(['code', 'accessibility', 'zoning']);
  });

  it('attributes every merged finding to the discipline that raised it', async () => {
    const arms = await threeArms();
    const res = merged(await merge(arms.values));

    for (const finding of res.findings) {
      const origin = arms.results.find((r) =>
        r.findings.some((f) => f.ruleId === finding.ruleId && f.message === finding.message),
      );
      expect(origin, finding.ruleId).toBeDefined();
      expect(finding.discipline).toBe(origin!.discipline);
    }
    // All three disciplines actually made it through — this is a real fan-in.
    expect(new Set(res.findings.map((f) => f.discipline))).toEqual(
      new Set(['code', 'accessibility', 'zoning']),
    );
  });

  it('lets a finding with no discipline of its own inherit its review’s', async () => {
    const arms = await threeArms();
    // A review authored against the original single-discipline shape: the
    // findings carry no `discipline` key at all.
    const legacy: ReviewResult = {
      ...arms.results[0],
      findings: arms.results[0].findings.map(({ discipline: _discipline, ...rest }) => rest),
    };
    expect(legacy.findings.every((f) => f.discipline === undefined)).toBe(true);

    const res = merged(await merge([toValue(legacy)]));
    expect(res.findings.length).toBe(legacy.findings.length);
    expect(res.findings.every((f) => f.discipline === 'code')).toBe(true);
  });

  it('renumbers the merged set, because ids are only unique per review run', async () => {
    const arms = await threeArms();
    const res = merged(await merge(arms.values));
    expect(res.findings.map((f) => f.id)).toEqual(
      res.findings.map((_f, i) => `f_${String(i + 1).padStart(3, '0')}`),
    );
    // The incoming reviews all started their own numbering at f_001.
    expect(arms.results.every((r) => r.findings[0]?.id === 'f_001')).toBe(true);
  });

  it('sorts worst-first and breaks ties by source order', async () => {
    const arms = await threeArms();
    const sorted = merged(await merge(arms.values));
    const rank = { violation: 0, warning: 1, advisory: 2 };
    const ranks = sorted.findings.map((f) => rank[f.severity]);
    expect(ranks).toEqual([...ranks].sort((a, b) => a - b));
    expect(new Set(ranks).size).toBe(3);

    const unsorted = merged(await merge(arms.values, { sort_by_severity: false }));
    // Unsorted is plain concatenation: the code review's warnings come first
    // because its edge does, ahead of the accessibility violations.
    expect(unsorted.findings[0].discipline).toBe('code');
    expect(unsorted.findings[0].severity).toBe('warning');
    // Same set either way, only the order differs.
    expect(unsorted.findings.map((f) => f.message).sort()).toEqual(
      sorted.findings.map((f) => f.message).sort(),
    );
  });

  it('drops findings that share a rule, a storey and a set of elements', async () => {
    const arms = await threeArms();
    const twice = await merge([arms.code, arms.code]);
    const once = merged(await merge([arms.code]));

    expect(merged(twice).findings.map((f) => f.message)).toEqual(once.findings.map((f) => f.message));
    expect(twice.logs).toContainEqual({
      level: 'info',
      message: `dropped ${once.findings.length} duplicate finding(s)`,
    });
    // `checked` still counts both arms: the filter is on findings, not work done.
    expect(merged(twice).summary.checked).toBe(once.summary.checked * 2);

    const kept = merged(await merge([arms.code, arms.code], { dedupe: false }));
    expect(kept.findings).toHaveLength(once.findings.length * 2);

    // With dedupe on, no two surviving findings share an identity — including
    // across disciplines and within a single arm.
    const all = merged(await merge(arms.values));
    const identities = all.findings.map(identityOf);
    expect(new Set(identities).size).toBe(identities.length);
  });

  it('skips a malformed arm with a warning instead of failing the whole fan-in', async () => {
    const arms = await threeArms();
    const run = await merge([arms.code, { nope: 1 }, 'not a review', null]);
    const res = merged(run);

    expect(res.sources).toHaveLength(1);
    expect(res.sources[0].discipline).toBe('code');
    expect(res.findings.length).toBeGreaterThan(0);
    expect(run.logs).toContainEqual({
      level: 'warn',
      message: 'reviews[1] is not a well-formed review (missing a string reviewId) — skipping it',
    });
    expect(run.logs).toContainEqual({
      level: 'warn',
      message: 'reviews[2] is not a well-formed review (not an object) — skipping it',
    });
    expect(run.logs).toContainEqual({ level: 'info', message: 'merging 1 of 4 incoming review(s)' });
  });

  it('names the field that made an arm unusable', async () => {
    const arms = await threeArms();
    const good = arms.results[0];
    const cases: [Value, string][] = [
      [toValue({ ...good, summary: { ...good.summary, checked: 'lots' } }), 'summary.checked is not a number'],
      [toValue({ ...good, standard: { name: 'IBC' } }), 'missing a standard {name, version}'],
      [toValue({ ...good, findings: 'none' }), 'findings is not an array'],
      [toValue({ ...good, findings: [{ id: 'f_001' }] }), 'findings[0] is not a well-formed finding'],
      [toValue({ ...good, discipline: 7 }), 'missing a string discipline'],
    ];
    for (const [bad, reason] of cases) {
      const run = await merge([bad]);
      expect(run.logs, reason).toContainEqual({
        level: 'warn',
        message: `reviews[0] is not a well-formed review (${reason}) — skipping it`,
      });
      expect(merged(run).findings).toEqual([]);
    }
  });

  it('accepts a single unwrapped review, so one lone edge still merges', async () => {
    const arms = await threeArms();
    const wrapped = merged(await merge([arms.code]));
    const bare = merged(await merge(arms.code));
    expect(bare.summary).toEqual(wrapped.summary);
    expect(bare.findings).toEqual(wrapped.findings);
    expect(bare.sources).toHaveLength(1);
  });

  it('emits a findings table that mirrors the merged result row for row', async () => {
    const arms = await threeArms();
    const run = await merge(arms.values);
    const res = merged(run);
    const table = run.outputs.findings as unknown as TableValue;
    expect(table.rows).toHaveLength(res.findings.length);
    // Guard the loop below: without this the mirror assertions are vacuous
    // the moment the fixture stops producing findings.
    expect(res.findings.length).toBeGreaterThan(0);
    res.findings.forEach((f, i) => {
      expect(table.rows[i].id).toBe(f.id);
      expect(table.rows[i].rule_id).toBe(f.ruleId);
      expect(table.rows[i].severity).toBe(f.severity);
      expect(table.rows[i].elements).toBe(f.elementIds.join(', '));
    });
  });

  it('refuses to merge without the reviews input', async () => {
    await expect(runNode(mergeFindingsNode, { inputs: {} })).rejects.toThrow(
      'aec.review.merge_findings: required input "reviews" is missing',
    );
  });
});
