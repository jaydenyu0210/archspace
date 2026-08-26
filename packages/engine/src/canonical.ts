/** Canonical JSON + value hashing (ARCHITECTURE §7.3): sorted keys,
 *  deterministic emission, BLAKE3 behind the node-sdk's hashBytes. */
import { hashBytes, isAssetRef, type Value } from '@archspace/node-sdk';

/** Deterministic JSON: object keys sorted recursively, arrays in order,
 *  JSON.stringify semantics for scalars (NaN/±Inf → null, -0 → 0). */
export function canonicalJson(value: unknown): string {
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'string') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
  }
  if (typeof value === 'object') {
    const keys = Object.keys(value as Record<string, unknown>).sort();
    const parts: string[] = [];
    for (const key of keys) {
      const v = (value as Record<string, unknown>)[key];
      if (v === undefined) continue; // JSON.stringify parity: undefined props are omitted
      parts.push(`${JSON.stringify(key)}:${canonicalJson(v)}`);
    }
    return `{${parts.join(',')}}`;
  }
  return 'null'; // functions/symbols/bigints have no canonical JSON form
}

/** Content hash of a wire value. AssetRefs are already content-addressed, so
 *  their hash IS the value hash; everything else hashes its canonical JSON. */
export function hashValue(value: Value): string {
  if (isAssetRef(value)) return value.hash;
  return hashBytes(new TextEncoder().encode(canonicalJson(value)));
}
