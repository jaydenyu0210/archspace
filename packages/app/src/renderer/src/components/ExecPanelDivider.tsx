/**
 * The draggable edge between the canvas and the execution panel.
 *
 * The panel was a fixed height because it held a log; it now also holds a drawn
 * floor plan, which needs more room than a log does — but only sometimes, and
 * only for some workflows. A divider lets the person looking at a plan have the
 * space without taking it from someone looking at a graph.
 *
 * The height is written to a CSS custom property on the shell rather than held
 * in the store, because it is a view preference with no bearing on the document
 * and nothing else needs to react to it. Keeping it out of the store also keeps
 * it out of undo.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  DEFAULT_PANEL_HEIGHT,
  MIN_PANEL_HEIGHT,
  clampPanelHeight,
  heightFromDrag,
  loadPanelHeight,
  savePanelHeight,
} from '../panel-height';

/** Keyboard nudge, in pixels — the same order as a deliberate mouse drag. */
const STEP = 24;

export function ExecPanelDivider() {
  const [height, setHeight] = useState(DEFAULT_PANEL_HEIGHT);
  const dragging = useRef<{ startY: number; startHeight: number } | null>(null);
  /**
   * The current height, readable from an event handler.
   *
   * `height` in a handler's closure is the value from the render that created
   * it, and pointermove → pointerup can complete inside a single task with no
   * render between them. Saving from state therefore persisted whatever the
   * height was when the drag *started*: the panel resized correctly and then
   * came back the old size on relaunch, which reads as the preference not being
   * saved at all rather than as a stale read.
   */
  const latest = useRef(DEFAULT_PANEL_HEIGHT);

  const apply = useCallback((next: number): void => {
    latest.current = next;
    setHeight(next);
    document.documentElement.style.setProperty('--exec-panel-height', `${next}px`);
  }, []);

  // The remembered height is read after mount, not during render: it comes from
  // storage, and reading storage during render makes the first paint depend on
  // something that can throw.
  useEffect(() => {
    apply(loadPanelHeight(window.innerHeight));
  }, [apply]);

  // A height chosen in a large window can swallow a small one. Re-clamping on
  // resize keeps the canvas usable without the user having to notice why.
  useEffect(() => {
    const onResize = (): void => apply(clampPanelHeight(latest.current, window.innerHeight));
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [apply]);

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>): void => {
    dragging.current = { startY: e.clientY, startHeight: height };
    // Capture, so a fast drag that outruns the 6px handle keeps tracking
    // instead of stopping wherever the pointer left it.
    e.currentTarget.setPointerCapture(e.pointerId);
  };

  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>): void => {
    const drag = dragging.current;
    if (drag === null) return;
    apply(heightFromDrag(drag.startHeight, drag.startY, e.clientY, window.innerHeight));
  };

  const endDrag = (e: React.PointerEvent<HTMLDivElement>): void => {
    if (dragging.current === null) return;
    dragging.current = null;
    e.currentTarget.releasePointerCapture(e.pointerId);
    savePanelHeight(latest.current);
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>): void => {
    const delta = e.key === 'ArrowUp' ? STEP : e.key === 'ArrowDown' ? -STEP : 0;
    if (delta === 0) return;
    e.preventDefault();
    const next = clampPanelHeight(latest.current + delta, window.innerHeight);
    apply(next);
    savePanelHeight(next);
  };

  return (
    <div
      className="exec-divider"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onKeyDown={onKeyDown}
      // A separator is the ARIA role for exactly this, and being focusable is
      // what makes the keyboard path above reachable at all.
      role="separator"
      aria-orientation="horizontal"
      aria-label="Resize the execution panel"
      aria-valuenow={height}
      aria-valuemin={MIN_PANEL_HEIGHT}
      tabIndex={0}
    />
  );
}
