/**
 * `createRuntime` — the claim that "it runs in CI" and "it runs in the app" are
 * one claim.
 *
 * runtime.ts exists to assemble, without Electron, the same registry
 * `packages/app/src/engine-child` assembles with it (ADR-0013 §1). Nothing
 * type-checks that equivalence: the two files are separate assemblies of the
 * same parts, and every way they can drift apart is silent. A node type that
 * only the app registers turns a colleague's workflow into an `unknown-type`
 * failure on the CI box; a lane cap the CLI forgets to derive turns a server
 * the user marked serial into a server called four times at once.
 *
 * So this file asserts the *shape of the assembly* rather than any one node:
 * which sources contribute node types, which settings become engine
 * configuration, and — the part that matters most for a blocking test lane —
 * what the runtime does **not** do on the way up. Building a runtime must not
 * dial an MCP server or reach the network (ADR-0009 §2, ADR-0013 §5); a suite
 * that quietly started spawning `uvx` would still pass, just slowly, until it
 * ran somewhere without a network.
 *
 * Every case builds against a temp config directory, never the developer's own.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { MCP_CONFIG_FILENAME } from '@archspace/mcp-host';
import { coreNodeTypes } from '@archspace/nodes-core';
import { createRuntime } from '../src/runtime.js';
import { captureConsole, cleanupTempDirs, closeTracked, tempDir, track } from './helpers.js';

afterEach(async () => {
  await closeTracked();
  await cleanupTempDirs();
});

const MCP_WITH_LANES = `servers:
  formats:
    transport: stdio
    command: ["uvx", "archspace-formats-server"]
    concurrency: 3
  slow_one:
    transport: stdio
    command: ["uvx", "archspace-slow-server"]
`;

describe('createRuntime — what ends up in the registry', () => {
  it('registers the whole core node set', async () => {
    // Against `coreNodeTypes()` rather than a pasted list, for the same reason
    // the nodes-core suite does: a copy of the roster is a copy that rots, and
    // the failure it would hide is "the CLI silently offers fewer nodes than
    // the app".
    const rt = track(await createRuntime({ configDir: await tempDir(), noPlugins: true }));

    const registered = rt.registry.manifests().map((m) => m.type);

    expect(registered.sort()).toEqual(coreNodeTypes());
  });

  it('registers no plugin nodes without consent, and says so by state', async () => {
    // The bundled `plugins/aec-review` is always discovered — it ships in the
    // workspace — so "no aec.review.* types" here is a statement about consent,
    // not about the plugin being absent. Both halves are asserted so the test
    // cannot pass by the plugin having quietly stopped existing.
    const rt = track(await createRuntime({ configDir: await tempDir() }));

    const discovered = rt.plugins?.list().map((p) => p.id) ?? [];
    const registered = rt.registry.manifests().map((m) => m.type);

    expect(discovered).toContain('aec-review');
    expect(registered.filter((t) => t.startsWith('aec.review.'))).toEqual([]);
  });

  it('skips the plugin host entirely under noPlugins', async () => {
    // `--no-plugins` is the "is a plugin the problem?" switch, so it has to be
    // the absence of the host, not a host with everything switched off — a
    // disabled plugin still gets discovered, parsed and namespaced.
    const rt = track(await createRuntime({ configDir: await tempDir(), noPlugins: true }));

    expect(rt.plugins).toBeNull();
    expect(rt.registry.manifests().map((m) => m.type).sort()).toEqual(coreNodeTypes());
  });
});

describe('createRuntime — settings that become engine configuration', () => {
  it('derives a lane cap for every server that names a concurrency, and only those', async () => {
    // `laneCaps` is handed straight to `startRun`. An entry that fails to
    // appear does not error — the engine just uses its own default — so the
    // symptom of losing this mapping is a server the user marked serial being
    // driven in parallel, seen only as intermittent failures from the server.
    const rt = track(
      await createRuntime({ configDir: await tempDir({ [MCP_CONFIG_FILENAME]: MCP_WITH_LANES }), noPlugins: true }),
    );

    // `slow_one` names no concurrency, and must NOT be given a cap here:
    // inventing one would freeze the engine's default at whatever this file
    // happened to think it was.
    expect(rt.laneCaps).toEqual({ 'mcp:formats': 3 });
  });

  it("carries the loader's issues onto the runtime, where doctor reads them", async () => {
    // `cmdRun` and `cmdDoctor` both print `rt.config.issues`. If the runtime
    // dropped them, a machine with a broken `mcp.yaml` would report a clean
    // bill of health and an empty server list.
    const dir = await tempDir({ [MCP_CONFIG_FILENAME]: 'servers: "not a mapping"\n' });

    const rt = track(await createRuntime({ configDir: dir, noPlugins: true }));

    expect(rt.config.dir).toBe(dir);
    expect(rt.config.issues).toHaveLength(1);
    expect(rt.config.issues[0]).toContain(MCP_CONFIG_FILENAME);
  });
});

describe('createRuntime — what it refuses to do on the way up', () => {
  it('configures MCP servers without dialling any of them', async () => {
    // ADR-0009 §2 (lazy connect) is what keeps ADR-0013's blocking lanes
    // offline: `archspace nodes` on a laptop with a Revit binding must not try
    // to reach the office. `idle` is the resting state that proves the binding
    // was accepted and the transport was never opened.
    const rt = track(
      await createRuntime({ configDir: await tempDir({ [MCP_CONFIG_FILENAME]: MCP_WITH_LANES }), noPlugins: true }),
    );

    expect(rt.mcp.list().map((s) => s.name).sort()).toEqual(['formats', 'slow_one']);
    expect(rt.mcp.list().map((s) => s.state)).toEqual(['idle', 'idle']);
    // No tools were fetched, so no MCP nodes were generated — the other half of
    // "nothing was dialled", stated where a reader can see the consequence.
    expect(rt.registry.manifests().filter((m) => m.type.startsWith('mcp.'))).toEqual([]);
  });

  it('installs the Autodesk platform gate, so a Windows-only server rests as unsupported', async () => {
    // runtime.ts passes `mcpSupportCheck(process.platform)` to the host. That
    // wiring is a cross-package claim nothing else in the repo covers: the
    // autodesk suite proves the gate is right, this proves the CLI installs it.
    // The expectation is a function of the platform because the gate is — on
    // Windows this binding is perfectly launchable.
    const dir = await tempDir({
      [MCP_CONFIG_FILENAME]: `servers:
  revit_local:
    transport: stdio
    command: ["C:\\\\Program Files\\\\RevitMcpServer\\\\RevitMcpServer.exe"]
`,
    });

    const rt = track(await createRuntime({ configDir: dir, noPlugins: true }));

    const status = rt.mcp.status('revit_local');
    expect(status?.state).toBe(process.platform === 'win32' ? 'idle' : 'unsupported');
    if (process.platform !== 'win32') {
      // The refusal has to name the way out, not just refuse — the autodesk
      // suite's central point, re-asserted here because this is the path an
      // operator actually hits.
      expect(status?.unsupportedReason).toContain('HTTP');
    }
  });

  it('builds quietly: nothing is printed unless something is wrong', async () => {
    // `archspace nodes --json` has to emit JSON and nothing else, and the run
    // transcript has to stay readable. Info and debug from the MCP and plugin
    // hosts are gated behind `--verbose` for exactly that reason.
    const captured = captureConsole();
    try {
      track(await createRuntime({ configDir: await tempDir({ [MCP_CONFIG_FILENAME]: MCP_WITH_LANES }) }));
    } finally {
      captured.restore();
    }

    expect(captured.lines).toEqual([]);
  });
});
