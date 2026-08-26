import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import {
  applyAssignability,
  assignable,
  formatPortType,
  isValueOfType,
  parsePortType,
  type ParsedType,
} from '../src/index.js';

describe('parsePortType / formatPortType', () => {
  it('parses the whole grammar', () => {
    const cases: Record<string, string> = {
      text: 'text', number: 'number', boolean: 'boolean', json: 'json', chat: 'chat', table: 'table',
      any: 'any', asset: 'asset', 'asset<ifc>': 'asset<ifc>',
      'list<text>': 'list<text>', 'list<list<number>>': 'list<list<number>>',
      'list<asset<ifc>>': 'list<asset<ifc>>',
      'acme.pointcloud.cloud': 'acme.pointcloud.cloud',
      ' text ': 'text',
    };
    for (const [input, expected] of Object.entries(cases)) {
      const parsed = parsePortType(input);
      expect(parsed, input).not.toBeNull();
      expect(formatPortType(parsed!)).toBe(expected);
    }
  });

  it('rejects invalid expressions', () => {
    for (const bad of ['', 'Text', 'list<>', 'list<nope', 'asset<>', 'asset<IFC>', 'set<text>', 'n.', '.x', 'list < text >x']) {
      expect(parsePortType(bad), bad).toBeNull();
    }
  });
});

describe('assignable — the §6.2 table', () => {
  const kind = (from: string, to: string) => {
    const a = assignable(from, to);
    return a.ok ? a.kind : 'no';
  };

  it('exact', () => {
    expect(kind('text', 'text')).toBe('exact');
    expect(kind('asset<ifc>', 'asset<ifc>')).toBe('exact');
    expect(kind('list<number>', 'list<number>')).toBe('exact');
    expect(kind('acme.pc.cloud', 'acme.pc.cloud')).toBe('exact');
  });

  it('widening', () => {
    expect(kind('text', 'json')).toBe('widen');
    expect(kind('table', 'json')).toBe('widen');
    expect(kind('chat', 'json')).toBe('widen');
    expect(kind('list<text>', 'json')).toBe('widen');
    expect(kind('asset<ifc>', 'asset')).toBe('widen');
  });

  it('narrowing refused', () => {
    expect(kind('json', 'table')).toBe('no');
    expect(kind('asset', 'asset<ifc>')).toBe('no');
    expect(kind('asset<dxf>', 'asset<ifc>')).toBe('no');
    expect(kind('json', 'text')).toBe('no');
    expect(kind('list<text>', 'text')).toBe('no'); // no implicit mapping
  });

  it('asset and plugin types never widen into json', () => {
    expect(kind('asset', 'json')).toBe('no');
    expect(kind('asset<ifc>', 'json')).toBe('no');
    expect(kind('acme.pc.cloud', 'json')).toBe('no');
  });

  it('the coercion table is exactly number→text, boolean→text', () => {
    expect(kind('number', 'text')).toBe('coerce');
    expect(kind('boolean', 'text')).toBe('coerce');
    expect(kind('text', 'number')).toBe('no');
    expect(kind('text', 'boolean')).toBe('no');
    expect(kind('json', 'text')).toBe('no');
  });

  it('lift wraps a single element', () => {
    expect(kind('text', 'list<text>')).toBe('lift');
    expect(kind('number', 'list<text>')).toBe('lift'); // lift ∘ coerce
    expect(kind('asset<ifc>', 'list<asset>')).toBe('lift'); // lift ∘ widen
    expect(kind('list<text>', 'list<list<text>>')).toBe('lift'); // lists nest
    expect(kind('text', 'list<list<text>>')).toBe('no'); // a lift never contains a lift
  });

  it('any is unchecked in both directions', () => {
    expect(kind('any', 'table')).toBe('unchecked');
    expect(kind('table', 'any')).toBe('unchecked');
    expect(kind('any', 'any')).toBe('unchecked');
    expect(kind('acme.pc.cloud', 'any')).toBe('unchecked');
  });

  it('plugin types are siloed', () => {
    expect(kind('acme.pc.cloud', 'acme.pc.mesh')).toBe('no');
    expect(kind('acme.pc.cloud', 'text')).toBe('no');
    expect(kind('text', 'acme.pc.cloud')).toBe('no');
  });
});

