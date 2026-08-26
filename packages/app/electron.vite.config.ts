import { defineConfig } from 'electron-vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// Workspace packages ship TypeScript source — `@archspace/*` resolve to a
// `src/index.ts`, not to built JavaScript — so they MUST be bundled into the
// main, preload and engine outputs. Electron and node builtins stay external.
//
// `ssr.noExternal` is what actually makes that happen, and its absence was a
// launch-blocking bug rather than an optimisation: Vite externalises anything
// it resolves out of `node_modules`, pnpm symlinks workspace packages into
// `node_modules`, so every `@archspace/*` import survived into `out/main` as a
// bare `require(...)`. At runtime Node then loaded `packages/autodesk/src/
// index.ts` and tried to resolve its `./capabilities.js` — a file that exists
// only as `.ts` — and the app died before opening a window:
//
//     Error [ERR_MODULE_NOT_FOUND]: Cannot find module
//     '.../packages/autodesk/src/capabilities.js'
//
// Nothing caught it because no CI step launches Electron; the headless CLI
// runs through tsx, which strips types and therefore resolves those same
// imports happily.
//
// The mechanism is electron-vite 5's `build.externalizeDeps`, which defaults
// to TRUE and externalises every entry in this package's `dependencies` —
// workspace packages included. The list of what to exclude is read from
// package.json rather than written out, so adding a tenth `@archspace/*`
// dependency cannot silently reintroduce the crash, and
// `scripts/check-bundle.mjs` (run by `build` and `dist`) fails the build if a
// bare @archspace require ever reappears in the output anyway.
const pkg = JSON.parse(readFileSync(resolve(__dirname, 'package.json'), 'utf8')) as {
  dependencies?: Record<string, string>;
};
/** Workspace packages: TypeScript source, therefore never external. */
const workspaceDeps = Object.keys(pkg.dependencies ?? {}).filter((d) => d.startsWith('@archspace/'));

export default defineConfig({
  main: {
    build: {
      externalizeDeps: { exclude: workspaceDeps },
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/main/index.ts'),
          engine: resolve(__dirname, 'src/engine-child/index.ts'),
          // Forked once per installed plugin by the engine host (§8.1).
          'plugin-child': resolve(__dirname, 'src/plugin-child/index.ts'),
        },
        output: { entryFileNames: '[name].js' },
      },
    },
  },
  preload: {
    build: {
      externalizeDeps: { exclude: workspaceDeps },
      rollupOptions: {
        input: { index: resolve(__dirname, 'src/preload/index.ts') },
      },
    },
  },
  renderer: {
    plugins: [react(), tailwindcss()],
  },
});
