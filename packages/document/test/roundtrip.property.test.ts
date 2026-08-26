import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { emitWorkflow, parseWorkflow, saveWorkflow } from '../src/index';
import { docArb, idArb, normalizeDoc, propRuns } from './helpers';

describe('round-trip properties (ADR-0013 §2)', () => {
  it('parse(emit(d)) is ok and deep-equals the normalized doc', () => {
    fc.assert(
      fc.property(docArb, (d) => {
        const text = emitWorkflow(d);
        const r = parseWorkflow(text);
        expect(r.ok, JSON.stringify(r.ok ? null : r.issues)).toBe(true);
        if (!r.ok) return;
        expect(r.doc).toEqual(normalizeDoc(d));
      }),
      propRuns(150),
    );
  });

  it('emitted text hygiene: LF only, no trailing whitespace, one trailing newline', () => {
    fc.assert(
      fc.property(docArb, (d) => {
        const text = emitWorkflow(d);
        expect(text.includes('\r')).toBe(false);
        expect(/[ \t]\n/.test(text)).toBe(false);
        expect(text.endsWith('\n')).toBe(true);
        expect(text.endsWith('\n\n')).toBe(false);
      }),
      propRuns(100),
    );
  });

  it('canonical stability: emit(parse(emit(d)).doc) === emit(d)', () => {
    fc.assert(
      fc.property(docArb, (d) => {
        const text = emitWorkflow(d);
        const r = parseWorkflow(text);
        expect(r.ok).toBe(true);
        if (!r.ok) return;
        expect(emitWorkflow(r.doc)).toBe(text);
      }),
      propRuns(150),
    );
  });

  it('no-op save is byte-identical for canonical docs', () => {
    fc.assert(
      fc.property(docArb, (d) => {
        const text = emitWorkflow(d);
        const r = parseWorkflow(text);
        expect(r.ok).toBe(true);
        if (!r.ok) return;
        expect(saveWorkflow(r.source, r.doc)).toBe(text);
      }),
      propRuns(150),
    );
  });

  it('save applies edits: rename + append node + move layout, then a reparse agrees', () => {
    fc.assert(
      fc.property(docArb, idArb, (d, extraId) => {
        fc.pre(!d.nodes.some((n) => n.id === extraId));
        const r = parseWorkflow(emitWorkflow(d));
        expect(r.ok).toBe(true);
        if (!r.ok) return;
        const doc2 = structuredClone(r.doc);
        doc2.meta.name = 'Renamed workflow';
        doc2.nodes.push({
          id: extraId,
          type: 'acme.pointcloud.load',
          version: 1,
          config: { path: 'scan.las' },
        });
        doc2.layout[extraId] = { x: 10.6, y: -3.2 };
        if (doc2.nodes.length > 1) {
          const first = doc2.nodes[0].id;
          doc2.layout[first] = { x: 777, y: 888 };
        }
        const out = saveWorkflow(r.source, doc2);
        const r2 = parseWorkflow(out);
        expect(r2.ok, JSON.stringify(r2.ok ? null : r2.issues)).toBe(true);
        if (!r2.ok) return;
        expect(r2.doc).toEqual(normalizeDoc(doc2));
      }),
      propRuns(80),
    );
  });

  it('save applies removals: drop the first node with its edges and layout', () => {
    fc.assert(
      fc.property(
        docArb.filter((d) => d.nodes.length > 0),
        (d) => {
          const r = parseWorkflow(emitWorkflow(d));
          expect(r.ok).toBe(true);
          if (!r.ok) return;
          const victim = r.doc.nodes[0].id;
          const doc2 = structuredClone(r.doc);
          doc2.nodes = doc2.nodes.filter((n) => n.id !== victim);
          doc2.edges = doc2.edges.filter(
            (e) => e.from.node !== victim && e.to.node !== victim,
          );
          delete doc2.layout[victim];
          const out = saveWorkflow(r.source, doc2);
          const r2 = parseWorkflow(out);
          expect(r2.ok, JSON.stringify(r2.ok ? null : r2.issues)).toBe(true);
          if (!r2.ok) return;
          expect(r2.doc).toEqual(normalizeDoc(doc2));
        },
      ),
      propRuns(80),
    );
  });
});
