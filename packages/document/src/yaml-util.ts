import {
  Document,
  Pair,
  Scalar,
  YAMLMap,
  YAMLSeq,
  isNode,
  isScalar,
  visit,
  type Node,
  type ToStringOptions,
} from 'yaml';

/**
 * Canonical stringify options (ARCHITECTURE §4.2 / ADR-0004): 2-space
 * indent, never wrap long lines (edges and prompts must stay one-line /
 * verbatim), LF endings and a single trailing newline come from the yaml
 * package itself. Flow collections are padded — `{ x: 120, y: 240 }` — with
 * the requires lists as the one exception, expressed via UnpaddedFlowSeq
 * below because the yaml package only has a global padding option.
 */
export const STR_OPTS: ToStringOptions = {
  lineWidth: 0,
  indent: 2,
  indentSeq: true,
  flowCollectionPadding: true,
};

/**
 * A flow sequence that stringifies without inner padding — `[revit]`, not
 * `[ revit ]` — so the requires lists match the canonical format while
 * layout flow maps keep the default padding. Purely a stringify-style
 * subclass; it adds no state, so parsed sequences can be re-tagged onto it
 * with Object.setPrototypeOf.
 */
export class UnpaddedFlowSeq extends YAMLSeq {
  override toString(
    ctx?: Parameters<YAMLSeq['toString']>[0],
    onComment?: Parameters<YAMLSeq['toString']>[1],
    onChompKeep?: Parameters<YAMLSeq['toString']>[2],
  ): string {
    if (ctx === undefined) return super.toString();
    return super.toString({ ...ctx, flowCollectionPadding: '' }, onComment, onChompKeep);
  }
}

/**
 * True for strings a block scalar cannot carry safely: any line ending in a
 * space or tab, or any CR. The yaml package round-trips both, but the emitted
 * file would then hold trailing whitespace (or a CR) that a whitespace-
 * stripping editor, formatter, or git hook silently eats — corrupting a
 * prompt. Canonical emission (§4.2 rule 1) forces double quotes instead, so
 * the whitespace is escaped and the file stays clean.
 */
export function needsQuoting(s: string): boolean {
  return /[ \t](\n|$)/.test(s) || s.includes('\r');
}

/** Force double quotes on every hazardous string scalar inside `node`. */
export function hardenScalars<T>(node: T): T {
  visit(node as Node | Document, {
    Scalar(_key, scalar) {
      if (typeof scalar.value === 'string' && needsQuoting(scalar.value)) {
        scalar.type = Scalar.QUOTE_DOUBLE;
      }
    },
  });
  return node;
}

/** doc.createNode with hazardous strings hardened — use for any value we write. */
export function newValueNode(doc: Document, value: unknown): unknown {
  return hardenScalars(doc.createNode(value));
}

/** String form of a map key (scalar keys stringify their value). */
export function keyString(k: unknown): string {
  if (isScalar(k)) return String(k.value);
  return String(k);
}

export function findPair(map: YAMLMap, key: string): Pair | undefined {
  return (map.items as Pair[]).find((p) => keyString(p.key) === key);
}

export function findPairIndex(map: YAMLMap, key: string): number {
  return (map.items as Pair[]).findIndex((p) => keyString(p.key) === key);
}

export function deletePair(map: YAMLMap, key: string): boolean {
  const i = findPairIndex(map, key);
  if (i < 0) return false;
  map.items.splice(i, 1);
  return true;
}

/**
 * Index at which to insert a new `key` so known keys keep their canonical
 * relative order: directly after the last existing pair whose key precedes
 * `key` in `order`. Unknown keys never move.
 */
export function insertIndexFor(map: YAMLMap, key: string, order: readonly string[]): number {
  const keyPos = order.indexOf(key);
  if (keyPos < 0) return map.items.length;
  let after = -1;
  const items = map.items as Pair[];
  for (let i = 0; i < items.length; i++) {
    const pos = order.indexOf(keyString(items[i].key));
    if (pos >= 0 && pos < keyPos) after = i;
  }
  return after + 1;
}

type Primitive = string | number | boolean | null;

function isPrimitive(v: unknown): v is Primitive {
  return (
    v === null || typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean'
  );
}

/** Carry comments/blank-line decorations from a replaced node to its successor. */
function copyDecorations(from: unknown, to: unknown): void {
  if (!isNode(from) || !isNode(to)) return;
  if (from.commentBefore !== undefined && to.commentBefore === undefined) {
    to.commentBefore = from.commentBefore;
  }
  if (from.comment !== undefined && to.comment === undefined) to.comment = from.comment;
  if (from.spaceBefore !== undefined && to.spaceBefore === undefined) {
    to.spaceBefore = from.spaceBefore;
  }
}

/**
 * Replace a pair's value with `value`, preserving as much of the original
 * scalar's formatting as is still valid: a scalar node is updated in place
 * (keeping its comments, and its quoting style when the value stays a
 * string), anything else is replaced wholesale with comments carried over.
 * `value` may be a prebuilt yaml Node.
 */
export function setPairValue(doc: Document, pair: Pair, value: unknown): void {
  const old = pair.value;
  if (isScalar(old) && isPrimitive(value) && !isNode(value)) {
    const bothStrings = typeof old.value === 'string' && typeof value === 'string';
    const bothInts =
      typeof old.value === 'number' &&
      typeof value === 'number' &&
      Number.isInteger(old.value) &&
      Number.isInteger(value);
    if (!bothStrings) old.type = undefined;
    if (!bothInts) old.format = undefined;
    old.value = value;
    // A style inherited from the previous value may not survive this one.
    if (typeof value === 'string' && needsQuoting(value)) old.type = Scalar.QUOTE_DOUBLE;
    return;
  }
  const node = isNode(value) ? hardenScalars(value) : (doc.createNode(value) as Node);
  hardenScalars(node);
  copyDecorations(old, node);
  pair.value = node;
}

/**
 * Ordered upsert: update the existing pair for `key` (via setPairValue) or
 * insert a new pair at its canonical position per `order`.
 */
export function mapSet(
  doc: Document,
  map: YAMLMap,
  key: string,
  value: unknown,
  order: readonly string[],
): void {
  const pair = findPair(map, key);
  if (pair) {
    setPairValue(doc, pair, value);
    return;
  }
  const valueNode = hardenScalars(isNode(value) ? value : (doc.createNode(value) as Node));
  const p = new Pair(doc.createNode(key), valueNode);
  map.items.splice(insertIndexFor(map, key, order), 0, p);
}

/** Round a canvas position to an integer, normalizing -0 to 0. */
export function roundPos(v: number): number {
  return Math.round(v) + 0;
}

/**
 * Deep structural equality over JSON-shaped values. Numbers compare with
 * `===` semantics except that NaN equals NaN and -0 equals 0, so equality
 * matches what survives a YAML round trip.
 */
export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a === 'number' && typeof b === 'number') {
    return Number.isNaN(a) && Number.isNaN(b);
  }
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((v, i) => deepEqual(v, b[i]));
  }
  if (
    a !== null &&
    b !== null &&
    typeof a === 'object' &&
    typeof b === 'object' &&
    !Array.isArray(a) &&
    !Array.isArray(b)
  ) {
    const ka = Object.keys(a);
    const kb = Object.keys(b);
    if (ka.length !== kb.length) return false;
    return ka.every(
      (k) =>
        Object.hasOwn(b, k) &&
        deepEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]),
    );
  }
  return false;
}
