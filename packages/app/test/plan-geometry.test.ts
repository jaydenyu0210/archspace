/**
 * Fitting a floor plan into the preview panel.
 *
 * Every case here is one that draws *something* when it is wrong, which is why
 * they are worth writing: a plan scaled from the wrong box is off-screen, a
 * degenerate box divides by zero and renders nothing, and a label that does not
 * fit turns a room schedule into a smear. None of those throw.
 */
import { describe, expect, it } from 'vitest';
import type { PlanLevelPreview } from '@archspace/engine';
import {
  flipY,
  labelOrientation,
  labelSize,
  planBounds,
  polygonBox,
  polygonPoints,
  shortLabel,
} from '../src/renderer/src/plan-geometry.js';

const SITE = { widthMm: 48_000, depthMm: 32_000 };

const level = (over: Partial<PlanLevelPreview> = {}): PlanLevelPreview => ({
  level: 0,
  rooms: [],
  walls: [],
  doors: [],
  exits: [],
  ...over,
});

describe('planBounds', () => {
  it('fits the geometry, not the site', () => {
    // A wall on the boundary is drawn at its true thickness, so it overhangs
    // the site by half of it. Fitting to the site alone clips exactly the edge
    // someone checks first.
    const box = planBounds(level({ walls: [[0, 0, 48_000, 0, 200]] }), SITE);
    expect(box.minX).toBeLessThan(0);
    expect(box.minY).toBeLessThan(-99);
    expect(box.minX + box.width).toBeGreaterThan(48_000);
  });

  it('covers every room vertex', () => {
    const box = planBounds(
      level({
        rooms: [
          { name: 'A', polygon: [[0, 0], [10_000, 0], [10_000, 5_000], [0, 5_000]] },
          { name: 'B', polygon: [[20_000, 8_000], [30_000, 8_000], [30_000, 12_000], [20_000, 12_000]] },
        ],
      }),
      SITE,
    );
    expect(box.minX).toBeLessThanOrEqual(0);
    expect(box.minY).toBeLessThanOrEqual(0);
    expect(box.minX + box.width).toBeGreaterThanOrEqual(30_000);
    expect(box.minY + box.height).toBeGreaterThanOrEqual(12_000);
  });

  it('falls back to the site for an empty level rather than collapsing', () => {
    // Zero width divides by zero in the viewBox and renders nothing at all,
    // which is indistinguishable from a failed run.
    expect(planBounds(level(), SITE)).toEqual({ minX: 0, minY: 0, width: 48_000, height: 32_000 });
    expect(planBounds(level(), { widthMm: 0, depthMm: 0 })).toEqual({
      minX: 0, minY: 0, width: 1, height: 1,
    });
  });

  it('never returns a zero or negative extent', () => {
    // A single point, and a plan of one degenerate wall: both are real inputs
    // from a generator that produced something odd, and neither may produce a
    // viewBox the browser refuses.
    for (const l of [
      level({ rooms: [{ name: 'x', polygon: [[5, 5], [5, 5], [5, 5]] }] }),
      level({ walls: [[100, 100, 100, 100, 0]] }),
      level({ exits: [[7, 7]] }),
    ]) {
      const box = planBounds(l, SITE);
      expect(box.width).toBeGreaterThan(0);
      expect(box.height).toBeGreaterThan(0);
      expect(Number.isFinite(box.minX)).toBe(true);
      expect(Number.isFinite(box.minY)).toBe(true);
    }
  });

  it('ignores non-finite coordinates instead of poisoning the whole box', () => {
    // One NaN from upstream would otherwise make every bound NaN, and the
    // entire plan disappears because of a single bad room.
    const box = planBounds(
      level({
        rooms: [
          { name: 'good', polygon: [[0, 0], [1000, 0], [1000, 1000], [0, 1000]] },
          { name: 'bad', polygon: [[Number.NaN, 0], [Infinity, 5], [0, Number.NaN]] },
        ],
      }),
      SITE,
    );
    expect(Number.isFinite(box.width)).toBe(true);
    expect(box.width).toBeGreaterThan(0);
    expect(box.minX + box.width).toBeLessThan(2000);
  });
});

