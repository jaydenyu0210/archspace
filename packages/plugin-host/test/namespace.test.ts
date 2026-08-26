/**
 * A plugin owns the node type ids under its declared namespace, and nothing
 * else (ARCHITECTURE §8.2: *"namespace … owns node type ids under this
 * prefix"*).
 *
 * The invariant is worth pinning because the failure it prevents is silent and
 * unfixable after the fact: node type ids are what a saved workflow document
 * stores (ADR-0004), so a plugin that registers `core.file.read` or squats a
 * neighbour's prefix does not merely shadow a node — it changes what an
 * existing document means, in a file the user has already committed. There is
 * no runtime error to notice. So both halves of the rule get a test:
 *
 *  - a plugin that *claims* a namespace it did not declare is refused **and
 *    killed** at startup, before a single one of its nodes is offered;
 *  - two installed plugins whose namespaces overlap cannot both load, and it
 *    is the second one that loses, deterministically.
 *
 * The first case is refused for the whole package, not per node. That is the
 * deliberate choice being pinned: a plugin whose manifest disagrees with its
 * code has a bug the author must fix, and quietly dropping the offending node
 * would ship a plugin that half-works and a palette that half-matches its docs.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { createPluginHost, type PluginHost } from '../src/index.js';
import { cleanupTempDirs, tempDir, writePluginDir } from './helpers.js';
import { CHILD_ENTRY, recordingSpawn, stubCapabilities } from './host-fixtures.js';

/** An entry exporting one node per given type id. */
function entryFor(...types: string[]): string {
  return `const manifest = (type) => ({
  type,
  version: 1,
  label: type,
  description: 'namespace fixture',
  category: 'test',
  params: { type: 'object', properties: {} },
  inputs: [],
  outputs: [{ id: 'out', type: 'text' }],
  caching: 'never',
});
export default ${JSON.stringify(types)}.map((type) => ({
  manifest: manifest(type),
  async execute() {
    return { out: type };
  },
}));
`;
}

let host: PluginHost | undefined;

afterEach(async () => {
  await host?.close();
  host = undefined;
  await cleanupTempDirs();
});

describe('a plugin may only register node types inside its declared namespace', () => {
  it('kills a plugin that registers a node outside its namespace, and offers none of its nodes', async () => {
    const userDir = await tempDir();
    const { spawn, processes } = recordingSpawn();
    await writePluginDir(join(userDir, 'fixture-plugin'), {
      // One perfectly legal node, and one that squats someone else's prefix.
      entry: entryFor('fixture.plugin.legal', 'other.namespace.sneaky'),
    });

    host = createPluginHost({
      userDir,
      childEntry: CHILD_ENTRY,
      spawn,
      consent: { 'fixture-plugin': { enabled: true, permissions: [] } },
      capabilities: stubCapabilities().capabilities,
    });

    const [plugin] = await host.discover();
    expect(plugin.state).toBe('failed');
    expect(plugin.error).toMatch(
      /registers node type "other\.namespace\.sneaky", which is outside its namespace "fixture\.plugin\."/,
    );

    // The whole package is refused — including the node that was in-namespace.
    expect(plugin.nodeTypes).toEqual([]);
    expect(host.nodeModules()).toEqual([]);

    // Refused *and* stopped: a process that has already imported an entry we
    // will not trust does not get to keep running (ADR-0008 §1).
    expect(processes).toHaveLength(1);
    expect(processes[0].killSignals).toEqual(['default']);
    await expect(processes[0].exited).resolves.toEqual({ code: null, signal: 'SIGTERM' });
  }, 60_000);

  it('treats a namespace that is merely a string prefix as outside', async () => {
    const userDir = await tempDir();
    const { spawn, processes } = recordingSpawn();
    await writePluginDir(join(userDir, 'fixture-plugin'), {
      // "fixture.plugins" shares fifteen characters with "fixture.plugin" and
      // owns none of them: the boundary is a dotted segment, not a substring.
      entry: entryFor('fixture.plugins.noop'),
    });

    host = createPluginHost({
      userDir,
      childEntry: CHILD_ENTRY,
      spawn,
      consent: { 'fixture-plugin': { enabled: true, permissions: [] } },
      capabilities: stubCapabilities().capabilities,
    });

    const [plugin] = await host.discover();
    expect(plugin.state).toBe('failed');
    expect(plugin.error).toMatch(/outside its namespace/);
    expect(host.nodeModules()).toEqual([]);
    await expect(processes[0].exited).resolves.toEqual({ code: null, signal: 'SIGTERM' });
  }, 60_000);
});

describe('two plugins cannot claim overlapping namespaces', () => {
  it('loads the first claimant and refuses every later one, without starting it', async () => {
    const userDir = await tempDir();
    const { spawn, processes } = recordingSpawn();

    // Discovery walks each directory in sorted order, so "first claimant" is a
    // property of the install, not of the filesystem's mood.
    await writePluginDir(join(userDir, 'alpha-plugin'), {
      manifest: { name: 'alpha-plugin', namespace: 'overlap.demo', displayName: 'Alpha' },
      entry: entryFor('overlap.demo.noop'),
    });
    await writePluginDir(join(userDir, 'beta-plugin'), {
      manifest: { name: 'beta-plugin', namespace: 'overlap.demo', displayName: 'Beta' },
      entry: entryFor('overlap.demo.noop'),
    });
    await writePluginDir(join(userDir, 'gamma-plugin'), {
      manifest: { name: 'gamma-plugin', namespace: 'overlap.demo.extra', displayName: 'Gamma' },
      entry: entryFor('overlap.demo.extra.noop'),
    });

    host = createPluginHost({
      userDir,
      childEntry: CHILD_ENTRY,
      spawn,
      consent: {
        'alpha-plugin': { enabled: true, permissions: [] },
        'beta-plugin': { enabled: true, permissions: [] },
        'gamma-plugin': { enabled: true, permissions: [] },
      },
      capabilities: stubCapabilities().capabilities,
    });

    const byId = new Map((await host.discover()).map((plugin) => [plugin.id, plugin]));

    expect(byId.get('alpha-plugin')!.state).toBe('loaded');
    expect(byId.get('alpha-plugin')!.nodeTypes).toEqual(['overlap.demo.noop']);

    // Identical namespace.
    expect(byId.get('beta-plugin')!.state).toBe('failed');
    expect(byId.get('beta-plugin')!.error).toBe(
      'namespace "overlap.demo" overlaps "overlap.demo", already claimed by plugin "alpha-plugin"',
    );
    // A namespace nested under one already claimed: "overlap.demo" would
    // otherwise silently own "overlap.demo.extra"'s node ids.
    expect(byId.get('gamma-plugin')!.state).toBe('failed');
    expect(byId.get('gamma-plugin')!.error).toBe(
      'namespace "overlap.demo.extra" overlaps "overlap.demo", already claimed by plugin "alpha-plugin"',
    );

    // Exactly one `overlap.demo.noop` is on offer, and the refused plugins were
    // never started — the clash is settled from manifests alone.
    expect(host.nodeModules().map((mod) => mod.manifest.type)).toEqual(['overlap.demo.noop']);
    expect(processes).toHaveLength(1);
  }, 60_000);
});
