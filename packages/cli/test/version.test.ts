/**
 * `archspace --version` and `--help` — the two commands that must answer
 * without a runtime.
 *
 * §16's M0 gate reads "CI green on a PR; `archspace --version` runs from a
 * fresh checkout", and M0 was declared passed. It did not run: the flag fell
 * through to `usage()`, which printed the whole synopsis to stderr and exited
 * 2. A gate a milestone was declared against is either executable or it is
 * decoration, so this is the command being made real rather than the gate being
 * quietly edited to match what shipped.
 *
 * Run as a real process, like every other CLI test here, because the assertions
 * are about the exit code and which stream the output went to — neither of
 * which survives calling the function in-process.
 *
 * The version is asserted to EQUAL the package's, not merely to look like a
 * version. A `--version` that prints a plausible number from the wrong place is
 * the failure this is guarding, and it is invisible to a regex.
 */
import { describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { afterEach } from 'vitest';
import { cleanupTempDirs, runCli } from './helpers.js';

afterEach(async () => {
  await cleanupTempDirs();
});

async function packageVersion(): Promise<string> {
  const raw = await readFile(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8');
  return (JSON.parse(raw) as { version: string }).version;
}

describe('archspace --version (ARCHITECTURE §16, M0 gate)', () => {
  it('prints this package’s version and exits 0', async () => {
    const expected = await packageVersion();
    const { code, output } = await runCli(['--version']);
    expect(code).toBe(0);
    expect(output.trim()).toBe(expected);
  });

  it('answers under every spelling a user will try', async () => {
    const expected = await packageVersion();
    for (const spelling of ['-v', 'version']) {
      const { code, output } = await runCli([spelling]);
      expect(code, `archspace ${spelling}`).toBe(0);
      expect(output.trim(), `archspace ${spelling}`).toBe(expected);
    }
  });

  it('needs no settings directory, no MCP host and no plugin host', async () => {
    // The point of a version command is to answer "is this thing installed".
    // Pointing it at a config directory that cannot exist proves it never went
    // looking: if it built a runtime, this is where it would fail.
    const { code, output } = await runCli(['--version', '--config-dir', '/nonexistent/archspace-version-probe']);
    expect(code).toBe(0);
    expect(output.trim()).toBe(await packageVersion());
  });
});

describe('archspace --help', () => {
  it('is a request, not a mistake: exit 0 on stdout', async () => {
    const { code, output } = await runCli(['--help']);
    expect(code).toBe(0);
    expect(output).toContain('archspace run <workflow.archspace.yaml>');
    expect(output).toContain('archspace --version');
  });

  it('still corrects a caller who got it wrong: exit 2', async () => {
    const { code, output } = await runCli(['bogus-command']);
    expect(code).toBe(2);
    expect(output).toContain('usage:');
  });

  it('lists every command it dispatches, so the synopsis cannot drift', async () => {
    const { output } = await runCli(['--help']);
    for (const command of ['run', 'nodes', 'plugins', 'mcp', 'ai', 'doctor']) {
      expect(output, `"${command}" is dispatched but not documented`).toContain(`archspace ${command}`);
    }
  });
});
