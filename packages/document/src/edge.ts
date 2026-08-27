import type { DocEdge } from './types.js';

/**
 * Edges are single-line plain strings: `n_a.result -> n_b.context`
 * (ARCHITECTURE §4.2 rule 6). Parsing is lenient about surrounding
 * whitespace so hand-edited files load; formatting always emits the
 * canonical form with exactly one space on each side of `->`.
 * Each endpoint must be `<node>.<port>` with exactly one dot.
 */
const EDGE_RE =
  /^\s*([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)\s*->\s*([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)\s*$/;

export function parseEdge(s: string): DocEdge | null {
  const m = EDGE_RE.exec(s);
  if (!m) return null;
  // All four groups are non-optional, so a match guarantees them — but the type
  // cannot say so, and unlike a type expression there is no harmless empty
  // value to fall back to: an edge with a blank node id is not an edge. Falling
  // through to null keeps the impossible case inside this function's existing
  // "not a valid edge" answer.
  const [, fromNode, fromPort, toNode, toPort] = m;
  if (fromNode === undefined || fromPort === undefined || toNode === undefined || toPort === undefined) {
    return null;
  }
  return {
    from: { node: fromNode, port: fromPort },
    to: { node: toNode, port: toPort },
  };
}

export function formatEdge(e: DocEdge): string {
  return `${e.from.node}.${e.from.port} -> ${e.to.node}.${e.to.port}`;
}
