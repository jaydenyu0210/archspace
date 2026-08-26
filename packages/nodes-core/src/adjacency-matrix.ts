/**
 * aec.adjacency_matrix — the desired adjacencies between space functions for a
 * building type: the planning intent a layout is later judged against.
 *
 * The function vocabulary is exactly the one aec.space_program emits for the
 * same building type (space-program.ts TEMPLATES), so the matrix and the
 * program speak about the same rooms. Pure and deterministic: same brief +
 * params ⇒ identical matrix.
 */
import type { NodeModule, Value } from '@archspace/node-sdk';
import type {
  AdjacencyMatrixResult,
  AdjacencyRequirement,
  ProjectBrief,
  TableValue,
} from './shapes.js';
import { requireInput, toValue } from './util.js';

export interface AdjacencyMatrixParams {
  strictness: 'relaxed' | 'standard' | 'strict';
  include_avoid: boolean;
}

interface AdjacencyTemplate {
  /** The space-program functions for this building type, in program order. */
  functions: string[];
  requirements: AdjacencyRequirement[];
}

/** How many of the top `preferred` pairs 'strict' promotes to `required`. */
const STRICT_PROMOTIONS = 2;

/**
 * One template per building type. Requirements are listed most-important-first
 * — 'strict' promotes from the top of the list, 'relaxed' demotes from the
 * bottom, so ordering is part of the contract, not incidental.
 */
const TEMPLATES: Record<ProjectBrief['buildingType'], AdjacencyTemplate> = {
  office: {
    functions: ['open_workspace', 'enclosed_office', 'meeting', 'support', 'amenity', 'service'],
    requirements: [
      {
        from: 'open_workspace',
        to: 'meeting',
        weight: 'required',
        maxDistanceM: 30,
        rationale: 'Teams book meeting rooms from their desks; a long walk to a booked room is the commonest source of lost meeting time.',
      },
      {
        from: 'open_workspace',
        to: 'support',
        weight: 'required',
        maxDistanceM: 40,
        rationale: 'Print, copy and store rooms serve the whole floor plate and must be reachable without leaving it.',
      },
      {
        from: 'open_workspace',
        to: 'enclosed_office',
        weight: 'preferred',
        maxDistanceM: 25,
        rationale: 'Managers sit with their teams; enclosed offices should ring the open floor rather than occupy a separate wing.',
      },
      {
        from: 'open_workspace',
        to: 'amenity',
        weight: 'preferred',
        maxDistanceM: 60,
        rationale: 'Break space should be visible from the floor it serves, but far enough that its noise does not carry into it.',
      },
      {
        from: 'meeting',
        to: 'amenity',
        weight: 'preferred',
        maxDistanceM: 40,
        rationale: 'Meetings spill into the café before and after; pairing them turns circulation into informal collaboration space.',
      },
      {
        from: 'service',
        to: 'open_workspace',
        weight: 'avoid',
        maxDistanceM: null,
        rationale: 'Plant, risers and waste rooms generate noise and vibration; keep them off the primary work floor.',
      },
      {
        from: 'service',
        to: 'meeting',
        weight: 'avoid',
        maxDistanceM: null,
        rationale: 'Mechanical noise carries straight into meeting rooms and ruins audio conferencing.',
      },
    ],
  },
  residential: {
    functions: ['unit', 'amenity', 'support', 'service'],
    requirements: [
      {
        from: 'unit',
        to: 'support',
        weight: 'required',
        maxDistanceM: 30,
        rationale: 'Refuse, storage and laundry serve every home; residents must reach them from their own floor core.',
      },
      {
        from: 'support',
        to: 'service',
        weight: 'required',
        maxDistanceM: 20,
        rationale: 'Refuse rooms feed the service yard; a long haul across the ground floor makes daily operation fail.',
      },
      {
        from: 'unit',
        to: 'amenity',
        weight: 'preferred',
        maxDistanceM: 60,
        rationale: 'Shared lounges and terraces are the amenity residents pay for; keep them a short, obvious walk from the lift lobby.',
      },
      {
        from: 'amenity',
        to: 'support',
        weight: 'preferred',
        maxDistanceM: 40,
        rationale: 'Cleaners’ stores and WCs serving amenity space belong inside it, not across the building.',
      },
      {
        from: 'unit',
        to: 'service',
        weight: 'avoid',
        maxDistanceM: null,
        rationale: 'Plant rooms, transformers and refuse holding run noisy at all hours; they do not belong against habitable rooms.',
      },
      {
        from: 'amenity',
        to: 'service',
        weight: 'avoid',
        maxDistanceM: null,
        rationale: 'Amenity space backing onto plant is the classic post-occupancy complaint.',
      },
    ],
  },
  school: {
    functions: ['classroom', 'lab', 'admin', 'assembly', 'support', 'service'],
    requirements: [
      {
        from: 'classroom',
        to: 'lab',
        weight: 'required',
        maxDistanceM: 45,
        rationale: 'Science teaching moves between classroom and lab inside one period; the walk has to fit the changeover.',
      },
      {
        from: 'admin',
        to: 'assembly',
        weight: 'required',
        maxDistanceM: 40,
        rationale: 'Reception supervises the main entrance and the hall used for assemblies and out-of-hours hire.',
      },
      {
        from: 'classroom',
        to: 'support',
        weight: 'preferred',
        maxDistanceM: 40,
        rationale: 'WCs and stores serve teaching clusters; pupils should not cross the school to reach them.',
      },
      {
        from: 'classroom',
        to: 'admin',
        weight: 'preferred',
        maxDistanceM: 60,
        rationale: 'Pastoral support and first aid come from the office; every teaching cluster needs a legible route to it.',
      },
      {
        from: 'assembly',
        to: 'support',
        weight: 'preferred',
        maxDistanceM: 30,
        rationale: 'The hall doubles as dining and performance space and needs stores and WCs on its doorstep.',
      },
      {
        from: 'classroom',
        to: 'service',
        weight: 'avoid',
        maxDistanceM: null,
        rationale: 'Deliveries, plant and refuse must not cross teaching areas — a safeguarding requirement as much as an acoustic one.',
      },
      {
        from: 'lab',
        to: 'assembly',
        weight: 'avoid',
        maxDistanceM: null,
        rationale: 'Fume extraction and large assembly crowds mix badly; keep lab discharge clear of the hall.',
      },
    ],
  },
  mixed_use: {
    functions: ['retail', 'open_workspace', 'unit', 'amenity', 'service'],
    requirements: [
      {
        from: 'retail',
        to: 'service',
        weight: 'required',
        maxDistanceM: 40,
        rationale: 'Shops need back-of-house servicing and refuse on a dedicated route, never through the residential lobby.',
      },
      {
        from: 'unit',
        to: 'amenity',
        weight: 'required',
        maxDistanceM: 50,
        rationale: 'Residents’ amenity is the compensation for a dense block; it must be theirs, close, and secure.',
      },
      {
        from: 'open_workspace',
        to: 'amenity',
        weight: 'preferred',
        maxDistanceM: 60,
        rationale: 'The workplace floors share the amenity deck; a direct core connection is what keeps it used.',
      },
      {
        from: 'retail',
        to: 'open_workspace',
        weight: 'preferred',
        maxDistanceM: 50,
        rationale: 'Ground-floor retail feeds the office lobby at lunchtime and gives the workplace an address.',
      },
      {
        from: 'unit',
        to: 'retail',
        weight: 'avoid',
        maxDistanceM: null,
        rationale: 'Late-licence retail directly below apartments is the standard mixed-use noise complaint; separate them.',
      },
      {
        from: 'unit',
        to: 'open_workspace',
        weight: 'avoid',
        maxDistanceM: null,
        rationale: 'Residential and workplace entrances, cores and servicing stay distinct — shared circulation fails both tenures.',
      },
    ],
  },
};

