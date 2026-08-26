import { defineConfig } from 'electron-vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { resolve } from 'node:path';

// Workspace packages ship TypeScript source, so main/preload/engine bundles
// include them (no externalizeDepsPlugin). Electron + node builtins stay external.
export default defineConfig({
  main: {
    build: {
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
      rollupOptions: {
        input: { index: resolve(__dirname, 'src/preload/index.ts') },
      },
    },
  },
  renderer: {
    plugins: [react(), tailwindcss()],
  },
});
