/**
 * Bundles the plugin to a single self-contained dist/index.js.
 *
 * A plugin is loaded by path in its own process, so it cannot rely on the
 * host's node_modules resolution: everything it uses at runtime — including
 * the helpers it borrows from @archspace/nodes-core — is inlined here. This
 * is exactly what a third-party plugin author does before `archspace plugin
 * pack`, which is why it is a plain esbuild call and nothing app-specific.
 */
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = dirname(dirname(fileURLToPath(import.meta.url)));

await build({
  entryPoints: [join(root, 'src/index.ts')],
  outfile: join(root, 'dist/index.js'),
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  sourcemap: true,
  logLevel: 'info',
});
