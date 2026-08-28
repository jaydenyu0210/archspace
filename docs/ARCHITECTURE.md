# Archspace — Architecture

- **Status:** Accepted (v1 baseline). Every decision here has a corresponding ADR in `docs/adr/`.
- **Date:** 2026-08-24
- **Inputs:** `docs/research/ecosystem.md` (2026-08-24). **No product brief exists in this repository** — the brief path referenced in the design request does not resolve, and the research doc records the same absence. Section 1 therefore states the product definition this architecture is built against; if a brief lands and contradicts it, the affected ADRs are the change surface.

---

## 1. What we are building

**Archspace is an open-source, macOS-first desktop application for building and running node-based workflows for AEC work.** A workflow is a directed graph on a canvas: nodes wire together AI model calls, MCP server tools (Revit and others), file-format operations (IFC first), and ordinary data plumbing. Workflows are saved as text documents that read and diff cleanly in git. Third parties extend the app by publishing node plugins.

Assumed requirements (from the design request plus the requirements restated in `docs/research/ecosystem.md`):

- macOS is the primary shipped platform; the codebase stays cross-platform.
- Revit integration is a major capability. Per the research (§3), everything Revit-session-bound is Windows-only, so Revit is reached as a **remote MCP server** — a Windows machine (colleague's workstation, office box, Parallels VM, cloud VM) running Revit plus an MCP bridge. The app itself never links Revit code.
- Open source. **App license: Apache-2.0** — coexists with the whole recommended dependency set (LGPL IfcOpenShell out-of-process, MPL-2.0 web-ifc, MIT everything else) and keeps both copyleft directions clean (research §6.5).
- AI is a first-class citizen but **no AI provider is privileged**, including local models.

Non-goals for v1: being a BIM viewer/editor first, cloud/SaaS execution, real-time collaboration, Windows/Linux installers (code stays portable; packaging is deferred), a plugin marketplace.

A note on sequencing: the research recommends shipping Windows first. This architecture ships **macOS first** — the design request scopes packaging to macOS and the restated brief says macOS-primary — and the research's own split-architecture recommendation is what makes that safe: the Revit-live tier arrives over remote MCP, not local code, so no milestone below depends on a Windows build of the app. The Windows-resident "Revit agent" (Revit add-in + Streamable HTTP MCP bridge) is a separate future deliverable; until it exists, community MCP servers (research §2.6) fill the slot over the identical transport.

## 2. Decisions at a glance

| # | Area | Decision | ADR |
|---|------|----------|-----|
| 1 | Platform strategy | Cross-platform TS core; macOS ships first; Revit via remote MCP; Apache-2.0 | [0001](adr/0001-platform-strategy.md) |
| 2 | Language & desktop framework | TypeScript everywhere; Electron; engine in a utility process | [0002](adr/0002-language-and-desktop-framework.md) |
| 3 | Frontend & canvas | React + React Flow (`@xyflow/react`); three.js + web-ifc for 3D preview | [0003](adr/0003-frontend-and-canvas.md) |
| 4 | Workflow document | Canonical, comment-preserving YAML; layout quarantined at the bottom; CST patching on save | [0004](adr/0004-workflow-document-format.md) |
| 5 | Node contract | Declarative manifest (JSON Schema params) + `execute(ctx, inputs, params)`; wire values = JSON ∪ AssetRef | [0005](adr/0005-node-contract.md) |
| 6 | Port types | Small nominal set + `list<T>` + tagged assets; explicit lifts; tiny lossless coercion table | [0006](adr/0006-port-type-system.md) |
| 7 | Execution engine | Demand-driven, memoized DAG; laned concurrency; event-sourced status | [0007](adr/0007-execution-engine.md) |
| 8 | Plugin boundary | One OS process per plugin; capability-based context; MCP is the polyglot tier | [0008](adr/0008-plugin-boundary.md) |
| 9 | MCP integration | Logical server names bound in user settings; tools become generated nodes; both transports + OAuth 2.1 | [0009](adr/0009-mcp-integration.md) |
| 10 | AI providers | Own `AiGateway` interface over the Vercel AI SDK provider layer; named model profiles | [0010](adr/0010-ai-provider-abstraction.md) |
| 11 | Files & assets | Project directory + content-addressed derived store; wires carry references, never bytes | [0011](adr/0011-assets-and-projects.md) |
| 12 | macOS distribution | electron-builder; Developer ID + notarization; GitHub Releases + Homebrew; no Mac App Store | [0012](adr/0012-macos-packaging.md) |
| 13 | Testing | Headless-first via CLI runner; property-tested serializer; deterministic scheduler; plugin testkit | [0013](adr/0013-testing-strategy.md) |

## 3. Language, desktop framework, frontend, canvas

### 3.1 TypeScript + Electron

One language, end to end: **TypeScript**, strict mode, on Node (pinned by Electron) — for the UI, the execution engine, the plugin SDK, and the CLI.

Why this wins here specifically:

1. **The plugin runtime is the product.** Third-party nodes are the growth loop; JavaScript/TypeScript is the largest addressable author base, and the in-process tier must live where the engine lives. Splitting engine (Rust/Swift) from plugin runtime (JS) would put an RPC boundary through the hottest path in the product.
2. **The MCP TypeScript SDK (`@modelcontextprotocol/sdk`, MIT) is the reference implementation** of the client stack the research says we must build (research §5): stdio subprocess management, Streamable HTTP + SSE resumption, OAuth 2.1/PKCE, cancellation. We should not reimplement that in a second language.
3. **web-ifc (MPL-2.0, TypeScript/WASM) gives IFC parsing and viewing in the same runtime** (research §4).
4. The AI provider ecosystem's best multi-provider abstraction (AI SDK, §10 below) is TypeScript.

**Electron** over the alternatives:

- **Tauri (rejected):** smaller binaries, but the backend is Rust — the plugin/engine runtime would either be Rust (kills the JS plugin story) or a Node sidecar (at which point we ship Electron's architecture by hand, minus its maturity). Rust MCP tooling is younger than the TS SDK.
- **Swift/SwiftUI (rejected):** best native feel, but macOS-only forever — directly contradicts the research's cross-platform recommendation and abandons the Windows path where live Revit actually runs. No web-ifc, weak plugin story.
- **Qt or Python/PySide (rejected):** IfcOpenShell synergy is real but reachable anyway via an out-of-process MCP server; node canvases in Qt are hand-rolled; Python app distribution/notarization on macOS is chronically painful.

### 3.2 Process model

Electron gives us real OS processes; we use them deliberately:

```
main (Electron)            window/menu/dialogs, safeStorage, auto-update, process supervision
 ├─ renderer (sandboxed)   React UI, canvas, inspector, viewer — no Node access
 └─ engine host (utilityProcess)
     ├─ core nodes         in-process worker pool
     ├─ plugin host ×N     one child process per installed plugin (capability RPC)
     └─ mcp servers ×N     stdio child processes / HTTP clients
```

- **Renderer:** `contextIsolation: true`, `sandbox: true`, no `nodeIntegration`. Talks to main/engine over typed IPC (`MessagePort` pairs, schema-validated messages).
- **Engine host** runs in an Electron `utilityProcess`: a plugin or engine crash never takes down the UI; main supervises and restarts it, marking any in-flight run as aborted.
- **Plugin hosts and stdio MCP servers** are children of the engine host — one supervision tree.

Build tooling: pnpm workspaces monorepo, Vite/electron-vite, Vitest. Renderer state: Zustand (what React Flow itself uses). Styling: Tailwind (low-stakes choice, not load-bearing).

### 3.3 Canvas: React Flow. Viewer: three.js + web-ifc

**`@xyflow/react` (React Flow, MIT)** renders the graph: it is the dominant, actively maintained React node-editor, with custom node/edge rendering, selection, viewport, and minimap solved. Target scale is hundreds of nodes per workflow, well inside its comfort zone with memoized nodes.

Rejected: **LiteGraph** (ComfyUI's canvas — imperative, aging API, poor React fit), **Rete.js v2** (brings its own engine opinions that would fight ours; smaller ecosystem), **custom WebGL canvas** (premature; the document model is renderer-agnostic, so a custom renderer remains a later escape hatch if profiling ever demands it — nothing else in this document would change).

The **3D preview panel** (IFC) is an app panel — not a node UI — built on three.js + web-ifc, fed by `asset<ifc>` values streamed from the engine. It ships with the IFC plugin milestone (M6), not before.

### 3.4 Repository layout

```
packages/
  document/     # workflow schema, YAML CST parser/patcher
  types/        # port type system: grammar, assignability, coercions
  node-sdk/     # public contract: NodeManifest, NodeModule, NodeContext, testkit
  engine/       # scheduler, cache, run events, process supervision
  nodes-core/   # built-in nodes (aec.*, ai.*)
  ai-gateway/   # provider abstraction
  mcp-host/     # MCP client pool, tool→node generation
  plugin-host/  # out-of-process plugin loader: consent, supervision, RPC
  autodesk/     # Revit/APS capability table, MCP presets, unimplemented seams
  cli/          # `archspace run` headless runner
  app/          # Electron main + renderer
plugins/
  aec-review/   # first-party plugin: the aec.review.* nodes, out of process
plugins/
  ifc/          # first-party plugin — dogfoods the plugin boundary
docs/           # this file, adr/, research/
```

`document`, `types`, `engine`, `node-sdk`, and `cli` have **zero Electron imports** — everything below the shell runs headless in plain Node. That line is what makes the testing strategy (§14) work.

## 4. The workflow document

### 4.1 Format: canonical, comment-preserving YAML

A workflow is **one file**: `<name>.archspace.yaml`. YAML 1.2, parsed with the `yaml` package's document API (core schema — no implicit-typing surprises).

Why YAML over JSON (the close call): this is an AI workflow tool, so the most-edited values in any document are **prompts**. YAML block scalars (`|`) diff prompts line-by-line; JSON string escaping turns any prompt edit into one unreadable changed line. Second, **comments**: users annotating why a node is configured the way it is turns workflows into reviewable engineering documents. Those two outweigh JSON's tooling edge — and we keep that edge anyway, since YAML parses to the same data model and is validated against a published JSON Schema.

Rejected: **JSON** (prompts and comments, above), **custom DSL** (years of tooling cost for marginal readability), **directory-bundle-as-document** (breaks "email someone a workflow"; the *project* is the bundle instead, §11), **SQLite/binary** (kills git entirely).

### 4.2 What a saved file contains

```yaml
archspace: 1                 # document schema version, migrated on load
kind: workflow               # reserved: future kinds include subgraph
meta:
  name: Room schedule summary
  description: Pull the room schedule from Revit and draft a QA summary.

# Generated on save from the nodes below; lets humans and CI see what a
# workflow needs without loading a node registry.
requires:
  mcp: [revit]               # logical server names — bound per machine (§9)
  ai: [default]              # model profile names — bound per machine (§10)
  plugins: []

nodes:
  - id: n_k3v9qp             # short random id, stable for life of the node
    type: mcp.revit.query_model
    version: 1
    schemaHash: b3:9f2c…     # MCP tool schema this node was built against
    config:
      category: Rooms
  - id: n_8t2mfa
    type: ai.generate_text
    version: 1
    config:
      profile: default
      prompt: |
        You are a BIM QA assistant. Summarize the room schedule below.
        Flag rooms missing an area or a department parameter.

edges:
  - n_k3v9qp.result -> n_8t2mfa.context     # one edge per line: clean diffs

layout:                      # presentation only — quarantined at the bottom
  n_k3v9qp: { x: 120, y: 240 }
  n_8t2mfa: { x: 460, y: 240 }
```

Rules that keep it diffable, enforced by the serializer and covered by property tests:

1. **Canonical emission.** Fixed key order per object kind; nodes and edges keep insertion order (new entries append — moving things on canvas never reorders the document); positions rounded to integers; no trailing whitespace; LF endings.
2. **Semantic/presentation quarantine.** Everything above `layout:` is meaning; `layout:` is pixels. A logic review can stop reading at `layout:`. (A separate sidecar file was rejected: two files per workflow breaks the sharing story; a quarantined trailing section gets 90% of the benefit.)
3. **Patch, don't re-emit.** Saving applies edits to the parsed YAML CST rather than serializing the in-memory graph from scratch — **user comments and any unknown-but-valid fields survive an open→edit→save round trip.** This is a hard requirement with its own tests, because it is what makes hand-editing and git merges survivable.
4. **Random short ids** (`n_` + 6 base32 chars), not sequential — two branches adding nodes don't collide on `n7` and manufacture merge conflicts.
5. **No runtime state in the document.** Outputs, caches, run history live in `.archspace/` (gitignored). A ComfyUI-style file that embeds results was explicitly rejected: it destroys diffs and conflates program with execution.
6. **Edges are single-line strings** `from.port -> to.port` — one line per edge added/removed in a diff.
7. `requires:` is **derived** from the graph on save (never hand-maintained) so a reviewer or CI can check availability without resolving the full node registry.

Documents are **data, not code**: no expression language in v1, no `eval` anywhere. String params support `{{input_name}}` template substitution only (a safe mini-language, not JavaScript). n8n-style JS expressions are deferred until we can run them in a real sandbox (§15).

Loading is resilient: an unknown node type becomes a **placeholder node** — the document is never mutilated because a plugin is missing; the run is simply blocked until the requirement is met.

## 5. The node contract

This is the load-bearing decision: plugins, MCP mapping, the AI nodes, caching, the inspector UI, and the testkit all hang off it.

### 5.1 Shape of the decision

A node type is two things:

1. A **declarative manifest** — pure serializable data. The app renders palettes and inspector forms, validates documents, and computes cache keys *without executing any plugin code*. Params are described in **JSON Schema (2020-12 subset)** — chosen over Zod or a bespoke schema because the manifest must cross process boundaries and languages, MCP tools already declare `inputSchema` as JSON Schema (making the MCP→node mapping mechanical, §9), and AI function-calling speaks it too. Zod stays a DX convenience in the TS SDK (compiled to JSON Schema), never the contract.
2. An **implementation** — one async function, `execute(ctx, inputs, params)`, receiving *only* the capabilities in `ctx`. There is no ambient authority: no bare `fs`, no bare network, no provider SDKs. That single property is what makes the plugin boundary (§8) and the testkit (§14) possible.

Config ("params") and dataflow inputs are **separate declarations**, because their UX differs (inspector form vs. wire), but any param marked *promotable* can be exposed as an input port of the corresponding type; a wired value overrides the configured one. (Grasshopper's everything-is-an-input was rejected as hostile to form-based configuration; n8n's hard split was rejected as hostile to composition. Promotion is the converged middle.)

### 5.2 The contract, concretely

```ts
// package: @archspace/node-sdk — this IS the public plugin API.

/** Everything that flows on a wire: JSON values plus asset references.
 *  Invariant: wire values are small. Bulk bytes always travel as AssetRef. */
export type Value =
  | null | boolean | number | string
  | Value[]
  | { [key: string]: Value }
  | AssetRef;

export interface AssetRef {
  kind: 'asset';
  hash: string;              // "b3:<hex>" — content address in the CAS (§11)
  mediaType: string;         // "model/ifc", "image/png", "text/csv", …
  format?: string;           // port-type tag: "ifc" | "dxf" | "csv" | …
  name?: string;             // display name hint
  size: number;              // bytes
}

/** Port type expressions — grammar and rules in §6. */
export type PortType = string; // "text" | "number" | "boolean" | "json" | "chat"
                               // | "table" | "asset" | "asset<fmt>" | "list<T>"
                               // | "any" | "<pluginNs>.<name>"

export interface PortDecl {
  id: string;                // snake_case, unique within the node
  type: PortType;
  label?: string;
  description?: string;
  required?: boolean;        // inputs only; default true
  variadic?: boolean;        // inputs only; N edges collected into list<T>
}

export interface NodeManifest {
  /** Globally unique, namespaced: "<ns>.<group>.<name>".
   *  Namespaces "core", "ai", "mcp" are reserved for the app. */
  type: string;
  /** Major version of the observable contract (ports/params/semantics). */
  version: number;
  label: string;
  description: string;
  category: string;          // palette grouping
  icon?: string;             // from the built-in icon set
  keywords?: string[];
  /** JSON Schema (2020-12 subset) for `params`. Vendor extensions under
   *  "x-archspace": ui hints (widget, rows, placeholder), `promotable: true`,
   *  `secretRef: true` (value is a secret KEY, never the secret). */
  params: JsonSchemaObject;
  inputs: PortDecl[];
  outputs: PortDecl[];
  /** 'pure': same inputs+params ⇒ same outputs; engine may memoize (§7).
   *  'never': always executes. Default 'never' — purity is opt-in. */
  caching: 'pure' | 'never';
  /** Scheduler lane (§7). Default 'cpu'. MCP nodes get "mcp:<server>". */
  lane?: 'cpu' | 'io' | 'ai' | `mcp:${string}`;
  /** Capabilities requested; anything undeclared is absent from ctx.
   *  e.g. 'net', 'secrets:acme_api_key'. User-consented at install (§8). */
  permissions?: string[];
}

export interface NodeModule<P = unknown> {
  manifest: NodeManifest;
  execute(ctx: NodeContext, inputs: Inputs, params: P): Promise<Outputs>;
  /** Rewrite params written by an older major version of this node. */
  migrateParams?(old: unknown, fromVersion: number): P;
}

export type Inputs  = Readonly<Record<string, Value | undefined>>;
export type Outputs = Record<string, Value>;

/** Everything a node can touch. Nothing else is reachable — by construction
 *  for out-of-process plugins, by convention + review for core nodes. */
export interface NodeContext {
  signal: AbortSignal;                       // cancellation (§7)
  runId: string;
  nodeId: string;

  log(level: 'debug'|'info'|'warn'|'error', message: string, data?: Value): void;
  progress(fraction?: number, message?: string): void;

  assets: {
    open(ref: AssetRef): Promise<ReadableStream<Uint8Array>>;
    bytes(ref: AssetRef): Promise<Uint8Array>;
    put(data: Uint8Array | ReadableStream<Uint8Array>,
        meta: { mediaType: string; format?: string; name?: string }): Promise<AssetRef>;
  };

  /** Resolves only keys declared in manifest.permissions AND granted by the user. */
  secrets: { get(key: string): Promise<string> };

  /** Provider-agnostic AI (§10). Always present; billed to the user's own keys. */
  ai: AiGateway;

  /** Present only when 'net' permission is declared and granted. */
  fetch?: typeof fetch;

  tempDir(): Promise<string>;               // wiped after the run

  /** Marks a thrown failure as transient so the engine may retry it (§7). */
  retryable<E extends Error>(err: E): E;
}
```

What is deliberately **not** in the contract (each with its forward-compat hook in §15): streaming outputs (an output can later be a stream handle behind the same `Value` envelope), custom React inspectors (JSON-Schema-generated forms only in v1 — arbitrary plugin code in the renderer is an XSS-equivalent we refuse for now), node-to-node hidden channels (everything crosses ports), direct MCP client access (MCP reaches plugins only as generated nodes, §9).

Versioning: bump `version` on any observable change; documents pin `type@version`; the loader calls `migrateParams` upward at open time and records the migration in the document diff — visible in review, like any other edit.

## 6. The port type system

Goals, in tension: catch real wiring mistakes early; stay learnable in an afternoon; never require passing gigabytes by value. Grasshopper's data trees demonstrate the ceiling of cleverness users will tolerate — we stay far below it.

### 6.1 The types

```
type       := primitive | container | assetType | pluginType | "any"
primitive  := "text" | "number" | "boolean" | "json" | "chat" | "table"
container  := "list<" type ">"                      (lists nest: list<list<T>> is legal, rare)
assetType  := "asset" | "asset<" format ">"          (format: ifc, dxf, csv, png, pdf, …)
pluginType := <plugin-namespace> "." <name>          (opaque nominal types)
```

- `text`, `number` (finite only — NaN/±Inf are rejected at the boundary), `boolean`.
- `json` — any `Value`. The pressure-release valve; typed ports are preferred.
- `chat` — a conversation: `[{ role: 'system'|'user'|'assistant', content: string }]`. First-class because chaining model calls is this product's bread and butter.
- `table` — `{ columns: [{ id, label? }], rows: Record<string, Value>[] }`. First-class because AEC is schedules.
- `asset` / `asset<fmt>` — an `AssetRef`. **Bulk data never rides a wire by value**; an IFC model on a wire is a content hash, and the IFC runtime memoizes parsing keyed by that hash. (A session-scoped in-memory `model` handle type was rejected: handles can't cross process boundaries, can't be cached, and would poison workflow portability. Content addressing gives the same amortization without the poison.)
- Plugin nominal types (`acme.pointcloud`): opaque; connect only to themselves and `any`. Plugins cannot register coercions in v1 — custom implicit conversions make graphs spooky at a distance.
- `secret` is **deliberately not a type**: credentials never flow through wires; nodes reference secret *keys* in params (`x-archspace.secretRef`) and resolve them via `ctx.secrets`.

### 6.2 Connection rules

Checked at three moments: edge creation (UI refuses or warns), document load (lint), and pre-run (hard validation).

1. **Exact match** connects.
2. **Widening** connects: `asset<ifc> → asset`; `T → json` for every primitive/container (up into `json` is always safe).
3. **Narrowing** (`asset → asset<ifc>`, `json → table`, …) does **not** connect implicitly — insert an explicit parse/assert node.
4. **Lift**: `T → list<T>` auto-wraps as a one-element list. The reverse (`list<T> → T`) is an error — **no implicit mapping.** Grasshopper's implicit looping is its single largest confusion generator; iteration will arrive as an explicit ForEach subgraph (§15), never as silent fan-out.
5. **Variadic inputs** accept multiple edges of `T` and deliver `list<T>` in edge-creation order.
6. **`any`** connects to everything, both directions, with a runtime check at execution and a visible "unchecked" edge style. For utility nodes (Inspect, Gate, Switch); discouraged elsewhere.
7. **Coercions** — engine-owned, total, lossless, cheap: `number → text`, `boolean → text`, and the `→ json` widenings. That is the whole table. Lossy or fallible conversions (`text → number`, `csv asset → table`) are visible nodes, not magic.

Multiple edges into a non-variadic input: refused. One source of truth per input.

## 7. The execution engine

### 7.1 Model: a demand-driven, memoized build graph

Workflows are **DAGs** — cycles are rejected at validation (ADR-0007; loops arrive later as explicit subgraph iteration, §15, not back-edges). "Run" means: given requested targets (whole graph, or one node), execute the reachable ancestor subgraph, **skipping every node whose memoized result is still valid**. This is a build system, deliberately: think make/Salsa, not an actor runtime. Framing it this way makes caching, partial re-runs, and "what will this run touch?" queries fall out of one mechanism instead of three.

### 7.2 Scheduling and concurrency

A ready-set worklist: a node becomes ready when all its inputs are resolved; ready nodes run concurrently, bounded per **lane**:

| Lane | Default cap | Rationale |
|---|---|---|
| `cpu` | max(1, cores − 1), clamped to 8 | Plugin/core compute; workers, not the engine loop |
| `io` | 16 | File/asset work |
| `ai` | 4 | Provider rate-limit citizenship |
| `mcp:<server>` | **1 per server** | A stdio server is one process of unknown reentrancy; raised per-server in settings when known safe |

Caps are configuration with defaults, not constants; these initial values are hypotheses to be profiled, not commitments. Core nodes execute on a worker pool in the engine host; plugin nodes execute in their plugin's process (§8); MCP nodes execute in the engine host where the client pool lives. One run per workflow at a time in v1 — starting a new run requires cancelling the active one (a run queue is deferred complexity).

### 7.3 Caching

Memoization key: `hash(engineAbi, nodeType, nodeVersion, canonicalParams, inputHashes…)` — canonical JSON (sorted keys, normalized numbers) hashed with BLAKE3 (the hash lives behind an interface; the specific algorithm is swappable). Two tiers: in-memory LRU for the session, persistent store (SQLite index + the content-addressed blob store, §11) across sessions. Only `caching: 'pure'` nodes participate; effectful nodes always run when demanded. Cached completions surface in the UI as `succeeded (cached)` — visibly instant, visibly stale-proof. Per-instance opt-out (`cache: false` on the node entry) for "pure but I want it fresh" cases. `--no-cache` on the CLI. Cache entries are valid forever by construction (content-addressed); eviction is size-based LRU, never correctness-based.

### 7.4 Cancellation

One `AbortController` per run, fanned out as `ctx.signal`. Guarantees: no node starts after cancel; in-flight nodes get the signal, then a 5-second grace, then (for out-of-process work) SIGTERM → SIGKILL; MCP calls send spec `notifications/cancelled`; AI calls abort through the SDK. Completed results stay cached — they're valid regardless of why the run stopped. The run ends in state `cancelled` with every node's final status recorded.

### 7.5 Partial failure

- A failing node gets status `failed` (taxonomy: `invalid-input`, `error`, `timeout`, `cancelled`).
- Its descendants become `skipped (upstream failed)` — never executed, never guessed.
- **Independent branches run to completion.** A 40-node workflow with one bad API key still produces the other 39 results; that is the concurrency model paying rent.
- Retries: only for errors explicitly marked transient — `ctx.retryable(err)` by node authors, and automatically for AI/MCP-layer 429/503s. Max 3 attempts, exponential backoff with jitter, every attempt visible as an event. Everything else fails fast; silent retry of non-idempotent work is how tools corrupt models.
- Error-values-on-wires (Result types) were rejected for v1 — they tax every node author for one pattern's benefit; a Try/Catch wrapper node can arrive later without contract changes.

### 7.6 Status to the UI: an event stream, not shared state

The engine emits one ordered, versioned event stream per run:

```
run:started        { runId, workflowHash, targets }
node:queued        { nodeId }
node:started       { nodeId, attempt }
node:progress      { nodeId, fraction?, message? }
node:log           { nodeId, level, message }
node:succeeded     { nodeId, cached: boolean, outputPreviews, durationMs }
node:failed        { nodeId, kind, message, willRetry }
node:skipped       { nodeId, reason }
run:finished       { status: succeeded|failed|partial|cancelled, stats }
```

The renderer folds events into UI state; the CLI prints them; the run manifest (§11) persists them as NDJSON. One protocol, three consumers — which is also why the engine is testable without a UI (§14). Output **previews** are computed engine-side and size-capped (~64 KB: truncated text, table head, image thumbnail); the renderer never touches raw bulk data.

## 8. The plugin boundary

### 8.1 Where the boundary sits

**A plugin is an OS process.** Each installed plugin package runs in its own child process of the engine host, speaking a versioned RPC protocol. Nodes within one plugin share their process; plugins never share.

Why a process and not `require()` into the engine (n8n's model) or worker threads: worker threads offer *no* security boundary and incomplete fault isolation; in-process loading offers neither. A process gives real fault containment (a segfaulting native dep fails one node, not the app), real OS-level mediation, and honest kill semantics for cancellation. The costs — RPC latency and serialization — are absorbed by the contract's core invariant: **wire values are small; bulk data is an `AssetRef`**, and plugin hosts read the content-addressed store directly (read-only mount; writes go through staged temp files committed by the engine). WASM sandboxing was rejected for v1: it forbids the native/heavyweight deps (geometry kernels) AEC plugins actually need.

Honesty clause, stated here and in ADR-0008: **v1's boundary is fault isolation plus permission mediation, not a hardened security sandbox.** A malicious native dependency inside a plugin process can do what the app's user can do. Defense today = capability-based API + declared permissions + user consent + no ambient authority; OS-level sandboxing of plugin processes (seatbelt profiles) is a documented hardening milestone, not v1.

### 8.2 What a plugin can and cannot reach

A plugin package is a directory: `archspace-plugin.json` manifest + a JS entry exporting `NodeModule[]`:

```jsonc
{
  "name": "acme-pointcloud",
  "version": "0.3.1",
  "namespace": "acme.pointcloud",   // owns node type ids under this prefix
  "displayName": "ACME Point Cloud Tools",
  "engineApi": 1,                   // node-sdk ABI major it was built against
  "entry": "dist/index.js",
  "permissions": ["net"],           // consented at install time
  "types": [{ "name": "cloud", "label": "Point cloud" }]
}
```

| Can reach (via `NodeContext` only) | Cannot reach |
|---|---|
| Declared inputs/params | Raw filesystem (no project dir, no home) |
| Asset store (content-addressed read; staged write) | Network — unless `net` declared **and** granted |
| Declared + granted secret keys | Secrets it didn't declare; the secrets file |
| `ctx.ai` gateway (user's configured providers) | Provider SDKs/keys directly |
| Logs, progress, temp dir | The renderer, Electron APIs, other plugins |
| — | The raw MCP client (MCP arrives only as generated nodes) |

Distribution in v1: a packed tarball installed into the managed plugins directory (`archspace plugin install ./acme.tgz` or via UI); a registry is future work. The **IFC plugin ships first-party but as a real plugin** — if the boundary can't carry our own flagship domain feature, it's decoration; this keeps us honest.

### 8.3 The polyglot tier is MCP

Python/C#/anything authors don't write Archspace plugins — they ship an **MCP server**, and it becomes nodes (§9). This is how IfcOpenShell (LGPL, Python) and ezdxf (MIT, Python) join the system with zero linking or FFI: a first-party "formats" MCP server, out of process, LGPL kept cleanly at arm's length. One extension story for the whole non-JS world, and it's the same story Revit already requires.

## 9. MCP servers as nodes

### 9.1 Configuration: logical names, local bindings

Workflows reference MCP servers by **logical name** (`revit`, `formats`). The binding — how `revit` actually launches or where it lives — is **user/machine settings, never the workflow file**:

```yaml
# ~/Library/Application Support/Archspace/mcp.yaml
servers:
  revit:
    transport: http
    url: https://revit-agent.office.example:8443/mcp   # Windows box running Revit + bridge
    auth: oauth                                         # tokens in Keychain
  formats:
    transport: stdio
    command: ["uvx", "archspace-formats-server"]
```

This split is load-bearing: workflows stay shareable (no absolute paths, no URLs, no credentials in git), and a repo can never make your machine execute a command — a project may *request* `revit`, but only the user's own settings say what `revit` runs. Project files suggesting bindings trigger an explicit consent flow; they are never auto-trusted (the VS Code tasks lesson).

### 9.2 Connection

The engine host owns an MCP client pool built on the official TS SDK, implementing the research §5 checklist: stdio child processes with spec shutdown (stdin close → SIGTERM → SIGKILL); Streamable HTTP with session headers, SSE resumption via `Last-Event-ID`, and both response modes; per-request timeouts; `notifications/cancelled`; version negotiation at `initialize`. OAuth 2.1 for remote servers exactly as specified — PKCE S256 required, RFC 9728 resource-metadata discovery, RFC 8707 `resource` parameter — with tokens in the OS keychain via `safeStorage`. Servers connect lazily on first demand and surface health in a status panel. This full remote stack is not gold-plating: **on macOS, every Revit path in the research is a remote authenticated server.**

### 9.3 Surfacing as nodes

On connect, `tools/list` responses generate node manifests mechanically — possible only because node params are already JSON Schema (§5):

- Type id: `mcp.<logicalName>.<toolName>`, lane `mcp:<logicalName>`.
- Each top-level `inputSchema` property → a param, promotable to an input port (schema type → port type: string→`text`, number→`number`, boolean→`boolean`, object/array→`json`).
- Outputs: `result` (`json`, structured content when the tool provides it), `text` (`text`, joined text content), `assets` (`list<asset>`, image/resource contents captured into the CAS).
- Caching: `'never'`, always. Tool annotations (`readOnlyHint`) are advisory per spec — we do not gamble cache correctness on them. A per-node "treat as pure" override exists for users who know their server.
- **Schema drift:** each MCP node stores the `schemaHash` of the tool schema it was authored against; on load, a live mismatch flags the node ("tool changed — review") rather than silently re-mapping. The workflow remains the reviewable source of truth.

Deferred, with hooks reserved (§15): MCP resources (as an asset-fetch node), prompts, and the client capabilities `sampling`/`elicitation` (both route through consent UI when they land; `sampling` will route through the AiGateway — a server borrowing the user's model is a feature, but only behind an explicit toggle).

## 10. AI provider abstraction

Two rules: nodes never see provider SDKs, and workflows never hardcode providers.

- **Nodes call `ctx.ai`** — our own thin interface: `generateText`, `generateObject` (JSON-Schema-constrained output — pairs naturally with `table`/`json` ports), `embed`. Implemented in `packages/ai-gateway`.
- **The gateway is implemented over the Vercel AI SDK provider layer** (`ai` + `@ai-sdk/*` packages, Apache-2.0): dozens of maintained providers — Anthropic, OpenAI, Google, Mistral, **Ollama and any OpenAI-compatible endpoint** (local/self-hosted parity is part of "no privileged provider") — behind one local library. To be explicit about the research's concern: this is a *library* dependency, not a routed *service* — no traffic passes through Vercel or any middleman, and no hosted gateway is ever a default. Our own interface on top means the AI SDK is swappable if it churns; it never appears in `node-sdk` types.
- **Workflows reference model *profiles*, not models.** Users define named profiles in settings — `default`, `fast`, `reasoning` — each mapping to provider + model + params, keys in the keychain. A workflow from a colleague who uses provider A runs unchanged on provider B: the profile name resolves per machine. Direct `provider/model` pinning is allowed but lint-flagged as a portability smell.
- A **`mock` provider** ships in the gateway: scripted responses for CI and the testkit; no live API in any test lane (§14).

Rejected: **LangChain** (heavy abstraction churn; we need calls, not chains — our graph *is* the chain); **per-provider SDKs behind our interface** (that's signing up to maintain N SDKs; the AI SDK's provider layer is exactly that maintenance, shared); **hosted router (OpenRouter-style) as default** (privileges a middleman and adds a network dependency to an offline-capable app; users can still add one as an OpenAI-compatible endpoint — their choice, not our default).

## 11. Files, assets, projects

- **A project is a directory** (normally a git repo): `workflows/*.archspace.yaml`, `assets/**` (user-managed source files), `.archspace/` (machine state, gitignored). A bare `.archspace.yaml` opened alone gets an implicit project in its directory — file-first UX still works.
- **Documents reference source assets by project-relative path** (`@assets/model.ifc`) — human-meaningful, git-meaningful. At run start the engine resolves paths → content hashes and records the mapping in the run manifest, so provenance is exact even as files change. Absolute paths never enter a document; files outside the project prompt copy-into-project.
- **Derived data lives in a content-addressed store (CAS)** under `.archspace/cache/` — every `AssetRef` produced by a node, keyed `b3:<hash>`. Gitignored *because* it's reproducible: the workflow is the recipe. To keep an output, **pin/export** copies it into `assets/` where git sees it. GC = LRU over unpinned CAS entries.
- **Run manifests** (`.archspace/runs/<runId>/`): the NDJSON event log + input hashes + node versions + timings. Debugging and provenance ("which model produced this schedule?") without polluting the document. Retention: last N runs.
- Secrets: `safeStorage`-encrypted (Keychain-backed key), stored in app support, **never** in the project. A pre-save lint refuses strings that look like credentials in documents.

## 12. Security posture (cross-cutting summary)

Renderer fully sandboxed; workflows are data (no eval, no expressions in v1); plugin capability model with install-time consent (§8, with its honesty clause); MCP bindings are machine-local with consent for project suggestions (§9); OAuth 2.1/PKCE for all remote servers; secrets in the OS keychain, never in documents, never on wires; localhost MCP bridges are expected to enforce Origin validation per spec — our docs for the future Revit agent will require it (DNS-rebinding, research §5). No telemetry by default; opt-in crash reporting later, if ever.

## 13. Packaging, signing, distribution (macOS)

- **electron-builder** with **electron-updater**. (Electron Forge rejected: fine tool, but builder + updater + GitHub Releases is the boring, proven open-source path with the richest macOS knobs.)
- **Universal binary** (arm64 + x64 in one artifact), DMG + ZIP (ZIP feeds the updater).
- **Developer ID Application** cert, **hardened runtime**, minimal entitlements, **notarized** via `notarytool` in CI (GitHub Actions macOS runner; cert + Apple API key as CI secrets). Gatekeeper-clean `spctl -a` on a fresh machine is a release gate, not a hope.
- **No Mac App Store** for v1 — the App Sandbox would break the product's spine: spawning stdio MCP servers, per-plugin child processes, and open project directories. Documented trade-off, revisitable only if the process model changes (it won't for v1).
- **App Sandbox off; hardened runtime on.** The security story is the process/permission architecture (§8, §12), stated honestly, not a checkbox.
- Distribution: **GitHub Releases** (canonical) + **Homebrew cask**. Auto-update via electron-updater against Releases; delta updates and staged rollouts later.
- Plugins are user-installed code: quarantine attributes on downloaded plugin archives are respected, and native binaries inside plugins are surfaced at install ("this plugin contains native code") as part of consent.

## 14. Testing strategy

The architecture was shaped to make the expensive things testable cheaply: everything below the Electron shell runs headless, and the CLI (`archspace run workflow.yaml`) is both a user feature and the integration harness.

| Layer | Approach |
|---|---|
| Document | **Property-based** (fast-check): `parse(emit(g)) ≡ g`; canonical stability `emit(parse(d)) ≡ d`; **comment survival** through open→edit→save; migration round-trips. Golden workflow files with snapshot diffs — a serializer change that dirties goldens is a reviewable event. |
| Type system | Table-driven assignability/coercion laws; property tests (widening is transitive; lift never loops). |
| Engine | **Deterministic mode**: virtual clock + seeded scheduler, simulated nodes (`sleep`, `failOnAttempt(n)`, `cacheProbe`). Asserts: parallel branches overlap; cancel stops within grace; cache hit ⇒ zero executions; one branch failing never skips an independent branch; retry backoff schedule exact. Run event logs snapshot-tested. |
| Node SDK | **`@archspace/node-sdk/testkit`**: run any `NodeModule` against fixture inputs/params with an in-memory ctx (mock assets, mock ai, captured logs) — no app required. The same tool plugin authors use; our core nodes are its first customer. |
| MCP | Official SDK `InMemoryTransport` for unit tests; a fixture server binary for process-level tests (spawn/kill/timeout/cancel); CI contract run against the reference `everything` server; schema-drift fixture flips a tool schema and asserts the flag. Revit-path smoke runs against a recorded community-server fixture (no Windows/Revit assumed in CI). |
| AI | The `mock` provider only, in unit/CI. Optional nightly live-smoke lane behind secrets, non-blocking. |
| App E2E | Playwright-for-Electron, deliberately thin: create → wire → run → statuses live → save → reload (layout + comments intact) → git diff minimal. The pyramid's tip, not its body. |
| Packaging | Release-candidate gate on a clean macOS VM: Gatekeeper pass, updater n−1 → n. |

CI on every PR: lint, typecheck, unit + property + engine + document suites, headless CLI integration runs, E2E on macOS runner. Coverage is a signal, not a gate; the gates are the property suites and the golden files.

## 15. Designed-but-deferred (the forward-compatibility ledger)

Each deferral names the hook that keeps it cheap later:

| Deferred | Hook already in place |
|---|---|
| Subgraphs as nodes / ForEach-map iteration | `kind:` field in documents; `list<T>` in the type system; nested-run support implied by demand-driven engine |
| Streaming between nodes (token streams) | `Value` envelope can carry a stream handle; event stream already incremental |
| JS expressions in params | Params are schema'd data; expression fields would be a new `x-archspace` widget + a real sandbox |
| Custom node inspector UIs | Manifest-driven forms mean a later sandboxed-webview slot is additive |
| MCP resources / prompts / sampling / elicitation | Client capabilities negotiated at `initialize`; consent UI pattern established |
| Plugin registry + signing | Manifest + tarball install already the unit of distribution |
| Windows/Linux packaging; the Windows Revit agent | Zero Electron-free packages import platform code; agent is an external MCP server by design |
| Hardened plugin sandboxing (seatbelt) | Plugins already out-of-process with mediated capabilities |
| Run queue / concurrent runs per workflow | Runs are already isolated by `runId` in engine and events |

## 16. Build order

Milestones are **scope-gated, not time-gated**; a milestone starts only when the previous gate is demonstrably true (gates are executable — a command, a test suite, a checklist on a clean machine). Headless before shell: the engine earns trust in CI before it gets a face.

**M0 — Foundations.**
Monorepo (pnpm), packages scaffolded with dependency rules enforced (no Electron below the shell), CI (lint, typecheck, Vitest) on macOS runner, `archspace` CLI stub.
*Gate:* CI green on a PR; `archspace --version` runs from a fresh checkout.

**M1 — Document & contract.**
`document` (YAML CST parse/patch/emit, canonical rules, migrations, lint), `types` (grammar, assignability, coercions), `node-sdk` (the §5 contract + testkit), `nodes-core` starter set (const, template, file read/write, csv→table, gate, inspect), registry with placeholder-node behavior.
*Gate:* property suites green (round-trip, canonical stability, comment survival); a hand-written workflow file validates and its `requires:` block regenerates byte-identically.
*Shipped short of scope:* **migrations and document lint are not built.** The gate above never asked for them — it names the three property suites and the `requires:` derivation, all of which are green — so M1 passed on what it measured while two items in its scope line went unbuilt. `archspace: 2` is a hard parse failure today with no upgrade path. That is survivable only because the format has never changed, and it is the first thing to build on the day it does. Recorded here rather than deleted from the scope line, because a milestone that quietly narrows to fit what happened is a milestone that measures nothing.

**M2 — Execution engine.**
Scheduler with lanes, memoization (memory + persistent CAS/SQLite), cancellation, retry policy, partial-failure semantics, event stream, run manifests, CLI runner executing real workflows headless.
*Gate:* deterministic-mode suite green: branch overlap proven under virtual clock; cancel → full stop within grace; unchanged re-run executes zero nodes; single-branch failure leaves independent branches `succeeded`. `archspace run` prints the event stream for a fixture workflow.

**M3 — Desktop shell & canvas.**
Electron shell (process model of §3.2), React Flow editor, JSON-Schema inspector forms, palette, run/cancel with live event-fed statuses, previews, open/save through the CST patcher.
*Gate:* E2E: build a three-node workflow in the UI, run it, watch statuses, save; `git diff` shows only intended semantic lines; reload preserves layout and hand-written comments.

**M4 — AI gateway & nodes.**
`ai-gateway` over the AI SDK provider layer, model profiles UI, keychain storage, `ai.generate_text` / `ai.generate_object` / `ai.embed`, mock provider wired into testkit and CI.
*Gate:* one workflow runs against two different real providers by switching a profile, no document edit; CI exercises the same workflow on `mock`.

**M5 — MCP integration.**
Client pool (stdio + Streamable HTTP + OAuth/PKCE + keychain tokens), logical-name registry + settings UI, tools→nodes generation, schema-drift detection, server health panel, consent flow for project-suggested bindings.
*Gate:* reference `everything` server's tools appear and execute as nodes; an authenticated remote HTTP server round-trips OAuth; drift fixture flags correctly; Revit-shaped smoke passes against the recorded community-server fixture.

**M6 — Plugin system + first-party IFC plugin.**
Plugin host processes, manifest/permissions/consent, install flow (tarball), `create-archspace-plugin` template, and the IFC plugin (web-ifc parse/query nodes + 3D preview panel) built as a real plugin.
*Gate:* template → testkit tests → pack → install → run, all documented and reproduced by a non-author; `process.exit(1)` inside a plugin node yields one failed node and a healthy app; undeclared-network attempt fails; IFC workflow loads a model and previews it.

**M7 — Projects, provenance, polish.**
Pin/export of derived assets, CAS GC, run-manifest browser ("what produced this?"), missing-requirements report on open (unbound servers/profiles/plugins), document lint surfaced in UI.
*Gate:* fresh clone of a project repo on a second machine reports exactly what's missing; after binding, a pure workflow reproduces hash-identical outputs; GC never touches pinned assets.

**M8 — Package & release.**
electron-builder pipeline, signing + notarization in CI, auto-update, Homebrew cask, docs site seed (plugin guide, MCP guide), first public alpha.
*Gate:* clean-macOS install passes Gatekeeper (`spctl -a`); auto-update from n−1 verified; a person outside the team follows the README from `git clone` to a running workflow.

Standing risks watched across milestones: Revit-agent reality (mitigated by fixtures + community servers until the first-party agent exists — see research §2.6 churn warning); React Flow performance at the high end (escape hatch documented in §3.3); plugin-sandbox expectations (honesty clause in §8 repeated in user-facing docs).
