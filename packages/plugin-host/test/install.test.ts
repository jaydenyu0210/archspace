/**
 * Installing and uninstalling a plugin (ARCHITECTURE §8.2, ADR-0008 §5).
 *
 * Every rejection case asserts the same second thing: **the plugins directory
 * is byte-for-byte untouched.** That is the property the whole staging dance
 * exists to buy, and it is the one the app depends on twice over — `discover()`
 * loads any directory with a manifest in it, and the consent sheet rolls a
 * declined install back with `uninstallPlugin(...).catch(() => {})`. A test
 * that only checked the thrown message would pass on an implementation that
 * left half a plugin behind for the next scan to pick up.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { mkdir, readdir, readFile, stat, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { installPluginFromPath, uninstallPlugin } from '../src/index.js';
import { cleanupTempDirs, makeTarGz, packDir, tempDir, writePluginDir } from './helpers.js';

afterEach(cleanupTempDirs);

/** A parent holding an empty `plugins/` and a `src/` to build fixtures in. */
async function workspace(): Promise<{ root: string; pluginsDir: string; sourceDir: string }> {
  const root = await tempDir();
  const pluginsDir = join(root, 'plugins');
  const sourceDir = join(root, 'src');
  await mkdir(pluginsDir, { recursive: true });
  return { root, pluginsDir, sourceDir };
}

async function entriesOf(dir: string): Promise<string[]> {
  return (await readdir(dir)).sort();
}

describe('installPluginFromPath — from a directory', () => {
  it('installs under the id host.ts keys consent by, and nothing else', async () => {
    const { pluginsDir, sourceDir } = await workspace();
    await writePluginDir(sourceDir);

    const installed = await installPluginFromPath(sourceDir, pluginsDir);

    expect(installed.id).toBe('fixture-plugin');
    expect(installed.manifest.namespace).toBe('fixture.plugin');
    expect(installed.containsNativeCode).toBe(false);
    // The id is the directory name — discovery derives the id back from the
    // manifest, so anything else silently detaches the consent just granted.
    expect(await entriesOf(pluginsDir)).toEqual(['fixture-plugin']);
    expect(await entriesOf(join(pluginsDir, 'fixture-plugin'))).toEqual(['archspace-plugin.json', 'index.mjs']);
  });

  it('reports native code so the consent sheet can say so', async () => {
    const { pluginsDir, sourceDir } = await workspace();
    await writePluginDir(sourceDir, { files: { 'node_modules/kernel/build/Release/kernel.node': 'binary' } });

    const installed = await installPluginFromPath(sourceDir, pluginsDir);

    expect(installed.containsNativeCode).toBe(true);
  });

  it('replaces a previous install of the same id, leaving none of it behind', async () => {
    const { pluginsDir, sourceDir } = await workspace();
    await writePluginDir(sourceDir, { files: { 'stale.txt': 'v1' } });
    await installPluginFromPath(sourceDir, pluginsDir);

    const next = join(await tempDir(), 'v2');
    await writePluginDir(next, { manifest: { version: '2.0.0' }, files: { 'fresh.txt': 'v2' } });
    const installed = await installPluginFromPath(next, pluginsDir);

    expect(installed.manifest.version).toBe('2.0.0');
    expect(await entriesOf(pluginsDir)).toEqual(['fixture-plugin']);
    const files = await entriesOf(join(pluginsDir, 'fixture-plugin'));
    expect(files).toContain('fresh.txt');
    expect(files).not.toContain('stale.txt');
  });

  it('creates the managed plugins directory on a fresh profile', async () => {
    const { root, sourceDir } = await workspace();
    const fresh = join(root, 'never-used', 'plugins');
    await writePluginDir(sourceDir);

    await installPluginFromPath(sourceDir, fresh);

    expect(await entriesOf(fresh)).toEqual(['fixture-plugin']);
  });

  it('leaves no staging directory behind for discover() to trip over', async () => {
    const { pluginsDir, sourceDir } = await workspace();
    await writePluginDir(sourceDir);
    await installPluginFromPath(sourceDir, pluginsDir);
    expect(await entriesOf(pluginsDir)).toEqual(['fixture-plugin']);
  });
});

describe('installPluginFromPath — from a packed tarball', () => {
  it('installs an archive with the wrapper directory every packing tool writes', async () => {
    const { pluginsDir, sourceDir } = await workspace();
    const packed = join(sourceDir, '..', 'pack', 'fixture-plugin');
    await writePluginDir(packed);
    const tarball = join(await tempDir(), 'fixture-plugin-1.0.0.tgz');
    await packDir(packed, tarball, 'fixture-plugin');

    const installed = await installPluginFromPath(tarball, pluginsDir);

    expect(installed.id).toBe('fixture-plugin');
    expect(await entriesOf(pluginsDir)).toEqual(['fixture-plugin']);
    expect(await readFile(join(pluginsDir, 'fixture-plugin', 'index.mjs'), 'utf8')).toContain('fixture.plugin.noop');
  });

  it('installs an archive packed from inside the plugin directory', async () => {
    const { pluginsDir, sourceDir } = await workspace();
    await writePluginDir(sourceDir);
    const tarball = join(await tempDir(), 'flat.tgz');
    await packDir(sourceDir, tarball);

    const installed = await installPluginFromPath(tarball, pluginsDir);

    expect(installed.id).toBe('fixture-plugin');
    expect(await entriesOf(pluginsDir)).toEqual(['fixture-plugin']);
  });
});