const arbType: fc.Arbitrary<ParsedType> = fc.letrec<{ t: ParsedType }>((tie) => ({
  t: fc.oneof(
    { maxDepth: 3, withCrossShrink: true },
    fc.constantFrom<ParsedType>(
      { kind: 'any' },
      { kind: 'primitive', name: 'text' },
      { kind: 'primitive', name: 'number' },
      { kind: 'primitive', name: 'boolean' },
      { kind: 'primitive', name: 'json' },
      { kind: 'primitive', name: 'chat' },
      { kind: 'primitive', name: 'table' },
      { kind: 'asset' },
      { kind: 'asset', format: 'ifc' },
      { kind: 'asset', format: 'csv' },
      { kind: 'plugin', namespace: 'acme.pc', name: 'cloud' },
    ),
    tie('t').map((item) => ({ kind: 'list', item }) as ParsedType),
  ),
})).t;

describe('properties', () => {
  it('format ∘ parse is identity', () => {
    fc.assert(fc.property(arbType, (t) => {
      const s = formatPortType(t);
      const parsed = parsePortType(s);
      expect(parsed).not.toBeNull();
      expect(formatPortType(parsed!)).toBe(s);
    }));
  });

  it('exact/widen assignability is transitive', () => {
    fc.assert(fc.property(arbType, arbType, arbType, (a, b, c) => {
      const ab = assignable(a, b);
      const bc = assignable(b, c);
      const okStep = (x: ReturnType<typeof assignable>) => x.ok && (x.kind === 'exact' || x.kind === 'widen');
      if (okStep(ab) && okStep(bc)) {
        const ac = assignable(a, c);
        expect(ac.ok && (ac.kind === 'exact' || ac.kind === 'widen')).toBe(true);
      }
    }));
  });

  it('lift never loops: a lift result is never itself a lift', () => {
    fc.assert(fc.property(arbType, arbType, (from, to) => {
      const a = assignable(from, to);
      if (a.ok && a.kind === 'lift') {
        expect(a.inner.kind).not.toBe('lift');
      }
    }));
  });
});

describe('applyAssignability', () => {
  it('coerces and lifts', () => {
    const coerce = assignable('number', 'text');
    expect(coerce.ok && applyAssignability(42, coerce)).toBe('42');
    const lift = assignable('number', 'list<text>');
    expect(lift.ok && applyAssignability(42, lift)).toEqual(['42']);
    const exact = assignable('text', 'text');
    expect(exact.ok && applyAssignability('x', exact)).toBe('x');
  });
});

describe('isValueOfType', () => {
  it('checks primitives, finiteness, containers, assets', () => {
    expect(isValueOfType('hi', 'text')).toBe(true);
    expect(isValueOfType(1.5, 'number')).toBe(true);
    expect(isValueOfType(NaN, 'number')).toBe(false);
    expect(isValueOfType(Infinity, 'number')).toBe(false);
    expect(isValueOfType([{ role: 'user', content: 'hi' }], 'chat')).toBe(true);
    expect(isValueOfType([{ role: 'robot', content: 'hi' }], 'chat')).toBe(false);
    expect(isValueOfType({ columns: [{ id: 'a' }], rows: [{ a: 1 }] }, 'table')).toBe(true);
    expect(isValueOfType({ columns: [{}], rows: [] }, 'table')).toBe(false);
    expect(isValueOfType(['a', 'b'], 'list<text>')).toBe(true);
    expect(isValueOfType(['a', 1], 'list<text>')).toBe(false);
    const ref = { kind: 'asset', hash: 'b3:00', mediaType: 'model/ifc', format: 'ifc', size: 10 };
    expect(isValueOfType(ref, 'asset')).toBe(true);
    expect(isValueOfType(ref, 'asset<ifc>')).toBe(true);
    expect(isValueOfType(ref, 'asset<dxf>')).toBe(false);
    expect(isValueOfType({ nested: { deep: [1, 'two', null] } }, 'json')).toBe(true);
  });
});
