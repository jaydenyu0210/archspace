/**
 * `archspace plugins` — what the exit code means.
 *
 * The listing itself is easy; the exit code is the part CI and shell scripts
 * branch on, and it is the part that was wrong. `needs-consent` is the state
 * every bundled plugin sits in until a human decides, so treating it as a
 * failure meant the first `archspace plugins` on a fresh machine reported an
 * error about the plugin the product ships — and `doctor`, which is the
 * command whose whole job is "is this machine healthy", returned 0 on the
 * identical state. Two commands disagreeing about one fact is the bug; these
 * tests pin the agreement.
 *
 * Driven as a real process over a temp `--config-dir` (helpers.ts), so what is
 * asserted is what an operator would actually see.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { cleanupTempDirs, runCli, tempDir } from './helpers.js';

afterAll(cleanupTempDirs);

describe('archspace plugins', () => {
  it('lists the bundled plugin and exits 0 while it is merely unconsented', async () => {
    const dir = await tempDir();
    const result = await runCli(['plugins', '--config-dir', dir]);

    // The listing is real: the bundled first-party plugin is discovered even
    // though it cannot load, which is the whole point of reporting state.
    expect(result.output).toContain('aec-review');
    expect(result.output).toContain('needs-consent');
    // Not a fault. A decision the user has not made yet is not a broken machine.
    expect(result.code, result.output).toBe(0);
  });

  it('agrees with doctor about the same machine', async () => {
    // The regression this file exists for: these two commands read the same
    // plugin list and used to return different verdicts on it.
    const dir = await tempDir();
    const plugins = await runCli(['plugins', '--config-dir', dir]);
    const doctor = await runCli(['doctor', '--config-dir', dir]);

    expect(doctor.output).toContain('needs-consent');
    expect(plugins.code, `plugins:\n${plugins.output}`).toBe(doctor.code);
  });

  it('exits 0 once the plugin is consented, and reports it loaded', async () => {
    const dir = await tempDir();
    const result = await runCli(['plugins', '--config-dir', dir, '--trust-plugin', 'aec-review']);

    expect(result.output).toContain('loaded');
    // The node types it contributes are the observable proof it really loaded,
    // rather than merely being recorded as consented.
    expect(result.output).toContain('aec.review.');
    expect(result.code, result.output).toBe(0);
  });
});
