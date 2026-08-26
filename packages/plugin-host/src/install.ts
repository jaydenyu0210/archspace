/**
 * Installing and removing a plugin package (ARCHITECTURE §8.2, ADR-0008 §5).
 *
 * v1 distribution is "a packed tarball installed into the managed plugins
 * directory", plus the case that keeps plugin authoring bearable: pointing the
 * installer at the directory you just built. Both land in the same place and
 * obey the same rule — **a plugin directory appears under `pluginsDir` only
 * once it is complete and its manifest has been validated.**
 *
 * That rule is not tidiness. `discover()` in host.ts scans `pluginsDir` one
 * level deep and loads whatever has an `archspace-plugin.json`, and
 * packages/app/src/main/plugins.ts calls `uninstallPlugin` to roll back when
 * the user *declines* the consent sheet. So a half-unpacked directory visible
 * to discovery is a plugin the user never consented to, running. Hence:
 * unpack into a staging directory, validate there, and make the last step a
 * single `rename` — the one filesystem operation that is atomic enough for the
 * promise we are making.
 *
 * The staging directory is `<pluginsDir>/.staging/<mkdtemp>` for two reasons at
 * once: it is on the same filesystem as the destination, so the final `rename`
 * cannot fail with `EXDEV`; and it is one level too deep for `scanDir`, which
 * looks for `<pluginsDir>/<name>/archspace-plugin.json` and will never see
 * `<pluginsDir>/.staging/<x>/…`. A sibling temp directory would have satisfied
 * only the second; `os.tmpdir()` only the first.
 *
 * **Spawning the system `tar`.** This package has two workspace dependencies
 * and no archive library, and ADR-0008's distribution story does not justify
 * pulling `node-tar` (and its dependency tree) into the host process to run
 * once per install click. macOS ships bsdtar, Linux ships GNU tar, and both
 * read a gzipped tarball with `-xf` (compression is auto-detected by both, so
 * no `-z` and no format sniffing here). The trade-off is real and worth
 * stating: we inherit whatever extraction semantics the local `tar` has,
 * including its handling of hostile entries — which is exactly why this file
 * does not trust it. Every entry name is validated with the manifest module's
 * `isContainedRelativePath` *before* extraction, and the unpacked tree is
 * audited for symlinks pointing out of it *after*. A plugin tarball is
 * downloaded, untrusted input; `tar` is a tool we call, not a boundary we lean
 * on. If Node ever grows a first-party archive reader, this is the file that
 * gets shorter.
 *
 * Note what installing is *not*: it is not consent, and it is not trust. It
 * validates a manifest and reports `containsNativeCode` so the caller can put
 * an honest sheet in front of a user (ADR-0008 §3); granting anything is the
 * caller's separate, explicit act.
 */
import { execFile } from 'node:child_process';
import type { Dirent, Stats } from 'node:fs';
import { cp, mkdir, mkdtemp, readFile, readdir, readlink, rename, rm, rmdir, stat } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import { containsNativeCode } from './native.js';
import {
  ENGINE_API,
  PLUGIN_MANIFEST_FILENAME,
  isContainedRelativePath,
  parsePluginManifest,
  type PluginManifest,
} from './manifest.js';

const execFileAsync = promisify(execFile);

/** Hidden, and one level deeper than discovery looks — see the file comment. */
const STAGING_DIR_NAME = '.staging';

/** `tar -tf` on a large dependency tree prints a lot of lines; the default 1 MiB
 *  would turn a big-but-honest plugin into a failed install. */
const TAR_LIST_MAX_BUFFER = 32 * 1024 * 1024;

/** Bounds the post-extraction symlink audit, for the same reason native.ts
 *  bounds its walk: an install click must not become an unbounded traversal. */
const MAX_AUDIT_DEPTH = 32;
const MAX_AUDIT_ENTRIES = 60_000;

