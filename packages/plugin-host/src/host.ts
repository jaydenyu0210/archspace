/**
 * @archspace/plugin-host — one OS process per installed plugin, a
 * capability-scoped context, and no ambient authority (ARCHITECTURE §8,
 * ADR-0008).
 *
 * **Honesty clause, repeated here because it belongs where the code is:
 * v1's boundary is fault isolation plus permission mediation, NOT a hardened
 * security sandbox.** A malicious native dependency inside a plugin process can
 * do anything the app's user can do — the process runs with the user's own
 * authority, and nothing here revokes `node:fs`. What this file does buy is
 * real and testable: a plugin that crashes, hangs, or segfaults fails exactly
 * one node while the app stays healthy; a plugin only ever *receives* the
 * capabilities its manifest declares and the user granted; and cancellation is
 * honest, because it ends in a kill. OS-level sandboxing (seatbelt profiles) is
 * the documented next milestone, and it is reachable only because we are
 * already out of process.
 *
 * Shape notes:
 *
 *  - Loading is lazy per call but discovery is eager: `discover()` starts each
 *    consented plugin once, because the node palette cannot be drawn without
 *    asking the plugin what nodes it has. After a crash the restart is lazy —
 *    the next `execute` brings the process back, which is what makes crash
 *    containment invisible to the user rather than merely survivable.
 *  - Capabilities split by whose truth they are. `secrets`, `ai` and `fetch`
 *    are host-level and come from `HostCapabilities`, because they are mediated
 *    against consent, which is host state. `assets` follows the *run*: an
 *    `AssetRef` is only resolvable in the store that minted it, so a host-call
 *    is serviced from the calling node's `ctx.assets`, with the host store as
 *    the fallback for calls that belong to no run.
 *  - Consent is also the enable switch. A plugin with no consent record is
 *    `needs-consent`, even one that declares no permissions at all: "this code
 *    may run" is itself the first decision the user makes.
 */
