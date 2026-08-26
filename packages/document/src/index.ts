/**
 * @archspace/document — the workflow document format.
 *
 * Canonical, comment-preserving YAML (ARCHITECTURE §4, ADR-0004):
 * `parseWorkflow` opens resiliently, `emitWorkflow` writes canonical text
 * for new files, and `saveWorkflow` patches the parsed CST instead of
 * re-emitting so comments, unknown fields, and untouched formatting survive
 * an open→edit→save round trip.
 */
export type {
  DocPort,
  DocNode,
  DocEdge,
  WorkflowMeta,
  WorkflowRequires,
  WorkflowDoc,
  DocIssue,
  ParseWorkflowResult,
} from './types.js';
export { WorkflowSource } from './source.js';
export { parseWorkflow } from './parse.js';
export { emitWorkflow } from './emit.js';
export { saveWorkflow } from './save.js';
export { deriveRequires } from './requires.js';
export type { DeriveRequiresOptions } from './requires.js';
export { generateNodeId } from './id.js';
export { parseEdge, formatEdge } from './edge.js';
