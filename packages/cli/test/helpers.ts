/**
 * Fixtures for the CLI suite.
 *
 * ADR-0013 §1 makes `archspace run` a user feature and the integration harness
 * at the same time, so this suite drives the real loader, the real plugin host
 * and — for the run command — a real child process. Two constraints follow from
 * that, and both are enforced here rather than remembered in every test:
 *
 *   **Never the developer's own settings.** On the machine running these tests
 *   `defaultConfigDir()` resolves to a directory that already holds someone's
 *   real MCP bindings and plugin consent. Every config directory a test sees
 *   comes from `tempDir()`, and `childEnv()` strips `ARCHSPACE_*` out of the
 *   spawned CLI's environment so that an operator who happens to have
 *   `ARCHSPACE_CONFIG_DIR` exported cannot redirect this suite at their own
 *   settings — nor a future test at their own secrets.
 *
 *   **Never the network** (ADR-0013 §5, §6). Nothing here binds an MCP server
 *   or an AI profile to a reachable endpoint. The workflow fixtures run on
 *   `aec.*` core nodes, which are pure CPU and deterministic by construction.
 *
 * `runCli` collects the child's transcript through a *file* rather than a pipe,
 * which is not fussiness. `index.ts` ends in `process.exit(code)`, and on macOS
 * a piped stdout is asynchronous — the last lines written before an exit can be
 * dropped. A file-backed stdout is synchronous on POSIX, so the transcript a
 * test asserts against is the whole transcript on every run rather than most of
 * it on most runs.
 */
import { mkdtemp, mkdir, open, readFile, rm, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { vi } from 'vitest';

const roots: string[] = [];

/** A throwaway directory, removed by `cleanupTempDirs()`. */
export async function tempDir(files: Record<string, string> = {}): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'archspace-cli-'));
  roots.push(dir);
  for (const [relative, contents] of Object.entries(files)) {
    const path = join(dir, relative);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, contents);
  }
  return dir;
}

export async function cleanupTempDirs(): Promise<void> {
  await Promise.all(roots.splice(0).map((dir) => rm(dir, { recursive: true, force: true }).catch(() => undefined)));
}

// ---------------------------------------------------------------------------
// Anything holding a process open
// ---------------------------------------------------------------------------

/** Structural, so this file never has to import the runtime it is closing. */
export interface Closeable {
  close(): Promise<void>;
}

const opened: Closeable[] = [];

/**
 * Register a runtime (or a bare plugin host) for teardown.
 *
 * Not optional bookkeeping: a `Runtime` owns forked plugin children and, once
 * an MCP server is dialled, stdio children too. One leaked runtime keeps the
 * vitest worker's event loop alive and turns an unrelated failure elsewhere in
 * the suite into a hang with no output.
 */
export function track<T extends Closeable>(closeable: T): T {
  opened.push(closeable);
  return closeable;
}

export async function closeTracked(): Promise<void> {
  await Promise.all(opened.splice(0).map((c) => c.close().catch(() => undefined)));
}

// ---------------------------------------------------------------------------
// Environment
// ---------------------------------------------------------------------------

/**
 * Set (or, with `undefined`, unset) environment variables and hand back the
 * undo. Used rather than `vi.stubEnv` because several of these tests care about
 * the difference between "absent" and "present but empty", and a helper that
 * spells both out at the call site is the one that makes those tests readable.
 */
export function withEnv(vars: Record<string, string | undefined>): () => void {
  const previous = new Map<string, string | undefined>();
  for (const [name, value] of Object.entries(vars)) {
    previous.set(name, process.env[name]);
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  return () => {
    for (const [name, value] of previous) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  };
}

/** Every `ARCHSPACE_*` variable currently exported, mapped to `undefined`. */
export function archspaceEnvOverrides(): Record<string, undefined> {
  const cleared: Record<string, undefined> = {};
  for (const name of Object.keys(process.env)) {
    if (name.startsWith('ARCHSPACE_')) cleared[name] = undefined;
  }
  return cleared;
}

// ---------------------------------------------------------------------------
// Console capture
// ---------------------------------------------------------------------------

export interface ConsoleCapture {
  /** Everything written, in order, whichever level wrote it. */
  lines: string[];
  restore(): void;
}

/**
 * Capture what the runtime prints.
 *
 * `--trust-plugin` deliberately writes its grant with `console.log` rather than
 * through the host log, because the host log swallows info unless `--verbose`
 * (runtime.ts). That printed line *is* the security-visible surface of a
 * headless consent decision, so it needs to be assertable.
 */
export function captureConsole(): ConsoleCapture {
  const lines: string[] = [];
  for (const level of ['log', 'warn', 'error', 'info', 'debug'] as const) {
    vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
      lines.push(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '));
    });
  }
  return { lines, restore: () => vi.restoreAllMocks() };
}

// ---------------------------------------------------------------------------
// Plugin fixtures
// ---------------------------------------------------------------------------

/** The node this fixture plugin reports on startup; asserted by type id. */
export const FIXTURE_PLUGIN_NODE_TYPE = 'perm.fixture.noop';

