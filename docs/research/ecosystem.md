# AEC Integration Ecosystem — Research Findings

Date of research: 2026-08-24. All "accessed" dates are 2026-08-24 unless noted.

**Sourcing note.** `autodesk.com` (the marketing site, the AEC blog, and the support-article CDN) blocks automated retrieval (HTTP 403 via Akamai). Where a claim rests on a page I could not fully retrieve, or on a secondary source, that is stated explicitly at the claim. `help.autodesk.com`, `aps.autodesk.com`, `modelcontextprotocol.io`, and the GitHub API were fully accessible and are the backbone of the verified claims.

**A note on "the product brief."** No product brief file exists in this repository (the working directory was empty at the start of this session). Section 7 is written against the requirements restated in the research request — macOS as primary platform, Revit integration as a major requirement, open-source desktop app — plus assumptions those requirements typically imply.

---

## 1. Autodesk MCP

### Does Autodesk publish official MCP servers? Yes — five of them.

Autodesk operates a dedicated documentation portal, **Autodesk MCP Server Help** (https://help.autodesk.com/view/ADSKMCP/ENU/, accessed 2026-08-24), which lists five official MCP servers:

| Server | Products | Local or cloud | Notes from the portal |
|---|---|---|---|
| Autodesk Product Help MCP | 110+ products' documentation, 10 languages | Remote | Documentation search only |
| Autodesk Fusion MCP | Fusion (live desktop session) | Local | Automation of a running Fusion session |
| Autodesk Fusion Data MCP | Fusion cloud data | Remote | Collaboration / project management |
| **Autodesk Revit 2027 MCP Server** | Revit 2027 | **Local** | **"Tech Preview (Public Beta)", "read-only access to Revit models", 7 tools** |
| Autodesk AutoCAD and Civil 3D MCP Server | AutoCAD, Civil 3D | Local | Query, analyze, **and modify** objects in drawings |

The per-server detail pages on that portal are rendered client-side and returned 404s to my fetcher, so tool-by-tool listings below come from other official pages and from secondary sources, marked accordingly.

### The Revit Public MCP Server (Tech Preview), in detail

- **What it is.** Autodesk's official, supported MCP server for Revit, announced on the Autodesk AEC blog on 2026-06-17 ("Introducing the Revit Public MCP Server", https://www.autodesk.com/blogs/aec/2026/06/17/revit-public-mcp-server/ — **URL confirmed via search results; page itself returned 403 and could not be read directly**).
- **Version coverage: Revit 2027 only.** Confirmed by the official portal (link above) and by the Revit 2027 What's New page, "Revit Public MCP Server (Tech Preview)" (https://help.autodesk.com/cloudhelp/2027/ENU/Revit-WhatsNew/files/GUID-97697CBF-0E11-484E-96E5-4277E3E8D61F.htm, accessed 2026-08-24). The secondary source BIM Chapters (Steve Stafford, 2026-04, https://bimchapters.blogspot.com/2026/04/revit-mcp-public-server-tech-preview.html) states this is "an absolute requirement; the tool does not work with earlier versions."
- **Local, not cloud.** The official portal labels it "Local." It runs alongside a live Revit 2027 session on the user's machine — which means **Windows only**, since Revit 2027 is a Windows application (see §3).
- **Distribution.** Installed as a separate add-on downloaded from the user's Autodesk Account under their Revit 2027 entitlements (BIM Chapters, secondary source; the official support article "Usage of Revit 2027 MCP Server", https://www.autodesk.com/support/technical/article/caas/sfdcarticles/sfdcarticles/Usage-of-Revit-2027-MCP-Server.html, returned 403 — search-result excerpts of it report a server executable at `C:\Program Files\Autodesk\Revit 2027 MCP Server Technical Preview\RevitMCPServer.exe` and automatic configuration of Claude Desktop / Cursor. **I could not read that article directly; treat the path and auto-config claims as unverified.**)
- **Transport.** Search excerpts of the official support article say it communicates over **stdio** and works with any MCP-spec-compliant client. **Not directly verified.** A third-party blog claims a localhost HTTP bridge on port 3000; I found no official confirmation of that and it contradicts the stdio description — do not design against either detail until confirmed on a Windows machine with the actual add-on.
- **Authentication.** No official documentation of an authentication requirement was retrievable. As a local stdio server tied to a licensed, signed-in Revit session, authentication is implicit in the Autodesk sign-in and desktop session. **Explicitly unverified.**
- **Tools.** The official What's New page (link above) says the feature lets you "interrogate and report on your model, such as searching for elements, checking parameters and counts," "batch editing parameters," and "capturing visual snapshots of views," used from within **Autodesk Assistant** as well as external MCP clients. Search excerpts of the official support article describe a "Query Model" tool (multi-criteria filtering: category, family name, element name, level, bounding box, parameter values with equals/contains/starts-with operators) and export tools (views to PNG/JPG/BMP/TIFF, sheets to PDF, schedules to CSV). The portal counts **7 tools**; I could not retrieve the authoritative per-tool list.
- **Read-only — with one documented tension.** The portal and the announcement (via BIM Chapters, quoting Autodesk's Harlan Brumm) describe it as read-only: "no Revit modifications are possible at the moment," with a dedicated **write server** described as planned future work. The What's New page's mention of "batch editing parameters" contradicts a strict read-only description. **I could not resolve this from retrievable official sources.** The safe planning assumption: read-plus-export today, no element creation/modification, write capability on Autodesk's roadmap but unshipped.
- **Documented limitations.** Tech Preview status (use with caution, outputs need human verification); Revit 2027 only; local session required; read-only (per above).

### APS-based MCP servers (the other official track)

For cloud data (Autodesk Construction Cloud, Autodesk Docs), Autodesk publishes **reference MCP server implementations** on Autodesk Platform Services rather than a hosted server, documented in the official APS blog post "Building Custom MCP Servers with Autodesk Platform Services" (https://aps.autodesk.com/blog/building-custom-mcp-servers-autodesk-platform-services, accessed 2026-08-24, fully retrieved):

- **JavaScript**: [aps-mcp-app-example](https://github.com/autodesk-platform-services/aps-mcp-app-example) — Streamable HTTP transport, Secure Service Account (SSA) auth, APS Viewer integration.
- **.NET**: [aps-aecdm-mcp-dotnet](https://github.com/autodesk-platform-services/aps-aecdm-mcp-dotnet) — stdio transport, AEC Data Model API access.
- **Python**: [aps-mcp-server-python](https://github.com/autodesk-platform-services/aps-mcp-server-python) — demonstrates all three APS auth patterns.

These wrap the Object Storage Service, Data Management API, and AEC Data Model API. Auth is APS OAuth: **2-legged** (app-owned resources), **Secure Service Accounts** (server-to-server JWT assertions; guide at https://aps.autodesk.com/en/docs/ssa/v1/developers_guide/overview/), and **3-legged** (user-delegated authorization code flow). Autodesk also publishes an **MCP publisher guide** for its marketplace (https://aps.autodesk.com/marketplace/mcp-publisher-guide — listed in search results; not retrieved).

Also relevant: [autodesk-platform-services/aps-mcp-server-nodejs](https://github.com/autodesk-platform-services/aps-mcp-server-nodejs) (Node.js, SSA-based fine-grained access control).

---

## 2. Revit programmatic access — the realistic options

### 2.1 Revit .NET API (add-in model)

- **What it is.** The native extensibility model: .NET assemblies loaded in-process by Revit. Official overview: https://aps.autodesk.com/developer/overview/revit-api (accessed 2026-08-24; the page confirms ".NET API" and "automate repetitive tasks and extend core software functionality" but carries little detail — the full API docs live in the Revit SDK and https://www.revitapidocs.com/ [community-hosted, unofficial]).
- **Read/write:** Full read and write — the complete model, parameters, geometry, families, views, transactions. This is the superset every other option is built on.
- **Needs Revit running locally:** Yes, in-process.
- **Windows required:** Yes (Revit is Windows-only; §3).
- **Licensing:** The API ships with Revit; developing and distributing add-ins requires each end user to hold a Revit license. **I could not retrieve the specific EULA/terms governing add-in distribution from an official source in this session** — verify against the Autodesk developer terms before shipping anything.

### 2.2 pyRevit

- **What it is.** A Rapid Application Development environment scripting the Revit API from Python (IronPython/CPython). Repo: https://github.com/pyrevitlabs/pyRevit; docs: https://docs.pyrevitlabs.io/ (accessed 2026-08-24).
- **License:** **GPL-3.0** (GitHub API, accessed 2026-08-24). Actively maintained (last push 2026-08-24).
- **Read/write:** Everything the Revit API can do.
- **Needs Revit running locally / Windows:** Yes and yes.
- **Licensing implication:** GPL-3.0 matters if you distribute code that links against pyRevit; scripts run *by* users inside their pyRevit install are a different situation. Flag for legal review if pyRevit becomes a distribution dependency.

### 2.3 Dynamo

- **What it is.** Visual programming environment; Dynamo for Revit ships with Revit. Repo: https://github.com/DynamoDS/Dynamo (accessed 2026-08-24).
- **License:** **Apache-2.0** (GitHub API). Actively maintained.
- **Read/write:** Read and write via Revit nodes when hosted in Revit. The standalone "Dynamo Sandbox" has no Revit access.
- **Needs Revit running locally / Windows:** For Revit work, yes and yes.
- **Fit:** An end-user automation tool, not an integration surface for an external app. Realistically out of scope as a programmatic channel.

### 2.4 Design Automation for Revit (APS "Automation API")

- **What it is.** Autodesk's cloud-hosted headless Revit engine: upload an add-in ("AppBundle") and a work item; Autodesk runs it against RVT files in the cloud. Official docs: https://aps.autodesk.com/en/docs/design-automation/v3/developers_guide/ and product page https://aps.autodesk.com/apis-and-services/revit-automation-api (accessed 2026-08-24 via search; overview page https://aps.autodesk.com/developer/overview/automation-api).
- **Read/write:** Full DB-level read and write of RVT files — parameter changes, geometry, family creation, data extraction, sheet/document generation.
- **Needs Revit running locally:** **No.** Needs no local Revit and no Windows machine — it is driven entirely over REST.
- **Documented restrictions** (official page: https://aps.autodesk.com/en/docs/design-automation/v3/developers_guide/restrictions, accessed 2026-08-24 via search result excerpt of the official docs):
  - No access to Revit UI APIs — the AppBundle must be a **DB-only application** (no `RevitUI` namespace).
  - No `ActiveView` / `ActiveDocument`.
  - Disk writes restricted to the job's working directory.
  - No Navisworks export; no Desktop Connector.
- **Model:** Batch, asynchronous jobs — not interactive editing of an open session. Latency is minutes per work item, not milliseconds.
- **Licensing/cost:** Consumption-based via APS (token/credit pricing). **I did not verify current pricing in this session** — see https://aps.autodesk.com/pricing before committing to it architecturally.

### 2.5 Autodesk Platform Services data APIs (no Revit engine at all)

- **AEC Data Model API** (https://aps.autodesk.com/autodesk-aec-data-model-api) — GraphQL read access to granular element/property data of models hosted in Autodesk Construction Cloud / Autodesk Docs, without opening Revit. **Read-oriented**; requires the model to live in Autodesk's cloud; APS OAuth (2LO/3LO/SSA).
- **Model Derivative API** — cloud translation of RVT/DWG/etc. into viewables and extractable metadata (SVF/derivatives). Read/translate only.
- **Data Management API** — hubs/projects/folders/versions plumbing.
- None of these need Revit installed or Windows; all are platform-neutral REST/GraphQL. All require the customer's models to be in ACC/Docs (or uploaded to OSS buckets), which is a workflow constraint, not a technical one.

### 2.6 Community MCP servers for Revit

Verified via the GitHub API on 2026-08-24:

| Project | License | Status | Coverage |
|---|---|---|---|
| [mcp-servers-for-revit/revit-mcp](https://github.com/mcp-servers-for-revit/revit-mcp) (the original "revit-mcp") | MIT | **Archived 2026-02** | Historical reference only |
| [mcp-servers-for-revit/mcp-servers-for-revit](https://github.com/mcp-servers-for-revit/mcp-servers-for-revit) ("Sparx fork", the successor) | MIT | Active (pushed 2026-04) | C#; claims ~138 tools incl. create/modify/delete |
| [LuDattilo/revit-mcp-server](https://github.com/LuDattilo/revit-mcp-server) | MIT | Active (pushed 2026-07) | C#; 80+ tools, Revit 2023–2026 |
| [Demolinator/revit-mcp-server](https://github.com/Demolinator/revit-mcp-server) | MIT | Active (pushed 2026-06) | Python via pyRevit; 48 tools, Revit 2024–2027 |

- **Read/write:** These are write-capable (element CRUD), unlike Autodesk's official read-only server. That is their whole appeal — and their risk: they execute arbitrary model mutations driven by an LLM, with community-grade testing.
- **Needs Revit running locally / Windows:** Yes and yes — all of them are an add-in inside a live Revit session plus an MCP-facing bridge process.
- **Licensing:** MIT across the board (GitHub API), compatible with any open-source app license. Note the ecosystem churn: the flagship project archived within roughly a year and fragmented into forks. Tool counts above are repo self-descriptions, not verified by me.

---

## 3. The macOS problem

**The core fact:** Revit does not run on macOS, and Autodesk publishes no macOS build. The official Revit system requirements list only 64-bit Windows (Windows 10 v1809+/Windows 11 per the Revit 2025/2026 requirements: https://www.autodesk.com/support/technical/article/caas/sfdcarticles/sfdcarticles/System-requirements-for-Revit-2025-products.html — 403-blocked to my fetcher, corroborated by search excerpts; and https://help.autodesk.com/cloudhelp/2026/ENU/Revit-Installation/files/GUID-2EF1661C-5A8D-41AC-A28F-9678DDF545CA.htm, accessed 2026-08-24, which lists supported virtualization configurations: "Citrix: Recommended-level configuration," "VMware: Recommended-level configuration," and "**Parallels Desktop for Mac: Recommended-level configuration**").

Every Revit integration path that touches a live model session therefore terminates on a Windows machine. The realistic reconciliations, with honest tradeoffs:

**Option A — Split architecture: macOS app + remote Windows "Revit agent" (recommended candidate).**
The macOS desktop app is an MCP *client*; Revit, plus an MCP server (official read-only or community write-capable), runs on a Windows machine — a colleague's workstation, an office server, or a cloud VM. The stdio-only servers need a small bridge that re-exposes them over MCP's Streamable HTTP transport (the MCP spec explicitly supports remote servers this way; §5). Tradeoffs: you now ship/maintain a Windows-side component; someone must own that machine and a Revit license; localhost-only defaults exist for good security reasons (DNS rebinding — see §5) so the bridge needs real auth, not a naked port. This is the only option that gives a macOS-native app *interactive* access to a *live* Revit session.

**Option B — Windows-in-Parallels on the same Mac.**
Autodesk's own system requirements bless Parallels Desktop at a recommended-level configuration (official requirements page cited above). On Apple silicon that means Windows 11 on Arm; Revit runs under x64 emulation/Arm compatibility. Tradeoffs: the user buys Windows + Parallels + a Revit license; performance overhead; and your "macOS-primary" app is now talking across a VM boundary (technically the same bridge problem as Option A, with the Windows machine being local). Viable for a single power user; a poor answer as a product's primary integration story.

**Option C — Cloud-only via APS: no Revit anywhere.**
Use the AEC Data Model API for reads and Design Automation for Revit for writes/batch jobs (§2.4–2.5). Fully platform-neutral; no Windows component to ship. Tradeoffs: models must live in Autodesk's cloud (ACC/Docs) or be uploaded per job; write operations are asynchronous batch jobs with minutes of latency, not interactive editing; ongoing consumption costs; users without ACC subscriptions are excluded.

**Option D — Meet in the open formats.**
The macOS app works natively on IFC (and DXF), and exchanges with Revit through Revit's own IFC import/export. Fully offline, fully open-source-compatible (§4). Tradeoffs: IFC round-tripping out of Revit is lossy and one-directional in practice (Revit's IFC import creates new elements rather than updating existing ones); this is interoperability, not integration. Honest as a baseline tier, insufficient as the headline "Revit integration."

**What does not exist:** a supported way to run Revit itself, the Revit API, pyRevit, Dynamo-for-Revit, or any local Revit MCP server natively on macOS. Any brief language implying "Revit integration running on the Mac" cannot be satisfied literally.

### Recommendation

The constraint binds only the *Revit-session side* — the code that must run inside a live Revit process — not the app itself. The MCP client, the IFC/DXF libraries, and the APS cloud APIs are all platform-neutral. So the decision is not "macOS app vs. no macOS app"; it is where to put the one irreducible Windows component.

**Build the desktop app cross-platform (e.g., Electron/Tauri or Qt), and ship the Windows-bound work as a separate "Revit agent": a Revit add-in plus an MCP bridge that exposes the session over Streamable HTTP.** The agent is required for *any* remote scenario anyway, so making the main app cross-platform adds little architecture on top of Option A:

- On **Windows**, the app and the agent install together; users get the local, live-Revit experience with no network hop worth noticing.
- On **macOS**, the identical app connects to a remote agent (Option A), to Parallels on the same machine (Option B, the degenerate single-machine case of A), or falls back to the APS cloud tier (Option C) and native IFC/DXF (Option D).

Ship **Windows first** — it exercises the full stack including the live-Revit tier — and follow with macOS once the remote and cloud tiers work. Tier the capabilities: D as the universal offline baseline, C for ACC-hosted teams, A as the headline "live Revit" tier.

Rejected alternatives: *Windows-only* is simplest but abandons the audience a macOS-primary brief presumably targets — Mac-based practitioners underserved precisely because Revit won't run there — and competes instead on the platform where users already have pyRevit and Dynamo natively. *macOS-only plus a mandatory bridge* has the highest friction and the narrowest market, defensible only with strong evidence of a Mac-committed user base willing to operate a Windows machine or VM.

---

## 4. Open format libraries (IFC, DWG, DXF)

Licenses and activity verified via the GitHub API on 2026-08-24 unless noted.

### IFC

| Library | Language | License | Status | OSS-app compatibility |
|---|---|---|---|---|
| [IfcOpenShell](https://github.com/IfcOpenShell/IfcOpenShell) (https://ifcopenshell.org/) | C++ with Python bindings | LGPL-3.0 | Very active (pushed 2026-08-25) | Yes; LGPL requires dynamic linking or source-relink provisions |
| [web-ifc / ThatOpen engine_web-ifc](https://github.com/ThatOpen/engine_web-ifc) | TypeScript + C++ (WASM) | MPL-2.0 | Active (pushed 2026-08-24) | Yes; file-level copyleft, friendly to any app license |
| [xbim Essentials](https://github.com/xBimTeam/XbimEssentials) | C# | CDDL (confirmed from repo `LICENCE.md`; GitHub reports "NOASSERTION") | Active (pushed 2026-08-16) | Usable, but CDDL is **GPL-incompatible** — a problem only if the app itself is GPL |

IfcOpenShell is the de-facto standard for full IFC read/write including geometry; web-ifc is the choice for TypeScript/Electron-style apps and is the engine under the ThatOpen (former IFC.js) component stack.

### DWG — the honest picture: there is no permissive, complete, vendor-grade option

| Option | Language | License | Status | Notes |
|---|---|---|---|---|
| ODA Drawings SDK (Open Design Alliance, https://www.opendesign.com/) | C++ (bindings for .NET etc.) | Proprietary, membership-based | Commercial, industry standard | Per ODA's pricing/membership pages (https://www.opendesign.com/pricing, https://www.opendesign.com/faq/membership — figures via search-result excerpts, **not independently verified**): annual membership + license fees on the order of thousands to tens of thousands of USD/year. Source available to members; **not open source and not redistributable under an OSS license** |
| [LibreDWG](https://github.com/LibreDWG/libredwg) | C | **GPL-3.0** | Active (pushed 2026-08-23) | GNU project. Linking it obligates the app to GPL-compatible licensing. Write support has historically lagged read; verify per-version coverage before relying on it |
| [ACadSharp](https://github.com/DomCR/ACadSharp) | C# | **MIT** | Active (pushed 2026-08-23) | Community DWG/DXF reader-writer. The only permissive DWG option found; coverage/fidelity is community-grade and I did not verify its per-DWG-version completeness |
| Autodesk RealDWG | C++/.NET | Commercial license program, Windows | — | Not compatible with an open-source, macOS-primary app; listed for completeness. Not verified from an official page this session |

### DXF

| Library | Language | License | Status |
|---|---|---|---|
| [ezdxf](https://github.com/mozman/ezdxf) | Python | MIT | Active (pushed 2026-08-19) |
| [netDxf](https://github.com/haplokuon/netDxf) | C# | MIT | **Archived Oct 2023** — do not adopt |
| ACadSharp (above) | C# | MIT | Active; covers DXF as well |

**Practical conclusion:** IFC and DXF are well served by maintained, permissively- or weak-copyleft-licensed libraries. DWG is the trap: the maintained choices are GPL (LibreDWG), commercial (ODA), or community-permissive with unverified fidelity (ACadSharp).

---

## 5. The MCP client side

Everything in this section is from the official MCP specification, version **2025-11-25** (https://modelcontextprotocol.io/specification/2025-11-25/, accessed 2026-08-24; pages: `basic/transports`, `basic/lifecycle`, `basic/authorization` — all fully retrieved).

**Message layer.** JSON-RPC 2.0, UTF-8. A client implements requests, responses, and notifications, plus utilities: ping, cancellation (`CancelledNotification`), progress notifications, and per-request timeouts (spec: implementations SHOULD enforce timeouts, MAY reset on progress, SHOULD cap regardless).

**Transports** (spec: `basic/transports`):
- **stdio** — the client launches the server as a subprocess and exchanges newline-delimited JSON-RPC over stdin/stdout; stderr is server logging. Clients "SHOULD support stdio whenever possible." Shutdown: close stdin → wait → SIGTERM → SIGKILL. This is how a desktop app would host local servers (e.g., an IfcOpenShell-backed server, or — on Windows — Autodesk's Revit server).
- **Streamable HTTP** — a single MCP endpoint accepting POST (client→server JSON-RPC; responses come back as `application/json` or as an SSE stream, and the client MUST support both) and GET (opens a server→client SSE stream). Sessions via the `MCP-Session-Id` header (echoed on every request; 404 means re-initialize); `MCP-Protocol-Version` header required on all post-init requests; resumability via SSE event IDs + `Last-Event-ID`. Security requirements the client should expect servers to enforce: Origin validation (DNS-rebinding defense) and localhost-only binding for local servers. This is the transport for reaching a remote Windows Revit bridge or an APS-based cloud server.
- Custom transports are permitted if they preserve the JSON-RPC framing and lifecycle.

**Lifecycle** (spec: `basic/lifecycle`): `initialize` request (protocol version, client capabilities, client info) → server responds with its version/capabilities → client sends `notifications/initialized` → operation phase constrained to negotiated capabilities → transport-level shutdown. Version negotiation: client sends its latest; if the server answers with a version the client doesn't support, disconnect. Client-side capabilities a desktop app can choose to offer: `roots` (filesystem roots), `sampling` (server-initiated LLM calls), `elicitation` (server-initiated user prompts), `tasks`.

**Authorization** (spec: `basic/authorization`; applies to HTTP transports only — **stdio servers get credentials from the environment instead**, e.g. env vars): OAuth 2.1. A compliant client MUST: handle 401s by discovering Protected Resource Metadata (RFC 9728, via `WWW-Authenticate` header or well-known URIs); discover authorization-server metadata (RFC 8414 and OIDC Discovery — both required client-side); implement **PKCE (S256)** and refuse to proceed if the AS doesn't advertise it; send the **RFC 8707 `resource` parameter** on authorization and token requests; send `Authorization: Bearer` on every request; handle 403 `insufficient_scope` step-up flows. Client registration options, in the spec's priority order: pre-registered credentials → Client ID Metadata Documents (client hosts a JSON metadata doc at an HTTPS URL used as its `client_id`) → Dynamic Client Registration (RFC 7591) → manual entry. Note that APS's own auth (2LO/3LO/SSA, §1) predates the MCP auth spec; an APS-backed remote server would front APS OAuth behind spec-standard resource metadata, or the client falls back to environment-style credential injection.

**Summary of what the desktop app must build:** a JSON-RPC engine; subprocess management for stdio servers; an HTTP+SSE client with session and resumption handling for remote servers; the initialize/capability handshake; timeout/cancellation plumbing; secure token storage plus a browser-based OAuth 2.1/PKCE flow for authenticated remote servers. Official SDKs (TypeScript, Python, C#, et al., at https://github.com/modelcontextprotocol) implement most of this.

---

## 6. Assumptions in the product brief that do not hold

(Assessed against the stated requirements — macOS primary, Revit integration major, open-source desktop app — since no brief document exists in this repository.)

1. **"The app integrates with Revit, and the app's primary platform is macOS" — these cannot both be literally true.** Revit, its API, pyRevit, Dynamo-for-Revit, and every local MCP server (official and community) run only on Windows, with a live Revit session (§2, §3). *Alternative (the recommendation in §3):* build the app **cross-platform** rather than macOS-first, re-scope "Revit integration" as a capability delivered by a **Windows-resident "Revit agent"** (Revit add-in + MCP bridge over Streamable HTTP) that the app reaches locally on Windows and remotely from macOS, with APS cloud APIs (Option C) for ACC-hosted teams and native IFC (Option D) as the offline baseline. Ship Windows first, macOS second. The brief should name the Windows-side agent as a deliverable, because nobody else ships it for you.

2. **"Autodesk's official MCP server gives us Revit read/write" — it is read-only, tech preview, and Revit 2027 only.** The official server exposes ~7 read/export tools, is labeled Tech Preview (Public Beta), and covers only Revit 2027 (§1) — a version most firms will not run in production for years; the installed base is on 2023–2026. A write server is announced intent, not product. *Alternative:* treat the official server as the trusted read path where 2027 exists; for write and for Revit 2023–2026, adopt or fork a community MIT server (the Sparx fork or Demolinator's pyRevit-based server, §2.6) behind your own bridge — and budget for maintaining it, given that the ecosystem's flagship repo was archived within about a year. For non-interactive writes, Design Automation for Revit is the officially supported route (§2.4).

3. **"Open-source libraries cover the file formats" — true for IFC and DXF, false for DWG.** There is no maintained, permissive, vendor-grade DWG library: the choices are GPL-3.0 (LibreDWG), proprietary membership fees (ODA), or a community MIT library of unverified fidelity (ACadSharp) (§4). *Alternative:* ship DXF as the first-class 2D exchange format (ezdxf/ACadSharp, both MIT) and demote DWG to "import via conversion" — either ODA-based conversion as an optional commercial add-on, or asking users to export DXF/IFC from their CAD tool. Do not put "native DWG editing" on an open-source roadmap without pricing ODA membership.

4. **"MCP integration means talking to one local server" — the transport story is split, and the interesting servers are remote.** Local stdio covers only same-machine servers, which on macOS excludes everything Revit (§3, §5). *Alternative:* build the client with both transports from day one, including the full OAuth 2.1/PKCE/RFC 9728 discovery stack — it is mandatory for any authenticated remote server and is the pathway to APS-backed servers.

5. **If the brief assumes a GPL license for the app itself:** xbim (CDDL) would be excluded, and any future use of Autodesk's proprietary SDKs or ODA would be complicated; conversely, if the brief assumes a permissive license, pyRevit (GPL-3.0) and LibreDWG (GPL-3.0) cannot be linked-in dependencies (§2.2, §4). *Alternative:* pick MPL-2.0 or Apache-2.0 for the app; both coexist with LGPL (IfcOpenShell, dynamically linked), MPL (web-ifc), and MIT (ezdxf, ACadSharp, community MCP servers), which covers the entire recommended dependency set without a copyleft conflict in either direction.
