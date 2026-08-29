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
   * Every storey the budget allows, so the panel can offer a storey switcher —
   * the first cut sent only the ground floor, which showed a sixth of a
   * six-storey building and implied the rest did not exist. `levelCount` is the
   * total in the plan, so `levels.length < levelCount` is what the UI reports
   * rather than quietly presenting a partial building as a whole one.
   *
   * Still enormously smaller than what it replaces: the full value is 261,000
   * characters of JSON, of which the generic preview showed the leading 6%,
   * cut mid-structure.
   */
  | {
      kind: 'plan';
      levels: PlanLevelPreview[];
      /** Storeys in the plan, which may exceed `levels.length`. */
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
 * How many characters of table cells one preview may carry.
 *
 * A row cap alone bounds the wrong thing. §7.6's promise is that bulk data
 * never reaches the renderer, and fifty rows of short cells and fifty rows of a
 * megabyte each are the same number of rows — so a node whose table holds long
 * text (an MCP tool returning documents, a review whose findings quote source)
 * put megabytes on every `node:succeeded` event, which the renderer receives
 * for every node of every run. The plan path already budgets bytes for exactly
 * this reason; this is the same rule applied to the one shape that was still
 * counted rather than measured.
 *
 * Matched to `TEXT_CAP` because a table preview and a text preview are the same
 * promise about the same channel.
 */
const TABLE_CELL_BUDGET = TEXT_CAP;

/**
 * How much plan geometry one preview may carry, counted in drawable items — a
 * polygon vertex, a wall, a door, an exit.
 *
 * A budget rather than a storey count, because storeys are not the same size:
 * six floors of this example are about 1,600 items and 34 KB, while a tower
 * with a hundred thin floors would be neither. The preview rides on every
 * `node:succeeded` event, so what has to be bounded is the bytes, not the
 * floors.
 */
const PLAN_ITEM_BUDGET = 4_000;

/** And a hard stop on storeys, so a tall building cannot spend the whole
 *  budget on floors nobody will click through. */
const PLAN_LEVEL_CAP = 24;

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

  const point = (v: Value): [number, number] | null =>
    Array.isArray(v) && typeof v[0] === 'number' && typeof v[1] === 'number' ? [v[0], v[1]] : null;

  /** One storey, or null if there is nothing on it worth drawing. */
  const readLevel = (entry: Value): PlanLevelPreview | null => {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) return null;
    const level = entry as Record<string, Value>;

    const rooms: PlanLevelPreview['rooms'] = [];
    for (const item of Array.isArray(level.rooms) ? level.rooms : []) {
      if (typeof item !== 'object' || item === null || Array.isArray(item)) continue;
      const room = item as Record<string, Value>;
      const polygon = (Array.isArray(room.polygon) ? room.polygon : [])
        .map(point)
        .filter((p): p is [number, number] => p !== null);
      if (polygon.length < 3) continue;
      rooms.push({ name: typeof room.name === 'string' ? room.name : '', polygon });
    }

    const walls: PlanLevelPreview['walls'] = [];
    for (const item of Array.isArray(level.walls) ? level.walls : []) {
      if (typeof item !== 'object' || item === null || Array.isArray(item)) continue;
      const wall = item as Record<string, Value>;
      const start = point(wall.start);
      const end = point(wall.end);
      if (start === null || end === null) continue;
      walls.push([start[0], start[1], end[0], end[1], typeof wall.thicknessMm === 'number' ? wall.thicknessMm : 100]);
    }

    const doors: PlanLevelPreview['doors'] = [];
    for (const item of Array.isArray(level.doors) ? level.doors : []) {
      if (typeof item !== 'object' || item === null || Array.isArray(item)) continue;
      const door = item as Record<string, Value>;
      const at = point(door.position);
      if (at === null) continue;
      doors.push([at[0], at[1], typeof door.widthMm === 'number' ? door.widthMm : 900]);
    }

    const exits: PlanLevelPreview['exits'] = [];
    for (const item of Array.isArray(level.exits) ? level.exits : []) {
      if (typeof item !== 'object' || item === null || Array.isArray(item)) continue;
      const at = point((item as Record<string, Value>).position);
      if (at !== null) exits.push(at);
    }

    if (rooms.length === 0 && walls.length === 0) return null;
    return {
      level: typeof level.level === 'number' ? level.level : 0,
      rooms,
      walls,
      doors,
      exits,
    };
  };

  const items = (level: PlanLevelPreview): number =>
    level.rooms.reduce((n, r) => n + r.polygon.length, 0)
    + level.walls.length + level.doors.length + level.exits.length;

  const kept: PlanLevelPreview[] = [];
  let spent = 0;
  for (const entry of levels) {
    if (kept.length >= PLAN_LEVEL_CAP) break;
    const level = readLevel(entry);
    if (level === null) continue;
    const cost = items(level);
    // The first storey goes in whatever it costs: a preview that budgets its
    // way down to nothing is worse than one that is slightly over.
    if (kept.length > 0 && spent + cost > PLAN_ITEM_BUDGET) break;
    kept.push(level);
    spent += cost;
  }

  // Nothing drawable is not a plan. Falling through to JSON at least shows
  // whatever did arrive, which is what someone debugging needs to see.
  if (kept.length === 0) return null;

  const dims = site as Record<string, Value>;
  return {
    kind: 'plan',
    levels: kept,
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
    // Rows are taken whole, and only while there is budget for them: half a
    // row is not a row, and `totalRows` is what tells the UI it is looking at
    // a window. The first row goes in whatever it costs, for the reason the
    // plan budget gives — a preview that can decline to show anything is not
    // a preview.
    const rows: Record<string, Value>[] = [];
    let spent = 0;
    for (const row of table.rows) {
      if (rows.length >= TABLE_ROW_CAP) break;
      const cost = JSON.stringify(row)?.length ?? 0;
      if (rows.length > 0 && spent + cost > TABLE_CELL_BUDGET) break;
      rows.push(row);
      spent += cost;
    }
    return {
      kind: 'table',
      columns: table.columns.map((c) => ({ id: c.id, ...(c.label !== undefined ? { label: c.label } : {}) })),
      rows,
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
