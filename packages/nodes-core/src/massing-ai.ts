/**
 * The AI backend for `aec.generate_massing` — the model picks the shape, and
 * this file refuses to believe it (ARCHITECTURE §10 / ADR-0010).
 *
 * **What the model is asked for, and what it is not.** It returns a strategy,
 * a footprint ring, an optional upper-storey ring and a sentence of reasoning.
 * It is never asked for an area, a FAR, a lot coverage, a facade area or a
 * storey elevation — every one of those is arithmetic over the polygon it did
 * return, computed by `massing.ts` exactly as it computes them for the
 * deterministic backend. That split is the whole design. A model asked for
 * both a shape and its area will cheerfully return an area that is not the
 * area of that shape, and the disagreement surfaces three nodes later as an
 * IFC whose volumes do not match its own report.
 *
 * Scale is why massing is the node that gets this first. A `MassingResult`
 * footprint is a few dozen vertices — about a kilobyte — where a
 * `FloorPlanResult` is ~95 KB and some five thousand numbers governed by
 * invariants nothing in this repo validates. One is a request a model can
 * plausibly satisfy and a human can check at a glance; the other is not.
 *
 * **The gate is the feature.** `validateMassingProposal` is the reason this is
 * shippable: a footprint that leaves the buildable envelope, self-describes as
 * three collinear points, or carries a non-finite coordinate is rejected
 * before it becomes geometry. Rejection is `retryable` at the call site,
 * because re-sampling is precisely the remedy for a bad sample — and unlike
 * the deterministic backend, an unusable answer here is an expected outcome
 * rather than a bug.
 *
 * What the gate deliberately does NOT check: whether the scheme is any good.
 * A model can return a 3 m × 400 m bar that satisfies every rule below and no
 * architect would draw. `DAYLIGHT_DEPTH_M` and the tower fraction in
 * `massing.ts` are the mock's judgement, and a model has no equivalent floor —
 * so the prompt states the daylight rule and `aec.review.zoning` remains the
 * independent check, in the spirit of ADR-0016: the thing that verifies the
 * output must not be the thing that produced it.
 */
import type { JsonSchemaObject, Value } from '@archspace/node-sdk';
import type { MassingStrategy, ProjectBrief } from './shapes.js';

/** What the model is allowed to decide. */
export interface MassingProposal {
  strategy: MassingStrategy;
  /** Site-local metres, closed implicitly — the last vertex joins the first. */
  footprint: [number, number][];
  /**
   * The plate above `setbackAboveLevel`, when the scheme steps back. Absent
   * means every storey repeats the footprint.
   */
  upperFootprint?: [number, number][];
  /** First level that uses `upperFootprint`; ignored without one. */
  setbackAboveLevel?: number;
  /** One sentence, logged so a run says why it looks like this. */
  rationale: string;
}

/**
 * The schema the provider is constrained to.
 *
 * Hand-written rather than derived from `MassingProposal`: this repo ships no
 * schema generator, and a JSON Schema is a prompt as much as a contract — the
 * descriptions below are the only place the model is told that coordinates are
 * metres from the envelope corner, which is the single most important fact for
 * getting a usable answer.
 */
export const MASSING_PROPOSAL_SCHEMA: JsonSchemaObject = {
  type: 'object',
  properties: {
    strategy: {
      type: 'string',
      enum: ['bar', 'courtyard', 'l_shape', 'tower_podium'],
      description: 'The massing parti this footprint expresses.',
    },
    footprint: {
      type: 'array',
      minItems: 3,
      description:
        'The ground-storey outline as [x, y] pairs in METRES, measured from the buildable envelope corner at [0, 0]. Do not repeat the first point at the end; the ring closes implicitly. Every point must lie inside the envelope.',
      items: {
        type: 'array',
        minItems: 2,
        maxItems: 2,
        items: { type: 'number' },
      },
    },
    upperFootprint: {
      type: 'array',
      minItems: 3,
      description:
        'Optional. The smaller plate used above the setback level, in the same coordinates. Omit for a scheme with one repeating plate.',
      items: {
        type: 'array',
        minItems: 2,
        maxItems: 2,
        items: { type: 'number' },
      },
    },
    setbackAboveLevel: {
      type: 'integer',
      minimum: 1,
      description: 'The first 0-based level that uses upperFootprint.',
    },
    rationale: {
      type: 'string',
      description: 'One sentence on why this parti suits the brief and the site.',
    },
  },
  required: ['strategy', 'footprint', 'rationale'],
};

/** The daylight rule the deterministic backend applies as DAYLIGHT_DEPTH_M. */
const DAYLIGHT_DEPTH_M = 18;

export function massingPrompt(
  brief: ProjectBrief,
  envW: number,
  envD: number,
  storeyCount: number,
): string {
  const targetPerStorey = (brief.targetGrossAreaM2 / Math.max(1, storeyCount)).toFixed(0);
  return [
    `Design the massing for ${brief.projectName}, a ${brief.buildingType.replace('_', ' ')} building.`,
    '',
    `Buildable envelope: ${envW.toFixed(1)} m wide by ${envD.toFixed(1)} m deep, with its corner at [0, 0].`,
    `Storeys: ${storeyCount}. Target gross area: ${brief.targetGrossAreaM2} m², so roughly ${targetPerStorey} m² per storey.`,
    `Occupancy ${brief.occupancyClass} under ${brief.code.version}.`,
    brief.notes.trim() === '' ? '' : `Brief notes: ${brief.notes.trim()}`,
    '',
    'Rules the footprint must satisfy:',
    `- Every vertex lies within the envelope: x in [0, ${envW.toFixed(1)}], y in [0, ${envD.toFixed(1)}].`,
    `- No habitable space sits more than about ${DAYLIGHT_DEPTH_M} m from a facade, so a deep plate needs a courtyard or a slot rather than more depth.`,
    '- The ring must be simple and non-degenerate: at least three points, no repeated final point, positive area.',
    '',
    'Return only the shape. Areas, height, FAR, coverage and facade area are computed from your polygon, so do not estimate them.',
  ]
    .filter((line) => line !== '')
    .join('\n');
}

