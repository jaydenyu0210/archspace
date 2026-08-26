/**
 * aec.review.merge_findings — folds several parallel reviews into one findings set.
 * Pure and instant: no backend stands behind it, so there is no latency to mock.
 *
 * The point of the node is convergence. Code, accessibility, zoning and energy
 * reviews all emit the same ReviewResult shape (shapes.ts), so they can be
 * concatenated without any consumer special-casing the producer — and every
 * finding keeps the discipline that raised it, so nothing is anonymised on the
 * way through. A merge sits on the critical path of a fan-out/fan-in run, so it
 * must never take the whole run down because one arm returned something odd:
 * malformed elements are logged and skipped, never thrown on.
 */
import type { NodeModule, Value } from '@archspace/node-sdk';
import type {
  FindingSeverity,
  MergedReviewResult,
  MergedReviewSource,
  ReviewDiscipline,
  ReviewFinding,
  ReviewResult,
  TableValue,
} from '@archspace/nodes-core/shapes';
import { fnv1a, hex8, mulberry32, toValue } from '@archspace/nodes-core/util';

export interface MergeFindingsParams {
  dedupe: boolean;
  sort_by_severity: boolean;
}

/** Merge ordering: the worst news first, stable within each severity. */
const SEVERITY_RANK: Record<FindingSeverity, number> = {
  violation: 0,
  warning: 1,
  advisory: 2,
};

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function isSeverity(v: unknown): v is FindingSeverity {
  return v === 'advisory' || v === 'warning' || v === 'violation';
}

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((s) => typeof s === 'string');
}

function isFinding(v: unknown): v is ReviewFinding {
  if (!isRecord(v)) return false;
  return (
    typeof v.id === 'string' &&
    typeof v.ruleId === 'string' &&
    typeof v.title === 'string' &&
    isSeverity(v.severity) &&
    typeof v.message === 'string' &&
    (v.level === null || typeof v.level === 'number') &&
    isStringArray(v.elementIds) &&
    isStringArray(v.elementGuids)
  );
}

/**
 * Structural check on one incoming review. Returns null when the value is a
 * well-formed ReviewResult, otherwise a short reason for the warn log.
 */
function reviewProblem(v: unknown): string | null {
  if (!isRecord(v)) return 'not an object';
  if (typeof v.reviewId !== 'string') return 'missing a string reviewId';
  if (typeof v.discipline !== 'string') return 'missing a string discipline';
  if (!isRecord(v.summary)) return 'missing a summary object';
  const summary = v.summary;
  for (const key of ['checked', 'passed', 'advisories', 'warnings', 'violations']) {
    if (typeof summary[key] !== 'number') return `summary.${key} is not a number`;
  }
  if (!isRecord(v.standard) || typeof v.standard.name !== 'string' || typeof v.standard.version !== 'string') {
    return 'missing a standard {name, version}';
  }
  if (!Array.isArray(v.findings)) return 'findings is not an array';
  const badIndex = v.findings.findIndex((f) => !isFinding(f));
  if (badIndex !== -1) return `findings[${badIndex}] is not a well-formed finding`;
  return null;
}

/** Identity used for dedupe: the same rule, on the same storey, on the same elements. */
function identityOf(finding: ReviewFinding): string {
  return `${finding.ruleId}|${finding.level}|${[...finding.elementIds].sort().join(',')}`;
}

