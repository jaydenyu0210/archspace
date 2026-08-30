/**
 * The 3D viewer's byte fetch — the fenced exception to §7.6 (ADR-0003).
 *
 * "Bulk data stops at the engine" is stated policy everywhere else in this
 * app, and the viewer is the one place it bends: a model panel cannot exist
 * without the model. This module IS the fence around that bend — the size
 * ceiling and the content-address integrity check — kept separate from
 * `assets.ts` for the same reason `asset-naming.ts` is separate: no electron
 * import, so the fence runs under plain vitest and a regression here fails a
 * test instead of shipping a hole.
 *
 * `readBytes` is injected rather than imported, exactly as `saveAsset` takes
 * it: main's control-channel plumbing stays in one place, and this logic is
 * testable without an engine child.
 */
import { assetFileName, type AssetRef } from '@archspace/node-sdk';
import { MAX_VIEWER_ASSET_BYTES, type ReadAssetResult } from '../shared/protocol.js';

export async function readAssetForViewer(
  ref: AssetRef,
  readBytes: (ref: AssetRef) => Promise<Uint8Array>,
): Promise<ReadAssetResult> {
  const fileName = assetFileName(ref);

  // Checked against the ref before paying for the engine round-trip…
  if (ref.size > MAX_VIEWER_ASSET_BYTES) {
    return {
      ok: false,
      error:
        `${fileName} is ${(ref.size / (1024 * 1024)).toFixed(1)} MB, over the ` +
        `${MAX_VIEWER_ASSET_BYTES / (1024 * 1024)} MB in-app preview ceiling — ` +
        'save it and open it in an external viewer instead.',
    };
  }

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

  // …and again against the bytes that actually came back. The store is
  // content-addressed, so a length that disagrees with the ref means these are
  // not the run's bytes (the save path applies the identical rule) — and a ref
  // whose `size` lies is exactly what a hostile renderer would send to slip
  // the pre-flight ceiling, which is why the ceiling is re-checked on real
  // bytes too.
  if (bytes.byteLength !== ref.size || bytes.byteLength > MAX_VIEWER_ASSET_BYTES) {
    return {
      ok: false,
      error: `Refusing to preview ${fileName}: the engine returned ${bytes.byteLength} bytes for an asset recorded as ${ref.size}.`,
    };
  }

  return { ok: true, bytes };
}

function reason(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
