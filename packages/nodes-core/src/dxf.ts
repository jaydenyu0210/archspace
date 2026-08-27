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
 * The 32 characters cp1252 places in 0x80–0x9F, where Latin-1 has controls.
 *
 * Everything else in cp1252 is Latin-1, i.e. the code point is the byte. This
 * table is the entire difference between the two.
 */
const CP1252_HIGH = '\u20AC\u0081\u201A\u0192\u201E\u2026\u2020\u2021\u02C6\u2030\u0160\u2039\u0152\u008D\u017D\u008F'
  + '\u0090\u2018\u2019\u201C\u201D\u2022\u2013\u2014\u02DC\u2122\u0161\u203A\u0153\u009D\u017E\u0178';

/** The cp1252 byte for a character, or -1 if the codepage cannot hold it. */
function cp1252Byte(cu: number): number {
  if (cu < 0x80 || (cu >= 0xa0 && cu <= 0xff)) return cu;
  const high = CP1252_HIGH.indexOf(String.fromCharCode(cu));
  return high === -1 ? -1 : 0x80 + high;
}

/**
 * A string safe to sit on a DXF value line.
 *
 * Two problems, both invisible until the file reaches a real reader.
 *
 * **Newlines split the record.** A DXF file is code line / value line, forever.
 * A room name containing a newline does not produce a wrapped label — it makes
 * every following line in the file land on the wrong side of the pairing.
 * Readers report this as `Invalid group code "Room 12.00 m2"`, pointing at
 * wherever the damage surfaced rather than where it started. Nothing upstream
 * forbids a newline in a room name, so this is the writer's job.
 *
 * **Non-ASCII is read in the file's declared codepage.** R12 predates Unicode;
 * UTF-8 only arrives with R2007. The header declares `ANSI_1252`, so the bytes
 * must be cp1252 — write UTF-8 into a cp1252 file and "Küche" arrives as
 * "KÃ¼che". Characters cp1252 can represent are therefore kept as-is and
 * encoded at the byte layer by `encodeCp1252`; the rest fall back to AutoCAD's
 * `\U+XXXX` escape, which is the only mechanism R12 has for them.
 *
 * The escape is the fallback rather than the rule because it is not universally
 * decoded — ezdxf returns it as a literal string — whereas a correctly encoded
 * cp1252 byte is right in every reader. So accented Latin, which is the case
 * that actually occurs in room names, survives everywhere; CJK degrades to an
 * escape that is at least legible and obviously an escape.
 */
function text(s: string): string {
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const cu = s.charCodeAt(i);
    // A newline would break the pairing; a space keeps the label readable.
    if (cu === 0x0a || cu === 0x0d) {
      out += ' ';
      continue;
    }
    // Other control characters carry no meaning in a drawing label.
    if (cu < 0x20 || cu === 0x7f) continue;
    out += cp1252Byte(cu) === -1
      ? `\\U+${cu.toString(16).toUpperCase().padStart(4, '0')}`
      : s[i];
  }
  return out;
}

/**
 * DXF text as cp1252 bytes, matching the `$DWGCODEPAGE` the header declares.
 *
 * Separate from `writeDxf` so the writer stays a pure string function that
 * tests can read, with the encoding applied once at the boundary. Every
 * character reaching here has already been through `text()`, so the codepage
 * cannot fail — the throw is a guard against a future caller, not a case that
 * arises.
 */
export function encodeCp1252(dxf: string): Uint8Array {
  const bytes = new Uint8Array(dxf.length);
  for (let i = 0; i < dxf.length; i++) {
    const byte = cp1252Byte(dxf.charCodeAt(i));
    if (byte === -1) {
      throw new RangeError(`dxf: U+${dxf.charCodeAt(i).toString(16)} is not representable in cp1252`);
    }
    bytes[i] = byte;
  }
  return bytes;
}

/**
 * A layer name, checked against R12's rules for a symbol name.
 *
 * R12 symbol names are not free text: letters, digits, `$`, `-` and `_` only,
 * at most 31 characters, and no spaces. A name outside that is another file
 * that some readers accept and AutoCAD does not, so it is rejected here rather
 * than silently rewritten — quietly renaming a layer would break the match
 * between the LAYER table and the entities referring to it, which is a worse
 * failure than an error the caller can see.
 */
