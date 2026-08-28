/**
 * The plugin process as untrusted input (ARCHITECTURE §8, ADR-0008 §2).
 *
 * Two claims this package makes in its own words, and did not keep:
 *
 *  1. `describePermission` tells a user consenting to `secrets:<key>` that
 *     "no other secret is reachable". The host spawned every plugin with a
 *     verbatim copy of `process.env`, so under the CLI's env-var secret
 *     provider a plugin was *handed* every secret on the machine before it ran
 *     a line. ADR-0008's honesty clause concedes a plugin could go and read a
 *     file; it does not license the host to deliver the values unasked.
 *  2. `isChildToHost`'s own comment says "never destructure a message before
 *     this has said it is one of ours" — and it checked only the tag. A
 *     `ready` message without `manifests` therefore threw a TypeError inside a
 *     `message` listener, which is an uncaught exception in the engine child:
 *     one malformed line from a plugin killing the process whose entire job is
 *     to survive that plugin.
 *
 * The env test uses a real forked child for the same reason
 * `crash-containment.test.ts` does — the claim is about what an OS process
 * inherits, and only an OS process can answer it. The message tests are unit
 * tests against the narrowing function, because the shapes under test are ones
 * a well-behaved child can never produce, so constructing them through the real
 * SDK would mean breaking the SDK to test the host.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { createMemoryAssetStore, type AiGateway } from '@archspace/node-sdk';
import { runNode } from '@archspace/node-sdk/testkit';
import {
  SECRET_ENV_PREFIX,
  createPluginHost,
  isChildToHost,
  pluginChildEnv,
  type HostCapabilities,
  type PluginHost,
} from '../src/index.js';
import { CHILD_ENTRY } from './host-fixtures.js';
import { cleanupTempDirs, tempDir, writePluginDir } from './helpers.js';

/** A node that reports what its own process inherited. It declares no
 *  permissions at all, which is the point: this is the floor, not a leak past
 *  a grant. */
const SNITCH_ENTRY = `export default [
  {
    manifest: {
      type: 'snitch.test.env',
      version: 1,
      label: 'env',
      description: 'reports the environment this process inherited',
      category: 'test',
      params: { type: 'object', properties: {} },
      inputs: [],
      outputs: [
        { id: 'secret_names', type: 'json' },
        { id: 'saw_ordinary_var', type: 'boolean' },
      ],
      caching: 'never',
    },
    async execute() {
      return {
        secret_names: Object.keys(process.env).filter((k) => k.startsWith('ARCHSPACE_SECRET_')),
        saw_ordinary_var: process.env.ARCHSPACE_TEST_ORDINARY === 'kept',
      };
    },
  },
];
`;

function stubCapabilities(): HostCapabilities {
  const unreachable = (name: string) => (): never => {
    throw new Error(`this fixture must not reach ${name}`);
  };
  return {
    assets: createMemoryAssetStore(),
    ai: {
      generateText: unreachable('ctx.ai.generateText'),
      generateObject: unreachable('ctx.ai.generateObject'),
      embed: unreachable('ctx.ai.embed'),
    } satisfies AiGateway,
    secrets: { get: unreachable('ctx.secrets.get') },
  };
}

let host: PluginHost | undefined;

afterEach(async () => {
  await host?.close();
  host = undefined;
  delete process.env[`${SECRET_ENV_PREFIX}ARCHSPACE_TEST_KEY`];
  delete process.env.ARCHSPACE_TEST_ORDINARY;
  await cleanupTempDirs();
});

describe('what a plugin process inherits', () => {
  it('is not handed the secret namespace, and keeps everything else', async () => {
    // Set on the *host* process, exactly as `archspace run` documents
    // (`export ARCHSPACE_SECRET_ACME_API_KEY=…`).
    process.env[`${SECRET_ENV_PREFIX}ARCHSPACE_TEST_KEY`] = 'the-value-a-plugin-must-not-be-given';
    process.env.ARCHSPACE_TEST_ORDINARY = 'kept';

    const userDir = await tempDir();
    await writePluginDir(join(userDir, 'snitch-plugin'), {
      manifest: { name: 'snitch-plugin', namespace: 'snitch.test', displayName: 'Snitch Fixture' },
      entry: SNITCH_ENTRY,
    });

    host = createPluginHost({
      userDir,
      childEntry: CHILD_ENTRY,
      consent: { 'snitch-plugin': { enabled: true, permissions: [] } },
      capabilities: stubCapabilities(),
    });

    const [plugin] = await host.discover();
    expect(plugin.state).toBe('loaded');

    const mod = host.nodeModules().find((m) => m.manifest.type === 'snitch.test.env')!;
    const { outputs } = await runNode(mod);

    expect(outputs.secret_names).toEqual([]);
    // The subtraction is surgical, not a curated environment: a plugin that
    // needs PATH or a proxy variable still gets it (see `pluginChildEnv`).
    expect(outputs.saw_ordinary_var).toBe(true);
  }, 60_000);
});

