/**
 * The 3D scene builder, tested against the real writer through an
 * independent parser.
 *
 * These cases run `aec.generate_bim_model` on a hand-written plan, then parse
 * its output with web-ifc's node build — a parser that did not write the file
 * — before asserting on what `buildIfcScene` makes of it. That chain is the
 * point (ADR-0016's lesson): a scene builder tested against synthetic mesh
 * data would inherit every misreading of the writer's conventions, while this
 * one fails if the writer, the parser, or the grouping drifts. The fixture
 * deliberately contains what the shipped example does not: a zero-length wall
 * and a two-point room, which the writer emits with null representations and
 * a viewer must tolerate as products-without-meshes rather than assume away.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { IfcAPI } from 'web-ifc';
import { runNode } from '@archspace/node-sdk/testkit';
import type { Value } from '@archspace/node-sdk';
import type { AssetRef } from '@archspace/node-sdk';
import { generateBimModelNode } from '@archspace/nodes-core';
import type { FloorPlanResult } from '@archspace/nodes-core';
import {
  buildIfcScene,
  cameraFrame,
  groupVisible,
  type IfcSceneData,
  type IfcSceneGroup,
} from '../src/renderer/src/ifc-scene.js';

/**
 * Two storeys; drawable: 3 walls, 1 door, 2 spaces. Degenerate on purpose:
 * w3 has zero length and r2 has a two-point polygon, so the writer gives both
 * a `$` representation — entities that exist but must not be drawn or counted
 * as drawn.
 */
const PLAN: FloorPlanResult = {
  planId: 'plan_f1x70001',
  generator: { name: 'mock-floorplan', version: '1.0.0', seed: 1 },
  units: 'mm',
  site: { widthMm: 20_000, depthMm: 10_000 },
  levels: [
    {
      level: 0,
      elevationMm: 0,
      rooms: [
        {
          id: 'r1',
          spaceId: null,
          name: 'Room A',
          function: 'office',
          polygon: [[0, 0], [8000, 0], [8000, 6000], [0, 6000]],
          areaM2: 48,
        },
        { id: 'r2', spaceId: null, name: 'Sliver', function: 'office', polygon: [[0, 0], [1000, 0]], areaM2: 0 },
      ],
      walls: [
        { id: 'w1', start: [0, 0], end: [8000, 0], thicknessMm: 200, kind: 'exterior' },
        { id: 'w2', start: [8000, 0], end: [8000, 6000], thicknessMm: 200, kind: 'exterior' },
        { id: 'w3', start: [4000, 4000], end: [4000, 4000], thicknessMm: 100, kind: 'interior' },
      ],
      doors: [{ id: 'd1', roomId: 'r1', position: [4000, 0], widthMm: 900 }],
      exits: [],
    },
    {
      level: 1,
      elevationMm: 3500,
      rooms: [
        {
          id: 'r3',
          spaceId: null,
          name: 'Room B',
          function: 'office',
          polygon: [[0, 0], [5000, 0], [5000, 5000], [0, 5000]],
          areaM2: 25,
        },
      ],
      walls: [{ id: 'w4', start: [0, 0], end: [5000, 0], thicknessMm: 150, kind: 'interior' }],
      doors: [],
      exits: [],
    },
  ],
  metrics: { grossAreaM2: 73, netAreaM2: 73, efficiency: 1 },
};

// Node defaults the suite relies on — level_height_mm 3500, wall_height_mm
// 3000 — expressed in METRES where geometry is asserted, because web-ifc
// emits geometry in the glTF convention: metres, +Y height, world z equal to
// minus the plan's y (the ifc-scene.ts header records the measurement).
// Attribute reads stay in file units, which the storeys case pins.
const LEVEL_HEIGHT_M = 3.5;
const WALL_HEIGHT_M = 3;

let api: IfcAPI;
let scene: IfcSceneData;

beforeAll(async () => {
  api = new IfcAPI();
  await api.Init();
  const run = await runNode(generateBimModelNode, {
    inputs: { floor_plan: PLAN as unknown as Value },
  });
  const ref = run.outputs.model as AssetRef;
  scene = buildIfcScene(api, await run.assets.bytes(ref));
});

const groupsOf = (category: IfcSceneGroup['category']): IfcSceneGroup[] =>
  scene.groups.filter((g) => g.category === category);

