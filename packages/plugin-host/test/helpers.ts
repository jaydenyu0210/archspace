/**
 * Fixtures for the plugin-host suite (ADR-0013 §1: everything below the shell
 * is headless, so these tests build real directories and real archives on
 * disk rather than mocking `node:fs`). The install path's whole promise is
 * about what is and is not present in a directory at a given moment — a
 * mocked filesystem would assert our beliefs about `rename`, not `rename`.
 */
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { promisify } from 'node:util';

export const execFileAsync = promisify(execFile);

const roots: string[] = [];

/** A throwaway directory, removed by `cleanupTempDirs()`. */
export async function tempDir(prefix = 'archspace-plugin-host-'): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  roots.push(dir);
  return dir;
}

export async function cleanupTempDirs(): Promise<void> {
  await Promise.all(roots.splice(0).map((dir) => rm(dir, { recursive: true, force: true }).catch(() => undefined)));
}

/** Write `files` (relative path → contents) under `dir`, creating parents. */
export async function writeTree(dir: string, files: Record<string, string>): Promise<string> {
  for (const [relative, contents] of Object.entries(files)) {
    const path = join(dir, relative);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, contents);
  }
  await mkdir(dir, { recursive: true });
  return dir;
}

export interface PluginFixture {
  /** Overrides merged into the manifest; `null` values delete the key. */
  manifest?: Record<string, unknown>;
  /** Raw manifest text, for the "not even JSON" cases. */
  rawManifest?: string;
  /** Extra files, relative to the plugin root. */
  files?: Record<string, string>;
  /** Contents of the entry module (default: an empty node list is invalid, so
   *  this defaults to one trivial node). */
  entry?: string;
}

export const DEFAULT_ENTRY = `const manifest = (type) => ({
  type,
  version: 1,
  label: type,
  description: 'fixture',
  category: 'test',
  params: { type: 'object', properties: {} },
  inputs: [],
  outputs: [{ id: 'out', type: 'text' }],
  caching: 'never',
});
export default [{ manifest: manifest('fixture.plugin.noop'), async execute() { return { out: 'ok' }; } }];
`;

/** A complete, valid plugin directory at `dir`. */
export async function writePluginDir(dir: string, fixture: PluginFixture = {}): Promise<string> {
  const manifest: Record<string, unknown> = {
    name: 'fixture-plugin',
    version: '1.0.0',
    namespace: 'fixture.plugin',
    displayName: 'Fixture Plugin',
    engineApi: 1,
    entry: 'index.mjs',
    permissions: [],
    ...fixture.manifest,
  };
  for (const [key, value] of Object.entries(manifest)) {
    if (value === null) delete manifest[key];
  }
  await writeTree(dir, {
    'archspace-plugin.json': fixture.rawManifest ?? JSON.stringify(manifest, null, 2),
    'index.mjs': fixture.entry ?? DEFAULT_ENTRY,
    ...fixture.files,
  });
  return dir;
}

/** Pack `dir` with the system tar, the way ADR-0008 §5 says plugins ship. */
export async function packDir(dir: string, tarball: string, wrapper?: string): Promise<string> {
  await mkdir(dirname(tarball), { recursive: true });
  const args =
    wrapper === undefined
      ? ['-czf', tarball, '-C', dir, '.']
      : ['-czf', tarball, '-C', dirname(dir), wrapper];
  await execFileAsync('tar', args);
  return tarball;
}

// ---------------------------------------------------------------------------
// A hand-rolled tar, for the entries the system tar refuses to create
// ---------------------------------------------------------------------------

/**
 * `tar -cf … ../evil` silently rewrites the member name ("Removing leading
 * `../'"), so a real traversal archive cannot be produced with the CLI — and a
 * test that cannot produce the attack cannot prove the defence. ustar headers
 * are 512 bytes of ASCII, so we write one.
 */
function ustarHeader(name: string, size: number): Buffer {
  const header = Buffer.alloc(512);
  header.write(name, 0, 100, 'utf8');
  header.write('000644 \0', 100, 8); // mode
  header.write('000000 \0', 108, 8); // uid
  header.write('000000 \0', 116, 8); // gid
  header.write(`${size.toString(8).padStart(11, '0')} `, 124, 12);
  header.write(`${Math.floor(Date.now() / 1000).toString(8).padStart(11, '0')} `, 136, 12);
  header.write('        ', 148, 8); // checksum field counts as spaces while summing
  header.write('0', 156, 1); // typeflag: regular file
  header.write('ustar\0', 257, 6);
  header.write('00', 263, 2);
  let checksum = 0;
  for (const byte of header) checksum += byte;
  header.write(`${checksum.toString(8).padStart(6, '0')}\0 `, 148, 8);
  return header;
}

export function makeTarGz(entries: { name: string; body: string }[]): Buffer {
  const blocks: Buffer[] = [];
  for (const entry of entries) {
    const body = Buffer.from(entry.body, 'utf8');
    blocks.push(ustarHeader(entry.name, body.length), body);
    const padding = (512 - (body.length % 512)) % 512;
    if (padding > 0) blocks.push(Buffer.alloc(padding));
  }
  blocks.push(Buffer.alloc(1024)); // end-of-archive: two zero blocks
  return gzipSync(Buffer.concat(blocks));
}
