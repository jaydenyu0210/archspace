/**
 * `containsNativeCode` — the input to the consent sheet's native-code sentence
 * (ARCHITECTURE §13, ADR-0008 §3).
 *
 * The asymmetry these tests encode: a false negative deletes a real warning
 * from a real dialog, so every signal gets its own case, including the ones
 * that only appear deep inside `node_modules` — which is exactly where a
 * transitive native dependency lives and exactly what a "skip node_modules"
 * walk would miss.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { containsNativeCode } from '../src/index.js';
import { cleanupTempDirs, tempDir, writePluginDir, writeTree } from './helpers.js';

afterEach(cleanupTempDirs);

async function plugin(files: Record<string, string>): Promise<string> {
  const dir = await tempDir();
  await writePluginDir(dir, { files });
  return dir;
}

describe('containsNativeCode', () => {
  it('is false for a pure-JS plugin, dependencies and all', async () => {
    const dir = await plugin({
      'dist/index.js': 'export default [];',
      'node_modules/left-pad/package.json': JSON.stringify({ name: 'left-pad', scripts: { test: 'node test.js' } }),
      'node_modules/left-pad/index.js': 'module.exports = () => {};',
      'README.md': '# no binaries here',
    });
    expect(await containsNativeCode(dir)).toBe(false);
  });

  it('finds a compiled addon inside a transitive dependency', async () => {
    const dir = await plugin({
      'node_modules/leveldown/build/Release/leveldown.node': 'MZ-not-really',
    });
    expect(await containsNativeCode(dir)).toBe(true);
  });

  it.each([
    ['a macOS shared library', 'vendor/libgeometry.dylib'],
    ['a Linux shared library', 'vendor/libgeometry.so'],
    ['a versioned soname', 'vendor/libgeometry.so.1.4.2'],
    ['a Windows DLL', 'vendor/geometry.dll'],
  ])('finds %s', async (_label, path) => {
    expect(await containsNativeCode(await plugin({ [path]: 'binary' }))).toBe(true);
  });

  it('finds a node-gyp build recipe', async () => {
    const dir = await plugin({ 'node_modules/sharp/binding.gyp': '{ "targets": [] }' });
    expect(await containsNativeCode(dir)).toBe(true);
  });

  it('finds a prebuilds directory even before it is populated', async () => {
    const dir = await tempDir();
    await writePluginDir(dir);
    await writeTree(dir, { 'node_modules/better-sqlite3/prebuilds/.keep': '' });
    expect(await containsNativeCode(dir)).toBe(true);
  });

  it.each([
    ['node-gyp', { install: 'node-gyp rebuild' }],
    ['prebuild-install', { install: 'prebuild-install || node-gyp rebuild' }],
    ['node-pre-gyp', { postinstall: 'node-pre-gyp install --fallback-to-build' }],
  ])('finds a %s install script in a nested package.json', async (_label, scripts) => {
    const dir = await plugin({
      'node_modules/thing/package.json': JSON.stringify({ name: 'thing', scripts }),
    });
    expect(await containsNativeCode(dir)).toBe(true);
  });

  it('ignores a build script that only ever runs on the author’s machine', async () => {
    const dir = await plugin({
      'node_modules/thing/package.json': JSON.stringify({ name: 'thing', scripts: { build: 'node-gyp rebuild' } }),
    });
    expect(await containsNativeCode(dir)).toBe(false);
  });

  it('does not choke on an unparseable nested package.json', async () => {
    const dir = await plugin({ 'node_modules/broken/package.json': '{ not json' });
    expect(await containsNativeCode(dir)).toBe(false);
  });

  it('reports false for a directory that does not exist rather than throwing', async () => {
    // "I could not look" is not a warning we can put in front of a user.
    await expect(containsNativeCode('/definitely/not/here')).resolves.toBe(false);
  });
});
