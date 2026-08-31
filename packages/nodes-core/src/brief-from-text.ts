/**
 * aec.brief_from_text — a paragraph of English becomes a ProjectBrief
 * (ARCHITECTURE §10 / ADR-0010).
 *
 * The front door to the whole concept-design chain. `aec.project_brief` asks
 * for nine fields in a form; this node asks for a sentence and works them out,
 * emitting the SAME `brief` shape on the same `json` port, so it is a drop-in
 * swap at the head of any existing workflow. Text in, and with the AI-backed
 * massing and floor-plan backends downstream, an IFC model out.
 *
 * **It is asked for the brief, not for the building.** Nine scalars — a name,
 * a type, a code version, two site dimensions, a storey count, a target area,
 * an occupancy class and the notes — is a request a model answers reliably and
 * a person can check at a glance. That is the whole reason this node exists
 * where it does: the semantic layer is where a model earns its keep, and every
 * coordinate downstream is still computed by code (the split ADR-0016's lesson
 * argues for, applied one node earlier).
 *
 * **No mock backend, deliberately.** `aec.generate_massing` and
 * `aec.generate_floor_plan` default to `auto` and fall back to a deterministic
 * scheme when no model answers, because a deterministic scheme is a real
 * answer to their question. There is no deterministic way to read a paragraph,
 * and a node that quietly emitted a default brief while ignoring what the user
 * typed would be worse than one that says it cannot work — so this one fails,
 * with the gateway's own sentence naming where to bind a profile. It is
 * therefore not a bundled example: CI runs every workflow in
 * `packages/app/resources` with no key, and an example that cannot run is not
 * an example. `docs/examples/text-to-bim.archspace.yaml` is where it lives.
 *
 * **The capacity rule is checked HERE.** `aec.generate_floor_plan` throws when
 * the target area does not fit the site — a real, deliberate failure, but one
 * that surfaces three nodes downstream of the sentence that caused it. The
 * same arithmetic runs in the gate below, so an over-ambitious description is
 * refused while the description is still the thing on screen, and refused
 * retryably so the model can try smaller.
 */
import type { JsonSchemaObject, NodeModule, Value } from '@archspace/node-sdk';
import type { ProjectBrief } from './shapes.js';
import { describeProfile, MODEL_PROFILE_PARAM, requestedProfile } from './ai-common.js';
import { round2, toValue } from './util.js';

export interface BriefFromTextParams {
  profile: string;
  description: string;
}

/** The enums `aec.project_brief` offers, restated as the model's vocabulary. */
const BUILDING_TYPES = ['office', 'residential', 'school', 'mixed_use'] as const;
const CODE_VERSIONS = ['IBC 2024', 'IBC 2021'] as const;
const OCCUPANCY_CLASSES = ['A-2', 'B', 'E', 'R-2', 'M'] as const;

/**
 * The bounds `aec.project_brief`'s own params declare. Restated rather than
 * imported because they are that node's form constraints; a brief this node
 * produced that the form could not have is a brief the user cannot then edit.
 */
const SITE_MIN_M = 10;
const SITE_MAX_M = 500;
const FLOORS_MAX = 40;
const MIN_AREA_M2 = 100;

/** The coverage the floor-plan generator allows — its capacity rule, exactly. */
const USABLE_COVERAGE = 0.85;

