/**
 * Pins the three properties that make the in-tree `mock` provider worth having
 * (ARCHITECTURE §10, §14 / ADR-0010 §4, ADR-0013 §6).
 *
 *  1. **Deterministic, and stable across processes.** ADR-0013 makes this
 *     provider load-bearing for golden files, the node testkit and memoized
 *     `pure` nodes. Self-consistency inside one run would prove none of that —
 *     a `Math.random()` seeded once per process passes that test — so the
 *     expectations below are *literal bytes*. If the seed derivation ever
 *     changes, these fail, which is exactly the review event that should
 *     happen: every golden file in the repo moves with them.
 *  2. **No network, ever.** Not a stubbed endpoint, not a fake `fetch` — a pure
 *     function. Every gateway here is built with `NEVER_FETCH`, so the mock's
 *     promise is asserted by the suite running at all.
 *  3. **It echoes what it was asked.** The digest covers model + system +
 *     prompt/messages, so a test elsewhere can assert that a node sent the
 *     system prompt it claims to send. That is only true if changing one
 *     character changes the answer, which is asserted rather than assumed.
 *
 * `mockObject` gets its own treatment: it claims to synthesise a value that
 * *satisfies* a schema, so a checker for the subset it honours runs over its
 * output. Literals alone would pin the bytes without pinning the promise.
 */
import { describe, expect, it } from 'vitest';
import type { JsonSchemaObject, Value } from '@archspace/node-sdk';
import { createAiGateway, mockEmbeddings, mockObject, mockText } from '../src/index.js';
import { NEVER_FETCH, configOf, keychain, mockProfile } from './helpers.js';

const ASK = 'Summarise the room schedule.';

const SCHEDULE: JsonSchemaObject = {
  type: 'object',
  properties: {
    room: { type: 'string' },
    area: { type: 'number', minimum: 10, maximum: 40, multipleOf: 0.5 },
    seats: { type: 'integer', minimum: 2, maximum: 8 },
    occupied: { type: 'boolean' },
    grade: { type: 'string', enum: ['A', 'B', 'C'] },
    level: { type: 'string', default: 'L01' },
    tags: { type: 'array', minItems: 2, maxItems: 3, items: { type: 'string' } },
  },
  required: ['room', 'notes'],
};

// ---------------------------------------------------------------------------
// A checker for exactly the subset mock.ts says it honours.
// ---------------------------------------------------------------------------

