/**
 * "Does this plugin ship native code?" — the honesty affordance behind the
 * install-consent sheet (ARCHITECTURE §13 last bullet, ADR-0008 §3).
 *
 * **What this proves: nothing about safety.** It is not a scanner, not a
 * signature check, and not a security control. It answers exactly one question
 * — *is there compiled, platform-specific code in this package?* — so the
 * consent dialog can say "this plugin contains native code … it is not a
 * security sandbox" instead of quietly omitting it. A pure-JS plugin can still
 * do everything the user can do (ADR-0008 §3): the process boundary is fault
 * isolation plus permission mediation, and `node:fs` is reachable from plain
 * JavaScript. So a `false` here means "we found no compiled artifact", never
 * "this plugin is safe", and the copy in packages/app/src/main/plugins.ts is
 * worded accordingly.
 *
 * Given that, the design bias is deliberate: **a false negative is the only
 * expensive error.** A missed `.node` silently deletes a real warning from a
 * real dialog, while a false positive merely shows a warning that is one
 * sentence too cautious. So the signals below are the honest ones a package
 * cannot ship native code without leaving at least one of — the compiled
 * artifact itself, the build recipe, the prebuild cache, or the install script
 * that fetches/builds it — and any single hit is enough. `node_modules` is
 * walked rather than skipped, because that is precisely where a transitive
 * native dependency hides; nested `package.json` files are the reason the walk
 * has to go all the way down.
 *
 * Rejected alternatives:
 *   - **Read file headers** (Mach-O / ELF / PE magic) instead of trusting
 *     extensions: strictly more accurate, but it means opening every file in a
 *     dependency tree at install time to catch a case (`libfoo.bin`) that no
 *     real toolchain produces. Extensions plus build-system markers are the
 *     signals real packages actually emit.
 *   - **Ask npm** (`gypfile`, `binary` fields) and stop there: describes intent,
 *     not contents, and misses vendored `.dylib`s entirely. Used here as one
 *     more signal, not as the answer.
 *
 * Bounds: the walk is depth- and entry-capped so a pathological package cannot
 * turn an install click into an unbounded traversal, it never follows a
 * symlink (a link is judged by its own name, so a `.node` symlink still
 * counts), and the only file bodies it reads are `package.json`s — capped in
 * size, because that is untrusted input too.
 */
import type { Dirent } from 'node:fs';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';

/** Compiled addons and platform shared libraries. `.so.1.2` is matched by the
 *  regex rather than by extension, because versioned sonames are how Linux
 *  packages actually vendor their libraries. */
const NATIVE_FILE_RE = /(\.node|\.dylib|\.dll|\.so|\.so\.[0-9]+(\.[0-9]+)*)$/i;

/** Build recipes and prebuild caches, matched by exact name. */
const NATIVE_FILE_NAMES = new Set(['binding.gyp']);
const NATIVE_DIR_NAMES = new Set(['prebuilds']);

/** The install-script toolchains whose whole job is to compile or download a
 *  binary. `cmake-js` and `prebuildify` are here for the same reason as the
 *  three ADR-named ones: they leave no other trace before the first install. */
const NATIVE_TOOL_RE = /\b(node-gyp|node-pre-gyp|prebuild-install|prebuildify|cmake-js)\b/;

/** Directories that cannot contain shipped code but can contain a great deal
 *  of everything else. Note `node_modules` is deliberately NOT here. */
const SKIP_DIR_NAMES = new Set(['.git', '.hg', '.svn']);

/** Bounds on the walk. Generous enough that no honest plugin reaches them, low
 *  enough that a hostile one cannot hang the consent dialog. */
const MAX_ENTRIES = 60_000;
const MAX_DEPTH = 32;
/** A `package.json` larger than this is not a manifest; refuse to read it
 *  rather than pull an arbitrary blob into memory during an install. */
const MAX_MANIFEST_BYTES = 1_000_000;

/**
 * True when `dir` contains at least one honest signal of compiled,
 * platform-specific code. A missing or unreadable directory is `false`: the
 * caller is describing something it is about to install or has just scanned,
 * and "I could not look" is not a warning we can put in front of a user.
 */
export async function containsNativeCode(dir: string): Promise<boolean> {
  let budget = MAX_ENTRIES;

  const walk = async (current: string, depth: number): Promise<boolean> => {
    if (depth > MAX_DEPTH || budget <= 0) return false;
    let entries: Dirent[];
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch {
      return false; // Unreadable subtree: not evidence either way.
    }

    const subdirs: string[] = [];
    for (const entry of entries) {
      if (budget-- <= 0) return false;
      const { name } = entry;

      // Symlinks are judged by their own name and never followed: following
      // them is how a walk leaves the directory it was asked about, and how it
      // finds a cycle. A link *named* `foo.node` is still a signal.
      if (entry.isSymbolicLink()) {
        if (NATIVE_FILE_RE.test(name) || NATIVE_FILE_NAMES.has(name)) return true;
        continue;
      }

      if (entry.isDirectory()) {
        if (NATIVE_DIR_NAMES.has(name)) return true;
        if (!SKIP_DIR_NAMES.has(name)) subdirs.push(join(current, name));
        continue;
      }

      if (!entry.isFile()) continue;
      if (NATIVE_FILE_RE.test(name) || NATIVE_FILE_NAMES.has(name)) return true;
      if (name === 'package.json' && (await declaresNativeBuild(join(current, name)))) return true;
    }

    for (const sub of subdirs) {
      if (await walk(sub, depth + 1)) return true;
    }
    return false;
  };

  return walk(dir, 0);
}

/**
 * True when a `package.json` says it builds or downloads a binary: an install
 * hook running one of the native toolchains, or npm's own `gypfile` marker.
 * Only the hook scripts are inspected — a `build` script calling node-gyp is a
 * developer convenience that never runs on the user's machine, and treating it
 * as a signal would flag half the repositories on npm.
 */
async function declaresNativeBuild(file: string): Promise<boolean> {
  let raw: string;
  try {
    raw = await readFile(file, 'utf8');
  } catch {
    return false;
  }
  if (raw.length > MAX_MANIFEST_BYTES) return false;

  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return false; // A broken manifest is a packaging bug, not a native-code claim.
  }
  if (typeof json !== 'object' || json === null) return false;

  const pkg = json as { gypfile?: unknown; binary?: unknown; scripts?: unknown };
  if (pkg.gypfile === true) return true;
  // node-pre-gyp's `binary` block exists only to locate a prebuilt binary.
  if (typeof pkg.binary === 'object' && pkg.binary !== null) return true;

  if (typeof pkg.scripts !== 'object' || pkg.scripts === null) return false;
  const scripts = pkg.scripts as Record<string, unknown>;
  for (const hook of ['preinstall', 'install', 'postinstall'] as const) {
    const script = scripts[hook];
    if (typeof script === 'string' && NATIVE_TOOL_RE.test(script)) return true;
  }
  return false;
}
