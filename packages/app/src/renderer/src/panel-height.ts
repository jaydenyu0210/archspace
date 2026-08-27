/**
 * How tall the execution panel is, and where that is remembered.
 *
 * The panel was a fixed 216 px because it held a log. It now also holds a
 * drawn floor plan, and 216 px leaves about 130 px for it — enough to see that
 * a plan exists and not enough to read one. Rather than take canvas space from
 * every workflow, including the ones that produce no drawing, the divider
 * moves.
 *
 * Pure, and separate from the component, so the clamping is testable: a height
 * that escapes its bounds does not throw, it silently swallows the canvas or
 * collapses the log, and either looks like a layout bug rather than a
 * miscalculation.
 */

/** Below this the log is a slit and the panel is not worth having open. */
export const MIN_PANEL_HEIGHT = 120;

/** The panel's height before anyone drags it. */
export const DEFAULT_PANEL_HEIGHT = 216;

/** The canvas must keep at least this much, whatever the window measures. */
const MIN_CANVAS_HEIGHT = 180;

const STORAGE_KEY = 'archspace.execPanelHeight';

/**
 * A height that fits the window.
 *
 * The upper bound is derived from the viewport rather than fixed, because a
 * height that was reasonable on a large display becomes the entire window on a
 * laptop — and a remembered value outlives the window it was chosen in. When
 * the window is too short to honour even the minimum, the minimum wins: a
 * cramped panel is recoverable by resizing the window, a negative one is not.
 */
export function clampPanelHeight(height: number, viewportHeight: number): number {
  if (!Number.isFinite(height)) return DEFAULT_PANEL_HEIGHT;
  const max = Math.max(viewportHeight - MIN_CANVAS_HEIGHT, MIN_PANEL_HEIGHT);
  return Math.round(Math.min(Math.max(height, MIN_PANEL_HEIGHT), max));
}

/**
 * The height for a drag that started at `startY` with the panel at
 * `startHeight`.
 *
 * The divider is the panel's top edge, so dragging up makes it taller — the
 * delta is inverted, which is the sort of sign error that produces a panel
 * fleeing the cursor.
 */
export function heightFromDrag(
  startHeight: number,
  startY: number,
  currentY: number,
  viewportHeight: number,
): number {
  return clampPanelHeight(startHeight + (startY - currentY), viewportHeight);
}

/**
 * The remembered height, or the default.
 *
 * Wrapped because storage is not guaranteed to exist or to be readable — a
 * private window, a cleared profile, a browser configured to refuse site data —
 * and a preference that cannot be read is not a reason to fail to render.
 */
export function loadPanelHeight(viewportHeight: number): number {
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    if (stored === null) return DEFAULT_PANEL_HEIGHT;
    return clampPanelHeight(Number(stored), viewportHeight);
  } catch {
    return DEFAULT_PANEL_HEIGHT;
  }
}

export function savePanelHeight(height: number): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, String(height));
  } catch {
    // A preference that cannot be saved is not worth interrupting anyone over.
  }
}
