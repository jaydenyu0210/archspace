/**
 * Saving a run's output assets to disk.
 *
 * The bytes live in the engine child's content-addressed store and are written
 * here, in main: for a save the renderer needs only the path back, so it sends
 * an `AssetRef` — the same small value it already has from the run event — and
 * main does the rest. The bytes-to-the-renderer path that DOES exist is not
 * this one: it is `asset-read.ts`, the fenced ADR-0003 viewer exception, kept
 * in its own electron-free module so the fence itself is unit-testable.
 *
 * The dialog filter is derived from the asset rather than fixed, because this
 * is one button serving every format any node or MCP tool can produce.
 */
import { dialog, app, type BrowserWindow } from 'electron';
import { writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { assetFileName, type AssetRef } from '@archspace/node-sdk';
import type { SaveResult } from '../shared/protocol.js';
import { assetFilters } from './asset-naming.js';

/**
 * Ask where to put an asset, then write it.
 *
 * `readBytes` is injected rather than imported so this stays testable without
 * an engine child, and so main's control-channel plumbing lives in one place.
 */
export async function saveAsset(
  win: BrowserWindow,
  ref: AssetRef,
  readBytes: (ref: AssetRef) => Promise<Uint8Array>,
): Promise<SaveResult> {
  const fileName = assetFileName(ref);

  const chosen = await dialog.showSaveDialog(win, {
    title: 'Save Output',
    defaultPath: join(app.getPath('downloads'), fileName),
    filters: assetFilters(fileName),
  });
  if (chosen.canceled || !chosen.filePath) return { ok: false, cancelled: true };

  // Read after the dialog, not before: the bytes cross a process boundary as a
  // structured-clone copy, and doing that for a save the user then cancels is
  // pure waste. The cost is that an unreadable asset is only discovered once a
  // path has been chosen, which is why the message below explains itself rather
  // than just reporting a failure.
  let bytes: Uint8Array;
  try {
    bytes = await readBytes(ref);
  } catch (err) {
    return {
      ok: false,
      error:
        `Could not read ${fileName} back from the engine: ${reason(err)}. ` +
        'Outputs live only for as long as the engine process does, so this usually ' +
        'means the engine restarted since the run — running the workflow again will rebuild it.',
    };
  }

  // The store is content-addressed, so a size that does not match the ref means
  // the bytes are not the ones the run produced.
  if (bytes.byteLength !== ref.size) {
    return {
      ok: false,
      error: `Refusing to write ${basename(chosen.filePath)}: the engine returned ${bytes.byteLength} bytes for an asset recorded as ${ref.size}.`,
    };
  }

  try {
    await writeFile(chosen.filePath, bytes);
  } catch (err) {
    return { ok: false, error: `Could not write ${chosen.filePath}: ${reason(err)}` };
  }
  return { ok: true, path: chosen.filePath };
}

function reason(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
