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

/**
 * The installer to re-run, resolved rather than guessed.
 *
 * Printing a relative path would be wrong more often than right: `electron` is
 * a dependency of `@archspace/app`, not of the workspace root, so there is no
 * `node_modules/electron` at the top of the repo — the obvious-looking
 * `node node_modules/electron/install.js` fails there with a module-not-found
 * that reads like a second, unrelated problem.
 */
function installerPath(packageDir) {
  return join(packageDir, 'install.js');
}

function fail(what, detail, packageDir) {
  const rerun = packageDir === undefined
    ? 'node <path-to>/node_modules/electron/install.js'
    : `node ${installerPath(packageDir)}`;
  console.error(
    `\nElectron's binary is not installed, so there is nothing to launch.\n` +
      `  ${what}\n` +
      (detail ? `  ${detail}\n` : '') +
      `\nThe npm package is small; the ~100 MB runtime is downloaded by its own\n` +
      `postinstall step, and that step did not run. Re-run it directly:\n` +
      `\n  ${rerun}\n` +
      `\nDirectly, and not through pnpm: once that script has been skipped,\n` +
      `\`pnpm install\`, \`pnpm install --force\` and \`pnpm rebuild electron\` all\n` +
      `decline to re-run it. Verified — they report success and change nothing.\n` +
      `\nWhy it was skipped, in order of likelihood:\n` +
      `\n  1. Your pnpm ignored the build-script allowlist. pnpm moved its\n` +
      `     settings out of package.json's "pnpm" field into\n` +
      `     pnpm-workspace.yaml; newer versions ignore the old location and say\n` +
      `     so in a warning that is easy to scroll past. This repo now declares\n` +
      `     onlyBuiltDependencies in pnpm-workspace.yaml — if you are on an\n` +
      `     older checkout, git pull.\n` +
      `  2. The download itself failed: a proxy, a dropped connection, or\n` +
      `     antivirus quarantining the archive. Set HTTPS_PROXY, or point\n` +
      `     Electron at a mirror with ELECTRON_MIRROR, and retry.\n` +
      `\nSee CONTRIBUTING.md §1.\n`,
  );
  process.exit(1);
}

let packageDir;
try {
  packageDir = dirname(require.resolve('electron/package.json'));
} catch {
  fail('The `electron` package is not installed at all.', 'Run `pnpm install` first.', undefined);
}

const pathFile = join(packageDir, 'path.txt');
if (!existsSync(pathFile)) {
  fail(`Missing ${pathFile}`, 'That file is written by electron/install.js when the download succeeds.', packageDir);
}

const relative = readFileSync(pathFile, 'utf8').trim();
const binary = join(packageDir, 'dist', relative);
if (!existsSync(binary)) {
  fail(`path.txt points at ${binary}, which does not exist.`, 'The download was interrupted or the archive was removed.', packageDir);
}
