/**
 * Text in, a ProjectBrief out — and the gate between them.
 *
 * This node is the head of the whole concept-design chain, so a brief it lets
 * through becomes a floor plan, a BIM model and a compliance report. Two
 * things therefore matter more than the happy path: that the brief it emits is
 * one `aec.project_brief`'s own form could have produced (same enums, same
 * bounds), and that an over-ambitious description is refused HERE rather than
 * three nodes later, where the message would name a generator instead of the
 * sentence that caused it.
 *
 * Every case runs the real node against a scripted gateway (testkit §4), so
 * none of it needs a key, a network or a provider.
 */
import { describe, expect, it } from 'vitest';
import { runNode } from '@archspace/node-sdk/testkit';
import { isRetryableError, type Value } from '@archspace/node-sdk';
import { briefFromTextNode, generateFloorPlanNode, spaceProgramNode } from '../src/index.js';
import type { ProjectBrief } from '../src/index.js';
import { validateBriefDraft } from '../src/brief-from-text.js';

/** What a well-behaved model returns for the placeholder description. */
const GOOD = {
  projectName: 'Riverside Offices',
  buildingType: 'office',
  codeVersion: 'IBC 2024',
  siteWidthM: 48,
  siteDepthM: 32,
  floors: 6,
  targetGrossAreaM2: 7500,
  occupancyClass: 'B',
  notes: 'Open-plan floors; the plot depth is assumed from the description.',
};

async function runText(object: unknown, description = 'A six-storey office on a 48 by 32 m plot.') {
  return runNode(briefFromTextNode, {
    params: { description },
    ai: { generateObject: () => Promise.resolve({ object: object as Value }) },
  });
}

describe('aec.brief_from_text', () => {
  it('emits the same brief shape aec.project_brief does', async () => {
    const run = await runText(GOOD);
    const brief = run.outputs.brief as unknown as ProjectBrief;

    expect(brief).toEqual({
      projectName: 'Riverside Offices',
      buildingType: 'office',
      code: { jurisdiction: 'IBC', version: 'IBC 2024' },
      // areaM2 is computed here, never taken from the model: it is the one
      // number in the brief that must agree with two others.
      site: { widthM: 48, depthM: 32, areaM2: 1536 },
      floors: 6,
      targetGrossAreaM2: 7500,
      occupancyClass: 'B',
      notes: 'Open-plan floors; the plot depth is assumed from the description.',
    });
  });

  it('feeds the rest of the chain, so text really does reach a floor plan', async () => {
    // The claim the node exists to make. If this passes, a description drives
    // the program, the plan and everything downstream of them.
    const brief = (await runText(GOOD)).outputs.brief as Value;
    const program = await runNode(spaceProgramNode, { inputs: { brief } });
    const plan = await runNode(generateFloorPlanNode, {
      params: { backend: 'mock', mock_latency_ms: 0 },
      inputs: { brief, program: program.outputs.program as Value },
    });

    const levels = (plan.outputs.floor_plan as unknown as { levels: unknown[] }).levels;
    expect(levels).toHaveLength(6);
  });

  it('appends anything wired to the text port to what was typed', async () => {
    let seenPrompt = '';
    await runNode(briefFromTextNode, {
      params: { description: 'A school.' },
      inputs: { text: 'The site is 60 by 40 m.' as unknown as Value },
      ai: {
        generateObject: (req) => {
          seenPrompt = req.prompt ?? '';
          return Promise.resolve({ object: GOOD as unknown as Value });
        },
      },
    });

    expect(seenPrompt).toContain('A school.');
    expect(seenPrompt).toContain('The site is 60 by 40 m.');
  });

  it('refuses to spend a call on an empty description', async () => {
    let called = false;
    const error = await runNode(briefFromTextNode, {
      params: { description: '   ' },
      ai: {
        generateObject: () => {
          called = true;
          return Promise.resolve({ object: GOOD as unknown as Value });
        },
      },
    }).catch((err: unknown) => err);

    expect((error as Error).message).toMatch(/nothing to work from/);
    expect(called).toBe(false);
  });

  it('names the project when the model did not', async () => {
    const run = await runText({ ...GOOD, projectName: '   ' });
    expect((run.outputs.brief as unknown as ProjectBrief).projectName).toBe('Untitled Project');
  });
});

describe('the gate refuses a brief the rest of the chain would choke on', () => {
  const cases: { name: string; object: unknown; why: RegExp }[] = [
    {
      name: 'a target area that does not fit the site',
      // 40,000 m² on 6 floors of a 1,536 m² site: 7,833 m² usable.
      object: { ...GOOD, targetGrossAreaM2: 40_000 },
      why: /does not fit 6 floor\(s\)/,
    },
    {
      name: 'a building type outside the vocabulary',
      object: { ...GOOD, buildingType: 'hospital' },
      why: /buildingType .* is not one of/,
    },
    {
      name: 'an occupancy class the reviews do not know',
      object: { ...GOOD, occupancyClass: 'F-1' },
      why: /occupancyClass .* is not one of/,
    },
    {
      name: 'a site smaller than the form allows',
      object: { ...GOOD, siteWidthM: 4 },
      why: /siteWidthM is 4, outside 10–500/,
    },
    {
      name: 'a fractional storey count',
      object: { ...GOOD, floors: 6.5 },
      why: /not a whole number/,
    },
    {
      name: 'more storeys than the form allows',
      object: { ...GOOD, floors: 90 },
      why: /floors is 90, outside 1–40/,
    },
    {
      name: 'something that is not an object',
      object: 'a nice building please',
      why: /did not return an object/,
    },
  ];

  for (const { name, object, why } of cases) {
    it(`rejects ${name}, retryably`, async () => {
      const error = await runText(object).catch((err: unknown) => err);

      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toMatch(why);
      // A brief is a sample; the remedy for a bad one is another sample, and
      // §7.5 gives the engine that decision.
      expect(isRetryableError(error)).toBe(true);
    });
  }

  it('states the capacity arithmetic, not just that it failed', async () => {
    const error = await runText({ ...GOOD, targetGrossAreaM2: 40_000 }).catch((err: unknown) => err);

    // The three numbers a person needs to fix the sentence they wrote.
    expect((error as Error).message).toContain('1536 m² site');
    expect((error as Error).message).toContain('7833.6 m² usable');
    expect((error as Error).message).toMatch(/ask for less area, more floors, or a bigger site/);
  });
});

describe('validateBriefDraft', () => {
  it('accepts a target exactly at the capacity ceiling', () => {
    // The boundary the floor plan uses is `>`, so equal must pass — otherwise
    // this node refuses briefs the next node would have accepted.
    const verdict = validateBriefDraft({ ...GOOD, targetGrossAreaM2: 6 * 1536 * 0.85 });
    expect(verdict.ok).toBe(true);
  });

  it('computes site area rather than trusting a model to multiply', () => {
    // The `areaM2` the model volunteered is 99,999 and is ignored; 30.5 x 20
    // is 610, and the target is sized to fit that rather than the fiction.
    const verdict = validateBriefDraft({
      ...GOOD,
      siteWidthM: 30.5,
      siteDepthM: 20,
      targetGrossAreaM2: 1000,
      areaM2: 99_999,
    });
    expect(verdict.ok).toBe(true);
    if (verdict.ok) expect(verdict.brief.site.areaM2).toBe(610);
  });
});
