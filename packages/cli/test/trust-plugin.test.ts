/**
 * `--trust-plugin` — consent, in a place with no dialog to show it in.
 *
 * ADR-0008 makes "this code may run" a decision a human takes, and takes
 * *before* the code runs — true even for a plugin declaring no permissions at
 * all. A headless run cannot ask, so the decision moves to the command line and
 * the operator typing the id is the consent. That relocation is only safe if
 * three properties hold, and none of them is visible from reading a call site:
 *
 *   1. **Absence is refusal.** With no record, a discovered plugin stays
 *      unloaded and contributes no node types. A plugin that loaded because it
 *      happened to be installed would make the consent model decorative.
 *   2. **The grant is the manifest, exactly.** A grant is for the permissions
 *      the plugin declares — which is why `trustNamedPlugins` runs *after*
 *      `discover()`, when there is a parsed manifest to read them from. The
 *      alternative to reading them is inventing a set or handing over a blanket
 *      one, and a blanket grant is the thing a permission list exists to
 *      prevent (ADR-0008 §2).
 *   3. **It does not persist.** Nothing may be written to `plugins.json`. A CI
 *      job that widened what the desktop app trusts afterwards would be a
 *      privilege escalation with a green checkmark on it; the app's consent
 *      store stays the only durable record. Non-persistence is a security
 *      property, so it is asserted as the *absence of a file*, not inferred.
 *
 * These run the real plugin host against real forked children — that is the
 * point of ADR-0013 §1 — but never the network, and never the developer's own
 * settings or consent store.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { createAiGateway, defaultAiConfig } from '@archspace/ai-gateway';
import { createMemoryAssetStore } from '@archspace/node-sdk';
import { createPluginHost, forkPluginSpawn } from '@archspace/plugin-host';
import { cliSecrets, cliStrictSecrets } from '../src/config.js';
import { createRuntime } from '../src/runtime.js';
import {
  FIXTURE_PLUGIN_ID,
  FIXTURE_PLUGIN_NODE_TYPE,
  FIXTURE_PLUGIN_PERMISSIONS,
  captureConsole,
  cleanupTempDirs,
  closeTracked,
  pluginChildEntry,
  tempDir,
  track,
  writeUserPlugin,
} from './helpers.js';

afterEach(async () => {
  await closeTracked();
  await cleanupTempDirs();
});

/** The bundled first-party plugin, always present in the workspace. */
const BUNDLED_ID = 'aec-review';

const trustingLine = (lines: string[], id: string): string | undefined =>
  lines.find((line) => line.includes(`trusting plugin "${id}"`));

describe('--trust-plugin — absence of consent is refusal', () => {
  it('leaves a discovered plugin unloaded, with no permissions and no nodes', async () => {
    const rt = track(await createRuntime({ configDir: await tempDir() }));

    const bundled = rt.plugins?.list().find((p) => p.id === BUNDLED_ID);

    expect(bundled?.state).toBe('needs-consent');
    expect(bundled?.grantedPermissions).toEqual([]);
    expect(bundled?.nodeTypes).toEqual([]);
    // Three independent surfaces, because a plugin leaking through any one of
    // them is a plugin whose code ran: the host's own view, the modules it
    // offers the runtime, and the registry a workflow is validated against.
    expect(rt.plugins?.nodeModules()).toEqual([]);
    expect(rt.registry.manifests().filter((m) => m.type.startsWith('aec.review.'))).toEqual([]);
  });
});

