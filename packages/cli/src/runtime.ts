/**
 * The headless runtime: the same registry the desktop app builds, assembled
 * without Electron.
 *
 * Core nodes + plugin nodes + generated MCP tool nodes come together here
 * exactly as they do in `packages/app/src/engine-child`, which is what makes
 * "it runs in CI" and "it runs in the app" the same claim rather than two
 * hopeful ones (ADR-0013). Everything Electron-shaped is replaced by its plain
 * Node equivalent: `child_process.fork` for plugin processes, environment
 * variables for secrets, and no OAuth browser leg at all — an MCP server that
 * needs interactive authorization reports that fact instead of hanging.
 */
import { fileURLToPath } from 'node:url';
import { createMemoryAssetStore, createNodeRegistry, type NodeModule, type NodeRegistry } from '@archspace/node-sdk';
import { registerCoreNodes } from '@archspace/nodes-core';
import { createAiGateway, type ArchspaceAiGateway } from '@archspace/ai-gateway';
import { createMcpHost, type McpHost } from '@archspace/mcp-host';
import { createPluginHost, type PluginConsentState, type PluginHost } from '@archspace/plugin-host';
import { mcpSupportCheck } from '@archspace/autodesk';
import { cliSecrets, cliStrictSecrets, loadCliConfig, workspacePluginsDir, type CliConfig } from './config.js';

export interface Runtime {
  config: CliConfig;
  registry: NodeRegistry;
  assets: ReturnType<typeof createMemoryAssetStore>;
  ai: ArchspaceAiGateway;
  mcp: McpHost;
  plugins: PluginHost | null;
  laneCaps: Record<string, number>;
  close(): Promise<void>;
}

export interface RuntimeOptions {
  configDir?: string;
  /** Skip the plugin host entirely — for diagnosing whether a plugin is the problem. */
  noPlugins?: boolean;
  /** Verbosity for engine-side logs from MCP and plugin hosts. */
  verbose?: boolean;
  /**
   * Plugin ids to consent to for this invocation only (`--trust-plugin`).
   *
   * Consent is a decision a human makes, and ADR-0008 keeps it that way even
   * for a plugin declaring no permissions: "this code may run" is the first
   * decision. A headless run has no dialog to show, so the decision moves to
   * the command line — an operator typing the id *is* the consent, and CI's
   * checked-in workflow file is where that grant is reviewed.
   *
   * It is deliberately not persisted. Writing to `plugins.json` would let a
   * CI job silently widen what the desktop app trusts afterwards; the app's
   * consent store stays the only durable record.
   */
  trustPlugins?: readonly string[];
}

/** The plugin child entry, resolved from this package rather than guessed. */
function pluginChildEntry(): string {
  return fileURLToPath(new URL('../../plugin-host/src/child.ts', import.meta.url));
}

/**
 * Apply `--trust-plugin` grants on top of whatever `plugins.json` already said.
 *
 * This runs *after* `discover()` on purpose. A grant is for the permissions the
 * plugin actually declares, and only a discovered plugin has a parsed manifest
 * to read them from — granting a name blind would mean either inventing a
 * permission set or handing over a blanket one, and a blanket grant is exactly
 * the thing ADR-0008 §2 says a permission list exists to prevent.
 *
 * Every grant is printed unconditionally, not through `log` (which swallows
 * info unless `--verbose`). A security decision that only shows up in verbose
 * mode is a security decision nobody reads.
 */
async function trustNamedPlugins(
  plugins: PluginHost,
  existing: CliConfig['pluginConsent'],
  ids: readonly string[],
  log: (level: 'debug' | 'info' | 'warn' | 'error', message: string, data?: unknown) => void,
): Promise<void> {
  if (ids.length === 0) return;

  const installed = new Map(plugins.list().map((info) => [info.id, info]));
  const consent: PluginConsentState = {};
  for (const [id, entry] of Object.entries(existing)) {
    consent[id] = { enabled: entry.enabled, permissions: [...entry.permissions] };
  }

  for (const id of ids) {
    const info = installed.get(id);
    if (!info) {
      log('warn', `--trust-plugin "${id}": no such plugin is installed; ignoring`);
      continue;
    }
    const permissions = [...info.manifest.permissions];
    consent[id] = { enabled: true, permissions };
    console.log(
      `  trusting plugin "${id}" for this run — permissions granted: ${
        permissions.length === 0 ? '(none declared)' : permissions.join(', ')
      }`,
    );
  }

  await plugins.setConsent(consent);
}

export async function createRuntime(options: RuntimeOptions = {}): Promise<Runtime> {
  const config = await loadCliConfig(options.configDir);

  const log = (level: 'debug' | 'info' | 'warn' | 'error', message: string, data?: unknown): void => {
    if (!options.verbose && (level === 'debug' || level === 'info')) return;
    const stream = level === 'error' || level === 'warn' ? console.error : console.log;
    stream(`  [${level}] ${message}${data === undefined ? '' : ` ${JSON.stringify(data)}`}`);
  };

  const assets = createMemoryAssetStore();
  const ai = createAiGateway({ config: config.ai, secrets: cliSecrets });

  const mcp = createMcpHost({
    assets,
    secrets: cliSecrets,
    // Deliberately no OAuth delegate: a headless run cannot open a browser, so
    // an interactive-auth server must say "needs authorization in the app"
    // rather than block a CI job forever.
    log,
    supportCheck: mcpSupportCheck(process.platform),
  });
  await mcp.configure(config.mcp);

  let plugins: PluginHost | null = null;
  if (options.noPlugins !== true) {
    const bundled = workspacePluginsDir(import.meta.url);
    plugins = createPluginHost({
      bundledDirs: bundled === null ? [] : [bundled],
      userDir: `${config.dir}/plugins`,
      childEntry: pluginChildEntry(),
      consent: config.pluginConsent,
      capabilities: { assets, ai, secrets: cliStrictSecrets, fetchImpl: fetch },
      log,
      // No `spawn` override: the host's own `forkPluginSpawn` is the right
      // implementation and this file used to carry a worse copy of it. That
      // copy passed `execArgv: ['--import', 'tsx']`, and Node resolves a BARE
      // specifier against the CHILD's cwd — which the host sets to the plugin's
      // own directory. So `tsx` was found only for plugins that happened to sit
      // inside this workspace, and every plugin a user actually installs under
      // `<configDir>/plugins` died before its entry loaded, reported only as
      // "exited during startup (exit code 1)". `forkPluginSpawn` resolves
      // `tsx/esm` from the child ENTRY and passes an absolute file URL, which
      // works from any cwd; it also forwards stdout and stderr to this `log`.
    });
    await plugins.discover();
    await trustNamedPlugins(plugins, config.pluginConsent, options.trustPlugins ?? [], log);
  }

  const registry = createNodeRegistry();
  registerCoreNodes(registry);
  const dynamic: NodeModule[] = [...(plugins?.nodeModules() ?? []), ...mcp.nodeModules()];
  for (const mod of dynamic) {
    try {
      registry.register(mod as NodeModule<unknown>);
    } catch (err) {
      log('warn', `could not register "${mod.manifest.type}": ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  const laneCaps: Record<string, number> = {};
  for (const [name, server] of Object.entries(config.mcp.servers)) {
    if (server.concurrency !== undefined) laneCaps[`mcp:${name}`] = server.concurrency;
  }

  return {
    config,
    registry,
    assets,
    ai,
    mcp,
    plugins,
    laneCaps,
    async close() {
      await Promise.allSettled([mcp.close(), plugins?.close() ?? Promise.resolve()]);
    },
  };
}
