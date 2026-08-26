/**
 * aec.review.zoning — MOCK of a zoning/planning-code checker.
 * Every check compares the ACTUAL massing metrics and footprint geometry
 * against the ACTUAL site constraints, so changing either upstream node
 * genuinely changes the findings. The ReviewResult shape (shapes.ts) is the
 * contract a real jurisdiction checker must return.
 *
 * There are no plan element ids at this stage of the design, so findings are
 * anchored to the massing id and to synthetic storey ids ("storey_4").
 */
import type { NodeModule, Value } from '@archspace/node-sdk';
import type {
  MassingResult,
  ProjectBrief,
  ReviewFinding,
  ReviewResult,
  SiteConstraints,
  TableValue,
} from '@archspace/nodes-core/shapes';
import { fnv1a, hex8, mulberry32, requireInput, round2, sleep, toValue } from '@archspace/nodes-core/util';

export interface ZoningReviewParams {
  include_advisory: boolean;
  mock_latency_ms: number;
}

/** Metres of slack allowed on a setback check before a vertex counts as out. */
const SETBACK_TOLERANCE_M = 0.01;

export const zoningReviewNode: NodeModule<ZoningReviewParams> = {
  manifest: {
    type: 'aec.review.zoning',
    version: 1,
    label: 'Zoning Review',
    description:
      "Mock zoning check: tests the massing scheme against the site's FAR, height, storey, coverage and setback limits.",
    category: 'Review',
    keywords: ['zoning', 'far', 'setback', 'envelope', 'mock'],
    caching: 'never',
    lane: 'ai',
    params: {
      type: 'object',
      properties: {
        include_advisory: {
          type: 'boolean',
          title: 'Include advisory findings',
          default: true,
        },
        mock_latency_ms: {
          type: 'integer',
          title: 'Mock latency (ms)',
          default: 700,
          minimum: 0,
        },
      },
    },
    inputs: [
      { id: 'constraints', type: 'json', label: 'Site constraints', required: true },
      { id: 'massing', type: 'json', label: 'Massing', required: true },
      { id: 'brief', type: 'json', label: 'Brief', required: false },
    ],
    outputs: [
      { id: 'result', type: 'json', label: 'Result' },
      { id: 'findings', type: 'table', label: 'Findings' },
    ],
  },

  async execute(ctx, inputs, params) {
    const constraints = requireInput<SiteConstraints>(inputs, 'constraints', 'aec.review.zoning');
    const massing = requireInput<MassingResult>(inputs, 'massing', 'aec.review.zoning');
    const brief = inputs.brief as unknown as ProjectBrief | undefined;
    if (brief === undefined) {
      ctx.log('info', 'no brief supplied — the programme-vs-envelope check (ZON-PRG-1) is skipped');
    }

    const limits = constraints.limits;
    const metrics = massing.metrics;

    ctx.progress(0.1, 'checking bulk limits');
    await sleep(params.mock_latency_ms / 3, ctx.signal);

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
        discipline: 'zoning',
        elementIds,
        // Zoning is checked before any BIM model exists, so there are no GUIDs.
        elementGuids: [],
      });
    };

    // ZON-FAR-1 — floor area ratio.
    checked++;
    if (metrics.far > limits.maxFar) {
      addFinding(
        'ZON-FAR-1',
        'Floor area ratio',
        'violation',
        `Scheme ${massing.massingId} has a floor area ratio of ${metrics.far} ` +
          `(${metrics.grossAreaM2} m² gross on a ${constraints.lot.areaM2} m² lot); ` +
          `${constraints.zoningDistrict} allows at most ${limits.maxFar}.`,
        null,
        [massing.massingId],
      );
    }

    // ZON-HGT-1 — building height.
    checked++;
    if (metrics.heightM > limits.maxHeightM) {
      addFinding(
        'ZON-HGT-1',
        'Building height',
        'violation',
        `Scheme ${massing.massingId} is ${metrics.heightM} m tall; ` +
          `${constraints.zoningDistrict} allows at most ${limits.maxHeightM} m ` +
          `(${round2(metrics.heightM - limits.maxHeightM)} m over).`,
        null,
        [massing.massingId],
      );
    }

    // ZON-STY-1 — storey count. The offending storeys are named individually.
    checked++;
    const storeyCount = massing.storeys.length;
    if (storeyCount > limits.maxStoreys) {
      addFinding(
        'ZON-STY-1',
        'Storey count',
        'violation',
        `Scheme ${massing.massingId} has ${storeyCount} storeys; ` +
          `${constraints.zoningDistrict} allows at most ${limits.maxStoreys}.`,
        null,
        massing.storeys
          .filter((s) => s.level >= limits.maxStoreys)
          .map((s) => `storey_${s.level}`),
      );
    }

    // ZON-COV-1 — lot coverage.
    checked++;
    if (metrics.lotCoveragePct > limits.maxLotCoveragePct) {
      addFinding(
        'ZON-COV-1',
        'Lot coverage',
        'violation',
        `Footprint of ${massing.footprint.areaM2} m² covers ${metrics.lotCoveragePct}% of the ` +
          `${constraints.lot.areaM2} m² lot; ${constraints.zoningDistrict} allows at most ` +
          `${limits.maxLotCoveragePct}%.`,
        null,
        [massing.massingId],
      );
    }

    ctx.progress(0.5, 'checking setbacks');
    await sleep(params.mock_latency_ms / 3, ctx.signal);

    // ZON-SET-1 — every footprint vertex must sit inside the buildable envelope
    // (the lot minus its setbacks), which is site-local 0..width × 0..depth.
    const buildable = constraints.buildable;
    massing.footprint.polygon.forEach(([x, y], index) => {
      checked++;
      const outside =
        x < -SETBACK_TOLERANCE_M ||
        y < -SETBACK_TOLERANCE_M ||
        x > buildable.widthM + SETBACK_TOLERANCE_M ||
        y > buildable.depthM + SETBACK_TOLERANCE_M;
      if (outside) {
        addFinding(
          'ZON-SET-1',
          'Setback encroachment',
          'violation',
          `Footprint vertex ${index} at (${round2(x)}, ${round2(y)}) m lies outside the buildable ` +
            `envelope of ${buildable.widthM} m × ${buildable.depthM} m ` +
            `(setbacks front ${constraints.setbacksM.front} m, rear ${constraints.setbacksM.rear} m, ` +
            `side ${constraints.setbacksM.side} m).`,
          null,
          [massing.massingId],
        );
      }
    });

    // ZON-PRG-1 — the brief itself may not be buildable on this site at all.
    if (brief !== undefined) {
      checked++;
      if (brief.targetGrossAreaM2 > constraints.maxGrossAreaM2) {
        addFinding(
          'ZON-PRG-1',
          'Programme exceeds the zoning envelope',
          'warning',
          `The brief asks for ${brief.targetGrossAreaM2} m² gross, but ${constraints.zoningDistrict} ` +
            `caps this lot at ${constraints.maxGrossAreaM2} m²; the programme is ` +
            `${round2(brief.targetGrossAreaM2 - constraints.maxGrossAreaM2)} m² over what may legally ` +
            `be built here.`,
          null,
          [massing.massingId],
        );
      }
    }

    // ZON-PRK-1 advisory — parking is a zoning obligation this mock never models.
    if (params.include_advisory) {
      checked++;
      const requiredSpaces = Math.ceil((metrics.grossAreaM2 / 100) * limits.minParkingPer100M2);
      addFinding(
        'ZON-PRK-1',
        'Parking provision not modelled',
        'advisory',
        `${constraints.zoningDistrict} requires ${limits.minParkingPer100M2} space(s) per 100 m², ` +
          `so ${metrics.grossAreaM2} m² gross needs ${requiredSpaces} parking space(s); none are ` +
          `modelled in this scheme.`,
        null,
        [massing.massingId],
      );
    }

    await sleep(params.mock_latency_ms / 3, ctx.signal);
    ctx.progress(1, 'review complete');

    const advisories = findings.filter((f) => f.severity === 'advisory').length;
    const warnings = findings.filter((f) => f.severity === 'warning').length;
    const violations = findings.filter((f) => f.severity === 'violation').length;

    const result: ReviewResult = {
      reviewId: `rev_${hex8(mulberry32(fnv1a(`${massing.massingId}:zoning`)))}`,
      discipline: 'zoning',
      engine: { name: 'mock-zoning-review', version: '1.0.0' },
      standard: { name: constraints.zoningDistrict, version: constraints.jurisdiction },
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

    return { result: toValue(result), findings: toValue(findingsTable) };
  },
};
