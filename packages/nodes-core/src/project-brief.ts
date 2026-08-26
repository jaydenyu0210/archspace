/** aec.project_brief — assembles the ProjectBrief every downstream node consumes. */
import type { NodeModule } from '@archspace/node-sdk';
import type { ProjectBrief } from './shapes.js';
import { round2, toValue } from './util.js';

export interface ProjectBriefParams {
  project_name: string;
  building_type: ProjectBrief['buildingType'];
  code_version: string;
  site_width_m: number;
  site_depth_m: number;
  floors: number;
  target_gross_area_m2: number;
  occupancy_class: string;
  notes: string;
}

export const projectBriefNode: NodeModule<ProjectBriefParams> = {
  manifest: {
    type: 'aec.project_brief',
    version: 1,
    label: 'Project Brief',
    description:
      'Assembles the project brief — site, massing, code and occupancy facts — that every downstream concept-design node consumes.',
    category: 'Plan',
    keywords: ['brief', 'program', 'site', 'concept'],
    caching: 'pure',
    lane: 'cpu',
    params: {
      type: 'object',
      properties: {
        project_name: {
          type: 'string',
          title: 'Project name',
          default: 'Riverside Office Tower',
        },
        building_type: {
          type: 'string',
          title: 'Building type',
          enum: ['office', 'residential', 'school', 'mixed_use'],
          default: 'office',
        },
        code_version: {
          type: 'string',
          title: 'Code version',
          enum: ['IBC 2024', 'IBC 2021'],
          default: 'IBC 2024',
        },
        site_width_m: {
          type: 'number',
          title: 'Site width (m)',
          default: 48,
          minimum: 10,
          maximum: 500,
        },
        site_depth_m: {
          type: 'number',
          title: 'Site depth (m)',
          default: 32,
          minimum: 10,
          maximum: 500,
        },
        floors: {
          type: 'integer',
          title: 'Floors',
          default: 6,
          minimum: 1,
          maximum: 40,
        },
        target_gross_area_m2: {
          type: 'number',
          title: 'Target gross area (m²)',
          // Kept below the floor-plan capacity limit (floors × site × 0.85 =
          // 7833.6 m² at the default site/floors) so defaults run end-to-end.
          default: 7600,
          minimum: 100,
        },
        occupancy_class: {
          type: 'string',
          title: 'Occupancy class',
          enum: ['A-2', 'B', 'E', 'R-2', 'M'],
          default: 'B',
        },
        notes: {
          type: 'string',
          title: 'Notes',
          default: '',
          'x-archspace': { widget: 'textarea', rows: 4 },
        },
      },
    },
    inputs: [],
    outputs: [{ id: 'brief', type: 'json', label: 'Brief' }],
  },

  async execute(_ctx, _inputs, params) {
    const brief: ProjectBrief = {
      projectName: params.project_name,
      buildingType: params.building_type,
      code: { jurisdiction: 'IBC', version: params.code_version },
      site: {
        widthM: params.site_width_m,
        depthM: params.site_depth_m,
        areaM2: round2(params.site_width_m * params.site_depth_m),
      },
      floors: params.floors,
      targetGrossAreaM2: params.target_gross_area_m2,
      occupancyClass: params.occupancy_class,
      notes: params.notes,
    };
    return { brief: toValue(brief) };
  },
};