import { readFile, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type {
  AiGateway,
  AssetRef,
  AssetStore,
  Inputs,
  NodeContext,
  NodeManifest,
  NodeModule,
  Outputs,
  Value,
} from '@archspace/node-sdk';
import { markRetryable } from '@archspace/node-sdk';
import { containsNativeCode } from './native.js';
import {
  ENGINE_API,
  PLUGIN_MANIFEST_FILENAME,
  entryPath,
  parsePluginManifest,
  pluginChildEnv,
  secretKeyOf,
  type ConfigIssue,
  type PluginManifest,
} from './manifest.js';
import {
  PLUGIN_RPC_VERSION,
  fromBase64,
  isChildToHost,
  toBase64,
  type AiEmbedArgs,
  type AiObjectArgs,
  type AiTextArgs,
  type AssetBytesArgs,
  type AssetPutArgs,
  type ChildToHost,
  type FetchArgs,
  type FetchResult,
  type HostCallMethod,
  type SecretGetArgs,
} from './protocol.js';
import { forkPluginSpawn, type PluginProcess, type PluginSpawn } from './spawn.js';

export type { PluginProcess, PluginSpawn, PluginSpawnOptions } from './spawn.js';

export type PluginState = 'loaded' | 'disabled' | 'needs-consent' | 'failed' | 'incompatible';

export interface InstalledPluginInfo {
  id: string;
  dir: string;
  source: 'bundled' | 'user';
  state: PluginState;
  manifest: PluginManifest;
  grantedPermissions: string[];
  nodeTypes: string[];
  error?: string;
  containsNativeCode: boolean;
  restarts: number;
}

export interface PluginConsent {
  enabled: boolean;
  permissions: string[];
  /** Stamped by `setConsent` so a version bump re-arms consent (ADR-0008 §2).
   *  Absent means the record predates the stamp and is honoured as given —
   *  the alternative, treating every un-stamped record as revoked, would nag
   *  users for a bookkeeping detail they never saw. */
  version?: string;
  engineApi?: number;
}
export type PluginConsentState = Record<string, PluginConsent>;

export interface HostCapabilities {
  assets: AssetStore;
  ai: AiGateway;
  secrets: { get(key: string): Promise<string> };
  /** Only handed to plugins granted 'net'. */
  fetchImpl?: typeof fetch;
}

export interface PluginHost {
  discover(): Promise<InstalledPluginInfo[]>;
  reload(): Promise<InstalledPluginInfo[]>;
  list(): InstalledPluginInfo[];
  setConsent(state: PluginConsentState): Promise<void>;
  nodeModules(): NodeModule[];
  /**
   * PIDs of live plugin processes, for a SYNCHRONOUS last-resort reap.
   *
   * `close()` is the correct shutdown and runs the documented cancel → SIGTERM
   * → SIGKILL ladder; this exists only for Node's `exit` event, which must be
   * synchronous. A promise started there never settles, so `close()` cannot run
   * on that path and every plugin process would be orphaned.
   */
  childPids(): number[];
  onChange(cb: (plugins: InstalledPluginInfo[]) => void): () => void;
  close(): Promise<void>;
}

export type HostLog = (level: 'debug' | 'info' | 'warn' | 'error', message: string, data?: unknown) => void;

export interface CreatePluginHostOptions {
  bundledDirs?: string[];
  userDir: string;
  childEntry: string;
  spawn?: PluginSpawn;
  consent: PluginConsentState;
  capabilities: HostCapabilities;
  log?: HostLog;
  killGraceMs?: number;
  /** How long a plugin gets to import its entry and report its nodes. */
  startTimeoutMs?: number;
}

const DEFAULT_KILL_GRACE_MS = 5_000;
const DEFAULT_START_TIMEOUT_MS = 20_000;
/** After SIGTERM, this long before SIGKILL. Short on purpose: by this point the
 *  plugin has already ignored both a cancel message and a term signal. */
const SIGKILL_DELAY_MS = 1_000;

// ---------------------------------------------------------------------------
// Per-plugin supervised process
// ---------------------------------------------------------------------------

interface PendingExec {
  ctx: NodeContext;
  nodeType: string;
  resolve(outputs: Outputs): void;
  reject(error: Error): void;
  settled: boolean;
  cleanup(): void;
}

type HostCallService = (method: HostCallMethod, args: unknown, ctx: NodeContext | undefined) => Promise<unknown>;

interface RuntimeOptions {
  pluginId: string;
  namespace: string;
  entry: string;
  dir: string;
  permissions: string[];
  childEntry: string;
  spawn: PluginSpawn;
  service: HostCallService;
  log: HostLog;
  killGraceMs: number;
  startTimeoutMs: number;
  onUnexpectedExit(code: number | null, signal: string | null): void;
}

class PluginRuntime {
  manifests: NodeManifest[] = [];
  private proc: PluginProcess | undefined;
  private starting: Promise<NodeManifest[]> | undefined;
  private pending = new Map<number, PendingExec>();
  private nextExecId = 1;
  private stopping = false;

  constructor(private readonly opts: RuntimeOptions) {}

  get pid(): number | undefined {
    return this.proc?.pid;
  }

  get running(): boolean {
    return this.proc !== undefined;
  }

  start(): Promise<NodeManifest[]> {
    if (this.starting) return this.starting;
    this.starting = this.spawnAndLoad().catch((err: unknown) => {
      this.starting = undefined;
      throw err;
    });
    return this.starting;
  }

  private spawnAndLoad(): Promise<NodeManifest[]> {
    const { opts } = this;
    return new Promise<NodeManifest[]>((resolveStart, rejectStart) => {
      // Not `process.env` verbatim: `pluginChildEnv` withholds the secret
      // namespace, which a child would otherwise inherit before it ran a line.
      const env = pluginChildEnv(process.env);
      // Marked so a plugin (and anyone reading `ps`) can tell what it is.
      env.ARCHSPACE_PLUGIN_ID = opts.pluginId;

      const proc = opts.spawn(opts.childEntry, ['--archspace-plugin', opts.pluginId], { cwd: opts.dir, env });
      this.proc = proc;
      this.stopping = false;

      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        this.stopping = true;
        proc.kill('SIGKILL');
        rejectStart(new Error(`plugin "${opts.pluginId}" did not report its nodes within ${opts.startTimeoutMs}ms`));
      }, opts.startTimeoutMs);
      timer.unref?.();

      proc.onStderr?.((text) => {
        const trimmed = text.trimEnd();
        if (trimmed.length > 0) opts.log('warn', `[plugin ${opts.pluginId}] ${trimmed}`);
      });

      const handleChildMessage = (raw: unknown): void => {
        if (!isChildToHost(raw)) return;
        if (raw.t === 'ready') {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          if (raw.v !== PLUGIN_RPC_VERSION) {
            this.stopping = true;
            proc.kill();
            rejectStart(new Error(`plugin "${opts.pluginId}" speaks RPC v${raw.v}; this build speaks v${PLUGIN_RPC_VERSION}`));
            return;
          }
          const offending = raw.manifests.find((m) => !isInNamespace(m.type, opts.namespace));
          if (offending) {
            this.stopping = true;
            proc.kill();
            rejectStart(
              new Error(
                `plugin "${opts.pluginId}" registers node type "${offending.type}", which is outside its namespace "${opts.namespace}."`,
              ),
            );
            return;
          }
          this.manifests = raw.manifests;
          resolveStart(raw.manifests);
          return;
        }
        if (raw.t === 'load-error') {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          this.stopping = true;
          proc.kill();
          rejectStart(new Error(`plugin "${opts.pluginId}" failed to load: ${raw.message}`));
          return;
        }
        this.onChildMessage(raw);
      };

      // Second line of defence behind `isChildToHost`. That guard checks the
      // shape of what a plugin sends; this catches everything that could still
      // throw while acting on a well-shaped message — a capability service that
      // rejects synchronously, a log sink that dies. Either way the exception
      // arrives on a `message` listener, where an escape is an uncaught
      // exception in the engine child, and containment (ADR-0008) means the
      // plugin fails, not the process that hosts every other plugin.
      proc.onMessage((raw) => {
        try {
          handleChildMessage(raw);
        } catch (err) {
          opts.log('error', `[plugin ${opts.pluginId}] host failed while handling a plugin message: ${String(err)}`);
          this.stopping = true;
          proc.kill();
          if (!settled) {
            settled = true;
            clearTimeout(timer);
            rejectStart(new Error(`plugin "${opts.pluginId}" sent a message this host could not handle: ${String(err)}`));
          }
        }
      });

      proc.onExit((code, signal) => {
        const wasStopping = this.stopping;
        this.proc = undefined;
        this.starting = undefined;
        const reason = signal !== null ? `signal ${signal}` : `exit code ${String(code)}`;
        // Every exec still in flight dies with the process. Each becomes one
        // failed node — the containment promise of ADR-0008 in three lines.
        for (const [, exec] of this.pending) {
          exec.settled = true;
          exec.cleanup();
          exec.reject(
            new Error(
              `plugin "${opts.pluginId}" exited (${reason}) while running "${exec.nodeType}" — the plugin restarts on the next call`,
            ),
          );
        }
        this.pending.clear();
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          rejectStart(new Error(`plugin "${opts.pluginId}" exited during startup (${reason})`));
        }
        if (!wasStopping) opts.onUnexpectedExit(code, signal);
      });

      proc.send({
        t: 'init',
        v: PLUGIN_RPC_VERSION,
        pluginId: opts.pluginId,
        namespace: opts.namespace,
        entry: opts.entry,
        permissions: opts.permissions,
      });
    });
  }

  private onChildMessage(message: ChildToHost): void {
    switch (message.t) {
      case 'log': {
        const exec = this.pending.get(message.id);
        if (message.data === undefined) exec?.ctx.log(message.level, message.message);
        else exec?.ctx.log(message.level, message.message, message.data);
        return;
      }
      case 'progress': {
        this.pending.get(message.id)?.ctx.progress(message.fraction, message.message);
        return;
      }
      case 'host-call': {
        const exec = this.pending.get(message.id);
        void this.opts
          .service(message.method, message.args, exec?.ctx)
          .then((value) => this.proc?.send({ t: 'host-result', callId: message.callId, ok: true, value }))
          .catch((err: unknown) =>
            this.proc?.send({
              t: 'host-result',
              callId: message.callId,
              ok: false,
              error: err instanceof Error ? err.message : String(err),
            }),
          );
        return;
      }
      case 'result': {
        const exec = this.pending.get(message.id);
        if (!exec || exec.settled) return;
        exec.settled = true;
        this.pending.delete(message.id);
        exec.cleanup();
        exec.resolve(message.outputs);
        return;
      }
      case 'error': {
        const exec = this.pending.get(message.id);
        if (!exec || exec.settled) return;
        exec.settled = true;
        this.pending.delete(message.id);
        exec.cleanup();
        const error = new Error(message.message);
        exec.reject(message.retryable ? markRetryable(error) : error);
        return;
      }
      default:
        return;
    }
  }

  async execute(nodeType: string, ctx: NodeContext, inputs: Inputs, params: unknown): Promise<Outputs> {
    await this.start();
    const proc = this.proc;
    if (!proc) throw new Error(`plugin "${this.opts.pluginId}" is not running`);

    const id = this.nextExecId++;
    return new Promise<Outputs>((resolveExec, rejectExec) => {
      let termTimer: NodeJS.Timeout | undefined;
      let killTimer: NodeJS.Timeout | undefined;

      const cleanup = (): void => {
        ctx.signal.removeEventListener('abort', onAbort);
        if (termTimer) clearTimeout(termTimer);
        if (killTimer) clearTimeout(killTimer);
      };

      // Cancellation ladder (§7.4): ask, then insist, then stop asking.
      const onAbort = (): void => {
        proc.send({ t: 'cancel', id });
        termTimer = setTimeout(() => {
          this.opts.log('warn', `plugin "${this.opts.pluginId}" ignored cancel for "${nodeType}" — sending SIGTERM`);
          proc.kill('SIGTERM');
          killTimer = setTimeout(() => proc.kill('SIGKILL'), SIGKILL_DELAY_MS);
          killTimer.unref?.();
        }, this.opts.killGraceMs);
        termTimer.unref?.();
      };

      this.pending.set(id, { ctx, nodeType, resolve: resolveExec, reject: rejectExec, settled: false, cleanup });
      if (ctx.signal.aborted) onAbort();
      else ctx.signal.addEventListener('abort', onAbort, { once: true });

      proc.send({
        t: 'exec',
        id,
        nodeType,
        runId: ctx.runId,
        nodeId: ctx.nodeId,
        inputs: inputs as Record<string, Value>,
        params: params as Value,
      });
    });
  }

  async stop(): Promise<void> {
    const proc = this.proc;
    if (!proc) return;
    this.stopping = true;
    const exited = new Promise<void>((done) => proc.onExit(() => done()));
    proc.send({ t: 'shutdown' });
    const timer = setTimeout(() => proc.kill('SIGKILL'), this.opts.killGraceMs);
    timer.unref?.();
    await exited;
    clearTimeout(timer);
    this.proc = undefined;
    this.starting = undefined;
  }
}

