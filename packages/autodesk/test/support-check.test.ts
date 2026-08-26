/**
 * The platform gate — the one piece of this package that runs on every launch
 * (ARCHITECTURE §9.2; ADR-0001 decision 2; research §3).
 *
 * `mcpSupportCheck` is handed to `createMcpHost` as `supportCheck` by both
 * engine hosts (packages/cli/src/runtime.ts, packages/app/src/engine-child).
 * It has exactly two ways to be wrong, and they are not symmetric:
 *
 *   Refusing too little costs the user a confusing ENOENT from a spawn that
 *   never had a chance — annoying, recoverable.
 *   Refusing too much costs the user Revit. On macOS, MCP Streamable HTTP to a
 *   remote Windows agent is the *only* live-Revit path that exists (research
 *   §3, Option A); a gate that ever refuses an HTTP binding silently deletes
 *   the product's headline capability on its primary platform.
 *
 * So the suite is deliberately lopsided: the HTTP cases are asserted on every
 * platform and with deliberately Windows-flavoured URLs, and the stdio cases
 * assert not just refusal but that the refusal *names the way out*. A refusal
 * that does not point at the remote-agent path is the same failure as no
 * refusal at all — the user still ends up believing Revit is unavailable.
 */
import { describe, expect, it } from 'vitest';
import type { McpServerConfig } from '@archspace/mcp-host';
import { mcpSupportCheck } from '../src/index.js';

const stdio = (...command: string[]): McpServerConfig => ({
  binding: { transport: 'stdio', command },
  enabled: true,
});

const http = (url: string): McpServerConfig => ({
  binding: { transport: 'http', url, auth: 'oauth' },
  enabled: true,
});

/** Every platform the app can run on, plus the two that matter most. */
const NON_WINDOWS: NodeJS.Platform[] = ['darwin', 'linux'];

describe('mcpSupportCheck — HTTP is never refused', () => {
  // First, because it is the assertion with the highest cost of regression.
  it.each<NodeJS.Platform>(['darwin', 'linux', 'win32'])('allows Streamable HTTP on %s', (platform) => {
    const check = mcpSupportCheck(platform);
    // The shapes a real Revit agent takes: an office box, a Parallels VM on
    // the same Mac (research §3 Option B — the degenerate single-machine case
    // of Option A), and a loopback bridge during development.
    expect(check('revit', http('https://revit-agent.office.example:8443/mcp'))).toBeUndefined();
    expect(check('revit', http('https://windows-vm.local:3000/mcp'))).toBeUndefined();
    expect(check('revit', http('http://127.0.0.1:3000/mcp'))).toBeUndefined();
  });

  it('allows an HTTP binding even when the URL is as Windows-shaped as a URL gets', () => {
    // The gate must look at the transport, not at vocabulary. A bridge is
    // perfectly entitled to be called "RevitMCPServer" and live on a host named
    // after a drive; refusing it would refuse the remote-agent path itself.
    const check = mcpSupportCheck('darwin');
    expect(check('revit', http('https://revitmcpserver.example/mcp'))).toBeUndefined();
    expect(check('revit', http('https://example.test/Revit%202027%20MCP%20Server'))).toBeUndefined();
  });
});

