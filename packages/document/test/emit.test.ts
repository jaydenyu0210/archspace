import { describe, expect, it } from 'vitest';
import { emitWorkflow, parseWorkflow } from '../src/index.js';
import type { WorkflowDoc } from '../src/index.js';

const ARCHITECTURE_EXAMPLE: WorkflowDoc = {
  meta: {
    name: 'Room schedule summary',
    description: 'Pull the room schedule from Revit and draft a QA summary.',
  },
  requires: { mcp: [], ai: [], plugins: [] }, // ignored: derived on emit
  nodes: [
    {
      id: 'n_k3v9qp',
      type: 'mcp.revit.query_model',
      version: 1,
      schemaHash: 'b3:9f2c',
      config: { category: 'Rooms' },
    },
    {
      id: 'n_8t2mfa',
      type: 'ai.generate_text',
      version: 1,
      config: {
        profile: 'default',
        prompt:
          'You are a BIM QA assistant. Summarize the room schedule below.\n' +
          'Flag rooms missing an area or a department parameter.\n',
      },
    },
  ],
  edges: [
    { from: { node: 'n_k3v9qp', port: 'result' }, to: { node: 'n_8t2mfa', port: 'context' } },
  ],
  layout: {
    n_k3v9qp: { x: 120, y: 240 },
    n_8t2mfa: { x: 460, y: 240 },
  },
};

const EXPECTED = `archspace: 1
kind: workflow
meta:
  name: Room schedule summary
  description: Pull the room schedule from Revit and draft a QA summary.

# Generated on save from the nodes below; lets humans and CI see what a
# workflow needs without loading a node registry.
requires:
  mcp: [revit]
  ai: [default]
  plugins: []

nodes:
  - id: n_k3v9qp
    type: mcp.revit.query_model
    version: 1
    schemaHash: b3:9f2c
    config:
      category: Rooms
  - id: n_8t2mfa
    type: ai.generate_text
    version: 1
    config:
      profile: default
      prompt: |
        You are a BIM QA assistant. Summarize the room schedule below.
        Flag rooms missing an area or a department parameter.

edges:
  - n_k3v9qp.result -> n_8t2mfa.context

layout:
  n_k3v9qp: { x: 120, y: 240 }
  n_8t2mfa: { x: 460, y: 240 }
`;

