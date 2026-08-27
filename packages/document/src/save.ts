/**
 * Saving an existing workflow file, byte-identical wherever nothing changed
 * (ARCHITECTURE §4.2 / ADR-0004 decision 4 — the hard requirement).
 *
 * This module never serializes a document. It walks the CST that
 * `parseWorkflow` kept and applies only the differences, which is why it is
 * three times the size of `emit.ts` for the same output format. That size is
 * the feature: re-emitting would be a fraction of the code and would throw
 * away the comments, blank lines and quoting style the user wrote.
 *
 * The `*_ORDER` constants below say where a key goes when it is *inserted*.
 * They never reorder keys that are already present — `insertIndexFor` only
 * ever computes a position for something new. A save that tidied a human's key
 * order would be the same broken promise in a politer form.
 */
import { Pair, Scalar, YAMLMap, YAMLSeq, isMap, isSeq, type Document } from 'yaml';
import type { WorkflowDoc, WorkflowRequires } from './types.js';
import type { WorkflowSource } from './source.js';
import { extractWorkflow } from './extract.js';
import { deriveRequires, type DeriveRequiresOptions } from './requires.js';
import { formatEdge } from './edge.js';
import { assertValidDoc, canonicalNodeShape } from './emit.js';
import {
  STR_OPTS,
  UnpaddedFlowSeq,
  deepEqual,
  deletePair,
  findPair,
  insertIndexFor,
  mapSet,
  newValueNode,
  roundPos,
} from './yaml-util.js';

const ROOT_ORDER = ['archspace', 'kind', 'meta', 'requires', 'nodes', 'edges', 'layout'] as const;
const META_ORDER = ['name', 'description'] as const;
const REQUIRES_ORDER = ['mcp', 'ai', 'plugins'] as const;
const NODE_ORDER = ['id', 'type', 'version', 'schemaHash', 'config'] as const;

type RootKey = (typeof ROOT_ORDER)[number];

/**
 * Patch, don't re-emit (ADR-0004 decision 4 — the hard requirement).
 *
 * Applies the difference between the CST held by `source` and the given
 * `doc` to the CST, so user comments, unknown-but-valid fields, and the
 * formatting of everything untouched survive. The diff baseline is
 * extractWorkflow(source) — the exact doc a parse of the current text
 * returns — which is what makes `saveWorkflow(parse(t).source, parse(t).doc)`
 * byte-identical to `t` for any well-formed `t`: nothing differs, nothing is
 * touched, and the original text is returned as-is.
 *
 * After patching, `source` reflects the new state, so the same handle
 * supports repeated saves.
 */
