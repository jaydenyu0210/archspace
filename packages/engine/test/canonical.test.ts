import { describe, expect, it } from 'vitest';
import type { AssetRef } from '@archspace/node-sdk';
import { canonicalJson, createRunCache, hashValue } from '../src/index.js';

describe('canonicalJson', () => {
  it('sorts object keys recursively', () => {
    expect(canonicalJson({ b: 1, a: { d: 2, c: 3 } })).toBe('{"a":{"c":3,"d":2},"b":1}');
  });

  it('preserves array order', () => {
    expect(canonicalJson([3, 1, 2])).toBe('[3,1,2]');
  });

  it('handles scalars and null like JSON', () => {
    expect(canonicalJson(null)).toBe('null');
    expect(canonicalJson('hi')).toBe('"hi"');
    expect(canonicalJson(true)).toBe('true');
    expect(canonicalJson(1.5)).toBe('1.5');
    expect(canonicalJson(-0)).toBe('0');
  });

  it('omits undefined object properties', () => {
    expect(canonicalJson({ a: 1, b: undefined })).toBe('{"a":1}');
  });
});

describe('hashValue', () => {
  it('is key-order independent', () => {
    expect(hashValue({ a: 1, b: 2 })).toBe(hashValue({ b: 2, a: 1 }));
  });

  it('distinguishes different values', () => {
    expect(hashValue({ a: 1 })).not.toBe(hashValue({ a: 2 }));
  });

  it('prefixes with b3:', () => {
    expect(hashValue('x')).toMatch(/^b3:[0-9a-f]{64}$/);
  });

  it('uses the content address of an AssetRef directly', () => {
    const ref: AssetRef = { kind: 'asset', hash: 'b3:deadbeef', mediaType: 'text/csv', size: 12 };
    expect(hashValue(ref)).toBe('b3:deadbeef');
  });
});

describe('createRunCache', () => {
  it('stores and reports size, and clears', () => {
    const cache = createRunCache();
    expect(cache.size).toBe(0);
    cache.set('k', { out: 1 });
    expect(cache.size).toBe(1);
    expect(cache.get('k')).toEqual({ out: 1 });
    expect(cache.get('missing')).toBeUndefined();
    cache.clear();
    expect(cache.size).toBe(0);
  });

  it('clones on set: mutating the stored object later does not poison the cache', () => {
    const cache = createRunCache();
    const outputs = { out: { a: 1 } };
    cache.set('k', outputs);
    outputs.out.a = 999;
    expect(cache.get('k')).toEqual({ out: { a: 1 } });
  });

  it('clones on get: mutating a retrieved object does not poison the cache', () => {
    const cache = createRunCache();
    cache.set('k', { out: { a: 1 } });
    const first = cache.get('k') as { out: { a: number } };
    first.out.a = 999;
    expect(cache.get('k')).toEqual({ out: { a: 1 } });
  });
});