function symbolName(name: string): string {
  if (!/^[A-Za-z0-9$_-]{1,31}$/.test(name)) {
    throw new RangeError(
      `dxf: "${name}" is not a valid R12 layer name (letters, digits, $ - _ only, 1-31 characters)`,
    );
  }
  return name;
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
    // The codepage the text bytes are in. R12 has no UTF-8 mode, so a reader
    // decodes by this declaration; `encodeCp1252` writes bytes to match.
    [9, '$DWGCODEPAGE'],
    [3, 'ANSI_1252'],
    // Millimetres. R12 predates $INSUNITS, so a strict R12 reader ignores it —
    // it is emitted anyway because every modern reader honours it, and without
    // it a plan drawn in millimetres opens as though it were inches.
    [9, '$INSUNITS'],
    [70, '4'],
    // Metric, and decimal display. Neither declares the unit — $INSUNITS does
    // that — but a reader that has ignored $INSUNITS still picks sane defaults
    // from these rather than falling back to imperial.
    [9, '$MEASUREMENT'],
    [70, '1'],
    [9, '$LUNITS'],
    [70, '2'],
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
    // Two silent failures guarded in one line. A negative 62 means "layer off"
    // — the file loads with no complaint and draws nothing. And a group code in
    // the integer range given a decimal value ("7.0") makes libdxfrw, which is
    // LibreCAD and QCAD, reject the entire file, while lenient readers coerce
    // it and hide the problem.
    if (!Number.isInteger(layer.color) || layer.color < 1 || layer.color > 255) {
      throw new RangeError(
        `dxf: layer "${layer.name}" needs an integer ACI colour in 1..255, got ${String(layer.color)}`,
      );
    }
    out.push(
      [0, 'LAYER'],
      [2, symbolName(layer.name)],
      // Flags. 0 means a perfectly ordinary layer: not frozen, not locked, not
      // off. A frozen layer draws nothing, which looks exactly like a file that
      // exported nothing.
      [70, '0'],
      [62, String(layer.color)],
      [6, 'CONTINUOUS'],
    );
  }

  out.push(
    [0, 'ENDTAB'],

    // STANDARD is what a TEXT entity with no explicit style resolves to, and an
    // undefined symbol is the same class of hazard as an undefined linetype:
    // AutoCAD refuses files that reference one, while lenient readers quietly
    // substitute a default and a local test proves nothing. Code 40 must be 0 —
    // a non-zero fixed height on the style silently overrides every TEXT's own
    // height. Code 4 is the big-font name: the code line is followed by an
    // empty value line, which is a real record and not an omitted one.
    [0, 'TABLE'],
    [2, 'STYLE'],
    [70, '1'],
    [0, 'STYLE'],
    [2, 'STANDARD'],
    [70, '0'],
    [40, '0.0'],
    [41, '1.0'],
    [50, '0.0'],
    [71, '0'],
    [42, '2.5'],
    [3, 'txt'],
    [4, ''],
    [0, 'ENDTAB'],

    [0, 'ENDSEC'],
  );
  return out;
}

/** One entity as its group codes. */
function entity(e: DxfEntity): Pair[] {
  switch (e.kind) {
    case 'line':
      return [
        [0, 'LINE'],
        [8, symbolName(e.layer)],
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
        [8, symbolName(e.layer)],
        [66, '1'],
        [70, e.closed ? '1' : '0'],
        [10, '0.0'],
        [20, '0.0'],
        [30, '0.0'],
      ];
      for (const [x, y] of e.points) {
        out.push([0, 'VERTEX'], [8, symbolName(e.layer)], [10, real(x)], [20, real(y)], [30, '0.0']);
      }
      out.push([0, 'SEQEND'], [8, symbolName(e.layer)]);
      return out;
    }

    case 'circle':
      return [
        [0, 'CIRCLE'],
        [8, symbolName(e.layer)],
        [10, real(e.centre[0])],
        [20, real(e.centre[1])],
        [30, '0.0'],
        [40, real(e.radius)],
      ];

    case 'text':
      // A TEXT with height 0 draws nothing and audits perfectly clean, which is
      // the worst combination available.
      if (!(e.height > 0)) {
        throw new RangeError(`dxf: text "${e.text}" needs a positive height, got ${String(e.height)}`);
      }
      // Centre-justified, which for DXF means BOTH alignment codes and BOTH
      // points. When 72 is non-zero the 10/20 point is ignored and the 11/21
      // "second alignment point" is what positions the text — so a writer that
      // sets 72 and omits 11/21 puts every label at the origin. They are
      // emitted with the same value here, which is correct and self-evidently
      // deliberate.
      return [
        [0, 'TEXT'],
        [8, symbolName(e.layer)],
        [10, real(e.at[0])],
        [20, real(e.at[1])],
        [30, '0.0'],
        [40, real(e.height)],
        [1, text(e.text)],
        // 72 centres horizontally, 73 vertically. Without 73 the baseline sits
        // on the point, so a room label rides above its own centroid by most of
        // its height — subtle enough to look intentional and wrong at any scale.
        [72, '1'],
        [73, '2'],
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
      // A TEXT with height 0 draws nothing and audits perfectly clean, which is
      // the worst combination available.
      if (!(e.height > 0)) {
        throw new RangeError(`dxf: text "${e.text}" needs a positive height, got ${String(e.height)}`);
      }
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
 * Line endings are CRLF, which is what AutoCAD itself emits. LF was the first
 * choice, for consistency with every other text artefact this project writes —
 * but consistency inside the repository is the wrong thing to optimise for in a
 * file whose entire purpose is to be opened somewhere else. Readers mostly
 * accept either (libdxfrw strips one trailing CR, ezdxf reads both), and
 * "mostly" is the reason to match the convention rather than the project.
 */
export function writeDxf(drawing: DxfDrawing): string {
  const pairs: Pair[] = [
    ...header(extents(drawing.entities)),
    ...tables(drawing.layers),
    // Empty, and present anyway. This writer defines no blocks, but AutoCAD's
    // own R12 output always carries a BLOCKS section and some readers expect
    // the four-section shape. Four lines to remove a question.
    [0, 'SECTION'],
    [2, 'BLOCKS'],
    [0, 'ENDSEC'],
    [0, 'SECTION'],
    [2, 'ENTITIES'],
    ...drawing.entities.flatMap(entity),
    [0, 'ENDSEC'],
    [0, 'EOF'],
  ];

  // Every pair is two lines, and the file ends on a newline so it terminates on
  // a record boundary — 0/EOF is the last record, and a reader that does not
  // find it rejects the whole file.
  // Group codes are right-justified in a three-character field, which is what
  // AutoCAD's DXFOUT emits. The DXFIN format is free-form so nothing requires
  // it — but matching the reference output costs two bytes a line and removes
  // one more way to differ from a file that is known to open. Value lines are
  // never padded: leading whitespace there becomes part of the string, so a
  // padded layer name would define a layer nothing refers to.
  return `${pairs.map(([code, value]) => `${String(code).padStart(3)}\r\n${value}`).join('\r\n')}\r\n`;
}
