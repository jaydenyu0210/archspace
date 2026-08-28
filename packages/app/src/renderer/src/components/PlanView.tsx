/**
 * A floor plan, drawn.
 *
 * Before this, inspecting the `Generate Floor Plan` node — the headline node of
 * an application about floor plans — showed the leading 6% of a 261,000
 * character JSON blob, cut mid-structure. The geometry was always there; it was
 * being rendered as the one thing nobody can read.
 *
 * The drawing mirrors the DXF export deliberately: the same room boundaries,
 * the same walls at their true thickness, the same door and exit markers. If
 * what is on screen and what opens in CAD ever disagree, that is a bug worth
 * seeing, and making them look alike is what makes it visible.
 *
 * SVG rather than canvas because the whole plan is a few hundred elements, it
 * stays sharp at any zoom, and a room can carry a `<title>` — which is how
 * every room gets an identity without the label collisions that drawing all of
 * them produces.
 */
import { useState } from 'react';
import type { PlanLevelPreview } from '@archspace/engine';
import {
  flipTransform,
  flipY,
  labelOrientation,
  labelSize,
  planBounds,
  polygonBox,
  polygonPoints,
  shortLabel,
} from '../plan-geometry';

export interface PlanViewProps {
  levels: PlanLevelPreview[];
  /** Storeys in the plan, which may exceed `levels.length`. */
  levelCount: number;
  site: { widthMm: number; depthMm: number };
}

const metres = (mm: number): string => (mm / 1000).toFixed(1);

export function PlanView({ levels, levelCount, site }: PlanViewProps) {
  const [shown, setShown] = useState(0);
  // A re-run can return fewer storeys than the last one, and an index left
  // pointing past the end renders nothing at all.
  const level = levels[Math.min(shown, levels.length - 1)];
  if (level === undefined) return null;

  const box = planBounds(level, site);
  const size = labelSize(box);

  return (
    <div className="plan-view">
      {/* A labelled group of toggles rather than a tablist: `role="tab"`
          requires a `tabpanel` it controls, and claiming a pattern that is not
          fully implemented is worse for a screen reader than not claiming it. */}
      {levels.length > 1 && (
        <div className="plan-storeys" role="group" aria-label="Storey">
          {levels.map((l, i) => (
            <button
              key={l.level}
              type="button"
              aria-pressed={i === shown}
              className={`plan-storey${i === shown ? ' is-current' : ''}`}
              onClick={() => setShown(i)}
              // The plan numbers storeys from zero; people count from one.
              title={`Storey ${l.level + 1} — ${l.rooms.length} rooms`}
            >
              {l.level + 1}
            </button>
          ))}
        </div>
      )}
      <svg
        className="plan-svg"
        viewBox={`${box.minX} ${box.minY} ${box.width} ${box.height}`}
        // The box takes the plan's own proportions so the panel is not mostly
        // empty: fitting a 1.47-wide plan into a 2.7-wide box wasted a third of
        // the width. CSS caps the height, and `meet` letterboxes whatever is
        // left rather than distorting the drawing.
        style={{ aspectRatio: `${box.width} / ${box.height}` }}
        role="img"
        aria-label={`Floor plan, storey ${level.level + 1} of ${levelCount}`}
        preserveAspectRatio="xMidYMid meet"
      >
        {/* Plan north is up, SVG y grows down. Geometry is drawn mirrored;
            labels are not (see flipY) — mirrored text is unreadable. */}
        <g transform={flipTransform(box)}>
          {level.rooms.map((room, i) => (
            <polygon key={`r${i}`} className="plan-room" points={polygonPoints(room.polygon)}>
              <title>{room.name}</title>
            </polygon>
          ))}

          {level.walls.map(([x1, y1, x2, y2, thickness], i) => (
            <line
              key={`w${i}`}
              className="plan-wall"
              x1={x1}
              y1={y1}
              x2={x2}
              y2={y2}
              // Millimetres, straight through: a wall is as thick on screen as
              // it is in the model, which is what makes this a plan and not a
              // diagram.
              strokeWidth={Math.max(thickness, 1)}
            />
          ))}

          {level.doors.map(([x, y, width], i) => (
            <circle key={`d${i}`} className="plan-door" cx={x} cy={y} r={Math.max(width, 1) / 2} />
          ))}

          {level.exits.map(([x, y], i) => (
            <circle key={`e${i}`} className="plan-exit" cx={x} cy={y} r={size * 0.6} />
          ))}

        </g>

        {/* Labels sit outside the mirrored group and above the geometry, only
            where they fit — turned to run along the room when the room is
            deeper than it is wide, which is most of them on a corridor plan. */}
        {level.rooms.map((room, i) => {
          const roomBox = polygonBox(room.polygon);
          if (roomBox === null) return null;
          const text = shortLabel(room.name);
          if (text === '') return null;
          const orientation = labelOrientation(roomBox, text, size);
          if (orientation === null) return null;
          const cx = roomBox.minX + roomBox.width / 2;
          const cy = flipY(box, roomBox.minY + roomBox.height / 2);
          return (
            <text
              key={`t${i}`}
              className="plan-label"
              x={cx}
              y={cy}
              fontSize={size}
              textAnchor="middle"
              dominantBaseline="central"
              {...(orientation === 'vertical' ? { transform: `rotate(-90 ${cx} ${cy})` } : {})}
            >
              {text}
            </text>
          );
        })}
      </svg>

      <div className="plan-caption mono">
        storey {level.level + 1} of {levelCount} · {level.rooms.length} rooms ·{' '}
        {level.walls.length} walls · {level.doors.length} doors · site {metres(site.widthMm)} ×{' '}
        {metres(site.depthMm)} m
        {/* Only when storeys were actually dropped. Saying it unconditionally,
            as the first version did, claimed a limitation that no longer
            applies to a building this preview carries whole. */}
        {levels.length < levelCount && (
          <span className="plan-note">
            {' '}· {levels.length} of {levelCount} storeys previewed
          </span>
        )}
      </div>
    </div>
  );
}
