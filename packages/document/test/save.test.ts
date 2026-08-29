import { describe, expect, it } from 'vitest';
import { emitWorkflow, parseWorkflow, saveWorkflow } from '../src/index.js';
import type { ParseWorkflowResult, WorkflowDoc } from '../src/index.js';

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

/**
 * The save that destroyed the document.
 *
 * `extractWorkflow` reports a malformed `layout:` entry and deliberately leaves
 * it in the CST (extract.ts:235) — the parse is a warning, not a failure, so a
 * hand-edited or merge-mangled position never blocks opening a workflow. But
 * `saveWorkflow` decided what to append by diffing against the *parsed* layout,
 * where the entry is absent, so it wrote the key a second time. A YAML map may
 * not repeat a key, so the file the app had just saved could not be reopened.
 *
 * Worth stating plainly because the severity is not obvious from the symptom:
 * this is not a cosmetic duplicate. Open a workflow whose layout someone had
 * hand-edited, move a node, save — and the workflow is gone, destroyed by the
 * app on a path the user had every reason to trust.
 */
describe('a layout entry the parse rejected but left in place', () => {
  const withBadLayout = (position: string): string => `archspace: 1
kind: workflow
meta:
  name: Bad layout
requires:
  mcp: []
  ai: []
  plugins: []
nodes:
  - id: n_aaa111
    type: aec.project_brief
    version: 1
    config: {}
edges: []
layout:
  n_aaa111: ${position}
`;

  it('is replaced on save, not appended beside — and the file reopens', () => {
    const parsed = parseWorkflow(withBadLayout('hand-edited to something that is not a map'));
    if (!parsed.ok) throw new Error('the malformed entry must be a warning, not a parse failure');
    // The premise: reported, excluded, and still in the file.
    expect(parsed.issues.map((i) => i.severity)).toContain('warning');
    expect(parsed.doc.layout).toEqual({});

    const moved: WorkflowDoc = { ...parsed.doc, layout: { n_aaa111: { x: 120, y: 240 } } };
    const saved = saveWorkflow(parsed.source, moved);

    expect(saved.match(/n_aaa111:/g) ?? []).toHaveLength(1);
    expect(saved).toContain('n_aaa111: { x: 120, y: 240 }');

    const reparsed = parseWorkflow(saved);
    expect(reparsed.ok, JSON.stringify(reparsed.issues)).toBe(true);
    if (reparsed.ok) expect(reparsed.doc.layout).toEqual({ n_aaa111: { x: 120, y: 240 } });
  });

  it('does the same for an entry whose x and y are not numbers', () => {
    // The other way extraction rejects a position: a map, but not of numbers.
    const parsed = parseWorkflow(withBadLayout('{ x: left, y: top }'));
    if (!parsed.ok) throw new Error('expected a warning, not a parse failure');
    expect(parsed.doc.layout).toEqual({});

    const saved = saveWorkflow(parsed.source, { ...parsed.doc, layout: { n_aaa111: { x: 7, y: 9 } } });
    expect(saved.match(/n_aaa111:/g) ?? []).toHaveLength(1);
    const reparsed = parseWorkflow(saved);
    expect(reparsed.ok, JSON.stringify(reparsed.issues)).toBe(true);
    if (reparsed.ok) expect(reparsed.doc.layout).toEqual({ n_aaa111: { x: 7, y: 9 } });
  });
});

/**
 * A config that is a YAML alias.
 *
 * `config: *shared` is what a hand-written file uses to give two nodes one set
 * of params, and it is legal YAML that `parseWorkflow` reads correctly:
 * `extractWorkflow` goes through `toJS()`, which resolves the alias, so the
 * parsed node has every key.
 *
 * `saveWorkflow` then wrote only the keys that had CHANGED into a map it had
 * just emptied, because an alias node is not a `YAMLMap` and the branch for
 * "not a map" replaced it with `{}`. Change one param on such a node and the
 * others were gone — silently, from an ordinary save, with the next run using
 * different values than the last one.
 *
 * Materialising the alias into a concrete map is correct and unavoidable here:
 * once one of the two nodes is edited independently they are no longer the same
 * config. Ending the sharing is the user's own instruction. Ending it *and*
 * dropping the values is the bug.
 */
