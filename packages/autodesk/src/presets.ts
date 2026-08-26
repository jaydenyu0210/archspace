/**
 * MCP server presets for the Autodesk world, plus the platform gate the app
 * hands to the MCP host.
 *
 * A preset is a *template*, not a connection: it produces a real
 * `McpServerConfig` the user can drop into mcp.yaml, with the machine-specific
 * parts left as declared placeholders. That distinction is the honesty rule of
 * this file — we know the transport shape of these servers, we do not know the
 * user's URL, and for two of them we do not reliably know the executable path
 * either (autodesk.com answers 403, so the Revit 2027 path is a search-excerpt
 * default the user must confirm). Nothing here is enabled by default; a preset
 * with an unfilled placeholder would otherwise fail obscurely at first demand.
 *
 * Availability is derived from the capability table via `resolveCapability`,
 * never restated, so a preset can never look available while the capability it
 * belongs to says otherwise. `mcpSupportCheck` is the independent gate: it runs
 * over whatever the user actually wrote in mcp.yaml — preset-derived or not —
 * and tells the host to report `unsupported` with a real reason rather than
 * letting a Windows-only stdio command fail as a confusing spawn error.
 */
import type { McpServerConfig } from '@archspace/mcp-host';
import type { CapabilityEvidence } from './model.js';
import { capabilityById, resolveCapability } from './capabilities.js';
import { cite } from './sources.js';

export interface McpServerPreset {
  id: string;
  /** Suggested key in mcp.yaml. Workflow-visible, so [a-z][a-z0-9_]*. */
  logicalName: string;
  label: string;
  description: string;
  capabilityId: string;
  config: McpServerConfig;
  /** Fields the user must fill before the preset is usable (e.g. the URL). */
  placeholders: { path: string; label: string; hint: string }[];
  availability: { available: boolean; reason?: string };
  evidence: CapabilityEvidence[];
}

/** Marks a value in a preset config that the user has to replace. Visible on
 *  purpose: a half-filled preset should look wrong at a glance. */
const TODO = '<replace me>';

/** Per-request timeout the MCP spec asks clients to enforce; the host's default. */
const TIMEOUT_MS = 60_000;

interface PresetSeed {
  id: string;
  logicalName: string;
  label: string;
  description: string;
  capabilityId: string;
  config: McpServerConfig;
  placeholders: { path: string; label: string; hint: string }[];
  evidence: CapabilityEvidence[];
  /** Reason this preset is unusable regardless of platform (archived, etc.). */
  hardBlock?: string;
}

