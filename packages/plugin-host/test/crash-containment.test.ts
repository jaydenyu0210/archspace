/**
 * ADR-0008's headline gate: **`process.exit` in a plugin node is one failed
 * node and a healthy app.**
 *
 * This is the assertion the whole out-of-process design was bought for, so it
 * is tested against a real forked child running the real `src/child.ts` over
 * the real RPC — not a fake `PluginSpawn`. A fake process would let us
 * *simulate* an exit and would prove only that the host handles a callback it
 * calls itself; the claim under test is that an OS process dying takes nothing
 * else with it, and that claim is only true if an OS process actually dies.
 *
 * The node modules come out of `host.nodeModules()` and are driven with
 * `@archspace/node-sdk/testkit`, because a plugin node is supposed to be
 * indistinguishable from a core node at the contract level (ADR-0005) — the
 * same harness core nodes use is the honest way to state that.
 *
 * Cost: this spawns a Node child through the `tsx` loader, so it is seconds
 * rather than milliseconds. It earns that as the one M6 gate in this package.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { createMemoryAssetStore, type AiGateway } from '@archspace/node-sdk';
import { runNode } from '@archspace/node-sdk/testkit';
import { createPluginHost, type HostCapabilities, type PluginHost } from '../src/index.js';
import { cleanupTempDirs, tempDir, writePluginDir } from './helpers.js';

/** The child that `forkPluginSpawn` runs: this package's own runtime, from source. */
const CHILD_ENTRY = fileURLToPath(new URL('../src/child.ts', import.meta.url));

/** Two nodes in one process: one that kills it, one that reports which process
 *  it is running in — so "the plugin came back" can be distinguished from
 *  "the plugin never actually died". */
const CRASH_ENTRY = `const manifest = (type) => ({
  type,
  version: 1,
  label: type,
  description: 'crash-containment fixture',
  category: 'test',
  params: { type: 'object', properties: {} },
  inputs: [],
  outputs: [{ id: 'out', type: 'text' }],
  caching: 'never',
});
export default [
  {
    manifest: manifest('crash.test.boom'),
    async execute() {
      process.exit(1);
    },
  },
  {
    manifest: manifest('crash.test.survivor'),
    async execute() {
      return { out: String(process.pid) };
    },
  },
];
`;

function stubCapabilities(): HostCapabilities {
  const unreachable = (name: string) => (): never => {
    throw new Error(`this fixture must not reach ${name}`);
  };
  return {
    assets: createMemoryAssetStore(),
    ai: {
      generateText: unreachable('ctx.ai.generateText'),
      generateObject: unreachable('ctx.ai.generateObject'),
      embed: unreachable('ctx.ai.embed'),
    } satisfies AiGateway,
    secrets: { get: unreachable('ctx.secrets.get') },
  };
}

let host: PluginHost | undefined;

afterEach(async () => {
  await host?.close();
  host = undefined;
  await cleanupTempDirs();
});

describe('crash containment (ADR-0008 §"Consequences")', () => {
  it('a node calling process.exit(1) fails exactly that node, and the plugin is back on the next call', async () => {
    const userDir = await tempDir();
    await writePluginDir(join(userDir, 'crash-plugin'), {
      manifest: { name: 'crash-plugin', namespace: 'crash.test', displayName: 'Crash Fixture' },
      entry: CRASH_ENTRY,
    });

    host = createPluginHost({
      userDir,
      childEntry: CHILD_ENTRY,
      consent: { 'crash-plugin': { enabled: true, permissions: [] } },
      capabilities: stubCapabilities(),
    });

    const [plugin] = await host.discover();
    expect(plugin.state).toBe('loaded');
    expect(plugin.nodeTypes.sort()).toEqual(['crash.test.boom', 'crash.test.survivor']);

    const modules = new Map(host.nodeModules().map((mod) => [mod.manifest.type, mod]));
    const boom = modules.get('crash.test.boom')!;
    const survivor = modules.get('crash.test.survivor')!;

    const before = await runNode(survivor);
    expect(typeof before.outputs.out).toBe('string');

    // The gate. One node fails; nothing else does.
    await expect(runNode(boom)).rejects.toThrow(/crash-plugin.*exited/);

    // The host is not merely alive, it is usable: the next call brings the
    // plugin back, in a genuinely new process.
    const after = await runNode(survivor);
    expect(after.outputs.out).not.toBe(before.outputs.out);

    const [status] = host.list();
    expect(status.state).toBe('loaded');
    expect(status.restarts).toBe(1);
    expect(status.error).toBeUndefined();
  }, 60_000);
});
