/**
 * aec.generate_bim_model — MOCK of a BIM authoring backend.
 * Emits a valid IFC4 SPF (STEP) file derived from the floor plan, plus a
 * BimModelSummary (shapes.ts) — the contract a real BIM backend must return.
 * Fully deterministic: fixed header timestamp, pseudo GUIDs derived from
 * planId + entity id, no Date.now, no Math.random.
 *
 * **Geometry.** Until ADR-0015 this wrote spatial structure only: every product
 * had a null placement and a null representation, so the file parsed as IFC4,
 * showed a correct storey/space tree, and rendered nothing at all. It is now a
 * geometric model — a placement chain from site down to each element, and
 * swept solids for spaces, walls and doors — because the floor plan already
 * held every number needed and simply was not being used. Verified by loading
 * the output in IfcOpenShell and running its geometry engine over it, not by
 * inspecting the text we ourselves wrote.
 *
 * What is still deliberately absent, because the plan data does not contain it:
 *
 *   - **Openings.** Doors are solids standing at their position, not voids cut
 *     into walls. `PlanDoor` names the room it serves, never the wall it sits
 *     in, so `IfcRelVoidsElement` would need a guess about which wall to
 *     perforate. Same rule as the missing door swings in the DXF export
 *     (ADR-0015 decision 8): a detail that looks authored reads as authored.
 *   - **Slabs and roofs.** There is no floor-plate outline in the plan, only
 *     room polygons; a slab would mean unioning them and inventing an edge.
 *   - **Materials, property sets, quantities.** A real backend's job.
 */
import type { NodeModule } from '@archspace/node-sdk';
import type { BimModelSummary, FloorPlanResult } from './shapes.js';
import { counterClockwise, stepReal, stepString, wallAxis, type Point2 } from './ifc.js';
import { ifcGuid, requireInput, sleep, toValue } from './util.js';

export interface GenerateBimModelParams {
  schema_version: 'IFC4';
  level_height_mm: number;
  wall_height_mm: number;
  mock_latency_ms: number;
}