export interface PluginInstallation {
  /** The installed plugin's id — `manifest.name`, which is also its directory
   *  name and the key consent is recorded under. See `pluginDirectory`. */
  id: string;
  manifest: PluginManifest;
  /** For the consent sheet's native-code sentence (ADR-0008 §3). Not a safety
   *  verdict — see native.ts. */
  containsNativeCode: boolean;
}

/**
 * Install the plugin at `source` — a `.tgz`/`.tar.gz` archive or a plugin
 * directory — into `pluginsDir`, replacing any existing install with the same
 * id, and return what the caller needs to ask for consent.
 *
 * Throws with a message meant to be shown to a user. On any throw, `pluginsDir`
 * is left exactly as it was found.
 */
export async function installPluginFromPath(source: string, pluginsDir: string): Promise<PluginInstallation> {
  const root = resolve(pluginsDir);
  const stagingRoot = join(root, STAGING_DIR_NAME);
  await mkdir(stagingRoot, { recursive: true });
  const work = await mkdtemp(join(stagingRoot, 'install-'));

  try {
    const unpackDir = join(work, 'unpack');
    await unpack(resolve(source), unpackDir);

    // Validate before the plugin can be discovered, not after: an invalid
    // manifest must never have existed under `pluginsDir` at all.
    const pluginRoot = await locateManifestRoot(unpackDir, source);
    const manifest = await readValidManifest(pluginRoot);
    const target = pluginDirectory(root, manifest.name);
    const native = await containsNativeCode(pluginRoot);

    await commit(pluginRoot, target, join(work, 'previous'));
    return { id: manifest.name, manifest, containsNativeCode: native };
  } finally {
    // Whatever happened, take the staging tree with us. The `rmdir` is
    // best-effort and non-recursive on purpose: it tidies `.staging` away when
    // this was the only install in flight, and quietly loses the race to a
    // concurrent one, which is the correct outcome either way.
    await rm(work, { recursive: true, force: true }).catch(() => undefined);
    await rmdir(stagingRoot).catch(() => undefined);
  }
}

/**
 * Remove an installed plugin's directory. Idempotent: removing a plugin that
 * is not there is success, because packages/app/src/main/plugins.ts calls this
 * as `….catch(() => {})` to roll back a declined consent, and a rollback that
 * throws when there is nothing to roll back is a rollback nobody can trust.
 *
 * Refuses any id that is not a single path segment inside `pluginsDir`. The id
 * comes from a manifest, and a manifest is untrusted input: `"name": "../.."`
 * must fail here even though it can never pass `parsePluginManifest`, because
 * this function is also reachable from an IPC handler with a caller-supplied id.
 */
