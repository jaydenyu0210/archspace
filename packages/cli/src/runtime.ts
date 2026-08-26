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
import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createMemoryAssetStore, createNodeRegistry, type NodeModule, type NodeRegistry } from '@archspace/node-sdk';
import { registerCoreNodes } from '@archspace/nodes-core';
import { createAiGateway, type ArchspaceAiGateway } from '@archspace/ai-gateway';
import { createMcpHost, type McpHost } from '@archspace/mcp-host';
import { createPluginHost, type PluginHost, type PluginProcess } from '@archspace/plugin-host';
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
}

/** The plugin child entry, resolved from this package rather than guessed. */
function pluginChildEntry(): string {
  return fileURLToPath(new URL('../../plugin-host/src/child.ts', import.meta.url));
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
      spawn: (childEntry, argv, opts): PluginProcess => {
        // The child entry is TypeScript in the workspace, so it is forked
        // through tsx — the same loader the rest of the repo's dev scripts use.
        const useTsx = childEntry.endsWith('.ts');
        const child = fork(childEntry, argv, {
          cwd: opts.cwd,
          env: opts.env,
          execArgv: useTsx ? ['--import', 'tsx'] : [],
          stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
        });
        child.stdout?.on('data', (chunk: Buffer) => log('info', `[plugin] ${chunk.toString().trimEnd()}`));
        child.stderr?.on('data', (chunk: Buffer) => log('warn', `[plugin] ${chunk.toString().trimEnd()}`));
        return {
          send: (message) => {
            if (child.connected) child.send(message);
          },
          onMessage: (cb) => child.on('message', cb),
          onExit: (cb) => child.on('exit', cb),
          kill: (signal) => child.kill(signal),
          get pid() {
            return child.pid;
          },
        };
      },
    });
    await plugins.discover();
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
