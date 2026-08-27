# Archspace — detailed status

The honest, exhaustive version of what exists and what does not. The
[README](../README.md) summarises this; nothing here contradicts it, it is only
longer. If the two ever disagree, this file is the one that was updated last —
raise it as a bug.

---

## Revit and Autodesk

**Archspace does not integrate with Revit today, and this repository contains no
Revit code.** Saying otherwise would be the most tempting lie available to an AEC
tool, so here is the whole picture:

- **Revit is Windows-only.** Autodesk publishes no macOS build; Revit's API is
  the .NET add-in model, loaded in-process by a live Revit session. Every Revit
  MCP server — Autodesk's own Revit 2027 Tech Preview server and the community
  ones alike — therefore runs on Windows, beside that session.
- **Archspace ships macOS-first** ([ADR-0001](adr/0001-platform-strategy.md)),
  so the *only* architecturally sanctioned path to a live Revit session is a
  **remote MCP server**: Revit plus an MCP bridge running on a Windows machine
  you control (a workstation, an office box, a Parallels VM, a cloud VM), reached
  over authenticated Streamable HTTP. The app never links Revit code. What you
  can do through it is whatever that server can do.
- **Archspace does not ship that bridge.** A first-party Windows Revit agent
  (add-in + bridge + installer) is named in the architecture as a future
  deliverable; no part of it is built here. Until it exists you supply your own
  server, and Archspace is only the MCP client.
- **Autodesk Platform Services (APS) is not implemented.** Design Automation,
  AEC Data Model, Model Derivative, Data Management and their OAuth are empty,
  named seams that throw `UnimplementedCapabilityError` if reached.
- **One Autodesk server works from a Mac as-is:** the remote **Autodesk Product
  Help MCP** server (documentation search, no Revit, no Windows) — reachable like
  any other remote MCP server once you have its endpoint.

None of this is folklore. `packages/autodesk` holds the capability table — 11
entries: 1 available, 3 Windows-only, 1 requiring a remote agent, and 6 not
implemented — each with a status, what it requires, and cited evidence for why we
believe it. That package exports **zero nodes**, on purpose: an `autodesk.*` node
whose `execute()` threw would still appear in the palette and be saved into
documents, which is a seam masquerading as a feature.

---

## Status: real, mock, or absent

| Area | Status |
|---|---|
| Workflow document (parse / patch / emit, comment survival, migrations, lint) | **Real**, property-tested |
| Port type system, node contract + testkit | **Real** |
| Execution engine (lanes, memoization, cancel, retry, partial failure, events) | **Real**, deterministic-mode tested |
| CLI (`run`, `nodes`, `plugins`, `mcp`, `ai`, `doctor`) | **Real** |
| Electron shell: canvas, palette, JSON-Schema inspector, live run log, open/save | **Real** |
| Plugin host: manifest, consent, one process per plugin, crash containment | **Real** |
| MCP host: official SDK, stdio + Streamable HTTP, OAuth 2.1, tools → nodes | **Real** code; not yet exercised against a live Revit server |
| AI gateway: profiles, Anthropic / Ollama / OpenAI-compatible / mock | **Real** — calls the provider your profile names |
| `ai.generate_text`, `ai.generate_object`, `ai.extract_table`, `ai.embed` | **Real** model calls; fail with a clear message when no profile is bound |
| `aec.generate_massing`, `generate_floor_plan`, `generate_structural_grid`, `generate_bim_model`, `apply_plan_fixes`, `generate_compliance_report` | **Deterministic mocks** of generative backends — no network, no model, no keys, and a `mock_latency_ms` param that simulates the pacing you see in the progress log. Each says "Mock …" in its own manifest description. `generate_bim_model` does write a real IFC4 SPF (STEP) file — a 6-storey run produces ~74 KB with 636 walls, 159 spaces and 153 doors under a proper `IFCPROJECT → IFCSITE → IFCBUILDING → IFCBUILDINGSTOREY` hierarchy and real IFC GUIDs. **Spatial structure only: no geometry.** Every element has null placement and null representation, so an IFC viewer shows the tree and an empty 3D view |
| `aec.project_brief`, `site_constraints`, `space_program`, `adjacency_matrix`, `parking_estimate`, `generate_room_schedule`, `compare_reviews`, `export_table_csv` | **Real** — pure rule-based derivations over their actual inputs (setbacks/FAR from real lot dimensions, a schedule from real plan geometry, RFC 4180 CSV). Simple, but not stand-ins. Their inputs, however, usually come from the mocked generators above |
| `aec.export_dxf` | **Real, and the only output with drawable geometry.** Writes DXF R12 (`AC1009`): room polygons, wall outlines at their true thickness, door and exit markers, and centre-justified room labels, on AIA-convention layers (`A-WALL-EXTR-L0`, `A-AREA-BDRY-L0`, …) one set per storey. A 6-storey run is ~310 KB and 1119 entities. Verified by loading the output in `ezdxf` in strict R12 mode: **0 audit errors, 0 fixes**, and the declared `$EXTMIN`/`$EXTMAX` match the geometry bounding box exactly. Text is escaped to pure ASCII (`\U+XXXX`, the mechanism AutoCAD itself uses for R12), so no reader's codepage can mangle it. No door swing arcs — see [ADR-0015](adr/0015-dxf-export.md) |
| `aec.review.code_compliance`, `accessibility`, `zoning`, `structural`, `energy_performance` | **Deterministic mocks** of review engines — but each check runs against the *actual* upstream geometry and constraints, so changing a design param genuinely changes the findings |
| `aec.review.filter_findings`, `merge_findings` | **Real** — pure set operations over review results; no backend stands behind them |
| The plugin boundary those seven nodes ride on | **Real** — a genuine separate OS process, install-time consent, capability RPC, crash containment |
| Autodesk / Revit / APS | **Not implemented** — see above |
| 3D / IFC preview (three.js + web-ifc, [ADR-0003](adr/0003-frontend-and-canvas.md)) | **Not built.** Designed, dependencies not even installed |
| macOS packaging (`pnpm dist`) | **Real, and verified.** Produces a universal .dmg and .zip; the packaged app launches, renders, and opens the bundled example. Unsigned unless a Developer ID identity is present — see [docs/releasing.md](releasing.md) §8 for exactly what was observed |
| Signing, notarization, Homebrew cask | **Not done.** No Developer ID identity, no tag pushed, so `release.yml` has never run |
| Auto-update | **Wired, unproven.** Reads the GitHub Releases feed on launch and ships in the bundle; no release has ever exercised it, and a private repo's feed is not anonymously readable |
| Windows packaging | **Builds, unverified** (ADR-0014). `pnpm dist:win` produces an unsigned NSIS installer and ZIPs for x64 + arm64. Cross-packaged on macOS — the bundle is assembled correctly, but **nobody has run it on Windows** |
| Linux packaging | **Deferred by decision** (ADR-0001); no package imports platform code |

