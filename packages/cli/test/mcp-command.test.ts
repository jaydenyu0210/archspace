/**
 * `archspace mcp` — what it says and what it exits with.
 *
 * Two failures that a script cannot see past. `--connect` printed "failed: …"
 * and exited 0, so `archspace mcp --connect revit && deploy` carried straight
 * on to a deploy that depended on a server it had just failed to reach. And
 * when `mcp.yaml` could not be parsed, `list()` was empty and the command
 * reported "No MCP servers configured. Add them to …/mcp.yaml" — a sentence
 * that is not merely unhelpful but false, sending the user to add servers to a
 * file that already has them and cannot be read.
 *
 * The parse errors were computed and discarded: only `run` and `doctor` printed
 * `rt.config.issues`, and `mcp`, `ai`, `nodes` and `plugins` were silent about
 * a settings file they had just failed to read.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { cleanupTempDirs, runCli, tempDir } from './helpers.js';

afterEach(async () => {
  await cleanupTempDirs();
});

describe('archspace mcp', () => {
  it('reports an unreadable mcp.yaml instead of calling it empty', async () => {
    const dir = await tempDir({ 'mcp.yaml': 'servers:\n  revit:\n    transport: nonsense\n' });
    const { code, output } = await runCli(['mcp', '--config-dir', dir]);

    expect(output).toContain('transport must be');
    expect(output).toContain('No MCP servers could be read from');
    // The false sentence, gone.
    expect(output).not.toContain('No MCP servers configured');
    // And it is a failure, because the machine is not in the state the user
    // asked about.
    expect(code).toBe(1);
  }, 60_000);

  it('still says "none configured" when there genuinely are none', async () => {
    const dir = await tempDir({ 'mcp.yaml': 'servers: {}\n' });
    const { code, output } = await runCli(['mcp', '--config-dir', dir]);
    expect(code).toBe(0);
    expect(output).toContain('No MCP servers configured');
    expect(output).toContain('mcp.yaml');
  }, 60_000);

  it('exits non-zero when a --connect fails', async () => {
    // The one a CI script depends on.
    const dir = await tempDir({ 'mcp.yaml': 'servers: {}\n' });
    const { code, output } = await runCli(['mcp', '--connect', 'ghost', '--config-dir', dir]);
    expect(output).toContain('connecting ghost');
    expect(output).toContain('failed:');
    expect(code).toBe(1);
  }, 60_000);

  it('exits 0 with no --connect and a readable, empty config', async () => {
    // The refusal must not have become "any empty config is an error".
    const dir = await tempDir({ 'mcp.yaml': 'servers: {}\n' });
    expect((await runCli(['mcp', '--config-dir', dir])).code).toBe(0);
  }, 60_000);
});

describe('every command that reads settings says what it could not read', () => {
  it.each(['mcp', 'ai', 'nodes', 'plugins'])('%s reports a broken mcp.yaml', async (command) => {
    const dir = await tempDir({ 'mcp.yaml': 'servers:\n  revit:\n    transport: nonsense\n' });
    const { output } = await runCli([command, '--config-dir', dir]);
    expect(output, `archspace ${command}`).toContain('transport must be');
  }, 60_000);
});
