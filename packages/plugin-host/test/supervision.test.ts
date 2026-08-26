/**
 * What the host does when a plugin will not cooperate: **refuse to half-speak
 * a protocol it does not share, and end a cancellation in a kill**
 * (ARCHITECTURE §8.1, §7.4; ADR-0008 §"Consequences": *"plugin authors get
 * honest cancellation (kill), and the engine gets honest supervision"*).
 *
 * Both invariants are about the same thing — that the host's promises do not
 * depend on the plugin's goodwill:
 *
 *  - **Version.** `PLUGIN_RPC_VERSION` is bumped when message shapes change
 *    incompatibly, so a child announcing a different version is a child whose
 *    `result` and `host-call` payloads we cannot read. Continuing anyway would
 *    turn a clean startup failure into misparsed values flowing into a
 *    workflow. The assertion is therefore not only "it failed" but "it sent
 *    nothing after `init`, and the process is gone".
 *  - **Cancellation.** §7.4's ladder is *ask, then insist, then stop asking*:
 *    a `cancel` message, then SIGTERM, then SIGKILL. Only the last rung is
 *    unconditional, and only the last rung is a promise the engine can keep —
 *    "cancel → full stop within grace" is an M2 gate the whole scheduler rests
 *    on. So the ladder is driven against a plugin that ignores the first two
 *    rungs, which is not an exotic plugin: nothing in the boundary revokes
 *    `process.on('SIGTERM')` (ADR-0008 §3's honesty clause).
 *
 * The version tests use a scripted `PluginSpawn` rather than a real fork,
 * because the real child always speaks `PLUGIN_RPC_VERSION` — a mismatch
 * cannot be produced honestly from `src/child.ts`, and faking one by editing
 * the constant would test the edit. The control case ("v1 loads") is included
 * so a broken fake cannot pass as a caught mismatch. The cancellation test uses
 * a real forked child, because SIGTERM and SIGKILL are OS behaviour and a fake
 * process would only prove that we call our own callbacks.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { NodeManifest } from '@archspace/node-sdk';
import { runNode } from '@archspace/node-sdk/testkit';
import {
  PLUGIN_RPC_VERSION,
  createPluginHost,
  type HostToChild,
  type PluginHost,
  type PluginProcess,
  type PluginSpawn,
} from '../src/index.js';
import { cleanupTempDirs, tempDir, writePluginDir } from './helpers.js';
import { CHILD_ENTRY, recordingSpawn, stubCapabilities } from './host-fixtures.js';

let host: PluginHost | undefined;

afterEach(async () => {
  await host?.close();
  host = undefined;
  await cleanupTempDirs();
});

// ---------------------------------------------------------------------------
// RPC version
// ---------------------------------------------------------------------------

const FIXTURE_NODE_MANIFEST: NodeManifest = {
  type: 'fixture.plugin.noop',
  version: 1,
  label: 'Noop',
  description: 'scripted fixture',
  category: 'test',
  params: { type: 'object', properties: {} },
  inputs: [],
  outputs: [{ id: 'out', type: 'text' }],
  caching: 'never',
};

interface ScriptedChild {
  spawn: PluginSpawn;
  /** Everything the host said to it, in order. */
  sent: HostToChild[];
  killSignals: string[];
}

/**
 * A child that answers `init` with a `ready` announcing `version`, and does
 * nothing else. It is the smallest thing that can be on the far end of the
 * seam — which is the point: the host's reaction has to be decided from the
 * announcement alone.
 */