export function saveWorkflow(
  source: WorkflowSource,
  doc: WorkflowDoc,
  options: DeriveRequiresOptions = {},
): string {
  assertValidDoc(doc);
  const ydoc: Document = source.ydoc;
  const { doc: base } = extractWorkflow(ydoc);
  if (base === null) {
    throw new Error('saveWorkflow: source no longer holds a valid workflow document');
  }
  const rootNode = ydoc.contents;
  if (!isMap(rootNode)) throw new Error('saveWorkflow: source root is not a map');
  const root = rootNode as unknown as YAMLMap;

  let dirty = false;
  const touch = (): void => {
    dirty = true;
  };

  /** Find or create a top-level section pair at its canonical position.
   * New sections get the canonical blank line before them; `layout` always
   * goes last (ARCHITECTURE §4.2 rule 2 — pixels below, meaning above). */
  const ensureSection = (key: RootKey, makeValue: () => unknown): Pair => {
    let pair = findPair(root, key);
    if (pair !== undefined) return pair;
    pair = new Pair(ydoc.createNode(key), makeValue());
    if (key !== 'meta') (pair.key as Scalar).spaceBefore = true;
    const idx = key === 'layout' ? root.items.length : insertIndexFor(root, key, ROOT_ORDER);
    root.items.splice(idx, 0, pair);
    touch();
    return pair;
  };

  const ensureMapSection = (key: RootKey): YAMLMap => {
    const pair = ensureSection(key, () => ydoc.createNode({}));
    if (!isMap(pair.value)) {
      pair.value = ydoc.createNode({});
      touch();
    }
    return pair.value as YAMLMap;
  };

  const ensureSeqSection = (key: RootKey): YAMLSeq => {
    const pair = ensureSection(key, () => ydoc.createNode([]));
    if (!isSeq(pair.value)) {
      pair.value = ydoc.createNode([]);
      touch();
    }
    return pair.value as YAMLSeq;
  };

  // ---- meta: set name/description only if changed; delete description when
  // it becomes undefined/empty.
  {
    const name = doc.meta.name === '' ? 'Untitled workflow' : doc.meta.name;
    const desc =
      doc.meta.description !== undefined && doc.meta.description !== ''
        ? doc.meta.description
        : undefined;
    const nameChanged = name !== base.meta.name;
    const descChanged = desc !== base.meta.description;
    if (nameChanged || descChanged) {
      const meta = ensureMapSection('meta');
      if (nameChanged) {
        mapSet(ydoc, meta, 'name', name, META_ORDER);
        touch();
      }
      if (descChanged) {
        if (desc === undefined) {
          if (deletePair(meta, 'description')) touch();
        } else {
          mapSet(ydoc, meta, 'description', desc, META_ORDER);
          touch();
        }
      }
    }
  }

  // ---- requires: recomputed via deriveRequires on every save. "Changed" is
  // judged against what the current nodes derive to — not against the file's
  // literal lists — so a hand-written (even stale) requires block is left
  // byte-identical until the derivation itself changes. Rewrites keep flow
  // style, unpadded ([revit]).
  {
    const target = deriveRequires(doc.nodes, options);
    const current = deriveRequires(base.nodes, options);
    const changed = REQUIRES_ORDER.filter((k) => !deepEqual(target[k], current[k]));
    if (changed.length > 0) {
      const pair = ensureSection('requires', () => ydoc.createNode({}));
      let writeAll = false;
      if (!isMap(pair.value)) {
        pair.value = ydoc.createNode({});
        writeAll = true;
      }
      const req = pair.value as YAMLMap;
      if (req.items.length === 0) writeAll = true;
      for (const k of writeAll ? REQUIRES_ORDER : changed) {
        mapSet(ydoc, req, k, makeRequiresList(ydoc, target, k), REQUIRES_ORDER);
        touch();
      }
    }
  }

  // ---- nodes: match CST items to doc.nodes by id; remove deleted, patch
  // only changed fields on survivors, append new nodes in canonical shape.
  // Surviving items are never reordered.
  {
    const docIds = new Set(doc.nodes.map((n) => n.id));
    const baseIds = new Set(base.nodes.map((n) => n.id));
    const nodesPair = findPair(root, 'nodes');
    const nodesSeq = nodesPair !== undefined && isSeq(nodesPair.value) ? (nodesPair.value as YAMLSeq) : undefined;

    // removals — base.nodes indexes align 1:1 with the CST sequence items
    const survivors = base.nodes.filter((n) => docIds.has(n.id));
    if (nodesSeq !== undefined) {
      for (let i = base.nodes.length - 1; i >= 0; i--) {
        const existing = base.nodes[i];
        if (existing === undefined) continue;
        if (!docIds.has(existing.id)) {
          nodesSeq.items.splice(i, 1);
          touch();
        }
      }
    }

    // surviving nodes — survivors[i] aligns with the (post-removal) CST items
    for (const dn of doc.nodes) {
      const bi = survivors.findIndex((s) => s.id === dn.id);
      if (bi < 0) continue; // new node; appended below
      const bn = survivors[bi];
      const item = nodesSeq?.items[bi];
      // `bn` cannot be missing — `bi` came from findIndex — but folding it in
      // here costs nothing and keeps the guarantee next to the read.
      if (bn === undefined || item === undefined || !isMap(item)) continue; // defensive; extraction guarantees a map
      const nodeMap = item as unknown as YAMLMap;
      if (dn.type !== bn.type) {
        mapSet(ydoc, nodeMap, 'type', dn.type, NODE_ORDER);
        touch();
      }
      if (dn.version !== bn.version) {
        mapSet(ydoc, nodeMap, 'version', dn.version, NODE_ORDER);
        touch();
      }
      if (dn.schemaHash === undefined) {
        if (bn.schemaHash !== undefined && deletePair(nodeMap, 'schemaHash')) touch();
      } else if (dn.schemaHash !== bn.schemaHash) {
        mapSet(ydoc, nodeMap, 'schemaHash', dn.schemaHash, NODE_ORDER);
        touch();
      }
      patchConfig(ydoc, nodeMap, dn.config ?? {}, bn.config, touch);
    }

    // additions — append at the end, canonical shape
    const newNodes = doc.nodes.filter((n) => !baseIds.has(n.id));
    if (newNodes.length > 0) {
      const seq = ensureSeqSection('nodes');
      for (const n of newNodes) {
        seq.items.push(newValueNode(ydoc, canonicalNodeShape(n)));
        touch();
      }
    }
  }

  // ---- edges: the CST is a string list; diff against doc.edges by
  // canonical formatted form. Surviving lines keep their spot (and their
  // comments and spacing), removed ones are deleted, new ones are appended.
  {
    const edgesPair = findPair(root, 'edges');
    const edgesSeq = edgesPair !== undefined && isSeq(edgesPair.value) ? (edgesPair.value as YAMLSeq) : undefined;
    const remaining = new Map<string, number>();
    for (const e of doc.edges) {
      const k = formatEdge(e);
      remaining.set(k, (remaining.get(k) ?? 0) + 1);
    }
    if (edgesSeq !== undefined) {
      const removeIdx: number[] = [];
      base.edges.forEach((e, i) => {
        const k = formatEdge(e);
        const c = remaining.get(k) ?? 0;
        if (c > 0) remaining.set(k, c - 1);
        else removeIdx.push(i);
      });
      for (let j = removeIdx.length - 1; j >= 0; j--) {
        edgesSeq.items.splice(removeIdx[j], 1);
        touch();
      }
    }
    const toAppend: string[] = [];
    for (const e of doc.edges) {
      const k = formatEdge(e);
      const c = remaining.get(k) ?? 0;
      if (c > 0) {
        remaining.set(k, c - 1);
        toAppend.push(k);
      }
    }
    if (toAppend.length > 0) {
      const seq = ensureSeqSection('edges');
      for (const k of toAppend) {
        seq.items.push(ydoc.createNode(k));
        touch();
      }
    }
  }

  // ---- layout: update changed positions (rounded), delete entries for
  // removed nodes, append flow-map entries for new nodes. Unchanged
  // positions are not touched; entries extraction excluded (unknown-node
  // leftovers, malformed shapes) are left alone.
  {
    const target = new Map<string, { x: number; y: number }>();
    for (const n of doc.nodes) {
      const p = doc.layout[n.id];
      if (p !== undefined) target.set(n.id, { x: roundPos(p.x), y: roundPos(p.y) });
    }
    const baseRounded = new Map<string, { x: number; y: number }>();
    for (const [id, p] of Object.entries(base.layout)) {
      baseRounded.set(id, { x: roundPos(p.x), y: roundPos(p.y) });
    }
    const removals = [...baseRounded.keys()].filter((id) => !target.has(id));
    const additions = [...target.keys()].filter((id) => !baseRounded.has(id));
    const updates = [...target.keys()].filter((id) => {
      const b = baseRounded.get(id);
      const t = target.get(id) as { x: number; y: number };
      return b !== undefined && (b.x !== t.x || b.y !== t.y);
    });
    if (removals.length > 0 || additions.length > 0 || updates.length > 0) {
      const lay = ensureMapSection('layout');
      for (const id of removals) {
        if (deletePair(lay, id)) touch();
      }
      for (const id of updates) {
        const t = target.get(id) as { x: number; y: number };
        const pair = findPair(lay, id);
        if (pair !== undefined && isMap(pair.value)) {
          const posMap = pair.value as YAMLMap;
          mapSet(ydoc, posMap, 'x', t.x, ['x', 'y']);
          mapSet(ydoc, posMap, 'y', t.y, ['x', 'y']);
        } else if (pair !== undefined) {
          pair.value = makePositionMap(ydoc, t);
        }
        touch();
      }
      for (const id of additions) {
        const t = target.get(id) as { x: number; y: number };
        lay.items.push(new Pair(ydoc.createNode(id), makePositionMap(ydoc, t)));
        touch();
      }
    }
  }

  if (!dirty) return source.text;
  const text = ydoc.toString(STR_OPTS);
  source.text = text;
  return text;
}