function isInNamespace(nodeType: string, namespace: string): boolean {
  return nodeType.startsWith(`${namespace}.`) && nodeType.length > namespace.length + 1;
}

// ---------------------------------------------------------------------------
// The host
// ---------------------------------------------------------------------------

interface PluginRecord {
  info: InstalledPluginInfo;
  runtime?: PluginRuntime;
  /** Declared ∩ granted, cached for permission checks on every host-call. */
  granted: string[];
}

export function createPluginHost(opts: CreatePluginHostOptions): PluginHost {
  const log: HostLog = opts.log ?? (() => undefined);
  const spawn = opts.spawn ?? forkPluginSpawn;
  const killGraceMs = opts.killGraceMs ?? DEFAULT_KILL_GRACE_MS;
  const startTimeoutMs = opts.startTimeoutMs ?? DEFAULT_START_TIMEOUT_MS;
  const childEntry = resolve(opts.childEntry);

  let consent: PluginConsentState = structuredClone(opts.consent);
  const records = new Map<string, PluginRecord>();
  const listeners = new Set<(plugins: InstalledPluginInfo[]) => void>();
  let closed = false;

  function snapshot(): InstalledPluginInfo[] {
    return [...records.values()].map((r) => structuredClone(r.info));
  }

  function notify(): void {
    const plugins = snapshot();
    for (const cb of [...listeners]) cb(plugins);
  }

  // -------------------------------------------------------------------------
  // Capability mediation — the one place a plugin's reach is decided
  // -------------------------------------------------------------------------

  function serviceFor(record: PluginRecord): HostCallService {
    const id = record.info.id;
    const declared = record.info.manifest.permissions;

    const requirePermission = (permission: string, what: string): void => {
      if (!declared.includes(permission)) {
        throw new Error(
          `plugin "${id}" tried to ${what} but its manifest does not declare the "${permission}" permission`,
        );
      }
      if (!record.granted.includes(permission)) {
        throw new Error(
          `plugin "${id}" tried to ${what} but the "${permission}" permission is not granted — enable it in Settings → Plugins`,
        );
      }
    };

    return async (method, args, ctx) => {
      // Assets follow the run; everything else is host state (see file comment).
      const assets: AssetStore = ctx?.assets ?? opts.capabilities.assets;
      switch (method) {
        case 'assets.bytes': {
          const { ref } = args as AssetBytesArgs;
          return { base64: toBase64(await assets.bytes(ref)) };
        }
        case 'assets.put': {
          const { base64, meta } = args as AssetPutArgs;
          const ref: AssetRef = await assets.put(fromBase64(base64), meta);
          return ref;
        }
        case 'secrets.get': {
          const { key } = args as SecretGetArgs;
          requirePermission(`secrets:${key}`, `read the secret "${key}"`);
          return opts.capabilities.secrets.get(key);
        }
        case 'ai.generateText':
          return opts.capabilities.ai.generateText({ ...(args as AiTextArgs), ...signalOf(ctx) });
        case 'ai.generateObject':
          return opts.capabilities.ai.generateObject({ ...(args as AiObjectArgs), ...signalOf(ctx) });
        case 'ai.embed':
          return opts.capabilities.ai.embed({ ...(args as AiEmbedArgs), ...signalOf(ctx) });
        case 'fetch': {
          requirePermission('net', 'make a network request');
          const impl = opts.capabilities.fetchImpl;
          if (!impl) throw new Error(`plugin "${id}" requested the network, but this host provides no fetch implementation`);
          const request = args as FetchArgs;
          const response = await impl(request.url, {
            method: request.method,
            headers: request.headers,
            ...(request.bodyBase64 !== undefined ? { body: fromBase64(request.bodyBase64) } : {}),
            ...signalOf(ctx),
          });
          const body = new Uint8Array(await response.arrayBuffer());
          // `forEach` rather than `[...headers.entries()]`: this file is
          // type-pulled into the renderer's DOM-lib compile, and DOM's `Headers`
          // only gains `entries()` from `lib.dom.iterable`. `forEach` is the one
          // iteration method both undici's and the DOM's `Headers` declare, so
          // it is the portable spelling — not a stylistic preference.
          const headers: [string, string][] = [];
          response.headers.forEach((value, key) => headers.push([key, value]));
          const result: FetchResult = {
            status: response.status,
            statusText: response.statusText,
            headers,
            bodyBase64: toBase64(body),
          };
          return result;
        }
        default:
          throw new Error(`plugin "${id}" made an unknown host call "${String(method)}"`);
      }
    };
  }

  // -------------------------------------------------------------------------
  // Discovery
  // -------------------------------------------------------------------------

  interface Candidate {
    dir: string;
    source: 'bundled' | 'user';
    manifest: PluginManifest | null;
    issues: ConfigIssue[];
    raw: string;
  }

  async function scanDir(dir: string, source: 'bundled' | 'user'): Promise<Candidate[]> {
    let entries: string[];
    try {
      entries = (await readdir(dir, { withFileTypes: true })).filter((e) => e.isDirectory() || e.isSymbolicLink()).map((e) => e.name);
    } catch {
      return []; // A missing plugins directory is normal, not an error.
    }
    const found: Candidate[] = [];
    for (const name of entries.sort()) {
      const pluginDir = join(dir, name);
      let raw: string;
      try {
        raw = await readFile(join(pluginDir, PLUGIN_MANIFEST_FILENAME), 'utf8');
      } catch {
        continue; // Not a plugin directory.
      }
      let json: unknown;
      try {
        json = JSON.parse(raw);
      } catch (err) {
        found.push({
          dir: pluginDir,
          source,
          manifest: null,
          raw,
          issues: [{ severity: 'error', path: '', message: `${PLUGIN_MANIFEST_FILENAME} is not valid JSON: ${String(err)}` }],
        });
        continue;
      }
      const parsed = parsePluginManifest(json, { dir: pluginDir });
      found.push({ dir: pluginDir, source, manifest: parsed.manifest, issues: parsed.issues, raw });
    }
    return found;
  }

  function placeholderManifest(dir: string): PluginManifest {
    return { name: dir, version: '0.0.0', namespace: 'unknown', displayName: dir, engineApi: 0, entry: '', permissions: [] };
  }

  async function stopAll(): Promise<void> {
    await Promise.all([...records.values()].map((r) => r.runtime?.stop() ?? Promise.resolve()));
    for (const record of records.values()) record.runtime = undefined;
  }

  async function discover(): Promise<InstalledPluginInfo[]> {
    if (closed) throw new Error('plugin host is closed');
    await stopAll();
    records.clear();

    const candidates: Candidate[] = [];
    for (const dir of opts.bundledDirs ?? []) candidates.push(...(await scanDir(dir, 'bundled')));
    candidates.push(...(await scanDir(opts.userDir, 'user')));

    const namespaces = new Map<string, string>(); // namespace → owning plugin id

    for (const candidate of candidates) {
      const manifest = candidate.manifest ?? placeholderManifest(candidate.dir);
      const id = candidate.manifest?.name ?? candidate.dir;
      const native = await containsNativeCode(candidate.dir);
      const info: InstalledPluginInfo = {
        id,
        dir: candidate.dir,
        source: candidate.source,
        state: 'failed',
        manifest,
        grantedPermissions: [],
        nodeTypes: [],
        containsNativeCode: native,
        restarts: 0,
      };
      const record: PluginRecord = { info, granted: [] };

      const errors = candidate.issues.filter((i) => i.severity === 'error');
      if (candidate.manifest === null || errors.length > 0) {
        info.error = errors.map((i) => (i.path ? `${i.path}: ${i.message}` : i.message)).join('; ');
        records.set(keyFor(records, id), record);
        continue;
      }
      if (records.has(id)) {
        info.error = `another installed plugin already uses the id "${id}"`;
        records.set(keyFor(records, id), record);
        continue;
      }
      const clash = [...namespaces.entries()].find(([ns]) => namespacesOverlap(ns, manifest.namespace));
      if (clash) {
        info.error = `namespace "${manifest.namespace}" overlaps "${clash[0]}", already claimed by plugin "${clash[1]}"`;
        records.set(id, record);
        continue;
      }
      namespaces.set(manifest.namespace, id);

      if (manifest.engineApi !== ENGINE_API) {
        info.state = 'incompatible';
        info.error = `plugin targets engine API ${manifest.engineApi}; this build implements ${ENGINE_API}`;
        records.set(id, record);
        continue;
      }

      const decision = consentFor(consent[id], manifest);
      record.granted = decision.granted;
      info.grantedPermissions = decision.granted;
      if (decision.state !== 'loaded') {
        info.state = decision.state;
        if (decision.reason) info.error = decision.reason;
        records.set(id, record);
        continue;
      }

      records.set(id, record);
      record.runtime = new PluginRuntime({
        pluginId: id,
        namespace: manifest.namespace,
        entry: entryPath(candidate.dir, manifest),
        dir: candidate.dir,
        permissions: decision.granted,
        childEntry,
        spawn,
        service: serviceFor(record),
        log,
        killGraceMs,
        startTimeoutMs,
        onUnexpectedExit: (code, signal) => {
          info.restarts += 1;
          log('warn', `plugin "${id}" exited unexpectedly (${signal !== null ? `signal ${signal}` : `code ${String(code)}`})`, {
            restarts: info.restarts,
          });
          notify();
        },
      });

      try {
        const manifests = await record.runtime.start();
        info.state = 'loaded';
        info.nodeTypes = manifests.map((m) => m.type);
      } catch (err) {
        info.state = 'failed';
        info.error = err instanceof Error ? err.message : String(err);
        record.runtime = undefined;
      }
    }

    notify();
    return snapshot();
  }

  // -------------------------------------------------------------------------
  // Proxy node modules
  // -------------------------------------------------------------------------

  function proxyFor(record: PluginRecord, manifest: NodeManifest): NodeModule<unknown> {
    return {
      manifest,
      async execute(ctx: NodeContext, inputs: Inputs, params: unknown): Promise<Outputs> {
        const runtime = record.runtime;
        if (!runtime) throw new Error(`plugin "${record.info.id}" is not loaded`);
        return runtime.execute(manifest.type, ctx, inputs, params);
      },
    };
  }

  return {
    discover,
    async reload(): Promise<InstalledPluginInfo[]> {
      return discover();
    },
    list(): InstalledPluginInfo[] {
      return snapshot();
    },
    async setConsent(state: PluginConsentState): Promise<void> {
      // Stamp what the user actually saw, so a later version or engineApi
      // change re-arms the dialog instead of inheriting an old decision.
      const stamped: PluginConsentState = {};
      for (const [id, entry] of Object.entries(state)) {
        const manifest = records.get(id)?.info.manifest;
        stamped[id] = {
          enabled: entry.enabled,
          permissions: [...entry.permissions],
          ...(entry.version !== undefined ? { version: entry.version } : manifest ? { version: manifest.version } : {}),
          ...(entry.engineApi !== undefined
            ? { engineApi: entry.engineApi }
            : manifest
              ? { engineApi: manifest.engineApi }
              : {}),
        };
      }
      consent = stamped;
      await discover();
    },
    childPids(): number[] {
      const pids: number[] = [];
      for (const record of records.values()) {
        const pid = record.runtime?.pid;
        if (pid !== undefined) pids.push(pid);
      }
      return pids;
    },
    nodeModules(): NodeModule[] {
      const modules: NodeModule[] = [];
      for (const record of records.values()) {
        if (record.info.state !== 'loaded' || !record.runtime) continue;
        for (const manifest of record.runtime.manifests) modules.push(proxyFor(record, manifest) as NodeModule);
      }
      return modules;
    },
    onChange(cb): () => void {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    async close(): Promise<void> {
      closed = true;
      await stopAll();
      listeners.clear();
    },
  };
}

// ---------------------------------------------------------------------------
// Consent
// ---------------------------------------------------------------------------

function consentFor(
  entry: PluginConsent | undefined,
  manifest: PluginManifest,
): { state: PluginState; granted: string[]; reason?: string } {
  if (!entry) {
    return { state: 'needs-consent', granted: [], reason: 'this plugin has not been reviewed yet' };
  }
  if (entry.version !== undefined && entry.version !== manifest.version) {
    return {
      state: 'needs-consent',
      granted: [],
      reason: `consent was given for version ${entry.version}; ${manifest.version} is installed`,
    };
  }
  if (entry.engineApi !== undefined && entry.engineApi !== manifest.engineApi) {
    return { state: 'needs-consent', granted: [], reason: 'the plugin now targets a different engine API' };
  }
  const missing = manifest.permissions.filter((p) => !entry.permissions.includes(p));
  if (missing.length > 0) {
    return { state: 'needs-consent', granted: [], reason: `new permissions requested: ${missing.join(', ')}` };
  }
  const granted = manifest.permissions.filter((p) => entry.permissions.includes(p));
  if (!entry.enabled) return { state: 'disabled', granted };
  return { state: 'loaded', granted };
}

/** Namespaces overlap when one is the other, or a dotted prefix of it —
 *  "acme" would otherwise silently own "acme.pointcloud"'s node ids. */
function namespacesOverlap(a: string, b: string): boolean {
  return a === b || a.startsWith(`${b}.`) || b.startsWith(`${a}.`);
}

function signalOf(ctx: NodeContext | undefined): { signal?: AbortSignal } {
  return ctx ? { signal: ctx.signal } : {};
}

/** A failed candidate still deserves a row in the UI, even when its id
 *  collides — give it a unique key rather than dropping it silently. */
function keyFor(records: Map<string, PluginRecord>, id: string): string {
  if (!records.has(id)) return id;
  for (let n = 2; ; n++) {
    const candidate = `${id}#${n}`;
    if (!records.has(candidate)) return candidate;
  }
}

export { secretKeyOf };
