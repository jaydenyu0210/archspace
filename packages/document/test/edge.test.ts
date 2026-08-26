import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { formatEdge, parseEdge, parseWorkflow } from '../src/index.js';
import { idArb, portArb, propRuns } from './helpers.js';

describe('parseEdge / formatEdge', () => {
  it('are inverse of each other (property)', () => {
    fc.assert(
      fc.property(idArb, portArb, idArb, portArb, (a, pa, b, pb) => {
        const e = { from: { node: a, port: pa }, to: { node: b, port: pb } };
        expect(parseEdge(formatEdge(e))).toEqual(e);
      }),
      propRuns(200),
    );
  });

  it('formats with exactly one space around the arrow', () => {
    expect(formatEdge({ from: { node: 'n_a', port: 'result' }, to: { node: 'n_b', port: 'context' } }))
      .toBe('n_a.result -> n_b.context');
  });

  it('tolerates extra whitespace when parsing', () => {
    expect(parseEdge('  n_a.result   ->   n_b.context ')).toEqual({
      from: { node: 'n_a', port: 'result' },
      to: { node: 'n_b', port: 'context' },
    });
  });

  it('rejects malformed edge strings', () => {
    for (const bad of [
      '',
      'nope',
      'a.b ->',
      '-> a.b',
      'a -> b',
      'a.b -> c',
      'a -> b.c',
      'a.b.c -> d.e',
      'a.b => c.d',
      'a.b - > c.d',
      'a.b -> c.d -> e.f',
      'a b.c -> d.e',
    ]) {
      expect(parseEdge(bad), bad).toBeNull();
    }
  });

  it('a malformed edge in a document is a fatal parse issue', () => {
    const text = [
      'archspace: 1',
      'kind: workflow',
      'meta: { name: X }',
      'nodes:',
      '  - { id: n_a, type: aec.x, version: 1, config: {} }',
      'edges:',
      '  - n_a.out => n_a.in',
      'layout: {}',
    ].join('\n');
    const r = parseWorkflow(text);
    expect(r.ok).toBe(false);
    expect(r.issues.some((i) => i.severity === 'error' && i.message.includes('does not parse'))).toBe(true);
  });

  it('an edge referencing an unknown node is a fatal parse issue', () => {
    const text = [
      'archspace: 1',
      'kind: workflow',
      'meta: { name: X }',
      'nodes:',
      '  - { id: n_a, type: aec.x, version: 1, config: {} }',
      'edges:',
      '  - n_a.out -> n_ghost.in',
      'layout: {}',
    ].join('\n');
    const r = parseWorkflow(text);
    expect(r.ok).toBe(false);
    expect(r.issues.some((i) => i.severity === 'error' && i.message.includes('unknown node'))).toBe(true);
  });
});
