/**
 * A minimal DXF writer, hand-rolled (ARCHITECTURE §6.1 `asset<dxf>`).
 *
 * Written rather than depended on, for the same reason `make-icon.py` writes
 * PNG bytes and `bim-model.ts` writes IFC STEP: DXF R12 is a documented,
 * line-oriented ASCII format, the subset a floor plan needs is small, and a
 * dependency here would be a native-adjacent parser in the path of an app that
 * otherwise needs none. What it costs is that every group code below has to be
 * right, which is why this file is pure and the test suite parses its output
 * back rather than eyeballing it.
 *
 * **R12 (`AC1009`), deliberately, and not R2000.** R2000 would let a room be a
 * single compact `LWPOLYLINE` instead of a `POLYLINE`/`VERTEX`…/`SEQEND` group,
 * which is roughly four times fewer lines. R12 is chosen anyway because it is
 * the version every reader written in the last thirty years accepts — AutoCAD,
 * LibreCAD, QCAD, ezdxf, and the browser viewers people actually paste a file
 * into. We cannot test in AutoCAD from here, so the tie-break goes to whatever
 * is most likely to open correctly the first time, and verbosity is free.
 *
 * **Coordinates are millimetres, passed through unscaled.** The floor plan
 * declares `units: 'mm'` and DXF is unitless — a number in the file means
 * whatever the reader is set to. Scaling to metres would be a silent
 * reinterpretation of the source data, so the numbers are the source's numbers
 * and `$INSUNITS` declares what they mean.
 *
 * Everything here is pure: same input, same bytes. That is what lets the
 * exporting node be `caching: 'pure'` and lets the content-addressed store
 * deduplicate a repeated export (§7.3).
 */

/** A point in the drawing, in millimetres. */
export type Point = readonly [number, number];

/** One layer in the output, with its AutoCAD Color Index. */
export interface DxfLayer {
  name: string;
  /** ACI: 1 red, 2 yellow, 3 green, 4 cyan, 5 blue, 6 magenta, 7 white/black, 8 grey. */
  color: number;
}

export type DxfEntity =
  | { kind: 'line'; layer: string; from: Point; to: Point }
  | { kind: 'polyline'; layer: string; points: readonly Point[]; closed: boolean }
  | { kind: 'circle'; layer: string; centre: Point; radius: number }
  | { kind: 'text'; layer: string; at: Point; height: number; text: string };

export interface DxfDrawing {
  layers: readonly DxfLayer[];
  entities: readonly DxfEntity[];
}

/**
 * One group code and its value, as the two lines DXF actually is.
 *
 * The format is nothing but this pair repeated: a code on its own line, then a
 * value on its own line. Building the file as a list of pairs rather than by
 * string concatenation is what keeps that invariant impossible to break by
 * accident — every `push` is structurally a complete record.
 */
type Pair = readonly [number, string];

/**
 * DXF reals, formatted to a fixed 6 decimals.
 *
 * Fixed rather than `String(n)` for two reasons. `String(1e-7)` yields
 * `"1e-7"`, and exponent notation is not universally accepted by DXF readers.
 * And a fixed width makes the output byte-identical for identical input on any
 * platform, which is the property the content-addressed store relies on.
 *
 * The `+ 0` normalises negative zero: `(-0).toFixed(6)` is `"-0.000000"`, which
 * is valid but makes two runs of the same drawing differ if a coordinate
 * happens to arrive with the opposite sign of zero.
 */
function real(n: number): string {
  if (!Number.isFinite(n)) {
    throw new TypeError(`dxf: refusing to write a non-finite coordinate (${String(n)})`);
  }
  // `toFixed` gives up above 1e21 and returns exponent notation regardless of
  // the digit count asked for — which is the one thing this function exists to
  // avoid. Nothing in a building is 1e21 mm across, so a coordinate that large
  // is corrupt input, and failing loudly beats writing a number no reader will
  // parse.
  if (Math.abs(n) >= 1e21) {
    throw new TypeError(`dxf: coordinate ${String(n)} is too large to write in fixed notation`);
  }
  return (n + 0).toFixed(6);
}