describe('a node whose config is a YAML alias', () => {
  const shared = `archspace: 1
kind: workflow
meta:
  name: Alias
requires:
  mcp: []
  ai: []
  plugins: []
x-defaults: &shared
  seed: 7
  latency: 0
  width: 900
nodes:
  - id: n_aaa111
    type: aec.generate_floor_plan
    version: 1
    config: *shared
  - id: n_bbb222
    type: aec.generate_floor_plan
    version: 1
    config: *shared
edges: []
layout: {}
`;

  it('parses with every key the anchor carries', () => {
    const parsed = parseWorkflow(shared);
    if (!parsed.ok) throw new Error('an alias is legal YAML and must parse');
    expect(parsed.doc.nodes[0].config).toEqual({ seed: 7, latency: 0, width: 900 });
  });

  it('keeps the unchanged keys when one of them is edited', () => {
    const parsed = parseWorkflow(shared);
    if (!parsed.ok) throw new Error('parse failed');
    const edited: WorkflowDoc = {
      ...parsed.doc,
      nodes: parsed.doc.nodes.map((n) => (n.id === 'n_aaa111' ? { ...n, config: { ...n.config, seed: 8 } } : n)),
    };

    const saved = saveWorkflow(parsed.source, edited);
    const reparsed = parseWorkflow(saved);
    expect(reparsed.ok).toBe(true);
    if (!reparsed.ok) return;
    expect(reparsed.doc.nodes[0].config).toEqual({ seed: 8, latency: 0, width: 900 });
    // The node nobody touched still follows the anchor, untouched.
    expect(reparsed.doc.nodes[1].config).toEqual({ seed: 7, latency: 0, width: 900 });
    expect(saved).toContain('*shared');
  });

  it('leaves the file byte-identical when nothing changed', () => {
    // The alias must not be materialised by merely opening and saving.
    const parsed = parseWorkflow(shared);
    if (!parsed.ok) throw new Error('parse failed');
    expect(saveWorkflow(parsed.source, parsed.doc)).toBe(shared);
  });
});

/**
 * A node APPENDED by a save must look like the same node EMITTED from scratch.
 *
 * The two paths build a node entry differently — `emitWorkflow` re-styles the
 * whole tree, `saveWorkflow` pushes one `createNode` result into an existing
 * sequence — and `createNode` builds a block sequence. So a node added in the
 * app saved its `promoted:` over three lines where the emitter writes one, and
 * the canonical form of a document depended on which path had written it. Every
 * other list in this format is flow (`requires:` is the precedent).
 */
describe('a node added by a save', () => {
  const base = `archspace: 1
kind: workflow
meta:
  name: Append
requires:
  mcp: []
  ai: []
  plugins: []
nodes:
  - id: n_aaa111
    type: aec.project_brief
    version: 1
    config: {}
edges: []
layout:
  n_aaa111: { x: 0, y: 0 }
`;

  it('writes promoted: in the same flow form the emitter uses', () => {
    const parsed = parseWorkflow(base);
    if (!parsed.ok) throw new Error('parse failed');
    const withNode: WorkflowDoc = {
      ...parsed.doc,
      nodes: [
        ...parsed.doc.nodes,
        { id: 'n_bbb222', type: 'aec.export_dxf', version: 1, promoted: ['file_name', 'level'], config: {} },
      ],
      layout: { ...parsed.doc.layout, n_bbb222: { x: 200, y: 0 } },
    };

    const saved = saveWorkflow(parsed.source, withNode);
    expect(saved).toContain('promoted: [file_name, level]');
    expect(saved).not.toMatch(/promoted:\n\s+- /);

    // And the two writers agree, which is the property that matters: the
    // canonical form must not depend on which path produced the file.
    const emitted = emitWorkflow(withNode);
    expect(emitted).toContain('promoted: [file_name, level]');

    const reparsed = parseWorkflow(saved);
    expect(reparsed.ok).toBe(true);
    if (reparsed.ok) expect(reparsed.doc.nodes[1].promoted).toEqual(['file_name', 'level']);
  });
});
