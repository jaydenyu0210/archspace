/**
 * Fixtures for a *running* plugin host (ARCHITECTURE §8, ADR-0008).
 *
 * `helpers.ts` next door builds the on-disk shapes the install path argues
 * about; this file builds the things a host needs once a plugin is actually
 * executing — the child entry, the bundled-plugin directory, a capability set
 * that records what it was asked for, and a `PluginSpawn` that watches a real
 * child process without replacing it.
 *
 * Two decisions worth stating, because both are the difference between a test
 * that proves the boundary and one that proves our own mocks:
 *
 *  - **`recordingSpawn` wraps `forkPluginSpawn`; it does not stand in for it.**
 *    A fake process can only demonstrate that the host handles callbacks the
 *    test itself fires. Wrapping keeps the real fork, the real IPC and the real
 *    OS signals, and adds only observation: which messages left the host, which
 *    signals were sent, which pid ran the work, and when the process died.
 *    That observation is what lets a test say "the work crossed a process
 *    boundary" instead of "the host returned a value".
 *  - **`stubCapabilities` always supplies a `fetchImpl`, even to tests about
 *    plugins that may not use the network.** A host with no fetch implementation
 *    refuses network calls for the *wrong reason* ("this host provides no fetch
 *    implementation"), which would let a permission regression pass as a green
 *    test. Supplying a recording implementation means a refusal has to be the
 *    permission check, and `fetchCalls` proves nothing reached the wire. It is
 *    canned-response-only and never opens a socket (ADR-0013: no live network
 *    in the blocking lanes).
 */
import { fileURLToPath } from 'node:url';
import { createMemoryAssetStore, type AiGateway } from '@archspace/node-sdk';
import {
  forkPluginSpawn,
  type HostCapabilities,
  type HostToChild,
  type PluginProcess,
  type PluginSpawn,
} from '../src/index.js';

/** The child that `forkPluginSpawn` runs: this package's own runtime, from
 *  source, exactly as the CLI runs it. */
export const CHILD_ENTRY = fileURLToPath(new URL('../src/child.ts', import.meta.url));

/** The repo's first-party plugins — the same directory `packages/cli` and the
 *  unpackaged app hand the host as `bundledDirs` (see `workspacePluginsDir`). */
export const BUNDLED_PLUGINS_DIR = fileURLToPath(new URL('../../../plugins', import.meta.url));

// ---------------------------------------------------------------------------
// Capabilities
// ---------------------------------------------------------------------------

export interface RecordedFetch {
  url: string;
  method: string;
  /** Lower-cased header names, as the host handed them over. */
  headers: Record<string, string>;
  body: string;
}

export interface StubCapabilities {
  capabilities: HostCapabilities;
  /** Requests the host actually performed on a plugin's behalf. Empty is the
   *  assertion for "the refusal happened before anything reached the wire". */
  fetchCalls: RecordedFetch[];
  /** Secret keys the host was asked for, in order. */
  secretReads: string[];
}

export interface StubCapabilityOptions {
  secrets?: Record<string, string>;
  /** Canned responses keyed by absolute URL. Anything else is an error, so a
   *  test can never accidentally depend on a network that is not there. */
  responses?: Record<string, { status?: number; body: string; contentType?: string }>;
}

export function stubCapabilities(options: StubCapabilityOptions = {}): StubCapabilities {
  const fetchCalls: RecordedFetch[] = [];
  const secretReads: string[] = [];

  const unreachable =
    (name: string) =>
    (): never => {
      throw new Error(`this fixture must not reach ${name}`);
    };

  const capabilities: HostCapabilities = {
    assets: createMemoryAssetStore(),
    ai: {
      generateText: unreachable('ctx.ai.generateText'),
      generateObject: unreachable('ctx.ai.generateObject'),
      embed: unreachable('ctx.ai.embed'),
    } satisfies AiGateway,
    secrets: {
      async get(key: string): Promise<string> {
        secretReads.push(key);
        const value = options.secrets?.[key];
        if (value === undefined) throw new Error(`this fixture host holds no secret "${key}"`);
        return value;
      },
    },
    // Spelled with `Parameters<typeof fetch>` for the same reason src/child.ts
    // is: these packages carry no DOM lib, so `RequestInfo` has no name here.
    fetchImpl: async (
      input: Parameters<typeof fetch>[0],
      init?: Parameters<typeof fetch>[1],
    ): Promise<Response> => {
      const request = new Request(input, init);
      const headers: Record<string, string> = {};
      request.headers.forEach((value, key) => {
        headers[key] = value;
      });
      fetchCalls.push({ url: request.url, method: request.method, headers, body: await request.text() });
      const canned = options.responses?.[request.url];
      if (canned === undefined) {
        throw new Error(`this fixture host has no canned response for ${request.method} ${request.url}`);
      }
      return new Response(canned.body, {
        status: canned.status ?? 200,
        headers: { 'content-type': canned.contentType ?? 'text/plain' },
      });
    },
  };

  return { capabilities, fetchCalls, secretReads };
}

// ---------------------------------------------------------------------------
// An observed process
// ---------------------------------------------------------------------------

export interface ExitInfo {
  code: number | null;
  signal: string | null;
}

export interface RecordedProcess {
  /** The OS pid of the child. `!== process.pid` is the whole point of §8.1. */
  readonly pid: number | undefined;
  /** Every message the host sent this child, in order. */
  readonly sent: HostToChild[];
  /** Every signal the host aimed at it; `kill()` with no argument records
   *  'default' (which `child_process` turns into SIGTERM). */
  readonly killSignals: string[];
  /** Resolves when the process really is gone. */
  readonly exited: Promise<ExitInfo>;
}

export interface RecordingSpawn {
  spawn: PluginSpawn;
  /** One entry per spawn, in spawn order. A plugin that was never started —
   *  because consent gated it — leaves this empty, which is the honest way to
   *  assert that no plugin code ran. */
  processes: RecordedProcess[];
}

/**
 * `forkPluginSpawn` with a tap on it. Everything the host does to the child
 * still happens for real; the wrapper only writes down what happened.
 */
export function recordingSpawn(inner: PluginSpawn = forkPluginSpawn): RecordingSpawn {
  const processes: RecordedProcess[] = [];

  const spawn: PluginSpawn = (childEntry, argv, opts) => {
    const proc = inner(childEntry, argv, opts);
    const sent: HostToChild[] = [];
    const killSignals: string[] = [];

    let settle: ((info: ExitInfo) => void) | undefined;
    const exited = new Promise<ExitInfo>((resolve) => {
      settle = resolve;
    });
    proc.onExit((code, signal) => settle?.({ code, signal }));

    processes.push({
      get pid(): number | undefined {
        return proc.pid;
      },
      sent,
      killSignals,
      exited,
    });

    const observed: PluginProcess = {
      get pid(): number | undefined {
        return proc.pid;
      },
      send(message: HostToChild): void {
        sent.push(message);
        proc.send(message);
      },
      onMessage(cb): void {
        proc.onMessage(cb);
      },
      onExit(cb): void {
        proc.onExit(cb);
      },
      onStderr(cb): void {
        proc.onStderr?.(cb);
      },
      kill(signal): void {
        killSignals.push(signal ?? 'default');
        proc.kill(signal);
      },
    };
    return observed;
  };

  return { spawn, processes };
}