describe('pluginChildEnv', () => {
  it('drops every key in the secret namespace and nothing else', () => {
    const env = pluginChildEnv({
      PATH: '/usr/bin',
      [`${SECRET_ENV_PREFIX}A`]: 'a',
      [`${SECRET_ENV_PREFIX}B_C`]: 'b',
      ARCHSPACE_PLUGIN_ID: 'x',
      ARCHSPACE_SECRETS: 'not in the namespace — no trailing underscore',
    });
    expect(Object.keys(env).sort()).toEqual(['ARCHSPACE_PLUGIN_ID', 'ARCHSPACE_SECRETS', 'PATH']);
  });

  it('omits unset variables rather than writing "undefined"', () => {
    expect(pluginChildEnv({ SET: 'yes', UNSET: undefined })).toEqual({ SET: 'yes' });
  });
});

describe('isChildToHost — shape, not just tag', () => {
  const manifest = {
    type: 'x.y.z',
    version: 1,
    label: 'Z',
    description: '',
    category: 'test',
    params: { type: 'object', properties: {} },
    inputs: [],
    outputs: [],
    caching: 'never',
  };

  it('accepts the messages a well-behaved child sends', () => {
    expect(isChildToHost({ t: 'ready', v: 1, manifests: [manifest] })).toBe(true);
    expect(isChildToHost({ t: 'ready', v: 1, manifests: [] })).toBe(true);
    expect(isChildToHost({ t: 'load-error', message: 'boom' })).toBe(true);
    expect(isChildToHost({ t: 'log', id: 1, level: 'warn', message: 'hi' })).toBe(true);
    expect(isChildToHost({ t: 'progress', id: 1 })).toBe(true);
    expect(isChildToHost({ t: 'progress', id: 1, fraction: 0.5, message: 'half' })).toBe(true);
    expect(isChildToHost({ t: 'host-call', callId: 1, id: 1, method: 'secrets.get', args: { key: 'k' } })).toBe(true);
    expect(isChildToHost({ t: 'result', id: 1, outputs: {} })).toBe(true);
    expect(isChildToHost({ t: 'error', id: 1, message: 'no', retryable: false })).toBe(true);
    expect(isChildToHost({ t: 'error', id: 1, message: 'no', retryable: true, cancelled: true })).toBe(true);
  });

  it('rejects a ready message the host would have dereferenced and died on', () => {
    // The exact regression: `raw.manifests.find(…)` on a message with no
    // `manifests`. Before the shape check this returned true.
    expect(isChildToHost({ t: 'ready', v: 1 })).toBe(false);
    expect(isChildToHost({ t: 'ready', v: 1, manifests: 'not-an-array' })).toBe(false);
    expect(isChildToHost({ t: 'ready', v: 1, manifests: [null] })).toBe(false);
    expect(isChildToHost({ t: 'ready', v: 1, manifests: [{ type: 42 }] })).toBe(false);
    expect(isChildToHost({ t: 'ready', v: 1, manifests: [{ ...manifest, inputs: 'nope' }] })).toBe(false);
    expect(isChildToHost({ t: 'ready', manifests: [] })).toBe(false);
  });

  it('rejects malformed variants of every other tag', () => {
    expect(isChildToHost({ t: 'load-error' })).toBe(false);
    expect(isChildToHost({ t: 'log', id: 1, level: 'shout', message: 'hi' })).toBe(false);
    expect(isChildToHost({ t: 'log', id: 'one', level: 'warn', message: 'hi' })).toBe(false);
    expect(isChildToHost({ t: 'progress', id: 1, fraction: 'half' })).toBe(false);
    expect(isChildToHost({ t: 'host-call', callId: 1, id: 1, method: 'fs.readFile' })).toBe(false);
    expect(isChildToHost({ t: 'result', id: 1, outputs: [] })).toBe(false);
    expect(isChildToHost({ t: 'result', id: 1 })).toBe(false);
    expect(isChildToHost({ t: 'error', id: 1, message: 'no' })).toBe(false);
    expect(isChildToHost({ t: 'error', id: 1, message: 'no', retryable: 'yes' })).toBe(false);
  });

  it('still rejects what it always rejected', () => {
    expect(isChildToHost(null)).toBe(false);
    expect(isChildToHost('ready')).toBe(false);
    expect(isChildToHost([{ t: 'ready', v: 1, manifests: [] }])).toBe(false);
    expect(isChildToHost({ t: 'init', v: 1 })).toBe(false);
    expect(isChildToHost({})).toBe(false);
  });

  it('refuses NaN where a number is required, because NaN survives typeof', () => {
    expect(isChildToHost({ t: 'result', id: NaN, outputs: {} })).toBe(false);
    expect(isChildToHost({ t: 'ready', v: NaN, manifests: [] })).toBe(false);
  });
});
