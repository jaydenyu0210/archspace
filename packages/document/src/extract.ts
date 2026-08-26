/**
 * Parsed YAML → `WorkflowDoc`, and the single place that decides what is fatal
 * (ARCHITECTURE §4 / ADR-0004).
 *
 * This is separate from `parse.ts` because `saveWorkflow` needs it too: a save
 * re-extracts the document it is about to patch and diffs the caller's doc
 * against *that*, so whatever this function decides a file means is exactly
 * what a save compares against. One reading used by both paths is what makes a
 * no-op save byte-identical rather than merely close — two subtly different
 * readings would show up as spurious edits in a user's diff.
 */
import { isMap, isSeq, type Document } from 'yaml';
import type { DocEdge, DocIssue, DocNode, WorkflowDoc } from './types.js';
import { parseEdge } from './edge.js';
import { deriveRequires } from './requires.js';
import { findPair } from './yaml-util.js';

export interface Extraction {
  /** null when a fatal issue was found. */
  doc: WorkflowDoc | null;
  issues: DocIssue[];
}

/**
 * Read a WorkflowDoc out of a parsed yaml Document, resiliently
 * (ARCHITECTURE §4 "loading is resilient", parse rules in ADR-0004).
 *
 * Fatal (doc: null): root not a map; `archspace` missing or ≠ 1; `kind`
 * present and ≠ "workflow"; `nodes`/`edges` present but not a sequence; a
 * node entry that is not a map or lacks a string id/type; duplicate node
 * ids; an edge that does not parse or references an unknown node id.
 *
 * Warnings (still extracted, with defaults): missing `kind`; missing
 * `meta.name` (default "Untitled workflow"); node missing `version`
 * (default 1) or `config` (default {}); missing `requires` (derived);
 * layout entries for unknown nodes (reported and excluded from doc.layout,
 * but never deleted from the CST); nodes missing a layout entry.
 *
 * This function is also the diff baseline for saveWorkflow: whatever it
 * reports for a document is exactly what a save compares the caller's doc
 * against, which is what makes a no-op save byte-identical.
 */
