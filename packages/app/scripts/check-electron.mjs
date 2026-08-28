/**
 * Make sure Electron's binary exists before anything tries to launch it —
 * downloading it if it does not.
 *
 * `electron` the npm package is a few hundred kilobytes of JavaScript; the
 * ~100 MB runtime is a separate download. **Electron 44 removed the postinstall
 * script that used to fetch it** and made the download lazy instead: its
 * `index.js` exports `getElectronPath()`, which downloads on first
 * `require('electron')` when `path.txt` and `dist/` are missing.
 *
 * electron-vite does not go through that. It has its own `getElectronPath()`
 * that reads `path.txt` directly and throws when it is absent:
 *
 *     Error: Electron uninstall
 *         at getElectronPath (…/electron-vite/dist/chunks/lib-….js)
 *
 * So the lazy download never fires, and a fresh clone fails at `pnpm dev` with a
 * message that names neither the cause nor the fix, and points at an uninstall
 * nobody ran. Requiring `electron` here closes the gap: it is Electron's own
 * supported mechanism, so this is less a workaround than calling the thing
 * electron-vite skips.
 *
 * Runs before `dev` and `smoke`. Deliberately NOT before `build`, `test` or the
 * CLI, which all work without the binary — gating commands that do not need a
 * 100 MB download on having one would be its own kind of wrong.
 */
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

function fail(detail) {
  let installer = '<electron>/install.js';
  try {
    installer = require.resolve('electron/install.js');
  } catch {
    // The package itself is missing; the message below covers that case.
  }
  console.error(
    `\nElectron's binary could not be installed, so there is nothing to launch.\n` +
      `  ${detail}\n` +
      `\nThe ~100 MB runtime is downloaded separately from the npm package.\n` +
      `Electron 44 fetches it on first use rather than in a postinstall step, and\n` +
      `that fetch did not succeed. Run it directly to see the underlying error:\n` +
      `\n  node ${installer}\n` +
      `\nNot through pnpm: \`pnpm install\`, \`pnpm install --force\` and\n` +
      `\`pnpm rebuild electron\` will not do it — electron declares no build\n` +
      `script for them to run. (If the package itself is missing, run\n` +
      `\`pnpm install\` first.)\n` +
      `\nUsual causes are a proxy, a dropped connection, or antivirus quarantining\n` +
      `the archive. Set HTTPS_PROXY, or point Electron at a mirror with\n` +
      `ELECTRON_MIRROR, and retry. See CONTRIBUTING.md §1.\n`,
  );
  process.exit(1);
}

let binary;
try {
  // Electron's own index.js downloads on demand and returns the path. It logs
  // "Downloading Electron binary..." itself, so a first run explains its own
  // pause rather than looking hung.
  binary = require('electron');
} catch (err) {
  fail(err instanceof Error ? err.message : String(err));
}

if (typeof binary !== 'string' || !existsSync(binary)) {
  fail(`electron resolved to ${JSON.stringify(binary)}, which is not a file on disk.`);
}
