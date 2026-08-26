/**
 * The plugin child process (ARCHITECTURE §8.1, ADR-0008).
 *
 * One of these runs per installed plugin. It imports the plugin's built entry,
 * reports the node manifests it found, and then does nothing but execute nodes
 * on request. Everything a node can touch is built here, per exec, from the
 * permission list the host sent at init — there is no ambient authority to take
 * away, because none is ever assembled: `ctx.fetch` is simply absent without
 * `net`, and `ctx.secrets.get` refuses a key the manifest never declared.
 *
 * Honesty clause, as in ADR-0008 §3 and ARCHITECTURE §8.1: **this is fault
 * isolation plus permission mediation, not a hardened security sandbox.**
 * Nothing here stops a plugin from calling `node:fs` directly — the process
 * runs with the user's own authority. What it does buy is real: a crash, an
 * infinite loop or a segfaulting native dependency kills one node, the host
 * survives it, and the capabilities the plugin is *offered* are the mediated
 * ones. OS-level sandboxing is the documented next milestone, made possible by
 * already being out of process.
 *
 * The module is importable (for tests and for the Electron bundle) and runnable
 * as a script (for the fork above); the bottom of the file runs it only when it
 * really is the entry point and really has an IPC channel.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  isRetryableError,
  markRetryable,
  type AssetRef,
  type Inputs,
  type NodeContext,
  type NodeModule,
  type Outputs,
  type Value,
} from '@archspace/node-sdk';
import {
  PLUGIN_RPC_VERSION,
  fromBase64,
  toBase64,
  type AssetBytesResult,
  type ChildToHost,
  type FetchResult,
  type HostCallMethod,
  type HostToChild,
  type InitMessage,
} from './protocol.js';

interface PendingHostCall {
  resolve(value: unknown): void;
  reject(error: Error): void;
}

interface RunningExec {
  abort: AbortController;
  tempDirs: string[];
}

export function runPluginChild(): void {
  const send = (message: ChildToHost): void => {
    process.send?.(message);
  };

  let init: InitMessage | undefined;
  const modules = new Map<string, NodeModule<unknown>>();
  const pendingCalls = new Map<number, PendingHostCall>();
  const running = new Map<number, RunningExec>();
  let nextCallId = 1;

  // -------------------------------------------------------------------------
  // Capability calls back to the host
  // -------------------------------------------------------------------------

  function hostCall<T>(execId: number, method: HostCallMethod, args: unknown): Promise<T> {
    const callId = nextCallId++;
    return new Promise<T>((resolve, reject) => {
      pendingCalls.set(callId, { resolve: resolve as (v: unknown) => void, reject });
      send({ t: 'host-call', callId, id: execId, method, args });
    });
  }

  function granted(permission: string): boolean {
    return init?.permissions.includes(permission) === true;
  }

  // -------------------------------------------------------------------------
  // NodeContext construction — the entire world a plugin node can reach
  // -------------------------------------------------------------------------

  function makeContext(execId: number, runId: string, nodeId: string, exec: RunningExec): NodeContext {
    const pluginId = init?.pluginId ?? 'plugin';

    const ctx: NodeContext = {
      signal: exec.abort.signal,
      runId,
      nodeId,
      log(level, message, data) {
        send(data === undefined ? { t: 'log', id: execId, level, message } : { t: 'log', id: execId, level, message, data });
      },
      progress(fraction, message) {
        send({
          t: 'progress',
          id: execId,
          ...(fraction !== undefined ? { fraction } : {}),
          ...(message !== undefined ? { message } : {}),
        });
      },
      assets: {
        async bytes(ref: AssetRef): Promise<Uint8Array> {
          const result = await hostCall<AssetBytesResult>(execId, 'assets.bytes', { ref });
          return fromBase64(result.base64);
        },
        async open(ref: AssetRef): Promise<ReadableStream<Uint8Array>> {
          // The RPC is request/response, so `open` is `bytes` in a stream's
          // clothing. Honest for the sizes the wire invariant permits; a
          // chunked read is a protocol change, not an API change.
          const bytes = await ctx.assets.bytes(ref);
          return new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(bytes);
              controller.close();
            },
          });
        },
        async put(data, meta): Promise<AssetRef> {
          const bytes = data instanceof Uint8Array ? data : await drain(data);
          return hostCall<AssetRef>(execId, 'assets.put', { base64: toBase64(bytes), meta });
        },
      },
      secrets: {
        async get(key: string): Promise<string> {
          // Refused here as well as in the host: the message a plugin author
          // sees has to name the declaration they forgot to write.
          if (!granted(`secrets:${key}`)) {
            throw new Error(
              `plugin "${pluginId}" may not read secret "${key}" — declare "secrets:${key}" in its permissions and grant it in Settings → Plugins`,
            );
          }
          return hostCall<string>(execId, 'secrets.get', { key });
        },
      },
      ai: {
        generateText: (req) =>
          hostCall<{ text: string }>(execId, 'ai.generateText', stripSignal(req)),
        generateObject: (req) =>
          hostCall<{ object: Value }>(execId, 'ai.generateObject', stripSignal(req)),
        embed: (req) => hostCall<{ embeddings: number[][] }>(execId, 'ai.embed', stripSignal(req)),
      },
      async tempDir(): Promise<string> {
        const dir = await mkdtemp(join(tmpdir(), `archspace-plugin-${pluginId}-`));
        exec.tempDirs.push(dir);
        return dir;
      },
      retryable: markRetryable,
    };

    // Absent, not disabled: a node cannot feature-detect its way around a
    // permission it was never granted.
    //
    // The parameters are spelled `Parameters<typeof fetch>[n]` rather than
    // `RequestInfo | URL`, because these packages deliberately do not load the
    // DOM lib (ARCHITECTURE §3.4: everything below the Electron shell is plain
    // Node) and `RequestInfo` is undici-internal — it is not one of the globals
    // @types/node declares. Adding "dom" to tsconfig would fix the name and
    // break something worse: `document`, `window` and `localStorage` would all
    // typecheck in a Node process. Deriving from the ambient `fetch` we are
    // standing in for keeps the signature exactly as wide as the real one, in
    // whichever runtime is providing it.
    if (granted('net')) {
      ctx.fetch = (async (
        input: Parameters<typeof fetch>[0],
        requestInit?: Parameters<typeof fetch>[1],
      ): Promise<Response> => {
        const request = new Request(input, requestInit);
        const body = await request.arrayBuffer();
        const result = await hostCall<FetchResult>(execId, 'fetch', {
          url: request.url,
          method: request.method,
          headers: [...request.headers.entries()],
          ...(body.byteLength > 0 ? { bodyBase64: toBase64(new Uint8Array(body)) } : {}),
        });
        return new Response(fromBase64(result.bodyBase64), {
          status: result.status,
          statusText: result.statusText,
          headers: result.headers,
        });
      }) as typeof fetch;
    }

    return ctx;
  }

  // -------------------------------------------------------------------------
  // Loading
  // -------------------------------------------------------------------------

  async function load(message: InitMessage): Promise<void> {
    init = message;
    try {
      const imported: unknown = await import(pathToFileURL(message.entry).href);
      const nodes = pickNodes(imported);
      if (nodes === null) {
        send({
          t: 'load-error',
          message: `plugin entry "${message.entry}" must default-export (or export as "nodes") an array of NodeModule`,
        });
        return;
      }
      for (const mod of nodes) modules.set(mod.manifest.type, mod);
      send({ t: 'ready', v: PLUGIN_RPC_VERSION, manifests: nodes.map((m) => m.manifest) });
    } catch (err) {
      send({ t: 'load-error', message: describeError(err) });
    }
  }

  // -------------------------------------------------------------------------
  // Execution
  // -------------------------------------------------------------------------

  async function execute(id: number, nodeType: string, runId: string, nodeId: string, inputs: Inputs, params: Value): Promise<void> {
    const mod = modules.get(nodeType);
    if (!mod) {
      send({ t: 'error', id, message: `plugin does not provide node type "${nodeType}"`, retryable: false });
      return;
    }
    const exec: RunningExec = { abort: new AbortController(), tempDirs: [] };
    running.set(id, exec);
    try {
      const outputs: Outputs = await mod.execute(makeContext(id, runId, nodeId, exec), inputs, params);
      send({ t: 'result', id, outputs });
    } catch (err) {
      send({
        t: 'error',
        id,
        message: describeError(err),
        retryable: isRetryableError(err),
        ...(exec.abort.signal.aborted ? { cancelled: true } : {}),
      });
    } finally {
      running.delete(id);
      await Promise.all(exec.tempDirs.map((dir) => rm(dir, { recursive: true, force: true }).catch(() => undefined)));
    }
  }

  // -------------------------------------------------------------------------
  // Message pump
  // -------------------------------------------------------------------------

  process.on('message', (raw: unknown) => {
    const message = raw as HostToChild;
    if (typeof message !== 'object' || message === null) return;
    switch (message.t) {
      case 'init':
        void load(message);
        return;
      case 'exec':
        void execute(message.id, message.nodeType, message.runId, message.nodeId, message.inputs as Inputs, message.params);
        return;
      case 'cancel':
        running.get(message.id)?.abort.abort(new Error('cancelled by the engine'));
        return;
      case 'host-result': {
        const pending = pendingCalls.get(message.callId);
        if (!pending) return;
        pendingCalls.delete(message.callId);
        if (message.ok) pending.resolve(message.value);
        else pending.reject(new Error(message.error ?? 'host call failed'));
        return;
      }
      case 'shutdown':
        for (const exec of running.values()) exec.abort.abort(new Error('plugin is shutting down'));
        process.exit(0);
    }
  });

  // A plugin that throws asynchronously must fail loudly on stderr and die,
  // rather than linger in a half-state the host cannot reason about.
  process.on('uncaughtException', (err) => {
    process.stderr.write(`uncaught exception in plugin process: ${describeError(err)}\n`);
    process.exit(1);
  });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function stripSignal<T extends { signal?: AbortSignal }>(req: T): Omit<T, 'signal'> {
  const { signal: _signal, ...rest } = req;
  return rest;
}

async function drain(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  const reader = stream.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) chunks.push(value);
  }
  const total = chunks.reduce((n, c) => n + c.byteLength, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

function isNodeModule(value: unknown): value is NodeModule<unknown> {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as { manifest?: { type?: unknown }; execute?: unknown };
  return typeof candidate.execute === 'function' && typeof candidate.manifest?.type === 'string';
}

/** Accept either shape ARCHITECTURE §8.2 sanctions: a default export or a
 *  named `nodes` export, both `NodeModule[]`. */
function pickNodes(imported: unknown): NodeModule<unknown>[] | null {
  if (typeof imported !== 'object' || imported === null) return null;
  const mod = imported as { default?: unknown; nodes?: unknown };
  for (const candidate of [mod.nodes, mod.default]) {
    if (Array.isArray(candidate) && candidate.length > 0 && candidate.every(isNodeModule)) {
      return candidate as NodeModule<unknown>[];
    }
  }
  return null;
}

function describeError(err: unknown): string {
  if (err instanceof Error) return err.stack ?? err.message;
  return String(err);
}

// Run only when forked as the entry point with a live IPC channel — importing
// this module (a test, the Electron bundle) must not start a message pump.
const invokedAsScript =
  process.argv[1] !== undefined && pathToFileURL(process.argv[1]).href === import.meta.url && process.send !== undefined;
if (invokedAsScript) runPluginChild();