describe('mcpSupportCheck — Windows-shaped stdio off Windows', () => {
  const windowsShaped: [label: string, config: McpServerConfig][] = [
    ['a .exe', stdio('C:\\Program Files\\Autodesk\\Revit 2027 MCP Server Technical Preview\\RevitMCPServer.exe')],
    ['a bare .exe with no path', stdio('server.exe')],
    ['an .EXE in any case', stdio('Server.EXE')],
    ['a .bat', stdio('C:\\tools\\start.bat')],
    ['a .cmd', stdio('start.cmd')],
    ['a .ps1', stdio('bridge.ps1')],
    // Isolates the drive-letter rule: no Windows file extension anywhere.
    ['a C:\\ drive path', stdio('C:\\tools\\bridge')],
    ['a drive path with forward slashes', stdio('D:/tools/bridge')],
    // Isolates the known-server rule: a POSIX launcher whose arguments name a
    // server that only exists beside a live Windows session.
    ['a known Windows-only Autodesk server named in argv', stdio('/usr/local/bin/launch', '--server', 'Revit 2027 MCP Server')],
    ['the AutoCAD/Civil 3D server named in argv', stdio('/usr/local/bin/launch', 'Autodesk AutoCAD and Civil 3D MCP Server')],
  ];

  for (const platform of NON_WINDOWS) {
    describe(platform, () => {
      const check = mcpSupportCheck(platform);

      it.each(windowsShaped)('refuses %s', (_label, config) => {
        expect(check('revit_2027', config)).toBeTypeOf('string');
      });

      it('explains why, and points at the remote-agent path', () => {
        const message = check('revit_2027', windowsShaped[0][1]);
        expect(message).toBeDefined();
        // Names the binding the user actually wrote, so the message is
        // findable in a mcp.yaml with a dozen servers.
        expect(message).toContain('revit_2027');
        expect(message).toContain('RevitMCPServer.exe');
        // Says which machine it is talking about, rather than "unsupported".
        expect(message).toContain(platform);
        // Says *why* — the reason is a fact about Revit, not about our code.
        expect(message).toMatch(/Windows applications/);
        expect(message).toMatch(/live session/);
        // And says what to do instead. Without this the user concludes that
        // Archspace cannot reach Revit from a Mac, which is false.
        expect(message).toContain('Streamable HTTP');
        expect(message).toContain('Remote Revit agent');
        expect(message).toContain('docs/autodesk-revit.md');
      });
    });
  }

  it('leaves genuinely portable stdio servers alone', () => {
    // The gate is about Windows-bound Autodesk servers, not about stdio. An
    // IFC or formats server launched with uvx/npx must still work on a Mac
    // (ARCHITECTURE §9.1's own example config does exactly this).
    const check = mcpSupportCheck('darwin');
    expect(check('formats', stdio('uvx', 'archspace-formats-server'))).toBeUndefined();
    expect(check('everything', stdio('npx', '-y', '@modelcontextprotocol/server-everything'))).toBeUndefined();
    expect(check('local', stdio('/opt/homebrew/bin/ifc-mcp', '--stdio'))).toBeUndefined();
  });

  it('does not crash on a degenerate command', () => {
    // parseMcpConfig already refuses an empty argv, so the gate never sees one
    // in practice; it must still be total, because a supportCheck that throws
    // takes the whole host down instead of one server.
    expect(mcpSupportCheck('darwin')('broken', stdio())).toBeUndefined();
  });
});

describe('mcpSupportCheck — on Windows', () => {
  const check = mcpSupportCheck('win32');

  it('refuses nothing at all', () => {
    // Windows is where every one of these servers is supposed to run. The gate
    // exists to explain a platform mismatch; on Windows there is none, and
    // deciding whether an executable is actually installed is the spawn's job,
    // not ours — guessing here would refuse servers that work.
    expect(check('revit_2027', stdio('C:\\Program Files\\Autodesk\\Revit 2027 MCP Server Technical Preview\\RevitMCPServer.exe'))).toBeUndefined();
    expect(check('autocad', stdio('C:\\Program Files\\Autodesk\\AcadMcp.exe'))).toBeUndefined();
    expect(check('revit_sparx', stdio('C:\\build\\RevitMcpBridge.exe'))).toBeUndefined();
    expect(check('formats', stdio('uvx', 'archspace-formats-server'))).toBeUndefined();
    expect(check('revit', http('https://revit-agent.office.example:8443/mcp'))).toBeUndefined();
  });
});

describe('mcpSupportCheck — the factory', () => {
  it('binds the platform once and holds no other state', () => {
    // The host calls the returned function per server, repeatedly, across
    // reconfigurations. It must be a pure function of (name, config).
    const check = mcpSupportCheck('darwin');
    const windows = stdio('C:\\tools\\bridge.exe');
    const first = check('a', windows);
    expect(check('b', http('https://example.test/mcp'))).toBeUndefined();
    expect(check('a', windows)).toBe(first);
  });

  it('is decided by the platform passed in, not by the host running the test', () => {
    // The app passes process.platform; the suite must be able to assert the
    // Windows branch from a Mac and the macOS branch from CI's Linux runner —
    // otherwise ADR-0013's "no Windows in CI" would make half of this file
    // untestable.
    const config = stdio('C:\\tools\\bridge.exe');
    expect(mcpSupportCheck('win32')('x', config)).toBeUndefined();
    expect(mcpSupportCheck('darwin')('x', config)).toBeTypeOf('string');
  });
});
