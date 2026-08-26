# Archspace

**Node-based workflows for AEC work.** Archspace is an open-source, macOS-first
desktop app in which you wire a directed graph on a canvas — plan a brief,
generate a scheme, review it against code, report on it — and run it. Workflows
are saved as plain, comment-preserving YAML that diffs cleanly in git, so a
workflow is something you can review in a pull request rather than a document
locked inside an application.

It is for the people who already automate AEC work and are tired of the seams:
architects and computational-design people who live in Dynamo/Grasshopper/pyRevit
and want AI model calls, MCP tools and file-format operations in the *same*
graph, under version control, on a Mac.

> ### Read this before you install anything
>
> This repository is a **pre-release build (v0.1.0)**, and it is deliberately
> honest about that:
>
> - **There is no published release yet.** No signed `.dmg` exists to download.
>   Building from source is the only way to run it today.
> - **The nodes that stand in for generative and review backends are
>   deterministic mocks** — six of the fourteen `aec.*` nodes (the massing, floor
>   plan, structural grid and BIM generators, the fixer, the report writer) and
>   the five `aec.review.*` discipline checks. They do no network I/O, call no
>   model, and return the same answer every run. What they *are* is the output
>   contract a real backend will have to satisfy. The plumbing around them — the
>   planning, scheduling, comparison and export nodes — is real.
> - **The `ai.*` nodes are not mocks** — they call whichever provider your model
>   profile names, and fail with a clear message when none is bound.
> - **Nothing here talks to Revit.** See [Revit and Autodesk](#revit-and-autodesk).
>
> The full breakdown is in [Status: real, mock, or absent](#status-real-mock-or-absent).

---

## The workflow model

A workflow is a **DAG**, not a script and not a flowchart. Six ideas carry the
whole model:

**1. Nodes are declarative manifests plus one async function.** A node type
declares its ports, its parameters (as JSON Schema — which is what lets the app
generate the inspector form, and lets MCP tools become nodes mechanically), its
caching policy and its concurrency lane. Its `execute(ctx, inputs, params)`
reaches the outside world *only* through `ctx`. See
[ADR-0005](docs/adr/0005-node-contract.md) and the walkthrough in
[docs/creating-nodes.md](docs/creating-nodes.md).

**2. Wires carry values, not bytes.** Ports have types — `text`, `number`,
`boolean`, `json`, `table`, `list<T>`, and tagged assets like `asset<ifc>`.
Assignability is explicit: no implicit mapping, no silent lossy coercion
([ADR-0006](docs/adr/0006-port-type-system.md)). Bulk data (an IFC model, a point
cloud) travels as an `AssetRef` into a content-addressed store; the wire carries
the reference ([ADR-0011](docs/adr/0011-assets-and-projects.md)).

**3. Execution is demand-driven and memoized.** You ask for a node's output; the
engine walks back, runs only what is stale, and runs independent branches
concurrently within per-resource *lanes* (`ai`, `mcp:<server>`, …). One branch
failing leaves independent branches `succeeded` and only its own descendants
`skipped` ([ADR-0007](docs/adr/0007-execution-engine.md)).

**4. Status is an event stream, not shared state.** A run emits
`node:started` / `node:progress` / `node:succeeded` / `node:failed` …; the canvas
and the CLI render the same stream. That is why the headless runner is a
first-class user feature and not a test-only shim.

**5. Loops are unrolled.** A review → fix → re-review cycle is two review nodes
side by side, never a back-edge — see
`packages/app/resources/review-fix-report.archspace.yaml`.

**6. The document is the source of truth.** Saving patches the YAML CST in place,
so your comments and key order survive a round-trip; node positions are
quarantined in a `layout:` block at the bottom so moving a node on the canvas
does not scramble the diff; and a generated `requires:` block at the top names
the plugins, MCP servers and model profiles the file needs
([ADR-0004](docs/adr/0004-workflow-document-format.md)).

Three example workflows ship in `packages/app/resources/` and are copied into
your workflows directory on first launch:

| File | What it demonstrates |
|---|---|
| `concept-compliance.archspace.yaml` | Brief → program → floor plan → IFC model → code review → report |
| `branching-review.archspace.yaml` | One scheme, five concurrent review arms, one merge; partial failure |
| `review-fix-report.archspace.yaml` | The unrolled review → fix → re-review → compare loop |

---

## Install (end users)

**No release has been published yet.** `.github/workflows/release.yml` builds,
signs and notarizes a universal macOS `.dmg` + `.zip` and publishes them as a
**draft** GitHub Release on a `v*` tag, but no such tag exists in this
repository. Until one does, [build from source](#build-from-source).

When a release does exist, this is what to expect:

1. Download the `.dmg` from the repository's **Releases** page, open it, drag
   **Archspace** to Applications.
2. On first open, macOS shows the standard prompt for a notarized app
   downloaded from the internet — *"Archspace is an app downloaded from the
   Internet. Are you sure you want to open it?"* Click **Open**. That prompt is
   the expected one; you should not have to right-click, run `xattr`, or visit
   Privacy & Security.
3. If you instead see *"cannot be opened because the developer cannot be
   verified"*, the build you downloaded was **not** signed — do not work around
   it, report it. The release workflow refuses to publish unsigned artifacts
   precisely so that this message is never something you have to click past
   ([ADR-0012](docs/adr/0012-macos-packaging.md)).

Archspace is **not** on the Mac App Store, and will not be for v1: the App
Sandbox forbids the things the product is made of — spawning stdio MCP servers,
one child process per plugin, opening arbitrary project directories. That
trade-off is written down rather than papered over (ADR-0012 §4).

---

## Build from source

### Prerequisites

| | Version | Where it is pinned |
|---|---|---|
| **Node.js** | **22** (`engines` allows ≥22) | [`.nvmrc`](.nvmrc), `package.json` |
| **pnpm** | **10.33.2** | `packageManager` in [`package.json`](package.json) |
| **macOS** | any recent version, Apple silicon or Intel | — |

`corepack enable` will honour the pinned pnpm version automatically. CI pins
nothing beyond these two files on purpose — a second pin eventually disagrees
with the first.

### Run it from the workspace

```sh
pnpm install
pnpm --filter @archspace/plugin-aec-review build   # the first-party plugin is loaded from its built dist/
pnpm dev                                           # launches Electron; opens the concept-compliance example
```

`pnpm dev` starts electron-vite with HMR for the renderer. On first launch the
three example workflows are copied into
`~/Library/Application Support/Archspace/workflows/` and the first one is opened,
so you are never staring at an empty canvas.

### Run a workflow headless

The CLI is both a user feature and the integration harness
([ADR-0013](docs/adr/0013-testing-strategy.md)). This command works from a fresh
checkout and prints the live run event stream:

```sh
pnpm cli run packages/app/resources/concept-compliance.archspace.yaml --trust-plugin aec-review
```

`--trust-plugin` is **required, not decorative**. That workflow uses
`aec.review.code_compliance`, which lives in the first-party plugin, and a plugin
that has not been consented to cannot load — even one declaring zero permissions
([ADR-0008](docs/adr/0008-plugin-boundary.md)). A terminal has no consent dialog,
so the grant is made explicitly on the command line, scoped to that single run.
Drop the flag and the run refuses to start — `plugin "aec-review" is
needs-consent: this plugin has not been reviewed yet` — which is the boundary
working, not a bug.

Other CLI commands — all of which read the same settings files the desktop app
does:

```sh
pnpm cli nodes                  # every node type available here (18; 25 with the plugin trusted)
pnpm cli plugins                # installed plugins and their consent state
pnpm cli mcp [--connect NAME]   # configured MCP servers and their tools
pnpm cli ai  [--probe PROFILE]  # model profiles and whether they are ready
pnpm cli doctor [WORKFLOW]      # all of the above as one report
```

`doctor` exists for the failure mode this app has to be good at: *"the workflow
my colleague sent me will not run on my machine."* A document names logical
servers, profiles and plugins; only your machine's settings say what those
resolve to.

### Package a macOS app locally

```sh
pnpm build                                    # renderer + preload + main, and the plugin
cd packages/app && pnpm exec electron-builder --mac --dir --publish never
# → packages/app/dist/mac-arm64/Archspace.app
```

Two honest caveats. This build is **unsigned** — it runs on the machine that
built it (a locally built app was never downloaded, so it carries no quarantine
flag and Gatekeeper does not gate it), but do not hand it to anyone else.
And it uses the **default Electron icon**: the repo deliberately ships no
`icon.icns` yet rather than a placeholder. The universal signed `.dmg` is
produced only by CI, which is the only sanctioned release path because that is
where the Apple credentials live.

> The root `package.json` has a `dist` script that does not currently work —
> it delegates to a `dist` script in `packages/app`, which does not exist. Use
> the `electron-builder` invocation above.

---

## Development

Five commands define "done", and CI runs exactly these, in this order, on
macOS ([`.github/workflows/ci.yml`](.github/workflows/ci.yml)):

```sh
pnpm lint
pnpm typecheck
pnpm --filter @archspace/plugin-aec-review build   # must precede test: the plugin is loaded from its dist/
pnpm test
pnpm cli run packages/app/resources/concept-compliance.archspace.yaml --trust-plugin aec-review
```

The last one is not a demo. Everything below the Electron shell runs headless by
design, so a real end-to-end run through the document parser, the type system,
the scheduler and the plugin boundary is the cheapest honest integration gate we
have. If it breaks, one of those broke, and the event stream says which.

House rules that no linter can enforce for you:

- Every source file opens with a doc comment giving the design rationale and
  citing what it implements (`ARCHITECTURE §9 / ADR-0009`). Comments explain
  *why*, and usually name the alternative that lost.
- `any`, `@ts-expect-error` and `eslint-disable` are errors outside tests. **A
  false green is worse than a known failure** — if something cannot be done
  honestly, leave it undone and say so.
- Only `packages/app` may import `electron`. Everything below the shell takes
  its capabilities as injected seams, which is what keeps the CLI and the test
  suites working. ESLint enforces this one.

Read [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) first; every decision in it
has a record in [`docs/adr/`](docs/adr/README.md), and the ADR wins over
intuition — the rejected alternatives are named on purpose.

---

## Extending Archspace

There are three extension points, and they are three because they answer three
different questions.

### Plugins — for TypeScript node authors

A plugin is a directory with an `archspace-plugin.json` manifest and a JS entry
exporting `NodeModule[]`, and it runs as **its own OS process**, a child of the
engine host, speaking capability RPC — so a segfaulting native dependency fails
one node rather than the app, and cancellation has honest kill semantics. A
plugin owns a node-type namespace, declares the permissions it needs (`net`,
named secrets), and cannot load at all until the user consents; it reaches the
world only through `NodeContext`, never the filesystem, the network, the
renderer, or another plugin. Note the stated limit: v1's boundary is fault
isolation plus permission mediation, **not a hardened security sandbox** — a
malicious native dependency inside a plugin process can do what you can do.
→ [ADR-0008](docs/adr/0008-plugin-boundary.md). Worked example:
[`plugins/aec-review/`](plugins/aec-review), which is first-party but ships as a
real plugin so the boundary is load-bearing rather than decorative.

### MCP servers — for everyone else, in any language

Python, C#, Rust and Go authors do not write Archspace plugins; they ship an
**MCP server**, and on connect every tool it advertises becomes a node
(`mcp.<server>.<tool>`) generated mechanically from its JSON Schema. Workflows
reference servers by **logical name** only — `revit`, `formats` — while the
binding that says what `revit` actually *is* lives in
`~/Library/Application Support/Archspace/mcp.yaml` on your machine, so documents
stay shareable and a repository can never make your machine execute a command.
The client is the official TypeScript SDK with both transports, OAuth 2.1 + PKCE
for remote servers, tokens in the Keychain, and a stored schema hash per node so
a tool that changes shape flags the node for review instead of silently
re-mapping. → [ADR-0009](docs/adr/0009-mcp-integration.md).

### AI providers — no provider is privileged

Nodes call `ctx.ai` (`generateText`, `generateObject`, `embed`) and never see a
provider SDK or a key; the gateway behind it is implemented over the Vercel AI
SDK's *provider layer* as a plain library — no traffic is routed through anyone,
and no hosted gateway is ever a default. Workflows name a **model profile**
(`default`, `fast`, `reasoning`) defined in
`~/Library/Application Support/Archspace/ai.yaml`, never a vendor or a model
string, so a colleague's workflow runs unchanged on your provider. Shipped
providers today: **Anthropic**, **Ollama** (local, no key, no egress), **any
OpenAI-compatible endpoint** (LM Studio, vLLM, a self-hosted router), and a
deterministic **mock** provider for CI and offline demos — never a default.
→ [ADR-0010](docs/adr/0010-ai-provider-abstraction.md).

---

## Revit and Autodesk

**Archspace does not integrate with Revit today, and this repository contains no
Revit code.** Saying otherwise would be the most tempting lie available to an AEC
tool, so here is the whole picture:

- **Revit is Windows-only.** Autodesk publishes no macOS build; Revit's API is
  the .NET add-in model, loaded in-process by a live Revit session. Every Revit
  MCP server — Autodesk's own Revit 2027 Tech Preview server and the community
  ones alike — therefore runs on Windows, beside that session.
- **Archspace ships macOS-first** ([ADR-0001](docs/adr/0001-platform-strategy.md)),
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
| `aec.generate_massing`, `generate_floor_plan`, `generate_structural_grid`, `generate_bim_model`, `apply_plan_fixes`, `generate_compliance_report` | **Deterministic mocks** of generative backends — no network, no model, no keys, and a `mock_latency_ms` param that simulates the pacing you see in the progress log. Each says "Mock …" in its own manifest description. `generate_bim_model` does write a syntactically valid IFC4 SPF (STEP) file, derived from mock plan data |
| `aec.project_brief`, `site_constraints`, `space_program`, `adjacency_matrix`, `parking_estimate`, `generate_room_schedule`, `compare_reviews`, `export_table_csv` | **Real** — pure rule-based derivations over their actual inputs (setbacks/FAR from real lot dimensions, a schedule from real plan geometry, RFC 4180 CSV). Simple, but not stand-ins. Their inputs, however, usually come from the mocked generators above |
| `aec.review.code_compliance`, `accessibility`, `zoning`, `structural`, `energy_performance` | **Deterministic mocks** of review engines — but each check runs against the *actual* upstream geometry and constraints, so changing a design param genuinely changes the findings |
| `aec.review.filter_findings`, `merge_findings` | **Real** — pure set operations over review results; no backend stands behind them |
| The plugin boundary those seven nodes ride on | **Real** — a genuine separate OS process, install-time consent, capability RPC, crash containment |
| Autodesk / Revit / APS | **Not implemented** — see above |
| 3D / IFC preview (three.js + web-ifc, [ADR-0003](docs/adr/0003-frontend-and-canvas.md)) | **Not built.** Designed, dependencies not even installed |
| Signed release, auto-update, Homebrew cask | **Not published yet.** The workflow exists; no tag has run it |
| Windows / Linux packaging | **Deferred by decision** (ADR-0001); no package imports platform code |

The mock nodes' output shapes are the contract, not a sketch:
[`packages/nodes-core/src/shapes.ts`](packages/nodes-core/src/shapes.ts) is
structured exactly as a real backend would return, so substituting a real
integration is a change inside `execute()`, never a port or shape rewrite. The
mock nodes announce themselves where you can see it: each one's manifest
description opens with "Mock …", and that description is what the palette and the
inspector display.

### Known gaps in the repo itself

- **A few suites are still red**, in `ai-gateway`, `mcp-host` and `cli` — each
  a newly written test that found a genuine edge case the source does not
  handle yet, not a broken build. Run the suites package by package to see
  what is actually failing.
- One structural trap worth knowing before you go bug-hunting: `pnpm test` is
  `pnpm -r run test`, every package but `packages/app` declares
  `"test": "vitest run"`, and **Vitest exits non-zero when a package has no
  test files at all** — so a new package without a suite reds the whole
  command with nothing actually failing an assertion.
- No application icon.
- No 3D/IFC preview, no published release, and no auto-update wiring — see the
  status table above.

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

## Licence

**Apache-2.0** — see [`LICENSE`](LICENSE), with third-party attributions in
[`NOTICE`](NOTICE). The choice is deliberate rather than default: it stays
compatible in both directions with the dependency set this architecture wants
(LGPL tools kept out-of-process, MPL-2.0 web-ifc, MIT elsewhere), and it grants
patent rights explicitly, which matters for a tool aimed at professional
practice.
