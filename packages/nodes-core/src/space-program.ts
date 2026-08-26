/**
 * aec.space_program — deterministic space program derivation from the brief.
 * No latency, no seed: same brief + params ⇒ identical table and summary.
 */
import type { NodeModule, Value } from '@archspace/node-sdk';
import type { ProjectBrief, SpaceProgramSummary, TableValue } from './shapes.js';
import { requireInput, round2, round3, toValue } from './util.js';

export interface SpaceProgramParams {
  circulation_factor: number;
  avg_area_per_person_m2: number;
}

interface TemplatePart {
  function: string;
  name: string;
  fraction: number; // fractions per building type sum to 1
  unitM2: number; // plausible room unit size
}

const TEMPLATES: Record<ProjectBrief['buildingType'], TemplatePart[]> = {
  office: [
    { function: 'open_workspace', name: 'Open workspace', fraction: 0.42, unitM2: 80 },
    { function: 'enclosed_office', name: 'Office', fraction: 0.13, unitM2: 12 },
    { function: 'meeting', name: 'Meeting room', fraction: 0.12, unitM2: 20 },
    { function: 'support', name: 'Support', fraction: 0.08, unitM2: 25 },
    { function: 'amenity', name: 'Amenity', fraction: 0.1, unitM2: 60 },
    { function: 'service', name: 'Service', fraction: 0.15, unitM2: 40 },
  ],
  residential: [
    { function: 'unit', name: 'Residential unit', fraction: 0.62, unitM2: 65 },
    { function: 'amenity', name: 'Amenity', fraction: 0.1, unitM2: 60 },
    { function: 'support', name: 'Support', fraction: 0.08, unitM2: 25 },
    { function: 'service', name: 'Service', fraction: 0.2, unitM2: 40 },
  ],
  school: [
    { function: 'classroom', name: 'Classroom', fraction: 0.45, unitM2: 60 },
    { function: 'lab', name: 'Laboratory', fraction: 0.12, unitM2: 90 },
    { function: 'admin', name: 'Admin office', fraction: 0.1, unitM2: 15 },
    { function: 'assembly', name: 'Assembly space', fraction: 0.13, unitM2: 150 },
    { function: 'support', name: 'Support', fraction: 0.05, unitM2: 25 },
    { function: 'service', name: 'Service', fraction: 0.15, unitM2: 40 },
  ],
  mixed_use: [
    { function: 'retail', name: 'Retail unit', fraction: 0.2, unitM2: 120 },
    { function: 'open_workspace', name: 'Open workspace', fraction: 0.3, unitM2: 80 },
    { function: 'unit', name: 'Residential unit', fraction: 0.25, unitM2: 65 },
    { function: 'amenity', name: 'Amenity', fraction: 0.1, unitM2: 60 },
    { function: 'service', name: 'Service', fraction: 0.15, unitM2: 40 },
  ],
};

export const spaceProgramNode: NodeModule<SpaceProgramParams> = {
  manifest: {
    type: 'aec.space_program',
    version: 1,
    label: 'Space Program',
    description:
      'Derives a deterministic space program (rooms, functions, levels, occupant loads) from the project brief.',
    category: 'Plan',
    keywords: ['program', 'spaces', 'rooms', 'schedule'],
    caching: 'pure',
    lane: 'cpu',
    params: {
      type: 'object',
      properties: {
        circulation_factor: {
          type: 'number',
          title: 'Circulation factor',
          default: 0.35,
          minimum: 0.15,
          maximum: 0.6,
        },
        avg_area_per_person_m2: {
          type: 'number',
          title: 'Average area per person (m²)',
          default: 9.3,
          minimum: 2,
        },
      },
    },
    inputs: [{ id: 'brief', type: 'json', label: 'Brief', required: true }],
    outputs: [
      { id: 'program', type: 'table', label: 'Program' },
      { id: 'summary', type: 'json', label: 'Summary' },
    ],
  },

  async execute(_ctx, inputs, params) {
    const brief = requireInput<ProjectBrief>(inputs, 'brief', 'aec.space_program');
    const template = TEMPLATES[brief.buildingType];
    if (!template) {
      throw new Error(`aec.space_program: unknown building type "${String(brief.buildingType)}"`);
    }

    const netAreaM2 = brief.targetGrossAreaM2 * (1 - params.circulation_factor);
    const rows: Record<string, Value>[] = [];
    let index = 0;
    for (const part of template) {
      const functionArea = netAreaM2 * part.fraction;
      const count = Math.max(1, Math.round(functionArea / part.unitM2));
      const roomArea = round2(functionArea / count);
      for (let i = 0; i < count; i++) {
        const level = index % brief.floors; // round-robin across floors
        rows.push({
          space_id: `sp_${String(index + 1).padStart(3, '0')}`,
          name: `${part.name} ${i + 1}`,
          function: part.function,
          level,
          area_m2: roomArea,
          occupant_load: Math.ceil(roomArea / params.avg_area_per_person_m2),
        });
        index++;
      }
    }

    const program: TableValue = {
      columns: [
        { id: 'space_id', label: 'Space' },
        { id: 'name', label: 'Name' },
        { id: 'function', label: 'Function' },
        { id: 'level', label: 'Level' },
        { id: 'area_m2', label: 'Area (m²)' },
        { id: 'occupant_load', label: 'Occupant load' },
      ],
      rows,
    };

    const netSum = round2(rows.reduce((s, r) => s + (r.area_m2 as number), 0));
    const perLevel: SpaceProgramSummary['perLevel'] = [];
    for (let level = 0; level < brief.floors; level++) {
      const levelRows = rows.filter((r) => r.level === level);
      perLevel.push({
        level,
        areaM2: round2(levelRows.reduce((s, r) => s + (r.area_m2 as number), 0)),
        occupantLoad: levelRows.reduce((s, r) => s + (r.occupant_load as number), 0),
      });
    }

    const summary: SpaceProgramSummary = {
      netAreaM2: netSum,
      circulationAreaM2: round2(brief.targetGrossAreaM2 - netSum),
      grossAreaM2: brief.targetGrossAreaM2,
      efficiency: round3(netSum / brief.targetGrossAreaM2),
      spaceCount: rows.length,
      perLevel,
    };

    return { program: toValue(program), summary: toValue(summary) };
  },
};
