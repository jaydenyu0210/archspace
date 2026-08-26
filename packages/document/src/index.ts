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
} from './types';
export { WorkflowSource } from './source';
export { parseWorkflow } from './parse';
export { emitWorkflow } from './emit';
export { saveWorkflow } from './save';
export { deriveRequires } from './requires';
export type { DeriveRequiresOptions } from './requires';
export { generateNodeId } from './id';
export { parseEdge, formatEdge } from './edge';
