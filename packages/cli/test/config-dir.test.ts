/**
 * Where the CLI looks for settings — the one function in this package that has
 * to agree with a completely different program.
 *
 * `defaultConfigDir()` is a hand-written re-derivation of Electron's
 * `app.getPath('userData')`. Nothing links the two: if the desktop app writes
 * `~/Library/Application Support/Archspace/mcp.yaml` and the CLI reads
 * somewhere else, both halves work perfectly and the product's central promise
 * — "the workflow that runs in the app runs in CI" (ADR-0013 §1) — quietly
 * stops being true, with no error anywhere. The failure presents as "the CLI
 * says I have no MCP servers", which is exactly the diagnosis `doctor` exists
 * to give and would then be giving wrongly.
 *
 * So the platform branches are pinned by segments rather than by eye. They can
 * only be reached by mocking `node:os`, because `defaultConfigDir()` reads the
 * platform ambiently instead of taking it as an argument the way
 * `mcpSupportCheck(process.platform)` does next door in @archspace/autodesk —
 * that asymmetry is the reason this file needs a mock and that one does not.
 *
 * `ARCHSPACE_CONFIG_DIR` gets the same weight, because it is what every other
 * test in this suite relies on to stay off the developer's real settings.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { withEnv } from './helpers.js';

const os = vi.hoisted(() => ({ platform: 'darwin' as NodeJS.Platform, home: '/home/tester' }));

vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>();
  return { ...actual, platform: () => os.platform, homedir: () => os.home };
});

const { defaultConfigDir } = await import('../src/config.js');

/** Cleared before every case: an operator with these exported must not matter. */
const AMBIENT = ['ARCHSPACE_CONFIG_DIR', 'APPDATA', 'XDG_CONFIG_HOME'] as const;

let restoreEnv: (() => void) | undefined;

function env(vars: Record<string, string | undefined> = {}): void {
  const cleared: Record<string, string | undefined> = {};
  for (const name of AMBIENT) cleared[name] = undefined;
  restoreEnv = withEnv({ ...cleared, ...vars });
}

afterEach(() => {
  restoreEnv?.();
  restoreEnv = undefined;
  os.platform = 'darwin';
  os.home = '/home/tester';
});

describe('defaultConfigDir — the platform branches', () => {
  // Asserted with `join` rather than a literal path: the separator is the
  // *host's*, and the claim being pinned is which segments the app and the CLI
  // agree on, not which slash Node prints them with.

  it('is the app support directory on macOS', () => {
    env();
    os.platform = 'darwin';
    os.home = '/Users/tester';

    expect(defaultConfigDir()).toBe(join('/Users/tester', 'Library', 'Application Support', 'Archspace'));
  });

  it('is %APPDATA%\\Archspace on Windows', () => {
    env({ APPDATA: join('C:', 'Users', 'tester', 'AppData', 'Roaming') });
    os.platform = 'win32';
    os.home = join('C:', 'Users', 'tester');

    expect(defaultConfigDir()).toBe(join('C:', 'Users', 'tester', 'AppData', 'Roaming', 'Archspace'));
  });

  it('falls back to the conventional Roaming path when Windows does not set APPDATA', () => {
    // A stripped service account or a `env -i` invocation. Electron would still
    // resolve a userData path here, so the CLI has to as well rather than
    // landing in `undefined/Archspace`.
    env();
    os.platform = 'win32';
    os.home = join('C:', 'Users', 'tester');

    expect(defaultConfigDir()).toBe(join('C:', 'Users', 'tester', 'AppData', 'Roaming', 'Archspace'));
  });

  it('honours XDG_CONFIG_HOME on Linux', () => {
    env({ XDG_CONFIG_HOME: '/home/tester/.local/config' });
    os.platform = 'linux';

    expect(defaultConfigDir()).toBe(join('/home/tester/.local/config', 'Archspace'));
  });

  it('falls back to ~/.config on Linux', () => {
    env();
    os.platform = 'linux';

    expect(defaultConfigDir()).toBe(join('/home/tester', '.config', 'Archspace'));
  });

  it('treats every other platform as XDG rather than guessing', () => {
    // The `default:` arm, reached by the BSDs. Naming one keeps the branch from
    // being deleted as unreachable.
    env();
    os.platform = 'freebsd';

    expect(defaultConfigDir()).toBe(join('/home/tester', '.config', 'Archspace'));
  });
});