describe('installPluginFromPath — refusals', () => {
  it('refuses a manifest that does not parse, and installs nothing', async () => {
    const { pluginsDir, sourceDir } = await workspace();
    await writePluginDir(sourceDir, { rawManifest: '{ "name": "fixture-plugin", ' });

    await expect(installPluginFromPath(sourceDir, pluginsDir)).rejects.toThrow(/not valid JSON/);
    expect(await entriesOf(pluginsDir)).toEqual([]);
  });

  it('refuses a manifest that is structurally invalid, and installs nothing', async () => {
    const { pluginsDir, sourceDir } = await workspace();
    await writePluginDir(sourceDir, { manifest: { namespace: 'Not A Namespace', permissions: ['telepathy'] } });

    await expect(installPluginFromPath(sourceDir, pluginsDir)).rejects.toThrow(/namespace/);
    expect(await entriesOf(pluginsDir)).toEqual([]);
  });

  it('refuses an engineApi this build does not implement, and installs nothing', async () => {
    const { pluginsDir, sourceDir } = await workspace();
    await writePluginDir(sourceDir, { manifest: { engineApi: 2 } });

    await expect(installPluginFromPath(sourceDir, pluginsDir)).rejects.toThrow(/engine API 2/);
    expect(await entriesOf(pluginsDir)).toEqual([]);
  });

  it('refuses a plugin whose entry has not been built', async () => {
    const { pluginsDir, sourceDir } = await workspace();
    await writePluginDir(sourceDir, { manifest: { entry: 'dist/index.js' } });

    await expect(installPluginFromPath(sourceDir, pluginsDir)).rejects.toThrow(/has not been built/);
    expect(await entriesOf(pluginsDir)).toEqual([]);
  });

  it('refuses an archive entry that escapes the plugin directory, and writes nothing at all', async () => {
    const { root, pluginsDir } = await workspace();
    const tarball = join(root, 'evil.tgz');
    await writeFile(
      tarball,
      makeTarGz([
        { name: 'archspace-plugin.json', body: '{}' },
        { name: '../evil', body: 'pwned' },
      ]),
    );

    // Rejected from the entry listing, before `tar -xf` is ever spawned.
    await expect(installPluginFromPath(tarball, pluginsDir)).rejects.toThrow(/escapes the plugin directory/);
    expect(await entriesOf(pluginsDir)).toEqual([]);
    await expect(stat(join(root, 'evil'))).rejects.toThrow();
  });

  it('refuses an archive containing a symlink out of the plugin directory', async () => {
    const { pluginsDir, sourceDir } = await workspace();
    await writePluginDir(sourceDir);
    // The name is contained; the link is not. This is the case entry-name
    // validation cannot see, and the reason the unpacked tree is audited.
    await symlink('/etc', join(sourceDir, 'vendor'));
    const tarball = join(await tempDir(), 'linked.tgz');
    await packDir(sourceDir, tarball);

    await expect(installPluginFromPath(tarball, pluginsDir)).rejects.toThrow(/points outside the plugin directory/);
    expect(await entriesOf(pluginsDir)).toEqual([]);
  });

  it('refuses a source that is not there', async () => {
    const { root, pluginsDir } = await workspace();
    await expect(installPluginFromPath(join(root, 'nope.tgz'), pluginsDir)).rejects.toThrow(/does not exist/);
    expect(await entriesOf(pluginsDir)).toEqual([]);
  });

  it('refuses a file that is not an archive', async () => {
    const { root, pluginsDir } = await workspace();
    const notAnArchive = join(root, 'notes.txt');
    await writeFile(notAnArchive, 'this is not a tarball');

    await expect(installPluginFromPath(notAnArchive, pluginsDir)).rejects.toThrow(/tar archive/);
    expect(await entriesOf(pluginsDir)).toEqual([]);
  });
});

describe('uninstallPlugin', () => {
  it('removes the plugin directory', async () => {
    const { pluginsDir, sourceDir } = await workspace();
    await writePluginDir(sourceDir);
    const { id } = await installPluginFromPath(sourceDir, pluginsDir);

    await uninstallPlugin(id, pluginsDir);

    expect(await entriesOf(pluginsDir)).toEqual([]);
  });

  it('is idempotent, because the declined-consent rollback calls it blind', async () => {
    const { pluginsDir, sourceDir } = await workspace();
    await writePluginDir(sourceDir);
    const { id } = await installPluginFromPath(sourceDir, pluginsDir);

    await uninstallPlugin(id, pluginsDir);
    await expect(uninstallPlugin(id, pluginsDir)).resolves.toBeUndefined();
    await expect(uninstallPlugin('never-installed', pluginsDir)).resolves.toBeUndefined();
  });

  it.each(['../evil', 'nested/plugin', '.', '..', '', '/etc'])(
    'refuses to delete anything outside the plugins directory (%j)',
    async (id) => {
      const { root, pluginsDir } = await workspace();
      const bystander = join(root, 'evil');
      await mkdir(bystander, { recursive: true });

      await expect(uninstallPlugin(id, pluginsDir)).rejects.toThrow();
      await expect(stat(bystander)).resolves.toBeTruthy();
      await expect(stat(pluginsDir)).resolves.toBeTruthy();
    },
  );
});