describe('--trust-plugin <id> — consent for this invocation', () => {
  it('loads the named plugin and registers exactly the node types it reports', async () => {
    // Asserted as a set difference against the unconsented run rather than
    // against a pasted list of review node ids: the claim is "consent adds this
    // plugin's nodes and nothing else", and it should survive the plugin
    // gaining or losing a node.
    const dir = await tempDir();
    const withoutConsent = track(await createRuntime({ configDir: dir }));
    const before = new Set(withoutConsent.registry.manifests().map((m) => m.type));

    const captured = captureConsole();
    let plugin;
    let added: string[];
    try {
      const rt = track(await createRuntime({ configDir: dir, trustPlugins: [BUNDLED_ID] }));
      plugin = rt.plugins?.list().find((p) => p.id === BUNDLED_ID);
      added = rt.registry.manifests().map((m) => m.type).filter((t) => !before.has(t));
    } finally {
      captured.restore();
    }

    expect(plugin?.state).toBe('loaded');
    expect(plugin?.nodeTypes.length).toBeGreaterThan(0);
    expect(added.sort()).toEqual([...plugin!.nodeTypes].sort());
    // Every one of them inside the namespace the manifest claims — the host
    // enforces this, and a plugin that could register outside it would be able
    // to shadow a core node type.
    expect(added.every((type) => type.startsWith('aec.review.'))).toBe(true);
  });

  it('announces the grant unconditionally, without --verbose', async () => {
    // A security decision that only appears in verbose mode is a security
    // decision nobody reads, so this line is printed straight to stdout rather
    // than through the host log. `verbose` is left off here on purpose.
    const captured = captureConsole();
    try {
      track(await createRuntime({ configDir: await tempDir(), trustPlugins: [BUNDLED_ID] }));
    } finally {
      captured.restore();
    }

    // The bundled plugin declares no permissions, and the line says so in
    // words. "(none declared)" and an omitted list are very different things to
    // read in a CI log.
    expect(trustingLine(captured.lines, BUNDLED_ID)).toBe(
      `  trusting plugin "${BUNDLED_ID}" for this run — permissions granted: (none declared)`,
    );
  });

  it('grants exactly the permissions the manifest declares, never a blanket set', async () => {
    // `plugins/aec-review` declares none, so on its own it cannot tell an exact
    // grant from a blanket one. This fixture declares two of different shapes —
    // the coarse `net` and the key-scoped `secrets:acme_api_key` — and both the
    // recorded grant and the printed one are checked against the manifest.
    const dir = await tempDir();
    await writeUserPlugin(dir);

    const captured = captureConsole();
    let fixture;
    try {
      const rt = track(await createRuntime({ configDir: dir, trustPlugins: [FIXTURE_PLUGIN_ID] }));
      fixture = rt.plugins?.list().find((p) => p.id === FIXTURE_PLUGIN_ID);
    } finally {
      captured.restore();
    }

    expect(fixture?.manifest.permissions).toEqual(FIXTURE_PLUGIN_PERMISSIONS);
    expect(fixture?.grantedPermissions).toEqual(FIXTURE_PLUGIN_PERMISSIONS);
    expect(trustingLine(captured.lines, FIXTURE_PLUGIN_ID)).toBe(
      `  trusting plugin "${FIXTURE_PLUGIN_ID}" for this run — permissions granted: ${FIXTURE_PLUGIN_PERMISSIONS.join(', ')}`,
    );
  });

  it('grants nothing to a plugin that was not named', async () => {
    // `setConsent` is called with a whole state object, so the failure mode
    // worth pinning is the sloppy one: consenting to everything discovered
    // because one id was typed.
    const dir = await tempDir();
    await writeUserPlugin(dir);

    const captured = captureConsole();
    let untouched;
    try {
      const rt = track(await createRuntime({ configDir: dir, trustPlugins: [BUNDLED_ID] }));
      untouched = rt.plugins?.list().find((p) => p.id === FIXTURE_PLUGIN_ID);
    } finally {
      captured.restore();
    }

    expect(untouched?.state).toBe('needs-consent');
    expect(untouched?.grantedPermissions).toEqual([]);
    expect(trustingLine(captured.lines, FIXTURE_PLUGIN_ID)).toBeUndefined();
  });

  it('warns about an unknown id instead of throwing, and trusts the rest of the list', async () => {
    // A typo in a CI invocation must not take down a run that is otherwise
    // fine — but it must not pass in silence either, because the plugin the
    // operator meant to trust is now not trusted and the workflow will fail
    // later with something less specific.
    const captured = captureConsole();
    let plugin;
    try {
      const rt = track(
        await createRuntime({ configDir: await tempDir(), trustPlugins: ['no-such-plugin', BUNDLED_ID] }),
      );
      plugin = rt.plugins?.list().find((p) => p.id === BUNDLED_ID);
    } finally {
      captured.restore();
    }

    const warning = captured.lines.find((line) => line.includes('no-such-plugin'));
    expect(warning).toBeDefined();
    expect(warning).toContain('no such plugin is installed');
    expect(plugin?.state).toBe('loaded');
  });
});

