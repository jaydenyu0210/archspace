/**
 * Tool results to wire values, and the invariant that wires carry references
 * rather than bytes (ARCHITECTURE §5.2, §9.3, §11 / ADR-0011).
 *
 * This is the file where a foreign server's response becomes something the
 * engine will copy. That copying is the whole risk: a `Value` is cloned into
 * every downstream node, every cache entry, every run event in the NDJSON log
 * and — for a preview — across a `MessagePort` into the renderer. A tool that
 * returns a rendered floor plan hands us a base64 PNG inline, and if that
 * string ever reaches a port the cost is paid N times over, silently, in a
 * profile nobody reads.
 *
 * So the invariant pinned here is negative and worth the trouble to state as
 * one: **no bulk bytes on the wire, ever.** Image, audio and embedded-resource
 * blocks are decoded once into the content-addressed store and travel on as
 * `AssetRef`s. The positive half is totality: the three outputs must account
 * for every block type a server can send, because a silently dropped block is
 * a tool that "returned nothing" with no way to find out why. `resource_link`
 * is the one thing we cannot capture (MCP resources are deferred, ADR-0009 §6),
 * so it is surfaced in text rather than lost.
 */
import { describe, expect, it } from 'vitest';
import { createMemoryAssetStore, hashBytes, isAssetRef, type AssetRef } from '@archspace/node-sdk';
import { captureToolResult, formatTagFor, toValue, type RawToolResult } from '../src/index.js';

function b64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64');
}

async function capture(result: RawToolResult): Promise<{ outcome: Awaited<ReturnType<typeof captureToolResult>>; assets: ReturnType<typeof createMemoryAssetStore> }> {
  const assets = createMemoryAssetStore();
  return { outcome: await captureToolResult(result, assets), assets };
}

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);

describe('captureToolResult, the three fixed outputs', () => {
  it('joins every text block, keeps structuredContent, and reports isError', async () => {
    const { outcome } = await capture({
      content: [
        { type: 'text', text: 'converted 3 files' },
        { type: 'text', text: '2 warnings' },
      ],
      structuredContent: { converted: 3, warnings: ['unit mismatch', 'missing level'] },
    });

    expect(outcome.text).toBe('converted 3 files\n2 warnings');
    expect(outcome.structured).toEqual({ converted: 3, warnings: ['unit mismatch', 'missing level'] });
    expect(outcome.assets).toEqual([]);
    expect(outcome.isError).toBe(false);
  });

  it.each<[string, RawToolResult]>([
    ['no content at all', {}],
    ['content that is not a list', { content: 'converted' }],
    ['an empty content list', { content: [] }],
    ['blocks that are not objects', { content: ['text', 7, null] }],
    ['a block type we do not know', { content: [{ type: 'video', data: 'AAAA' }] }],
  ])('degrades to empty outputs for %s rather than throwing', async (_label, result) => {
    const { outcome } = await capture(result);

    expect(outcome).toEqual({ isError: false, text: '', structured: null, assets: [] });
  });

  it.each<[string, unknown, unknown]>([
    ['absent', undefined, null],
    ['null', null, null],
    ['a scalar', 42, 42],
    ['a list', [1, 'two'], [1, 'two']],
  ])('reports structuredContent that is %s as %o', async (_label, structuredContent, expected) => {
    const { outcome } = await capture(structuredContent === undefined ? { content: [] } : { content: [], structuredContent });

    expect(outcome.structured).toEqual(expected);
  });

  it('reports isError only for the literal true a tool sets', async () => {
    expect((await capture({ content: [], isError: true })).outcome.isError).toBe(true);
    expect((await capture({ content: [], isError: 'true' })).outcome.isError).toBe(false);
    expect((await capture({ content: [] })).outcome.isError).toBe(false);
  });
});

