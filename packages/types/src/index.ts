/**
 * Port type system — ARCHITECTURE §6 / ADR-0006.
 *
 * Grammar:
 *   type       := primitive | container | assetType | pluginType | "any"
 *   primitive  := "text" | "number" | "boolean" | "json" | "chat" | "table"
 *   container  := "list<" type ">"
 *   assetType  := "asset" | "asset<" format ">"
 *   pluginType := <plugin-namespace> "." <name>     (two or more dot segments)
 *
 * Connection rules (§6.2): exact match; widening (asset<f> → asset, primitive/
 * container → json); a tiny lossless coercion table (number→text, boolean→text);
 * lift T → list<T>; `any` connects both ways with a runtime check. Everything
 * else — narrowing, list<T>→T, parsing — is an explicit node or an error.
 */

export type PrimitiveName = 'text' | 'number' | 'boolean' | 'json' | 'chat' | 'table';

export type ParsedType =
  | { kind: 'any' }
  | { kind: 'primitive'; name: PrimitiveName }
  | { kind: 'list'; item: ParsedType }
  | { kind: 'asset'; format?: string }
  | { kind: 'plugin'; namespace: string; name: string };

const PRIMITIVES: ReadonlySet<string> = new Set(['text', 'number', 'boolean', 'json', 'chat', 'table']);
const IDENT = /^[a-z][a-z0-9_]*$/;

/** Parse a port type expression. Returns null when the expression is invalid. */
export function parsePortType(input: string): ParsedType | null {
  const s = input.trim();
  if (s === 'any') return { kind: 'any' };
  if (PRIMITIVES.has(s)) return { kind: 'primitive', name: s as PrimitiveName };
  if (s === 'asset') return { kind: 'asset' };

  const generic = /^([a-z][a-z0-9_]*)<(.+)>$/.exec(s);
  if (generic) {
    // Both groups are non-optional, so a match guarantees them — but the type
    // cannot say so, and `?? ''` is better than asserting: an empty head
    // matches neither branch and an empty inner fails to parse, so the
    // impossible case degrades into this function's existing "not a valid type
    // expression" answer rather than into a crash.
    const head = generic[1] ?? '';
    const inner = generic[2] ?? '';
    if (head === 'list') {
      const item = parsePortType(inner);
      return item ? { kind: 'list', item } : null;
    }
    if (head === 'asset') {
      const format = inner.trim();
      return IDENT.test(format) ? { kind: 'asset', format } : null;
    }
    return null;
  }

  // Plugin nominal type: <namespace>.<name>, namespace itself may be dotted.
  const segments = s.split('.');
  if (segments.length >= 2 && segments.every((seg) => IDENT.test(seg))) {
    // `length >= 2` makes this present; falling through to null if it somehow
    // is not costs nothing and keeps the guarantee local to the read.
    const name = segments[segments.length - 1];
    if (name !== undefined) {
      return { kind: 'plugin', namespace: segments.slice(0, -1).join('.'), name };
    }
  }
  return null;
}

export function formatPortType(t: ParsedType): string {
  switch (t.kind) {
    case 'any': return 'any';
    case 'primitive': return t.name;
    case 'list': return `list<${formatPortType(t.item)}>`;
    case 'asset': return t.format ? `asset<${t.format}>` : 'asset';
    case 'plugin': return `${t.namespace}.${t.name}`;
  }
}

export function typeEquals(a: ParsedType, b: ParsedType): boolean {
  return formatPortType(a) === formatPortType(b);
}

export type CoercionName = 'number->text' | 'boolean->text';

/**
 * Result of asking "may a value of `from` be delivered to a port of `to`?".
 * - exact:     identical types
 * - widen:     asset<f> → asset, or primitive/container → json (identity at runtime)
 * - coerce:    engine-owned lossless conversion (number→text, boolean→text)
 * - lift:      auto-wrap into a one-element list; `inner` says how the element lands
 * - unchecked: `any` on either side — connects, engine checks the value at run time
 */
export type Assignability =
  | { ok: true; kind: 'exact' }
  | { ok: true; kind: 'widen' }
  | { ok: true; kind: 'coerce'; coercion: CoercionName }
  | { ok: true; kind: 'lift'; inner: Assignability & { ok: true } }
  | { ok: true; kind: 'unchecked' }
  | { ok: false; reason: string };

function resolve(t: ParsedType | string): ParsedType | null {
  return typeof t === 'string' ? parsePortType(t) : t;
}

/**
 * A type as it should appear in a message, whichever form the caller passed.
 *
 * `String()` on a `ParsedType` yields "[object Object]". Today that is
 * unreachable — `resolve` only returns null for a string it failed to parse —
 * but the reason is three lines away from the message, and this is the text a
 * user reads when a connection is refused. Rendering it properly costs one
 * call and stops being a latent trap.
 */
function describeType(t: ParsedType | string): string {
  return typeof t === 'string' ? t : formatPortType(t);
}