describe('emitWorkflow — canonical text', () => {
  it('emits the ARCHITECTURE §4.2 example byte-for-byte', () => {
    expect(emitWorkflow(ARCHITECTURE_EXAMPLE)).toBe(EXPECTED);
  });

  it('emits an empty workflow canonically and it re-parses', () => {
    const text = emitWorkflow({
      meta: { name: 'Empty' },
      requires: { mcp: [], ai: [], plugins: [] },
      nodes: [],
      edges: [],
      layout: {},
    });
    expect(text).toBe(
      `archspace: 1
kind: workflow
meta:
  name: Empty

# Generated on save from the nodes below; lets humans and CI see what a
# workflow needs without loading a node registry.
requires:
  mcp: []
  ai: []
  plugins: []

nodes: []

edges: []

layout: {}
`,
    );
    const r = parseWorkflow(text);
    expect(r.ok).toBe(true);
  });

  it('omits empty/undefined description and empty config; rounds positions; orders layout by nodes', () => {
    const text = emitWorkflow({
      meta: { name: 'X', description: '' },
      requires: { mcp: ['bogus'], ai: [], plugins: [] },
      nodes: [
        { id: 'n_b', type: 'aec.b', version: 2, config: {} },
        { id: 'n_a', type: 'aec.a', version: 1, config: {} },
      ],
      edges: [],
      layout: { n_a: { x: 1.4, y: 2.6 }, n_b: { x: -0.2, y: 9.5 } },
    });
    expect(text).not.toContain('description');
    expect(text).not.toContain('config');
    expect(text).not.toContain('bogus'); // requires is derived, not copied
    // layout keys in node order, integer-rounded, -0 normalized
    const layoutPart = text.slice(text.indexOf('layout:'));
    expect(layoutPart).toBe('layout:\n  n_b: { x: 0, y: 10 }\n  n_a: { x: 1, y: 3 }\n');
  });

  it('keeps insertion order of nodes and edges (never sorts)', () => {
    const text = emitWorkflow({
      meta: { name: 'Order' },
      requires: { mcp: [], ai: [], plugins: [] },
      nodes: [
        { id: 'n_z', type: 'aec.z', version: 1, config: {} },
        { id: 'n_a', type: 'aec.a', version: 1, config: {} },
      ],
      edges: [
        { from: { node: 'n_z', port: 'b' }, to: { node: 'n_a', port: 'b' } },
        { from: { node: 'n_a', port: 'a' }, to: { node: 'n_z', port: 'a' } },
      ],
      layout: {},
    });
    expect(text.indexOf('n_z')).toBeLessThan(text.indexOf('n_a'));
    expect(text.indexOf('n_z.b -> n_a.b')).toBeLessThan(text.indexOf('n_a.a -> n_z.a'));
  });

  it('rejects documents that could not re-parse (duplicate ids, unknown edge refs)', () => {
    expect(() =>
      emitWorkflow({
        meta: { name: 'X' },
        requires: { mcp: [], ai: [], plugins: [] },
        nodes: [
          { id: 'n_a', type: 'aec.x', version: 1, config: {} },
          { id: 'n_a', type: 'aec.y', version: 1, config: {} },
        ],
        edges: [],
        layout: {},
      }),
    ).toThrow(/duplicate node id/);
    expect(() =>
      emitWorkflow({
        meta: { name: 'X' },
        requires: { mcp: [], ai: [], plugins: [] },
        nodes: [],
        edges: [{ from: { node: 'n_a', port: 'x' }, to: { node: 'n_b', port: 'y' } }],
        layout: {},
      }),
    ).toThrow(/unknown node/);
  });
});

describe('ambiguous scalars (YAML 1.2 core schema)', () => {
  const doc: WorkflowDoc = {
    meta: { name: 'Ambiguous' },
    requires: { mcp: [], ai: [], plugins: [] },
    nodes: [
      {
        id: 'n_a',
        type: 'aec.x',
        version: 1,
        config: { a: 'true', b: 'no', c: '007', d: '3.14', e: 'null', f: '' },
      },
    ],
    edges: [],
    layout: {},
  };

  it('emits ambiguous strings quoted so they stay strings', () => {
    const text = emitWorkflow(doc);
    expect(text).toContain('a: "true"');
    expect(text).toContain('c: "007"');
    expect(text).toContain('d: "3.14"');
    expect(text).toContain('e: "null"');
    expect(text).toContain('f: ""');
    // "no" is not a boolean in YAML 1.2 core — plain is fine
    expect(text).toContain('b: no');
  });

  it('round-trips them as strings, strictly equal', () => {
    const r = parseWorkflow(emitWorkflow(doc));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.doc.nodes[0].config).toEqual({
      a: 'true',
      b: 'no',
      c: '007',
      d: '3.14',
      e: 'null',
      f: '',
    });
    for (const v of Object.values(r.doc.nodes[0].config)) expect(typeof v).toBe('string');
  });

  it('keeps real booleans/numbers/nulls as their own types', () => {
    const r = parseWorkflow(
      emitWorkflow({
        ...doc,
        nodes: [{ id: 'n_a', type: 'aec.x', version: 1, config: { n: 7, f: 3.14, b: true, z: null } }],
      }),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.doc.nodes[0].config).toEqual({ n: 7, f: 3.14, b: true, z: null });
  });

  it('multi-line strings emit as block scalars', () => {
    const text = emitWorkflow({
      ...doc,
      nodes: [{ id: 'n_a', type: 'aec.x', version: 1, config: { prompt: 'one\ntwo\n' } }],
    });
    expect(text).toContain('prompt: |\n        one\n        two\n');
  });
});
