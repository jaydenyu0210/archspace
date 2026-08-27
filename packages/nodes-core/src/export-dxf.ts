/**
 * aec.export_dxf — a floor plan as a 2D CAD drawing (ARCHITECTURE §6.1).
 *
 * This is the one export in the project that produces **drawable geometry**.
 * The IFC written by `aec.generate_bim_model` is a spatial model — a correct
 * hierarchy of storeys, spaces, walls and doors with no placement and no
 * representation, so an IFC viewer shows a tree over an empty 3D view. The
 * floor plan itself, though, is real coordinates: room polygons, wall
 * centrelines with thicknesses, door positions, all in millimetres. Those go
 * into a DXF unchanged, and what opens in CAD is the plan the graph actually
 * produced.
 *
 * Layer names follow the AIA CAD Layer Guidelines convention
 * (`A-WALL-EXTR`, `A-AREA-BDRY`, …) because an architect opening this file
 * already knows what those mean, with a `-L<n>` suffix so a multi-storey export
 * can be switched storey by storey. The suffix is present even for a
 * single-level export, so a layer name means the same thing in both modes.
 *
 * Deliberately NOT invented: door swings. A `PlanDoor` carries a position and a
 * width but no orientation, so a swing arc would require guessing which wall it
 * belongs to and which way it opens. A circle of the door's width, on the door
 * layer, says exactly what is known — there is an opening this wide, here — and
 * nothing that isn't. Drawing a plausible-looking swing would be the kind of
 * detail that reads as authoritative precisely because it looks drafted.
 */
import type { NodeModule } from '@archspace/node-sdk';
import type { FloorPlanLevel, FloorPlanResult, PlanRoom } from './shapes.js';
import { writeDxf, type DxfEntity, type DxfLayer, type Point } from './dxf.js';
import { requireInput, round2 } from './util.js';

export interface ExportDxfParams {
  file_name: string;
  level: string;
  text_height_mm: number;
  include_labels: boolean;
  include_doors: boolean;
}

/** Layer roles, and the AutoCAD Color Index each gets. */
const LAYERS = [
  { role: 'wallExterior', base: 'A-WALL-EXTR', color: 7 },
  { role: 'wallInterior', base: 'A-WALL-INTR', color: 8 },
  { role: 'roomBoundary', base: 'A-AREA-BDRY', color: 4 },
  { role: 'roomLabel', base: 'A-AREA-IDEN', color: 3 },
  { role: 'door', base: 'A-DOOR', color: 2 },
  { role: 'exit', base: 'A-FLOR-EXIT', color: 1 },
] as const;

type LayerRole = (typeof LAYERS)[number]['role'];

const layerName = (role: LayerRole, level: number): string =>
  `${LAYERS.find((l) => l.role === role)?.base ?? 'A-MISC'}-L${level}`;

/**
 * The area centroid of a simple polygon (the shoelace formula).
 *
 * Not the mean of the vertices, which is only the centroid for a shape whose
 * vertices are evenly distributed — an L-shaped room would put its label
 * somewhere in the notch. Degenerate polygons (fewer than three points, or zero
 * signed area, which a collinear or repeated-point polygon produces) fall back
 * to the vertex mean, because a label placed imperfectly is better than a label
 * placed at NaN.
 */
export function polygonCentroid(polygon: readonly Point[]): Point {
  if (polygon.length === 0) return [0, 0];
  if (polygon.length < 3) {
    return [
      polygon.reduce((s, p) => s + p[0], 0) / polygon.length,
      polygon.reduce((s, p) => s + p[1], 0) / polygon.length,
    ];
  }

  let twiceArea = 0;
  let cx = 0;
  let cy = 0;
  for (let i = 0; i < polygon.length; i++) {
    const [x0, y0] = polygon[i] as Point;
    const [x1, y1] = polygon[(i + 1) % polygon.length] as Point;
    const cross = x0 * y1 - x1 * y0;
    twiceArea += cross;
    cx += (x0 + x1) * cross;
    cy += (y0 + y1) * cross;
  }

  if (twiceArea === 0) {
    return [
      polygon.reduce((s, p) => s + p[0], 0) / polygon.length,
      polygon.reduce((s, p) => s + p[1], 0) / polygon.length,
    ];
  }
  return [cx / (3 * twiceArea), cy / (3 * twiceArea)];
}