export const BRIEF_SCHEMA: JsonSchemaObject = {
  type: 'object',
  properties: {
    projectName: { type: 'string', description: 'A short project name. Invent one if the text does not give it.' },
    buildingType: { type: 'string', enum: [...BUILDING_TYPES] },
    codeVersion: { type: 'string', enum: [...CODE_VERSIONS], description: 'Default to IBC 2024 unless the text says otherwise.' },
    siteWidthM: { type: 'number', description: `Site width in metres, ${SITE_MIN_M}–${SITE_MAX_M}.` },
    siteDepthM: { type: 'number', description: `Site depth in metres, ${SITE_MIN_M}–${SITE_MAX_M}.` },
    floors: { type: 'integer', description: `Number of storeys, 1–${FLOORS_MAX}.` },
    targetGrossAreaM2: { type: 'number', description: 'Total gross floor area wanted, in square metres.' },
    occupancyClass: {
      type: 'string',
      enum: [...OCCUPANCY_CLASSES],
      description: 'IBC occupancy: A-2 assembly, B business, E educational, R-2 residential, M mercantile.',
    },
    notes: { type: 'string', description: 'One or two sentences of design intent, in your own words.' },
  },
  required: [
    'projectName',
    'buildingType',
    'codeVersion',
    'siteWidthM',
    'siteDepthM',
    'floors',
    'targetGrossAreaM2',
    'occupancyClass',
    'notes',
  ],
};

export function briefPrompt(description: string): string {
  return [
    'Turn this description into a project brief.',
    '',
    description.trim(),
    '',
    'Fill in anything the description leaves out with a professionally sensible value for that building type, and say so in the notes.',
    `The target gross area must fit the site: it cannot exceed floors x (width x depth) x ${USABLE_COVERAGE}, because the layout generator refuses more.`,
  ].join('\n');
}

export type BriefVerdict = { ok: true; brief: ProjectBrief } | { ok: false; why: string };

function oneOf<T extends string>(value: unknown, allowed: readonly T[], field: string): T | string {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value)
    ? (value as T)
    : `${field} ${JSON.stringify(value)} is not one of ${allowed.join(', ')}`;
}

function inRange(value: unknown, lo: number, hi: number, field: string): number | string {
  if (typeof value !== 'number' || !Number.isFinite(value)) return `${field} is not a number`;
  if (value < lo || value > hi) return `${field} is ${value}, outside ${lo}–${hi}`;
  return value;
}

/**
 * Everything that must hold before a sampled brief becomes the head of a
 * workflow. Each bound is one the form-based node already enforces, plus the
 * capacity rule the floor plan would otherwise raise three nodes later.
 */
export function validateBriefDraft(raw: unknown): BriefVerdict {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { ok: false, why: 'the model did not return an object' };
  }
  const rec = raw as Record<string, unknown>;

  const buildingType = oneOf(rec['buildingType'], BUILDING_TYPES, 'buildingType');
  if (typeof buildingType === 'string' && !(BUILDING_TYPES as readonly string[]).includes(buildingType)) {
    return { ok: false, why: buildingType };
  }
  const codeVersion = oneOf(rec['codeVersion'], CODE_VERSIONS, 'codeVersion');
  if (!(CODE_VERSIONS as readonly string[]).includes(codeVersion)) return { ok: false, why: codeVersion };
  const occupancyClass = oneOf(rec['occupancyClass'], OCCUPANCY_CLASSES, 'occupancyClass');
  if (!(OCCUPANCY_CLASSES as readonly string[]).includes(occupancyClass)) {
    return { ok: false, why: occupancyClass };
  }

  const widthM = inRange(rec['siteWidthM'], SITE_MIN_M, SITE_MAX_M, 'siteWidthM');
  if (typeof widthM === 'string') return { ok: false, why: widthM };
  const depthM = inRange(rec['siteDepthM'], SITE_MIN_M, SITE_MAX_M, 'siteDepthM');
  if (typeof depthM === 'string') return { ok: false, why: depthM };
  const floors = inRange(rec['floors'], 1, FLOORS_MAX, 'floors');
  if (typeof floors === 'string') return { ok: false, why: floors };
  if (!Number.isInteger(floors)) return { ok: false, why: `floors is ${floors}, which is not a whole number` };
  const targetGrossAreaM2 = inRange(rec['targetGrossAreaM2'], MIN_AREA_M2, Number.MAX_SAFE_INTEGER, 'targetGrossAreaM2');
  if (typeof targetGrossAreaM2 === 'string') return { ok: false, why: targetGrossAreaM2 };

  const areaM2 = round2(widthM * depthM);
  const usableM2 = round2(floors * areaM2 * USABLE_COVERAGE);
  if (targetGrossAreaM2 > usableM2) {
    // The same sum aec.generate_floor_plan runs. Caught here, the message can
    // still point at the sentence that caused it.
    return {
      ok: false,
      why:
        `${targetGrossAreaM2} m² does not fit ${floors} floor(s) on a ${areaM2} m² site ` +
        `(${usableM2} m² usable at ${USABLE_COVERAGE * 100}% coverage) — ask for less area, more floors, or a bigger site`,
    };
  }

  const projectName = typeof rec['projectName'] === 'string' && rec['projectName'].trim() !== ''
    ? rec['projectName'].trim()
    : 'Untitled Project';

  return {
    ok: true,
    brief: {
      projectName,
      buildingType: buildingType as ProjectBrief['buildingType'],
      code: { jurisdiction: 'IBC', version: codeVersion },
      site: { widthM: round2(widthM), depthM: round2(depthM), areaM2 },
      floors,
      targetGrossAreaM2: round2(targetGrossAreaM2),
      occupancyClass,
      notes: typeof rec['notes'] === 'string' ? rec['notes'] : '',
    },
  };
}

