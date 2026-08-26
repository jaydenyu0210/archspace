/**
 * `loadCliConfig` — the settings loader, and the three ways it can lie.
 *
 * The CLI reads the same `mcp.yaml`, `ai.yaml` and `plugins.json` the desktop
 * app writes (ARCHITECTURE §9.1, ADR-0013 §1), which means the loader stands
 * between a hand-editable file and every claim `doctor` makes about a machine.
 * Its failure modes are ordered by how much damage they do, and it is the
 * *quietest* one that does the most:
 *
 *   throwing        — loud, and the operator fixes the file. Least harmful.
 *   reporting       — the intended outcome: the issue names the file and the
 *                     path inside it, and everything still parseable survives.
 *   silence         — the dangerous one. An empty `servers` map with no issue
 *                     attached is indistinguishable from "you have configured
 *                     no MCP servers", so the operator reads `doctor`'s output,
 *                     believes it, and goes looking for the fault somewhere
 *                     else entirely. Same for plugin consent: silently empty
 *                     consent reads as "nothing is trusted yet", which is a
 *                     sentence the CLI is entitled to say only when it is true.
 *
 * So every malformed-input case below asserts two things — the salvage and the
 * *issue* — and never just the salvage.
 *
 * The suite never touches the developer's own settings directory: every case
 * passes an explicit temp `dir`. See helpers.ts.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { AI_CONFIG_FILENAME, defaultAiConfig } from '@archspace/ai-gateway';
import { MCP_CONFIG_FILENAME } from '@archspace/mcp-host';
import { loadCliConfig } from '../src/config.js';
import { cleanupTempDirs, tempDir } from './helpers.js';

afterEach(cleanupTempDirs);

const GOOD_MCP = `servers:
  formats:
    transport: stdio
    command: ["uvx", "archspace-formats-server"]
    concurrency: 3
  revit:
    transport: http
    url: https://revit-agent.office.example:8443/mcp
    auth: oauth
    enabled: false
`;

const GOOD_AI = `defaultProfile: local
profiles:
  - name: local
    provider: ollama
    model: llama3.1
    baseUrl: http://localhost:11434/v1
`;

describe('loadCliConfig — a machine with no settings yet', () => {
  it('returns defaults with no issues when the directory does not exist', async () => {
    // First run on a fresh CI box, and the reason `readOptional` swallows
    // ENOENT: a missing settings directory is a state, not a fault.
    const parent = await tempDir();
    const dir = join(parent, 'never-created');

    const config = await loadCliConfig(dir);

    expect(config.issues).toEqual([]);
    expect(config.dir).toBe(dir);
    expect(config.mcp.servers).toEqual({});
    expect(config.pluginConsent).toEqual({});
  });

  it('returns the same AI defaults the app would show, not an empty profile list', async () => {
    // The defaults are shared code (`defaultAiConfig`), asserted as a whole
    // rather than by profile name: the point is that both programs start from
    // one object, so a change to the out-of-the-box binding cannot land in the
    // app and miss the CLI.
    const config = await loadCliConfig(await tempDir());

    expect(config.ai).toEqual(defaultAiConfig());
  });

  it('reads an empty directory exactly as it reads a missing one', async () => {
    const config = await loadCliConfig(await tempDir());

    expect(config.issues).toEqual([]);
    expect(config.mcp.servers).toEqual({});
    expect(config.pluginConsent).toEqual({});
  });
});

describe('loadCliConfig — a machine that is configured', () => {
  it('loads all three files, keeping the details the runtime later depends on', async () => {
    const dir = await tempDir({
      [MCP_CONFIG_FILENAME]: GOOD_MCP,
      [AI_CONFIG_FILENAME]: GOOD_AI,
      'plugins.json': JSON.stringify({ 'aec-review': { enabled: true, permissions: [] } }),
    });

    const config = await loadCliConfig(dir);

    expect(config.issues).toEqual([]);
    expect(Object.keys(config.mcp.servers).sort()).toEqual(['formats', 'revit']);
    // `concurrency` is the field `createRuntime` turns into a `mcp:<name>` lane
    // cap; dropping it silently would let a serial server be called in parallel.
    expect(config.mcp.servers.formats.concurrency).toBe(3);
    // `enabled: false` has to survive as false — defaulting it to true would
    // connect a server the user switched off.
    expect(config.mcp.servers.revit.enabled).toBe(false);
    expect(config.ai.defaultProfile).toBe('local');
    expect(config.ai.profiles.map((p) => p.name)).toEqual(['local']);
    expect(config.pluginConsent).toEqual({ 'aec-review': { enabled: true, permissions: [] } });
  });
});

describe('loadCliConfig — a malformed mcp.yaml is reported, never silently empty', () => {
  it('names the file and the path when the top level is the wrong shape', async () => {
    const dir = await tempDir({ [MCP_CONFIG_FILENAME]: 'servers: "not a mapping"\n' });

    const config = await loadCliConfig(dir);

    expect(config.mcp.servers).toEqual({});
    // Both halves of the prefix matter: "mcp.yaml" tells the operator which of
    // three files to open, "servers" tells them where to look inside it.
    expect(config.issues).toHaveLength(1);
    expect(config.issues[0]).toContain(MCP_CONFIG_FILENAME);
    expect(config.issues[0]).toContain('servers');
  });

  it('reports unparseable YAML rather than throwing out of the loader', async () => {
    const dir = await tempDir({ [MCP_CONFIG_FILENAME]: 'servers:\n  formats:\n   - [unclosed\n' });

    const config = await loadCliConfig(dir);

    expect(config.issues.length).toBeGreaterThan(0);
    expect(config.issues.every((issue) => issue.startsWith(MCP_CONFIG_FILENAME))).toBe(true);
  });

  it('keeps every good binding when one server is broken', async () => {
    // The property ADR-0009's tolerant parser exists for: a typo in one entry
    // must not cost the operator the other four. Asserted here as well as in
    // the mcp-host suite because this is the path `doctor` actually walks, and
    // a loader that bailed on the first issue would pass that suite and fail
    // every user.
    const dir = await tempDir({
      [MCP_CONFIG_FILENAME]: `servers:
  formats:
    transport: stdio
    command: ["uvx", "archspace-formats-server"]
  broken:
    transport: stdio
`,
    });

    const config = await loadCliConfig(dir);

    expect(Object.keys(config.mcp.servers)).toEqual(['formats']);
    expect(config.issues).toHaveLength(1);
    expect(config.issues[0]).toContain('broken');
  });
});

describe('loadCliConfig — a malformed ai.yaml is reported, never silently defaulted', () => {
  it('reports the fallback, because the fallback is not empty', async () => {
    // This is the sharpest instance of the silence problem. `parseAiConfig`
    // falls back to `defaultAiConfig()` — two working-looking profiles — so
    // without the issue the operator sees a *plausible* list and never learns
    // their own file was ignored. The issue is the only thing distinguishing
    // "your profiles" from "profiles we invented".
    const dir = await tempDir({ [AI_CONFIG_FILENAME]: 'profiles: [\n' });

    const config = await loadCliConfig(dir);

    expect(config.ai).toEqual(defaultAiConfig());
    expect(config.issues).toHaveLength(1);
    expect(config.issues[0]).toContain(AI_CONFIG_FILENAME);
  });

  it('reports a bad profile and keeps the good ones', async () => {
    const dir = await tempDir({
      [AI_CONFIG_FILENAME]: `defaultProfile: local
profiles:
  - name: local
    provider: ollama
    model: llama3.1
    baseUrl: http://localhost:11434/v1
  - name: bogus
    provider: not_a_provider
    model: whatever
`,
    });

    const config = await loadCliConfig(dir);

    expect(config.ai.profiles.map((p) => p.name)).toEqual(['local']);
    expect(config.issues).toHaveLength(1);
    expect(config.issues[0]).toContain(AI_CONFIG_FILENAME);
    expect(config.issues[0]).toContain('not_a_provider');
  });

  it('carries issues from every file at once, so one report fixes the machine', async () => {
    const dir = await tempDir({
      [MCP_CONFIG_FILENAME]: 'servers: "not a mapping"\n',
      [AI_CONFIG_FILENAME]: 'profiles: [\n',
      'plugins.json': '{ not json',
    });

    const config = await loadCliConfig(dir);

    expect(config.issues).toHaveLength(3);
    expect(config.issues.filter((i) => i.startsWith(MCP_CONFIG_FILENAME))).toHaveLength(1);
    expect(config.issues.filter((i) => i.startsWith(AI_CONFIG_FILENAME))).toHaveLength(1);
    expect(config.issues.filter((i) => i.includes('plugins.json'))).toHaveLength(1);
  });
});

describe('loadCliConfig — a malformed plugins.json is reported, never silently unconsented', () => {
  it('reports text that is not JSON at all', async () => {
    const dir = await tempDir({ 'plugins.json': '{ "aec-review": ' });

    const config = await loadCliConfig(dir);

    expect(config.pluginConsent).toEqual({});
    expect(config.issues).toHaveLength(1);
    expect(config.issues[0]).toContain('plugins.json');
  });

  // ---------------------------------------------------------------------
  // The two cases below are the ones a `JSON.parse` guard alone does not
  // cover, and both were silent until this suite named them: valid JSON of
  // the wrong outer shape, and valid JSON of the right outer shape holding a
  // record nobody checked. They are the sharpest form of the silence problem
  // in the suite header — consent that is quietly empty reads as "nothing has
  // been trusted yet", and that is a sentence about a user's own security
  // decisions. Do not relax either one to match a future refactor.
  // ---------------------------------------------------------------------

  it('reports valid JSON that is not a consent object', async () => {
    // One case per JSON shape that survives `JSON.parse` and fails the object
    // check, gathered into a single assertion so that one missing `else`
    // reads as one failure rather than four.
    const reported: Record<string, string[]> = {};
    for (const body of ['[]', 'null', '42', '"aec-review"']) {
      const dir = await tempDir({ 'plugins.json': body });

      const config = await loadCliConfig(dir);

      // The salvage is already right; it is the report that is missing.
      expect(config.pluginConsent).toEqual({});
      reported[body] = config.issues;
    }

    expect(reported).toEqual({
      '[]': [expect.stringContaining('plugins.json')],
      null: [expect.stringContaining('plugins.json')],
      42: [expect.stringContaining('plugins.json')],
      '"aec-review"': [expect.stringContaining('plugins.json')],
    });
  });

  it('reports and drops a consent record that is missing its permission list', async () => {
    // Reachable from a hand-edit, or from a record written by an older build.
    // Taken as-is, the damage lands two layers away: `--trust-plugin` spreads
    // `entry.permissions` and dies with "entry.permissions is not iterable" —
    // an unhandled TypeError out of `createRuntime`, caused by a settings file,
    // mentioning no settings file. Dropping the record is the safe direction
    // (its plugin stays unconsented); the issue is what makes it findable.
    const dir = await tempDir({
      'plugins.json': JSON.stringify({
        'aec-review': { enabled: true, permissions: [] },
        'half-written': { enabled: true },
      }),
    });

    const config = await loadCliConfig(dir);

    expect(Object.keys(config.pluginConsent)).toEqual(['aec-review']);
    expect(config.issues).toHaveLength(1);
    expect(config.issues[0]).toContain('half-written');
  });
});
