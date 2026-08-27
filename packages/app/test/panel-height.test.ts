/**
 * The execution panel's height, and the arithmetic that keeps it sane.
 *
 * Nothing here throws when it is wrong. A bad clamp swallows the canvas or
 * collapses the log; an inverted drag delta makes the panel flee the cursor;
 * a remembered height outlives the window it was chosen in and takes over a
 * smaller one. All three read as layout bugs rather than as arithmetic.
 */
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_PANEL_HEIGHT,
  MIN_PANEL_HEIGHT,
  clampPanelHeight,
  heightFromDrag,
} from '../src/renderer/src/panel-height.js';

const TALL = 1000;

describe('clampPanelHeight', () => {
  it('leaves a reasonable height alone', () => {
    expect(clampPanelHeight(216, TALL)).toBe(216);
    expect(clampPanelHeight(480, TALL)).toBe(480);
  });

  it('keeps the log from collapsing to a slit', () => {
    expect(clampPanelHeight(0, TALL)).toBe(MIN_PANEL_HEIGHT);
    expect(clampPanelHeight(-500, TALL)).toBe(MIN_PANEL_HEIGHT);
  });

  it('always leaves the canvas something to be', () => {
    // Dragging to the top of the window would otherwise leave a graph editor
    // with no graph in it.
    const height = clampPanelHeight(TALL, TALL);
    expect(height).toBeLessThan(TALL);
    expect(TALL - height).toBeGreaterThanOrEqual(180);
  });

  it('re-fits a height chosen in a bigger window', () => {
    // A remembered 600px panel on a 1400px display, reopened on a laptop.
    const onLaptop = clampPanelHeight(600, 700);
    expect(onLaptop).toBeLessThanOrEqual(700 - 180);
    expect(onLaptop).toBeGreaterThanOrEqual(MIN_PANEL_HEIGHT);
  });

  it('prefers a cramped panel to an impossible one when the window is tiny', () => {
    // Below about 300px there is no height that satisfies both bounds. A
    // cramped panel is recoverable by resizing the window; a negative one is
    // not, and a zero-height grid row makes the panel vanish with no way back.
    for (const viewport of [50, 120, 200, 300]) {
      const height = clampPanelHeight(400, viewport);
      expect(height, `viewport ${viewport}`).toBe(MIN_PANEL_HEIGHT);
      expect(height).toBeGreaterThan(0);
    }
  });

  it('falls back to the default rather than propagating a bad number', () => {
    // localStorage holds strings; `Number('')` is 0 and `Number('x')` is NaN,
    // and a NaN grid row collapses the panel silently.
    expect(clampPanelHeight(Number.NaN, TALL)).toBe(DEFAULT_PANEL_HEIGHT);
    expect(clampPanelHeight(Infinity, TALL)).toBe(DEFAULT_PANEL_HEIGHT);
  });

  it('returns whole pixels', () => {
    expect(clampPanelHeight(216.7, TALL)).toBe(217);
    expect(Number.isInteger(clampPanelHeight(300.4, TALL))).toBe(true);
  });
});

describe('heightFromDrag', () => {
  it('grows the panel when the divider is dragged up', () => {
    // The divider is the panel's top edge, so the delta is inverted. Get the
    // sign wrong and the panel runs away from the cursor.
    expect(heightFromDrag(216, 500, 400, TALL)).toBe(316);
    // 100px down from 216 is 116, under the floor — so the floor.
    expect(heightFromDrag(216, 500, 600, TALL)).toBe(MIN_PANEL_HEIGHT);
  });

  it('shrinks it when dragged down, to the floor and no further', () => {
    expect(heightFromDrag(400, 300, 400, TALL)).toBe(300);
    expect(heightFromDrag(216, 500, 900, TALL)).toBe(MIN_PANEL_HEIGHT);
  });

  it('never escapes the clamp mid-drag', () => {
    for (const y of [0, 100, 500, 900, 5000, -5000]) {
      const height = heightFromDrag(216, 500, y, TALL);
      expect(height).toBeGreaterThanOrEqual(MIN_PANEL_HEIGHT);
      expect(height).toBeLessThanOrEqual(TALL - 180);
    }
  });

  it('is a no-op when the pointer has not moved', () => {
    expect(heightFromDrag(216, 500, 500, TALL)).toBe(216);
  });
});
