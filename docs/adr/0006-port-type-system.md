# ADR-0006 — Port types: small nominal set, explicit lifts, no implicit mapping

- **Status:** Accepted
- **Date:** 2026-08-24

## Context

The type system must catch real wiring mistakes without becoming a study topic. Grasshopper's data trees mark the ceiling of tolerable cleverness (powerful, notoriously confusing); everything-is-JSON marks the floor (no validation value). AEC data adds a twist: payloads (IFC models) far too large to pass by value.

## Decision

Grammar and rules in ARCHITECTURE §6. Core: `text`, `number` (finite), `boolean`, `json`, `chat`, `table`; one container `list<T>`; `asset` / `asset<format>` as content-addressed references; opaque plugin nominal types; `any` for utility nodes.

Rules: exact match; widening (`asset<ifc>→asset`, `T→json`); **lift** `T→list<T>`; variadic inputs collect edges into `list<T>`; a tiny engine-owned lossless coercion table (`number→text`, `boolean→text`, `→json`); everything else — narrowing, parsing, `list<T>→T` — is an explicit node or an error. Validation at edge-creation, document-load, and pre-run.

Three deliberate exclusions:

- **No implicit mapping** of scalar nodes over lists (Grasshopper's biggest confusion source). Iteration arrives later as an explicit ForEach subgraph.
- **No session-handle types** (e.g. an in-memory `model`): handles can't cross processes or cache. Nodes exchange `asset<ifc>`; runtimes memoize parsing keyed by content hash — same amortization, no poison.
- **No `secret` type:** credentials never ride wires; params reference secret *keys* resolved via `ctx.secrets`.

## Consequences

- Some graphs need an explicit parse/assert node where other tools would silently coerce — a wash: the graph says what happens.
- `chat` and `table` as named types give AI and schedule workflows early validation instead of `json` soup.
- Plugin types are siloed (self + `any` only) until a future adapter story earns its complexity.

## Alternatives considered

- **Grasshopper-style trees + implicit replication:** maximum power, community-documented confusion; rejected.
- **Structural typing / full generics:** inference engine complexity without matching user value at this graph scale; rejected (only `list<T>` is generic).
- **Everything is `json`:** no early errors, no typed UX (color-coded ports, filtered palettes); rejected.
