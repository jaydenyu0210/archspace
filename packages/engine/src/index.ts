/**
 * @archspace/engine — demand-driven, memoized DAG execution with laned
 * concurrency, cancellation, retry, and an event-sourced run status stream
 * (ARCHITECTURE §7 / ADR-0007), plus the deterministic scheduler mode that
 * ADR-0013's engine suite runs on.
 */

export type { EngineNodeSpec, EngineEdgeSpec, EngineGraph } from './graph.js';

export type {
  NodeFailureKind,
  RunStatus,
  RunStats,
  RunEvent,
  RunOptions,
  RunResult,
  RunHandle,
} from './run.js';
export { startRun } from './run.js';

export type { ValuePreview, OutputPreview } from './preview.js';

export type { SchedulerHooks, VirtualScheduler } from './scheduler.js';
export { createVirtualScheduler } from './scheduler.js';

export type { RunCache } from './cache.js';
export { createRunCache } from './cache.js';

export type { ValidationIssue } from './validate.js';
export { validateGraph, GraphValidationError } from './validate.js';

export { canonicalJson, hashValue } from './canonical.js';
