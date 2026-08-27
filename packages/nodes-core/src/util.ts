/**
 * Internal helpers for @archspace/nodes-core: seeded determinism (mulberry32),
 * abort-aware sleep, stable string hashing, IFC pseudo-GUIDs, and small
 * numeric utilities. Nothing here uses Math.random or Date.now — same params
 * and inputs must produce byte-identical outputs.
 */
import type { Inputs, Value } from '@archspace/node-sdk';

/** Mulberry32 — tiny deterministic PRNG. Same seed ⇒ same sequence. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** FNV-1a 32-bit string hash — used to seed PRNGs from stable string keys. */
export function fnv1a(input: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Eight lowercase hex chars drawn from a PRNG. */
export function hex8(rng: () => number): string {
  return (Math.floor(rng() * 0x100000000) >>> 0).toString(16).padStart(8, '0');
}

/** The 64-character IFC GlobalId alphabet (base64 per ISO 16739). */
const IFC_B64 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz_$';

/**
 * Deterministic 22-char pseudo-GUID in the IFC base64 alphabet, derived from a
 * stable key (plan id + entity id). Same key ⇒ same GUID, always.
 *
 * The first character is drawn from only the first four symbols of the
 * alphabet, and that is not an arbitrary restriction. An IfcGloballyUniqueId
 * packs a 128-bit UUID into 22 base64 characters, and 22 × 6 = 132 — so the
 * leading character carries just the top 2 bits and can only ever be 0, 1, 2
 * or 3. Drawing it from all 64 symbols, as this did until IfcOpenShell's
 * validator was pointed at the output, makes roughly 94% of the GUIDs in every
 * model fail `IfcGloballyUniqueId` validation. The file still parses and still
 * opens; it is simply, quietly, not conformant.
 */
export function ifcGuid(key: string): string {
  // Two independent hash seeds keep the effective key space well past 32 bits.
  const a = mulberry32(fnv1a(key));
  const b = mulberry32(fnv1a(`${key}\u0000ifc-guid`));
  let out = '';
  for (let i = 0; i < 22; i++) {
    const mask = i === 0 ? 3 : 63;
    out += IFC_B64[(Math.floor(a() * 64) ^ Math.floor(b() * 64)) & mask];
  }
  return out;
}

/**
 * Abort-aware sleep: resolves after `ms`, rejects with a DOMException named
 * 'AbortError' the moment `signal` fires (also when already aborted).
 */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const abortError = () => new DOMException('The operation was aborted', 'AbortError');
    if (signal?.aborted) {
      reject(abortError());
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortError());
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

export function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

export function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}

/** Read a required input, throwing a clear error when it is absent. */
export function requireInput<T>(inputs: Inputs, id: string, nodeType: string): T {
  const v = inputs[id];
  if (v === undefined || v === null) {
    throw new Error(`${nodeType}: required input "${id}" is missing`);
  }
  return v as unknown as T;
}

/**
 * Cast a typed result shape to a wire Value. The shapes in shapes.ts are
 * JSON-safe by construction; TS interfaces merely lack index signatures.
 */
/**
 * A `table` cell rendered as text.
 *
 * Cells are `Value`, so a cell can legitimately hold an object or a list — an
 * upstream node or an MCP tool is free to put one there. Bare `String()` turns
 * those into "[object Object]", which then travels into a room id, a CSV
 * column or a report as though it were data. JSON is the honest rendering: it
 * is wrong-looking in a way a reader can act on.
 */
export function cellText(v: Value | undefined): string {
  if (v === undefined || v === null) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  return JSON.stringify(v);
}

export function toValue<T>(v: T): Value {
  return v as unknown as Value;
}