export async function uninstallPlugin(id: string, pluginsDir: string): Promise<void> {
  const target = pluginDirectory(resolve(pluginsDir), id);
  await rm(target, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// Where a plugin is allowed to live
// ---------------------------------------------------------------------------

/**
 * The directory an id maps to — the single place install and uninstall agree
 * on. The id *is* the directory name, because host.ts keys a plugin by
 * `manifest.name` (`const id = candidate.manifest?.name ?? candidate.dir`) and
 * consent is recorded under that same key: install somewhere else and the
 * consent the user just gave attaches to nothing.
 */
function pluginDirectory(pluginsRoot: string, id: string): string {
  if (!isPluginDirectoryName(id)) {
    throw new Error(`"${id}" is not a valid plugin id — a plugin id is a single directory name inside the plugins folder`);
  }
  const target = resolve(pluginsRoot, id);
  // Belt and braces: the rule above already implies this, and the day someone
  // relaxes the rule this is the assertion that still says no.
  if (!isInside(pluginsRoot, target)) {
    throw new Error(`refusing to touch "${target}" — it is outside the plugins directory "${pluginsRoot}"`);
  }
  return target;
}

function isPluginDirectoryName(id: string): boolean {
  if (id.length === 0 || id === '.' || id === '..') return false;
  if (id.includes('/') || id.includes('\\') || id.includes(sep)) return false;
  return isContainedRelativePath(id);
}

/** True when `candidate` is a strict descendant of `root`. */
function isInside(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel.length > 0 && !rel.startsWith('..') && !isAbsolute(rel);
}

// ---------------------------------------------------------------------------
// Unpacking
// ---------------------------------------------------------------------------

async function unpack(source: string, into: string): Promise<void> {
  let info: Stats;
  try {
    info = await stat(source);
  } catch {
    throw new Error(`"${source}" does not exist`);
  }

  if (info.isDirectory()) {
    // A directory the user picked in a file dialog is content already sitting
    // on their disk under their own authority, so it gets copied rather than
    // audited: the archive checks below exist because a tarball arrives from
    // somewhere else, and applying them here would reject every pnpm workspace
    // checkout (whose `node_modules` is symlinks pointing at a global store).
    await cp(source, into, { recursive: true, filter: notDeveloperJunk });
    return;
  }
  if (!info.isFile()) {
    throw new Error(`"${source}" is neither a plugin directory nor a packed plugin archive`);
  }

  await mkdir(into, { recursive: true });
  await extractArchive(source, into);
}

/** A plugin directory is usually a checkout; its VCS metadata is not part of
 *  the plugin and can dwarf it. */
function notDeveloperJunk(src: string): boolean {
  const name = basename(src);
  return name !== '.git' && name !== '.hg' && name !== '.svn';
}

async function extractArchive(archive: string, into: string): Promise<void> {
  for (const entry of await listArchive(archive)) {
    const name = entry.replace(/[\\/]+$/, ''); // directory entries carry a trailing slash
    if (name.length === 0) continue;
    if (!isContainedRelativePath(name)) {
      throw new Error(
        `"${basename(archive)}" contains an entry that escapes the plugin directory ("${entry}") — refusing to unpack it`,
      );
    }
  }

  try {
    await execFileAsync('tar', ['-xf', archive, '-C', into]);
  } catch (err) {
    throw new Error(`"${basename(archive)}" could not be unpacked: ${tarError(err)}`);
  }

  await assertNoEscapingLinks(into, archive);
}

async function listArchive(archive: string): Promise<string[]> {
  let stdout: string;
  try {
    ({ stdout } = await execFileAsync('tar', ['-tf', archive], { maxBuffer: TAR_LIST_MAX_BUFFER }));
  } catch (err) {
    throw new Error(`"${basename(archive)}" is not a readable tar archive: ${tarError(err)}`);
  }
  // A filename containing a newline arrives as two lines. Both are validated,
  // so the split can only ever reject more than it should — the safe direction.
  return stdout.split('\n').filter((line) => line.length > 0);
}

function tarError(err: unknown): string {
  if (typeof err === 'object' && err !== null) {
    const stderr = (err as { stderr?: unknown }).stderr;
    if (typeof stderr === 'string' && stderr.trim().length > 0) return stderr.trim();
  }
  return err instanceof Error ? err.message : String(err);
}

/**
 * Refuse a tree containing a symlink that points outside it.
 *
 * Validated entry *names* are not enough on their own: the classic archive
 * escape is a well-named symlink (`vendor -> /usr/local/lib`) followed by a
 * well-named file written through it (`vendor/libfoo.dylib`). Some tars refuse
 * that, some do not, and "some" is not a security property — so the tree is
 * checked once here, after extraction, where the answer does not depend on
 * which `tar` the machine happens to ship.
 */
async function assertNoEscapingLinks(root: string, archive: string): Promise<void> {
  let budget = MAX_AUDIT_ENTRIES;

  const walk = async (current: string, depth: number): Promise<void> => {
    if (depth > MAX_AUDIT_DEPTH || budget <= 0) return;
    let entries: Dirent[];
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (budget-- <= 0) return;
      const path = join(current, entry.name);
      if (entry.isSymbolicLink()) {
        const target = resolve(dirname(path), await readlink(path));
        if (!isInside(root, target)) {
          throw new Error(
            `"${basename(archive)}" contains a link that points outside the plugin directory ("${relative(root, path)}" → "${target}") — refusing to install it`,
          );
        }
        continue;
      }
      if (entry.isDirectory()) await walk(path, depth + 1);
    }
  };

  await walk(root, 0);
}

/**
 * The directory holding `archspace-plugin.json`: either the unpacked root, or
 * its single subdirectory. The unwrap exists because every packing tool that
 * matters (`npm pack`, `tar -czf x.tgz ./my-plugin`) writes one wrapper
 * directory, and telling users their correctly-packed tarball is "missing a
 * manifest" would be a lie. It is deliberately one level and one candidate —
 * searching the tree for any manifest would let an archive choose which of
 * several plugins it "is".
 */
async function locateManifestRoot(unpacked: string, source: string): Promise<string> {
  if (await hasManifest(unpacked)) return unpacked;

  let entries: Dirent[];
  try {
    entries = await readdir(unpacked, { withFileTypes: true });
  } catch {
    entries = [];
  }
  const dirs = entries.filter((e) => e.isDirectory());
  if (dirs.length === 1) {
    const nested = join(unpacked, dirs[0].name);
    if (await hasManifest(nested)) return nested;
  }
  throw new Error(`"${basename(source)}" is not an Archspace plugin — it has no ${PLUGIN_MANIFEST_FILENAME}`);
}

async function hasManifest(dir: string): Promise<boolean> {
  try {
    return (await stat(join(dir, PLUGIN_MANIFEST_FILENAME))).isFile();
  } catch {
    return false;
  }
}

/**
 * Parse the staged manifest with the same parser discovery uses, and refuse
 * anything discovery would refuse. Passing `{ dir }` is what makes "the plugin
 * has not been built" an install-time error instead of a mysterious `failed`
 * row in Settings later.
 *
 * The engineApi mismatch is upgraded from `parsePluginManifest`'s warning to a
 * hard failure here, because the two callers want different things: discovery
 * needs the parsed identity so it can render an `incompatible` row explaining
 * itself, while an installer that copied in a plugin it knows cannot load has
 * simply misled the user.
 */
async function readValidManifest(dir: string): Promise<PluginManifest> {
  let raw: string;
  try {
    raw = await readFile(join(dir, PLUGIN_MANIFEST_FILENAME), 'utf8');
  } catch {
    throw new Error(`this plugin has no ${PLUGIN_MANIFEST_FILENAME}`);
  }

  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (err) {
    throw new Error(`${PLUGIN_MANIFEST_FILENAME} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
  }

  const { manifest, issues } = parsePluginManifest(json, { dir });
  const errors = issues.filter((issue) => issue.severity === 'error');
  if (manifest === null || errors.length > 0) {
    const detail = errors.map((issue) => (issue.path ? `${issue.path}: ${issue.message}` : issue.message)).join('; ');
    throw new Error(`${PLUGIN_MANIFEST_FILENAME} is not valid — ${detail}`);
  }
  if (manifest.engineApi !== ENGINE_API) {
    throw new Error(
      `"${manifest.displayName}" targets engine API ${manifest.engineApi}; this build implements ${ENGINE_API}, so it could not be loaded`,
    );
  }
  return manifest;
}

// ---------------------------------------------------------------------------
// The atomic step
// ---------------------------------------------------------------------------

/**
 * Move the validated tree into place, replacing a previous install of the same
 * id. Both moves are `rename` within one filesystem, so the visible states are
 * only ever "old plugin" or "new plugin" — never "half a plugin", which is the
 * one state `discover()` must not be able to observe.
 *
 * The displaced previous version goes into the staging tree rather than to a
 * sibling like `<id>.old`, which discovery *would* see (as a second plugin
 * claiming the same id and namespace). If the second rename fails, it goes back.
 */
async function commit(staged: string, target: string, previous: string): Promise<void> {
  let displaced = false;
  try {
    await rename(target, previous);
    displaced = true;
  } catch {
    // Nothing there to displace: the ordinary first-install path.
  }

  try {
    await rename(staged, target);
  } catch (err) {
    if (displaced) await rename(previous, target).catch(() => undefined);
    throw new Error(`could not move the plugin into "${target}": ${err instanceof Error ? err.message : String(err)}`);
  }
}