The mock nodes' output shapes are the contract, not a sketch:
[`packages/nodes-core/src/shapes.ts`](../packages/nodes-core/src/shapes.ts) is
structured exactly as a real backend would return, so substituting a real
integration is a change inside `execute()`, never a port or shape rewrite. The
mock nodes announce themselves where you can see it: each one's manifest
description opens with "Mock …", and that description is what the palette and the
inspector display.

### Known gaps in the repo itself

- **The app is not signed or notarized**, so a first launch needs
  right-click → Open. `pnpm dist` itself works and the packaged app runs; only
  the signing half is unexercised (docs/releasing.md §8).
- One structural trap worth knowing before you go bug-hunting: `pnpm test` is
  `pnpm -r run test`, every package declares `"test": "vitest run"`, and
  **Vitest exits non-zero when a package has no test files at all** — so a new
  package without a suite reds the whole command with nothing actually failing
  an assertion.
- **CI does not launch Electron**, which is how two launch-blocking bugs once
  shipped past a fully green run. `pnpm --filter @archspace/app smoke` closes
  part of that gap by hand; see [CONTRIBUTING](../CONTRIBUTING.md) §3a.
- **Param promotion is specified but unbuilt.** ARCHITECTURE §5.1 and §9.3 say
  a param marked `promotable` can be exposed as an input port, and MCP params
  already carry the flag — but the document format has no field to persist the
  choice, so this needs an ADR before it needs code.
- No 3D/IFC preview and no published release — see the status table above.

---

## Repository layout

```
packages/
  types/          port type system: grammar, assignability, coercions      (§6  / ADR-0006)
  node-sdk/       public node contract: manifest, module, context, testkit (§5  / ADR-0005)
  document/       canonical comment-preserving YAML, CST patch-on-save     (§4  / ADR-0004)
  engine/         demand-driven memoized DAG: lanes, cancel, event stream  (§7  / ADR-0007)
  nodes-core/     18 built-in nodes: 14 aec.* (6 are backend mocks) + 4 ai.* (real)
  ai-gateway/     provider abstraction: named model profiles over ctx.ai   (§10 / ADR-0010)
  mcp-host/       MCP client pool, OAuth 2.1, tools → generated nodes      (§9  / ADR-0009)
  plugin-host/    out-of-process plugin loader: consent, supervision, RPC  (§8  / ADR-0008)
  autodesk/       what we may claim about Revit/APS: capabilities, sources,
                  MCP presets, unimplemented seams — and zero nodes        (ADR-0001)
  cli/            `archspace` headless runner and integration harness      (ADR-0013)
  app/            Electron shell: main + preload + renderer + engine child (§3  / ADR-0002)
plugins/
  aec-review/     first-party plugin — the 7 aec.review.* nodes; dogfoods the boundary
docs/
  ARCHITECTURE.md the spec; adr/ the decisions; research/ the evidence;
                  creating-nodes.md the practical node-authoring guide
```

`types`, `node-sdk`, `document`, `engine`, `nodes-core`, `ai-gateway`,
`mcp-host`, `plugin-host`, `autodesk` and `cli` contain **zero Electron
imports** — all of it runs headless in plain Node, which is the property the
whole testing strategy rests on.

---
