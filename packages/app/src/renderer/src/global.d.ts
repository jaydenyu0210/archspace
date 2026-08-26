/**
 * The single declaration of what the preload bridge put on `window`
 * (ARCHITECTURE §12).
 *
 * `ArchspaceBridge` is imported from the shared protocol rather than restated
 * here, so the renderer's view of the bridge and preload's implementation of
 * it cannot drift: preload declares `const bridge: ArchspaceBridge`, and both
 * sides fail to compile together if either changes alone.
 *
 * This is also the file where a weakened type would do the most damage and be
 * hardest to notice — it is the only description of everything the sandboxed
 * renderer can reach — so it is worth reading in full whenever the bridge grows.
 */
import type { ArchspaceBridge } from '../../shared/protocol';

declare global {
  interface Window {
    archspace: ArchspaceBridge;
  }
}

export {};
