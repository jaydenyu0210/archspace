/**
 * What a saved asset is called and what the save dialog filters on.
 *
 * Split from `assets.ts` for the reason `drift.ts` is split from `store.ts`:
 * everything here is a pure decision about what the UI claims, and the module
 * it came from cannot be imported without an Electron runtime. A wrong answer
 * here is a file the user cannot find or cannot open, which is worth a test.
 */
import { extname } from 'node:path';

/** The shape Electron's save dialog takes, stated structurally so this module
 *  needs no Electron import. */
export interface FileFilter {
  name: string;
  extensions: string[];
}

/** Human names for the extensions this build actually produces. */
const FILTER_LABELS: Readonly<Record<string, string>> = {
  dxf: 'AutoCAD DXF drawing',
  ifc: 'IFC model',
  csv: 'CSV table',
  json: 'JSON',
  md: 'Markdown',
  txt: 'Text',
  png: 'PNG image',
  jpg: 'JPEG image',
  pdf: 'PDF',
};

/**
 * Save-dialog filters for one asset: its own type first, then everything.
 *
 * "All files" is always offered because the filter is a guess built from a
 * media type a node supplied, and a wrong guess must never be the reason
 * someone cannot save their own output.
 */
export function assetFilters(fileName: string): FileFilter[] {
  const extension = extname(fileName).replace('.', '').toLowerCase();
  const all = { name: 'All files', extensions: ['*'] };
  if (extension === '') return [all];
  return [{ name: FILTER_LABELS[extension] ?? extension.toUpperCase(), extensions: [extension] }, all];
}