describe('polygonBox', () => {
  it('measures a polygon, and reports nothing for an empty one', () => {
    expect(polygonBox([[0, 0], [400, 0], [400, 200], [0, 200]])).toEqual({
      minX: 0, minY: 0, width: 400, height: 200,
    });
    expect(polygonBox([])).toBeNull();
  });
});

describe('labels', () => {
  it('sizes type to the plan, so it is legible at any scale', () => {
    // A fixed millimetre size is readable on a 48 m plan and invisible on a
    // 480 m one; the ratio is what stays constant.
    const small = labelSize({ minX: 0, minY: 0, width: 48_000, height: 32_000 });
    const large = labelSize({ minX: 0, minY: 0, width: 480_000, height: 320_000 });
    expect(large / small).toBeCloseTo(10, 6);
    expect(small).toBeGreaterThan(100);
  });

  it('turns a label to run along a room that is deeper than it is wide', () => {
    // The real shape of an office plan: a corridor with 5.2 m × 15.1 m rooms
    // off it. Requiring a horizontal fit labelled exactly one room in
    // twenty-seven; rotating is what a drafter does, and the depth is there.
    const size = 911;
    const typicalRoom = { minX: 0, minY: 0, width: 5_192, height: 15_100 };
    expect(labelOrientation(typicalRoom, 'Open workspace 1', size)).toBe('vertical');

    const wide = { minX: 0, minY: 0, width: 12_000, height: 6_000 };
    expect(labelOrientation(wide, 'Open workspace', size)).toBe('horizontal');
  });

  it('leaves a room unlabelled when the name fits neither way', () => {
    // A smear of overlapping names is worse than none; the tooltip covers it.
    const size = 800;
    const tiny = { minX: 0, minY: 0, width: 1_200, height: 1_200 };
    const hairline = { minX: 0, minY: 0, width: 12_000, height: 900 };
    expect(labelOrientation(tiny, 'Open workspace', size)).toBeNull();
    expect(labelOrientation(hairline, 'Open workspace', size)).toBeNull();
  });

  it('prefers horizontal when both orientations fit', () => {
    const size = 400;
    const square = { minX: 0, minY: 0, width: 10_000, height: 10_000 };
    expect(labelOrientation(square, 'Meeting', size)).toBe('horizontal');
  });

  it('truncates on a word boundary, so a name still reads as a name', () => {
    expect(shortLabel('Corridor')).toBe('Corridor');
    expect(shortLabel('Open workspace 12')).toBe('Open workspace 12');
    expect(shortLabel('Executive meeting room 4')).toBe('Executive meeting…');
    // No usable word boundary: a hard cut beats dropping to nothing.
    expect(shortLabel('Supercalifragilisticexpialidocious')).toBe('Supercalifragilist…');
    expect(shortLabel('  padded  ')).toBe('padded');
    expect(shortLabel('')).toBe('');
  });
});

describe('flipY', () => {
  it('is its own inverse, so a label lands where its room is', () => {
    // Plan north is up, SVG y grows down. Geometry is drawn mirrored and labels
    // are not — get this wrong and every name appears on the room opposite.
    const box = { minX: -1000, minY: -1000, width: 50_000, height: 34_000 };
    for (const y of [-1000, 0, 15_100, 33_000]) {
      expect(flipY(box, flipY(box, y))).toBeCloseTo(y, 9);
    }
    // The top of the box maps to the bottom, and the middle stays put.
    expect(flipY(box, box.minY)).toBeCloseTo(box.minY + box.height, 9);
    expect(flipY(box, box.minY + box.height / 2)).toBeCloseTo(box.minY + box.height / 2, 9);
  });
});

describe('polygonPoints', () => {
  it('emits the SVG points attribute', () => {
    expect(polygonPoints([[0, 0], [100, 0], [100, 50]])).toBe('0,0 100,0 100,50');
    expect(polygonPoints([])).toBe('');
  });
});