export type ProposalRejection =
  | { ok: true; proposal: MassingProposal }
  | { ok: false; why: string };

function isPolygon(value: unknown, at: string): { ok: true; ring: [number, number][] } | { ok: false; why: string } {
  if (!Array.isArray(value)) return { ok: false, why: `${at} is not an array of points` };
  if (value.length < 3) return { ok: false, why: `${at} has ${value.length} points; a ring needs at least 3` };
  const ring: [number, number][] = [];
  for (const point of value) {
    if (!Array.isArray(point) || point.length < 2) return { ok: false, why: `${at} holds a point that is not an [x, y] pair` };
    const [x, y] = point as unknown[];
    if (typeof x !== 'number' || typeof y !== 'number' || !Number.isFinite(x) || !Number.isFinite(y)) {
      return { ok: false, why: `${at} holds a point whose coordinates are not finite numbers` };
    }
    ring.push([x, y]);
  }
  return { ok: true, ring };
}

/** Shoelace area of a closed ring, in the polygon's own units. */
export function ringAreaM2(ring: readonly [number, number][]): number {
  let twice = 0;
  for (let i = 0; i < ring.length; i++) {
    const [x1, y1] = ring[i];
    const [x2, y2] = ring[(i + 1) % ring.length];
    twice += x1 * y2 - x2 * y1;
  }
  return Math.abs(twice) / 2;
}

const STRATEGIES: MassingStrategy[] = ['bar', 'courtyard', 'l_shape', 'tower_podium'];

/**
 * Everything that must be true before a sampled scheme becomes geometry.
 *
 * `tolM` exists because a model asked to fill a 48 m envelope will answer 48.0
 * and occasionally 48.000000001; refusing that would be pedantry that costs a
 * re-sample. It is a rounding tolerance and nothing more — a metre past the
 * boundary is still a refusal.
 */
export function validateMassingProposal(
  raw: unknown,
  envW: number,
  envD: number,
  storeyCount: number,
  tolM = 0.05,
): ProposalRejection {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { ok: false, why: 'the model did not return an object' };
  }
  const rec = raw as Record<string, unknown>;

  const strategy = rec['strategy'];
  if (typeof strategy !== 'string' || !STRATEGIES.includes(strategy as MassingStrategy)) {
    return { ok: false, why: `strategy ${JSON.stringify(strategy)} is not one of ${STRATEGIES.join(', ')}` };
  }

  const footprint = isPolygon(rec['footprint'], 'footprint');
  if (!footprint.ok) return footprint;

  const inside = (ring: readonly [number, number][], at: string): string | null => {
    for (const [x, y] of ring) {
      if (x < -tolM || y < -tolM || x > envW + tolM || y > envD + tolM) {
        return `${at} leaves the ${envW.toFixed(1)} × ${envD.toFixed(1)} m envelope at [${x}, ${y}]`;
      }
    }
    return null;
  };

  const outside = inside(footprint.ring, 'footprint');
  if (outside !== null) return { ok: false, why: outside };

  const area = ringAreaM2(footprint.ring);
  if (area <= 0) {
    // Collinear points, or a ring that folds back on itself exactly. Either
    // way there is no volume to build, and every metric below would be zero.
    return { ok: false, why: 'the footprint encloses no area — its points may be collinear' };
  }
  if (area > envW * envD + 1) {
    // A self-intersecting ring can report more area than the envelope holds
    // while every individual vertex sits inside it, so this is not implied by
    // the containment check above.
    return {
      ok: false,
      why: `the footprint encloses ${area.toFixed(0)} m², more than the ${(envW * envD).toFixed(0)} m² envelope — the ring may cross itself`,
    };
  }

  const proposal: MassingProposal = {
    strategy: strategy as MassingStrategy,
    footprint: footprint.ring,
    rationale: typeof rec['rationale'] === 'string' ? rec['rationale'] : '',
  };

  if (rec['upperFootprint'] !== undefined && rec['upperFootprint'] !== null) {
    const upper = isPolygon(rec['upperFootprint'], 'upperFootprint');
    if (!upper.ok) return upper;
    const upperOutside = inside(upper.ring, 'upperFootprint');
    if (upperOutside !== null) return { ok: false, why: upperOutside };
    if (ringAreaM2(upper.ring) <= 0) {
      return { ok: false, why: 'the upper footprint encloses no area' };
    }
    const level = rec['setbackAboveLevel'];
    // A setback plate with no level to start at describes nothing; rather than
    // guess a storey, take the plate and ignore it, which the caller sees as a
    // scheme with one repeating plate.
    if (typeof level === 'number' && Number.isInteger(level) && level >= 1 && level < storeyCount) {
      proposal.upperFootprint = upper.ring;
      proposal.setbackAboveLevel = level;
    }
  }

  return { ok: true, proposal };
}

/** The proposal as a wire value, for the log line that records what was asked. */
export function proposalSummary(proposal: MassingProposal): Value {
  return {
    strategy: proposal.strategy,
    footprintPoints: proposal.footprint.length,
    ...(proposal.setbackAboveLevel !== undefined ? { setbackAboveLevel: proposal.setbackAboveLevel } : {}),
  };
}
