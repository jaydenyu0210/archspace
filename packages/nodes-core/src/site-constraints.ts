/**
 * aec.site_constraints — the zoning envelope a scheme has to fit inside.
 *
 * Setbacks, height, FAR and coverage are resolved against the brief's lot into
 * a buildable footprint and a binding gross-area ceiling. Everything is derived
 * from the ACTUAL lot dimensions on the brief, so changing the site upstream
 * genuinely moves the envelope. The SiteConstraints shape (shapes.ts) is the
 * contract a real jurisdiction/GIS lookup must return.
 */
import type { NodeModule, Value } from '@archspace/node-sdk';
import type { ProjectBrief, SiteConstraints, TableValue } from './shapes.js';
import { requireInput, round2, toValue } from './util.js';

export interface SiteConstraintsParams {
  jurisdiction: string;
  zoning_district: string;
  setback_front_m: number;
  setback_rear_m: number;
  setback_side_m: number;
  max_height_m: number;
  max_storeys: number;
  max_far: number;
  max_lot_coverage_pct: number;
  min_parking_per_100_m2: number;
}

export const siteConstraintsNode: NodeModule<SiteConstraintsParams> = {
  manifest: {
    type: 'aec.site_constraints',
    version: 1,
    label: 'Site Constraints',
    description:
      'The zoning envelope a scheme has to fit inside — setbacks, height, FAR and coverage resolved into a buildable footprint and a binding gross-area ceiling.',
    category: 'Plan',
    keywords: ['zoning', 'setbacks', 'far', 'coverage', 'envelope', 'site'],
    caching: 'pure',
    lane: 'cpu',
    params: {
      type: 'object',
      properties: {
        jurisdiction: {
          type: 'string',
          title: 'Jurisdiction',
          default: 'City of Riverside',
        },
        zoning_district: {
          type: 'string',
          title: 'Zoning district',
          enum: ['C-2 Commercial', 'R-4 Residential', 'M-1 Light Industrial', 'MU-3 Mixed Use'],
          default: 'C-2 Commercial',
        },
        setback_front_m: {
          type: 'number',
          title: 'Front setback (m)',
          default: 6,
          minimum: 0,
          maximum: 30,
        },
        setback_rear_m: {
          type: 'number',
          title: 'Rear setback (m)',
          default: 4.5,
          minimum: 0,
          maximum: 30,
        },
        setback_side_m: {
          type: 'number',
          title: 'Side setback (m)',
          default: 3,
          minimum: 0,
          maximum: 30,
        },
        max_height_m: {
          type: 'number',
          title: 'Max height (m)',
          default: 28,
          minimum: 3,
          maximum: 300,
        },
        max_storeys: {
          type: 'integer',
          title: 'Max storeys',
          default: 8,
          minimum: 1,
          maximum: 60,
        },
        max_far: {
          type: 'number',
          title: 'Max FAR',
          default: 3.5,
          minimum: 0.1,
          maximum: 20,
        },
        max_lot_coverage_pct: {
          type: 'number',
          title: 'Max lot coverage (%)',
          default: 70,
          minimum: 5,
          maximum: 100,
        },
        min_parking_per_100_m2: {
          type: 'number',
          title: 'Min parking per 100 m²',
          default: 1.5,
          minimum: 0,
          maximum: 10,
        },
      },
    },
    inputs: [{ id: 'brief', type: 'json', label: 'Brief', required: true }],
    outputs: [
      { id: 'constraints', type: 'json', label: 'Constraints' },
      { id: 'limits', type: 'table', label: 'Limits' },
    ],
  },

  async execute(_ctx, inputs, params) {
    const brief = requireInput<ProjectBrief>(inputs, 'brief', 'aec.site_constraints');

    const lot = {
      widthM: round2(brief.site.widthM),
      depthM: round2(brief.site.depthM),
      areaM2: round2(brief.site.areaM2),
    };

    // The lot minus its setbacks. Setbacks deeper than the lot leave nothing —
    // clamped at zero rather than going negative, and called out in the notes.
    const buildableWidthM = round2(Math.max(0, lot.widthM - 2 * params.setback_side_m));
    const buildableDepthM = round2(
      Math.max(0, lot.depthM - params.setback_front_m - params.setback_rear_m),
    );
    const buildable = {
      widthM: buildableWidthM,
      depthM: buildableDepthM,
      areaM2: round2(buildableWidthM * buildableDepthM),
    };

    // Two independent footprint caps: what the setbacks leave, and what the
    // coverage percentage allows. The lesser binds.
    const coverageFootprintM2 = round2((lot.areaM2 * params.max_lot_coverage_pct) / 100);
    const maxFootprintM2 = round2(Math.min(buildable.areaM2, coverageFootprintM2));

    // Two independent gross-area caps: FAR against the whole lot, and the
    // buildable footprint stacked to the storey limit. Again, the lesser binds.
    const farCapM2 = round2(params.max_far * lot.areaM2);
    const stackedCapM2 = round2(maxFootprintM2 * params.max_storeys);
    const maxGrossAreaM2 = round2(Math.min(farCapM2, stackedCapM2));
    const farBinds = farCapM2 < stackedCapM2;
    const stackBinds = stackedCapM2 < farCapM2;

    const notes: string[] = [];

    if (buildable.areaM2 <= 0) {
      notes.push(
        `Setbacks (front ${params.setback_front_m} m, rear ${params.setback_rear_m} m, ` +
          `side ${params.setback_side_m} m each) consume the entire lot: no buildable footprint remains ` +
          `on a ${lot.widthM} × ${lot.depthM} m site.`,
      );
    }

    if (coverageFootprintM2 < buildable.areaM2) {
      notes.push(
        `The ${params.max_lot_coverage_pct}% coverage cap allows a ${coverageFootprintM2} m² footprint, ` +
          `less than the ${buildable.areaM2} m² the setbacks leave — coverage binds the footprint.`,
      );
    } else {
      notes.push(
        `Setbacks reduce the ${lot.areaM2} m² lot to a ${buildable.areaM2} m² buildable footprint, ` +
          `at or below the ${params.max_lot_coverage_pct}% coverage cap of ${coverageFootprintM2} m² — ` +
          `setbacks bind the footprint.`,
      );
    }

    if (farBinds) {
      notes.push(
        `FAR ${params.max_far} on a ${lot.areaM2} m² lot caps gross area at ${farCapM2} m²; ` +
          `the coverage cap (${maxFootprintM2} m² footprint × ${params.max_storeys} storeys) would allow ` +
          `${stackedCapM2} m² — FAR binds.`,
      );
    } else if (stackBinds) {
      notes.push(
        `The buildable footprint (${maxFootprintM2} m² × ${params.max_storeys} storeys) caps gross area at ` +
          `${stackedCapM2} m²; FAR ${params.max_far} on a ${lot.areaM2} m² lot would allow ${farCapM2} m² — ` +
          `footprint × storeys binds.`,
      );
    } else {
      notes.push(
        `FAR ${params.max_far} and the footprint × storeys cap coincide at ${maxGrossAreaM2} m² — ` +
          `both bind together.`,
      );
    }

    notes.push(
      `${params.max_storeys} storeys within ${params.max_height_m} m allows an average floor-to-floor of ` +
        `${round2(params.max_height_m / params.max_storeys)} m.`,
    );

    notes.push(
      `At ${params.min_parking_per_100_m2} stalls per 100 m², a scheme built to the ${maxGrossAreaM2} m² ` +
        `ceiling requires ${Math.ceil((maxGrossAreaM2 / 100) * params.min_parking_per_100_m2)} parking stalls.`,
    );

    const constraints: SiteConstraints = {
      jurisdiction: params.jurisdiction,
      zoningDistrict: params.zoning_district,
      lot,
      setbacksM: {
        front: params.setback_front_m,
        rear: params.setback_rear_m,
        side: params.setback_side_m,
      },
      limits: {
        maxHeightM: params.max_height_m,
        maxStoreys: params.max_storeys,
        maxFar: params.max_far,
        maxLotCoveragePct: params.max_lot_coverage_pct,
        minParkingPer100M2: params.min_parking_per_100_m2,
      },
      buildable,
      maxGrossAreaM2,
      notes,
    };

    const fromDistrict = `zoning district ${params.zoning_district}`;
    const grossBasis = farBinds
      ? 'derived: FAR × lot area'
      : stackBinds
        ? 'derived: buildable footprint × max storeys'
        : 'derived: FAR × lot area (equal to footprint × storeys)';

    const limits: TableValue = {
      columns: [
        { id: 'limit', label: 'Limit' },
        { id: 'value', label: 'Value' },
        { id: 'unit', label: 'Unit' },
        { id: 'basis', label: 'Basis' },
      ],
      rows: [
        { limit: 'Max height', value: params.max_height_m, unit: 'm', basis: fromDistrict },
        { limit: 'Max storeys', value: params.max_storeys, unit: 'storeys', basis: fromDistrict },
        { limit: 'Max FAR', value: params.max_far, unit: 'ratio', basis: fromDistrict },
        {
          limit: 'Max lot coverage',
          value: params.max_lot_coverage_pct,
          unit: '%',
          basis: fromDistrict,
        },
        {
          limit: 'Buildable footprint',
          value: maxFootprintM2,
          unit: 'm²',
          basis: 'derived: lot minus setbacks, capped by coverage',
        },
        { limit: 'Max gross area', value: maxGrossAreaM2, unit: 'm²', basis: grossBasis },
        {
          limit: 'Min parking',
          value: params.min_parking_per_100_m2,
          unit: 'stalls / 100 m²',
          basis: fromDistrict,
        },
      ] satisfies Record<string, Value>[],
    };

    return { constraints: toValue(constraints), limits: toValue(limits) };
  },
};
