# ADR-0002 — TypeScript + Electron, engine in a utility process

- **Status:** Accepted
- **Date:** 2026-08-24

## Context

We need one stack for a canvas-heavy UI, an execution engine, a plugin runtime third parties will actually write for, an MCP client (stdio subprocesses + Streamable HTTP + OAuth 2.1), and IFC handling. The plugin runtime and the MCP client stack dominate the choice.

## Decision

**TypeScript everywhere, on Electron.**

- The official MCP TypeScript SDK is the reference client implementation of everything research §5 requires.
- JS/TS is the largest plugin-author base; the engine must live in the same runtime as in-process-tier plugins.
- web-ifc (TS/WASM, MPL-2.0) and the AI SDK provider layer are TypeScript.

Process model: sandboxed renderer (no Node); Electron main for windows/dialogs/safeStorage/updates; the **execution engine in an Electron `utilityProcess`**, which parents plugin host processes and stdio MCP servers — one supervision tree, crash-isolated from the UI. Tooling: pnpm workspaces, electron-vite, Vitest.

## Consequences

- Electron's footprint (~150 MB+, per-app Chromium) is accepted as the cost of the plugin/MCP/IFC synergies.
- Native modules (better-sqlite3) need electron-rebuild in CI — routine, but real.
- Engine crash recovery must be designed (main supervises, marks runs aborted) rather than assumed.

## Alternatives considered

- **Tauri:** smaller binaries, but the Rust backend either kills the JS plugin story or demands a Node sidecar that re-creates Electron's architecture by hand; Rust MCP tooling is younger than the TS SDK. Rejected.
- **Swift/SwiftUI:** best macOS feel; macOS-only forever, contradicting ADR-0001; no web-ifc; weak plugin story. Rejected.
- **Qt (C++/Python):** IfcOpenShell synergy is reachable anyway via MCP out-of-process; hand-rolled node canvas; painful macOS distribution for Python apps. Rejected.
- **Engine in the main process:** simpler IPC, but plugin/engine crashes would take the whole app down and heavy compute would block window management. Rejected.