describe('--trust-plugin — the grant does not outlive the process', () => {
  it('creates no plugins.json, and leaves the settings directory as it found it', async () => {
    const dir = await tempDir();
    const before = (await readdir(dir)).sort();

    const captured = captureConsole();
    try {
      track(await createRuntime({ configDir: dir, trustPlugins: [BUNDLED_ID] }));
    } finally {
      captured.restore();
    }

    // Asserted as the absence of the file specifically, and then as the
    // directory being unchanged, because "no consent was persisted" is the
    // security property and an empty-but-present `plugins.json` would still be
    // a write to the app's consent store.
    expect(existsSync(join(dir, 'plugins.json'))).toBe(false);
    expect((await readdir(dir)).sort()).toEqual(before);
  });

  it('does not touch an existing plugins.json, not even to restate what it says', async () => {
    // The escalation this prevents: a CI job trusting a plugin for one run and
    // leaving the desktop app trusting it forever afterwards. Byte-for-byte,
    // because a rewrite that happened to produce the same consent would still
    // be this file writing to the app's store.
    const original = `${JSON.stringify({ 'some-other-plugin': { enabled: false, permissions: [] } }, null, 2)}\n`;
    const dir = await tempDir({ 'plugins.json': original });

    const captured = captureConsole();
    try {
      track(await createRuntime({ configDir: dir, trustPlugins: [BUNDLED_ID] }));
    } finally {
      captured.restore();
    }

    expect(await readFile(join(dir, 'plugins.json'), 'utf8')).toBe(original);
  });
});

describe('--trust-plugin — a plugin installed in the settings directory', () => {
  // The user plugin directory is `<configDir>/plugins`, which `createRuntime`
  // hands the host as `userDir` — the path a plugin installed through the app
  // ends up in, and the only path a third-party plugin ever takes. Everything
  // above trusts `plugins/aec-review`, which lives inside the workspace; these
  // two cases are what separate "a bundled plugin loads" from "a plugin loads".

  it('is a plugin the host can load — same host, same child entry, same capabilities', async () => {
    // The control. This host differs from the one `createRuntime` builds in
    // exactly one thing: it takes plugin-host's own `forkPluginSpawn` instead
    // of the fork runtime.ts writes by hand. If this passes and the next case
    // fails, the fixture is not the variable.
    const dir = await tempDir();
    await writeUserPlugin(dir);

    const host = track(
      createPluginHost({
        userDir: join(dir, 'plugins'),
        childEntry: pluginChildEntry(),
        spawn: forkPluginSpawn,
        consent: { [FIXTURE_PLUGIN_ID]: { enabled: true, permissions: FIXTURE_PLUGIN_PERMISSIONS } },
        capabilities: {
          assets: createMemoryAssetStore(),
          ai: createAiGateway({ config: defaultAiConfig(), secrets: cliSecrets }),
          secrets: cliStrictSecrets,
        },
      }),
    );

    const fixture = (await host.discover()).find((p) => p.id === FIXTURE_PLUGIN_ID);

    expect(fixture?.state).toBe('loaded');
    expect(fixture?.nodeTypes).toEqual([FIXTURE_PLUGIN_NODE_TYPE]);
  });

  // -------------------------------------------------------------------------
  // KNOWN DEFECT — this case fails today.
  //
  // runtime.ts passes `execArgv: ['--import', 'tsx']` to `fork`, and Node
  // resolves a bare `--import` specifier against the child's *cwd*. The host
  // sets that cwd to the plugin's own directory, so the lookup only finds
  // `tsx` for plugins that happen to sit inside this workspace. A plugin under
  // `<configDir>/plugins` — every plugin a user ever installs — dies at
  // startup with ERR_MODULE_NOT_FOUND before its entry is imported, and the
  // operator is told "exited during startup (exit code 1)".
  //
  // plugin-host's `forkPluginSpawn` already solves this: it resolves
  // `tsx/esm` from the child ENTRY and passes an absolute file URL. The fix is
  // to use it, or to resolve the loader the same way. Do not relax this test:
  // the control above proves the fixture loads under the correct spawn.
  // -------------------------------------------------------------------------

  it('loads under --trust-plugin, and registers its node type', async () => {
    const dir = await tempDir();
    await writeUserPlugin(dir);

    const captured = captureConsole();
    let fixture;
    let registered: string[] = [];
    try {
      const rt = track(await createRuntime({ configDir: dir, trustPlugins: [FIXTURE_PLUGIN_ID] }));
      fixture = rt.plugins?.list().find((p) => p.id === FIXTURE_PLUGIN_ID);
      registered = rt.registry.manifests().map((m) => m.type);
    } finally {
      captured.restore();
    }

    expect(fixture?.error).toBeUndefined();
    expect(fixture?.state).toBe('loaded');
    expect(fixture?.nodeTypes).toEqual([FIXTURE_PLUGIN_NODE_TYPE]);
    expect(registered).toContain(FIXTURE_PLUGIN_NODE_TYPE);
  });
});