function scriptedChild(version: number): ScriptedChild {
  const sent: HostToChild[] = [];
  const killSignals: string[] = [];

  const spawn: PluginSpawn = () => {
    const messageListeners: ((message: unknown) => void)[] = [];
    const exitListeners: ((code: number | null, signal: string | null) => void)[] = [];
    let alive = true;

    const proc: PluginProcess = {
      pid: 424242,
      send(message: HostToChild): void {
        sent.push(message);
        if (message.t === 'init') {
          queueMicrotask(() => {
            for (const cb of messageListeners) cb({ t: 'ready', v: version, manifests: [FIXTURE_NODE_MANIFEST] });
          });
          return;
        }
        // A real child exits on `shutdown` (src/child.ts). Honouring it here is
        // not politeness: a fake that ignored it would make every `close()` in
        // this file wait out the kill grace, and slow tests get deleted.
        if (message.t === 'shutdown' && alive) {
          alive = false;
          queueMicrotask(() => {
            for (const cb of exitListeners) cb(0, null);
          });
        }
      },
      onMessage(cb): void {
        messageListeners.push(cb);
      },
      onExit(cb): void {
        exitListeners.push(cb);
      },
      kill(signal): void {
        killSignals.push(signal ?? 'default');
        if (!alive) return;
        alive = false;
        queueMicrotask(() => {
          for (const cb of exitListeners) cb(null, signal ?? 'SIGTERM');
        });
      },
    };
    return proc;
  };

  return { spawn, sent, killSignals };
}

async function hostOver(child: ScriptedChild): Promise<PluginHost> {
  const userDir = await tempDir();
  await writePluginDir(join(userDir, 'fixture-plugin'));
  return createPluginHost({
    userDir,
    childEntry: CHILD_ENTRY,
    spawn: child.spawn,
    consent: { 'fixture-plugin': { enabled: true, permissions: [] } },
    capabilities: stubCapabilities().capabilities,
  });
}

describe('an RPC version the host does not speak', () => {
  it('loads normally when the child speaks this build’s version (the control)', async () => {
    const child = scriptedChild(PLUGIN_RPC_VERSION);
    host = await hostOver(child);

    const [plugin] = await host.discover();
    expect(plugin.state).toBe('loaded');
    expect(plugin.nodeTypes).toEqual(['fixture.plugin.noop']);
    expect(child.killSignals).toEqual([]);
  }, 60_000);

  it('kills the plugin instead of half-speaking to it', async () => {
    const child = scriptedChild(PLUGIN_RPC_VERSION + 1);
    host = await hostOver(child);

    const [plugin] = await host.discover();
    expect(plugin.state).toBe('failed');
    expect(plugin.error).toBe(
      `plugin "fixture-plugin" speaks RPC v${PLUGIN_RPC_VERSION + 1}; this build speaks v${PLUGIN_RPC_VERSION}`,
    );

    // The nodes it announced are not registered, even though their type ids
    // were inside its namespace — an unreadable protocol makes the *content*
    // of the announcement untrustworthy, not just its version field.
    expect(plugin.nodeTypes).toEqual([]);
    expect(host.nodeModules()).toEqual([]);

    // Nothing was said to it after the handshake it failed, and it is dead.
    expect(child.sent.map((message) => message.t)).toEqual(['init']);
    expect(child.killSignals).toEqual(['default']);
  }, 60_000);
});

// ---------------------------------------------------------------------------
// Cancellation
// ---------------------------------------------------------------------------

/**
 * Two nodes: one that observes `ctx.signal` and one that ignores everything a
 * host can ask of it. The marker file is how the test knows the exec is really
 * in flight before it cancels — a plugin writing a path it was handed as a
 * param is ordinary, and waiting for it beats sleeping a guessed interval.
 */