const SEEDS: readonly PresetSeed[] = [
  {
    id: 'autodesk-product-help',
    logicalName: 'autodesk_help',
    label: 'Autodesk Product Help (official, remote)',
    description:
      "Autodesk's remote documentation MCP server: help content for 110+ products in 10 languages. The only official Autodesk MCP server that needs neither Revit nor Windows, so it works from a Mac as soon as you paste the endpoint. Auth is left as 'oauth' because the research could not retrieve the server's page: if the endpoint turns out to be open, the host simply never runs the flow; if it challenges, the 401 discovery path handles it.",
    capabilityId: 'autodesk-product-help-mcp',
    config: {
      binding: { transport: 'http', url: TODO, auth: 'oauth' },
      enabled: false,
      description: 'Autodesk Product Help MCP (official, remote, documentation search only)',
      timeoutMs: TIMEOUT_MS,
      concurrency: 1,
    },
    placeholders: [
      {
        path: 'binding.url',
        label: 'Endpoint URL',
        hint: 'The Streamable HTTP endpoint from Autodesk MCP Server Help (https://help.autodesk.com/view/ADSKMCP/ENU/). The per-server page is rendered client-side and the research could not read it, so we cannot pre-fill this — copy it from the portal.',
      },
    ],
    evidence: [
      cite(
        'adsk-mcp-portal',
        'The portal lists Autodesk Product Help MCP as a Remote server covering 110+ products in 10 languages, documentation search only.',
      ),
    ],
  },
  {
    id: 'revit-agent',
    logicalName: 'revit',
    label: 'Remote Revit agent (Streamable HTTP)',
    description:
      "Connect to a Windows machine that runs Revit plus an MCP bridge, over MCP's Streamable HTTP transport. This is the macOS answer to Revit and the only preset here that is a pure network client, so it is available on every platform — what it can do is whatever the server behind the bridge can do. Archspace does not ship the agent; you point this at one you run.",
    capabilityId: 'revit-remote-agent',
    config: {
      binding: { transport: 'http', url: TODO, auth: 'oauth' },
      enabled: false,
      description: 'Windows machine running Revit plus an MCP bridge (see docs/autodesk-revit.md)',
      timeoutMs: TIMEOUT_MS,
      concurrency: 1,
    },
    placeholders: [
      {
        path: 'binding.url',
        label: 'Agent URL',
        hint: 'The bridge\'s MCP endpoint, e.g. https://revit-agent.office.example:8443/mcp. Use TLS and real authentication: the MCP spec expects local servers to bind localhost and validate Origin precisely because an open port is a DNS-rebinding target. If your bridge uses a static token instead of OAuth, switch auth to "bearer" and set bearerTokenRef to a keychain key — never paste the token here.',
      },
    ],
    evidence: [
      cite(
        'mcp-transports',
        'Streamable HTTP is the spec transport for remote servers: one endpoint, POST plus GET/SSE, sessions via MCP-Session-Id, resumption via Last-Event-ID.',
      ),
      cite(
        'mcp-authorization',
        'HTTP transports use OAuth 2.1 with PKCE S256, RFC 9728 resource-metadata discovery and the RFC 8707 resource parameter — what the host runs when it meets a 401.',
      ),
    ],
  },
  {
    id: 'revit-2027-official',
    logicalName: 'revit_2027',
    label: 'Autodesk Revit 2027 MCP Server (official, Tech Preview)',
    description:
      "Autodesk's own read-and-export Revit server, launched over stdio beside a live Revit 2027 session. Windows only. Both the executable path below and the stdio transport come from search-result excerpts of a support article that returned 403 — they are a documented default to confirm on the machine, not a promise.",
    capabilityId: 'revit-2027-mcp',
    config: {
      binding: {
        transport: 'stdio',
        command: ['C:\\Program Files\\Autodesk\\Revit 2027 MCP Server Technical Preview\\RevitMCPServer.exe'],
      },
      enabled: false,
      description:
        'Autodesk Revit 2027 MCP Server (Tech Preview) — read/export, requires a live Revit 2027 session',
      timeoutMs: TIMEOUT_MS,
      concurrency: 1,
    },
    placeholders: [
      {
        path: 'binding.command.0',
        label: 'Server executable',
        hint: 'Confirm the real path on the Windows machine. Our default comes from search excerpts of an Autodesk support article nobody could read directly, and a third-party blog claims a localhost HTTP bridge on port 3000 instead — if the executable is not there, check the add-on install before assuming stdio at all.',
      },
    ],
    evidence: [
      cite(
        'adsk-mcp-portal',
        'Listed as Local, Tech Preview (Public Beta), read-only access to Revit models, 7 tools.',
      ),
      cite(
        'revit-mcp-support-article',
        'Executable at C:\\Program Files\\Autodesk\\Revit 2027 MCP Server Technical Preview\\RevitMCPServer.exe, communicating over stdio with any MCP-compliant client.',
        'NOT DIRECTLY VERIFIED — this is the claim the preset defaults are built on.',
      ),
      cite(
        'revit-2027-whats-new',
        'Revit 2027 only; the documented behaviour is interrogating the model, batch parameter editing and view snapshots.',
      ),
    ],
  },
  {
    id: 'autocad-civil3d-official',
    logicalName: 'autocad',
    label: 'Autodesk AutoCAD and Civil 3D MCP Server (official)',
    description:
      "Autodesk's official local server for AutoCAD and Civil 3D — query, analyze and modify drawing objects. The research retrieved no executable path and no transport for it, so every part of this command is a placeholder: get the real one from Autodesk MCP Server Help before enabling it.",
    capabilityId: 'autocad-civil3d-mcp',
    config: {
      binding: {
        transport: 'stdio',
        command: [`C:\\Program Files\\Autodesk\\${TODO}\\${TODO}.exe`],
      },
      enabled: false,
      description:
        'Autodesk AutoCAD and Civil 3D MCP Server — writes to drawings; path and transport unconfirmed',
      timeoutMs: TIMEOUT_MS,
      concurrency: 1,
    },
    placeholders: [
      {
        path: 'binding.command.0',
        label: 'Server executable',
        hint: 'Unknown to us. The Autodesk MCP portal names this server but its detail page could not be retrieved, so neither the install path nor the transport is documented here. If the server turns out to be HTTP rather than stdio, change the binding instead of forcing a command.',
      },
    ],
    evidence: [
      cite(
        'adsk-mcp-portal',
        'Listed as Local, covering AutoCAD and Civil 3D, able to query, analyze and modify objects in drawings.',
        'No tool list, install path or transport for this server was retrievable.',
      ),
    ],
  },
  {
    id: 'revit-mcp-sparx',
    logicalName: 'revit_sparx',
    label: 'mcp-servers-for-revit (community, MIT, write-capable)',
    description:
      'The successor to the archived flagship revit-mcp: C#, MIT, active as of 2026-04, self-describing ~138 tools including create/modify/delete. Write-capable, community-tested — the appeal and the risk are the same sentence. Build it yourself and point this command at the bridge.',
    capabilityId: 'community-revit-mcp',
    config: {
      binding: { transport: 'stdio', command: [`C:\\${TODO}\\RevitMcpBridge.exe`] },
      enabled: false,
      description: 'mcp-servers-for-revit (community, MIT) — can create, modify and delete elements',
      timeoutMs: TIMEOUT_MS,
      concurrency: 1,
    },
    placeholders: [
      {
        path: 'binding.command.0',
        label: 'Bridge executable',
        hint: 'The bridge you built from https://github.com/mcp-servers-for-revit/mcp-servers-for-revit. No signed installer exists; the path is yours. From macOS, run this on the Windows machine and reach it through the Remote Revit agent preset instead.',
      },
    ],
    evidence: [
      cite(
        'gh-mcp-servers-for-revit',
        'MIT, active (pushed 2026-04), C#, claims ~138 tools including create/modify/delete.',
      ),
      cite(
        'gh-revit-mcp-archived',
        'Its predecessor — the ecosystem flagship — was archived in 2026-02, about a year after launch. Budget for maintaining whatever you adopt here.',
      ),
    ],
  },
  {
    id: 'revit-mcp-ludattilo',
    logicalName: 'revit_ludattilo',
    label: 'LuDattilo/revit-mcp-server (community, MIT, write-capable)',
    description:
      'C#, MIT, active as of 2026-07, self-describing 80+ tools for Revit 2023–2026 — the option that covers the versions firms actually run, since the official server is Revit 2027 only.',
    capabilityId: 'community-revit-mcp',
    config: {
      binding: { transport: 'stdio', command: [`C:\\${TODO}\\RevitMcpServer.exe`] },
      enabled: false,
      description: 'LuDattilo/revit-mcp-server (community, MIT) — Revit 2023–2026, write-capable',
      timeoutMs: TIMEOUT_MS,
      concurrency: 1,
    },
    placeholders: [
      {
        path: 'binding.command.0',
        label: 'Server executable',
        hint: 'Built from https://github.com/LuDattilo/revit-mcp-server. Tool count and version coverage are the repository\'s own claims and were not verified by us.',
      },
    ],
    evidence: [
      cite(
        'gh-ludattilo-revit-mcp',
        'MIT, active (pushed 2026-07), C#, claims 80+ tools for Revit 2023–2026.',
      ),
    ],
  },
  {
    id: 'revit-mcp-demolinator',
    logicalName: 'revit_pyrevit',
    label: 'Demolinator/revit-mcp-server (community, MIT, via pyRevit)',
    description:
      'Python through pyRevit, MIT, active as of 2026-06, self-describing 48 tools for Revit 2024–2027. Note the licensing shape: pyRevit itself is GPL-3.0, but it lives on the Windows machine and Archspace links none of it.',
    capabilityId: 'community-revit-mcp',
    config: {
      binding: { transport: 'stdio', command: [`C:\\${TODO}\\revit-mcp-server.exe`] },
      enabled: false,
      description: 'Demolinator/revit-mcp-server (community, MIT, pyRevit) — Revit 2024–2027',
      timeoutMs: TIMEOUT_MS,
      concurrency: 1,
    },
    placeholders: [
      {
        path: 'binding.command.0',
        label: 'Server entry point',
        hint: 'However you launch the server from https://github.com/Demolinator/revit-mcp-server on the Windows machine — an executable, or a python interpreter plus a script as separate argv entries.',
      },
    ],
    evidence: [
      cite(
        'gh-demolinator-revit-mcp',
        'MIT, active (pushed 2026-06), Python via pyRevit, claims 48 tools for Revit 2024–2027.',
      ),
      cite(
        'gh-pyrevit',
        'pyRevit is GPL-3.0 — relevant if you distribute code linked against it, not for running this server on your own machine.',
      ),
    ],
  },
  {
    id: 'revit-mcp-archived',
    logicalName: 'revit_mcp_archived',
    label: 'revit-mcp (ARCHIVED — do not adopt)',
    description:
      'The original community flagship. MIT, archived in 2026-02, historical reference only. It is listed here so that finding it in a search result is not the first you hear of its status — it is permanently unavailable as a preset, on every platform.',
    capabilityId: 'community-revit-mcp',
    config: {
      binding: { transport: 'stdio', command: [`C:\\${TODO}\\revit-mcp.exe`] },
      enabled: false,
      description: 'ARCHIVED community server — unmaintained since 2026-02',
      timeoutMs: TIMEOUT_MS,
      concurrency: 1,
    },
    placeholders: [],
    hardBlock:
      'Archived 2026-02 and unmaintained. Use mcp-servers-for-revit (the successor fork) or one of the other MIT community servers instead.',
    evidence: [
      cite(
        'gh-revit-mcp-archived',
        'MIT, ARCHIVED 2026-02. Historical reference only.',
      ),
    ],
  },
];