export function assignable(fromT: ParsedType | string, toT: ParsedType | string): Assignability {
  const from = resolve(fromT);
  const to = resolve(toT);
  if (!from) return { ok: false, reason: `invalid source type "${describeType(fromT)}"` };
  if (!to) return { ok: false, reason: `invalid target type "${describeType(toT)}"` };

  // `any` connects to everything, both directions, checked at run time.
  if (from.kind === 'any' || to.kind === 'any') return { ok: true, kind: 'unchecked' };

  if (typeEquals(from, to)) return { ok: true, kind: 'exact' };

  // Widening into json: every primitive and container, never asset or plugin types.
  if (to.kind === 'primitive' && to.name === 'json' && (from.kind === 'primitive' || from.kind === 'list')) {
    return { ok: true, kind: 'widen' };
  }

  // asset<format> → asset.
  if (to.kind === 'asset' && to.format === undefined && from.kind === 'asset') {
    return { ok: true, kind: 'widen' };
  }

  // The whole coercion table (§6.2 rule 7): lossless, total, cheap.
  if (from.kind === 'primitive' && to.kind === 'primitive' && to.name === 'text') {
    if (from.name === 'number') return { ok: true, kind: 'coerce', coercion: 'number->text' };
    if (from.name === 'boolean') return { ok: true, kind: 'coerce', coercion: 'boolean->text' };
  }

  // Lift T → list<U> when T lands in U by exact/widen/coerce. A lift never
  // contains another lift, so lifting cannot loop.
  if (to.kind === 'list') {
    const inner = assignable(from, to.item);
    if (inner.ok && inner.kind !== 'lift' && inner.kind !== 'unchecked') {
      return { ok: true, kind: 'lift', inner };
    }
  }

  return { ok: false, reason: `${formatPortType(from)} does not connect to ${formatPortType(to)}` };
}

/**
 * Apply an `ok` assignability to a runtime value: identity for exact/widen/
 * unchecked, string conversion for coercions, one-element wrap for lifts.
 */
export function applyAssignability(value: unknown, a: Assignability & { ok: true }): unknown {
  switch (a.kind) {
    case 'exact':
    case 'widen':
    case 'unchecked':
      return value;
    case 'coerce':
      return String(value);
    case 'lift':
      return [applyAssignability(value, a.inner)];
  }
}

/** Structural check that a runtime value inhabits a Value shape (JSON ∪ AssetRef). */
export function isValueShape(v: unknown): boolean {
  if (v === null || typeof v === 'string' || typeof v === 'boolean') return true;
  if (typeof v === 'number') return Number.isFinite(v);
  if (Array.isArray(v)) return v.every(isValueShape);
  if (typeof v === 'object') {
    return Object.getPrototypeOf(v) === Object.prototype || Object.getPrototypeOf(v) === null
      ? Object.values(v as Record<string, unknown>).every(isValueShape)
      : false;
  }
  return false;
}

function isAssetRefShape(v: unknown, format?: string): boolean {
  if (typeof v !== 'object' || v === null) return false;
  const r = v as Record<string, unknown>;
  if (r.kind !== 'asset' || typeof r.hash !== 'string' || typeof r.mediaType !== 'string' || typeof r.size !== 'number') {
    return false;
  }
  return format === undefined || r.format === format;
}

/**
 * Runtime type check — used by the engine at the boundary of `any` edges and
 * for finite-number enforcement (§6.1: NaN/±Inf rejected at the boundary).
 */
export function isValueOfType(v: unknown, t: ParsedType | string): boolean {
  const type = resolve(t);
  if (!type) return false;
  switch (type.kind) {
    case 'any':
      return isValueShape(v);
    case 'primitive':
      switch (type.name) {
        case 'text': return typeof v === 'string';
        case 'number': return typeof v === 'number' && Number.isFinite(v);
        case 'boolean': return typeof v === 'boolean';
        case 'json': return isValueShape(v);
        case 'chat':
          return Array.isArray(v) && v.every((m) => {
            if (typeof m !== 'object' || m === null) return false;
            const msg = m as Record<string, unknown>;
            return (msg.role === 'system' || msg.role === 'user' || msg.role === 'assistant')
              && typeof msg.content === 'string';
          });
        case 'table': {
          if (typeof v !== 'object' || v === null) return false;
          const tbl = v as Record<string, unknown>;
          return Array.isArray(tbl.columns)
            && tbl.columns.every((c) => typeof c === 'object' && c !== null && typeof (c as Record<string, unknown>).id === 'string')
            && Array.isArray(tbl.rows)
            && tbl.rows.every((r) => typeof r === 'object' && r !== null && !Array.isArray(r) && isValueShape(r));
        }
      }
      break;
    case 'list':
      return Array.isArray(v) && v.every((item) => isValueOfType(item, type.item));
    case 'asset':
      return isAssetRefShape(v, type.format);
    case 'plugin':
      // Nominal and opaque: the wire enforces provenance, not structure.
      return isValueShape(v);
  }
  return false;
}
