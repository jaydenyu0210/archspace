/**
 * Fail early, and usefully, when Electron's binary is missing.
 *
 * `electron` the npm package is a few kilobytes of JavaScript; the ~100 MB
 * runtime is fetched by its own postinstall script, which writes `path.txt` and
 * a `dist/` directory next to it. When that download does not happen — a proxy,
 * a dropped connection, an antivirus product eating the zip, or build scripts
 * never being approved — `pnpm install` still reports success and the failure
 * only surfaces later as:
 *
 *     Error: Electron uninstall
 *         at getElectronPath (…/electron-vite/dist/chunks/lib-….js)
 *
 * which says nothing about what is wrong or what to do, and sends people
 * looking for an uninstall they never ran. This turns that into the two
 * commands that actually fix it.
 *
 * Run before anything that launches the real binary (`dev`, `smoke`). Not
 * before `build`, which only bundles JavaScript and works fine without it.
 */
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

const require = createRequire(import.meta.url);

function fail(what, detail) {
  console.error(
    `\nElectron's binary is not installed, so there is nothing to launch.\n` +
      `  ${what}\n` +
      (detail ? `  ${detail}\n` : '') +
      `\nThe npm package is small; the ~100 MB runtime is downloaded by its own\n` +
      `postinstall step, and that step did not complete. Re-run it:\n` +
      `\n  pnpm rebuild electron\n` +
      `\nIf that fails, run it directly to see the underlying error — a proxy, a\n` +
      `dropped connection, or antivirus quarantining the download are the usual\n` +
      `causes, and only this command will tell you which:\n` +
      `\n  node node_modules/electron/install.js\n` +
      `\nBehind a corporate proxy, point Electron at a mirror or set HTTPS_PROXY\n` +
      `before retrying. See CONTRIBUTING.md §1.\n`,
  );
  process.exit(1);
}

let packageDir;
try {
  packageDir = dirname(require.resolve('electron/package.json'));
} catch {
  fail('The `electron` package is not installed at all.', 'Run `pnpm install` first.');
}

const pathFile = join(packageDir, 'path.txt');
if (!existsSync(pathFile)) {
  fail(`Missing ${pathFile}`, 'That file is written by electron/install.js when the download succeeds.');
}

const relative = readFileSync(pathFile, 'utf8').trim();
const binary = join(packageDir, 'dist', relative);
if (!existsSync(binary)) {
  fail(`path.txt points at ${binary}, which does not exist.`, 'The download was interrupted or the archive was removed.');
}