/**
 * The presets, with availability resolved for the given host. Order is
 * deliberate: what works everywhere first, then the Windows-bound servers,
 * then the archived one last.
 */
export function revitPresets(platform: NodeJS.Platform): McpServerPreset[] {
  return SEEDS.map((seed) => {
    const capability = capabilityById(seed.capabilityId);
    // A seed pointing at an unknown capability is a programming error, not a
    // user-visible state; fail closed rather than shipping an unexplained preset.
    const resolved = capability
      ? resolveCapability(capability, platform)
      : { usableHere: false, reason: `Unknown capability "${seed.capabilityId}".` };
    const availability = seed.hardBlock
      ? { available: false, reason: seed.hardBlock }
      : resolved.usableHere
        ? { available: true }
        : { available: false, reason: resolved.reason };
    return {
      id: seed.id,
      logicalName: seed.logicalName,
      label: seed.label,
      description: seed.description,
      capabilityId: seed.capabilityId,
      config: structuredClone(seed.config),
      placeholders: seed.placeholders.map((p) => ({ ...p })),
      availability,
      evidence: seed.evidence.map((e) => ({ ...e })),
    };
  });
}

/** Executable shapes that only exist on Windows, whatever the user named them. */
const WINDOWS_EXECUTABLE = /\.(exe|bat|cmd|ps1)$/i;
const WINDOWS_DRIVE_PATH = /^[a-z]:[\\/]/i;
/** Product names specific enough that a match cannot be a coincidence. */
const WINDOWS_ONLY_SERVERS = ['revitmcpserver', 'revit 2027 mcp server', 'autocad and civil 3d mcp server'];

