/**
 * Fail the build if a workspace package survived into the main/preload output
 * as a bare `require` (ARCHITECTURE §3.2, ADR-0012).
 *
 * This exists because the app once could not start at all, and nothing noticed.
 * `@archspace/*` packages resolve to a `src/index.ts`, so leaving one external
 * hands Node TypeScript at runtime, with `./x.js` imports that exist only as
 * `./x.ts`:
 *
 *     Error [ERR_MODULE_NOT_FOUND]: Cannot find module
 *     '.../packages/autodesk/src/capabilities.js'
 *
 * Every gate stayed green through it. `tsc` type-checks source and never looks
 * at the bundle; `electron-vite build` succeeds either way, because externality
 * is a valid build output; the headless CLI runs through tsx, which strips
 * types and so resolves those exact imports without complaint. The one thing
 * that would have caught it is launching Electron, which no CI step does.
 *
 * So this is a cheap stand-in for the check we cannot cheaply run: it asserts
 * the property the launch depends on, in about ten milliseconds, with no
 * display and no Electron. It is not a substitute for someone running
 * `pnpm dev` — it cannot see a window fail to open — but it does close the
 * specific hole that produced a product which did not run.
 */
import { readdir, readFile } from 'node:fs/promises';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const APP = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Bare specifier for a workspace package, in either module syntax. */
const BARE_WORKSPACE = /(?:require\(|from\s*)["'](@archspace\/[a-z0-9-]+)["']/g;

async function jsFilesIn(dir) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true, recursive: true });
  } catch {
    return []; // Nothing built yet; `build` runs this after electron-vite.
  }
  return entries
    .filter((e) => e.isFile() && e.name.endsWith('.js'))
    .map((e) => join(e.parentPath ?? e.path, e.name));
}

const offenders = [];
for (const dir of ['out/main', 'out/preload']) {
  for (const file of await jsFilesIn(join(APP, dir))) {
    const text = await readFile(file, 'utf8');
    const found = new Set([...text.matchAll(BARE_WORKSPACE)].map((m) => m[1]));
    if (found.size > 0) offenders.push({ file: file.slice(APP.length + 1), packages: [...found].sort() });
  }
}

if (offenders.length > 0) {
  console.error('Workspace packages left external in the Electron bundle:\n');
  for (const { file, packages } of offenders) {
    console.error(`  ${file}`);
    for (const p of packages) console.error(`    ${p}`);
  }
  console.error(
    '\nThese resolve to TypeScript source, so Electron cannot load them at runtime:\n' +
      "the app will die with ERR_MODULE_NOT_FOUND before opening a window.\n" +
      'Fix: electron.vite.config.ts must exclude them from `build.externalizeDeps`.',
  );
  process.exit(1);
}

console.log('bundle check: no workspace package left external');
