/**
 * The fence around the viewer's byte fetch (asset-read.ts).
 *
 * Every ref reaching `asset:read` comes from a sandboxed renderer, so these
 * cases are the adversarial ones: a ref over the ceiling, a ref whose size
 * lies about bytes that are really over the ceiling, an engine that no longer
 * has the asset. Each failure must come back as a rendered state with a
 * sentence a person can act on — the store is session-scoped, and "run it
 * again" is the actual fix.
 */
import { describe, expect, it } from 'vitest';
import type { AssetRef } from '@archspace/node-sdk';
import { MAX_VIEWER_ASSET_BYTES } from '../src/shared/protocol.js';
import { readAssetForViewer } from '../src/main/asset-read.js';

const ref = (over: Partial<AssetRef> = {}): AssetRef => ({
  kind: 'asset',
  hash: 'b3:' + 'ab'.repeat(32),
  mediaType: 'model/ifc',
  format: 'ifc',
  name: 'plan_test.ifc',
  size: 4,
  ...over,
});

const bytesOf = (...values: number[]): Uint8Array => Uint8Array.from(values);

describe('readAssetForViewer', () => {
  it('returns the bytes when the ref and the store agree', async () => {
    const result = await readAssetForViewer(ref(), () => Promise.resolve(bytesOf(1, 2, 3, 4)));
    expect(result).toEqual({ ok: true, bytes: bytesOf(1, 2, 3, 4) });
  });

  it('refuses a ref over the ceiling without asking the engine', async () => {
    let asked = false;
    const result = await readAssetForViewer(ref({ size: MAX_VIEWER_ASSET_BYTES + 1 }), () => {
      asked = true;
      return Promise.resolve(new Uint8Array());
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('preview ceiling');
    expect(asked).toBe(false);
  });

  it('refuses bytes whose length disagrees with the content-addressed ref', async () => {
    const result = await readAssetForViewer(ref({ size: 4 }), () => Promise.resolve(bytesOf(1, 2)));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('2 bytes for an asset recorded as 4');
  });

  it('re-checks the ceiling on the real bytes, so a lying ref cannot slip it', async () => {
    // size says 4 (under the ceiling); the engine hands back a giant buffer.
    const result = await readAssetForViewer(ref({ size: 4 }), () =>
      Promise.resolve(new Uint8Array(MAX_VIEWER_ASSET_BYTES + 1)),
    );
    expect(result.ok).toBe(false);
  });

  it('turns an engine failure into the run-it-again explanation', async () => {
    const result = await readAssetForViewer(ref(), () =>
      Promise.reject(new Error('asset not found: b3:abab')),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('asset not found');
      expect(result.error).toContain('running the workflow again');
    }
  });
});
