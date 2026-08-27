/** Output previews (ARCHITECTURE §7.6): computed engine-side, size-capped,
 *  so the renderer/CLI never touch raw bulk data. */
import { isAssetRef, type AssetRef, type NodeManifest, type Outputs, type PortDecl, type Value } from '@archspace/node-sdk';
import { isValueOfType, parsePortType } from '@archspace/types';

/**
 * One storey, reduced to what it takes to draw it.
 *
 * Coordinates are millimetres, as the plan states them — the renderer scales to
 * fit rather than the engine pre-scaling, so the numbers here still mean what
 * they meant upstream and a reader can check them against the DXF.
 */
export interface PlanLevelPreview {
  level: number;
  rooms: { name: string; polygon: [number, number][] }[];
  /** `[x1, y1, x2, y2, thicknessMm]`, flattened: a wall is five numbers, and
   *  at ~640 walls per plan the key names cost more than the data. */
  walls: [number, number, number, number, number][];
  doors: [number, number, number][];
  exits: [number, number][];
}

export type ValuePreview =
  | { kind: 'text'; text: string; truncated: boolean }
  | { kind: 'json'; json: string; truncated: boolean } // pretty-printed, 2-space
  | { kind: 'table'; columns: { id: string; label?: string }[]; rows: Record<string, Value>[]; totalRows: number }
  | { kind: 'asset'; ref: AssetRef }
  /**
   * A floor plan, as geometry the UI can draw (`PortDecl.preview: 'plan'`).
   *
   * Only the first storey, because the panel shows one plan at a time and the
   * whole point is to be small: the full six-storey value is 261,000 characters
   * of JSON, of which the generic preview showed the leading 6%. `levelCount`
   * says what was left out so the UI can say so rather than implying the
   * building has one floor.
   */
  | {
      kind: 'plan';
      level: PlanLevelPreview;
      levelCount: number;
      site: { widthMm: number; depthMm: number };
      metrics?: Record<string, Value>;
    }
  | { kind: 'empty' };

export interface OutputPreview {
  port: string;
  type: string;
  preview: ValuePreview;
}

const TEXT_CAP = 16_000;
const TABLE_ROW_CAP = 50;

/**
 * A floor plan reduced to drawable geometry, or null if the value is not one.
 *
 * The hint on the port says what this value is meant to be; it does not
 * guarantee the value arrived intact — a node can be wrong, and an MCP tool or
 * a plugin is code this build did not write. So the shape is checked here and a
 * value that does not fit falls back to the generic JSON preview rather than
 * throwing, because a preview that crashes the run is far worse than a preview
 * that is merely unhelpful.
 */
function planPreview(value: Value): ValuePreview | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const plan = value as Record<string, Value>;
  const levels = plan.levels;
  const site = plan.site;
  if (!Array.isArray(levels) || typeof site !== 'object' || site === null || Array.isArray(site)) return null;

  const first = levels[0];
  if (typeof first !== 'object' || first === null || Array.isArray(first)) return null;
  const level = first as Record<string, Value>;

  const point = (v: Value): [number, number] | null =>
    Array.isArray(v) && typeof v[0] === 'number' && typeof v[1] === 'number' ? [v[0], v[1]] : null;

  const rooms: PlanLevelPreview['rooms'] = [];
  for (const entry of Array.isArray(level.rooms) ? level.rooms : []) {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) continue;
    const room = entry as Record<string, Value>;
    const polygon = (Array.isArray(room.polygon) ? room.polygon : [])
      .map(point)
      .filter((p): p is [number, number] => p !== null);
    if (polygon.length < 3) continue;
    rooms.push({ name: typeof room.name === 'string' ? room.name : '', polygon });
  }

  const walls: PlanLevelPreview['walls'] = [];
  for (const entry of Array.isArray(level.walls) ? level.walls : []) {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) continue;
    const wall = entry as Record<string, Value>;
    const start = point(wall.start);
    const end = point(wall.end);
    if (start === null || end === null) continue;
    walls.push([start[0], start[1], end[0], end[1], typeof wall.thicknessMm === 'number' ? wall.thicknessMm : 100]);
  }

  const doors: PlanLevelPreview['doors'] = [];
  for (const entry of Array.isArray(level.doors) ? level.doors : []) {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) continue;
    const door = entry as Record<string, Value>;
    const at = point(door.position);
    if (at === null) continue;
    doors.push([at[0], at[1], typeof door.widthMm === 'number' ? door.widthMm : 900]);
  }

  const exits: PlanLevelPreview['exits'] = [];
  for (const entry of Array.isArray(level.exits) ? level.exits : []) {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) continue;
    const at = point((entry as Record<string, Value>).position);
    if (at !== null) exits.push(at);
  }

  // Nothing to draw is not a plan. Falling through to JSON at least shows
  // whatever did arrive, which is what someone debugging needs to see.
  if (rooms.length === 0 && walls.length === 0) return null;

  const dims = site as Record<string, Value>;
  return {
    kind: 'plan',
    level: {
      level: typeof level.level === 'number' ? level.level : 0,
      rooms,
      walls,
      doors,
      exits,
    },
    levelCount: levels.length,
    site: {
      widthMm: typeof dims.widthMm === 'number' ? dims.widthMm : 0,
      depthMm: typeof dims.depthMm === 'number' ? dims.depthMm : 0,
    },
    ...(typeof plan.metrics === 'object' && plan.metrics !== null && !Array.isArray(plan.metrics)
      ? { metrics: plan.metrics as Record<string, Value> }
      : {}),
  };
}

export function previewValue(
  portType: string,
  value: Value | undefined,
  hint?: PortDecl['preview'],
): ValuePreview {
  if (value === null || value === undefined) return { kind: 'empty' };
  if (isAssetRef(value)) return { kind: 'asset', ref: value };

  if (hint === 'plan') {
    const plan = planPreview(value);
    if (plan !== null) return plan;
  }

  const parsed = parsePortType(portType);
  if (parsed?.kind === 'primitive' && parsed.name === 'text' && typeof value === 'string') {
    return { kind: 'text', text: value.slice(0, TEXT_CAP), truncated: value.length > TEXT_CAP };
  }
  if (parsed?.kind === 'primitive' && parsed.name === 'table' && isValueOfType(value, 'table')) {
    const table = value as { columns: { id: string; label?: string }[]; rows: Record<string, Value>[] };
    return {
      kind: 'table',
      columns: table.columns.map((c) => ({ id: c.id, ...(c.label !== undefined ? { label: c.label } : {}) })),
      rows: table.rows.slice(0, TABLE_ROW_CAP),
      totalRows: table.rows.length,
    };
  }
  const json = JSON.stringify(value, null, 2) ?? 'null';
  return { kind: 'json', json: json.slice(0, TEXT_CAP), truncated: json.length > TEXT_CAP };
}

export function outputPreviews(manifest: NodeManifest, outputs: Outputs): OutputPreview[] {
  return manifest.outputs.map((port) => ({
    port: port.id,
    type: port.type,
    preview: previewValue(port.type, outputs[port.id], port.preview),
  }));
}
