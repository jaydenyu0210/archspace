# ADR-0008 — One OS process per plugin; MCP as the polyglot tier

- **Status:** Accepted
- **Date:** 2026-08-24

## Context

Third-party nodes are the growth loop, so the boundary must be generous enough to write real nodes (including native/heavy deps) and firm enough that a bad plugin can't silently own the app. Node.js offers no in-process isolation worth trusting: worker threads share the process and `require` reaches everything.

## Decision

1. **A plugin is an OS process** — one child process of the engine host per installed plugin package; nodes in a package share it; packages never share. Communication is versioned RPC implementing the node contract; `NodeContext` calls are mediated by the engine.
2. **Capability-scoped API only** (ADR-0005): plugins reach the asset store (direct read of the CAS; writes staged and committed by the engine), declared+granted secrets, `ctx.ai`, permission-gated `fetch`, logs/progress/temp. They cannot reach the project tree, arbitrary fs, the renderer, Electron, other plugins, or the raw MCP client. Permissions are declared in `archspace-plugin.json` and consented at install.
3. **Honesty clause:** v1 is *fault isolation + permission mediation*, not a hardened sandbox — a malicious native dependency can do what the user can do. Stated in user-facing docs verbatim; OS-level sandboxing (seatbelt profiles) is a planned hardening milestone made possible by already being out-of-process.
4. **The polyglot tier is MCP** (ADR-0009): Python/C#/other authors ship an MCP server, not a plugin. This is how IfcOpenShell (LGPL) and ezdxf join without linking issues.
5. Distribution v1: packed tarball into a managed plugins dir; registry later. The **first-party IFC plugin ships as a real plugin** to keep the boundary honest.

RPC cost is absorbed by the wire-value invariant (small JSON + AssetRefs); no bulk bytes cross the boundary.

## Consequences

- Per-plugin process overhead (~tens of MB each) bounds "hundreds of plugins" scenarios — acceptable: packages are few, nodes per package many.
- Crash containment is real and testable (`process.exit` in a node = one failed node, healthy app — an M6 gate).
- Plugin authors get honest cancellation (kill), and the engine gets honest supervision.

## Alternatives considered

- **In-process `require()`** (n8n): zero isolation, permissions decorative, one bad dep kills the app. Rejected.
- **Worker threads:** fault-ish isolation, no security story, shared-process crashes; rejected as the boundary (still used *inside* the engine for core-node compute).
- **WASM sandbox:** strongest isolation, but forbids native deps (geometry kernels) that AEC plugins genuinely need; rejected for v1.
- **Everything-is-MCP (no JS tier):** maximal uniformity, but a heavy ceremony for a ten-line utility node and no shared `ctx.ai`/assets semantics; rejected as the *only* tier.
