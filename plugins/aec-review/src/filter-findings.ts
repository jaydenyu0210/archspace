/**
 * aec.review.filter_findings — narrows a review down to the findings you
 * actually intend to act on. Pure and instant: no backend stands behind it.
 *
 * The node exists because the review → modify → report loop needs a place to
 * say "fix the violations, ignore the advisories" WITHOUT the fixer growing a
 * severity policy of its own. It preserves the ReviewResult shape exactly
 * (shapes.ts), recomputing `summary` so downstream consumers never see a
 * summary that disagrees with the findings beside it — a filtered review is
 * still a well-formed review, which is what lets it feed aec.apply_plan_fixes
 * and aec.generate_compliance_report unchanged.
 */
import type { NodeModule, Value } from '@archspace/node-sdk';
import type {
  FindingSeverity,
  ReviewDiscipline,
  ReviewFinding,
  ReviewResult,
  TableValue,
} from '@archspace/nodes-core/shapes';
import { toValue } from '@archspace/nodes-core/util';

export interface FilterFindingsParams {
  include_violations: boolean;
  include_warnings: boolean;
  include_advisories: boolean;
  disciplines: string;
  rule_prefix: string;
  renumber: boolean;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Parse the comma-separated discipline allowlist; empty means "all". */
function parseDisciplines(raw: string): Set<string> {
  return new Set(
    raw
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter((s) => s.length > 0),
  );
}

export const filterFindingsNode: NodeModule<FilterFindingsParams> = {
  manifest: {
    type: 'aec.review.filter_findings',
    version: 1,
    label: 'Filter Findings',
    description:
      'Narrows a review to the findings worth acting on — by severity, discipline or rule prefix — and recomputes the summary so the result is still a well-formed review.',
    category: 'Review',
    keywords: ['filter', 'findings', 'severity', 'triage'],
    caching: 'pure',
    lane: 'cpu',
    params: {
      type: 'object',
      properties: {
        include_violations: {
          type: 'boolean',
          title: 'Keep violations',
          description: 'Findings that break a mandatory requirement.',
          default: true,
        },
        include_warnings: {
          type: 'boolean',
          title: 'Keep warnings',
          description: 'Findings that are close to a limit or need a judgement call.',
          default: true,
        },
        include_advisories: {
          type: 'boolean',
          title: 'Keep advisories',
          description: 'Informational findings.',
          default: false,
        },
        disciplines: {
          type: 'string',
          title: 'Disciplines',
          description:
            'Comma-separated allowlist (code, accessibility, zoning, structural, energy). Empty keeps every discipline.',
          default: '',
          'x-archspace': { placeholder: 'code, accessibility' },
        },
        rule_prefix: {
          type: 'string',
          title: 'Rule id prefix',
          description: 'Keep only findings whose rule id starts with this, e.g. "IBC-1010". Empty keeps all rules.',
          default: '',
          'x-archspace': { placeholder: 'IBC-' },
        },
        renumber: {
          type: 'boolean',
          title: 'Renumber kept findings',
          description: 'Reassign f_001… over the kept set. Off keeps the original ids for traceability.',
          default: false,
        },
      },
    },
    inputs: [{ id: 'review', type: 'json', label: 'Review', required: true }],
    outputs: [
      { id: 'result', type: 'json', label: 'Result' },
      { id: 'findings', type: 'table', label: 'Findings' },
      { id: 'kept_count', type: 'number', label: 'Kept' },
      { id: 'dropped_count', type: 'number', label: 'Dropped' },
    ],
  },

  async execute(ctx, inputs, params) {
    const incoming = inputs.review;
    if (incoming === undefined || incoming === null) {
      throw new Error('aec.review.filter_findings: required input "review" is missing');
    }
    if (!isRecord(incoming) || !Array.isArray(incoming.findings)) {
      throw new Error(
        'aec.review.filter_findings: input "review" is not a review result — expected an object with a findings array',
      );
    }
    const review = incoming as unknown as ReviewResult;

    const severities = new Set<FindingSeverity>();
    if (params.include_violations) severities.add('violation');
    if (params.include_warnings) severities.add('warning');
    if (params.include_advisories) severities.add('advisory');
    if (severities.size === 0) {
      ctx.log('warn', 'every severity is switched off — this filter keeps nothing');
    }

    const disciplines = parseDisciplines(params.disciplines);
    const prefix = params.rule_prefix.trim();

    const kept = review.findings.filter((finding) => {
      if (!severities.has(finding.severity)) return false;
      if (disciplines.size > 0) {
        const discipline = (finding.discipline ?? review.discipline) as ReviewDiscipline;
        if (!disciplines.has(String(discipline).toLowerCase())) return false;
      }
      if (prefix.length > 0 && !finding.ruleId.startsWith(prefix)) return false;
      return true;
    });

    const findings: ReviewFinding[] = params.renumber
      ? kept.map((finding, index) => ({ ...finding, id: `f_${String(index + 1).padStart(3, '0')}` }))
      : kept.map((finding) => ({ ...finding }));

    const dropped = review.findings.length - findings.length;

    // The summary must agree with the findings beside it. `checked` is a
    // property of the review that ran, not of this filter, so it is carried
    // through untouched and `passed` is recomputed against it.
    const advisories = findings.filter((f) => f.severity === 'advisory').length;
    const warnings = findings.filter((f) => f.severity === 'warning').length;
    const violations = findings.filter((f) => f.severity === 'violation').length;

    const result: ReviewResult = {
      ...review,
      summary: {
        checked: review.summary.checked,
        passed: review.summary.checked - findings.length,
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

    ctx.progress(1, `kept ${findings.length} of ${review.findings.length} finding(s)`);

    return {
      result: toValue(result),
      findings: toValue(findingsTable),
      kept_count: findings.length,
      dropped_count: dropped,
    };
  },
};
