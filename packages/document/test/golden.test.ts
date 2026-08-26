import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseWorkflow, saveWorkflow } from '../src/index';

const GOLDEN = readFileSync(new URL('./fixtures/golden.archspace.yaml', import.meta.url), 'utf8');

describe('golden file', () => {
  it('parse result matches the snapshot', () => {
    const r = parseWorkflow(GOLDEN);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect({ doc: r.doc, issues: r.issues }).toMatchSnapshot();
  });

  it('no-op save is byte-identical and matches the snapshot', () => {
    const r = parseWorkflow(GOLDEN);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const out = saveWorkflow(r.source, r.doc);
    expect(out).toBe(GOLDEN);
    expect(out).toMatchSnapshot();
  });
});
