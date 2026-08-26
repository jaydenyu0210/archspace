# ADR-0004 — Canonical, comment-preserving YAML with quarantined layout

- **Status:** Accepted
- **Date:** 2026-08-24

## Context

Workflows must live in git as first-class engineering documents: readable in review, mergeable, diffable. The prior art is a graveyard of bad diffs — ComfyUI's one-line JSON, Node-RED's `flows.json`, n8n exports. Two facts dominate: in an AI workflow tool the most-edited values are multi-line prompts, and reviewers need to distinguish logic changes from node-dragging.

## Decision

One file per workflow, `<name>.archspace.yaml`, YAML 1.2 (core schema), structure per ARCHITECTURE §4. The load-bearing rules:

1. **YAML over JSON** for two decisive features: block scalars (prompts diff line-by-line) and comments (workflows become annotated, reviewable documents). A published JSON Schema still validates the parsed data model.
2. **Canonical emission:** fixed key order, insertion-ordered nodes/edges (append-only on add; canvas moves never reorder), integer-rounded positions, one edge per line (`from.port -> to.port`).
3. **Layout quarantined** in a trailing `layout:` section — semantic diff above, pixels below. (Sidecar file rejected: breaks single-file sharing.)
4. **Patch, don't re-emit:** saves apply edits to the parsed YAML CST (`yaml` package document API), so user comments and unknown-but-valid fields survive round trips. Tested as a hard invariant.
5. **Random short node ids** (`n_` + 6 base32) so parallel branches don't collide on sequential ids in merges.
6. **No runtime state in the document**; results/caches live in gitignored `.archspace/`.
7. `requires:` block derived on save; documents are data — no expressions, no eval; `{{name}}` substitution only.
8. `archspace: 1` version field; loader migrates old documents forward; unknown node types become placeholders, never data loss.

## Consequences

- The serializer is real engineering (CST patching, canonical rules) with property tests — paid once, and the whole git story rests on it.
- YAML's implicit-typing traps are neutralized by the core schema + always-quoted emission of ambiguous scalars.
- Hand-edited files may be non-canonical; the app normalizes only touched regions, so a reformat never masquerades as a semantic change.

## Alternatives considered

- **JSON:** better tooling reflexes, but prompts-as-escaped-strings and no comments are disqualifying here. Rejected.
- **Custom DSL:** peak readability, years of parser/LSP/formatter cost. Rejected.
- **Directory bundle as the document:** solves assets but breaks "send someone a workflow"; the *project* is the bundle instead (ADR-0011). Rejected.
- **Embedding outputs in the file** (ComfyUI-style): destroys diffs, conflates program with execution. Rejected.
