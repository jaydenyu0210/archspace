/**
 * Engine host — runs inside an Electron utilityProcess (ARCHITECTURE §3.2).
 * A crash here never takes down the UI; main supervises and restarts us.
 *
 * This process owns everything that executes: the node registry, the session
 * asset store and run cache, the AI gateway (§10), the MCP client pool (§9.2)
 * and the plugin host (§8). It owns none of the things that require an OS
 * identity — no keychain, no browser, no settings files — so it asks main for
 * those over a second, private "control" port and never touches them directly.
 *
 * The registry is REBUILT rather than mutated whenever the node set changes
 * (a plugin loads, an MCP server connects). `@archspace/node-sdk`'s registry
 * is deliberately append-only and refuses duplicates, which is the right
 * behaviour for a set that is supposed to be a fixed snapshot; the run in
 * flight keeps the registry it started with, so a server connecting mid-run
 * cannot change what that run is executing.
 */
import { join } from 'node:path';
import { fork } from 'node:child_process';
import { createMemoryAssetStore, createNodeRegistry, type NodeModule, type NodeRegistry } from '@archspace/node-sdk';
import { registerCoreNodes } from '@archspace/nodes-core';
import { createRunCache, startRun, validateGraph, GraphValidationError, type RunHandle } from '@archspace/engine';
import { createAiGateway, defaultAiConfig, type ArchspaceAiGateway } from '@archspace/ai-gateway';
import { createMcpHost, type McpHost, type McpServerStatus } from '@archspace/mcp-host';
import { createPluginHost, type InstalledPluginInfo, type PluginHost, type PluginProcess, type PluginSpawn } from '@archspace/plugin-host';
import { mcpSupportCheck } from '@archspace/autodesk';
import type { MessagePortMain } from 'electron';
import {
  OAUTH_REDIRECT_URI,
  type EngineControlEvent,
  type EngineControlRequest,
  type EnginePaths,
  type EngineRequest,
  type EngineResponse,
  type OAuthStoreSlot,
} from '../shared/protocol';

// ---------------------------------------------------------------------------
// Ports
// ---------------------------------------------------------------------------

let rendererPort: MessagePortMain | null = null;
let controlPort: MessagePortMain | null = null;

function toRenderer(msg: EngineResponse): void {
  rendererPort?.postMessage(msg);
}
function toMain(msg: EngineControlEvent): void {
  controlPort?.postMessage(msg);
}

// ---------------------------------------------------------------------------
// Control-channel RPC: secrets and OAuth live in main, so we ask for them
// ---------------------------------------------------------------------------

type Pending = { resolve: (value: never) => void; reject: (err: Error) => void };
const pending = new Map<number, Pending>();
let controlSeq = 0;

function controlCall<T>(send: (requestId: number) => void): Promise<T> {
  const requestId = ++controlSeq;
  return new Promise<T>((resolve, reject) => {
    if (controlPort === null) {
      reject(new Error('the engine is not connected to the main process yet'));
      return;
    }
    pending.set(requestId, { resolve: resolve as (value: never) => void, reject });
    send(requestId);
  });
}

function settleControl(requestId: number, value: unknown, error?: string): void {
  const entry = pending.get(requestId);
  if (entry === undefined) return;
  pending.delete(requestId);
  if (error !== undefined) entry.reject(new Error(error));
  else entry.resolve(value as never);
}

const secrets = {
  async get(key: string): Promise<string | undefined> {
    return controlCall<string | undefined>((requestId) => toMain({ t: 'secret-request', requestId, key }));
  },
};

/** The strict form nodes see: an unresolvable key is an error, not `undefined`. */
const strictSecrets = {
  async get(key: string): Promise<string> {
    const value = await secrets.get(key);
    if (value === undefined) {
      throw new Error(`secret "${key}" is not set — add it in Settings → Secrets`);
    }
    return value;
  },
};