export const briefFromTextNode: NodeModule<BriefFromTextParams> = {
  manifest: {
    type: 'aec.brief_from_text',
    version: 1,
    label: 'Brief from Text',
    description:
      'Describe a building in a sentence and get the project brief the rest of the chain consumes — same shape as Project Brief, so it drops in at the head of any workflow.',
    category: 'Plan',
    keywords: ['brief', 'text', 'prompt', 'ai', 'concept'],
    // A model call is not a function of its inputs (§5.2), and the memo key
    // cannot see which provider a profile name resolved to on this machine.
    caching: 'never',
    lane: 'ai',
    permissions: [],
    params: {
      type: 'object',
      properties: {
        description: {
          type: 'string',
          title: 'Description',
          description: 'What you want, in plain words. Anything wired to the text port is appended.',
          default: '',
          'x-archspace': {
            widget: 'textarea',
            rows: 6,
            placeholder:
              'A six-storey speculative office on a 48 by 32 m riverside plot, about 7,500 m², open-plan floors.',
          },
        },
        profile: MODEL_PROFILE_PARAM,
      },
    },
    inputs: [{ id: 'text', type: 'text', label: 'Text', required: false }],
    outputs: [{ id: 'brief', type: 'json', label: 'Brief' }],
  },

  async execute(ctx, inputs, params) {
    const wired = typeof inputs.text === 'string' ? inputs.text.trim() : '';
    const written = params.description.trim();
    const description = [written, wired].filter((part) => part !== '').join('\n\n');
    if (description === '') {
      throw new Error(
        'aec.brief_from_text: nothing to work from — describe the building in the Description field, or wire the text port',
      );
    }

    const profile = requestedProfile(params.profile);
    ctx.progress(0.1, `asking ${describeProfile(profile)} to read the description`);

    // No try/catch: when no profile is bound the gateway throws an error whose
    // message already names Settings → AI model profiles, and rewriting it
    // would replace the one sentence the user can act on. There is no mock to
    // fall back to here — see the header.
    const { object } = await ctx.ai.generateObject({
      schema: BRIEF_SCHEMA,
      system:
        'You are an architect writing a concept brief. Answer with the brief only: names, dimensions, storeys, areas and occupancy.',
      prompt: briefPrompt(description),
      signal: ctx.signal,
      ...(profile !== undefined ? { profile } : {}),
    });

    const verdict = validateBriefDraft(object);
    if (!verdict.ok) {
      throw ctx.retryable(
        new Error(`aec.brief_from_text: the brief the model wrote is not usable — ${verdict.why}`),
      );
    }

    const brief = verdict.brief;
    ctx.progress(
      1,
      `${brief.projectName}: ${brief.floors} storey(s), ${brief.targetGrossAreaM2} m² on ${brief.site.widthM} × ${brief.site.depthM} m`,
    );
    return { brief: toValue(brief) as Value };
  },
};