/**
 * Platform gate the app hands to `createMcpHost` as `supportCheck`.
 *
 * It only ever refuses stdio servers whose command could not run on this host
 * at all — a Windows executable, a drive-letter path, or one of the named
 * Autodesk Windows servers. HTTP bindings always pass: reaching a Windows
 * machine over the network is the entire point of the remote-agent story, and
 * refusing it here would break the one Revit path macOS has.
 */
export function mcpSupportCheck(
  platform: NodeJS.Platform,
): (name: string, config: McpServerConfig) => string | undefined {
  return (name, config) => {
    if (platform === 'win32') return undefined;
    if (config.binding.transport !== 'stdio') return undefined;
    const command = config.binding.command;
    const executable = command[0] ?? '';
    const joined = command.join(' ').toLowerCase();
    const windowsShaped =
      WINDOWS_EXECUTABLE.test(executable) ||
      WINDOWS_DRIVE_PATH.test(executable) ||
      WINDOWS_ONLY_SERVERS.some((marker) => joined.includes(marker));
    if (!windowsShaped) return undefined;
    return (
      `"${name}" launches a Windows executable (${executable}), and this machine is ${platform}. ` +
      'Revit and AutoCAD/Civil 3D are Windows applications and their MCP servers must run beside a live session, ' +
      'so this server cannot start here. Run it on a Windows machine and connect to it over MCP Streamable HTTP ' +
      '(the "Remote Revit agent" preset) instead — see docs/autodesk-revit.md.'
    );
  };
}
