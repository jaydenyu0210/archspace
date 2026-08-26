# ADR-0009 — Logical MCP server names; tools generated as nodes

- **Status:** Accepted
- **Date:** 2026-08-24

## Context

MCP is the app's bridge to Revit (remote, per ADR-0001), to the Python format tooling, and to the growing server ecosystem. Research §5 fixes the client obligations (spec 2025-11-25): stdio + Streamable HTTP, lifecycle negotiation, cancellation, OAuth 2.1/PKCE with RFC 9728/8414/8707 discovery. Workflows must stay shareable without leaking machine paths or credentials, and a cloned repo must never be able to execute a command on its own say-so.

## Decision

1. **Workflows reference servers by logical name** (`revit`, `formats`). Name → transport/command/URL binding lives only in user settings; a project may *suggest* bindings, gated behind an explicit consent flow. Documents carry no commands, paths, URLs, or credentials.
2. **The engine host owns one MCP client pool** (official TS SDK): stdio children with spec shutdown; Streamable HTTP with session headers, both response modes, SSE resumption; per-request timeouts; `notifications/cancelled`; full OAuth 2.1/PKCE + resource-metadata discovery; tokens via `safeStorage`/Keychain. Lazy connect; health surfaced in UI.
3. **`tools/list` generates node manifests mechanically** (possible because params are JSON Schema, ADR-0005): type `mcp.<name>.<tool>`, lane `mcp:<name>`, inputSchema properties → promotable params, outputs `result` (json) / `text` / `assets` (contents captured into the CAS).
4. **Caching `'never'`, always.** Spec says annotations like `readOnlyHint` are untrusted hints; we don't gamble cache correctness on them. Per-node user override exists.
5. **Schema drift is detected, not absorbed:** nodes pin a `schemaHash` of the tool schema they were authored against; live mismatch flags the node for review instead of silent re-mapping.
6. Deferred with hooks: resources (asset-fetch node), prompts, `sampling` (will route through the AiGateway behind an explicit consent toggle), `elicitation`.

## Consequences

- The remote/OAuth stack lands in one milestone (M5) because Revit-on-macOS *is* the remote authenticated case — it cannot be deferred.
- Serial-by-default per-server lanes (ADR-0007) make slow servers a visible bottleneck; the per-server cap override is the pressure valve.
- Dynamic nodes mean palette contents vary by machine; the `requires:` block + missing-requirements report keep that legible.

## Alternatives considered

- **Commands/URLs in the workflow file** (many tools do this): maximally convenient, leaks machine detail into git and hands repos arbitrary-command execution; rejected on security grounds.
- **One generic "MCP call" node** with server+tool as params: no per-tool ports/forms/validation, workflows opaque in review; rejected as the primary surface (a dynamic-call node may appear later for power users).
- **Trusting `readOnlyHint` for caching:** correctness gamble on an advisory field; rejected.
