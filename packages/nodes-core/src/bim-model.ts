/**
 * aec.generate_bim_model — MOCK of a BIM authoring backend.
 * Emits a small but syntactically valid IFC SPF (STEP) file derived from the
 * floor plan, plus a BimModelSummary (shapes.ts) — the contract a real BIM
 * backend must return. Fully deterministic: fixed header timestamp, pseudo
 * GUIDs derived from planId + entity id, no Date.now, no Math.random.
 */
import type { NodeModule } from '@archspace/node-sdk';
import type { BimModelSummary, FloorPlanResult } from './shapes.js';
import { ifcGuid, requireInput, sleep, toValue } from './util.js';

export interface GenerateBimModelParams {
  schema_version: 'IFC4';
  level_height_mm: number;
  mock_latency_ms: number;
}

export const generateBimModelNode: NodeModule<GenerateBimModelParams> = {
  manifest: {
    type: 'aec.generate_bim_model',
    version: 1,
    label: 'Generate BIM Model',
    description:
      'Mock BIM authoring backend: writes a small, valid IFC4 SPF model (project/site/building/storeys/spaces/walls/doors) from the floor plan.',
    category: 'Generate',
    keywords: ['bim', 'ifc', 'model', 'mock'],
    caching: 'never',
    lane: 'ai',
    params: {
      type: 'object',
      properties: {
        schema_version: {
          type: 'string',
          title: 'IFC schema',
          enum: ['IFC4'],
          default: 'IFC4',
        },
        level_height_mm: {
          type: 'integer',
          title: 'Level height (mm)',
          default: 3500,
          minimum: 2400,
          maximum: 6000,
        },
        mock_latency_ms: {
          type: 'integer',
          title: 'Mock latency (ms)',
          default: 1000,
          minimum: 0,
        },
      },
    },
    inputs: [{ id: 'floor_plan', type: 'json', label: 'Floor plan', required: true }],
    outputs: [
      { id: 'model', type: 'asset<ifc>', label: 'IFC model' },
      { id: 'summary', type: 'json', label: 'Summary' },
    ],
  },

  async execute(ctx, inputs, params) {
    const plan = requireInput<FloorPlanResult>(inputs, 'floor_plan', 'aec.generate_bim_model');

    ctx.progress(0.1, 'authoring spatial structure');
    await sleep(params.mock_latency_ms / 2, ctx.signal);

    const lines: string[] = [];
    let nextRef = 1;
    const elementCounts: Record<string, number> = {};

    const add = (keyword: string, pascal: string, attrs: string): number => {
      const ref = nextRef++;
      elementCounts[pascal] = (elementCounts[pascal] ?? 0) + 1;
      lines.push(`#${ref}=${keyword}(${attrs});`);
      return ref;
    };
    const guidFor = (entityId: string): string => ifcGuid(`${plan.planId}:${entityId}`);
    const str = (v: string): string => `'${v.replace(/'/g, "''")}'`;
    const real = (n: number): string => (Number.isInteger(n) ? `${n}.` : String(n));

    const projectRef = add(
      'IFCPROJECT',
      'IfcProject',
      `${str(guidFor('project'))},$,${str('Archspace Concept Project')},$,$,$,$,$,$`,
    );
    const siteRef = add(
      'IFCSITE',
      'IfcSite',
      `${str(guidFor('site'))},$,${str('Site')},$,$,$,$,$,.ELEMENT.,$,$,$,$,$`,
    );
    const buildingRef = add(
      'IFCBUILDING',
      'IfcBuilding',
      `${str(guidFor('building'))},$,${str('Building')},$,$,$,$,$,.ELEMENT.,$,$,$`,
    );

    const storeyRefs: number[] = [];
    const spaces: BimModelSummary['spaces'] = [];
    const doors: BimModelSummary['doors'] = [];

    for (const level of plan.levels) {
      const elevationMm = level.level * params.level_height_mm;
      const storeyRef = add(
        'IFCBUILDINGSTOREY',
        'IfcBuildingStorey',
        `${str(guidFor(`storey:${level.level}`))},$,${str(`Level ${level.level + 1}`)},$,$,$,$,$,.ELEMENT.,${real(elevationMm)}`,
      );
      storeyRefs.push(storeyRef);

      const containedRefs: number[] = [];
      for (const room of level.rooms) {
        const guid = guidFor(room.id);
        containedRefs.push(
          add(
            'IFCSPACE',
            'IfcSpace',
            `${str(guid)},$,${str(room.id)},$,$,$,$,${str(room.name)},.ELEMENT.,.INTERNAL.,$`,
          ),
        );
        spaces.push({ roomId: room.id, guid, name: room.name, level: level.level });
      }
      for (const wall of level.walls) {
        containedRefs.push(
          add(
            'IFCWALL',
            'IfcWall',
            `${str(guidFor(wall.id))},$,${str(wall.id)},$,$,$,$,$,$`,
          ),
        );
      }
      for (const door of level.doors) {
        const guid = guidFor(door.id);
        containedRefs.push(
          add(
            'IFCDOOR',
            'IfcDoor',
            `${str(guid)},$,${str(door.id)},$,$,$,$,$,2100.,${real(door.widthMm)},$,$,$`,
          ),
        );
        doors.push({ doorId: door.id, guid, level: level.level });
      }
      add(
        'IFCRELCONTAINEDINSPATIALSTRUCTURE',
        'IfcRelContainedInSpatialStructure',
        `${str(guidFor(`contained:${level.level}`))},$,$,$,(${containedRefs.map((r) => `#${r}`).join(',')}),#${storeyRef}`,
      );
    }

    add(
      'IFCRELAGGREGATES',
      'IfcRelAggregates',
      `${str(guidFor('agg:project'))},$,$,$,#${projectRef},(#${siteRef})`,
    );
    add(
      'IFCRELAGGREGATES',
      'IfcRelAggregates',
      `${str(guidFor('agg:site'))},$,$,$,#${siteRef},(#${buildingRef})`,
    );
    add(
      'IFCRELAGGREGATES',
      'IfcRelAggregates',
      `${str(guidFor('agg:building'))},$,$,$,#${buildingRef},(${storeyRefs.map((r) => `#${r}`).join(',')})`,
    );

    const fileName = `${plan.planId}.ifc`;
    const text = [
      'ISO-10303-21;',
      'HEADER;',
      "FILE_DESCRIPTION(('Archspace mock BIM model'),'2;1');",
      `FILE_NAME(${str(fileName)},'2026-01-01T00:00:00',('Archspace'),('Archspace'),'mock-bim 1.0.0','Archspace mock-bim','');`,
      `FILE_SCHEMA(('${params.schema_version}'));`,
      'ENDSEC;',
      'DATA;',
      ...lines,
      'ENDSEC;',
      'END-ISO-10303-21;',
      '',
    ].join('\n');

    ctx.progress(0.7, 'serializing IFC');
    await sleep(params.mock_latency_ms / 2, ctx.signal);

    const model = await ctx.assets.put(new TextEncoder().encode(text), {
      mediaType: 'model/ifc',
      format: 'ifc',
      name: fileName,
    });
    ctx.progress(1, 'model stored');

    const summary: BimModelSummary = {
      schema: 'IFC4',
      generator: { name: 'mock-bim', version: '1.0.0' },
      storeys: plan.levels.length,
      elementCounts,
      spaces,
      doors,
    };

    return { model, summary: toValue(summary) };
  },
};
