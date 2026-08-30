import { defineConfig } from 'electron-vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Plugin } from 'vite';

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

/**
 * web-ifc's wasm as a `data:` URI the renderer can import.
 *
 * The 3D viewer (ADR-0003) must load this binary in the packaged app, whose
 * window is `loadFile`'d from file:// — an origin where Chromium's fetch()
 * refuses wasm URLs, so the usual `?url` asset import works in dev and fails
 * only packaged. A data: URI takes the same fetch path successfully under
 * both origins. Inlining via Vite's `?inline` suffix was tried and rejected
 * by the build itself: Vite reserves bare `.wasm` for its `?init` helper and
 * hands the binary to Rollup's JS parser instead of the asset pipeline. So
 * the inlining is done here, explicitly, where the mechanism is stated
 * rather than inferred from suffix behaviour that has shifted across Vite
 * majors. `scripts/check-bundle.mjs` asserts the URI survived into the
 * renderer bundle, because only a launched window would otherwise notice it
 * missing.
 *
 * The path resolves through the package's own node_modules on purpose:
 * web-ifc is a direct dependency, so pnpm guarantees the symlink exists
 * there, version-locked to what the renderer imports.
 */
const WEB_IFC_WASM_ID = 'virtual:web-ifc-wasm';
function webIfcWasmDataUri(): Plugin {
  return {
    name: 'archspace:web-ifc-wasm-data-uri',
    resolveId(id) {
      return id === WEB_IFC_WASM_ID ? `\0${WEB_IFC_WASM_ID}` : undefined;
    },
    load(id) {
      if (id !== `\0${WEB_IFC_WASM_ID}`) return undefined;
      const wasm = readFileSync(resolve(__dirname, 'node_modules/web-ifc/web-ifc.wasm'));
      return `export default ${JSON.stringify(`data:application/wasm;base64,${wasm.toString('base64')}`)};`;
    },
  };
}

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
    plugins: [react(), tailwindcss(), webIfcWasmDataUri()],
  },
});
