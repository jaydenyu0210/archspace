/**
 * @archspace/engine — demand-driven, memoized DAG execution with laned
 * concurrency, cancellation, retry, and an event-sourced run status stream
 * (ARCHITECTURE §7 / ADR-0007), plus the deterministic scheduler mode that
 * ADR-0013's engine suite runs on.
 */

export type { EngineNodeSpec, EngineEdgeSpec, EngineGraph } from './graph';

export type {
  NodeFailureKind,
  RunStatus,
  RunStats,
  RunEvent,
  RunOptions,
  RunResult,
  RunHandle,
} from './run';
export { startRun } from './run';

export type { ValuePreview, OutputPreview } from './preview';

export type { SchedulerHooks, VirtualScheduler } from './scheduler';
export { createVirtualScheduler } from './scheduler';

export type { RunCache } from './cache';
export { createRunCache } from './cache';

export type { ValidationIssue } from './validate';
export { validateGraph, GraphValidationError } from './validate';

export { canonicalJson, hashValue } from './canonical';
