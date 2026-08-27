/**
 * Fitting a floor plan into a preview panel.
 *
 * Split from the component for the reason `drift.ts` is split from `store.ts`:
 * this is arithmetic, arithmetic is where the mistakes are, and the app's test
 * runner is deliberately DOM-free (see vitest.config.ts). A wrong number here
 * draws a plan off-screen or inside-out, which looks like nothing at all.
 *
 * Everything is in millimetres, matching what the engine sends and what the DXF
 * export writes — the SVG viewBox does the scaling, so no coordinate is ever
 * pre-multiplied and a number on screen still means what it meant upstream.
 */
import type { PlanLevelPreview } from '@archspace/engine';

export interface PlanBox {
  minX: number;
  minY: number;
  width: number;
  height: number;
}

/**
 * The box to draw, in plan coordinates.
 *
 * Taken from the geometry rather than from the site dimensions, because a wall
 * on the site boundary is drawn at its true thickness and so overhangs the site
 * by half of it — fitting to the site alone clips exactly the edges someone
 * checks first. The site is the floor, not the ceiling: an empty level still
 * gets the site's box so the panel shows an empty plot rather than collapsing.
 */
export function planBounds(level: PlanLevelPreview, site: { widthMm: number; depthMm: number }): PlanBox {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;

  const see = (x: number, y: number): void => {
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
  };

  for (const room of level.rooms) for (const [x, y] of room.polygon) see(x, y);
  for (const [x1, y1, x2, y2, thickness] of level.walls) {
    const half = Math.max(thickness, 0) / 2;
    see(x1 - half, y1 - half);
    see(x2 + half, y2 + half);
  }
  for (const [x, y, width] of level.doors) see(x + width / 2, y + width / 2);
  for (const [x, y] of level.exits) see(x, y);

  if (!Number.isFinite(minX)) {
    return { minX: 0, minY: 0, width: Math.max(site.widthMm, 1), height: Math.max(site.depthMm, 1) };
  }

  // A degenerate box divides by zero downstream and renders nothing; one
  // millimetre is enough to keep the arithmetic honest.
  const width = Math.max(maxX - minX, 1);
  const height = Math.max(maxY - minY, 1);
  // A little air, so boundary walls are not flush against the panel edge.
  const pad = Math.max(width, height) * 0.02;
  return { minX: minX - pad, minY: minY - pad, width: width + pad * 2, height: height + pad * 2 };
}

/** The axis-aligned bounds of one polygon. */
export function polygonBox(polygon: readonly (readonly [number, number])[]): PlanBox | null {
  if (polygon.length === 0) return null;
  const xs = polygon.map((p) => p[0]);
  const ys = polygon.map((p) => p[1]);
  const minX = Math.min(...xs);
  const minY = Math.min(...ys);
  return { minX, minY, width: Math.max(...xs) - minX, height: Math.max(...ys) - minY };
}

/**
 * A type size that renders about the same on screen whatever the plan measures.
 *
 * The viewBox scales millimetres to pixels, so a fixed millimetre size is
 * legible on a 48 m plan and invisible on a 480 m one. Deriving it from the box
 * keeps roughly the same number of characters across the drawing at any scale.
 */
export function labelSize(box: PlanBox): number {
  return Math.max(box.width, box.height) / 55;
}

/**
 * How, if at all, this room can carry a drawn label.
 *
 * Labelling everything is what the first DXF render did, and in the narrow
 * rooms along the corridor the names collided into an unreadable smear. But
 * refusing every room that cannot hold its name *horizontally* was worse in the
 * other direction: a typical office plan is a corridor with deep, narrow rooms
 * off it — 5.2 m wide and 15.1 m deep here — so exactly one room in twenty-seven
 * got a label.
 *
 * Turning the label to run along the room is what a drafter does, and it is
 * what the geometry asks for: the same name that needs 8 m of width has 15 m of
 * depth available. Rotation is counter-clockwise, so the text reads bottom-to-
 * top, which is the drafting convention.
 *
 * A room that fits neither way is left to the tooltip, which every room gets.
 */
export type LabelOrientation = 'horizontal' | 'vertical' | null;

export function labelOrientation(room: PlanBox, text: string, size: number): LabelOrientation {
  // 0.55em per character is a reasonable mean for a proportional face; this
  // only has to separate "obviously fits" from "obviously does not".
  const needed = text.length * size * 0.55;
  const thickness = size * 1.8;
  if (room.width >= needed && room.height >= thickness) return 'horizontal';
  // Rotated, the name runs along the room's depth and needs its width only for
  // the type's own height.
  if (room.height >= needed && room.width >= thickness) return 'vertical';
  return null;
}

/**
 * A room label short enough to be worth drawing.
 *
 * Truncation is by whole words where it can be, because "Open workspace" reads
 * as a room and "Open worksp…" reads as a bug.
 */
export function shortLabel(name: string, max = 18): string {
  const trimmed = name.trim();
  if (trimmed.length <= max) return trimmed;
  const cut = trimmed.slice(0, max);
  const lastSpace = cut.lastIndexOf(' ');
  return `${(lastSpace > max * 0.5 ? cut.slice(0, lastSpace) : cut).trimEnd()}…`;
}

/**
 * A plan y-coordinate as an SVG y-coordinate.
 *
 * Plan north is up and SVG y grows downward, so the geometry is drawn inside a
 * flipped group. Labels cannot live in that group — mirrored text is
 * unreadable, and un-mirroring each one while also rotating it composes into a
 * transform nobody can check by eye. So labels are drawn unflipped and their
 * position is mapped here instead, which makes the rotation a plain
 * `rotate(-90)` about a point.
 */
export function flipY(box: PlanBox, y: number): number {
  return box.minY * 2 + box.height - y;
}

/** The transform that mirrors plan space into SVG space. */
export function flipTransform(box: PlanBox): string {
  return `translate(0 ${box.minY * 2 + box.height}) scale(1 -1)`;
}

/** `points` for an SVG polygon. */
export function polygonPoints(polygon: readonly (readonly [number, number])[]): string {
  return polygon.map(([x, y]) => `${x},${y}`).join(' ');
}
