/** Session-scoped in-memory memoization cache (ARCHITECTURE §7.3). The
 *  persistent SQLite/CAS tier is future work; this Map is the in-memory tier.
 *  Values are structuredClone'd on BOTH set and get so neither the producing
 *  node nor any consumer can mutate what the cache holds.
 *
 *  **Bounded, because "session-scoped" in the desktop app means the life of the
 *  process.** The engine child builds one cache at startup and every run shares
 *  it (`packages/app/src/engine-child/index.ts`), so an unbounded Map grew for
 *  as long as the app was open — and it is not small: §7.6 says bulk bytes
 *  travel as `AssetRef`, but a floor plan is a `json` wire value and a
 *  six-storey one is about 261,000 characters. Ten parameter sweeps over that
 *  node is a few megabytes of dead memo nobody will ask for again.
 *
 *  Least-recently-used, on entry count. A byte budget would be the better
 *  bound and needs a size for every value, which means serializing each one on
 *  the way in — paying a real cost on every write to bound a rare case. Entry
 *  count is coarse and predictable, and LRU keeps the entries a user is
 *  actually re-running: the whole point of the memo is the second press of Run
 *  on a graph whose upstream did not change. */
import type { Outputs } from '@archspace/node-sdk';

export interface RunCache {
  get(key: string): Outputs | undefined;
  set(key: string, outputs: Outputs): void;
  clear(): void;
  size: number;
}

/**
 * How many memoized results to keep.
 *
 * Sized for the shape of the work rather than for a memory target: the largest
 * shipped example has 14 nodes, so this holds roughly the last twenty runs of
 * it in full. Small enough that the worst case (every entry a 261 KB plan) is
 * tens of megabytes rather than unbounded; large enough that nothing a person
 * does in one sitting evicts what they are iterating on.
 */
const DEFAULT_MAX_ENTRIES = 256;

export function createRunCache(maxEntries: number = DEFAULT_MAX_ENTRIES): RunCache {
  const limit = Math.max(1, Math.floor(maxEntries));
  // A `Map` iterates in insertion order, so "delete and re-insert on read" is
  // the whole LRU: the oldest key is always the first one iteration yields.
  const entries = new Map<string, Outputs>();
  return {
    get(key) {
      const hit = entries.get(key);
      if (hit === undefined) return undefined;
      entries.delete(key);
      entries.set(key, hit);
      return structuredClone(hit);
    },
    set(key, outputs) {
      entries.delete(key); // re-inserting moves an existing key to the newest end
      entries.set(key, structuredClone(outputs));
      while (entries.size > limit) {
        const oldest = entries.keys().next();
        if (oldest.done === true) break;
        entries.delete(oldest.value);
      }
    },
    clear() {
      entries.clear();
    },
    get size() {
      return entries.size;
    },
  };
}
