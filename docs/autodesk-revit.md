# Autodesk and Revit

**The short answer: Archspace is an MCP client. It never runs Revit, never links
Revit code, and ships no Revit-side component.** What it can do with a Revit
model is exactly what some MCP server — Autodesk's, a community project's, or one
you write — can do, and *that* server runs on Windows beside a live Revit
session. On macOS you reach it over the network.

This page is the practical guide to what is real, what needs Windows, what is a
declared seam with no implementation behind it, and how to configure each thing
that works. The reasoning behind the split is in
[ADR-0001](adr/0001-platform-strategy.md) and
[ADR-0009](adr/0009-mcp-integration.md); the evidence is in
[`docs/research/ecosystem.md`](research/ecosystem.md).

Everything here mirrors [`packages/autodesk/src/capabilities.ts`](../packages/autodesk/src/capabilities.ts).
That table is the single source of truth — the Autodesk panel in Settings renders
from it, the MCP presets derive their availability from it, and the error you get
when you reach for an unimplemented capability is generated from it. There is no
second, friendlier version of these facts. If this page and that table disagree,
the table is right and this page is stale.

---

## 1. Two things to know before anything else

### Revit does not run on macOS

Autodesk publishes no macOS build of Revit. The official system requirements list
64-bit Windows only, and the installation help page's supported-virtualization
list — Citrix, VMware, and *Parallels Desktop for Mac* at "Recommended-level
configuration" — describes a **Windows guest on a Mac**, not a macOS build
(research §3).

Every integration path that touches a *live model session* therefore terminates
on a Windows machine: the Revit .NET API, pyRevit, Dynamo-for-Revit, Autodesk's
own Revit MCP server, and every community MCP server. There is no supported way
to run any of them natively on macOS, and no configuration of Archspace changes
that.

What is **not** bound by this: the MCP client, the Autodesk Platform Services
cloud APIs, and open-format work. Those are platform-neutral. The constraint
binds the Revit-session side, not the app.

### Several claims below could not be verified directly

`autodesk.com` — the marketing site, the AEC blog, and the support-article CDN —
returns HTTP 403 to automated retrieval. `help.autodesk.com`, `aps.autodesk.com`,
`modelcontextprotocol.io` and the GitHub API were fully accessible and are the
backbone of everything stated as fact (research, sourcing note).

That distinction is carried in the code, not just in prose: every claim in the
capability table is a `CapabilityEvidence` built by `cite()`, which takes
`directlyVerified` from the source catalogue in
[`packages/autodesk/src/sources.ts`](../packages/autodesk/src/sources.ts) rather
than from the caller. A claim cannot be promoted to "verified" at the point of
use. §7 lists every source and how it was reached.

The claims most affected: **the Revit 2027 MCP server's executable path and its
stdio transport.** Both come from search-result excerpts of an Autodesk support
article nobody could read. Treat the preset default as a starting guess to
confirm on the machine, not as documentation.

---

## 2. What is genuinely available

### From a Mac, today, with no Windows machine

**Autodesk Product Help MCP server** — Autodesk's remote documentation server:
search the help for 110+ products in 10 languages. Remote, needs no Revit and no
Windows, so it works from macOS as soon as you paste the endpoint. It is the only
official Autodesk MCP server in that position.

It searches documentation. It does not touch your models.