/** A schema as it really arrives: parsed JSON, not a hand-written literal. */
function schemaFromJson(text: string): JsonSchemaObject {
  return JSON.parse(text) as JsonSchemaObject;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Assert `value` satisfies `node`, reporting the path when it does not. */
function assertSatisfies(node: Record<string, unknown>, value: unknown, path = '$'): void {
  if (Array.isArray(node.enum) && node.enum.length > 0) {
    expect(node.enum, `${path} is one of the enum members`).toContainEqual(value);
    return;
  }
  const type = typeof node.type === 'string' ? node.type : undefined;
  switch (type) {
    case 'object': {
      expect(isRecord(value), `${path} is an object`).toBe(true);
      const record = value as Record<string, unknown>;
      for (const key of (node.required as string[] | undefined) ?? []) {
        expect(Object.hasOwn(record, key), `${path}.${key} is present because it is required`).toBe(true);
      }
      for (const [key, property] of Object.entries((node.properties as Record<string, unknown>) ?? {})) {
        if (isRecord(property) && Object.hasOwn(record, key)) {
          assertSatisfies(property, record[key], `${path}.${key}`);
        }
      }
      return;
    }
    case 'array': {
      expect(Array.isArray(value), `${path} is an array`).toBe(true);
      const items = value as unknown[];
      if (typeof node.minItems === 'number') {
        expect(items.length, `${path} honours minItems`).toBeGreaterThanOrEqual(node.minItems);
      }
      if (typeof node.maxItems === 'number') {
        expect(items.length, `${path} honours maxItems`).toBeLessThanOrEqual(node.maxItems);
      }
      if (isRecord(node.items)) {
        items.forEach((item, index) => assertSatisfies(node.items as Record<string, unknown>, item, `${path}[${index}]`));
      }
      return;
    }
    case 'integer':
    case 'number': {
      expect(typeof value, `${path} is a number`).toBe('number');
      const n = value as number;
      if (type === 'integer') expect(Number.isInteger(n), `${path} is an integer`).toBe(true);
      if (typeof node.minimum === 'number') expect(n, `${path} honours minimum`).toBeGreaterThanOrEqual(node.minimum);
      if (typeof node.maximum === 'number') expect(n, `${path} honours maximum`).toBeLessThanOrEqual(node.maximum);
      if (typeof node.multipleOf === 'number' && node.multipleOf > 0) {
        const steps = n / node.multipleOf;
        expect(Math.abs(steps - Math.round(steps)), `${path} honours multipleOf`).toBeLessThan(1e-9);
      }
      return;
    }
    case 'boolean':
      expect(typeof value, `${path} is a boolean`).toBe('boolean');
      return;
    case 'null':
      expect(value, `${path} is null`).toBeNull();
      return;
    default:
      expect(typeof value, `${path} is a string`).toBe('string');
  }
}

describe('mockText is deterministic down to the byte', () => {
  it('answers the same request with the same literal bytes', () => {
    // Literal, not `toBe(mockText(...))`: this value has to be identical in CI,
    // on another machine, in a later process. A self-comparison proves neither.
    expect(mockText('mock-small', { prompt: ASK })).toBe('[mock mock-small 5c2ceb585357] Summarise the room schedule.');
    expect(mockText('mock-small', { prompt: ASK })).toBe(mockText('mock-small', { prompt: ASK }));
  });

  it('changes when the system prompt changes — the property that makes it assertable', () => {
    const bare = mockText('mock-small', { prompt: ASK });
    const instructed = mockText('mock-small', { system: 'You are terse.', prompt: ASK });

    expect(instructed).toBe('[mock mock-small 0cdd591b3688] Summarise the room schedule.');
    expect(instructed).not.toBe(bare);
    // The echo is unchanged; only the digest moved. That is what lets a node
    // test say "you sent a different system prompt" and nothing else.
    expect(instructed.endsWith(ASK)).toBe(true);
    expect(bare.endsWith(ASK)).toBe(true);
  });

  it('changes when the model changes', () => {
    expect(mockText('mock-large', { prompt: ASK })).toBe('[mock mock-large 52024735ae96] Summarise the room schedule.');
    expect(mockText('mock-large', { prompt: ASK })).not.toBe(mockText('mock-small', { prompt: ASK }));
  });

  it('changes when a single character of the prompt changes', () => {
    expect(mockText('mock-small', { prompt: 'a' })).not.toBe(mockText('mock-small', { prompt: 'b' }));
  });

  it('reads a bare prompt as the user turn it is', () => {
    // Canonicalisation, asserted: `prompt: x` and a single user message are the
    // same request, so a node that switches between the two forms does not
    // invalidate a golden file.
    expect(mockText('mock-small', { messages: [{ role: 'user', content: ASK }] })).toBe(
      mockText('mock-small', { prompt: ASK }),
    );
  });

  it('distinguishes conversations that differ only in turn order', () => {
    const forward = mockText('m', { messages: [{ role: 'user', content: 'a' }, { role: 'assistant', content: 'b' }] });
    const reversed = mockText('m', { messages: [{ role: 'assistant', content: 'b' }, { role: 'user', content: 'a' }] });
    expect(forward).not.toBe(reversed);
  });

  it('echoes the last user turn, whitespace collapsed and long input truncated', () => {
    expect(mockText('m', { messages: [{ role: 'user', content: '  lots   of \n space  ' }] })).toContain('] lots of space');
    // The last user turn, not the first: an echo of the conversation's opening
    // line would make a multi-turn demo read as if the node ignored the user.
    expect(
      mockText('m', {
        messages: [
          { role: 'user', content: 'first' },
          { role: 'assistant', content: 'middle' },
          { role: 'user', content: 'last' },
        ],
      }),
    ).toContain('] last');

    const long = mockText('m', { prompt: 'z'.repeat(200) });
    const echo = long.slice(long.indexOf('] ') + 2);
    expect(echo).toHaveLength(80);
    expect(echo).toBe(`${'z'.repeat(77)}...`);
  });

  it('is shaped so a failure diff is readable', () => {
    expect(mockText('mock-small', { prompt: ASK })).toMatch(/^\[mock mock-small [0-9a-f]{12}] /);
  });
});

describe('mockObject synthesises a value that satisfies the schema', () => {
  it('honours default, enum, type, required, bounds, multipleOf and item counts', () => {
    const value = mockObject('mock-small', { prompt: 'rooms' }, SCHEDULE);

    assertSatisfies(SCHEDULE as Record<string, unknown>, value);
    expect(value).toEqual({
      room: 'room-6182ed',
      area: 26,
      seats: 6,
      occupied: false,
      grade: 'A',
      level: 'L01',
      tags: ['tags[0]-cc63f7', 'tags[1]-f8e546'],
      notes: 'notes-1779f1',
    });
  });

  it('prefers a schema that states its own answer', () => {
    // A `default` is the schema telling us the answer; an `enum` is the schema
    // telling us the answer set. Synthesising past either would be inventing.
    expect(mockObject('m', { prompt: 'p' }, { type: 'object', properties: { a: { type: 'string', default: 'D' } } })).toEqual({ a: 'D' });
    expect(mockObject('m', { prompt: 'p' }, { type: 'object', properties: { a: { type: 'string', enum: ['x', 'y'] } } })).toEqual({ a: 'x' });
    // A default wins over an enum: it is the more specific statement.
    expect(
      mockObject('m', { prompt: 'p' }, { type: 'object', properties: { a: { type: 'string', enum: ['x', 'y'], default: 'y' } } }),
    ).toEqual({ a: 'y' });
  });

  it('invents a value for a required key that properties never described', () => {
    expect(mockObject('m', { prompt: 'p' }, { type: 'object', properties: {}, required: ['ghost'] })).toEqual({
      ghost: 'ghost-a75c53',
    });
  });

  it('emits every declared property, not only the required ones', () => {
    // The mock's shape is the shape a downstream table/json port gets wired
    // against, so an optional column has to be there to be wired.
    const value = mockObject('m', { prompt: 'p' }, {
      type: 'object',
      properties: { needed: { type: 'string' }, optional: { type: 'string' } },
      required: ['needed'],
    });
    expect(Object.keys(value as Record<string, Value>).sort()).toEqual(['needed', 'optional']);
  });

  it('collapses an integer range that bounds pull shut', () => {
    expect(mockObject('m', { prompt: 'p' }, { type: 'object', properties: { n: { type: 'integer', minimum: 5, maximum: 5 } } })).toEqual({ n: 5 });
    // An impossible range degrades to the lower bound rather than throwing: a
    // bad schema should show up as an odd value, not as a crashed run.
    expect(mockObject('m', { prompt: 'p' }, { type: 'object', properties: { n: { type: 'integer', minimum: 9, maximum: 1 } } })).toEqual({ n: 9 });
  });

  it('gives an array at least one element unless maxItems forbids it', () => {
    const one = mockObject('m', { prompt: 'p' }, { type: 'object', properties: { rows: { type: 'array', items: { type: 'string' } } } });
    expect((one as { rows: Value[] }).rows).toHaveLength(1);

    const none = mockObject('m', { prompt: 'p' }, { type: 'object', properties: { rows: { type: 'array', maxItems: 0, items: { type: 'string' } } } });
    expect((none as { rows: Value[] }).rows).toEqual([]);

    // No `items` means nothing is known about the row shape; an empty list is
    // the only honest answer.
    const untyped = mockObject('m', { prompt: 'p' }, { type: 'object', properties: { rows: { type: 'array' } } });
    expect((untyped as { rows: Value[] }).rows).toEqual([]);
  });

  it('infers object and array from shape when no type is declared, and takes a union head', () => {
    expect(mockObject('m', { prompt: 'p' }, { type: 'object', properties: { nested: { properties: { a: { type: 'boolean' } } } } })).toEqual({
      nested: { a: expect.any(Boolean) },
    });
    // node-sdk types a property's `type` as a single string, so a union can
    // only arrive the way a real one does — parsed out of a manifest or a
    // plugin's JSON. That is the path asserted here.
    const union = mockObject('m', { prompt: 'p' }, schemaFromJson('{"type":"object","properties":{"u":{"type":["string","number"]}}}'));
    expect(typeof (union as { u: Value }).u).toBe('string');
  });

  it('is unchanged by the key order the schema was authored in', () => {
    const a = mockObject('m', { prompt: 'p' }, { type: 'object', properties: { x: { type: 'string' } }, required: ['x'] });
    const b = mockObject('m', { prompt: 'p' }, { type: 'object', required: ['x'], properties: { x: { type: 'string' } } });
    expect(a).toEqual(b);
  });

  it('varies with the request, so the digest promise holds for objects too', () => {
    const one = mockObject('m', { prompt: 'p' }, SCHEDULE);
    const two = mockObject('m', { system: 's', prompt: 'p' }, SCHEDULE);
    expect(one).not.toEqual(two);
    assertSatisfies(SCHEDULE as Record<string, unknown>, two);
  });

  it('returns something JSON can carry, because it goes on a wire', () => {
    const value = mockObject('m', { prompt: 'p' }, SCHEDULE);
    expect(JSON.parse(JSON.stringify(value))).toEqual(value);
  });
});

describe('mockEmbeddings', () => {
  it('returns unit-length vectors of fixed width, byte-identical every run', () => {
    const [alpha, beta] = mockEmbeddings('mock-embed', ['alpha', 'beta']);
    // Asserted rather than assumed: two inputs must yield two vectors, and if
    // that ever stops being true this should say so here rather than fail
    // further down with a confusing read of undefined.
    expect(alpha).toBeDefined();
    expect(beta).toBeDefined();
    if (alpha === undefined || beta === undefined) throw new Error('mockEmbeddings returned fewer vectors than inputs');

    expect(alpha).toHaveLength(16);
    expect(alpha).toEqual([
      0.482871, -0.134447, -0.426063, 0.149595, 0.18368, -0.028404, 0.024617, 0.456361,
      -0.001894, 0.301085, 0.369255, -0.085213, -0.217766, 0.089, -0.013255, 0.107936,
    ]);
    const norm = Math.sqrt(beta.reduce((sum, x) => sum + x * x, 0));
    expect(norm).toBeCloseTo(1, 5);
  });

  it('scores identical inputs as identical, so cosine similarity means something', () => {
    const [first, second, other] = mockEmbeddings('m', ['same', 'same', 'different']);
    expect(first).toEqual(second);
    expect(first).not.toEqual(other);
  });

  it('separates models', () => {
    expect(mockEmbeddings('a', ['x'])).not.toEqual(mockEmbeddings('b', ['x']));
  });

  it('returns nothing for nothing', () => {
    expect(mockEmbeddings('m', [])).toEqual([]);
  });
});

describe('a mock profile never reaches a transport', () => {
  const gateway = createAiGateway({
    config: configOf([mockProfile()]),
    secrets: keychain(),
    // Any request at all fails this whole block. That is the assertion.
    fetchImpl: NEVER_FETCH,
  });

  it('serves all three calls and a probe with the transport wired to explode', async () => {
    await expect(gateway.generateText({ prompt: ASK })).resolves.toEqual({
      text: '[mock mock-small 5c2ceb585357] Summarise the room schedule.',
    });
    await expect(gateway.generateObject({ prompt: 'rooms', schema: SCHEDULE })).resolves.toEqual({
      object: mockObject('mock-small', { prompt: 'rooms' }, SCHEDULE),
    });
    await expect(gateway.embed({ values: ['alpha'] })).resolves.toEqual({
      embeddings: mockEmbeddings('mock-small', ['alpha']),
    });
    await expect(gateway.probe('offline')).resolves.toMatchObject({ ok: true });
  });

  it('routes the request through the gateway unchanged, system prompt included', async () => {
    // The gateway is not allowed to quietly reshape a request on its way to the
    // mock: what the node asked for is what the digest covers.
    const viaGateway = await gateway.generateText({ system: 'You are terse.', prompt: ASK });
    expect(viaGateway.text).toBe(mockText('mock-small', { system: 'You are terse.', prompt: ASK }));
  });

  it('takes the same readiness path as a real provider', async () => {
    // `mock` is a member of the provider union rather than a bypass, so a mock
    // profile can be `invalid` like any other.
    const broken = createAiGateway({
      config: configOf([{ name: 'offline', provider: 'mock', model: '' }]),
      secrets: keychain(),
      fetchImpl: NEVER_FETCH,
    });
    expect((await broken.listProfiles())[0]).toMatchObject({ readiness: 'invalid' });
    await expect(broken.generateText({ prompt: 'x' })).rejects.toMatchObject({ reason: 'invalid' });
  });
});