export const generateBimModelNode: NodeModule<GenerateBimModelParams> = {
  manifest: {
    type: 'aec.generate_bim_model',
    version: 1,
    label: 'Generate BIM Model',
    description:
      'Mock BIM authoring backend: writes a valid IFC4 SPF model from the floor plan — project, site, building, storeys, spaces, walls and doors, each placed in 3D with swept-solid geometry an IFC viewer renders. Doors are solids at their position, not openings cut into walls: the plan data says which room a door serves, never which wall it sits in.',
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
        wall_height_mm: {
          type: 'integer',
          title: 'Wall height (mm)',
          description:
            'How far walls and spaces are extruded upward from each storey. Kept below the level height so a floor zone remains — walls that reach the storey above leave no room for structure.',
          default: 3000,
          minimum: 2000,
          maximum: 5500,
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
    const str = stepString;
    const real = stepReal;

    // ---- geometry primitives, shared by every element -----------------------
    // Repeated points and directions are emitted once and referenced, which is
    // what a real exporter does: with 636 walls the alternative is thousands of
    // identical IFCCARTESIANPOINT((0.,0.,0.)) records.
    const point3 = (x: number, y: number, z: number): number =>
      add('IFCCARTESIANPOINT', 'IfcCartesianPoint', `(${real(x)},${real(y)},${real(z)})`);
    const point2 = (x: number, y: number): number =>
      add('IFCCARTESIANPOINT', 'IfcCartesianPoint', `(${real(x)},${real(y)})`);
    const direction3 = (x: number, y: number, z: number): number =>
      add('IFCDIRECTION', 'IfcDirection', `(${real(x)},${real(y)},${real(z)})`);

    const originRef = point3(0, 0, 0);
    const upRef = direction3(0, 0, 1);
    /** The identity frame: origin, default Z up, default X east. */
    const identityAxisRef = add('IFCAXIS2PLACEMENT3D', 'IfcAxis2Placement3D', `#${originRef},$,$`);

    /** A frame at (x, y, z), optionally rotated so its X axis points along `ref`. */
    const axisAt = (x: number, y: number, z: number, ref?: Point2): number => {
      const at = x === 0 && y === 0 && z === 0 && ref === undefined ? originRef : point3(x, y, z);
      if (ref === undefined) {
        return add('IFCAXIS2PLACEMENT3D', 'IfcAxis2Placement3D', `#${at},$,$`);
      }
      const refRef = direction3(ref[0], ref[1], 0);
      return add('IFCAXIS2PLACEMENT3D', 'IfcAxis2Placement3D', `#${at},#${upRef},#${refRef}`);
    };

    // ---- units and the representation context -------------------------------
    // Without these two, IfcProject is incomplete and a viewer has no frame to
    // interpret coordinates in — geometry that is present still does not draw.
    const lengthUnit = add('IFCSIUNIT', 'IfcSIUnit', '*,.LENGTHUNIT.,.MILLI.,.METRE.');
    const areaUnit = add('IFCSIUNIT', 'IfcSIUnit', '*,.AREAUNIT.,$,.SQUARE_METRE.');
    const volumeUnit = add('IFCSIUNIT', 'IfcSIUnit', '*,.VOLUMEUNIT.,$,.CUBIC_METRE.');
    const angleUnit = add('IFCSIUNIT', 'IfcSIUnit', '*,.PLANEANGLEUNIT.,$,.RADIAN.');
    const unitsRef = add(
      'IFCUNITASSIGNMENT',
      'IfcUnitAssignment',
      `(#${lengthUnit},#${areaUnit},#${volumeUnit},#${angleUnit})`,
    );

    const contextRef = add(
      'IFCGEOMETRICREPRESENTATIONCONTEXT',
      'IfcGeometricRepresentationContext',
      `$,${str('Model')},3,1.E-05,#${identityAxisRef},$`,
    );
    // Shape representations hang off the 'Body' subcontext, not the parent —
    // that is the convention every viewer and MVD expects for solid geometry.
    const bodyContextRef = add(
      'IFCGEOMETRICREPRESENTATIONSUBCONTEXT',
      'IfcGeometricRepresentationSubContext',
      `${str('Body')},${str('Model')},*,*,*,*,#${contextRef},$,.MODEL_VIEW.,$`,
    );

    /** Wrap one swept solid as the product's body representation. */
    const bodyShape = (solidRef: number): number => {
      const shapeRef = add(
        'IFCSHAPEREPRESENTATION',
        'IfcShapeRepresentation',
        `#${bodyContextRef},${str('Body')},${str('SweptSolid')},(#${solidRef})`,
      );
      return add('IFCPRODUCTDEFINITIONSHAPE', 'IfcProductDefinitionShape', `$,$,(#${shapeRef})`);
    };

    /** Extrude a profile straight up by `height`, in the product's own frame. */
    const extrude = (profileRef: number, height: number): number =>
      add(
        'IFCEXTRUDEDAREASOLID',
        'IfcExtrudedAreaSolid',
        `#${profileRef},#${identityAxisRef},#${upRef},${real(height)}`,
      );

    // ---- the placement chain: site → building → storey → element ------------
    const sitePlacementRef = add('IFCLOCALPLACEMENT', 'IfcLocalPlacement', `$,#${identityAxisRef}`);
    const buildingPlacementRef = add(
      'IFCLOCALPLACEMENT',
      'IfcLocalPlacement',
      `#${sitePlacementRef},#${identityAxisRef}`,
    );

    const projectRef = add(
      'IFCPROJECT',
      'IfcProject',
      `${str(guidFor('project'))},$,${str('Archspace Concept Project')},$,$,$,$,(#${contextRef}),#${unitsRef}`,
    );
    const siteRef = add(
      'IFCSITE',
      'IfcSite',
      `${str(guidFor('site'))},$,${str('Site')},$,$,#${sitePlacementRef},$,$,.ELEMENT.,$,$,$,$,$`,
    );
    const buildingRef = add(
      'IFCBUILDING',
      'IfcBuilding',
      `${str(guidFor('building'))},$,${str('Building')},$,$,#${buildingPlacementRef},$,$,.ELEMENT.,$,$,$`,
    );

    const storeyRefs: number[] = [];
    const spaces: BimModelSummary['spaces'] = [];
    const doors: BimModelSummary['doors'] = [];

    // A door reaches 2.1 m, the standard leaf height, regardless of how tall the
    // walls around it are.
    const doorHeightMm = 2100;
    const doorThicknessMm = 100;

    for (const level of plan.levels) {
      const elevationMm = level.level * params.level_height_mm;
      const storeyPlacementRef = add(
        'IFCLOCALPLACEMENT',
        'IfcLocalPlacement',
        `#${buildingPlacementRef},#${axisAt(0, 0, elevationMm)}`,
      );
      const storeyRef = add(
        'IFCBUILDINGSTOREY',
        'IfcBuildingStorey',
        `${str(guidFor(`storey:${level.level}`))},$,${str(`Level ${level.level + 1}`)},$,$,#${storeyPlacementRef},$,$,.ELEMENT.,${real(elevationMm)}`,
      );
      storeyRefs.push(storeyRef);

      /** An element's placement, relative to this storey's floor. */
      const placeOnStorey = (x: number, y: number, ref?: Point2): number =>
        add(
          'IFCLOCALPLACEMENT',
          'IfcLocalPlacement',
          `#${storeyPlacementRef},#${axisAt(x, y, 0, ref)}`,
        );

      // Physical products go in IfcRelContainedInSpatialStructure; spaces do
      // not. An IfcSpace is itself a spatial structure element, so it belongs
      // in the decomposition tree via IfcRelAggregates — putting it in the
      // contained list violates IfcRelContainedInSpatialStructure.WR31 (that
      // list may not hold spatial elements) and leaves the space failing
      // IfcSpatialStructureElement.WR41, which requires exactly one
      // decomposition parent. Both were flagged by IfcOpenShell's validator;
      // neither shows up when reading the file by eye, because the tree still
      // looks right in a viewer.
      const containedRefs: number[] = [];
      const spaceRefs: number[] = [];

      for (const room of level.rooms) {
        const guid = guidFor(room.id);
        // The room's own polygon, swept to wall height. Wound counter-clockwise
        // first: a clockwise ring extrudes with inverted normals, which renders
        // as a room that is invisible from outside.
        let shapeRef = '$';
        if (room.polygon.length >= 3) {
          const ring = counterClockwise(room.polygon as readonly Point2[]);
          const pointRefs = ring.map(([x, y]) => point2(x, y));
          // IfcArbitraryClosedProfileDef wants a closed curve, and an
          // IfcPolyline is closed only when it repeats its first point.
          const polylineRef = add(
            'IFCPOLYLINE',
            'IfcPolyline',
            `(${[...pointRefs, pointRefs[0]].map((r) => `#${r}`).join(',')})`,
          );
          const profileRef = add(
            'IFCARBITRARYCLOSEDPROFILEDEF',
            'IfcArbitraryClosedProfileDef',
            `.AREA.,${str(room.name)},#${polylineRef}`,
          );
          shapeRef = `#${bodyShape(extrude(profileRef, params.wall_height_mm))}`;
        }
        spaceRefs.push(
          add(
            'IFCSPACE',
            'IfcSpace',
            `${str(guid)},$,${str(room.id)},$,$,#${placeOnStorey(0, 0)},${shapeRef},${str(room.name)},.ELEMENT.,.INTERNAL.,$`,
          ),
        );
        spaces.push({ roomId: room.id, guid, name: room.name, level: level.level });
      }

      for (const wall of level.walls) {
        // The wall's own frame runs along its centreline, so the profile is a
        // plain length × thickness rectangle. An axis-aligned profile could not
        // describe a wall that runs diagonally at all.
        const axis = wallAxis(wall.start as Point2, wall.end as Point2);
        let shapeRef = '$';
        let placementRef: number;
        if (axis === null) {
          // Zero length: no direction to point along, and a degenerate solid is
          // worse than none — invisible in a viewer, still counted in take-offs.
          placementRef = placeOnStorey(wall.start[0], wall.start[1]);
        } else {
          placementRef = placeOnStorey(axis.origin[0], axis.origin[1], axis.refDirection);
          const profileRef = add(
            'IFCRECTANGLEPROFILEDEF',
            'IfcRectangleProfileDef',
            // Centred half a length along local X, so the rectangle spans the
            // wall from its start to its end and straddles the centreline.
            `.AREA.,$,#${add('IFCAXIS2PLACEMENT2D', 'IfcAxis2Placement2D', `#${point2(axis.length / 2, 0)},$`)},${real(axis.length)},${real(wall.thicknessMm)}`,
          );
          shapeRef = `#${bodyShape(extrude(profileRef, params.wall_height_mm))}`;
        }
        containedRefs.push(
          add(
            'IFCWALL',
            'IfcWall',
            `${str(guidFor(wall.id))},$,${str(wall.id)},$,$,#${placementRef},${shapeRef},$,${wall.kind === 'exterior' ? '.SOLIDWALL.' : '.PARTITIONING.'}`,
          ),
        );
      }

      for (const door of level.doors) {
        const guid = guidFor(door.id);
        const profileRef = add(
          'IFCRECTANGLEPROFILEDEF',
          'IfcRectangleProfileDef',
          `.AREA.,$,#${add('IFCAXIS2PLACEMENT2D', 'IfcAxis2Placement2D', `#${point2(0, 0)},$`)},${real(door.widthMm)},${real(doorThicknessMm)}`,
        );
        containedRefs.push(
          add(
            'IFCDOOR',
            'IfcDoor',
            `${str(guid)},$,${str(door.id)},$,$,#${placeOnStorey(door.position[0], door.position[1])},#${bodyShape(extrude(profileRef, doorHeightMm))},$,${real(doorHeightMm)},${real(door.widthMm)},.DOOR.,$,$`,
          ),
        );
        doors.push({ doorId: door.id, guid, level: level.level });
      }
      add(
        'IFCRELCONTAINEDINSPATIALSTRUCTURE',
        'IfcRelContainedInSpatialStructure',
        `${str(guidFor(`contained:${level.level}`))},$,$,$,(${containedRefs.map((r) => `#${r}`).join(',')}),#${storeyRef}`,
      );
      if (spaceRefs.length > 0) {
        add(
          'IFCRELAGGREGATES',
          'IfcRelAggregates',
          `${str(guidFor(`agg:storey:${level.level}`))},$,$,$,#${storeyRef},(${spaceRefs.map((r) => `#${r}`).join(',')})`,
        );
      }
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