describe('bulk content is captured, never inlined (ADR-0011)', () => {
  it('puts image bytes in the store and an AssetRef on the wire', async () => {
    const { outcome, assets } = await capture({
      content: [
        { type: 'text', text: 'rendered' },
        { type: 'image', data: b64(PNG), mimeType: 'image/png' },
      ],
    });

    expect(outcome.assets).toHaveLength(1);
    const ref = outcome.assets[0];
    expect(isAssetRef(ref)).toBe(true);
    // The format tag is what makes `asset<png>` connect to a typed input
    // instead of everything being a bare `asset`.
    expect(ref).toMatchObject({ kind: 'asset', mediaType: 'image/png', format: 'png', size: PNG.byteLength, hash: hashBytes(PNG) });
    expect(await assets.bytes(ref)).toEqual(PNG);
    expect(outcome.text).toBe('rendered');
  });

  it('keeps the server’s order when several blocks are captured', async () => {
    // `assets.put` is awaited in order precisely so a node that returns two
    // images cannot have them swapped by scheduling.
    const { outcome } = await capture({
      content: [
        { type: 'image', data: b64(PNG), mimeType: 'image/png' },
        { type: 'image', data: b64(JPEG), mimeType: 'image/jpeg' },
      ],
    });

    expect(outcome.assets.map((r: AssetRef) => r.hash)).toEqual([hashBytes(PNG), hashBytes(JPEG)]);
  });

  it.each<[string, string, string, string]>([
    ['an image with no mimeType', 'image', 'image/png', 'png'],
    ['audio with no mimeType', 'audio', 'audio/wav', 'wav'],
  ])('gives %s the spec default', async (_label, type, mediaType, format) => {
    const { outcome } = await capture({ content: [{ type, data: b64(PNG) }] });

    expect(outcome.assets[0]).toMatchObject({ mediaType, format });
  });

  it('ignores a binary block with no data instead of storing an empty asset', async () => {
    const { outcome } = await capture({ content: [{ type: 'image', mimeType: 'image/png' }] });

    expect(outcome.assets).toEqual([]);
  });

  it('never lets a large payload reach the wire', async () => {
    // The invariant, stated as a size: 64 KiB in, a ref of a couple of hundred
    // bytes out. This is the assertion that fails the day somebody "simplifies"
    // the capture by passing base64 straight through as text.
    const bulk = new Uint8Array(64 * 1024).fill(0x2e);
    const encoded = b64(bulk);

    const { outcome } = await capture({ content: [{ type: 'text', text: 'here is your model' }, { type: 'image', data: encoded, mimeType: 'image/png' }] });

    const onTheWire = JSON.stringify({ result: outcome.structured, text: outcome.text, assets: outcome.assets });
    expect(outcome.assets[0].size).toBe(bulk.byteLength);
    expect(onTheWire).not.toContain(encoded.slice(0, 512));
    expect(onTheWire.length).toBeLessThan(512);
  });
});

