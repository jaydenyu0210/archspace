/**
 * What `archspace run` says when a workflow's `requires:` block is not
 * satisfied here (ARCHITECTURE §9.1).
 *
 * This is the failure the CLI exists to be good at — "the workflow my
 * colleague sent me will not run on my machine" — so the message *is* the
 * feature, and each of these was wrong in a way that sent the reader in the
 * wrong direction:
 *
 *  - Under `--no-plugins` the reporter said the plugin was "not installed".
 *    It is installed; the operator had just disabled the host on the command
 *    line. Blaming the machine for something the reader did ten seconds ago is
 *    the least useful thing a diagnostic can do.
 *  - An unconsented plugin said only `is needs-consent`, which names a state
 *    rather than an action. It is the one unmet requirement with a fix
 *    available in the same shell, so it now says what to type.
 *
 * Driven against the real shipped example, so the requirement being reported
 * is a real one rather than a fixture's idea of one.
 */
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { cleanupTempDirs, runCli, tempDir } from './helpers.js';

/** The shipped example whose `requires:` names the first-party plugin. */
const EXAMPLE = fileURLToPath(
  new URL('../../app/resources/concept-compliance.archspace.yaml', import.meta.url),
);

afterAll(cleanupTempDirs);

describe('unmet requirements are reported accurately', () => {
  it('blames the flag, not the machine, under --no-plugins', async () => {
    const dir = await tempDir();
    const result = await runCli(['run', EXAMPLE, '--config-dir', dir, '--no-plugins']);

    expect(result.code, result.output).toBe(1);
    expect(result.output).toContain('the plugin host is disabled (--no-plugins)');
    // The old wording, which sent readers hunting for a plugin sitting on disk.
    expect(result.output).not.toContain('is not installed');
  });

  it('tells an operator how to consent, not merely that consent is missing', async () => {
    const dir = await tempDir();
    const result = await runCli(['run', EXAMPLE, '--config-dir', dir]);

    expect(result.code, result.output).toBe(1);
    expect(result.output).toContain('--trust-plugin aec-review');
    // And the advice has to be true: the same command with that flag runs.
    const fixed = await runCli(['run', EXAMPLE, '--config-dir', dir, '--trust-plugin', 'aec-review']);
    expect(fixed.code, fixed.output).toBe(0);
    expect(fixed.output).toContain('run finished  succeeded');
    // Two real runs of the shipped example, one of which executes every node
    // (the mock generators pace themselves with mock_latency_ms), so this
    // needs more than vitest's 5s default. Asserting the advice actually works
    // is worth the seconds — advice that does not is worse than none.
  }, 30_000);

  it('refuses rather than running the nodes that happen to be satisfiable', async () => {
    // A partial run is worse than a refusal: the exit code says failure while
    // the transcript shows nodes completing, and whatever they wrote is a
    // half-answer that looks like an answer.
    const dir = await tempDir();
    const result = await runCli(['run', EXAMPLE, '--config-dir', dir, '--no-plugins']);

    expect(result.output).toContain('Validation failed — not running.');
    expect(result.output).not.toContain('run finished');
    expect(result.output).not.toContain('complete');
  });
});