/**
 * A wall as the rectangle it occupies in plan, rather than a centreline.
 *
 * `PlanWall` carries a thickness, and a plan drawing in which walls are
 * hairlines is not a plan an architect can use — it also throws away the one
 * piece of information that distinguishes a wall from a line. The rectangle is
 * the centreline offset by half the thickness in both perpendicular directions.
 * A zero-length wall has no direction to offset along, so it is skipped rather
 * than emitted as a degenerate shape.
 */
export function wallOutline(
  start: Point,
  end: Point,
  thicknessMm: number,
): readonly Point[] | null {
  const dx = end[0] - start[0];
  const dy = end[1] - start[1];
  const length = Math.hypot(dx, dy);
  if (length === 0 || thicknessMm <= 0) return null;

  const half = thicknessMm / 2;
  // Unit normal, i.e. the direction rotated a quarter turn.
  const nx = (-dy / length) * half;
  const ny = (dx / length) * half;

  return [
    [start[0] + nx, start[1] + ny],
    [end[0] + nx, end[1] + ny],
    [end[0] - nx, end[1] - ny],
    [start[0] - nx, start[1] - ny],
  ];
}

/** Which storeys to draw, and where each is placed. */
function chooseLevels(plan: FloorPlanResult, raw: string): { levels: FloorPlanLevel[]; all: boolean } {
  const want = raw.trim().toLowerCase();
  if (want === '' || want === 'all') return { levels: [...plan.levels], all: true };

  const index = Number.parseInt(want, 10);
  if (!Number.isInteger(index)) {
    throw new Error(`aec.export_dxf: level must be a storey number or "all", got "${raw}"`);
  }
  const level = plan.levels.find((l) => l.level === index);
  if (level === undefined) {
    const available = plan.levels.map((l) => l.level).join(', ');
    throw new Error(`aec.export_dxf: this plan has no level ${index} (levels present: ${available || 'none'})`);
  }
  return { levels: [level], all: false };
}

/**
 * ASCII on purpose: a hyphen rather than an em dash, "m2" rather than "m²".
 *
 * The writer would escape both to `\U+XXXX`, which AutoCAD renders correctly
 * and other readers show literally — a needless gamble for punctuation this
 * node chose itself. "m2" is also how area is conventionally annotated in CAD,
 * where superscript support depends on the text style. A room *name* still goes
 * through unchanged; that is the user's text, not ours.
 */
function roomLabel(room: PlanRoom): string {
  return `${room.name} - ${round2(room.areaM2)} m2`;
}