*You need:* the server's Streamable HTTP endpoint URL, from
[Autodesk MCP Server Help](https://help.autodesk.com/view/ADSKMCP/ENU/). We
cannot pre-fill it — the portal's per-server detail pages are rendered
client-side and returned 404 to the researcher's fetcher, so the endpoint was
never retrieved. Plus an Autodesk sign-in if the endpoint challenges; the MCP
host runs the OAuth 2.1 flow on a 401 by itself.

### From a Mac, through a Windows machine you run

**Remote Revit agent over Streamable HTTP** — the only way a macOS app touches a
live Revit session. Revit plus an MCP server runs on a Windows machine (a
workstation, an office box, a Parallels VM, a cloud VM) behind a bridge that
speaks MCP Streamable HTTP; Archspace connects as an ordinary authenticated MCP
client. **What you can do is whatever the server behind the bridge can do** — this
row is a transport, not a feature set.

*You need:* a Windows machine with Revit and a Revit MCP server; a bridge that
re-exposes that stdio server over Streamable HTTP (**Archspace does not ship
one** — see §3); real authentication and TLS on that endpoint; and someone who
owns that machine and its Revit licence.

### On Windows, beside a live session

These three are real and usable — on Windows. From macOS they are reachable only
through the remote agent above.

**Autodesk Revit 2027 MCP Server (Tech Preview)** — Autodesk's own server. Local,
Revit 2027 **only**, labelled Tech Preview (Public Beta), 7 tools per the portal.
The portal calls it "read-only access to Revit models"; the Revit 2027 What's New
page documents interrogating the model (searching elements, checking parameters
and counts), **batch editing parameters**, and capturing view snapshots. Those two
descriptions are in tension and the research could not resolve it from
retrievable official sources. **Plan for read-plus-export and no element
creation.** Autodesk (quoted via BIM Chapters) says no Revit modifications are
possible at the moment, with a write server described as future work.

Distributed as a separate add-on from your Autodesk Account under the Revit 2027
entitlement. Revit 2027 is an absolute requirement — it does not work with earlier
versions, which matters because the installed base is on 2023–2026.

**Autodesk AutoCAD and Civil 3D MCP Server** — official, local, and per the portal
able to query, analyze **and modify** objects in drawings. We gate it to Windows
because it must run beside a live desktop session; the research never established
which desktop platforms it supports, and retrieved neither an install path nor a
transport for it. Nothing about this preset is pre-filled.

**Community Revit MCP servers (MIT)** — these do what Autodesk's does not:
create, modify and delete elements, across Revit 2023–2027. Verified via the
GitHub API on 2026-08-24:

| Project | License | Status | Self-described coverage |
|---|---|---|---|
| [mcp-servers-for-revit](https://github.com/mcp-servers-for-revit/mcp-servers-for-revit) (the "Sparx fork") | MIT | Active, pushed 2026-04 | C#, ~138 tools incl. create/modify/delete |
| [LuDattilo/revit-mcp-server](https://github.com/LuDattilo/revit-mcp-server) | MIT | Active, pushed 2026-07 | C#, 80+ tools, Revit 2023–2026 |
| [Demolinator/revit-mcp-server](https://github.com/Demolinator/revit-mcp-server) | MIT | Active, pushed 2026-06 | Python via pyRevit, 48 tools, Revit 2024–2027 |
| [mcp-servers-for-revit/revit-mcp](https://github.com/mcp-servers-for-revit/revit-mcp) (the original) | MIT | **Archived 2026-02** | Historical reference only |

Tool counts and version coverage are each repository's own claim and were not
verified. Three things to weigh before depending on one: they execute arbitrary
LLM-driven model mutations with community-grade testing; none ships a signed
installer, so you build it yourself; and the ecosystem's flagship archived within
about a year and fragmented into forks, so budget for maintaining whatever you
adopt.

On licensing: all four are MIT. pyRevit, which the Demolinator server runs on, is
GPL-3.0 — that dependency lives on the Windows machine, and Archspace links none
of it.

---

## 3. What is a declared seam, not an implementation

Six of the eleven rows in the capability table are `not-implemented`. They exist
in code so that the shape of the missing work is named and so that reaching for
one fails loudly — with the capability id, the reason, and the repo path of the
empty seam — instead of returning a plausible-looking stub. A mock would be
indistinguishable from a working integration at every call site.

Every method on `createApsClient()` **throws `UnimplementedCapabilityError`
synchronously**. Nothing here is half-working; it is not working, on purpose.

| Capability | Seam |
|---|---|
| **Archspace Revit agent** (first-party Windows add-in + bridge) | [`packages/autodesk/src/presets.ts`](../packages/autodesk/src/presets.ts) — the `revit-agent` preset is the socket a first-party agent would plug into. It is a client-side template today; no server-side code exists anywhere in this repo. |
| **APS authentication** (2-legged / 3-legged / Secure Service Accounts) | [`packages/autodesk/src/aps.ts`](../packages/autodesk/src/aps.ts) — `createApsClient().authenticate()` |
| **APS Design Automation for Revit** | `packages/autodesk/src/aps.ts` — `createApsClient().startDesignAutomationWorkItem()` |
| **APS AEC Data Model API** | `packages/autodesk/src/aps.ts` — `createApsClient().queryAecDataModel()` |
| **APS Model Derivative API** | `packages/autodesk/src/aps.ts` — `createApsClient().translateModelDerivative()` |
| **APS Data Management API** | `packages/autodesk/src/aps.ts` — `createApsClient()` itself; no data-management method is even exposed yet |

What each of those *would* be, and why none of it ships:

- **Archspace Revit agent.** A Revit .NET add-in plus an MCP bridge, so that
  connecting a Mac to Revit is an install rather than a project. No add-in, no
  bridge process and no installer is built by any package here. ADR-0001 names
  the Windows agent as a separate, later deliverable. Until it exists you supply
  your own agent and Archspace is only the client. **Do not describe Archspace as
  "integrating with Revit" on the strength of this row.**
- **APS authentication.** No registered APS application, no client credentials, no
  token acquisition, no keychain slots for APS credentials. Every APS capability
  needs this first, and a decision about which of the three auth patterns fits a
  desktop app has not been made.
- **Design Automation for Revit.** Autodesk's cloud-hosted headless Revit: upload
  a DB-only AppBundle and a work item and Autodesk runs it against RVT files with
  full read and write, no Windows machine of your own. It is a .NET
  build-and-upload pipeline, not an HTTP call — Archspace ships no AppBundle, no
  work-item submission, no polling, no result retrieval. Documented restrictions
  if you ever build it: no Revit UI APIs, no `ActiveView`/`ActiveDocument`, disk
  writes confined to the job working directory, no Navisworks export, no Desktop
  Connector. Batch and asynchronous — minutes per work item, not interactive
  editing. Consumption-priced; the research did not verify current pricing.
- **AEC Data Model API.** GraphQL read access to granular element and property
  data for models hosted in Autodesk Construction Cloud or Autodesk Docs — no
  Revit, no Windows, no download. The most plausible first real APS capability
  precisely because it is read-only and platform-neutral. Plausible is not
  shipped: no GraphQL client, no schema, no query nodes.
- **Model Derivative API.** Cloud translation of RVT/DWG and friends into
  viewables and extractable metadata. Read and translate only. No job submission,
  no manifest polling, no derivative download — and Archspace has no viewer to
  consume SVF output, so it would be half a feature even if the calls existed.
- **Data Management API.** Hubs, projects, folders and versions: the plumbing
  that finds a model in ACC/Docs before any other APS capability can act on it.
  Without it there is no way to name the model the others would operate on.

### There are no `autodesk.*` nodes, and that is deliberate

[`packages/autodesk/src/nodes.ts`](../packages/autodesk/src/nodes.ts) exports a
function that always returns an empty array. Everything Autodesk that actually
works arrives as MCP tools, and the MCP host generates one node per tool of a
connected server (ARCHITECTURE §9.3). Everything that does not work must not be
reachable from the canvas at all: an `autodesk.*` node whose `execute()` threw
would still appear in the palette, be wired into a workflow and be saved into a
document — a seam masquerading as a feature.

---

## 4. Configuring a preset

Presets are **templates for `mcp.yaml`, not connections.** A preset produces a
real server config with the machine-specific parts left as declared
placeholders. Nothing is enabled by default, because a preset with an unfilled
placeholder would otherwise fail obscurely at first demand.

### 4.1 Where the file is, and the shape it takes

`mcp.yaml` lives in the app's user-data directory — on macOS,
`~/Library/Application Support/Archspace/mcp.yaml`. It is machine-local and
hand-editable, and it is never committed with a workflow: a workflow says
`mcp.revit.get_elements`, and only this file says what `revit` is. That split is
what keeps workflows shareable and stops a cloned repository from making your
machine execute a command (ADR-0009).

**One gotcha.** The presets API describes placeholder locations with paths like
`binding.url` and `binding.command.0`. Those are paths into the *in-memory*
`McpServerConfig`, where the discriminated union is nested. In the YAML file the
binding is written **flat** — `transport`, `url`, `command` are siblings of
`enabled`, because that is what a human hand-editing the file expects. Write the
flat form:

```yaml
servers:
  revit:
    transport: http           # not: binding: { transport: ... }
    url: https://…
    enabled: true
```

Fields you can set on any server, from
[`packages/mcp-host/src/config.ts`](../packages/mcp-host/src/config.ts):

| Field | Applies to | Notes |
|---|---|---|
| `transport` | all | `stdio` or `http` (`http` means MCP Streamable HTTP) |
| `command` | stdio | argv array; `command[0]` is the executable. Non-empty, all strings |
| `env` | stdio | string→string map, passed to the child |
| `cwd` | stdio | working directory for the child |
| `url` | http | must parse, and must be `http:` or `https:`. Plain `http:` to anything but loopback logs a warning — credentials and tool arguments would travel unencrypted |
| `auth` | http | `none`, `oauth`, or `bearer`. Anything else is an error and the server is dropped |
| `bearerTokenRef` | http | the **key** of a secret, never the token. Required when `auth: bearer`, or the host refuses the connection |
| `headers` | http | string→string map of extra request headers |
| `enabled` | all | **absent means enabled** — a user who wrote a binding meant to use it. Presets ship `enabled: false`, so you must flip it |
| `description` | all | free text, shown in the server list |
| `timeoutMs` | all | per-request timeout; default 60000 |
| `concurrency` | all | lane cap for `mcp:<name>`; default 1 (serial per server) |
| `trustReadOnlyHint` | all | opt in to caching a tool's results based on its advisory `readOnlyHint`. Off by default; MCP calls are cached `never` because the spec says the hint is untrusted |

Logical server names must match `[a-z][a-z0-9_]*` — they are workflow-visible
identifiers. Parsing is tolerant: one malformed server is dropped with a reported
issue rather than costing you every other binding.

### 4.2 The `<replace me>` sentinel

Any string in a preset config containing `<replace me>` is a value we could not
know. It is deliberately ugly so a half-filled preset looks wrong at a glance,
and every occurrence has a matching entry in the preset's `placeholders` list
with a label and a hint explaining what belongs there.

**A `<replace me>` left in place is not a default — it is an unanswered
question.** Replace every one before setting `enabled: true`.

### 4.3 Preset by preset

Below, `logical name` is the suggested key under `servers:` and what workflows
will say (`mcp.<name>.<tool>`). You can rename it; nothing depends on our
suggestion.

---

#### Autodesk Product Help (official, remote) — `autodesk_help`

Available on every platform. One placeholder.

```yaml
servers:
  autodesk_help:
    transport: http
    url: <replace me>
    auth: oauth
    enabled: false
    description: Autodesk Product Help MCP (official, remote, documentation search only)
    timeoutMs: 60000
    concurrency: 1
```

- **`url`** — the Streamable HTTP endpoint, copied from
  [Autodesk MCP Server Help](https://help.autodesk.com/view/ADSKMCP/ENU/). The
  per-server page is rendered client-side and the research could not read it, so
  there is nothing to pre-fill.
- **`auth`** — left as `oauth` on purpose. If the endpoint turns out to be open,
  the host simply never runs the flow; if it challenges with a 401, the
  RFC 9728 discovery path handles it. Either way this value is safe.
- Set `enabled: true` once the URL is real.

---

#### Remote Revit agent (Streamable HTTP) — `revit`

**This is the macOS answer to Revit.** A pure network client, so it is available
on every platform. One placeholder.

```yaml
servers:
  revit:
    transport: http
    url: <replace me>
    auth: oauth
    enabled: false
    description: Windows machine running Revit plus an MCP bridge (see docs/autodesk-revit.md)
    timeoutMs: 60000
    concurrency: 1
```

- **`url`** — your bridge's MCP endpoint, e.g.
  `https://revit-agent.office.example:8443/mcp`. Use TLS and real
  authentication. The MCP spec expects local servers to bind loopback and
  validate `Origin` precisely because an open port is a DNS-rebinding target; a
  bridge you have deliberately exposed to the network has taken that protection
  off and must replace it with something.
- **`auth`** — `oauth` if your bridge implements the MCP authorization spec. If
  it uses a static token instead, set `auth: bearer` and add
  `bearerTokenRef: <your-secret-key>` naming a secret you added in
  **Settings → Secrets**. **Never paste a token into this file** — secrets are
  stored by key here and the value lives in the OS keychain.
- Archspace does not ship the agent. Point this at one you run: an official Revit
  2027 server or a community server, behind a bridge that re-exposes stdio over
  Streamable HTTP.
- Raise `concurrency` only if your bridge is genuinely concurrent. Revit is not.

---

#### Autodesk Revit 2027 MCP Server (official, Tech Preview) — `revit_2027`

Windows only. Launched over stdio beside a live Revit 2027 session.

```yaml
servers:
  revit_2027:
    transport: stdio
    command:
      - C:\Program Files\Autodesk\Revit 2027 MCP Server Technical Preview\RevitMCPServer.exe
    enabled: false
    description: Autodesk Revit 2027 MCP Server (Tech Preview) — read/export, requires a live Revit 2027 session
    timeoutMs: 60000
    concurrency: 1
```

- **`command[0]`** — **confirm this path on the machine.** It comes from
  search-result excerpts of an Autodesk support article that returned 403, and a
  third-party blog claims a localhost HTTP bridge on port 3000 instead, which
  contradicts the stdio description. If the executable is not there, check the
  add-on installation before assuming stdio at all — if it turns out to be HTTP,
  change `transport` rather than forcing a command.
- The server needs a signed-in, open Revit 2027 session; it talks to the running
  application. No official documentation of a separate authentication requirement
  was retrievable — as a local stdio server tied to a licensed session, auth is
  presumed implicit in the Autodesk sign-in. Explicitly unverified.
- **From macOS this preset is unavailable and the host will refuse it** (§5).
  Run it on the Windows machine and reach it through `revit`.

---

#### Autodesk AutoCAD and Civil 3D MCP Server (official) — `autocad`

Windows only. **Every part of this command is a placeholder.**

```yaml
servers:
  autocad:
    transport: stdio
    command:
      - C:\Program Files\Autodesk\<replace me>\<replace me>.exe
    enabled: false
    description: Autodesk AutoCAD and Civil 3D MCP Server — writes to drawings; path and transport unconfirmed
    timeoutMs: 60000
    concurrency: 1
```

- **`command[0]`** — unknown to us. The Autodesk MCP portal names this server but
  its detail page could not be retrieved, so neither the install path nor the
  transport is documented here. Get the real one from Autodesk MCP Server Help.
  If it turns out to be HTTP rather than stdio, change the binding instead of
  forcing a command.
- This server **modifies drawing objects**. Enabling it is a deliberate decision
  about write access, not a convenience.

---

#### Community servers — `revit_sparx`, `revit_ludattilo`, `revit_pyrevit`

Windows only, MIT, **write-capable**. All three have the same shape: one
placeholder for a bridge you built yourself, because none of them ships a signed
installer.

```yaml
servers:
  revit_sparx:
    transport: stdio
    command:
      - C:\<replace me>\RevitMcpBridge.exe
    enabled: false
    description: mcp-servers-for-revit (community, MIT) — can create, modify and delete elements
    timeoutMs: 60000
    concurrency: 1
```

The default `command[0]` per preset, and where the code comes from:

| Logical name | Default command | Built from |
|---|---|---|
| `revit_sparx` | `C:\<replace me>\RevitMcpBridge.exe` | [mcp-servers-for-revit](https://github.com/mcp-servers-for-revit/mcp-servers-for-revit) |
| `revit_ludattilo` | `C:\<replace me>\RevitMcpServer.exe` | [LuDattilo/revit-mcp-server](https://github.com/LuDattilo/revit-mcp-server) |
| `revit_pyrevit` | `C:\<replace me>\revit-mcp-server.exe` | [Demolinator/revit-mcp-server](https://github.com/Demolinator/revit-mcp-server) |

- **`command[0]`** — the path is yours; there is no install location to guess.
  For the pyRevit-based server, "however you launch it" may be a Python
  interpreter plus a script — those are **separate argv entries**, not one string
  with a space in it.
- `revit_ludattilo` is the option that covers Revit 2023–2026, i.e. the versions
  firms actually run, since Autodesk's official server is 2027-only.
- From macOS: run these on the Windows machine and connect through the
  `revit` preset instead.

---

#### revit-mcp (ARCHIVED) — `revit_mcp_archived`

Listed so that finding it in a search result is not the first you hear of its
status. It is **permanently unavailable as a preset, on every platform** — a hard
block, not a platform gate:

> Archived 2026-02 and unmaintained. Use mcp-servers-for-revit (the successor
> fork) or one of the other MIT community servers instead.

---

## 5. What happens when you configure a Windows server on a Mac

Archspace installs a platform gate on the MCP host
(`mcpSupportCheck`, in [`presets.ts`](../packages/autodesk/src/presets.ts)). It
runs over whatever you actually wrote in `mcp.yaml` — preset-derived or not — and
reports the server as `unsupported` with a real reason instead of letting it fail
as a confusing spawn error.

It refuses a stdio server only when the command could not run on this host at
all: a `.exe`/`.bat`/`.cmd`/`.ps1` executable, a drive-letter path, or one of the
named Autodesk Windows servers. You get a message naming the server, the
executable, this machine's platform, why Revit and AutoCAD are Windows-bound, and
what to do instead.

**HTTP bindings always pass.** Reaching a Windows machine over the network is the
entire point of the remote-agent story, and refusing it here would break the one
Revit path macOS has.

Genuinely portable stdio servers are left alone — `uvx archspace-formats-server`,
`npx -y @modelcontextprotocol/server-everything`, `/opt/homebrew/bin/ifc-mcp`
and the like all run normally on a Mac.

---

## 6. Choosing an approach

From research §3, with the tradeoffs it records:

| If you… | Use | Cost |
|---|---|---|
| Need interactive access to a live Revit model from a Mac | A Windows machine + MCP server + bridge, via the `revit` preset | You own that machine, its Revit licence, and the bridge's security |
| Are a single user willing to run Windows locally | Parallels Desktop on the same Mac (Autodesk blesses it at recommended-level configuration), then the same bridge | Windows + Parallels + Revit licences, performance overhead. Fine for one power user; a poor primary story for a product |
| Have models already in Autodesk Construction Cloud / Docs | The APS cloud tier — AEC Data Model for reads, Design Automation for batch writes | **Not implemented in Archspace** (§3). Also: asynchronous, consumption-priced, excludes users without ACC |
| Just need data out of Revit occasionally | Revit's own IFC/DXF export, and work on the open formats | Interoperability, not integration. IFC round-tripping out of Revit is lossy — Revit's IFC import creates new elements rather than updating existing ones |

The last row is the honest baseline tier and is insufficient as a headline "Revit
integration"; the first is the only option that gives a macOS app interactive
access to a live session.

---

## 7. Sources

Every URL this package is allowed to cite, with how the research reached it.
This is the catalogue in
[`packages/autodesk/src/sources.ts`](../packages/autodesk/src/sources.ts);
upgrading a "not retrieved" to "retrieved" requires new research, not a better
mood.

**Retrieved directly (2026-08-24):**

| Source | Notes |
|---|---|
| [Autodesk MCP Server Help portal](https://help.autodesk.com/view/ADSKMCP/ENU/) | Index only. Per-server detail pages are client-side rendered and returned 404, so no tool-by-tool list came from here |
| [Revit 2027 What's New — Revit Public MCP Server](https://help.autodesk.com/cloudhelp/2027/ENU/Revit-WhatsNew/files/GUID-97697CBF-0E11-484E-96E5-4277E3E8D61F.htm) | |
| [Revit installation help — virtualization](https://help.autodesk.com/cloudhelp/2026/ENU/Revit-Installation/files/GUID-2EF1661C-5A8D-41AC-A28F-9678DDF545CA.htm) | The Parallels "Recommended-level configuration" claim |
| [APS blog — Building Custom MCP Servers](https://aps.autodesk.com/blog/building-custom-mcp-servers-autodesk-platform-services) | Fully retrieved. The three APS auth patterns |
| [Revit API overview](https://aps.autodesk.com/developer/overview/revit-api) | Confirms the .NET add-in model; little further detail |
| [MCP spec 2025-11-25 — transports](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports) | Fully retrieved |
| [MCP spec 2025-11-25 — authorization](https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization) | Fully retrieved |
| [BIM Chapters — Revit MCP public server](https://bimchapters.blogspot.com/2026/04/revit-mcp-public-server-tech-preview.html) | **Secondary source** — an independent blog (Steve Stafford), not Autodesk |
| The four GitHub repos in §2 | Licenses, archive status and last-push dates read from the GitHub API. **Tool counts and version coverage are each repo's own self-description and were not verified** |

**Not retrieved directly:**

| Source | Why, and what rests on it |
|---|---|
| [Autodesk AEC blog — Revit Public MCP Server](https://www.autodesk.com/blogs/aec/2026/06/17/revit-public-mcp-server/) | HTTP 403 (Akamai). The URL and the 2026-06-17 announcement date come from search results; the page was never read |
| [Support article — Usage of Revit 2027 MCP Server](https://www.autodesk.com/support/technical/article/caas/sfdcarticles/sfdcarticles/Usage-of-Revit-2027-MCP-Server.html) | HTTP 403. **The server executable path, the stdio transport and the Claude Desktop/Cursor auto-configuration all come from search-result excerpts of this article** |
| [Revit system requirements](https://www.autodesk.com/support/technical/article/caas/sfdcarticles/sfdcarticles/System-requirements-for-Revit-2025-products.html) | HTTP 403; corroborated only by search excerpts |
| [APS AEC Data Model API](https://aps.autodesk.com/autodesk-aec-data-model-api) | Named as the product page; no direct retrieval recorded |
| [APS Design Automation developer guide](https://aps.autodesk.com/en/docs/design-automation/v3/developers_guide/) | Reached through search results |
| [APS Design Automation restrictions](https://aps.autodesk.com/en/docs/design-automation/v3/developers_guide/restrictions) | Known only through a search-result excerpt of the official docs |
| [APS Secure Service Accounts guide](https://aps.autodesk.com/en/docs/ssa/v1/developers_guide/overview/) | Linked from the APS MCP blog post; no direct retrieval recorded |
| [APS developer portal](https://aps.autodesk.com/) | Used where the research names an API without citing a specific page — Model Derivative and Data Management. An entry point to find the real documentation, **not evidence for any detail** |