/** Build a canonical unpadded flow list for one requires entry. */
function makeRequiresList(ydoc: Document, target: WorkflowRequires, key: (typeof REQUIRES_ORDER)[number]): YAMLSeq {
  const seq = new UnpaddedFlowSeq();
  seq.flow = true;
  for (const v of target[key]) seq.items.push(ydoc.createNode(v));
  return seq;
}

/** Build a canonical `{ x: 120, y: 240 }` flow map. */
function makePositionMap(ydoc: Document, t: { x: number; y: number }): YAMLMap {
  const m = ydoc.createNode({ x: t.x, y: t.y }) as YAMLMap;
  m.flow = true;
  return m;
}

/**
 * Set/delete only the top-level config keys that changed (deep-compare);
 * a nested value is replaced wholesale when anything inside it changed.
 */
function patchConfig(
  ydoc: Document,
  nodeMap: YAMLMap,
  target: Record<string, unknown>,
  current: Record<string, unknown>,
  touch: () => void,
): void {
  const changedKeys = Object.keys(target).filter(
    (k) => !Object.hasOwn(current, k) || !deepEqual(target[k], current[k]),
  );
  const removedKeys = Object.keys(current).filter((k) => !Object.hasOwn(target, k));
  if (changedKeys.length === 0 && removedKeys.length === 0) return;
  let pair = findPair(nodeMap, 'config');
  if (pair === undefined) {
    pair = new Pair(ydoc.createNode('config'), ydoc.createNode({}));
    nodeMap.items.splice(insertIndexFor(nodeMap, 'config', NODE_ORDER), 0, pair);
  } else if (!isMap(pair.value)) {
    pair.value = ydoc.createNode({});
  }
  const cfg = pair.value as YAMLMap;
  for (const k of changedKeys) {
    mapSet(ydoc, cfg, k, target[k], []);
    touch();
  }
  for (const k of removedKeys) {
    if (deletePair(cfg, k)) touch();
  }
}