const oauthDelegate = {
  async authorize(server: string, authorizationUrl: string): Promise<{ code: string; state?: string }> {
    return controlCall<{ code: string; state?: string }>((requestId) =>
      toMain({ t: 'oauth-request', requestId, server, authorizationUrl, redirectUri: OAUTH_REDIRECT_URI }),
    );
  },
  async read(server: string, slot: OAuthStoreSlot): Promise<string | null> {
    return controlCall<string | null>((requestId) => toMain({ t: 'oauth-store-read', requestId, server, slot }));
  },
  async write(server: string, slot: OAuthStoreSlot, json: string | null): Promise<void> {
    await controlCall<void>((requestId) => toMain({ t: 'oauth-store-write', requestId, server, slot, json }));
  },
};

// ---------------------------------------------------------------------------
// Session services
// ---------------------------------------------------------------------------

// Session-scoped: memoized pure results and produced assets survive across
// runs while the app is open. Stands in for the persistent CAS of §11.
const cache = createRunCache();
const assets = createMemoryAssetStore();

const ai: ArchspaceAiGateway = createAiGateway({ config: defaultAiConfig(), secrets });

const log = (level: 'debug' | 'info' | 'warn' | 'error', message: string, data?: unknown): void => {
  const line = `[engine] ${message}`;
  if (level === 'error') console.error(line, data ?? '');
  else if (level === 'warn') console.warn(line, data ?? '');
  else console.log(line, data ?? '');
};

const mcp: McpHost = createMcpHost({
  assets,
  secrets,
  oauth: oauthDelegate,
  log,
  // Autodesk's local servers require a live Revit/AutoCAD session, which is
  // Windows-only (research §3). Gating here means the server reports
  // "unsupported" with the real reason instead of failing as a broken command.
  supportCheck: mcpSupportCheck(process.platform),
});

let plugins: PluginHost | null = null;
let paths: EnginePaths | null = null;

/**
 * Forking from inside a utilityProcess: `utilityProcess` itself is a
 * main-process API, so a plugin child is a plain `child_process.fork` of the
 * Electron binary with ELECTRON_RUN_AS_NODE=1 — the documented way to get a
 * Node runtime out of a shipped Electron app without bundling a second one.
 */