describe('buildIfcScene on the real writer output', () => {
  it('counts drawn products, not entities — degenerates excluded', () => {
    // w3 and r2 exist in the file with `$` representations; a count that
    // included them would caption geometry the panel is not showing.
    expect(scene.counts).toEqual({ wall: 3, door: 1, space: 2, other: 0 });
  });

  it('reads both storeys in elevation order, elevations in FILE units', () => {
    // 3500, not 3.5: Elevation is an attribute read, which web-ifc does not
    // unit-convert — the one place scene data is millimetres, pinned so a
    // future "fix" that converts it must come here and say so.
    expect(scene.storeys).toEqual([
      { name: 'Level 1', elevation: 0 },
      { name: 'Level 2', elevation: 3500 },
    ]);
  });

  it('groups by category and storey, walls and doors via containment, spaces via aggregation', () => {
    const shape = scene.groups.map((g) => `${g.category}:${g.storey}:${g.productCount}`).sort();
    expect(shape).toEqual(['door:0:1', 'space:0:1', 'space:1:1', 'wall:0:2', 'wall:1:1'].sort());
  });

  it('applies placements: storey-1 geometry sits a level height up', () => {
    // Height is world Y in web-ifc's output space.
    for (const g of scene.groups.filter((g) => g.storey === 1)) {
      for (let i = 1; i < g.positions.length; i += 3) {
        expect(g.positions[i]).toBeGreaterThanOrEqual(LEVEL_HEIGHT_M - 1e-4);
      }
    }
    // And the ground-floor door stands where the plan put it (x 4 m ± half a
    // 0.9 m width, straddling y = 0) — a dropped or misapplied placement
    // matrix would leave it at the origin in the product's own frame.
    const door = groupsOf('door')[0];
    let minX = Infinity, maxX = -Infinity;
    for (let i = 0; i < door.positions.length; i += 3) {
      minX = Math.min(minX, door.positions[i]);
      maxX = Math.max(maxX, door.positions[i]);
    }
    expect(minX).toBeCloseTo(4 - 0.45, 3);
    expect(maxX).toBeCloseTo(4 + 0.45, 3);
  });

  it('bounds cover the built volume, in metres Y-up', () => {
    expect(scene.bounds).not.toBeNull();
    const { min, max } = scene.bounds!;
    // x: w2's thickness straddles its centreline at plan x = 8000, so 8.1.
    expect(min[0]).toBeCloseTo(0, 3);
    expect(max[0]).toBeCloseTo(8.1, 3);
    // y is height: ground to the top of a storey-1 wall.
    expect(min[1]).toBeCloseTo(0, 3);
    expect(max[1]).toBeCloseTo(LEVEL_HEIGHT_M + WALL_HEIGHT_M, 3);
    // z is minus plan-y: room depth 6 m one way, w1's straddle 0.1 the other.
    expect(min[2]).toBeCloseTo(-6, 3);
    expect(max[2]).toBeCloseTo(0.1, 3);
  });

  it('emits watertight buffers: unit normals, indices in range', () => {
    for (const g of scene.groups) {
      expect(g.positions.length).toBe(g.normals.length);
      expect(g.indices.length % 3).toBe(0);
      const vertexCount = g.positions.length / 3;
      for (const index of g.indices) expect(index).toBeLessThan(vertexCount);
      for (let i = 0; i < g.normals.length; i += 3) {
        const len = Math.hypot(g.normals[i], g.normals[i + 1], g.normals[i + 2]);
        expect(len).toBeCloseTo(1, 3);
      }
    }
  });
});

describe('groupVisible', () => {
  const group = (over: Partial<IfcSceneGroup>): IfcSceneGroup => ({
    category: 'wall',
    storey: 0,
    positions: new Float32Array(),
    normals: new Float32Array(),
    indices: new Uint32Array(),
    productCount: 1,
    ...over,
  });

  it('hides spaces unless asked for, regardless of storey', () => {
    expect(groupVisible(group({ category: 'space' }), { storey: null, showSpaces: false })).toBe(false);
    expect(groupVisible(group({ category: 'space' }), { storey: 0, showSpaces: true })).toBe(true);
  });

  it('isolates a storey but never hides unplaced geometry', () => {
    expect(groupVisible(group({ storey: 1 }), { storey: 0, showSpaces: false })).toBe(false);
    expect(groupVisible(group({ storey: 0 }), { storey: 0, showSpaces: false })).toBe(true);
    // A group the file failed to place would otherwise be visible in NO view.
    expect(groupVisible(group({ storey: null }), { storey: 0, showSpaces: false })).toBe(true);
  });
});

describe('cameraFrame', () => {
  const bounds = { min: [0, 0, 0] as [number, number, number], max: [8000, 6000, 6500] as [number, number, number] };

  it('centres on the model and backs off far enough for the bounding sphere', () => {
    const fovY = Math.PI / 4;
    const { center, distance } = cameraFrame(bounds, fovY, 2);
    expect(center).toEqual([4000, 3000, 3250]);
    const radius = Math.hypot(8000, 6000, 6500) / 2;
    // The sphere must fit the NARROWER angle — at aspect 2 that is vertical.
    expect(distance).toBeCloseTo(radius / Math.sin(fovY / 2), 6);
    expect(distance).toBeGreaterThan(radius);
  });

  it('fits the horizontal angle when the panel is taller than wide', () => {
    const fovY = Math.PI / 4;
    const fovX = 2 * Math.atan(Math.tan(fovY / 2) * 0.5);
    const { distance } = cameraFrame(bounds, fovY, 0.5);
    const radius = Math.hypot(8000, 6000, 6500) / 2;
    expect(distance).toBeCloseTo(radius / Math.sin(fovX / 2), 6);
  });
});
