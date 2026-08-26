/**
 * The Autodesk/Revit capability map — the one place in Archspace that says what
 * we can actually do with Revit today.
 *
 * The product requirement this module serves: implement only what the research
 * phase confirmed exists; where a capability does not exist, ship the seam and
 * mark it clearly as unimplemented in both the code and the UI; never present a
 * mock as a working integration. So this table has no aspirational rows. Six of
 * its eleven entries are `not-implemented`, each naming the empty seam by repo
 * path, and the settings panel and docs/autodesk-revit.md both render from
 * here — there is no second, friendlier version of these facts.
 *
 * Everything below is sourced from docs/research/ecosystem.md §1–§3 via
 * sources.ts. Where the researcher was blocked (autodesk.com answers 403), the
 * evidence says so and `directlyVerified` stays false all the way to the
 * screen. Read the Revit 2027 entry in particular before "fixing" anything
 * there: its executable path and stdio transport are excerpt-level claims, not
 * documented facts.
 */
import type { AutodeskCapability } from './model.js';
import { cite } from './sources.js';

/** Revit is a Windows application; every live-session channel terminates there. */
const WINDOWS_REVIT_FACT = cite(
  'revit-virtualization',
  'Revit runs on Windows only; Autodesk publishes no macOS build. The installation help page lists supported virtualization (Citrix, VMware, and Parallels Desktop for Mac at "Recommended-level configuration") — a Windows guest on a Mac, not a macOS build.',
);
const WINDOWS_REVIT_REQUIREMENTS = cite(
  'revit-system-requirements',
  'The official Revit system requirements list 64-bit Windows only.',
);

