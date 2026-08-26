# ADR-0007 — Demand-driven memoized DAG with laned concurrency

- **Status:** Accepted
- **Date:** 2026-08-24

## Context

The engine must: run graphs concurrently, avoid recomputing unchanged work (AI and MCP calls are slow and cost money), cancel cleanly, survive partial failure usefully, and stream status to a UI, a CLI, and run logs alike.

## Decision

Per ARCHITECTURE §7:

1. **DAG only.** Cycles rejected at validation; loops arrive later as explicit subgraph iteration, never back-edges.
2. **Demand-driven with memoization** — a build system, not an actor runtime: run(targets) executes the ancestor subgraph, skipping nodes whose cache key (`engineAbi + type + version + canonical params + input hashes`, BLAKE3 behind an interface) already resolves. Persistent cache = SQLite index + content-addressed store; only `caching:'pure'` nodes participate; eviction is size-LRU, never correctness.
3. **Laned concurrency:** ready-set worklist bounded per lane — `cpu` (cores−1, ≤8), `io` (16), `ai` (4), `mcp:<server>` (**1** — a stdio server is one process of unknown reentrancy; per-server override in settings). Caps are config with hypothesized defaults.
4. **Cancellation:** one AbortController per run → `ctx.signal`; no starts after cancel; 5 s grace then SIGTERM→SIGKILL for out-of-process work; MCP `notifications/cancelled`; completed results stay cached.
5. **Partial failure:** failed node → descendants `skipped (upstream failed)`; **independent branches complete**. Retries only for errors explicitly marked transient (`ctx.retryable`, AI/MCP 429/503), max 3, backoff+jitter, every attempt an event.
6. **Event-sourced status:** one ordered, versioned event stream per run (ARCHITECTURE §7.6) consumed identically by renderer, CLI, and persisted run manifests. Previews computed engine-side, size-capped; bulk data never reaches the renderer.

One active run per workflow in v1 (new run requires cancel); runs are `runId`-isolated so a queue is additive later.

## Consequences

- Purity honesty matters: a mislabeled `pure` node caches wrong results — the testkit encourages purity checks, and default is `'never'`.
- Deterministic test mode (virtual clock, seeded scheduler) must be built into the scheduler, not bolted on (ADR-0013 depends on it).
- Event stream versioning is a public-ish contract from M2 onward (CLI consumers).

## Alternatives considered

- **Always-recompute push execution** (early ComfyUI style): simplest, but re-billing every upstream AI call on each tweak is user-hostile; rejected.
- **Reactive/live evaluation** (spreadsheet-style, Grasshopper): brilliant for pure geometry, dangerous with effectful AI/MCP nodes firing on every keystroke; rejected for v1 (memoization already gives cheap re-runs).
- **Result-values on wires** for failure handling: taxes every node author; a Try/Catch wrapper node can come later; rejected.
- **Actor model / durable queue** (n8n-style workers): infrastructure weight without a multi-tenant server to justify it; rejected.