/**
 * A plugin that declares two permissions of *different shapes* — the coarse
 * `net` and the key-scoped `secrets:<key>` — because "granted exactly what the
 * manifest declares" is only a meaningful assertion against a manifest that
 * declares more than nothing. `plugins/aec-review` declares none at all, so on
 * its own it cannot tell an exact grant apart from a blanket one.
 */
export const FIXTURE_PLUGIN_ID = 'perm-fixture';
export const FIXTURE_PLUGIN_PERMISSIONS = ['net', 'secrets:acme_api_key'];

const FIXTURE_PLUGIN_ENTRY = `export default [
  {
    manifest: {
      type: '${FIXTURE_PLUGIN_NODE_TYPE}',
      version: 1,
      label: 'Fixture Noop',
      description: 'Reports one node so the host has something to register.',
      category: 'test',
      params: { type: 'object', properties: {} },
      inputs: [],
      outputs: [{ id: 'out', type: 'text' }],
      caching: 'never',
    },
    async execute() {
      return { out: 'ok' };
    },
  },
];
`;

/**
 * Write the fixture plugin into the *user* plugin directory of a config dir —
 * `<configDir>/plugins/<id>`, which is exactly the path `createRuntime` hands
 * the plugin host as `userDir`.
 */
export async function writeUserPlugin(configDir: string, id = FIXTURE_PLUGIN_ID): Promise<string> {
  const dir = join(configDir, 'plugins', id);
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, 'archspace-plugin.json'),
    `${JSON.stringify(
      {
        name: id,
        version: '1.0.0',
        namespace: 'perm.fixture',
        displayName: 'Permission Fixture',
        engineApi: 1,
        entry: 'index.mjs',
        permissions: FIXTURE_PLUGIN_PERMISSIONS,
      },
      null,
      2,
    )}\n`,
  );
  await writeFile(join(dir, 'index.mjs'), FIXTURE_PLUGIN_ENTRY);
  return dir;
}

/** The plugin child entry `createRuntime` forks, resolved the same way it is. */
export function pluginChildEntry(): string {
  return fileURLToPath(new URL('../../plugin-host/src/child.ts', import.meta.url));
}

// ---------------------------------------------------------------------------
// Workflow fixtures
// ---------------------------------------------------------------------------

export interface WorkflowNode {
  id: string;
  type: string;
}

export interface WorkflowRequires {
  mcp?: string[];
  ai?: string[];
  plugins?: string[];
}

/**
 * A minimal but *canonical* workflow document: the same key order and the same
 * generated `requires:`/`layout:` blocks `saveWorkflow` emits, so a fixture
 * never fails for a reason the parser would also raise against a real file.
 */
export function workflowYaml(name: string, nodes: WorkflowNode[], requires: WorkflowRequires = {}): string {
  const list = (values: string[] | undefined): string => `[${(values ?? []).join(', ')}]`;
  const nodeBlock = nodes
    .map((n) => `  - id: ${n.id}\n    type: ${n.type}\n    version: 1\n    config: {}`)
    .join('\n');
  const layoutBlock = nodes.map((n, i) => `  ${n.id}: { x: ${120 + i * 180}, y: 240 }`).join('\n');
  return [
    'archspace: 1',
    'kind: workflow',
    'meta:',
    `  name: ${name}`,
    '',
    'requires:',
    `  mcp: ${list(requires.mcp)}`,
    `  ai: ${list(requires.ai)}`,
    `  plugins: ${list(requires.plugins)}`,
    '',
    'nodes:',
    nodeBlock,
    '',
    'edges: []',
    '',
    'layout:',
    layoutBlock,
    '',
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Driving the CLI as a process
// ---------------------------------------------------------------------------

export interface CliResult {
  code: number;
  /** stdout and stderr interleaved, as an operator would see them. */
  output: string;
}

const cliEntry = fileURLToPath(new URL('../src/index.ts', import.meta.url));

/**
 * The TypeScript loader, resolved from the CLI entry rather than named as a
 * bare specifier. Node resolves a bare `--import` specifier against the child's
 * *cwd*, which is not where this package's dependencies live; resolving from
 * the entry is what `forkPluginSpawn` does for the same reason.
 */
const tsLoader = pathToFileURL(createRequire(pathToFileURL(cliEntry)).resolve('tsx/esm')).href;

/** Run `archspace <args>` as a real process and return its exit code and transcript. */
export async function runCli(args: string[]): Promise<CliResult> {
  const workDir = await tempDir();
  const transcript = join(workDir, 'transcript.log');
  const handle = await open(transcript, 'w');
  try {
    const child = spawn(process.execPath, ['--import', tsLoader, cliEntry, ...args], {
      cwd: workDir,
      // Both streams into one descriptor: the CLI splits diagnostics across
      // stdout and stderr, and an assertion about ordering ("the failure is
      // reported *instead of* a run, not after one") needs them interleaved.
      stdio: ['ignore', handle.fd, handle.fd],
      env: { ...process.env, ...archspaceEnvOverrides() },
    });
    const code = await new Promise<number>((resolve, reject) => {
      child.on('error', reject);
      child.on('exit', (status, signal) => resolve(status ?? (signal === null ? -1 : -2)));
    });
    return { code, output: await readFile(transcript, 'utf8') };
  } finally {
    await handle.close();
  }
}
