import { describe, expect, it } from 'vitest';
import { parseWorkflow } from '../src/index';

const MINIMAL = [
  'archspace: 1',
  'kind: workflow',
  'meta:',
  '  name: Minimal',
  'nodes:',
  '  - id: n_a',
  '    type: aec.project_brief',
  '    version: 1',
  '    config: {}',
  'edges: []',
  'layout:',
  '  n_a: { x: 0, y: 0 }',
].join('\n');

describe('parseWorkflow — fatal conditions', () => {
  const fatals: Array<[string, string]> = [
    ['invalid YAML', 'nodes: [unclosed'],
    ['root not a map', '- just\n- a\n- list'],
    ['empty document', ''],
    ['archspace missing', 'kind: workflow\nmeta: { name: X }'],
    ['archspace wrong', 'archspace: 2\nkind: workflow'],
    ['archspace stringy', 'archspace: "1"\nkind: workflow'],
    ['kind not workflow', 'archspace: 1\nkind: pipeline'],
    ['nodes not a sequence', 'archspace: 1\nkind: workflow\nnodes: 5'],
    [
      'duplicate node ids',
      'archspace: 1\nkind: workflow\nnodes:\n  - { id: n_a, type: aec.x, version: 1 }\n  - { id: n_a, type: aec.y, version: 1 }',
    ],
    [
      'node entry not a map',
      'archspace: 1\nkind: workflow\nnodes:\n  - just a string',
    ],
    [
      'node without id',
      'archspace: 1\nkind: workflow\nnodes:\n  - { type: aec.x, version: 1 }',
    ],
    [
      'node without type',
      'archspace: 1\nkind: workflow\nnodes:\n  - { id: n_a, version: 1 }',
    ],
    [
      'edges not a sequence',
      'archspace: 1\nkind: workflow\nnodes: []\nedges: what',
    ],
    [
      'edge not a string',
      'archspace: 1\nkind: workflow\nnodes:\n  - { id: n_a, type: aec.x, version: 1 }\nedges:\n  - { from: n_a }',
    ],
    ['multiple documents', 'archspace: 1\n---\narchspace: 1'],
  ];
  for (const [label, text] of fatals) {
    it(label, () => {
      const r = parseWorkflow(text);
      expect(r.ok).toBe(false);
      expect(r.issues.some((i) => i.severity === 'error')).toBe(true);
    });
  }
});

describe('parseWorkflow — resilient loading with warnings', () => {
  it('parses a minimal canonical-ish document without errors', () => {
    const r = parseWorkflow(MINIMAL);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.doc.meta.name).toBe('Minimal');
    expect(r.doc.nodes).toEqual([
      { id: 'n_a', type: 'aec.project_brief', version: 1, config: {} },
    ]);
    expect(r.doc.edges).toEqual([]);
    expect(r.doc.layout).toEqual({ n_a: { x: 0, y: 0 } });
    // requires was missing: derived, with a warning
    expect(r.doc.requires).toEqual({ mcp: [], ai: [], plugins: [] });
    expect(r.issues.every((i) => i.severity === 'warning')).toBe(true);
  });

  it('bare "archspace: 1" loads with defaults and warnings', () => {
    const r = parseWorkflow('archspace: 1');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.doc).toEqual({
      meta: { name: 'Untitled workflow' },
      requires: { mcp: [], ai: [], plugins: [] },
      nodes: [],
      edges: [],
      layout: {},
    });
    const warn = (frag: string) =>
      r.issues.some((i) => i.severity === 'warning' && i.message.includes(frag));
    expect(warn('kind')).toBe(true);
    expect(warn('meta.name')).toBe(true);
    expect(warn('requires missing')).toBe(true);
  });

  it('node defaults: missing version -> 1, missing config -> {}', () => {
    const text = [
      'archspace: 1',
      'kind: workflow',
      'meta: { name: X }',
      'nodes:',
      '  - id: n_a',
      '    type: aec.project_brief',
      'edges: []',
    ].join('\n');
    const r = parseWorkflow(text);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.doc.nodes[0]).toEqual({ id: 'n_a', type: 'aec.project_brief', version: 1, config: {} });
    const warn = (frag: string) =>
      r.issues.some((i) => i.severity === 'warning' && i.message.includes(frag));
    expect(warn('missing version')).toBe(true);
    expect(warn('missing config')).toBe(true);
    expect(warn('no layout entry')).toBe(true);
  });

  it('unknown node types are reported faithfully, not rejected', () => {
    const text = [
      'archspace: 1',
      'kind: workflow',
      'meta: { name: X }',
      'nodes:',
      '  - { id: n_a, type: totally.unknown.thing, version: 3, config: { a: 1 } }',
    ].join('\n');
    const r = parseWorkflow(text);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.doc.nodes[0].type).toBe('totally.unknown.thing');
    expect(r.doc.requires.plugins).toEqual(['totally']);
  });

  it('layout entry for an unknown node is excluded from doc.layout with a warning', () => {
    const text = [
      'archspace: 1',
      'kind: workflow',
      'meta: { name: X }',
      'nodes:',
      '  - { id: n_a, type: aec.x, version: 1, config: {} }',
      'layout:',
      '  n_a: { x: 1, y: 2 }',
      '  n_ghost: { x: 9, y: 9 }',
    ].join('\n');
    const r = parseWorkflow(text);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.doc.layout).toEqual({ n_a: { x: 1, y: 2 } });
    expect(
      r.issues.some((i) => i.severity === 'warning' && i.message.includes('unknown node "n_ghost"')),
    ).toBe(true);
  });

  it('a present requires block is reported as found (parse artifact)', () => {
    const text = [
      'archspace: 1',
      'kind: workflow',
      'meta: { name: X }',
      'requires:',
      '  mcp: [stale]',
      '  ai: []',
      '  plugins: [ghost]',
      'nodes: []',
      'edges: []',
    ].join('\n');
    const r = parseWorkflow(text);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.doc.requires).toEqual({ mcp: ['stale'], ai: [], plugins: ['ghost'] });
  });

  it('empty meta.description is treated as absent', () => {
    const text = 'archspace: 1\nkind: workflow\nmeta:\n  name: X\n  description: ""\nnodes: []';
    const r = parseWorkflow(text);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.doc.meta).toEqual({ name: 'X' });
  });
});