const CANCEL_ENTRY = `import { writeFileSync } from 'node:fs';

// Deliberately deaf. The boundary revokes nothing inside a plugin process
// (ADR-0008 §3), so this is one line any plugin — or any native dependency of
// one — can have, by accident or on purpose.
process.on('SIGTERM', () => {});

const manifest = (type) => ({
  type,
  version: 1,
  label: type,
  description: 'cancellation fixture',
  category: 'test',
  params: { type: 'object', properties: { marker: { type: 'string', default: '' } } },
  inputs: [],
  outputs: [{ id: 'out', type: 'text' }],
  caching: 'never',
});

export default [
  {
    manifest: manifest('fixture.plugin.stubborn'),
    async execute(ctx, inputs, params) {
      writeFileSync(params.marker, 'running');
      await new Promise(() => {});
      return { out: 'unreachable' };
    },
  },
  {
    manifest: manifest('fixture.plugin.polite'),
    async execute(ctx, inputs, params) {
      writeFileSync(params.marker, 'running');
      await new Promise((_resolve, reject) => {
        ctx.signal.addEventListener('abort', () => reject(new Error('stopped at the first ask')), { once: true });
      });
      return { out: 'unreachable' };
    },
  },
];
`;

describe('the cancellation ladder ends in a kill (§7.4)', () => {
  async function cancellableHost(killGraceMs: number): Promise<{
    host: PluginHost;
    processes: ReturnType<typeof recordingSpawn>['processes'];
    marker: string;
  }> {
    const userDir = await tempDir();
    await writePluginDir(join(userDir, 'fixture-plugin'), { entry: CANCEL_ENTRY });
    const { spawn, processes } = recordingSpawn();

    const created = createPluginHost({
      userDir,
      childEntry: CHILD_ENTRY,
      spawn,
      consent: { 'fixture-plugin': { enabled: true, permissions: [] } },
      capabilities: stubCapabilities().capabilities,
      killGraceMs,
    });
    await created.discover();
    return { host: created, processes, marker: join(await tempDir(), 'running') };
  }

  it('terminates a plugin that ignores both the cancel message and SIGTERM', async () => {
    const started = await cancellableHost(250);
    host = started.host;

    const stubborn = host.nodeModules().find((mod) => mod.manifest.type === 'fixture.plugin.stubborn')!;
    const controller = new AbortController();
    const pending = runNode(stubborn, { params: { marker: started.marker }, signal: controller.signal });

    // Cancel only once the node is genuinely running, so the ladder is being
    // climbed against a live exec rather than against a race.
    await vi.waitUntil(() => existsSync(started.marker), { timeout: 30_000, interval: 20 });
    controller.abort();

    await expect(pending).rejects.toThrow(/exited \(signal SIGKILL\) while running "fixture\.plugin\.stubborn"/);

    // The whole documented ladder, in order: ask over RPC, insist with SIGTERM,
    // then stop asking. Nothing else was ever sent.
    const [proc] = started.processes;
    expect(proc.sent.map((message) => message.t)).toEqual(['init', 'exec', 'cancel']);
    expect(proc.killSignals).toEqual(['SIGTERM', 'SIGKILL']);
    await expect(proc.exited).resolves.toEqual({ code: null, signal: 'SIGKILL' });
  }, 60_000);

  it('does not touch a plugin that stops when asked', async () => {
    // A grace long enough that a SIGTERM would have to be a bug, not a race.
    const started = await cancellableHost(30_000);
    host = started.host;

    const polite = host.nodeModules().find((mod) => mod.manifest.type === 'fixture.plugin.polite')!;
    const controller = new AbortController();
    const pending = runNode(polite, { params: { marker: started.marker }, signal: controller.signal });

    await vi.waitUntil(() => existsSync(started.marker), { timeout: 30_000, interval: 20 });
    controller.abort();

    await expect(pending).rejects.toThrow(/stopped at the first ask/);

    const [proc] = started.processes;
    expect(proc.sent.map((message) => message.t)).toEqual(['init', 'exec', 'cancel']);
    expect(proc.killSignals).toEqual([]);
    // Still alive and still loaded: a cooperative cancellation costs the plugin
    // its exec, not its process (which is what makes the next run cheap).
    expect(() => process.kill(proc.pid!, 0)).not.toThrow();
    expect(host.list()[0].state).toBe('loaded');
    expect(host.list()[0].restarts).toBe(0);
  }, 60_000);
});