export const exportDxfNode: NodeModule<ExportDxfParams> = {
  manifest: {
    type: 'aec.export_dxf',
    version: 1,
    label: 'Export Floor Plan to DXF',
    description:
      'Writes a floor plan as a 2D CAD drawing (DXF R12) with rooms, walls, doors and labels on AIA-style layers. Unlike the IFC export, this carries real geometry you can open and draw over.',
    category: 'Report',
    keywords: ['dxf', 'cad', 'export', 'drawing', 'plan', 'autocad'],
    // Same plan and params produce byte-identical output, so a repeated export
    // is a cache hit and the content store deduplicates it (§7.3).
    caching: 'pure',
    lane: 'io',
    permissions: [],
    params: {
      type: 'object',
      properties: {
        file_name: {
          type: 'string',
          title: 'File name',
          default: 'plan.dxf',
        },
        level: {
          type: 'string',
          title: 'Storey',
          description:
            'A storey number (0 is the ground floor), or "all" to place every storey side by side in one drawing.',
          default: 'all',
        },
        text_height_mm: {
          type: 'number',
          title: 'Label text height (mm)',
          description: 'Drawing units are millimetres, so 200 is a 200 mm tall label — legible at 1:100.',
          default: 200,
          minimum: 1,
        },
        include_labels: {
          type: 'boolean',
          title: 'Room labels',
          description: 'Write each room’s name and area at its centroid.',
          default: true,
        },
        include_doors: {
          type: 'boolean',
          title: 'Door openings',
          description:
            'Mark each door as a circle of its width. Doors carry no orientation in the plan data, so no swing arc is drawn.',
          default: true,
        },
      },
    },
    inputs: [{ id: 'floor_plan', type: 'json', label: 'Floor plan', required: true }],
    outputs: [
      { id: 'dxf', type: 'asset<dxf>', label: 'DXF' },
      { id: 'entity_count', type: 'number', label: 'Entities' },
      { id: 'levels_drawn', type: 'number', label: 'Levels drawn' },
    ],
  },

  async execute(ctx, inputs, params) {
    const plan = requireInput<FloorPlanResult>(inputs, 'floor_plan', 'aec.export_dxf');
    const { levels, all } = chooseLevels(plan, params.level);

    const entities: DxfEntity[] = [];
    const used = new Set<string>();
    const layer = (role: LayerRole, level: number): string => {
      const name = layerName(role, level);
      used.add(name);
      return name;
    };

    // Side by side when drawing every storey, because a plan sheet is how
    // storeys are read together — stacking them at the same origin would
    // overlay six floors on top of one another. The gutter is a tenth of the
    // site, floored at two metres: wide enough to read as a separation at any
    // zoom, narrow enough that six storeys still fit on one screen. A full
    // site width as the gutter, which the first cut used, doubles the drawing
    // and pushes the storeys apart faster than the eye can group them.
    const gutter = Math.max(plan.site.widthMm / 10, 2000);
    const originFor = (index: number): number => (all ? index * (plan.site.widthMm + gutter) : 0);

    for (const [index, level] of levels.entries()) {
      const dx = originFor(index);
      const shift = (p: Point): Point => [p[0] + dx, p[1]];

      for (const room of level.rooms) {
        if (room.polygon.length >= 3) {
          entities.push({
            kind: 'polyline',
            layer: layer('roomBoundary', level.level),
            points: room.polygon.map(shift),
            closed: true,
          });
        }
        if (params.include_labels) {
          entities.push({
            kind: 'text',
            layer: layer('roomLabel', level.level),
            at: shift(polygonCentroid(room.polygon)),
            height: params.text_height_mm,
            text: roomLabel(room),
          });
        }
      }

      for (const wall of level.walls) {
        const outline = wallOutline(wall.start, wall.end, wall.thicknessMm);
        const role: LayerRole = wall.kind === 'exterior' ? 'wallExterior' : 'wallInterior';
        if (outline === null) continue;
        entities.push({
          kind: 'polyline',
          layer: layer(role, level.level),
          points: outline.map(shift),
          closed: true,
        });
      }

      if (params.include_doors) {
        for (const door of level.doors) {
          entities.push({
            kind: 'circle',
            layer: layer('door', level.level),
            centre: shift(door.position),
            radius: door.widthMm / 2,
          });
        }
      }

      for (const exit of level.exits) {
        entities.push({
          kind: 'circle',
          layer: layer('exit', level.level),
          centre: shift(exit.position),
          // Exits have no width in the plan data; a fixed 500 mm marker is a
          // symbol rather than a measurement, and is labelled as such here.
          radius: 500,
        });
      }
    }

    // Only layers that something was actually drawn on. An empty layer is
    // harmless but it makes a reader's layer list claim content that is not
    // there, and this file is read by people looking for what exists.
    const layers: DxfLayer[] = [];
    for (const level of levels) {
      for (const { role, color } of LAYERS) {
        const name = layerName(role, level.level);
        if (used.has(name)) layers.push({ name, color });
      }
    }

    const dxf = writeDxf({ layers, entities });
    const ref = await ctx.assets.put(new TextEncoder().encode(dxf), {
      // The IANA-registered type for DXF. `application/dxf` is common in the
      // wild but unregistered.
      mediaType: 'image/vnd.dxf',
      format: 'dxf',
      name: params.file_name,
    });

    ctx.log(
      'info',
      `wrote ${entities.length} entities across ${levels.length} level(s) to ${params.file_name}`,
      { bytes: ref.size, layers: layers.length },
    );

    return { dxf: ref, entity_count: entities.length, levels_drawn: levels.length };
  },
};
