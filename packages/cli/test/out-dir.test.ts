/**
 * `archspace run --out <dir>` — getting the files a run produced onto disk.
 *
 * Without this flag a headless run generated a DXF drawing and an IFC model
 * into an in-memory store and then exited, discarding both. That is the exact
 * shape of a failure that reads as a success: the transcript says "succeeded",
 * every node reports complete, and there is nothing to show for it.
 *
 * So what these cases assert is mostly about *bytes on disk* rather than about
 * the transcript — the file exists, it is the size the run said it was, and it
 * starts with what its format requires. A test that only checked the log would
 * have passed against the version that discarded everything.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { readFile, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { cleanupTempDirs, runCli, tempDir, workflowYaml } from './helpers.js';

afterEach(cleanupTempDirs);

/** brief → program → plan → dxf: the shortest chain that produces a file. */
function planToDxf(fileName = 'plan.dxf', extra: { id: string; file: string }[] = []): string {
  return workflowYaml(
    'Plan Export',
    [
      { id: 'brief', type: 'aec.project_brief', config: { floors: 2, target_gross_area_m2: 2000 } },
      { id: 'program', type: 'aec.space_program' },
      { id: 'plan', type: 'aec.generate_floor_plan', config: { mock_latency_ms: 0, seed: 3 } },
      { id: 'dxf', type: 'aec.export_dxf', config: { file_name: fileName } },
      ...extra.map((e) => ({ id: e.id, type: 'aec.export_dxf', config: { file_name: e.file } })),
    ],
    {},
    [
      'brief.brief -> program.brief',
      'brief.brief -> plan.brief',
      'program.program -> plan.program',
      'plan.floor_plan -> dxf.floor_plan',
      ...extra.map((e) => `plan.floor_plan -> ${e.id}.floor_plan`),
    ],
  );
}

describe('archspace run --out', () => {
  it('writes the run’s files, and they are the files the run reported', async () => {
    const dir = await tempDir({ 'plan.archspace.yaml': planToDxf('tower.dxf') });
    const out = join(dir, 'artifacts');

    const result = await runCli(['run', join(dir, 'plan.archspace.yaml'), '--config-dir', dir, '--out', out]);

    expect(result.code).toBe(0);
    expect(result.output).toContain('run finished  succeeded');
    expect(result.output).toContain(join(out, 'tower.dxf'));

    // The directory did not exist: --out creates it rather than failing on a
    // path the user has obviously not made yet.
    expect(await readdir(out)).toEqual(['tower.dxf']);

    const bytes = await readFile(join(out, 'tower.dxf'));
    expect(bytes.byteLength).toBeGreaterThan(0);
    // R12, and the group-code framing intact — not merely a non-empty file.
    const text = bytes.toString('latin1');
    expect(text.startsWith('  0\r\nSECTION\r\n')).toBe(true);
    expect(text).toContain('AC1009');
    expect(text.endsWith('  0\r\nEOF\r\n')).toBe(true);

    // The size the transcript announced is the size on disk.
    const announced = /\(([\d.]+) KB/.exec(result.output)?.[1];
    expect(Number(announced)).toBeCloseTo(bytes.byteLength / 1024, 1);
    expect((await stat(join(out, 'tower.dxf'))).size).toBe(bytes.byteLength);
  });

  it('names the file from the node’s own file_name param', async () => {
    const dir = await tempDir({ 'plan.archspace.yaml': planToDxf('riverside.dxf') });
    const out = join(dir, 'artifacts');
    const result = await runCli(['run', join(dir, 'plan.archspace.yaml'), '--config-dir', dir, '--out', out]);

    expect(result.code).toBe(0);
    expect(await readdir(out)).toEqual(['riverside.dxf']);
  });

  it('reports a name collision instead of silently overwriting', async () => {
    // Two exports asked for the same file name. Writing both would leave one
    // file that claims to be two outputs, which is worse than an error —
    // nothing downstream could tell which run produced it.
    const dir = await tempDir({
      'plan.archspace.yaml': planToDxf('same.dxf', [{ id: 'dxf2', file: 'same.dxf' }]),
    });
    const out = join(dir, 'artifacts');

    const result = await runCli(['run', join(dir, 'plan.archspace.yaml'), '--config-dir', dir, '--out', out]);

    // The run itself succeeded; the write did not, and the exit code follows
    // what the operator asked for rather than what the engine managed.
    expect(result.output).toContain('run finished  succeeded');
    expect(result.output).toContain('two outputs claim this name');
    expect(result.code).toBe(1);
    expect(await readdir(out)).toEqual(['same.dxf']);
  });

  it('says so when a run produced nothing, rather than leaving an empty directory unexplained', async () => {
    const dir = await tempDir({
      'brief.archspace.yaml': workflowYaml('Brief Only', [{ id: 'brief', type: 'aec.project_brief' }]),
    });
    const out = join(dir, 'artifacts');

    const result = await runCli(['run', join(dir, 'brief.archspace.yaml'), '--config-dir', dir, '--out', out]);

    expect(result.code).toBe(0);
    expect(result.output).toContain('No files to write');
    expect(await readdir(out)).toEqual([]);
  });
});

describe('archspace run without --out', () => {
  it('mentions the files it produced, so they are not silently discarded', async () => {
    // The whole failure this flag exists for: a run that generated a drawing
    // used to look identical to one that generated nothing.
    const dir = await tempDir({ 'plan.archspace.yaml': planToDxf('tower.dxf') });

    const result = await runCli(['run', join(dir, 'plan.archspace.yaml'), '--config-dir', dir]);

    expect(result.code).toBe(0);
    expect(result.output).toContain('1 file(s) produced');
    expect(result.output).toContain('tower.dxf');
    expect(result.output).toContain('--out');
  });

  it('stays quiet about files when a run produced none', async () => {
    const dir = await tempDir({
      'brief.archspace.yaml': workflowYaml('Brief Only', [{ id: 'brief', type: 'aec.project_brief' }]),
    });

    const result = await runCli(['run', join(dir, 'brief.archspace.yaml'), '--config-dir', dir]);

    expect(result.code).toBe(0);
    expect(result.output).not.toContain('file(s) produced');
    expect(result.output).not.toContain('--out');
  });
});
