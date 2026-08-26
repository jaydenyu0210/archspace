/**
 * Canonical text for a NEW workflow file (ARCHITECTURE §4.2 / ADR-0004).
 *
 * The write path with no history to respect: nothing exists on disk, so every
 * byte is ours to choose, and the choice is fixed key order, `requires`
 * derived from the nodes, and integer-rounded layout — two people generating
 * from the same document get identical bytes.
 *
 * This is emphatically NOT the path for saving a file that already exists.
 * That is `save.ts`, which patches the CST, because re-emitting a file a human
 * has edited would silently discard their comments (ADR-0004 decision 4). The
 * two modules share `assertValidDoc` and `canonicalNodeShape` so a patched
 * file and a freshly emitted one cannot disagree about the shape of a node
 * entry — the one place the two paths could drift apart unnoticed.
 */
import { Document, Scalar, isMap, isSeq } from 'yaml';
import type { DocNode, WorkflowDoc } from './types.js';
import { deriveRequires, type DeriveRequiresOptions } from './requires.js';
import { formatEdge } from './edge.js';
import { STR_OPTS, UnpaddedFlowSeq, hardenScalars, keyString, roundPos } from './yaml-util.js';

/**
 * The two-line comment a canonical new file carries above `requires:`
 * (ARCHITECTURE §4.2). Patching never re-adds or removes it on existing
 * files — it exists only because emitWorkflow writes it.
 */
export const REQUIRES_COMMENT =
  ' Generated on save from the nodes below; lets humans and CI see what a\n' +
  ' workflow needs without loading a node registry.';

/**
 * Canonical shape of one node entry: id, type, version, schemaHash (omitted
 * when absent), config (omitted when empty) — ARCHITECTURE §4.2 rule 1.
 */
export function canonicalNodeShape(n: DocNode): Record<string, unknown> {
  return {
    id: n.id,
    type: n.type,
    version: n.version,
    ...(n.schemaHash !== undefined ? { schemaHash: n.schemaHash } : {}),
    ...(Object.keys(n.config ?? {}).length > 0 ? { config: n.config } : {}),
  };
}

/** Shared input validation for emit/save: a doc that violates these could
 * not be re-parsed, so refuse to serialize it. */
export function assertValidDoc(doc: WorkflowDoc): void {
  const seen = new Set<string>();
  for (const n of doc.nodes) {
    if (seen.has(n.id)) throw new TypeError(`duplicate node id "${n.id}"`);
    seen.add(n.id);
  }
  for (const e of doc.edges) {
    for (const end of [e.from, e.to]) {
      if (!seen.has(end.node)) {
        throw new TypeError(`edge references unknown node "${end.node}"`);
      }
    }
  }
}

/**
 * Emit canonical text for a NEW file (ARCHITECTURE §4.2): fixed key order,
 * insertion-ordered nodes/edges, requires derived from nodes (the incoming
 * doc.requires is a parse artifact and is ignored), layout last with keys in
 * node order and integer-rounded flow-map positions, block scalars for
 * multi-line strings, LF endings, 2-space indent, no line wrapping.
 */
export function emitWorkflow(doc: WorkflowDoc, options: DeriveRequiresOptions = {}): string {
  assertValidDoc(doc);
  const requires = deriveRequires(doc.nodes, options);
  const layout: Record<string, { x: number; y: number }> = {};
  for (const n of doc.nodes) {
    const p = doc.layout[n.id];
    if (p !== undefined) layout[n.id] = { x: roundPos(p.x), y: roundPos(p.y) };
  }
  const rootObj = {
    archspace: 1,
    kind: 'workflow',
    meta: {
      name: doc.meta.name === '' ? 'Untitled workflow' : doc.meta.name,
      // empty/undefined description ≡ absent
      ...(doc.meta.description !== undefined && doc.meta.description !== ''
        ? { description: doc.meta.description }
        : {}),
    },
    requires,
    nodes: doc.nodes.map(canonicalNodeShape),
    edges: doc.edges.map(formatEdge),
    layout,
  };
  const ydoc = new Document(rootObj, { version: '1.2' });
  const root = ydoc.contents;
  if (!isMap(root)) throw new Error('unreachable: document root is a map by construction');
  for (const pair of root.items) {
    const k = keyString(pair.key);
    const keyNode = pair.key as Scalar;
    if (k === 'requires' || k === 'nodes' || k === 'edges' || k === 'layout') {
      keyNode.spaceBefore = true;
    }
    if (k === 'requires') {
      keyNode.commentBefore = REQUIRES_COMMENT;
      if (isMap(pair.value)) {
        for (const rp of pair.value.items) {
          if (isSeq(rp.value)) {
            Object.setPrototypeOf(rp.value, UnpaddedFlowSeq.prototype);
            rp.value.flow = true;
          }
        }
      }
    }
    if (k === 'layout' && isMap(pair.value)) {
      for (const lp of pair.value.items) {
        if (isMap(lp.value)) lp.value.flow = true;
      }
    }
  }
  // Every scalar here is ours, so hardening the whole document is safe;
  // saveWorkflow hardens only the values it writes, leaving untouched
  // regions byte-identical.
  hardenScalars(ydoc);
  return ydoc.toString(STR_OPTS);
}
