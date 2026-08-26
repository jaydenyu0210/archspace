/** Session-scoped in-memory memoization cache (ARCHITECTURE §7.3). The
 *  persistent SQLite/CAS tier is future work; this Map is the in-memory tier.
 *  Values are structuredClone'd on BOTH set and get so neither the producing
 *  node nor any consumer can mutate what the cache holds. */
import type { Outputs } from '@archspace/node-sdk';

export interface RunCache {
  get(key: string): Outputs | undefined;
  set(key: string, outputs: Outputs): void;
  clear(): void;
  size: number;
}

export function createRunCache(): RunCache {
  const entries = new Map<string, Outputs>();
  return {
    get(key) {
      const hit = entries.get(key);
      return hit === undefined ? undefined : structuredClone(hit);
    },
    set(key, outputs) {
      entries.set(key, structuredClone(outputs));
    },
    clear() {
      entries.clear();
    },
    get size() {
      return entries.size;
    },
  };
}