function electronSpawn(execPath: string): PluginSpawn {
  return (childEntry, argv, opts): PluginProcess => {
    const child = fork(childEntry, argv, {
      cwd: opts.cwd,
      execPath,
      env: { ...opts.env, ELECTRON_RUN_AS_NODE: '1' },
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
  };
}

// ---------------------------------------------------------------------------
// The registry: core nodes + plugin nodes + generated MCP nodes
// ---------------------------------------------------------------------------

let registry: NodeRegistry = buildRegistry();

function buildRegistry(): NodeRegistry {
  const next = createNodeRegistry();
  registerCoreNodes(next);

  const dynamic: NodeModule[] = [...(plugins?.nodeModules() ?? []), ...mcp.nodeModules()];
  for (const mod of dynamic) {
    try {
      next.register(mod as NodeModule<unknown>);
    } catch (err) {
      // A colliding or malformed dynamic node must not cost us the whole
      // registry — the rest of the app keeps working and the reason is logged
      // against the offending type.
      log('warn', `could not register "${mod.manifest.type}": ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return next;
}

function refreshRegistry(): void {
  registry = buildRegistry();
  toRenderer({ t: 'manifests', manifests: registry.manifests(), schemaHashes: mcp.toolSchemaHashes() });
}

function pushMcpStatus(servers: McpServerStatus[]): void {
  toRenderer({ t: 'mcp-status', servers });
  toMain({ t: 'mcp-status', servers });
}

function pushPluginStatus(list: InstalledPluginInfo[]): void {
  toRenderer({ t: 'plugin-status', plugins: list });
  toMain({ t: 'plugin-status', plugins: list });
}

mcp.onChange((servers) => {
  refreshRegistry();
  pushMcpStatus(servers);
});

// ---------------------------------------------------------------------------
// Runs
// ---------------------------------------------------------------------------

const runs = new Map<string, RunHandle>();

/**
 * Lane caps: every `mcp:<server>` lane is serial by default because a stdio
 * server is one process of unknown reentrancy (§7.2). A server the user has
 * told us is safe to parallelise raises its own cap and nothing else's.
 */
function laneCaps(): Record<string, number> {
  const caps: Record<string, number> = {};
  for (const server of mcp.list()) {
    const configured = mcpConcurrency.get(server.name);
    if (configured !== undefined) caps[`mcp:${server.name}`] = configured;
  }
  return caps;
}
const mcpConcurrency = new Map<string, number>();

// ---------------------------------------------------------------------------
// Renderer channel
// ---------------------------------------------------------------------------

function wireRenderer(port: MessagePortMain): void {
  rendererPort = port;

  port.on('message', (e) => {
    const msg = e.data as EngineRequest;
    void handleRendererMessage(msg);
  });

  port.start();
}

async function handleRendererMessage(msg: EngineRequest): Promise<void> {
  switch (msg.t) {
    case 'hello':
      toRenderer({ t: 'manifests', manifests: registry.manifests(), schemaHashes: mcp.toolSchemaHashes() });
      pushMcpStatus(mcp.list());
      if (plugins !== null) pushPluginStatus(plugins.list());
      toRenderer({ t: 'ai-status', profiles: await ai.listProfiles() });
      break;

    case 'validate':
      toRenderer({ t: 'validated', requestId: msg.requestId, issues: validateGraph(msg.graph, registry) });
      break;

    case 'run': {
      try {
        const handle = startRun(msg.graph, {
          registry,
          runId: msg.runId,
          cache,
          assets,
          ai,
          laneCaps: laneCaps(),
        });
        runs.set(msg.runId, handle);
        handle.onEvent((event) => toRenderer({ t: 'event', runId: msg.runId, event }));
        void handle.done.then(() => runs.delete(msg.runId));
      } catch (err) {
        toRenderer({
          t: 'run-rejected',
          runId: msg.runId,
          issues:
            err instanceof GraphValidationError
              ? err.issues
              : [{ severity: 'error', code: 'engine', message: err instanceof Error ? err.message : String(err) }],
        });
      }
      break;
    }

    case 'cancel':
      runs.get(msg.runId)?.cancel();
      break;

    case 'mcp-status':
      pushMcpStatus(mcp.list());
      break;

    case 'mcp-connect':
      await respond(msg.requestId, 'mcp-result', async () => {
        await mcp.connect(msg.name);
      });
      break;

    case 'mcp-disconnect':
      await respond(msg.requestId, 'mcp-result', async () => {
        await mcp.disconnect(msg.name);
      });
      break;

    case 'mcp-refresh':
      await respond(msg.requestId, 'mcp-result', async () => {
        await mcp.refresh(msg.name);
      });
      break;

    case 'plugin-status':
      if (plugins !== null) pushPluginStatus(plugins.list());
      break;

    case 'plugin-set-enabled':
      await respond(msg.requestId, 'plugin-result', async () => {
        if (plugins === null) throw new Error('the plugin host is not ready yet');
        const current = plugins.list().find((p) => p.id === msg.id);
        if (current === undefined) throw new Error(`no installed plugin with id "${msg.id}"`);
        // Consent is main's to persist; the engine only applies what it is told,
        // so it asks main to write and waits for the config push to come back.
        await plugins.setConsent({
          ...Object.fromEntries(
            plugins.list().map((p) => [p.id, { enabled: p.state !== 'disabled', permissions: p.grantedPermissions }]),
          ),
          [msg.id]: { enabled: msg.enabled, permissions: current.grantedPermissions },
        });
        refreshRegistry();
        pushPluginStatus(plugins.list());
      });
      break;

    case 'plugin-reload':
      await respond(msg.requestId, 'plugin-result', async () => {
        if (plugins === null) throw new Error('the plugin host is not ready yet');
        await plugins.reload();
        refreshRegistry();
        pushPluginStatus(plugins.list());
      });
      break;

    case 'ai-status':
      toRenderer({ t: 'ai-status', profiles: await ai.listProfiles() });
      break;

    case 'ai-probe':
      toRenderer({ t: 'ai-probe-result', requestId: msg.requestId, result: await ai.probe(msg.profile) });
      break;
  }
}

async function respond(
  requestId: number,
  kind: 'mcp-result' | 'plugin-result',
  work: () => Promise<void>,
): Promise<void> {
  try {
    await work();
    toRenderer({ t: kind, requestId, ok: true });
  } catch (err) {
    toRenderer({ t: kind, requestId, ok: false, error: err instanceof Error ? err.message : String(err) });
  }
}

// ---------------------------------------------------------------------------
// Control channel
// ---------------------------------------------------------------------------

function wireControl(port: MessagePortMain): void {
  controlPort = port;

  port.on('message', (e) => {
    const msg = e.data as EngineControlRequest;
    void handleControlMessage(msg);
  });

  port.start();
  toMain({ t: 'ready' });
}

async function handleControlMessage(msg: EngineControlRequest): Promise<void> {
  switch (msg.t) {
    case 'init':
      paths = msg.paths;
      break;

    case 'config': {
      ai.reconfigure(msg.ai);
      toRenderer({ t: 'ai-status', profiles: await ai.listProfiles() });

      mcpConcurrency.clear();
      for (const [name, server] of Object.entries(msg.mcp.servers)) {
        if (server.concurrency !== undefined) mcpConcurrency.set(name, server.concurrency);
      }
      await mcp.configure(msg.mcp);

      if (paths !== null) {
        if (plugins === null) {
          plugins = createPluginHost({
            bundledDirs: paths.bundledPluginDirs,
            userDir: paths.userPluginsDir,
            childEntry: paths.pluginChildEntry,
            spawn: electronSpawn(paths.execPath),
            consent: msg.pluginConsent,
            capabilities: { assets, ai, secrets: strictSecrets, fetchImpl: fetch },
            log,
          });
          plugins.onChange((list) => {
            refreshRegistry();
            pushPluginStatus(list);
          });
          await plugins.discover();
        } else {
          await plugins.setConsent(msg.pluginConsent);
        }
        pushPluginStatus(plugins.list());
      }

      refreshRegistry();
      pushMcpStatus(mcp.list());
      break;
    }

    case 'secret-result':
      settleControl(msg.requestId, msg.value, msg.error);
      break;

    case 'oauth-result':
      settleControl(msg.requestId, msg.ok ? { code: msg.code, state: msg.state } : undefined, msg.ok ? undefined : (msg.error ?? 'authorization failed'));
      break;

    case 'oauth-store-result':
      settleControl(msg.requestId, msg.json ?? null, msg.ok ? undefined : (msg.error ?? 'token store failed'));
      break;
  }
}

// ---------------------------------------------------------------------------
// Port handover from main
// ---------------------------------------------------------------------------

process.parentPort.on('message', (e) => {
  const port = e.ports[0];
  if (port === undefined) return;
  const kind = (e.data as { type?: string } | null)?.type;
  if (kind === 'control') wireControl(port);
  else wireRenderer(port);
});

/**
 * Graceful teardown: the SDK's spec shutdown for each MCP transport and the
 * documented kill ladder for each plugin. This is the path that should run.
 */
async function shutdown(): Promise<void> {
  await Promise.allSettled([mcp.close(), plugins?.close() ?? Promise.resolve()]);
}

/**
 * The last resort, and the reason it is not simply `shutdown()`.
 *
 * Node runs `exit` handlers SYNCHRONOUSLY and terminates the moment they
 * return: a promise started inside one never settles. This handler used to call
 * `void shutdown()`, which read as cleanup and did nothing at all — every stdio
 * MCP server and every plugin process was orphaned, and an orphan reparents to
 * init and outlives the login session. Signalling pids is the only kind of
 * cleanup available here, so that is what it does.
 *
 * SIGKILL rather than SIGTERM: by the time this runs there is no event loop
 * left to observe a graceful exit, so a polite signal would just be a signal
 * nobody waits for. Anything that deserved a graceful shutdown got one on the
 * SIGTERM path below.
 */
process.on('exit', () => {
  for (const pid of [...mcp.childPids(), ...(plugins?.childPids() ?? [])]) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // Already gone, or never ours. Either way there is nothing to reap and
      // nothing useful to report — the process is one statement from exiting.
    }
  }
});

process.on('SIGTERM', () => {
  void shutdown().finally(() => process.exit(0));
});

export const pluginChildEntryName = (dir: string): string => join(dir, 'plugin-child.js');
