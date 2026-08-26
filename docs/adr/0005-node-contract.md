# ADR-0005 — Node contract: declarative manifest + capability-scoped execute

- **Status:** Accepted
- **Date:** 2026-08-24

## Context

Every future node — built-in, third-party plugin, MCP-generated, AI — must satisfy one contract; the inspector UI, validation, caching, testkit, and plugin RPC are all derived from it. It is the decision with the largest blast radius in the project.

## Decision

A node type = **declarative `NodeManifest`** (pure data) + **`execute(ctx, inputs, params)`** (one async function). Full types in ARCHITECTURE §5.2; the six load-bearing choices:

1. **Manifest is serializable data, separate from code.** Palettes, forms, document validation, and cache keys work without executing plugin code, and manifests cross process/language boundaries.
2. **Params are JSON Schema (2020-12 subset)** with `x-archspace` UI extensions. Chosen because MCP tools already declare JSON Schema (`inputSchema` → params is mechanical), AI function-calling speaks it, and forms can be generated from it. Zod is a TS-side authoring convenience compiled to JSON Schema — never the contract.
3. **Params and input ports are separate, bridged by promotion:** a param marked `promotable` can be exposed as a typed input port; wired values override configured ones. (Grasshopper's everything-is-a-port and n8n's hard split both rejected.)
4. **Wire values are `Value` = JSON ∪ `AssetRef`, nothing else.** Bulk bytes always travel as content-addressed asset references. This one invariant makes caching hashable, IPC cheap, and cross-process execution uniform.
5. **`ctx` is the entire world:** cancellation signal, logs/progress, asset store, declared secrets, AI gateway, optional `fetch` (permission-gated), temp dir. No ambient authority — which is what makes the plugin boundary (ADR-0008) and the testkit (ADR-0013) possible.
6. **Explicit versioning:** integer `version` in the manifest, pinned in documents, `migrateParams` upgrades old configs at load, visibly (it's a document edit).

Caching declaration is binary in v1: `'pure'` (memoizable) or `'never'` (default).

## Consequences

- Every capability a node ever needs must be threaded through `ctx` — deliberate friction that keeps the boundary real.
- No custom React inspectors in v1 (forms are schema-generated); custom UI arrives later as a sandboxed slot without contract change.
- Streaming outputs are deferred; the `Value` envelope leaves room for a stream handle later.

## Alternatives considered

- **Zod (or TS types) as the schema contract:** best DX, but not serializable across processes/languages and requires executing plugin code to know its shape. Rejected as contract, kept as authoring sugar.
- **Class-based node API** (lifecycle methods, instance state): invites hidden state that breaks memoization and RPC; a pure async function is the honest unit. Rejected.
- **Nodes receive raw fs/network and "we trust plugins"** (n8n model): forecloses any future sandbox and makes permissions decorative. Rejected.
