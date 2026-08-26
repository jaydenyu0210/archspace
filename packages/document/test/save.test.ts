import { describe, expect, it } from 'vitest';
import { emitWorkflow, parseWorkflow, saveWorkflow } from '../src/index';
import type { ParseWorkflowResult, WorkflowDoc } from '../src/index';

function mustParse(text: string): Extract<ParseWorkflowResult, { ok: true }> {
  const r = parseWorkflow(text);
  if (!r.ok) throw new Error(`fixture must parse: ${JSON.stringify(r.issues)}`);
  return r;
}

const CANONICAL: WorkflowDoc = {
  meta: { name: 'Save tests' },
  requires: { mcp: [], ai: [], plugins: [] },
  nodes: [
    { id: 'n_one111', type: 'mcp.revit.query_model', version: 1, config: { category: 'Rooms' } },
    { id: 'n_two222', type: 'ai.generate_text', version: 1, config: { profile: 'default' } },
  ],
  edges: [{ from: { node: 'n_one111', port: 'result' }, to: { node: 'n_two222', port: 'context' } }],
  layout: { n_one111: { x: 0, y: 0 }, n_two222: { x: 200, y: 0 } },
};

describe('saveWorkflow — patch semantics', () => {
  it('the same handle supports repeated saves', () => {
    const text = emitWorkflow(CANONICAL);
    const r = mustParse(text);
    const doc1 = structuredClone(r.doc);
    doc1.meta.name = 'First rename';
    const out1 = saveWorkflow(r.source, doc1);
    expect(out1).toContain('name: First rename');

    const doc2 = structuredClone(doc1);
    doc2.nodes[0].config['category'] = 'Doors';
    const out2 = saveWorkflow(r.source, doc2);
    expect(out2).toContain('name: First rename');
    expect(out2).toContain('category: Doors');

    // no-op after the mutations returns the latest text verbatim
    expect(saveWorkflow(r.source, doc2)).toBe(out2);
  });

  it('reordering doc.nodes does not reorder the file (byte-identical output)', () => {
    const text = emitWorkflow(CANONICAL);
    const r = mustParse(text);
    const doc = structuredClone(r.doc);
    doc.nodes.reverse();
    expect(saveWorkflow(r.source, doc)).toBe(text);
  });

  it('a stale hand-written requires block is untouched while the derivation is unchanged', () => {
    const text = [
      'archspace: 1',
      'kind: workflow',
      'meta: { name: Stale }',
      'requires:',
      '  mcp: [bogus_server]',
      '  ai: [nonsense]',
      '  plugins: []',
      'nodes:',
      '  - { id: n_a, type: aec.project_brief, version: 1, config: {} }',
      'edges: []',
      'layout: { n_a: { x: 0, y: 0 } }',
      '',
    ].join('\n');
    const r = mustParse(text);
    // no-op: byte identical even though requires is stale
    expect(saveWorkflow(r.source, structuredClone(r.doc))).toBe(text);
    // a change that alters the derivation rewrites only the lists that changed
    const doc = structuredClone(r.doc);
    doc.nodes.push({ id: 'n_b', type: 'mcp.revit.query_model', version: 1, config: {} });
    doc.layout['n_b'] = { x: 100, y: 0 };
    const out = saveWorkflow(r.source, doc);
    expect(out).toContain('mcp: [revit]');
    expect(out).not.toContain('bogus_server');
    expect(out).toContain('ai: [nonsense]'); // ai derivation unchanged -> stale list kept
  });

  it('version/schemaHash set only when changed; new keys land in canonical field order', () => {
    const text = [
      'archspace: 1',
      'kind: workflow',
      'meta: { name: Fields }',
      'nodes:',
      '  - id: n_a',
      '    type: aec.project_brief',
      '    config:',
      '      a: 1',
      'edges: []',
      'layout: { n_a: { x: 0, y: 0 } }',
      '',
    ].join('\n');
    const r = mustParse(text);
    // doc.version is the defaulted 1 -> no write, byte-identical
    expect(saveWorkflow(r.source, structuredClone(r.doc))).toBe(text);
    const doc = structuredClone(r.doc);
    doc.nodes[0].version = 2;
    doc.nodes[0].schemaHash = 'b3:cafe';
    const out = saveWorkflow(r.source, doc);
    const lines = out.split('\n');
    const idIdx = lines.findIndex((l) => l.includes('id: n_a'));
    expect(lines[idIdx + 1]).toContain('type: aec.project_brief');
    expect(lines[idIdx + 2]).toContain('version: 2');
    expect(lines[idIdx + 3]).toContain('schemaHash: b3:cafe');
    expect(lines[idIdx + 4]).toContain('config:');
    // removing schemaHash again deletes the pair
    const doc2 = structuredClone(doc);
    delete doc2.nodes[0].schemaHash;
    const out2 = saveWorkflow(r.source, doc2);
    expect(out2).not.toContain('schemaHash');
  });

  it('config keys are set/deleted individually; nested values replace wholesale', () => {
    const text = emitWorkflow({
      ...CANONICAL,
      nodes: [
        {
          id: 'n_a',
          type: 'aec.x',
          version: 1,
          config: { keep: 'as is', drop: 1, nested: { a: 1, b: [1, 2] } },
        },
      ],
      edges: [],
      layout: { n_a: { x: 0, y: 0 } },
    });
    const r = mustParse(text);
    const doc = structuredClone(r.doc);
    delete doc.nodes[0].config['drop'];
    (doc.nodes[0].config['nested'] as Record<string, unknown>)['b'] = [1, 2, 3];
    doc.nodes[0].config['added'] = true;
    const out = saveWorkflow(r.source, doc);
    expect(out).toContain('keep: as is');
    expect(out).not.toContain('drop:');
    expect(out).toContain('added: true');
    const r2 = mustParse(out);
    expect(r2.doc.nodes[0].config).toEqual({
      keep: 'as is',
      nested: { a: 1, b: [1, 2, 3] },
      added: true,
    });
  });

  it('description is deleted when it becomes undefined or empty', () => {
    const text = emitWorkflow({ ...CANONICAL, meta: { name: 'D', description: 'bye' } });
    const r = mustParse(text);
    const doc = structuredClone(r.doc);
    doc.meta.description = '';
    const out = saveWorkflow(r.source, doc);
    expect(out).not.toContain('description');
    const r2 = mustParse(out);
    expect(r2.doc.meta).toEqual({ name: 'D' });
  });

  it('duplicate edges are treated as a multiset', () => {
    const dup: WorkflowDoc = {
      ...CANONICAL,
      edges: [
        { from: { node: 'n_one111', port: 'a' }, to: { node: 'n_two222', port: 'b' } },
        { from: { node: 'n_one111', port: 'a' }, to: { node: 'n_two222', port: 'b' } },
      ],
    };
    const text = emitWorkflow(dup);
    const r = mustParse(text);
    expect(r.doc.edges).toHaveLength(2);
    // no-op keeps both
    expect(saveWorkflow(r.source, structuredClone(r.doc))).toBe(text);
    // dropping one occurrence deletes exactly one line
    const doc = structuredClone(r.doc);
    doc.edges.pop();
    const out = saveWorkflow(r.source, doc);
    expect(out.split('n_one111.a -> n_two222.b').length - 1).toBe(1);
  });

  it('layout entries for removed nodes are deleted; unknown-node leftovers are kept', () => {
    const text = [
      'archspace: 1',
      'kind: workflow',
      'meta: { name: L }',
      'nodes:',
      '  - { id: n_a, type: aec.x, version: 1, config: {} }',
      '  - { id: n_b, type: aec.y, version: 1, config: {} }',
      'edges: []',
      'layout:',
      '  n_a: { x: 0, y: 0 }',
      '  n_b: { x: 10, y: 0 }',
      '  n_leftover: { x: 99, y: 99 }',
      '',
    ].join('\n');
    const r = mustParse(text);
    // no-op leaves the leftover alone
    expect(saveWorkflow(r.source, structuredClone(r.doc))).toBe(text);
    const doc = structuredClone(r.doc);
    doc.nodes = doc.nodes.filter((n) => n.id !== 'n_b');
    delete doc.layout['n_b'];
    const out = saveWorkflow(r.source, doc);
    expect(out).not.toContain('n_b');
    expect(out).toContain('n_leftover: { x: 99, y: 99 }');
  });

  it('unchanged positions are not rewritten even when given as un-rounded floats', () => {
    const text = [
      'archspace: 1',
      'kind: workflow',
      'meta: { name: F }',
      'nodes:',
      '  - { id: n_a, type: aec.x, version: 1, config: {} }',
      'edges: []',
      'layout:',
      '  n_a: { x: 120.7, y: 240 }',
      '',
    ].join('\n');
    const r = mustParse(text);
    expect(r.doc.layout['n_a']).toEqual({ x: 120.7, y: 240 });
    // rounds to the same pixel -> untouched, byte-identical
    expect(saveWorkflow(r.source, structuredClone(r.doc))).toBe(text);
    const doc = structuredClone(r.doc);
    doc.layout['n_a'] = { x: 130.2, y: 240 };
    const out = saveWorkflow(r.source, doc);
    expect(out).toContain('n_a: { x: 130, y: 240 }');
  });

  it('rejects docs with duplicate node ids or dangling edges', () => {
    const r = mustParse(emitWorkflow(CANONICAL));
    const doc = structuredClone(r.doc);
    doc.nodes.push({ ...doc.nodes[0] });
    expect(() => saveWorkflow(r.source, doc)).toThrow(/duplicate node id/);
  });
});