/**
 * A string safe to sit on a DXF value line.
 *
 * Two problems, both invisible until the file reaches a real reader.
 *
 * **Newlines split the record.** A DXF file is code line / value line, forever.
 * A room name containing a newline does not produce a wrapped label — it makes
 * every following line in the file land on the wrong side of the pairing, which
 * is unrecoverable corruption from that byte onward. Nothing upstream forbids a
 * newline in a room name, so this is the writer's job.
 *
 * **Non-ASCII is read in the reader's codepage, not ours.** R12 predates
 * Unicode: a reader decodes the bytes as its own single-byte codepage (cp1252,
 * typically), so UTF-8 output arrives as mojibake — "m²" reads as "mÂ²".
 * Escaping to `\U+XXXX` is the mechanism AutoCAD itself uses when saving a
 * Unicode drawing back to R12, so it is what readers expect; a reader that does
 * not decode it shows a legible escape rather than a corrupted glyph. The
 * happy side effect is that the whole file is then pure ASCII, which every
 * codepage agrees on — so `$DWGCODEPAGE` need not be guessed at.
 *
 * Iteration is by UTF-16 code unit rather than code point, so an astral
 * character becomes its two surrogate escapes — again matching what AutoCAD
 * writes.
 */
function text(s: string): string {
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const cu = s.charCodeAt(i);
    // A newline would break the pairing; a space keeps the label readable.
    if (cu === 0x0a || cu === 0x0d) {
      out += ' ';
    } else if (cu < 0x20 || cu === 0x7f) {
      // Other control characters carry no meaning in a drawing label.
      continue;
    } else if (cu < 0x7f) {
      out += s[i];
    } else {
      out += `\\U+${cu.toString(16).toUpperCase().padStart(4, '0')}`;
    }
  }
  return out;
}

/** The HEADER section: the few variables a reader actually consults. */
function header(bounds: { min: Point; max: Point }): Pair[] {
  return [
    [0, 'SECTION'],
    [2, 'HEADER'],
    // The version. Readers branch on this, and claiming a version we do not
    // emit is the fastest way to be rejected.
    [9, '$ACADVER'],
    [1, 'AC1009'],
    // Millimetres. R12 predates $INSUNITS, so a strict R12 reader ignores it —
    // it is emitted anyway because every modern reader honours it, and without
    // it a plan drawn in millimetres opens as though it were inches.
    [9, '$INSUNITS'],
    [70, '4'],
    // Drawing extents. Absent or wrong, "zoom extents" lands the user somewhere
    // that looks empty, which is indistinguishable from a file that failed to
    // load — the single most common way a technically-valid DXF reads as broken.
    [9, '$EXTMIN'],
    [10, real(bounds.min[0])],
    [20, real(bounds.min[1])],
    [9, '$EXTMAX'],
    [10, real(bounds.max[0])],
    [20, real(bounds.max[1])],
    [0, 'ENDSEC'],
  ];
}

/**
 * The TABLES section: linetypes then layers, in that order.
 *
 * The order is not cosmetic. Every layer below names `CONTINUOUS` as its
 * linetype, and a reader that meets that reference before the LTYPE table
 * defines it may refuse the file. Defining CONTINUOUS first costs nine lines
 * and removes the question.
 */
function tables(layers: readonly DxfLayer[]): Pair[] {
  const out: Pair[] = [
    [0, 'SECTION'],
    [2, 'TABLES'],

    [0, 'TABLE'],
    [2, 'LTYPE'],
    [70, '1'],
    [0, 'LTYPE'],
    [2, 'CONTINUOUS'],
    [70, '0'],
    [3, 'Solid line'],
    // 65 is the alignment code 'A'; a CONTINUOUS linetype has no dash pattern,
    // so the element count (73) is 0 and the pattern length (40) is 0.
    [72, '65'],
    [73, '0'],
    [40, '0.0'],
    [0, 'ENDTAB'],

    [0, 'TABLE'],
    [2, 'LAYER'],
    [70, String(layers.length)],
  ];

  for (const layer of layers) {
    out.push(
      [0, 'LAYER'],
      [2, text(layer.name)],
      // Flags. 0 means a perfectly ordinary layer: not frozen, not locked, not
      // off. A frozen layer draws nothing, which looks exactly like a file that
      // exported nothing.
      [70, '0'],
      [62, String(layer.color)],
      [6, 'CONTINUOUS'],
    );
  }

  out.push([0, 'ENDTAB'], [0, 'ENDSEC']);
  return out;
}