describe('embedded resources', () => {
  it('captures a blob resource with a name taken from its uri', async () => {
    const { outcome, assets } = await capture({
      content: [{ type: 'resource', resource: { uri: 'file:///models/tower.ifc', mimeType: 'model/ifc', blob: b64(PNG) } }],
    });

    expect(outcome.assets[0]).toMatchObject({ mediaType: 'model/ifc', format: 'ifc', name: 'tower.ifc' });
    expect(await assets.bytes(outcome.assets[0])).toEqual(PNG);
  });

  it('captures a text resource as bytes rather than putting it on the wire', async () => {
    const csv = 'level,area\nL1,420\n';
    const { outcome, assets } = await capture({
      content: [{ type: 'resource', resource: { uri: 'schedule.csv', mimeType: 'text/csv', text: csv } }],
    });

    expect(outcome.assets[0]).toMatchObject({ mediaType: 'text/csv', format: 'csv', name: 'schedule.csv' });
    expect(new TextDecoder().decode(await assets.bytes(outcome.assets[0]))).toBe(csv);
    // Text content is a text BLOCK; a text RESOURCE is a file the tool
    // produced, and files travel by reference.
    expect(outcome.text).toBe('');
  });

  it('tags a text resource with no declared media type consistently with what it stored', async () => {
    // This was red when it was written, and the defect it found is now fixed:
    // the file's own words are that the format tag is "derived from the media
    // type", but for an untyped text resource the code derived the tag from
    // the `application/octet-stream` fallback and then stored the asset as
    // `text/plain` instead, so the ref contradicted itself: a `text/plain`
    // asset presenting to the port type system as `asset<octet_stream>`, which
    // will not connect to an `asset<plain>` input. The tag has to come from the
    // media type actually recorded.
    const { outcome } = await capture({
      content: [{ type: 'resource', resource: { uri: 'notes.txt', text: 'no mimeType here' } }],
    });

    expect(outcome.assets[0]).toMatchObject({ mediaType: 'text/plain', format: 'plain' });
  });

  it('prefers the blob when a resource carries both spellings', async () => {
    const { outcome, assets } = await capture({
      content: [{ type: 'resource', resource: { uri: 'x.bin', mimeType: 'application/octet-stream', blob: b64(JPEG), text: 'ignored' } }],
    });

    expect(outcome.assets).toHaveLength(1);
    expect(await assets.bytes(outcome.assets[0])).toEqual(JPEG);
  });

  it.each<[string, unknown]>([
    ['a resource that is not a mapping', { type: 'resource', resource: 'file:///x' }],
    ['a resource with neither text nor blob', { type: 'resource', resource: { uri: 'file:///x' } }],
  ])('ignores %s', async (_label, block) => {
    const { outcome } = await capture({ content: [block] });

    expect(outcome.assets).toEqual([]);
  });

  it('surfaces a resource_link in text rather than losing it', async () => {
    // Not fetchable without the resources capability (deferred, ADR-0009 §6).
    // Naming it keeps the information visible instead of the node appearing to
    // have returned nothing.
    const { outcome } = await capture({
      content: [
        { type: 'resource_link', uri: 'file:///models/tower.rvt', name: 'Tower' },
        { type: 'resource_link', uri: 'file:///models/site.rvt' },
      ],
    });

    expect(outcome.text).toBe('[resource] Tower: file:///models/tower.rvt\n[resource] file:///models/site.rvt');
    expect(outcome.assets).toEqual([]);
  });
});

describe('formatTagFor', () => {
  it.each<[string, string | undefined]>([
    ['image/png', 'png'],
    ['IMAGE/PNG', 'png'],
    ['model/ifc', 'ifc'],
    ['text/csv', 'csv'],
    ['text/plain; charset=utf-8', 'plain'],
    ['application/octet-stream', 'octet_stream'],
    // A structured suffix wins: it names the part a consumer can parse.
    ['application/vnd.autodesk.revit+json', 'json'],
    ['image/svg+xml', 'xml'],
    // Port type segments must start with a letter, so these get no tag at all
    // rather than an illegal one.
    ['application/3mf', undefined],
    ['not-a-media-type', undefined],
    ['application/', undefined],
    ['', undefined],
  ])('maps %o to %o', (mediaType, expected) => {
    expect(formatTagFor(mediaType)).toBe(expected);
  });
});

describe('toValue', () => {
  it('deep-copies JSON, so a later mutation of the response cannot reach a wire', async () => {
    const source = { nested: { list: [1, 2] } };

    const copied = toValue(source) as { nested: { list: number[] } };
    source.nested.list.push(3);

    expect(copied).toEqual({ nested: { list: [1, 2] } });
  });

  it.each<[string, unknown, unknown]>([
    ['null', null, null],
    ['a boolean', true, true],
    ['a string', 'x', 'x'],
    ['a finite number', 1.5, 1.5],
    // Not JSON values: anything that cannot cross a wire that promises `Value`
    // becomes null rather than crossing it anyway.
    ['NaN', Number.NaN, null],
    ['Infinity', Number.POSITIVE_INFINITY, null],
    ['undefined', undefined, null],
    ['a function', (): number => 1, null],
    ['a bigint', 10n, null],
    ['a symbol', Symbol('x'), null],
  ])('maps %s to %o', (_label, input, expected) => {
    expect(toValue(input)).toEqual(expected);
  });

  it('drops undefined-valued keys and recurses into arrays', () => {
    expect(toValue({ kept: 1, dropped: undefined, list: [Number.NaN, { deep: 'ok' }] })).toEqual({ kept: 1, list: [null, { deep: 'ok' }] });
  });
});