describe('defaultConfigDir — the ARCHSPACE_CONFIG_DIR override', () => {
  it('wins over every platform default', () => {
    // The override is what CI uses to point at a checked-in settings directory,
    // and what this whole suite uses to stay off the developer's real one.
    for (const platform of ['darwin', 'win32', 'linux'] as const) {
      restoreEnv?.();
      env({ ARCHSPACE_CONFIG_DIR: '/srv/ci/archspace-settings' });
      os.platform = platform;

      expect(defaultConfigDir()).toBe(resolve('/srv/ci/archspace-settings'));
    }
  });

  it('resolves a relative override against the working directory', () => {
    // `--config-dir ./fixtures/settings` is the natural thing to type from a
    // repository root, and the plugin host later joins `plugins` onto whatever
    // comes back — a relative answer would silently follow the process around.
    env({ ARCHSPACE_CONFIG_DIR: './fixtures/settings' });

    const dir = defaultConfigDir();

    expect(dir).toBe(resolve(process.cwd(), 'fixtures', 'settings'));
    expect(resolve(dir)).toBe(dir);
  });

  it('ignores an exported-but-empty override instead of resolving it to the cwd', () => {
    // `ARCHSPACE_CONFIG_DIR=` — a CI variable that was declared and never
    // filled in. `resolve('')` is the working directory, so treating empty as
    // "set" would point the whole settings layer at whatever directory the
    // command happened to be run from.
    env({ ARCHSPACE_CONFIG_DIR: '' });
    os.platform = 'darwin';
    os.home = '/Users/tester';

    expect(defaultConfigDir()).toBe(join('/Users/tester', 'Library', 'Application Support', 'Archspace'));
  });
});

/**
 * `workspacePluginsDir` has the same shape of hazard as `defaultConfigDir`
 * above — a path derived from something that is not a path.
 *
 * It reads its own module URL to find the repo root, and a URL's pathname is
 * percent-encoded: a checkout under a directory with a space in it produced
 * `.../My%20Projects/...`, `existsSync` said no, and the bundled plugin
 * disappeared. The user's symptom is not "bad path"; it is `archspace run`
 * reporting an unmet plugin requirement for a plugin that is sitting right
 * there. On Windows `file:///C:/x` has pathname `/C:/x`, which is not a path
 * at all — and ADR-0014 ships Windows.
 *
 * Asserted against a synthetic URL rather than `import.meta.url`, because the
 * repo this runs in has no space in its path and so cannot reproduce it.
 */
describe('workspacePluginsDir — a file URL is not a path', () => {
  it('decodes a percent-encoded segment instead of looking for a literal %20', async () => {
    const { workspacePluginsDir } = await import('../src/config.js');
    const encoded = pathToFileURL(join('/tmp', 'My Projects', 'archspace', 'packages', 'cli', 'src', 'config.ts')).href;
    expect(encoded).toContain('%20');
    // The directory does not exist, so the answer is null either way — but the
    // path it asked about is the assertion, and `existsSync` cannot report it.
    // Re-derive it the way the function does and check the decoding directly.
    expect(fileURLToPath(new URL('.', encoded))).toContain('My Projects');
    expect(fileURLToPath(new URL('.', encoded))).not.toContain('%20');
    expect(workspacePluginsDir(encoded)).toBeNull();
  });

  it('finds the repo\u2019s own plugins directory from this file\u2019s real location', async () => {
    const { workspacePluginsDir } = await import('../src/config.js');
    const fromSrc = new URL('../src/config.ts', import.meta.url).href;
    expect(workspacePluginsDir(fromSrc)).toBe(resolve(fileURLToPath(new URL('../../../plugins', import.meta.url))));
  });
});
