# ADR-0011 — Project directory + content-addressed derived store

- **Status:** Accepted
- **Date:** 2026-08-24

## Context

AEC workflows chew on large binaries (IFC models, point clouds, PDFs, images). Documents must reference them without embedding them (ADR-0004), sharing a repo must carry the inputs, and derived outputs must be reproducible rather than committed. Wires carry `AssetRef`s, never bytes (ADR-0005).

## Decision

1. **A project is a directory** (normally a git repo): `workflows/*.archspace.yaml`, `assets/**` (user-managed inputs, committed), `.archspace/` (machine state, gitignored). A lone workflow file gets an implicit project in its directory.
2. **Documents reference inputs by project-relative path** (`@assets/model.ifc`) — human- and git-meaningful. Absolute paths never enter documents; out-of-project files prompt copy-in. At run start, paths resolve to content hashes recorded in the run manifest — exact provenance even as files change.
3. **Derived data lives in a content-addressed store** (`.archspace/cache/`, keyed `b3:<hash>`) shared with the memoization layer (ADR-0007). Gitignored because reproducible: the workflow is the recipe. **Pin/export** copies a derived asset into `assets/` when it should become a kept input.
4. **Run manifests** (`.archspace/runs/<id>/`): event log (NDJSON) + input hashes + node versions + timings; retention last N. Answers "what produced this file?" without touching the document.
5. **Secrets never live in the project** — `safeStorage`-encrypted in app support; a pre-save lint refuses credential-looking strings in documents.
6. GC: size-LRU over unpinned CAS entries; pinned and referenced-by-recent-runs entries are exempt.

## Consequences

- Cloning a project on a second machine + binding requirements reproduces pure outputs hash-identically (an M7 gate).
- Large committed inputs are the user's git problem (LFS if they choose); we deliberately don't invent storage.
- The CAS doubles as the cache value store — one blob discipline, two payoffs.

## Alternatives considered

- **Embed assets in the document** (base64): kills diffs and file sizes. Rejected.
- **Absolute paths:** breaks sharing instantly. Rejected.
- **App-global asset library outside the repo:** breaks clone-and-run and provenance. Rejected for inputs (the CAS is global-ish but only for reproducible derivations).
- **Committing derived outputs by default:** repo bloat and merge noise for recomputable data; pin/export covers the exceptions. Rejected.