export const AUTODESK_CAPABILITIES: readonly AutodeskCapability[] = [
  {
    id: 'autodesk-product-help-mcp',
    title: 'Autodesk Product Help MCP server',
    summary:
      'Autodesk’s remote documentation MCP server: search the help for 110+ products in 10 languages. It needs no Revit and no Windows, so it is the one official Autodesk MCP server that works from a Mac as-is.',
    status: 'available',
    channel: 'mcp',
    access: 'read',
    platforms: ['cloud'],
    requires: [
      'The server’s Streamable HTTP endpoint URL, from Autodesk MCP Server Help (the research could not retrieve the per-server page, so we cannot pre-fill it)',
      'An Autodesk sign-in if the endpoint challenges — the MCP host runs the OAuth 2.1 flow on a 401',
    ],
    evidence: [
      cite(
        'adsk-mcp-portal',
        'Autodesk’s MCP portal lists five official servers, of which "Autodesk Product Help MCP" is Remote and covers 110+ products’ documentation in 10 languages; documentation search only.',
      ),
      cite(
        'mcp-authorization',
        'MCP authorization applies to HTTP transports: a compliant client discovers protected-resource metadata from the 401 and runs OAuth 2.1 with PKCE — so an authenticated Autodesk endpoint needs no bespoke code here.',
      ),
    ],
  },
  {
    id: 'revit-2027-mcp',
    title: 'Autodesk Revit 2027 MCP Server (Tech Preview)',
    summary:
      'Autodesk’s own Revit MCP server: local, read-and-export, Revit 2027 only, labelled Tech Preview (Public Beta). It runs beside a live Revit session, which means it runs on Windows — from macOS you reach it through a remote agent.',
    status: 'available-windows-only',
    channel: 'mcp',
    access: 'read-export',
    platforms: ['windows'],
    requires: [
      'A Windows machine running Revit 2027 (earlier versions are not supported)',
      'The Revit 2027 MCP Server add-on, downloaded from your Autodesk Account under the Revit 2027 entitlement',
      'A signed-in, open Revit session — the server talks to the running application',
      'Confirmation of the server executable path and transport on that machine: our defaults come from search excerpts of a page nobody could read',
    ],
    evidence: [
      cite(
        'adsk-mcp-portal',
        'The portal lists "Autodesk Revit 2027 MCP Server" as Local, "Tech Preview (Public Beta)", "read-only access to Revit models", 7 tools.',
      ),
      cite(
        'revit-2027-whats-new',
        'Revit 2027 What’s New documents the "Revit Public MCP Server (Tech Preview)": interrogating and reporting on the model (searching elements, checking parameters and counts), batch editing parameters, and capturing visual snapshots of views — which sits in tension with the portal’s "read-only" wording.',
        'The research could not resolve the read-only/batch-edit contradiction from retrievable official sources; plan for read-plus-export and no element creation.',
      ),
      cite(
        'revit-mcp-support-article',
        'A server executable at C:\\Program Files\\Autodesk\\Revit 2027 MCP Server Technical Preview\\RevitMCPServer.exe, stdio transport, and automatic configuration of Claude Desktop/Cursor.',
        'NOT DIRECTLY VERIFIED. A third-party blog instead claims a localhost HTTP bridge on port 3000, which contradicts the stdio description; treat both as unconfirmed until checked on a Windows machine.',
      ),
      cite(
        'revit-mcp-blog',
        'Autodesk announced the Revit Public MCP Server on the AEC blog on 2026-06-17.',
      ),
      cite(
        'bim-chapters',
        'Revit 2027 is an absolute requirement ("the tool does not work with earlier versions"), and the add-on is distributed through the user’s Autodesk Account. Autodesk (Harlan Brumm) is quoted saying no Revit modifications are possible at the moment, with a write server described as future work.',
      ),
      WINDOWS_REVIT_FACT,
    ],
  },
  {
    id: 'autocad-civil3d-mcp',
    title: 'Autodesk AutoCAD and Civil 3D MCP Server',
    summary:
      'Autodesk’s official local MCP server for AutoCAD and Civil 3D — the portal says it can query, analyze and modify objects in drawings. We gate it to Windows because it must run beside a live desktop session and the research never established which desktop platforms it supports.',
    status: 'available-windows-only',
    channel: 'mcp',
    access: 'read-write',
    platforms: ['windows'],
    requires: [
      'A machine running AutoCAD or Civil 3D with the Autodesk MCP server installed',
      'The server’s executable path and transport — the research retrieved neither, so nothing here is pre-filled',
      'A deliberate decision about write access: this server modifies drawing objects',
    ],
    evidence: [
      cite(
        'adsk-mcp-portal',
        'The portal lists "Autodesk AutoCAD and Civil 3D MCP Server" as Local, covering AutoCAD and Civil 3D, and able to query, analyze and modify objects in drawings.',
        'The per-server detail page was unreachable, so no tool list, executable path, or transport for this server is known.',
      ),
      cite(
        'mcp-transports',
        'stdio servers are launched as a subprocess by the client on the same machine, so a "Local" server cannot be reached across machines without a bridge that re-exposes it over Streamable HTTP.',
      ),
    ],
  },
  {
    id: 'community-revit-mcp',
    title: 'Community Revit MCP servers (MIT)',
    summary:
      'Community add-in-plus-bridge servers that do what Autodesk’s does not: create, modify and delete elements, on Revit 2023–2027. MIT-licensed and genuinely useful, with community-grade testing and a churn record worth reading before you depend on one.',
    status: 'available-windows-only',
    channel: 'mcp',
    access: 'read-write',
    platforms: ['windows'],
    requires: [
      'A Windows machine with Revit and the community add-in installed, plus its bridge process',
      'A build of the chosen server — none of them ship a signed installer we can point at',
      'Your own judgement about letting a model be mutated by an LLM: these execute arbitrary model edits',
      'A maintenance plan: the flagship project archived within about a year and the ecosystem fragmented into forks',
    ],
    evidence: [
      cite(
        'gh-mcp-servers-for-revit',
        'mcp-servers-for-revit (the "Sparx fork", successor to the original revit-mcp) is MIT, active (pushed 2026-04), C#, and claims ~138 tools including create/modify/delete.',
      ),
      cite(
        'gh-ludattilo-revit-mcp',
        'LuDattilo/revit-mcp-server is MIT, active (pushed 2026-07), C#, claims 80+ tools for Revit 2023–2026.',
      ),
      cite(
        'gh-demolinator-revit-mcp',
        'Demolinator/revit-mcp-server is MIT, active (pushed 2026-06), Python via pyRevit, claims 48 tools for Revit 2024–2027.',
      ),
      cite(
        'gh-revit-mcp-archived',
        'The original mcp-servers-for-revit/revit-mcp — the ecosystem’s flagship — is MIT and was ARCHIVED in 2026-02. Historical reference only; do not adopt it.',
      ),
      cite(
        'gh-pyrevit',
        'pyRevit is GPL-3.0. It matters for the pyRevit-based server: that dependency lives on the Windows machine, not in this app, and Archspace links none of it.',
      ),
      WINDOWS_REVIT_REQUIREMENTS,
    ],
  },
  {
    id: 'revit-remote-agent',
    title: 'Remote Revit agent over Streamable HTTP',
    summary:
      'The only way a macOS app touches a live Revit session: Revit plus an MCP server runs on a Windows machine (workstation, office box, Parallels VM, cloud VM) behind a bridge that speaks MCP Streamable HTTP, and Archspace connects as an ordinary authenticated MCP client. What you can do is whatever the server behind the bridge can do.',
    status: 'requires-remote-agent',
    channel: 'mcp',
    access: 'read-write',
    platforms: ['windows'],
    requires: [
      'A Windows machine with Revit and a Revit MCP server (official read/export, or a community write-capable one)',
      'A bridge that re-exposes that stdio server over MCP Streamable HTTP — Archspace does not ship one (see the Archspace Revit agent entry)',
      'Real authentication and TLS on that endpoint, plus Origin validation: a naked port is a DNS-rebinding target',
      'The endpoint URL, and whoever owns that machine and its Revit licence',
    ],
    evidence: [
      cite(
        'mcp-transports',
        'MCP Streamable HTTP is a single endpoint taking POST and GET with SSE, sessions via MCP-Session-Id and resumption via Last-Event-ID — the spec’s supported way to reach a remote server. The spec also expects local servers to bind localhost and validate Origin as DNS-rebinding defence.',
      ),
      cite(
        'mcp-authorization',
        'For HTTP transports the spec requires OAuth 2.1 with PKCE S256, RFC 9728 protected-resource-metadata discovery from the 401, and the RFC 8707 resource parameter — which is what "real authentication" means for this endpoint.',
      ),
      WINDOWS_REVIT_FACT,
      WINDOWS_REVIT_REQUIREMENTS,
    ],
  },
  {
    id: 'revit-first-party-agent',
    title: 'Archspace Revit agent (Windows add-in + bridge)',
    summary:
      'A first-party Windows component — a Revit add-in plus an MCP bridge — so that connecting a Mac to Revit is an install, not a project. It does not exist. Nothing in this repo builds, ships, or updates it.',
    status: 'not-implemented',
    channel: 'revit-addin',
    access: 'none',
    platforms: ['windows'],
    requires: [
      'Nothing you can supply today — this is our work, not yours',
      'Until it exists: run a third-party Revit MCP server on the Windows machine and point the "Remote Revit agent" preset at it',
    ],
    unimplementedReason:
      'No Revit add-in, no bridge process and no installer ships in this repository, and none is built by any package here. The architecture names the Windows Revit agent as a future deliverable; the honest status until then is that the user supplies their own agent and Archspace is only the MCP client. Do not describe Archspace as "integrating with Revit" on the strength of this row.',
    seam: 'packages/autodesk/src/presets.ts — the `revit-agent` preset is the socket a first-party agent would plug into; it is a client-side template today, and no server-side code exists anywhere in this repo.',
    evidence: [
      cite(
        'revit-api-overview',
        'Revit’s extensibility is the .NET add-in model: assemblies loaded in-process by Revit. That is what a first-party agent would have to be — Windows code inside a live Revit session.',
      ),
      WINDOWS_REVIT_FACT,
    ],
  },
  {
    id: 'aps-oauth',
    title: 'Autodesk Platform Services authentication',
    summary:
      'APS OAuth — 2-legged for app-owned resources, 3-legged for user-delegated access, and Secure Service Accounts for server-to-server JWT assertions. Every APS capability below needs it first. Not implemented: Archspace has no APS application, no credential storage for one, and no token flow.',
    status: 'not-implemented',
    channel: 'aps-rest',
    access: 'none',
    platforms: ['cloud'],
    requires: [
      'An APS application (client id/secret) registered by whoever runs Archspace',
      'A decision about which of the three auth patterns fits a desktop app before any code is written',
    ],
    unimplementedReason:
      'No APS client, no registered application, no token acquisition and no keychain slots for APS credentials exist in this codebase. Every method of the APS seam throws instead of pretending to authenticate.',
    seam: 'packages/autodesk/src/aps.ts — createApsClient().authenticate()',
    evidence: [
      cite(
        'aps-mcp-blog',
        'Autodesk publishes reference MCP server implementations over APS (JavaScript/Streamable HTTP, .NET/stdio, Python) rather than hosting servers, and documents the three APS auth patterns: 2-legged, Secure Service Accounts, and 3-legged.',
      ),
      cite('aps-ssa-guide', 'Secure Service Accounts have their own APS developer guide.'),
    ],
  },
  {
    id: 'aps-design-automation-revit',
    title: 'APS Design Automation for Revit',
    summary:
      'Autodesk’s cloud-hosted headless Revit: upload a DB-only add-in bundle and a work item, and Autodesk runs it against RVT files with full read and write — no Windows machine of your own, minutes of latency per job, consumption pricing. Not implemented here.',
    status: 'not-implemented',
    channel: 'aps-rest',
    access: 'read-write',
    platforms: ['cloud'],
    requires: [
      'APS credentials and consumption budget (pricing was not verified by the research)',
      'A DB-only AppBundle — no RevitUI namespace, no ActiveView/ActiveDocument — which is a .NET build pipeline Archspace does not have',
      'Acceptance that this is batch, asynchronous work: minutes per work item, not interactive editing',
    ],
    unimplementedReason:
      'Archspace ships no AppBundle, no work-item submission, no polling and no result retrieval. Writing to Revit through Design Automation is a whole .NET build-and-upload pipeline, not an HTTP call, and none of it exists here.',
    seam: 'packages/autodesk/src/aps.ts — createApsClient().startDesignAutomationWorkItem()',
    evidence: [
      cite(
        'aps-design-automation-guide',
        'Design Automation v3 runs Autodesk engines (including Revit) in the cloud over REST: AppBundles plus work items, with full DB-level read and write of RVT files and no local Revit or Windows machine required.',
      ),
      cite(
        'aps-design-automation-restrictions',
        'Documented restrictions: no Revit UI APIs (DB-only application), no ActiveView/ActiveDocument, disk writes confined to the job working directory, no Navisworks export, no Desktop Connector.',
      ),
    ],
  },
  {
    id: 'aps-aec-data-model',
    title: 'APS AEC Data Model API',
    summary:
      'GraphQL read access to granular element and property data for models hosted in Autodesk Construction Cloud or Autodesk Docs — no Revit, no Windows, no download. Not implemented here.',
    status: 'not-implemented',
    channel: 'aps-graphql',
    access: 'read',
    platforms: ['cloud'],
    requires: [
      'Models already hosted in Autodesk Construction Cloud or Autodesk Docs',
      'APS credentials (see Autodesk Platform Services authentication)',
    ],
    unimplementedReason:
      'No GraphQL client, no schema, no query nodes. This is the most plausible first real APS capability precisely because it is read-only and platform-neutral — but plausible is not shipped.',
    seam: 'packages/autodesk/src/aps.ts — createApsClient().queryAecDataModel()',
    evidence: [
      cite(
        'aps-aec-data-model',
        'The AEC Data Model API gives GraphQL read access to granular element/property data of models in Autodesk Construction Cloud / Autodesk Docs, without opening Revit; it needs neither Revit nor Windows, but does require the model to live in Autodesk’s cloud.',
      ),
      cite(
        'aps-mcp-blog',
        'Autodesk’s own .NET reference MCP server (aps-aecdm-mcp-dotnet) is built on the AEC Data Model API, which is the shape this capability would take.',
      ),
    ],
  },
  {
    id: 'aps-model-derivative',
    title: 'APS Model Derivative API',
    summary:
      'Cloud translation of RVT/DWG and friends into viewables and extractable metadata. Read and translate only. Not implemented here.',
    status: 'not-implemented',
    channel: 'aps-rest',
    access: 'read-export',
    platforms: ['cloud'],
    requires: [
      'Models uploaded to an APS bucket or hosted in ACC/Docs',
      'APS credentials (see Autodesk Platform Services authentication)',
    ],
    unimplementedReason:
      'No translation job submission, no manifest polling, no derivative download. Archspace also has no viewer to consume the SVF output, so the capability would be half a feature even if the calls existed.',
    seam: 'packages/autodesk/src/aps.ts — createApsClient().translateModelDerivative()',
    evidence: [
      cite(
        'aps-portal',
        'The research (§2.5) describes Model Derivative as cloud translation of RVT/DWG and similar into viewables and extractable metadata, read/translate only, needing neither Revit nor Windows.',
        'The research names this API without citing a specific page, so this entry points at the APS portal root rather than a documentation page we can vouch for. Find and verify the real endpoint documentation before implementing.',
      ),
    ],
  },
  {
    id: 'aps-data-management',
    title: 'APS Data Management API',
    summary:
      'Hubs, projects, folders and versions — the plumbing that finds a model in ACC/Docs before any other APS capability can act on it. Not implemented here.',
    status: 'not-implemented',
    channel: 'aps-rest',
    access: 'read',
    platforms: ['cloud'],
    requires: [
      'An Autodesk Construction Cloud or Autodesk Docs account with the models in it',
      'APS credentials (see Autodesk Platform Services authentication)',
    ],
    unimplementedReason:
      'No hub/project/folder browsing and no version resolution ships. Without it there is no way to name the model the other APS capabilities would operate on.',
    seam: 'packages/autodesk/src/aps.ts — createApsClient() (no data-management method is exposed yet; the seam is the client itself)',
    evidence: [
      cite(
        'aps-mcp-blog',
        'Autodesk’s reference MCP servers wrap the Object Storage Service, the Data Management API and the AEC Data Model API — Data Management being the hubs/projects/folders/versions layer.',
      ),
      cite(
        'aps-portal',
        'The research (§2.5) describes Data Management as hubs/projects/folders/versions plumbing, platform-neutral REST, requiring the customer’s models to live in ACC/Docs or an OSS bucket.',
        'Named without a specific citation in the research; the portal root is the entry point, not evidence for any detail.',
      ),
    ],
  },
];

