import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseWorkflow, saveWorkflow } from '../src/index.js';
import type { WorkflowDoc } from '../src/index.js';
import { commentTails } from './helpers.js';

const FIXTURE = readFileSync(new URL('./fixtures/commented.archspace.yaml', import.meta.url), 'utf8');

function open(): { doc: WorkflowDoc; save: (d: WorkflowDoc) => string } {
  const r = parseWorkflow(FIXTURE);
  expect(r.ok).toBe(true);
  if (!r.ok) throw new Error('fixture must parse');
  return { doc: structuredClone(r.doc), save: (d) => saveWorkflow(r.source, d) };
}

function expectAllCommentsSurvive(output: string): void {
  for (const tail of commentTails(FIXTURE)) {
    expect(output, `comment ${JSON.stringify(tail)} must survive`).toContain(tail);
  }
}

describe('comment survival across mutating saves (ADR-0004 hard invariant)', () => {
  it('fixture parses clean and a no-op save is byte-identical', () => {
    const { doc, save } = open();
    expect(save(doc)).toBe(FIXTURE);
  });

  it('add node', () => {
    const { doc, save } = open();
    doc.nodes.push({ id: 'n_dddddd', type: 'acme.pointcloud.load', version: 1, config: { path: 'x.las' } });
    doc.layout['n_dddddd'] = { x: 620, y: 240 };
    const out = save(doc);
    expectAllCommentsSurvive(out);
    expect(out).toContain('id: n_dddddd');
    expect(out).toContain('plugins: [acme]'); // requires re-derived, flow style, unpadded
  });

  it('remove a different node (n_bbbbbb, which carries no comments)', () => {
    const { doc, save } = open();
    doc.nodes = doc.nodes.filter((n) => n.id !== 'n_bbbbbb');
    doc.edges = doc.edges.filter((e) => e.from.node !== 'n_bbbbbb' && e.to.node !== 'n_bbbbbb');
    delete doc.layout['n_bbbbbb'];
    const out = save(doc);
    expectAllCommentsSurvive(out);
    expect(out).not.toContain('n_bbbbbb');
  });

  it('change a config value (its inline comment survives too)', () => {
    const { doc, save } = open();
    doc.nodes[0].config['category'] = 'Walls';
    const out = save(doc);
    expectAllCommentsSurvive(out);
    expect(out).toContain('category: Walls # inline value comment');
    expect(out).not.toContain('Rooms');
  });

  it('add an edge', () => {
    const { doc, save } = open();
    doc.edges.push({ from: { node: 'n_aaaaaa', port: 'result' }, to: { node: 'n_bbbbbb', port: 'context' } });
    const out = save(doc);
    expectAllCommentsSurvive(out);
    expect(out).toContain('n_aaaaaa.result -> n_bbbbbb.context');
  });

  it('remove an edge (the uncommented one)', () => {
    const { doc, save } = open();
    doc.edges = doc.edges.filter((e) => e.from.node !== 'n_bbbbbb');
    const out = save(doc);
    expectAllCommentsSurvive(out);
    expect(out).not.toContain('n_bbbbbb.brief');
  });

  it('move a node: layout-only change leaves everything above layout: byte-identical', () => {
    const { doc, save } = open();
    doc.layout['n_bbbbbb'] = { x: 333.4, y: 251.6 };
    const out = save(doc);
    expectAllCommentsSurvive(out);
    const cut = FIXTURE.indexOf('\nlayout:');
    expect(cut).toBeGreaterThan(0);
    const semanticPart = FIXTURE.slice(0, cut + '\nlayout:'.length);
    expect(out.startsWith(semanticPart)).toBe(true);
    expect(out).toContain('n_bbbbbb: { x: 333, y: 252 }');
  });

  it('rename the workflow', () => {
    const { doc, save } = open();
    doc.meta.name = 'Renamed fixture';
    const out = save(doc);
    expectAllCommentsSurvive(out);
    expect(out).toContain('name: Renamed fixture # inline name comment');
  });
});

