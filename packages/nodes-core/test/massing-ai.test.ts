/**
 * The AI massing backend, and the gate that makes it shippable.
 *
 * Every case here runs the real node with a SCRIPTED gateway (testkit §4), so
 * the whole path — prompt, schema, validation, geometry, metrics — is
 * exercised with no key, no network and no provider, exactly as ADR-0013
 * requires of anything CI runs.
 *
 * The cases that matter most are the refusals. A model that returns a
 * plausible-looking scheme which leaves the site, encloses nothing, or folds
 * over itself must never reach `MassingResult`, because everything downstream
 * — the zoning review, the structural grid, a report a person reads — treats
 * that shape as a fact about a building. Each refusal is asserted to be
 * RETRYABLE too: a bad sample is an expected outcome whose remedy is another
 * sample, and marking it otherwise would have the engine give up on the one
 * failure that reliably fixes itself.
 */
import { describe, expect, it } from 'vitest';
import { runNode } from '@archspace/node-sdk/testkit';
import { isRetryableError, type Value } from '@archspace/node-sdk';
import { generateMassingNode } from '../src/index.js';
import type { MassingResult, ProjectBrief } from '../src/index.js';
import { ringAreaM2, validateMassingProposal } from '../src/massing-ai.js';

const BRIEF: ProjectBrief = {
  projectName: 'Test Tower',
  buildingType: 'office',
  code: { jurisdiction: 'IBC', version: 'IBC 2024' },
  site: { widthM: 60, depthM: 40, areaM2: 2400 },
  floors: 4,
  targetGrossAreaM2: 4000,
  occupancyClass: 'B',
  notes: '',
};

/** A rectangle well inside the 60 × 40 m site. */
const GOOD_RING = [
  [0, 0],
  [40, 0],
  [40, 18],
  [0, 18],
];

/** Run the node on the ai backend with one scripted model answer. */
async function runAi(object: unknown) {
  return runNode(generateMassingNode, {
    params: { backend: 'ai', mock_latency_ms: 0 },
    inputs: { brief: BRIEF as unknown as Value },
    ai: { generateObject: () => Promise.resolve({ object: object as Value }) },
  });
}

describe('aec.generate_massing on the ai backend', () => {
  it('builds the storeys from the polygon the model returned', async () => {
    const run = await runAi({
      strategy: 'bar',
      footprint: GOOD_RING,
      rationale: 'A daylight-deep bar along the long edge.',
    });
    const massing = run.outputs.massing as unknown as MassingResult;

    expect(massing.generator.name).toBe('ai-massing');
    expect(massing.strategy).toBe('bar');
    expect(massing.footprint.polygon).toEqual(GOOD_RING);
    expect(massing.storeys).toHaveLength(4);
    // Every storey repeats the plate when no setback was proposed.
    for (const storey of massing.storeys) expect(storey.polygon).toEqual(GOOD_RING);
  });

  it('computes every metric from that polygon rather than asking for it', async () => {
    const run = await runAi({ strategy: 'bar', footprint: GOOD_RING, rationale: '' });
    const massing = run.outputs.massing as unknown as MassingResult;

    // 40 × 18 = 720 m² per plate, four of them.
    expect(massing.footprint.areaM2).toBe(720);
    expect(massing.metrics.grossAreaM2).toBe(2880);
    expect(massing.metrics.heightM).toBe(14);
    // FAR and coverage are against the 2400 m² lot.
    expect(massing.metrics.far).toBeCloseTo(1.2, 3);
    expect(massing.metrics.lotCoveragePct).toBe(30);
    // Facade is the ring perimeter × height: (40+18)×2 × 14.
    expect(massing.metrics.facadeAreaM2).toBe(1624);
  });

  it('ignores any areas the model volunteers, because it is never asked for them', async () => {
    // A model that answers with both a shape and its measurements will
    // eventually contradict itself. The node reads the polygon and nothing
    // else, so a wrong number here can only be wrong in the model's reply —
    // never in the result.
    const run = await runAi({
      strategy: 'bar',
      footprint: GOOD_RING,
      rationale: '',
      metrics: { grossAreaM2: 99999, far: 42 },
      footprintAreaM2: 1,
    });
    const massing = run.outputs.massing as unknown as MassingResult;

    expect(massing.metrics.grossAreaM2).toBe(2880);
    expect(massing.metrics.far).toBeCloseTo(1.2, 3);
  });

  it('steps the upper storeys back when the model proposes a setback', async () => {
    const upper = [
      [5, 2],
      [30, 2],
      [30, 14],
      [5, 14],
    ];
    const run = await runAi({
      strategy: 'tower_podium',
      footprint: GOOD_RING,
      upperFootprint: upper,
      setbackAboveLevel: 2,
      rationale: 'Podium to the street, tower set back above.',
    });
    const massing = run.outputs.massing as unknown as MassingResult;

    expect(massing.storeys.map((s) => s.polygon)).toEqual([GOOD_RING, GOOD_RING, upper, upper]);
    // 720 + 720 + 300 + 300
    expect(massing.metrics.grossAreaM2).toBe(2040);
  });

  it('records the reasoning in the run log, where a person reads it', async () => {
    const run = await runAi({
      strategy: 'l_shape',
      footprint: GOOD_RING,
      rationale: 'An L wraps the corner and keeps the courtyard open to the south.',
    });

    expect(run.logs.map((l) => l.message)).toContain(
      'An L wraps the corner and keeps the courtyard open to the south.',
    );
  });
});

