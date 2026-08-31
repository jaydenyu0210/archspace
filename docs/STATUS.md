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
| Workflow document (parse / patch / emit, comment survival) | **Real**, property-tested. Six properties over generated documents: round-trip, canonical stability, text hygiene, byte-identical no-op save, and two mutating-save shapes. **Migrations and document lint are not built** — `archspace: 2` is a hard parse failure with no upgrade path, and the M1 gate's "migrations, lint" is unbuilt scope, not shipped scope. Nothing needs them yet, because the format has never changed; the day it does, the framework is the first cost |
| Port type system, node contract + testkit | **Real** |
| Execution engine (lanes, memoization, cancel, retry, partial failure, events) | **Real**, deterministic-mode tested |
| CLI (`run`, `nodes`, `plugins`, `mcp`, `ai`, `doctor`) | **Real** |
| Electron shell: canvas, palette, JSON-Schema inspector, live run log, open/save | **Real** |
| Floor plan preview — the plan drawn as 2D geometry in the run panel | **Real.** Rooms, walls at true thickness, doors, exits and rotated room labels, with a storey switcher, on a resizable panel. Same visual vocabulary as the DXF export on purpose, so the two disagreeing is visible. Replaces what the headline node used to show: the leading 6% of a 261,000-character JSON blob. Storeys are carried up to a geometry budget (~34 KB for the 6-storey example); when a taller building exceeds it the caption says how many of how many are shown |
| Getting produced files out — **Save…** on any asset in the run panel, `archspace run --out <dir>` headless | **Real**, and covered end to end: the smoke test clicks Save in the packaged app and checks the bytes that land on disk. Bulk data never enters the renderer (§7.6) — it asks main to save an `AssetRef`, and main reads the bytes from the engine over its own channel |
| Param promotion — a `promotable` param exposed as an input port ([ADR-0017](adr/0017-param-promotion.md)) | **Real.** Persisted as a sorted `promoted:` list on the node entry; one derivation of the effective port list shared by the validator, the runner, the canvas and the connection check; the wired value folded into `params` between the schema defaults and the cache key, so a wire-supplied value and the same form-supplied value are one memo rather than two. Three first-party params are opted in (`aec.export_dxf.file_name`, and `avg_area_per_person_m2` / `circulation_factor` on `aec.space_program`), plus **every** MCP tool argument, which mcp-host has always marked promotable. Not built: promoting a param whose schema is an `enum` or an `array` loses that fidelity — §9.3 maps them to `text` and `json` — and nothing validates a wired value against the param's schema, deliberately, because nothing validates a configured one either |
| Plugin host: manifest, consent, one process per plugin, crash containment | **Real** |
| MCP host: official SDK, stdio + Streamable HTTP, OAuth 2.1, tools → nodes | **Real** code; not yet exercised against a live Revit server |
| AI gateway: profiles, Anthropic / OpenAI / Google Gemini / Ollama / OpenAI-compatible / mock | **Real** — calls the provider your profile names, with the key from the OS keychain and never from an ambient env var (proved per provider). The three hosted vendors are first-class entries on their own SDK packages rather than base URLs on the compatible shim, because that shim defaults `supportsStructuredOutputs` to false and silently downgraded `generateObject`'s JSON Schema to bare JSON mode — so an OpenAI or Gemini key produced objects that satisfied no schema. Each now carries the schema in its own dialect (`text.format`, `generationConfig.responseSchema`, `output_config.format`), pinned by tests that drive the real SDK against a recorded transport. OpenAI's strict mode is deliberately off: it demands `additionalProperties: false` everywhere, which hand-written manifest schemas do not have |
| `ai.generate_text`, `ai.generate_object`, `ai.extract_table`, `ai.embed` | **Real** model calls; fail with a clear message when no profile is bound |
| `aec.brief_from_text` | **Real.** Describe a building in a sentence and it returns the same `ProjectBrief` the form-based node emits, so it drops in at the head of any workflow — text in, and with the backends below, an IFC out. It asks a model for nine scalars, not for a building, and validates every one against the bounds the form itself enforces plus the floor-plan capacity rule, so an over-ambitious sentence is refused where the sentence is still on screen rather than three nodes later. No mock backend on purpose: there is no deterministic way to read a paragraph, and emitting a default brief while ignoring what was typed would be worse than failing. It is therefore not a bundled example — CI runs those with no key — and ships as [`docs/examples/text-to-bim.archspace.yaml`](examples/text-to-bim.archspace.yaml) |
| `aec.generate_massing`, `generate_floor_plan` | **Deterministic by default, and AI-backed when a profile is bound.** Both take a `backend` param defaulting to `auto`: a model chooses the *scheme* — the massing footprint, or the circulation parti (which axis the spine runs, single or double loaded, corridor width, room depth) — and the existing code turns it into geometry. The model is never asked for a number: areas, FAR, coverage, facade, elevations and every coordinate are computed from the polygon or parti it returned, so a metric cannot disagree with the volume it describes. A sampled scheme that leaves the site, encloses nothing, or will not fit the program is refused retryably before it becomes geometry — which also gives the ai path the fit check the deterministic packer has never had. `auto` degrades to the deterministic scheme when no model answers, saying which in the run log and, on massing, in `generator.name`. Setting `ai` makes failures hard |
| `aec.generate_structural_grid`, `generate_bim_model`, `apply_plan_fixes`, `generate_compliance_report` | **Deterministic mocks** of generative backends — no network, no model, no keys, and a `mock_latency_ms` param that simulates the pacing you see in the progress log. `generate_bim_model` does write a real IFC4 SPF (STEP) file — a 6-storey run produces ~516 KB with 636 walls, 159 spaces and 153 doors under a proper `IFCPROJECT → IFCSITE → IFCBUILDING → IFCBUILDINGSTOREY` hierarchy, **and it now carries geometry**: a placement chain from site to element and an `IfcExtrudedAreaSolid` per space, wall and door. Verified with IfcOpenShell ([ADR-0016](adr/0016-ifc-geometry.md)): full IFC4 schema validation *including EXPRESS rules* reports **0 issues**, the geometry engine produces 948 shapes with 0 failures, and every element's volume matches the source plan to within floating-point error. Still absent, because the plan data does not contain it: openings (doors are solids at their position, not voids cut into walls), slabs, roofs, materials and property sets |
| `aec.project_brief`, `site_constraints`, `space_program`, `adjacency_matrix`, `parking_estimate`, `generate_room_schedule`, `compare_reviews`, `export_table_csv` | **Real** — pure rule-based derivations over their actual inputs (setbacks/FAR from real lot dimensions, a schedule from real plan geometry, RFC 4180 CSV). Simple, but not stand-ins. Their inputs, however, usually come from the mocked generators above |
| `aec.export_dxf` | **Real, and the only output with drawable geometry.** Writes DXF R12 (`AC1009`): room polygons, wall outlines at their true thickness, door and exit markers, and centre-justified room labels, on AIA-convention layers (`A-WALL-EXTR-L0`, `A-AREA-BDRY-L0`, …) one set per storey. A 6-storey run is ~400 KB and 1119 entities. Verified by loading the output in `ezdxf` in strict R12 mode: **0 audit errors, 0 fixes**, and the declared `$EXTMIN`/`$EXTMAX` match the geometry bounding box exactly. Written the way AutoCAD writes R12 — CRLF, cp1252 bytes behind a declared `$DWGCODEPAGE`, three-column group codes, `CONTINUOUS` and `STANDARD` defined before anything references them — because AutoCAD is the reader that cannot be tested from here; the reasoning is in [`docs/research/dxf-r12.md`](research/dxf-r12.md). No door swing arcs, and silent-failure inputs (a negative layer colour, a zero text height, a layer name R12 cannot hold) are rejected rather than written out — see [ADR-0015](adr/0015-dxf-export.md) |
| `aec.review.code_compliance`, `accessibility`, `zoning`, `structural`, `energy_performance` | **Deterministic mocks** of review engines — but each check runs against the *actual* upstream geometry and constraints, so changing a design param genuinely changes the findings |
| `aec.review.filter_findings`, `merge_findings` | **Real** — pure set operations over review results; no backend stands behind them |
| The plugin boundary those seven nodes ride on | **Real** — a genuine separate OS process, install-time consent, capability RPC, crash containment |
| Autodesk / Revit / APS | **Not implemented** — see above |
| 3D / IFC preview (three.js + web-ifc, [ADR-0003](adr/0003-frontend-and-canvas.md)) | **Real.** An `asset<ifc>` output previews as an orbitable 3D panel in the execution pane: web-ifc (an independent parser — the file is shown as it IS, not as the writer meant it) streams the geometry into merged per-storey/per-category meshes, coloured by the viewer since the mock writer emits no styles; storey isolation and a spaces toggle (room volumes default hidden — they occlude everything); caption counts what was actually drawn. Bytes reach the sandboxed renderer through one fenced IPC (`asset:read`, capped at 64 MiB, content-address-checked) — the deliberate exception to §7.6, recorded there. The wasm rides the renderer bundle as a data: URI because file:// cannot fetch it packaged; `check-bundle.mjs` guards that. Parse/group/transform logic is pure and node-tested against the real writer's output through web-ifc's node build (`test/ifc-scene.test.ts`); the smoke test cross-checks drawn counts against the summary port in a live window. Not built: per-element selection/properties, sections, measurements — a viewer, not an editor (non-goal per §1) |
| macOS packaging (`pnpm dist`) | **Real, and verified.** Produces a universal .dmg and .zip; the packaged app launches, renders, and opens the bundled example. Unsigned unless a Developer ID identity is present — see [docs/releasing.md](releasing.md) §8 for exactly what was observed |
| Signing, notarization, Homebrew cask | **Not done.** No Developer ID identity, no tag pushed, so `release.yml` has never run |
| Auto-update | **Wired, unproven.** Reads the GitHub Releases feed on launch and ships in the bundle. The repository is public, so the anonymous read an updater needs would work — but nothing has ever been published at that feed, so no release has exercised any of it |
| Windows packaging | **Builds; blocked on modern Windows** (ADR-0014). `pnpm dist:win` produces an unsigned NSIS installer and ZIPs for x64 + arm64, cross-packaged on macOS. The first real install attempt (2026-08-27) was refused by **Smart App Control** on Windows 11, which unlike SmartScreen offers no override — so on a clean Windows 11 machine the download is unusable, not merely warned about. Running from source works. Signing is the fix and is not done |
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
  part of that gap by hand; see [CONTRIBUTING](../CONTRIBUTING.md) §3a. It now
  also covers the two things only a real window can answer — that a dropped
  file does not navigate the app away, and that the promote button on the
  inspector actually adds a port to the node card.
- **No shipped example wires a promotion**, because no built-in node emits a
  `number`: the only shape the current node set can demonstrate end to end is
  text into a string param. Promotion itself is covered by the CLI suite (the
  integration harness, ADR-0013) and by the smoke test; what is missing is a
  workflow a new user opens and *sees* it in. A node with a scalar output would
  close it.
- **Migrations and document lint are unbuilt**, and `archspace: 2` is a hard
  parse failure with no upgrade path. Survivable only because the format has
  never changed — see the M1 note in [ARCHITECTURE §16](ARCHITECTURE.md).
- No published release — see the status table above.

---

## Repository layout

```
packages/
  types/          port type system: grammar, assignability, coercions      (§6  / ADR-0006)
  node-sdk/       public node contract: manifest, module, context, testkit (§5  / ADR-0005)
  document/       canonical comment-preserving YAML, CST patch-on-save     (§4  / ADR-0004)
  engine/         demand-driven memoized DAG: lanes, cancel, event stream  (§7  / ADR-0007)
  nodes-core/     19 built-in nodes: 15 aec.* (6 are backend mocks) + 4 ai.* (real)
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