describe('unknown-field survival', () => {
  const TEXT = [
    'archspace: 1',
    'kind: workflow',
    'x-custom: keep me',
    'meta:',
    '  name: Unknowns',
    'nodes:',
    '  - id: n_aaaaaa',
    '    type: aec.project_brief',
    '    version: 1',
    '    vendor_extra: 42',
    '    config:',
    '      a: 1',
    'edges: []',
    'layout:',
    '  n_aaaaaa: { x: 0, y: 0 }',
    '',
  ].join('\n');

  it('extra top-level and per-node keys survive a mutating save', () => {
    const r = parseWorkflow(TEXT);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const doc = structuredClone(r.doc);
    doc.meta.name = 'Still unknowns';
    doc.nodes[0].config['a'] = 2;
    doc.nodes.push({ id: 'n_bbbbbb', type: 'acme.widget', version: 1, config: {} });
    doc.layout['n_bbbbbb'] = { x: 100, y: 0 };
    const out = saveWorkflow(r.source, doc);
    expect(out).toContain('x-custom: keep me');
    expect(out).toContain('vendor_extra: 42');
    expect(out).toContain('a: 2');
    // the derived requires section is created at its canonical position
    expect(out).toContain('plugins: [acme]');
    expect(out.indexOf('requires:')).toBeGreaterThan(out.indexOf('meta:'));
    expect(out.indexOf('requires:')).toBeLessThan(out.indexOf('nodes:'));
    // and the whole thing still parses
    const r2 = parseWorkflow(out);
    expect(r2.ok).toBe(true);
  });
});

describe('non-canonical hand-written file', () => {
  const TEXT = [
    'archspace: 1',
    'kind: workflow',
    "meta: { name: 'Odd file' }",
    'nodes:',
    '    - { id: n_aaaaaa, type: aec.project_brief, version: 1, config: { title: \'Tower A\' } }',
    '    - id: n_bbbbbb',
    '      type: acme.thing',
    '      version: 1',
    '      config:',
    "            deep: 'single quoted'",
    'edges:',
    '    - n_aaaaaa.brief    ->    n_bbbbbb.brief',
    'layout: { n_aaaaaa: { x: 1, y: 2 }, n_bbbbbb: { x: 3, y: 4 } }',
    '',
  ].join('\n');

  it('parses fine (warnings only)', () => {
    const r = parseWorkflow(TEXT);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.doc.nodes.map((n) => n.id)).toEqual(['n_aaaaaa', 'n_bbbbbb']);
    expect(r.doc.edges).toEqual([
      { from: { node: 'n_aaaaaa', port: 'brief' }, to: { node: 'n_bbbbbb', port: 'brief' } },
    ]);
    expect(r.issues.every((i) => i.severity === 'warning')).toBe(true);
  });

  it('a no-op save changes nothing', () => {
    const r = parseWorkflow(TEXT);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(saveWorkflow(r.source, r.doc)).toBe(TEXT);
  });

  it("a save touching one node's config leaves other nodes' formatting alone", () => {
    const r = parseWorkflow(TEXT);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const doc = structuredClone(r.doc);
    doc.nodes[1].config['deep'] = 'changed';
    const out = saveWorkflow(r.source, doc);
    // node A keeps its flow style and single quotes, all on one line
    expect(out).toContain(
      "- { id: n_aaaaaa, type: aec.project_brief, version: 1, config: { title: 'Tower A' } }",
    );
    // the changed scalar keeps its single-quote style
    expect(out).toContain("deep: 'changed'");
    expect(out).not.toContain('single quoted');
    // the odd-whitespace edge scalar is untouched
    expect(out).toContain('n_aaaaaa.brief    ->    n_bbbbbb.brief');
    // the flow-style layout stays flow
    expect(out).toContain('layout: { n_aaaaaa: { x: 1, y: 2 }, n_bbbbbb: { x: 3, y: 4 } }');
  });
});
