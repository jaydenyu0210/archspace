/**
 * The workflow document's in-memory shapes (ARCHITECTURE §4.2 / ADR-0004).
 *
 * Data only, and deliberately so: parse, extract, emit and save all speak
 * these types, so any logic living here would be imported by every one of them
 * and would create exactly the cycle that splitting `edge`, `requires` and
 * `yaml-util` out avoids.
 *
 * Note what `ParseWorkflowResult` carries beside the doc: a `WorkflowSource`.
 * `WorkflowDoc` is the value the app edits; the CST it was read from is what a
 * save patches (ADR-0004 decision 4). The two stay separate objects rather
 * than merging into one, because only one of them is safe to hand to a
 * reducer, and the other must not be mutated except by `saveWorkflow`.
 */
import type { WorkflowSource } from './source.js';

/** One endpoint of an edge: a node id plus a port name on that node. */
export interface DocPort {
  node: string;
  port: string;
}

/** A node entry as stored in the document (ARCHITECTURE §4.2). */
export interface DocNode {
  id: string;
  type: string;
  version: number;
  schemaHash?: string;
  /**
   * Params this node instance exposes as input ports (§5.1, ADR-0017).
   *
   * Sorted and deduped — it is a set, written down, and `requires:` is the
   * house precedent for a sorted list. Absent when empty, so a document that
   * promotes nothing is byte-identical to one written before promotion
   * existed.
   *
   * Persisted here rather than inferred from the edges, because a promotion
   * that is not yet wired is a real state a user creates and must not lose,
   * and because `packages/document` resolves no node registry: without this
   * line an edge into a param is indistinguishable from a typo to every reader
   * of the file, human or otherwise.
   */
  promoted?: string[];
  config: Record<string, unknown>;
}

export interface DocEdge {
  from: DocPort;
  to: DocPort;
}

export interface WorkflowMeta {
  name: string;
  description?: string;
}

/** The derived `requires:` block — see deriveRequires for the derivation rule. */
export interface WorkflowRequires {
  mcp: string[];
  ai: string[];
  plugins: string[];
}

/** The parsed data model of one workflow document. */
export interface WorkflowDoc {
  meta: WorkflowMeta;
  requires: WorkflowRequires;
  nodes: DocNode[];
  edges: DocEdge[];
  layout: Record<string, { x: number; y: number }>;
}

export interface DocIssue {
  severity: 'error' | 'warning';
  message: string;
  path?: string;
}

export type ParseWorkflowResult =
  | { ok: true; doc: WorkflowDoc; source: WorkflowSource; issues: DocIssue[] }
  | { ok: false; issues: DocIssue[] };
