/** Compliance review: geometry-driven findings react to upstream params. */
import { describe, expect, it } from 'vitest';
import type { ComplianceReviewResult, TableValue } from '../src/index.js';
import { runPipeline } from './helpers.js';

const GUID_RE = /^[0-9A-Za-z_$]{22}$/;

function result(run: Awaited<ReturnType<typeof runPipeline>>): ComplianceReviewResult {
  return run.review.outputs.result as unknown as ComplianceReviewResult;
}

describe('aec.code_compliance_review', () => {
  it('default upstream params produce zero door/corridor violations', async () => {
    const run = await runPipeline();
    const res = result(run);
    const bad = res.findings.filter(
      (f) => f.severity === 'violation' && (f.ruleId === 'IBC-1010.1.1' || f.ruleId === 'IBC-1020.3'),
    );
    expect(bad).toEqual([]);
    expect(res.summary.checked).toBeGreaterThan(0);
    expect(res.summary.passed).toBe(res.summary.checked - res.findings.length);
  });

  it('door_width_mm 800 raises an IBC-1010.1.1 violation naming a door', async () => {
    const run = await runPipeline({ plan: { door_width_mm: 800 } });
    const violations = result(run).findings.filter(
      (f) => f.ruleId === 'IBC-1010.1.1' && f.severity === 'violation',
    );
    expect(violations.length).toBeGreaterThan(0);
    expect(violations[0].message).toMatch(/d_\d+_\d+/);
    expect(violations[0].message).toContain('800');
    expect(violations[0].message).toContain('813');
  });

  it('corridor_width_mm 1000 with enough occupants raises an IBC-1020.3 violation', async () => {
    const run = await runPipeline({ plan: { corridor_width_mm: 1000 } });
    const violations = result(run).findings.filter(
      (f) => f.ruleId === 'IBC-1020.3' && f.severity === 'violation',
    );
    expect(violations.length).toBeGreaterThan(0);
    expect(violations[0].message).toContain('1000');
    expect(violations[0].message).toContain('1120');
  });

  it('findings table row count matches result.findings length', async () => {
    const run = await runPipeline({ plan: { door_width_mm: 800 } });
    const res = result(run);
    const table = run.review.outputs.findings as unknown as TableValue;
    expect(table.rows.length).toBe(res.findings.length);
    expect(table.columns.map((c) => c.id)).toEqual([
      'id',
      'rule_id',
      'severity',
      'title',
      'level',
      'elements',
      'message',
    ]);
    res.findings.forEach((f, i) => {
      expect(table.rows[i].id).toBe(f.id);
      expect(table.rows[i].elements).toBe(f.elementIds.join(', '));
    });
  });

  it('attaches IFC guids to findings when bim_summary is present', async () => {
    const run = await runPipeline({ plan: { door_width_mm: 800 } });
    const violation = result(run).findings.find(
      (f) => f.ruleId === 'IBC-1010.1.1' && f.severity === 'violation',
    );
    expect(violation).toBeDefined();
    expect(violation!.elementGuids.length).toBeGreaterThan(0);
    for (const guid of violation!.elementGuids) expect(guid).toMatch(GUID_RE);
  });
});
