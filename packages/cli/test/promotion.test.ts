/**
 * Param promotion through the whole product (ADR-0017, ADR-0013 §1).
 *
 * The CLI *is* the integration harness — "the workflow that runs in the app
 * runs in CI" — so this drives a real `archspace` process over a real file with
 * the real registry, rather than calling `startRun` with a hand-built graph the
 * way `packages/engine`'s suite does. Between them they cover the two halves
 * that can disagree: the engine suite proves the fold and the cache key, this
 * one proves the field survives YAML, reaches `EngineNodeSpec`, and produces
 * ports the validator and the runner both recognise.
 *
 * The wired case uses `aec.export_dxf.file_name`, which is a `string` param and
 * so a `text` port, driven from `aec.generate_compliance_report.report` — the
 * only shape of promotion the built-in node set can currently demonstrate end
 * to end, because no core node emits a `number`. That it produces a preposterous
 * filename is the point being tested, not a recommendation: the assertion is
 * that the *wire* reached the param, and a value nobody would type by hand is
 * the clearest way to know it did.
 *
 * The error-message tests matter as much as the happy path. Promotion's whole
 * failure surface is a name that used to resolve and stopped, and ADR-0017
 * chose to spend an error message on each case rather than let them collapse
 * into "unknown input port".
 */
