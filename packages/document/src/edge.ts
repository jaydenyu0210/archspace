import type { DocEdge } from './types';

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
  return {
    from: { node: m[1], port: m[2] },
    to: { node: m[3], port: m[4] },
  };
}

export function formatEdge(e: DocEdge): string {
  return `${e.from.node}.${e.from.port} -> ${e.to.node}.${e.to.port}`;
}
