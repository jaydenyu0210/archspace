/**
 * aec.parking_estimate — how many parking spaces the brief implies, and how
 * much site area they consume.
 *
 * This node is the worked example in docs/creating-nodes.md. It is kept
 * deliberately small, but it is a real shipped node: pure, deterministic, and
 * exercising the three things every node author needs — an optional input with
 * a documented fallback, params with defaults, and outputs of three different
 * port types.
 */
import type { NodeModule, Value } from '@archspace/node-sdk';
import type { ParkingEstimate, ProjectBrief, SiteConstraints, TableValue } from './shapes.js';
import { requireInput, round2, toValue } from './util.js';

export interface ParkingEstimateParams {
  ratio_per_100_m2: number;
  accessible_pct: number;
  ev_ready_pct: number;
  space_area_m2: number;
}

/** Used when neither the param nor the zoning constraints supply a ratio. */
const FALLBACK_RATIO = 1.5;

export const parkingEstimateNode: NodeModule<ParkingEstimateParams> = {
  manifest: {
    type: 'aec.parking_estimate',
    version: 1,
    label: 'Parking Estimate',
    description:
      'Estimates the parking spaces the brief requires — total, accessible and EV-ready — and the site area they consume.',
    category: 'Plan',
    keywords: ['parking', 'zoning', 'site', 'planning'],
    caching: 'pure',
    lane: 'cpu',
    params: {
      type: 'object',
      properties: {
        ratio_per_100_m2: {
          type: 'number',
          title: 'Spaces per 100 m²',
          description: 'Leave at 0 to take the ratio from the connected site constraints.',
          default: 0,
          minimum: 0,
          maximum: 20,
        },
        accessible_pct: {
          type: 'number',
          title: 'Accessible spaces (%)',
          default: 4,
          minimum: 0,
          maximum: 20,
        },
        ev_ready_pct: {
          type: 'number',
          title: 'EV-ready spaces (%)',
          default: 10,
          minimum: 0,
          maximum: 100,
        },
        space_area_m2: {
          type: 'number',
          title: 'Area per space (m², incl. aisle)',
          default: 27.5,
          minimum: 15,
          maximum: 60,
        },
      },
    },
    inputs: [
      { id: 'brief', type: 'json', label: 'Brief', required: true },
      { id: 'constraints', type: 'json', label: 'Site constraints', required: false },
    ],
    outputs: [
      { id: 'spaces_required', type: 'number', label: 'Spaces required' },
      { id: 'breakdown', type: 'table', label: 'Breakdown' },
      { id: 'estimate', type: 'json', label: 'Estimate' },
    ],
  },

  async execute(ctx, inputs, params) {
    const brief = requireInput<ProjectBrief>(inputs, 'brief', 'aec.parking_estimate');
    const constraints = inputs.constraints as unknown as SiteConstraints | undefined;

    // Precedence: an explicit param wins, then the zoning ratio, then a
    // documented default — and the estimate records which one was used.
    let ratio = params.ratio_per_100_m2;
    let ratioSource: ParkingEstimate['ratioSource'] = 'param';
    if (ratio <= 0) {
      const zoned = constraints?.limits?.minParkingPer100M2;
      if (typeof zoned === 'number' && zoned > 0) {
        ratio = zoned;
        ratioSource = 'constraints';
      } else {
        ratio = FALLBACK_RATIO;
        ratioSource = 'default';
        ctx.log('info', `no parking ratio supplied — assuming ${FALLBACK_RATIO} spaces per 100 m²`);
      }
    }

    const grossAreaM2 = brief.targetGrossAreaM2;
    const total = Math.ceil((grossAreaM2 / 100) * ratio);
    // At least one accessible space wherever any parking is required.
    const accessible = total > 0 ? Math.max(1, Math.ceil((total * params.accessible_pct) / 100)) : 0;
    const evReady = Math.ceil((total * params.ev_ready_pct) / 100);
    const standard = Math.max(0, total - accessible);
    const areaM2 = round2(total * params.space_area_m2);

    const estimate: ParkingEstimate = {
      grossAreaM2,
      ratioPer100M2: ratio,
      ratioSource,
      spaces: { total, standard, accessible, evReady },
      areaM2,
      areaRatio: grossAreaM2 > 0 ? round2(areaM2 / grossAreaM2) : 0,
    };

    const breakdown: TableValue = {
      columns: [
        { id: 'category', label: 'Category' },
        { id: 'spaces', label: 'Spaces' },
        { id: 'area_m2', label: 'Area (m²)' },
      ],
      rows: [
        { category: 'Standard', spaces: standard, area_m2: round2(standard * params.space_area_m2) },
        { category: 'Accessible', spaces: accessible, area_m2: round2(accessible * params.space_area_m2) },
        { category: 'EV-ready (of total)', spaces: evReady, area_m2: round2(evReady * params.space_area_m2) },
        { category: 'Total', spaces: total, area_m2: areaM2 },
      ] as Record<string, Value>[],
    };

    return {
      spaces_required: total,
      breakdown: toValue(breakdown),
      estimate: toValue(estimate),
    };
  },
};
