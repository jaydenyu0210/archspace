# ADR-0001 — Cross-platform core, macOS ships first, Revit via remote MCP

- **Status:** Accepted
- **Date:** 2026-08-24

## Context

The restated brief (no brief file exists; see `docs/research/ecosystem.md` §0/§7) requires: macOS primary, Revit integration major, open source. The research establishes that Revit, its API, pyRevit, Dynamo-for-Revit, and every local Revit MCP server run only on Windows against a live Revit session (research §2–§3). "Revit integration running on the Mac" cannot be satisfied literally. The research recommends a cross-platform app plus a Windows-resident "Revit agent" (Revit add-in + MCP bridge over Streamable HTTP), and suggests shipping Windows first.

## Decision

1. Build the application cross-platform (no platform-specific code below the shell), but **ship macOS first** — the design request scopes packaging to macOS and the brief-as-restated says macOS-primary.
2. **Revit is reached exclusively as a remote MCP server** (research Option A; Parallels is its single-machine degenerate case, APS cloud and IFC interchange are the fallback tiers). The app never links Revit code and no milestone depends on a Windows build.
3. The Windows Revit agent is a separate, later deliverable. Until it exists, community MIT MCP servers (research §2.6) fill the slot over the identical transport, and CI uses recorded fixtures.
4. App license: **Apache-2.0** — compatible in both directions with the recommended dependency set (LGPL IfcOpenShell out-of-process, MPL-2.0 web-ifc, MIT elsewhere; research §6.5).

## Consequences

- The MCP client must support Streamable HTTP + OAuth 2.1 from the start (ADR-0009); it is the Revit path, not an extra.
- We knowingly defer the platform where live Revit runs locally; the macOS product must stand on AI + MCP + IFC value before the agent ships.
- GPL libraries (pyRevit, LibreDWG) can never be linked in-process; they remain reachable out-of-process via MCP.

## Alternatives considered

- **Windows first** (research's suggestion): exercises the full stack earliest, but contradicts the explicit macOS scope of this design request and competes head-on where pyRevit/Dynamo already live. Rejected for sequencing, not architecture — the code stays portable.
- **macOS-only app:** narrows the market permanently and forfeits the future local-Revit tier. Rejected.
- **Native Swift app:** see ADR-0002. Rejected.
