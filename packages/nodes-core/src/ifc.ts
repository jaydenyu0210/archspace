/**
 * The parts of IFC authoring that are arithmetic rather than bookkeeping.
 *
 * `bim-model.ts` emits the entity records; everything here is the geometry and
 * formatting underneath them, pulled out for the same reason `dxf.ts` is
 * separate from `export-dxf.ts`: it is pure, it is where the mistakes live, and
 * a mistake here produces a file that parses perfectly and renders wrongly.
 *
 * IFC coordinates are millimetres throughout, matching `FloorPlanResult` and
 * the `IFCSIUNIT(*,.LENGTHUNIT.,.MILLI.,.METRE.)` the model declares. Nothing
 * is rescaled on the way through.
 */

/** A point in plan, in millimetres. */
export type Point2 = readonly [number, number];

/**
 * A number as a STEP real.
 *
 * STEP requires every real to carry a decimal point — `1` is an integer literal
 * and a parser will type it as one, which is a schema violation wherever a real
 * is expected. `String(n)` gets this wrong twice: it drops the point on whole
 * numbers, and for small magnitudes it produces `1e-7`, which has no decimal
 * point at all and is not a legal STEP real. Both matter here: unit direction
 * vectors are the one place this writer produces very small numbers, and a wall
 * running due north has an x-component of about 6e-17 rather than a clean zero.
 *
 * Values that small are numerical noise standing in for zero, so they are
 * flushed to zero rather than dressed up in exponent notation. Above that,
 * `toPrecision` keeps enough digits for millimetre geometry without writing out
 * seventeen of them, and the result is normalised to always contain a `.`.
 */
export function stepReal(n: number): string {
  if (!Number.isFinite(n)) {
    throw new TypeError(`ifc: refusing to write a non-finite number (${String(n)})`);
  }
  // Below a micrometre in a model measured in millimetres, and below any
  // plausible direction-cosine, this is round-off pretending to be a value.
  if (Math.abs(n) < 1e-9) return '0.';
  if (Number.isInteger(n) && Math.abs(n) < 1e15) return `${n}.`;

  const fixed = n.toPrecision(12);
  // toPrecision may still choose exponent form for extreme magnitudes; those
  // are legal STEP as long as the mantissa keeps its point, which the
  // normalisation below guarantees.
  if (fixed.includes('e') || fixed.includes('E')) {
    const [mantissa, exponent] = fixed.split(/[eE]/) as [string, string];
    const withPoint = mantissa.includes('.') ? mantissa : `${mantissa}.`;
    return `${withPoint}E${exponent}`;
  }
  // Trim the trailing zeros toPrecision pads with, but never the point itself:
  // "12.300000" becomes "12.3", and "12.000000" becomes "12." rather than "12".
  return fixed.includes('.') ? fixed.replace(/0+$/, '') : `${fixed}.`;
}

/** A STEP string literal, with embedded quotes doubled. */
export function stepString(v: string): string {
  return `'${v.replace(/'/g, "''")}'`;
}

/**
 * Twice the signed area of a polygon (the shoelace sum).
 *
 * Positive means counter-clockwise. The sign is the whole point of computing
 * it — see `counterClockwise`.
 */
export function signedArea2(polygon: readonly Point2[]): number {
  let sum = 0;
  for (let i = 0; i < polygon.length; i++) {
    const [x0, y0] = polygon[i] as Point2;
    const [x1, y1] = polygon[(i + 1) % polygon.length] as Point2;
    sum += x0 * y1 - x1 * y0;
  }
  return sum;
}

/**
 * A polygon wound counter-clockwise.
 *
 * `IfcArbitraryClosedProfileDef` takes the outer curve as counter-clockwise;
 * hand it a clockwise ring and the swept solid comes out with inverted normals,
 * which a viewer renders as a room lit from the inside or not at all. Nothing
 * upstream guarantees a winding — `PlanRoom.polygon` is whatever the generator
 * emitted — so it is established here rather than assumed.
 */
export function counterClockwise(polygon: readonly Point2[]): readonly Point2[] {
  return signedArea2(polygon) < 0 ? [...polygon].reverse() : polygon;
}

/**
 * The local placement of a wall drawn along a centreline.
 *
 * A wall is modelled as a rectangle swept upward, so its own axis must run
 * along the wall: the placement sits at `start`, its X axis points down the
 * wall, and the profile is then a plain `length × thickness` rectangle in that
 * local frame. The alternative — an axis-aligned profile per wall — cannot
 * represent a wall that is not parallel to an axis at all.
 *
 * Returns `null` for a zero-length wall, which has no direction to point along.
 * A degenerate solid is worse than an absent one: it is invisible in a viewer
 * but still counted in every quantity take-off.
 */
export function wallAxis(
  start: Point2,
  end: Point2,
): { origin: Point2; refDirection: Point2; length: number } | null {
  const dx = end[0] - start[0];
  const dy = end[1] - start[1];
  const length = Math.hypot(dx, dy);
  if (length === 0) return null;
  return { origin: start, refDirection: [dx / length, dy / length], length };
}