export function extractWorkflow(ydoc: Document): Extraction {
  const issues: DocIssue[] = [];
  const error = (message: string, path?: string): void => {
    issues.push({ severity: 'error', message, ...(path !== undefined ? { path } : {}) });
  };
  const warn = (message: string, path?: string): void => {
    issues.push({ severity: 'warning', message, ...(path !== undefined ? { path } : {}) });
  };
  const hasError = (): boolean => issues.some((i) => i.severity === 'error');
  const fail = (): Extraction => ({ doc: null, issues });

  const root = ydoc.contents;
  if (!isMap(root)) {
    error('document root must be a map');
    return fail();
  }
  const raw = (ydoc.toJS() ?? {}) as Record<string, unknown>;

  // archspace / kind
  if (raw['archspace'] !== 1) {
    error('archspace version marker missing or not 1', 'archspace');
  }
  if (!Object.hasOwn(raw, 'kind')) {
    warn('missing kind; assuming workflow', 'kind');
  } else if (raw['kind'] !== 'workflow') {
    error(`kind must be "workflow", got ${JSON.stringify(raw['kind'])}`, 'kind');
  }

  // meta
  let name = 'Untitled workflow';
  let description: string | undefined;
  const metaRaw = raw['meta'];
  if (metaRaw !== undefined && (metaRaw === null || typeof metaRaw !== 'object' || Array.isArray(metaRaw))) {
    warn('meta is not a map; using defaults', 'meta');
  } else {
    const m = (metaRaw ?? {}) as Record<string, unknown>;
    if (typeof m['name'] === 'string' && m['name'] !== '') {
      name = m['name'];
    } else {
      warn('meta.name missing; defaulting to "Untitled workflow"', 'meta.name');
    }
    const d = m['description'];
    if (typeof d === 'string') {
      if (d !== '') description = d; // empty description ≡ absent
    } else if (d !== undefined && d !== null) {
      warn('meta.description is not a string; ignoring', 'meta.description');
    }
  }

  // nodes — on success, nodes[i] corresponds 1:1 with the CST sequence items.
  const nodesPair = findPair(root, 'nodes');
  if (nodesPair !== undefined && !isSeq(nodesPair.value)) {
    error('nodes must be a sequence', 'nodes');
    return fail();
  }
  const nodes: DocNode[] = [];
  const ids = new Set<string>();
  const rawNodes = Array.isArray(raw['nodes']) ? (raw['nodes'] as unknown[]) : [];
  rawNodes.forEach((rn, i) => {
    const path = `nodes[${i}]`;
    if (rn === null || typeof rn !== 'object' || Array.isArray(rn)) {
      error('node entry is not a map', path);
      return;
    }
    const n = rn as Record<string, unknown>;
    const id = n['id'];
    if (typeof id !== 'string' || id === '') {
      error('node id missing or not a string', `${path}.id`);
      return;
    }
    if (ids.has(id)) {
      error(`duplicate node id "${id}"`, `${path}.id`);
      return;
    }
    ids.add(id);
    const type = n['type'];
    if (typeof type !== 'string' || type === '') {
      error(`node "${id}" is missing a type`, `${path}.type`);
      return;
    }
    let version = 1;
    if (typeof n['version'] === 'number') {
      version = n['version'];
    } else if (Object.hasOwn(n, 'version')) {
      warn(`node "${id}" has a non-numeric version; defaulting to 1`, `${path}.version`);
    } else {
      warn(`node "${id}" is missing version; defaulting to 1`, `${path}.version`);
    }
    let schemaHash: string | undefined;
    if (typeof n['schemaHash'] === 'string') {
      schemaHash = n['schemaHash'];
    } else if (n['schemaHash'] !== undefined && n['schemaHash'] !== null) {
      warn(`node "${id}" schemaHash is not a string; ignoring`, `${path}.schemaHash`);
    }
    let config: Record<string, unknown> = {};
    const c = n['config'];
    if (c === undefined) {
      warn(`node "${id}" is missing config; defaulting to {}`, `${path}.config`);
    } else if (c === null || typeof c !== 'object' || Array.isArray(c)) {
      warn(`node "${id}" config is not a map; treating as {}`, `${path}.config`);
    } else {
      config = c as Record<string, unknown>;
    }
    nodes.push({
      id,
      type,
      version,
      ...(schemaHash !== undefined ? { schemaHash } : {}),
      config,
    });
  });
  if (hasError()) return fail();

  // edges — on success, edges[i] corresponds 1:1 with the CST sequence items.
  const edgesPair = findPair(root, 'edges');
  if (edgesPair !== undefined && !isSeq(edgesPair.value)) {
    error('edges must be a sequence', 'edges');
    return fail();
  }
  const edges: DocEdge[] = [];
  const rawEdges = Array.isArray(raw['edges']) ? (raw['edges'] as unknown[]) : [];
  rawEdges.forEach((re, i) => {
    const path = `edges[${i}]`;
    if (typeof re !== 'string') {
      error('edge entry is not a string', path);
      return;
    }
    const e = parseEdge(re);
    if (e === null) {
      error(`edge "${re}" does not parse (expected "node.port -> node.port")`, path);
      return;
    }
    if (!ids.has(e.from.node)) {
      error(`edge references unknown node "${e.from.node}"`, path);
      return;
    }
    if (!ids.has(e.to.node)) {
      error(`edge references unknown node "${e.to.node}"`, path);
      return;
    }
    edges.push(e);
  });
  if (hasError()) return fail();

  // requires — a parse artifact: reported as found, derived when missing,
  // never used for output (emit/save always re-derive from nodes).
  let requires = deriveRequires(nodes);
  const reqRaw = raw['requires'];
  if (reqRaw === undefined) {
    warn('requires missing; derived from nodes', 'requires');
  } else if (reqRaw === null || typeof reqRaw !== 'object' || Array.isArray(reqRaw)) {
    warn('requires is not a map; derived from nodes', 'requires');
  } else {
    const r = reqRaw as Record<string, unknown>;
    const list = (k: string): string[] => {
      const v = r[k];
      if (v === undefined || v === null) return [];
      if (!Array.isArray(v)) {
        warn(`requires.${k} is not a list; treating as []`, `requires.${k}`);
        return [];
      }
      const out: string[] = [];
      v.forEach((item, i) => {
        if (typeof item === 'string') out.push(item);
        else if (item === null || typeof item !== 'object') out.push(String(item));
        else warn(`requires.${k}[${i}] is not a string; ignoring`, `requires.${k}[${i}]`);
      });
      return out;
    };
    requires = { mcp: list('mcp'), ai: list('ai'), plugins: list('plugins') };
  }

  // layout — entries for unknown nodes and malformed entries are excluded
  // from doc.layout but left alone in the CST.
  const layout: Record<string, { x: number; y: number }> = {};
  const sawLayoutKey = new Set<string>();
  const layRaw = raw['layout'];
  if (
    layRaw !== undefined &&
    layRaw !== null &&
    (typeof layRaw !== 'object' || Array.isArray(layRaw))
  ) {
    warn('layout is not a map; ignoring', 'layout');
  } else if (layRaw !== undefined && layRaw !== null) {
    for (const [k, v] of Object.entries(layRaw as Record<string, unknown>)) {
      const path = `layout.${k}`;
      sawLayoutKey.add(k);
      if (!ids.has(k)) {
        warn(`layout entry for unknown node "${k}" (left in place)`, path);
        continue;
      }
      if (v === null || typeof v !== 'object' || Array.isArray(v)) {
        warn(`layout entry "${k}" is not a map; ignoring`, path);
        continue;
      }
      const { x, y } = v as Record<string, unknown>;
      if (
        typeof x !== 'number' ||
        typeof y !== 'number' ||
        !Number.isFinite(x) ||
        !Number.isFinite(y)
      ) {
        warn(`layout entry "${k}" needs numeric x and y; ignoring`, path);
        continue;
      }
      layout[k] = { x, y };
    }
  }
  for (const n of nodes) {
    if (!sawLayoutKey.has(n.id)) {
      warn(`node "${n.id}" has no layout entry`, `layout.${n.id}`);
    }
  }

  return {
    doc: {
      meta: { name, ...(description !== undefined ? { description } : {}) },
      requires,
      nodes,
      edges,
      layout,
    },
    issues,
  };
}