/** One entity as its group codes. */
function entity(e: DxfEntity): Pair[] {
  switch (e.kind) {
    case 'line':
      return [
        [0, 'LINE'],
        [8, text(e.layer)],
        [10, real(e.from[0])],
        [20, real(e.from[1])],
        [30, '0.0'],
        [11, real(e.to[0])],
        [21, real(e.to[1])],
        [31, '0.0'],
      ];

    case 'polyline': {
      // R12 polylines are a group, not an entity: a POLYLINE header, one VERTEX
      // each, and a SEQEND to close the group. Two codes on the header are
      // easy to omit and fatal to omit — 66/1 says "vertices follow", and the
      // 10/20/30 point is required even though it is always zero and unused.
      const out: Pair[] = [
        [0, 'POLYLINE'],
        [8, text(e.layer)],
        [66, '1'],
        [70, e.closed ? '1' : '0'],
        [10, '0.0'],
        [20, '0.0'],
        [30, '0.0'],
      ];
      for (const [x, y] of e.points) {
        out.push([0, 'VERTEX'], [8, text(e.layer)], [10, real(x)], [20, real(y)], [30, '0.0']);
      }
      out.push([0, 'SEQEND'], [8, text(e.layer)]);
      return out;
    }

    case 'circle':
      return [
        [0, 'CIRCLE'],
        [8, text(e.layer)],
        [10, real(e.centre[0])],
        [20, real(e.centre[1])],
        [30, '0.0'],
        [40, real(e.radius)],
      ];

    case 'text':
      // Centre-justified, which for DXF means BOTH alignment codes and BOTH
      // points. When 72 is non-zero the 10/20 point is ignored and the 11/21
      // "second alignment point" is what positions the text — so a writer that
      // sets 72 and omits 11/21 puts every label at the origin. They are
      // emitted with the same value here, which is correct and self-evidently
      // deliberate.
      return [
        [0, 'TEXT'],
        [8, text(e.layer)],
        [10, real(e.at[0])],
        [20, real(e.at[1])],
        [30, '0.0'],
        [40, real(e.height)],
        [1, text(e.text)],
        [72, '1'],
        [11, real(e.at[0])],
        [21, real(e.at[1])],
        [31, '0.0'],
      ];
  }
}

/** Bounding box over everything drawn, for `$EXTMIN`/`$EXTMAX`. */
function extents(entities: readonly DxfEntity[]): { min: Point; max: Point } {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;

  const see = (x: number, y: number): void => {
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
  };

  for (const e of entities) {
    switch (e.kind) {
      case 'line':
        see(e.from[0], e.from[1]);
        see(e.to[0], e.to[1]);
        break;
      case 'polyline':
        for (const [x, y] of e.points) see(x, y);
        break;
      case 'circle':
        see(e.centre[0] - e.radius, e.centre[1] - e.radius);
        see(e.centre[0] + e.radius, e.centre[1] + e.radius);
        break;
      case 'text':
        see(e.at[0], e.at[1]);
        break;
    }
  }

  // An empty drawing has no extents. Zero is the honest answer and keeps the
  // file valid; the alternative, Infinity, would be written as "Infinity" and
  // rejected by `real`.
  if (!Number.isFinite(minX)) return { min: [0, 0], max: [0, 0] };
  return { min: [minX, minY], max: [maxX, maxY] };
}

/**
 * Serialise a drawing to DXF text.
 *
 * Line endings are LF, matching every other text artefact this project writes
 * (the IFC model, the CSV export, the markdown reports). DXF is historically a
 * CRLF format and readers accept either; consistency within the project is
 * worth more than matching a convention that no reader enforces.
 */
export function writeDxf(drawing: DxfDrawing): string {
  const pairs: Pair[] = [
    ...header(extents(drawing.entities)),
    ...tables(drawing.layers),
    [0, 'SECTION'],
    [2, 'ENTITIES'],
    ...drawing.entities.flatMap(entity),
    [0, 'ENDSEC'],
    [0, 'EOF'],
  ];

  // Every pair is two lines, and the file ends on a newline so it terminates on
  // a record boundary.
  return `${pairs.map(([code, value]) => `${code}\n${value}`).join('\n')}\n`;
}
