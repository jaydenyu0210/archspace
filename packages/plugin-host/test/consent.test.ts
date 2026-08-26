/**
 * Consent is the enable switch, not a label on one (ARCHITECTURE §8.2,
 * ADR-0008 §2; `host.ts`: *"A plugin with no consent record is
 * `needs-consent`, even one that declares no permissions at all"*).
 *
 * This file exists because of a shipped bug: the app could not run its own
 * bundled example workflows, because the first-party plugin sat at
 * `needs-consent` and therefore contributed no node types — the document
 * referenced `aec.review.*` nodes that the registry had never heard of. The
 * failure was invisible from the host's own API surface, which happily listed
 * a plugin it was not offering. So the assertions here are always in pairs:
 * the *state* the host reports, and the *node types it actually hands out*.
 * A regression that fixes one without the other is the bug coming back.
 *
 * The second half pins the other direction — consent that must NOT be honoured.
 * `setConsent` stamps the version and engine API the user actually saw, so an
 * upgraded plugin re-asks instead of inheriting a decision made about different
 * code. That stamp is invisible from outside, so it is tested the only honest
 * way: grant consent, change the plugin on disk, and check the host re-arms.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { createPluginHost, type PluginHost } from '../src/index.js';
import { cleanupTempDirs, tempDir, writePluginDir } from './helpers.js';
import { BUNDLED_PLUGINS_DIR, CHILD_ENTRY, recordingSpawn, stubCapabilities } from './host-fixtures.js';

let host: PluginHost | undefined;

afterEach(async () => {
  await host?.close();
  host = undefined;
  await cleanupTempDirs();
});

describe('consent gates loading (the bug that broke the shipped examples)', () => {
  it('leaves an unreviewed first-party plugin unstarted and contributing no node types', async () => {
    const userDir = await tempDir();
    const { spawn, processes } = recordingSpawn();

    host = createPluginHost({
      bundledDirs: [BUNDLED_PLUGINS_DIR],
      userDir,
      childEntry: CHILD_ENTRY,
      spawn,
      consent: {}, // nobody has said yes yet
      capabilities: stubCapabilities().capabilities,
    });

    const [plugin] = await host.discover();
    expect(plugin.id).toBe('aec-review');
    expect(plugin.state).toBe('needs-consent');
    expect(plugin.error).toMatch(/not been reviewed/);
    expect(plugin.grantedPermissions).toEqual([]);

    // The pair that the shipped bug broke: state *and* contribution.
    expect(plugin.nodeTypes).toEqual([]);
    expect(host.nodeModules()).toEqual([]);

    // And "not loaded" means no plugin code ran at all — consent is checked
    // before the process exists, not after it has imported the entry.
    expect(processes).toEqual([]);
  }, 60_000);

  it('loads the same plugin, and all seven node types, once setConsent says yes', async () => {
    const userDir = await tempDir();
    const { spawn, processes } = recordingSpawn();

    host = createPluginHost({
      bundledDirs: [BUNDLED_PLUGINS_DIR],
      userDir,
      childEntry: CHILD_ENTRY,
      spawn,
      consent: {},
      capabilities: stubCapabilities().capabilities,
    });

    await host.discover();
    expect(host.nodeModules()).toEqual([]);

    await host.setConsent({ 'aec-review': { enabled: true, permissions: [] } });

    const [plugin] = host.list();
    expect(plugin.state).toBe('loaded');
    expect(plugin.error).toBeUndefined();
    expect(plugin.nodeTypes).toHaveLength(7);
    expect(host.nodeModules().map((mod) => mod.manifest.type)).toEqual(plugin.nodeTypes);
    expect(processes).toHaveLength(1);
  }, 60_000);

  it('honours a recorded-but-disabled decision without starting the plugin', async () => {
    const userDir = await tempDir();
    const { spawn, processes } = recordingSpawn();
    await writePluginDir(join(userDir, 'fixture-plugin'));

    host = createPluginHost({
      userDir,
      childEntry: CHILD_ENTRY,
      spawn,
      consent: { 'fixture-plugin': { enabled: false, permissions: [] } },
      capabilities: stubCapabilities().capabilities,
    });

    const [plugin] = await host.discover();
    expect(plugin.state).toBe('disabled');
    expect(plugin.nodeTypes).toEqual([]);
    expect(host.nodeModules()).toEqual([]);
    expect(processes).toEqual([]);
  }, 60_000);
});

describe('consent re-arms when the thing consented to changes', () => {
  it('does not let an upgraded plugin inherit the grant given to the old version', async () => {
    const userDir = await tempDir();
    const pluginDir = join(userDir, 'fixture-plugin');
    const { spawn, processes } = recordingSpawn();
    await writePluginDir(pluginDir, { manifest: { version: '1.0.0' } });

    host = createPluginHost({
      userDir,
      childEntry: CHILD_ENTRY,
      spawn,
      consent: {},
      capabilities: stubCapabilities().capabilities,
    });
    await host.discover();

    // The consent the user gives carries no version — `setConsent` stamps it
    // with what was on screen. That stamp is the whole mechanism under test.
    await host.setConsent({ 'fixture-plugin': { enabled: true, permissions: [] } });
    expect(host.list()[0].state).toBe('loaded');
    expect(host.nodeModules()).toHaveLength(1);
    expect(processes).toHaveLength(1);

    // The plugin is upgraded underneath the grant.
    await writePluginDir(pluginDir, { manifest: { version: '2.0.0' } });
    await host.reload();

    const [plugin] = host.list();
    expect(plugin.state).toBe('needs-consent');
    expect(plugin.error).toBe('consent was given for version 1.0.0; 2.0.0 is installed');
    expect(plugin.nodeTypes).toEqual([]);
    expect(host.nodeModules()).toEqual([]);

    // The new version is not merely un-listed — it was never started, and the
    // process running the consented version is gone.
    expect(processes).toHaveLength(1);
    // Gone cleanly, not killed: `discover()` stops the old runtime with a
    // `shutdown` message that the child obeys, so the exit is a normal one.
    await expect(processes[0].exited).resolves.toEqual({ code: 0, signal: null });
  }, 60_000);

  it('re-arms when the plugin now targets a different engine API than the record', async () => {
    const userDir = await tempDir();
    const { spawn, processes } = recordingSpawn();
    await writePluginDir(join(userDir, 'fixture-plugin'));

    host = createPluginHost({
      userDir,
      childEntry: CHILD_ENTRY,
      spawn,
      // A stamp left by a build of the plugin that targeted engine API 2; the
      // installed one targets 1. The node contract the user consented to is
      // not the node contract that would run.
      consent: { 'fixture-plugin': { enabled: true, permissions: [], version: '1.0.0', engineApi: 2 } },
      capabilities: stubCapabilities().capabilities,
    });

    const [plugin] = await host.discover();
    expect(plugin.state).toBe('needs-consent');
    expect(plugin.error).toMatch(/different engine API/);
    expect(host.nodeModules()).toEqual([]);
    expect(processes).toEqual([]);
  }, 60_000);

  it('re-arms when an upgrade asks for a permission the user never saw', async () => {
    const userDir = await tempDir();
    const pluginDir = join(userDir, 'fixture-plugin');
    const { spawn, processes } = recordingSpawn();
    await writePluginDir(pluginDir, { manifest: { version: '1.0.0', permissions: [] } });

    host = createPluginHost({
      userDir,
      childEntry: CHILD_ENTRY,
      spawn,
      // Same version, same engine API — only the ask has grown. Nothing in the
      // stamp would catch this; the permission diff has to.
      consent: { 'fixture-plugin': { enabled: true, permissions: [], version: '1.0.0', engineApi: 1 } },
      capabilities: stubCapabilities().capabilities,
    });

    await writePluginDir(pluginDir, { manifest: { version: '1.0.0', permissions: ['net', 'secrets:API_TOKEN'] } });
    const [plugin] = await host.discover();

    expect(plugin.state).toBe('needs-consent');
    expect(plugin.error).toBe('new permissions requested: net, secrets:API_TOKEN');
    expect(plugin.grantedPermissions).toEqual([]);
    expect(host.nodeModules()).toEqual([]);
    expect(processes).toEqual([]);
  }, 60_000);
});