export const mergeFindingsNode: NodeModule<MergeFindingsParams> = {
  manifest: {
    type: 'aec.review.merge_findings',
    version: 1,
    label: 'Merge Findings',
    description:
      'Folds the results of several parallel reviews into one findings set, keeping each finding attributed to the discipline that raised it.',
    category: 'Review',
    keywords: ['merge', 'findings', 'review', 'fan-in'],
    caching: 'pure',
    lane: 'cpu',
    params: {
      type: 'object',
      properties: {
        dedupe: {
          type: 'boolean',
          title: 'Drop duplicate findings',
          default: true,
        },
        sort_by_severity: {
          type: 'boolean',
          title: 'Sort by severity',
          default: true,
        },
      },
    },
    inputs: [
      { id: 'reviews', type: 'json', label: 'Reviews', required: true, variadic: true },
    ],
    outputs: [
      { id: 'result', type: 'json', label: 'Result' },
      { id: 'findings', type: 'table', label: 'Findings' },
      { id: 'violation_count', type: 'number', label: 'Violations' },
    ],
  },

  async execute(ctx, inputs, params) {
    const delivered = inputs.reviews;
    if (delivered === undefined || delivered === null) {
      throw new Error('aec.review.merge_findings: required input "reviews" is missing');
    }
    // A variadic input delivers list<json> in edge order. A single unwrapped
    // review is accepted too, so one lone edge still merges instead of failing.
    const incoming: unknown[] = Array.isArray(delivered) ? delivered : [delivered];

    const accepted: ReviewResult[] = [];
    incoming.forEach((candidate, index) => {
      const problem = reviewProblem(candidate);
      if (problem !== null) {
        ctx.log('warn', `reviews[${index}] is not a well-formed review (${problem}) — skipping it`);
        return;
      }
      accepted.push(candidate as ReviewResult);
    });
    if (accepted.length !== incoming.length) {
      ctx.log(
        'info',
        `merging ${accepted.length} of ${incoming.length} incoming review(s)`,
      );
    }

    // Concatenate, keeping each finding's own discipline; a finding authored
    // against the original single-discipline shape inherits its review's.
    const collected: ReviewFinding[] = [];
    for (const review of accepted) {
      for (const finding of review.findings) {
        collected.push({
          ...finding,
          discipline: (finding.discipline ?? review.discipline) as ReviewDiscipline,
        });
      }
    }

    const deduped: ReviewFinding[] = [];
    if (params.dedupe) {
      const seen = new Set<string>();
      for (const finding of collected) {
        const identity = identityOf(finding);
        if (seen.has(identity)) continue;
        seen.add(identity);
        deduped.push(finding);
      }
      const dropped = collected.length - deduped.length;
      if (dropped > 0) ctx.log('info', `dropped ${dropped} duplicate finding(s)`);
    } else {
      deduped.push(...collected);
    }

    // Sort worst-first, stably: the source index breaks every tie, so the order
    // is a function of the inputs alone.
    const ordered = params.sort_by_severity
      ? deduped
          .map((finding, index) => ({ finding, index }))
          .sort((a, b) => {
            const rank = SEVERITY_RANK[a.finding.severity] - SEVERITY_RANK[b.finding.severity];
            return rank !== 0 ? rank : a.index - b.index;
          })
          .map((entry) => entry.finding)
      : deduped;

    // Ids are assigned per review run, so the merged set always renumbers.
    const findings: ReviewFinding[] = ordered.map((finding, index) => ({
      ...finding,
      id: `f_${String(index + 1).padStart(3, '0')}`,
    }));

    const sources: MergedReviewSource[] = accepted.map((review) => ({
      reviewId: review.reviewId,
      discipline: review.discipline,
      standard: review.standard,
      summary: review.summary,
    }));

    const checked = accepted.reduce((sum, review) => sum + review.summary.checked, 0);
    const advisories = findings.filter((f) => f.severity === 'advisory').length;
    const warnings = findings.filter((f) => f.severity === 'warning').length;
    const violations = findings.filter((f) => f.severity === 'violation').length;

    const result: MergedReviewResult = {
      reviewId: `rev_${hex8(mulberry32(fnv1a(sources.map((s) => s.reviewId).join('|'))))}`,
      discipline: 'merged',
      engine: { name: 'mock-merge', version: '1.0.0' },
      standard: { name: 'multi-discipline', version: `${sources.length} reviews` },
      summary: {
        checked,
        passed: checked - findings.length,
        advisories,
        warnings,
        violations,
      },
      findings,
      sources,
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

    ctx.progress(1, `merged ${findings.length} finding(s) from ${sources.length} review(s)`);

    return {
      result: toValue(result),
      findings: toValue(findingsTable),
      violation_count: violations,
    };
  },
};