/**
 * Strictness shifts weights without reordering or dropping rows:
 * - 'strict'  promotes the top STRICT_PROMOTIONS `preferred` pairs to `required`;
 * - 'relaxed' demotes every `required` pair but the first to `preferred`;
 * - 'standard' leaves the template as authored.
 * Every mode keeps at least one `required` pair.
 */
function applyStrictness(
  requirements: AdjacencyRequirement[],
  strictness: AdjacencyMatrixParams['strictness'],
): AdjacencyRequirement[] {
  const out: AdjacencyRequirement[] = [];
  let promoted = 0;
  let requiredKept = false;
  for (const req of requirements) {
    if (strictness === 'strict' && req.weight === 'preferred' && promoted < STRICT_PROMOTIONS) {
      promoted++;
      out.push({ ...req, weight: 'required' });
      continue;
    }
    if (strictness === 'relaxed' && req.weight === 'required') {
      if (!requiredKept) {
        requiredKept = true;
        out.push({ ...req });
        continue;
      }
      out.push({ ...req, weight: 'preferred' });
      continue;
    }
    out.push({ ...req });
  }
  return out;
}

export const adjacencyMatrixNode: NodeModule<AdjacencyMatrixParams> = {
  manifest: {
    type: 'aec.adjacency_matrix',
    version: 1,
    label: 'Adjacency Matrix',
    description:
      'The desired adjacencies between space functions for this building type — the planning intent a layout is later judged against.',
    category: 'Plan',
    keywords: ['adjacency', 'program', 'planning', 'brief'],
    caching: 'pure',
    lane: 'cpu',
    params: {
      type: 'object',
      properties: {
        strictness: {
          type: 'string',
          title: 'Strictness',
          enum: ['relaxed', 'standard', 'strict'],
          default: 'standard',
        },
        include_avoid: {
          type: 'boolean',
          title: 'Include "avoid" pairs',
          default: true,
        },
      },
    },
    inputs: [{ id: 'brief', type: 'json', label: 'Brief', required: true }],
    outputs: [
      { id: 'adjacency', type: 'json', label: 'Adjacency' },
      { id: 'matrix', type: 'table', label: 'Matrix' },
    ],
  },

  async execute(_ctx, inputs, params) {
    const brief = requireInput<ProjectBrief>(inputs, 'brief', 'aec.adjacency_matrix');
    const template = TEMPLATES[brief.buildingType];
    if (!template) {
      throw new Error(`aec.adjacency_matrix: unknown building type "${String(brief.buildingType)}"`);
    }

    const weighted = applyStrictness(template.requirements, params.strictness);
    const requirements = params.include_avoid ? weighted : weighted.filter((r) => r.weight !== 'avoid');

    const adjacency: AdjacencyMatrixResult = {
      buildingType: brief.buildingType,
      functions: [...template.functions],
      requirements,
    };

    const matrix: TableValue = {
      columns: [
        { id: 'from', label: 'From' },
        { id: 'to', label: 'To' },
        { id: 'weight', label: 'Weight' },
        { id: 'max_distance_m', label: 'Max distance (m)' },
        { id: 'rationale', label: 'Rationale' },
      ],
      rows: requirements.map(
        (r): Record<string, Value> => ({
          from: r.from,
          to: r.to,
          weight: r.weight,
          max_distance_m: r.maxDistanceM,
          rationale: r.rationale,
        }),
      ),
    };

    return { adjacency: toValue(adjacency), matrix: toValue(matrix) };
  },
};