export function capabilityById(id: string): AutodeskCapability | undefined {
  return AUTODESK_CAPABILITIES.find((cap) => cap.id === id);
}

/**
 * Status as it applies on the host actually running the app.
 *
 * `usableHere` answers one question only: can this machine use the capability
 * *at all*, assuming the user does the work listed in `requires`? A remote agent
 * is therefore usable from macOS (we are the client) while a local Windows
 * server is not — and `not-implemented` is never usable anywhere, which is what
 * keeps a seam from leaking into the UI as an option.
 */
export function resolveCapability(
  cap: AutodeskCapability,
  platform: NodeJS.Platform,
): { usableHere: boolean; reason: string } {
  const here = platformLabel(platform);
  switch (cap.status) {
    case 'available':
      return { usableHere: true, reason: `Works on ${here} once you supply what it requires.` };
    case 'available-windows-only':
      return platform === 'win32'
        ? {
            usableHere: true,
            reason:
              'Works on this machine: it is Windows, so the server can run beside a live Revit or AutoCAD session.',
          }
        : {
            usableHere: false,
            reason: `Needs Windows with a live Revit or AutoCAD session, and this machine is ${here}. Run it on a Windows machine and connect through a remote agent over MCP Streamable HTTP instead.`,
          };
    case 'requires-remote-agent':
      return {
        usableHere: true,
        reason: `Usable from ${here} as an MCP client, but only once someone runs the agent on a Windows machine with Revit — Archspace is the client, never the Revit side.`,
      };
    case 'not-implemented':
      return {
        usableHere: false,
        reason: `Not implemented on any platform. ${cap.unimplementedReason ?? ''} Seam: ${cap.seam ?? 'none recorded'}`.trim(),
      };
  }
}

function platformLabel(platform: NodeJS.Platform): string {
  if (platform === 'darwin') return 'macOS';
  if (platform === 'win32') return 'Windows';
  if (platform === 'linux') return 'Linux';
  return platform;
}
