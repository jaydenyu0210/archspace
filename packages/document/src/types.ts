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