describe('the gate refuses a scheme that is not buildable', () => {
  const cases: { name: string; object: unknown; why: RegExp }[] = [
    {
      name: 'a footprint that leaves the site',
      object: { strategy: 'bar', footprint: [[0, 0], [80, 0], [80, 18], [0, 18]], rationale: '' },
      why: /leaves the .* envelope/,
    },
    {
      name: 'three collinear points, which enclose nothing',
      object: { strategy: 'bar', footprint: [[0, 0], [10, 0], [20, 0]], rationale: '' },
      why: /encloses no area/,
    },
    {
      name: 'a ring with too few points',
      object: { strategy: 'bar', footprint: [[0, 0], [10, 10]], rationale: '' },
      why: /at least 3/,
    },
    {
      name: 'a coordinate that is not a number',
      object: { strategy: 'bar', footprint: [[0, 0], ['x', 0], [10, 10]], rationale: '' },
      why: /finite numbers/,
    },
    {
      name: 'a strategy outside the vocabulary',
      object: { strategy: 'blob', footprint: GOOD_RING, rationale: '' },
      why: /is not one of/,
    },
    {
      name: 'something that is not an object at all',
      object: [1, 2, 3],
      why: /did not return an object/,
    },
  ];

  for (const { name, object, why } of cases) {
    it(`rejects ${name}, retryably`, async () => {
      const error = await runAi(object).catch((err: unknown) => err);

      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toMatch(why);
      // The remedy for a bad sample is another sample; §7.5 gives the engine
      // that decision, and it can only make it if the mark is here.
      expect(isRetryableError(error)).toBe(true);
    });
  }
});

describe('validateMassingProposal', () => {
  it('accepts a vertex a rounding error outside the envelope, and not a metre', () => {
    const nearly = [[0, 0], [60.000001, 0], [60.000001, 40], [0, 40]];
    expect(validateMassingProposal({ strategy: 'bar', footprint: nearly, rationale: '' }, 60, 40, 2).ok).toBe(true);

    const past = [[0, 0], [61, 0], [61, 40], [0, 40]];
    expect(validateMassingProposal({ strategy: 'bar', footprint: past, rationale: '' }, 60, 40, 2).ok).toBe(false);
  });

  it('drops a setback plate whose level is not a storey this building has', () => {
    // Every vertex is legal, so this is not a rejection — it is a scheme with
    // one repeating plate, which is what a setback above the roof describes.
    const verdict = validateMassingProposal(
      {
        strategy: 'tower_podium',
        footprint: GOOD_RING,
        upperFootprint: [[1, 1], [5, 1], [5, 5], [1, 5]],
        setbackAboveLevel: 9,
        rationale: '',
      },
      60,
      40,
      4,
    );

    expect(verdict.ok).toBe(true);
    if (verdict.ok) {
      expect(verdict.proposal.upperFootprint).toBeUndefined();
      expect(verdict.proposal.setbackAboveLevel).toBeUndefined();
    }
  });

  it('catches a self-crossing ring that keeps every vertex inside the site', () => {
    // A bow-tie: containment alone cannot see this, and its shoelace area is
    // not the area of anything you could build.
    const bowtie = [[0, 0], [60, 40], [60, 0], [0, 40]];
    const verdict = validateMassingProposal({ strategy: 'bar', footprint: bowtie, rationale: '' }, 60, 40, 2);

    // The bow-tie's signed halves cancel, so it reads as enclosing nothing —
    // which is the correct refusal even though the reason differs from the
    // oversized case the area ceiling catches.
    expect(verdict.ok).toBe(false);
  });
});

describe('ringAreaM2', () => {
  it('measures a ring whichever way round it is wound', () => {
    const square: [number, number][] = [[0, 0], [10, 0], [10, 10], [0, 10]];
    expect(ringAreaM2(square)).toBe(100);
    expect(ringAreaM2([...square].reverse())).toBe(100);
  });
});
