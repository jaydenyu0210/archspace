# Archspace

**Node-based workflows for architecture and construction work.**

Wire up a graph on a canvas — write a brief, generate a scheme, check it against
code, produce a report — then press Run. Workflows save as plain text that reads
well in a git diff, so a workflow is something a colleague can review in a pull
request rather than a file locked inside an application.

It is aimed at people who already automate AEC work in Dynamo, Grasshopper or
pyRevit and want AI calls, external tools and file operations in the *same*
graph, under version control.

> **This is an early preview (v0.1.0).** Several of the design nodes are
> realistic mocks rather than real engines — see
> [What's real and what isn't](#whats-real-and-what-isnt). Please read that
> before judging it.

---

## Download

### Windows

**[Download the installer](https://github.com/jaydenyu0210/archspace/releases/latest)**
— works on both Intel/AMD and ARM PCs. It does not need administrator rights.

This build is **not code-signed**, so Windows will object. Which box you get
matters, because only one of them has a way through:

| What you see | What to do |
|---|---|
| **"Windows protected your PC"** (blue box, SmartScreen) | **More info → Run anyway.** Expected, and the normal case. |
| **"Smart App Control blocked an app that may be unsafe"** | There is no "run anyway". See below. |

**If Smart App Control blocked it**, no click gets you past it. Smart App
Control is a Windows 11 feature that refuses apps it cannot attribute to a known
publisher, and unlike SmartScreen it offers no override — signing is the only
thing that satisfies it, and this build is not signed. Your options:

1. **Run it from source instead** (recommended — see
   [For developers](#for-developers)). You launch Electron's own signed binary,
   so Smart App Control has no reason to intervene. You get the same app.
2. **Turn Smart App Control off** — Windows Security → *App & browser control* →
   *Smart App Control settings* → *Off*. Know the cost first: **this cannot be
   undone without reinstalling Windows**, and it lowers protection for every app
   on the machine, not just this one. Do not do it casually to try an alpha.
3. **Wait for a signed build.** Tracked in
   [ADR-0014](docs/adr/0014-windows-packaging.md); it needs a code-signing
   certificate this project does not have yet.

*Nobody has run this on Windows yet.* It builds and every file is verifiably in
the right place, but you may be the first person to launch it. Please
[open an issue](https://github.com/jaydenyu0210/archspace/issues) with whatever
happens.

### macOS

Not yet. The app builds and runs on macOS, but a download needs Apple signing
and notarisation or macOS refuses to open it. Until that is set up,
[build it from source](#for-developers).

---

## Your first five minutes

1. **Open it.** Archspace starts with an example already loaded —
   *Concept compliance check*, six connected nodes.
2. **Press ▶ Run.** It will refuse. One node comes from a plugin that ships with
   the app but has not been enabled yet — and it tells you exactly that, and
   where to fix it.
3. **Enable the plugin.** Menu → **Archspace → Plugins…**, read what it asks
   for, click **Grant consent & enable**. Plugins run in their own process and
   only get what they declare, so you are asked before anything loads.
4. **Press ▶ Run again.** About five seconds. Watch each node report progress in
   the log at the bottom, then click a node to see what it produced. Click
   *Generate Floor Plan* and the plan is **drawn** — rooms, walls at their real
   thickness, doors and exits. Drag the bar above the panel to make it bigger.
5. **Save something.** Click the *Export Floor Plan to DXF* node and press
   **Save…** in the panel at the bottom right. That is a real CAD drawing —
   open it in AutoCAD, LibreCAD, QCAD, or any online DXF viewer.

From there: drag a node from the palette on the left onto the canvas, drag from
one node's output dot to another's input to wire them, and edit settings in the
panel on the right. Every node's form is generated from the node itself, so a
plugin you install tomorrow gets a proper editor for free.

Two more examples are already in your workflows folder:

| Example | What it shows |
|---|---|
| `branching-review` | One design, five reviews running at once, merged into a single result |
| `review-fix-report` | Review → fix the problems → review again → compare the two |

---

## What's real and what isn't

Being straight about this matters more than looking finished.

**Real, and doing what it says:**

- The workflow format, the canvas, and the execution engine
- The plugin system, the MCP client, and the AI nodes — the AI nodes call real
  providers (Anthropic, Ollama, or any OpenAI-compatible endpoint) once you add
  a model profile in Settings
- The rule-based nodes: briefs, space programs, parking estimates, room
  schedules, adjacency, CSV export — plain calculations over your actual inputs

**Realistic mocks, not real engines:**

- Floor-plan, massing, structural-grid and BIM generation
- The five review disciplines (code, accessibility, zoning, structural, energy)

They produce structured, repeatable, plausible output with no network and no
model behind them, and each says "Mock …" in its own description. What *is* real
about them is the shape of what they return: a genuine backend can be
substituted later without redesigning a single workflow.

**Files it can produce:**

- **DXF** (`export_dxf`) — a real 2D CAD drawing you can open in AutoCAD,
  LibreCAD, QCAD or any DXF viewer: rooms, walls at their true thickness, doors,
  exits and labels, on properly named layers, one set per storey. This is the
  one output with actual drawable geometry.
- **IFC** (`generate_bim_model`) — a real IFC4 file with a correct spatial
  hierarchy of storeys, spaces, walls and doors, and 3D geometry for every one
  of them. It opens in an IFC viewer as a building you can walk through. Doors
  are solids standing at their position rather than openings cut into walls, and
  there are no floor slabs — the floor plan simply does not say which wall a
  door belongs to, or where the floor plate ends.
- **CSV** (`export_table_csv`) — ordinary RFC 4180.
- **No DWG.** DXF is the interchange format; DWG is proprietary.

**Not implemented at all:** Revit and Autodesk. The app shows a full matrix of
what exists and what is an unbuilt seam, with reasons, under
**Archspace → Autodesk & Revit…**

The exhaustive version of all of this is in
**[docs/STATUS.md](docs/STATUS.md)**.

---

## How it works, briefly

A workflow is a **directed graph**, not a script.

- **Nodes** declare their inputs, outputs and settings. The app generates the
  editing form from that declaration.
- **Wires carry typed values** — text, numbers, tables, JSON, file references.
  Mismatched types will not connect, so a broken graph is visible before it runs.
- **Only what is needed runs.** Ask for one node's output and the engine works
  backwards, skips anything already up to date, and runs independent branches at
  the same time.
- **One failure does not sink the run.** Independent branches still succeed; only
  what depended on the failure is skipped.
- **The file is the truth.** Saving edits the YAML in place, so your comments and
  ordering survive. Node positions live in their own block at the bottom, so
  nudging a node on the canvas does not produce a noisy diff.

---

## Extending it

Three ways in, for three different people.

**Plugins — if you write TypeScript.** A folder with a manifest and an entry
file. Each plugin runs in its own OS process, declares the permissions it needs,
and cannot load until you consent. A crashing plugin fails one node, not the
app. Worth knowing the stated limit: this is fault isolation and permission
mediation, **not a hardened security sandbox**.
→ [ADR-0008](docs/adr/0008-plugin-boundary.md), with
[`plugins/aec-review/`](plugins/aec-review) as a working example.

**MCP servers — if you write anything else.** Python, C#, Rust, Go: ship an
[MCP](https://modelcontextprotocol.io) server and every tool it offers becomes a
node automatically. Workflows refer to servers by a nickname you choose, and
what that nickname points at lives in your own settings — so sharing a workflow
never makes someone else's machine run your commands.
→ [ADR-0009](docs/adr/0009-mcp-integration.md).

**AI providers — no provider is special.** Nodes ask for a *model profile* you
named (`default`, `fast`), never a vendor. A colleague's workflow runs unchanged
against your provider. Anthropic, Ollama (local, no key, nothing leaves your
machine), and any OpenAI-compatible endpoint work today.
→ [ADR-0010](docs/adr/0010-ai-provider-abstraction.md).

---

## For developers

Needs [Node](https://nodejs.org) (version in `.nvmrc`) and
[pnpm](https://pnpm.io).

```sh
git clone https://github.com/jaydenyu0210/archspace.git
cd archspace
pnpm install
pnpm dev      # run the app
pnpm test     # 1104 tests across 12 packages
```

This is also the way to run it on a Windows machine with Smart App Control on:
`pnpm dev` launches Electron's own signed binary rather than an unsigned
installer, so nothing is blocked. The app is identical.

Run a workflow with no UI — a real feature, not a test harness:

```sh
pnpm cli run packages/app/resources/concept-compliance.archspace.yaml \
  --trust-plugin aec-review --out ./artifacts
```

`--out` writes every file the run produced (the DXF drawing, the IFC model)
into that directory.

Package it:

```sh
pnpm dist        # macOS .dmg + .zip
pnpm dist:win    # Windows installer + zips
```

**[CONTRIBUTING.md](CONTRIBUTING.md)** has the rest: the six commands CI runs,
the house rules, and the traps worth knowing before you lose an afternoon to
one. Design decisions live in [docs/adr/](docs/adr/) — the reasoning, and what
was rejected, is written down.

---

## Licence

Apache-2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE).