import { afterEach, describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { readFile, readdir } from 'node:fs/promises';
import { cleanupTempDirs, runCli, tempDir, workflowYaml } from './helpers.js';

afterEach(async () => {
  await cleanupTempDirs();
});

/** Brief -> plan -> DXF, with `file_name` promoted on the exporter. */
function promotedExportWorkflow(promoted: string[], edges: string[]): string {
  return workflowYaml(
    'Promotion integration',
    [
      { id: 'n_brief0', type: 'aec.project_brief', config: { project_name: 'Promotion Probe', floors: 1, target_gross_area_m2: 1200 } },
      { id: 'n_plan00', type: 'aec.generate_floor_plan', config: { seed: 3, mock_latency_ms: 0 } },
      { id: 'n_prog00', type: 'aec.space_program', config: {} },
      { id: 'n_dxf000', type: 'aec.export_dxf', config: { file_name: 'from-the-form.dxf' }, promoted },
    ],
    {},
    [
      'n_brief0.brief -> n_prog00.brief',
      'n_brief0.brief -> n_plan00.brief',
      'n_prog00.program -> n_plan00.program',
      'n_plan00.floor_plan -> n_dxf000.floor_plan',
      ...edges,
    ],
  );
}

describe('a promoted param survives the file and reaches the engine', () => {
  it('runs, and falls back to the configured value while the port is unwired', async () => {
    const dir = await tempDir({ 'w.archspace.yaml': promotedExportWorkflow(['file_name'], []) });
    const out = join(dir, 'out');
    const { code, output } = await runCli(['run', join(dir, 'w.archspace.yaml'), '--out', out]);

    expect(code, output).toBe(0);
    // The promotion is persisted and the port exists — and because a promoted
    // port is always optional, an unwired one is a node ready to run rather
    // than a `missing-input`. The configured value is what lands on disk.
    expect(await readdir(out)).toContain('from-the-form.dxf');
  }, 60_000);

  it('lets a wired value override the configured one, end to end', async () => {
    // `report` is `text`; `file_name` is a `string` param, so §9.3 gives it a
    // `text` port and the edge is exactly assignable.
    const doc = workflowYaml(
      'Promotion integration',
      [
        { id: 'n_brief0', type: 'aec.project_brief', config: { project_name: 'Promotion Probe', floors: 1, target_gross_area_m2: 1200 } },
        { id: 'n_plan00', type: 'aec.generate_floor_plan', config: { seed: 3, mock_latency_ms: 0 } },
        { id: 'n_prog00', type: 'aec.space_program', config: {} },
        { id: 'n_bim000', type: 'aec.generate_bim_model', config: { mock_latency_ms: 0 } },
        { id: 'n_rev000', type: 'aec.review.code_compliance', config: { mock_latency_ms: 0 } },
        {
          id: 'n_rep000',
          type: 'aec.generate_compliance_report',
          config: { tone: 'brief', mock_latency_ms: 0 },
        },
        {
          id: 'n_dxf000',
          type: 'aec.export_dxf',
          config: { file_name: 'from-the-form.dxf' },
          promoted: ['file_name'],
        },
      ],
      { plugins: ['aec-review'] },
      [
        'n_brief0.brief -> n_prog00.brief',
        'n_brief0.brief -> n_plan00.brief',
        'n_brief0.brief -> n_rep000.brief',
        'n_prog00.program -> n_plan00.program',
        'n_plan00.floor_plan -> n_bim000.floor_plan',
        'n_plan00.floor_plan -> n_rev000.floor_plan',
        'n_plan00.floor_plan -> n_dxf000.floor_plan',
        'n_bim000.summary -> n_rev000.bim_summary',
        'n_rev000.result -> n_rep000.review',
        'n_rep000.report -> n_dxf000.file_name',
      ],
    );
    const dir = await tempDir({ 'w.archspace.yaml': doc });
    const out = join(dir, 'out');
    const { code, output } = await runCli([
      'run',
      join(dir, 'w.archspace.yaml'),
      '--out',
      out,
      '--trust-plugin',
      'aec-review',
    ]);

    expect(code, output).toBe(0);
    const written = await readdir(out);
    // The configured name did NOT win. (The IFC from the BIM node is in here
    // too, hence a targeted assertion rather than a count.)
    expect(written).not.toContain('from-the-form.dxf');
    const dxf = written.filter((f) => f.endsWith('.dxf'));
    expect(dxf, `wrote: ${written.join(', ')}`).toHaveLength(1);
    // The report's own text became the name, which no one would type — that is
    // how we know the wire reached `params` rather than the default surviving
    // under a different spelling.
    expect(dxf[0].length).toBeGreaterThan('from-the-form.dxf'.length);
    // And what landed is real DXF, so the override did not merely rename a
    // file — the node ran with the wired value and produced output.
    const bytes = await readFile(join(out, dxf[0]));
    expect(bytes.subarray(0, 12).toString('latin1')).toBe('  0\r\nSECTION');
  }, 60_000);
});

describe('what a promotion says when it stops working', () => {
  it('names the param when the node type has no such param', async () => {
    const dir = await tempDir({
      'w.archspace.yaml': promotedExportWorkflow(['no_such_param'], []),
    });
    const { code, output } = await runCli(['run', join(dir, 'w.archspace.yaml')]);
    expect(code).not.toBe(0);
    expect(output).toContain('bad-promotion');
    expect(output).toContain('no_such_param');
    // The diagnosis a user needs: the node type moved under a saved document.
    expect(output).toMatch(/may have changed since the workflow was saved/);
  }, 60_000);

  it('refuses to promote a param its author did not mark promotable', async () => {
    // `level` is a real `aec.export_dxf` param and deliberately not promotable.
    const dir = await tempDir({ 'w.archspace.yaml': promotedExportWorkflow(['level'], []) });
    const { code, output } = await runCli(['run', join(dir, 'w.archspace.yaml')]);
    expect(code).not.toBe(0);
    expect(output).toContain('bad-promotion');
    expect(output).toMatch(/not marked promotable/);
  }, 60_000);

  it('reports ONE error for a bad promotion, not a cascade', async () => {
    // A promotion that cannot be honoured still yields a port, so the edge into
    // it does not also produce `bad-edge`, and the required-input sweep does not
    // produce a false `missing-input` for a port the user did wire.
    const dir = await tempDir({
      'w.archspace.yaml': promotedExportWorkflow(['no_such_param'], ['n_plan00.floor_plan -> n_dxf000.no_such_param']),
    });
    const { output } = await runCli(['run', join(dir, 'w.archspace.yaml')]);
    expect(output.match(/bad-promotion/g) ?? []).toHaveLength(1);
    expect(output).not.toContain('missing-input');
    expect(output).not.toContain('unknown input port');
  }, 60_000);

  it('tells a hand-editor that the target is a promotable param, not a dead end', async () => {
    // The edge without the declaration — the commonest hand-edit, and what a
    // merge produces when it keeps one side's edge and the other's node entry.
    const dir = await tempDir({
      'w.archspace.yaml': promotedExportWorkflow([], ['n_plan00.floor_plan -> n_dxf000.file_name']),
    });
    const { code, output } = await runCli(['run', join(dir, 'w.archspace.yaml')]);
    expect(code).not.toBe(0);
    expect(output).toContain('is a promotable param');
    expect(output).toContain('promoted:');
    // The old message was a dead end in front of a one-line fix.
    expect(output).not.toContain('unknown input port');
  }, 60_000);
});

describe('archspace doctor sees the same graph archspace run does', () => {
  it('accepts a promoted workflow rather than reporting a bad edge', async () => {
    // These used to be two hand-written doc -> graph mappings. A copy that
    // forgot `promoted` type-checks and passes every test, and then `doctor`
    // and `run` disagree about one file.
    const dir = await tempDir({
      'w.archspace.yaml': promotedExportWorkflow(['file_name'], []),
    });
    const { code, output } = await runCli(['doctor', join(dir, 'w.archspace.yaml')]);
    expect(code, output).toBe(0);
    expect(output).toContain('ready to run here');
  }, 60_000);
});
