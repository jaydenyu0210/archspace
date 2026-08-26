/**
 * The permission model, from both sides of the wire (ARCHITECTURE §8.2,
 * ADR-0008 §2, and §16's M6 gate verbatim: *"undeclared-network attempt
 * fails"*).
 *
 * Why every case is tested twice — once through `ctx`, once by a plugin that
 * hand-writes the RPC message `ctx` would have sent: the child refuses first
 * (§8.1 — `ctx.fetch` is *absent*, not disabled, and `ctx.secrets.get` names
 * the declaration the author forgot), which is an author-experience feature,
 * not a security control. It runs inside the untrusted process, so it is
 * advice, and a plugin can simply not take it — `process.send` is right there
 * (ADR-0008 §3's honesty clause: nothing revokes `node:*` inside a plugin).
 * The decision that actually holds is the host's, in `serviceFor`. A suite that
 * only drove `ctx` would prove the polite half and leave the enforcing half
 * uncovered, which is the wrong half to guess about.
 *
 * `fetchCalls` on the stub host is the load-bearing negative assertion
 * throughout: the host always *has* a fetch implementation here, so a refusal
 * has to come from the permission check rather than from a missing capability,
 * and an empty `fetchCalls` is the proof that nothing reached the wire. The
 * implementation only ever returns canned bytes and never opens a socket
 * (ADR-0013: no live network in the blocking lanes).
 */
import { afterEach, describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { runNode } from '@archspace/node-sdk/testkit';
import type { NodeModule } from '@archspace/node-sdk';
import { createPluginHost, type PluginHost } from '../src/index.js';
import { cleanupTempDirs, tempDir, writePluginDir } from './helpers.js';
import { CHILD_ENTRY, stubCapabilities, type StubCapabilities } from './host-fixtures.js';

const MANIFEST_HELPER = `const manifest = (type) => ({
  type,
  version: 1,
  label: type,
  description: 'permission fixture',
  category: 'test',
  params: { type: 'object', properties: {} },
  inputs: [],
  outputs: [{ id: 'out', type: 'text' }],
  caching: 'never',
});
`;

/**
 * A plugin that reaches around its own `NodeContext` and speaks the host
 * protocol itself. This is not a contrived attack: it is three lines any
 * plugin author can write, which is exactly why the host cannot rely on the
 * child's checks. `id: 0` marks a call that belongs to no exec.
 */
const RAW_HOST_CALL = `let nextRawCallId = 9000;
function rawHostCall(method, args) {
  const callId = nextRawCallId++;
  return new Promise((resolve) => {
    const onMessage = (message) => {
      if (message && message.t === 'host-result' && message.callId === callId) {
        process.off('message', onMessage);
        resolve(message.ok ? 'ALLOWED: ' + JSON.stringify(message.value) : 'REFUSED: ' + message.error);
      }
    };
    process.on('message', onMessage);
    process.send({ t: 'host-call', callId, id: 0, method, args });
  });
}
`;

/** Declares no permissions at all, and tries the network anyway. */
const NO_NET_ENTRY =
  MANIFEST_HELPER +
  RAW_HOST_CALL +
  `export default [
  {
    manifest: manifest('fixture.plugin.probe_fetch'),
    async execute(ctx) {
      return { out: 'ctx.fetch is ' + typeof ctx.fetch };
    },
  },
  {
    manifest: manifest('fixture.plugin.call_fetch'),
    async execute(ctx) {
      const response = await ctx.fetch('https://plugins.test/data');
      return { out: 'reached the network: ' + response.status };
    },
  },
  {
    manifest: manifest('fixture.plugin.raw_fetch'),
    async execute() {
      return {
        out: await rawHostCall('fetch', { url: 'https://plugins.test/data', method: 'GET', headers: [] }),
      };
    },
  },
];
`;

/** Declares "net", and is granted it. */
const NET_ENTRY =
  MANIFEST_HELPER +
  `export default [
  {
    manifest: manifest('fixture.plugin.post'),
    async execute(ctx) {
      const response = await ctx.fetch('https://plugins.test/echo', {
        method: 'POST',
        headers: { 'x-plugin': 'yes' },
        body: 'ping',
      });
      return { out: response.status + ' ' + (await response.text()) };
    },
  },
];
`;

/** Declares exactly one secret key, and reaches for two. */
const SECRETS_ENTRY =
  MANIFEST_HELPER +
  RAW_HOST_CALL +
  `export default [
  {
    manifest: manifest('fixture.plugin.read_declared'),
    async execute(ctx) {
      return { out: await ctx.secrets.get('API_TOKEN') };
    },
  },
  {
    manifest: manifest('fixture.plugin.read_undeclared'),
    async execute(ctx) {
      return { out: await ctx.secrets.get('OTHER_TOKEN') };
    },
  },
  {
    manifest: manifest('fixture.plugin.raw_secret'),
    async execute() {
      return { out: await rawHostCall('secrets.get', { key: 'OTHER_TOKEN' }) };
    },
  },
];
`;

let host: PluginHost | undefined;

afterEach(async () => {
  await host?.close();
  host = undefined;
  await cleanupTempDirs();
});

interface LoadedFixture {
  modules: Map<string, NodeModule>;
  stub: StubCapabilities;
}

/** One fixture plugin, consented exactly as far as its manifest declares. */
async function load(entry: string, permissions: string[], stub: StubCapabilities): Promise<LoadedFixture> {
  const userDir = await tempDir();
  await writePluginDir(join(userDir, 'fixture-plugin'), { manifest: { permissions }, entry });

  host = createPluginHost({
    userDir,
    childEntry: CHILD_ENTRY,
    consent: { 'fixture-plugin': { enabled: true, permissions } },
    capabilities: stub.capabilities,
  });

  const [plugin] = await host.discover();
  expect(plugin.error).toBeUndefined();
  expect(plugin.state).toBe('loaded');
  expect(plugin.grantedPermissions).toEqual(permissions);

  return { modules: new Map(host.nodeModules().map((mod) => [mod.manifest.type, mod])), stub };
}

describe('the network permission — M6 gate: "undeclared-network attempt fails"', () => {
  it('is absent from ctx in the child, so the attempt fails before an RPC is even formed', async () => {
    const stub = stubCapabilities({ responses: { 'https://plugins.test/data': { body: 'secret' } } });
    const { modules } = await load(NO_NET_ENTRY, [], stub);

    // Absent, not disabled: a node cannot feature-detect its way around a
    // permission it was never granted (src/child.ts).
    const probe = await runNode(modules.get('fixture.plugin.probe_fetch')!);
    expect(probe.outputs.out).toBe('ctx.fetch is undefined');

    // …and calling it anyway is one failed node, not a request.
    await expect(runNode(modules.get('fixture.plugin.call_fetch')!)).rejects.toThrow(/ctx\.fetch is not a function/);
    expect(stub.fetchCalls).toEqual([]);
  }, 60_000);

  it('is refused by the host too, when a plugin hand-writes the RPC the child would not send', async () => {
    const stub = stubCapabilities({ responses: { 'https://plugins.test/data': { body: 'secret' } } });
    const { modules } = await load(NO_NET_ENTRY, [], stub);

    const run = await runNode(modules.get('fixture.plugin.raw_fetch')!);

    // The refusal reaches the plugin as a failed host-call, and it names the
    // missing declaration rather than the missing grant — the manifest is what
    // the author has to change.
    expect(run.outputs.out).toMatch(/^REFUSED: /);
    expect(run.outputs.out).toMatch(/does not declare the "net" permission/);
    expect(stub.fetchCalls).toEqual([]);
  }, 60_000);

  it('is performed by the host on the plugin’s behalf once declared and granted', async () => {
    const stub = stubCapabilities({
      responses: { 'https://plugins.test/echo': { status: 201, body: 'pong' } },
    });
    const { modules } = await load(NET_ENTRY, ['net'], stub);

    const run = await runNode(modules.get('fixture.plugin.post')!);

    // The response crossed back intact: status, and a body that travelled as
    // base64 because the IPC channel only guarantees JSON (src/protocol.ts).
    expect(run.outputs.out).toBe('201 pong');

    // And the request was made by the host — which is what makes it loggable
    // and revocable (the wording the consent sheet uses in describePermission).
    expect(stub.fetchCalls).toHaveLength(1);
    expect(stub.fetchCalls[0].url).toBe('https://plugins.test/echo');
    expect(stub.fetchCalls[0].method).toBe('POST');
    expect(stub.fetchCalls[0].body).toBe('ping');
    expect(stub.fetchCalls[0].headers['x-plugin']).toBe('yes');
  }, 60_000);
});

describe('secrets are granted one key at a time', () => {
  it('refuses an undeclared key in the child, naming the declaration the author forgot', async () => {
    const stub = stubCapabilities({ secrets: { API_TOKEN: 'tok_declared', OTHER_TOKEN: 'tok_undeclared' } });
    const { modules } = await load(SECRETS_ENTRY, ['secrets:API_TOKEN'], stub);

    await expect(runNode(modules.get('fixture.plugin.read_undeclared')!)).rejects.toThrow(
      /declare "secrets:OTHER_TOKEN" in its permissions/,
    );
    // The host was never asked, so the value was never read out of the
    // keychain — the refusal is not "fetched and discarded".
    expect(stub.secretReads).toEqual([]);
  }, 60_000);

  it('refuses an undeclared key at the host as well, over a hand-written RPC', async () => {
    const stub = stubCapabilities({ secrets: { API_TOKEN: 'tok_declared', OTHER_TOKEN: 'tok_undeclared' } });
    const { modules } = await load(SECRETS_ENTRY, ['secrets:API_TOKEN'], stub);

    const run = await runNode(modules.get('fixture.plugin.raw_secret')!);

    expect(run.outputs.out).toMatch(/^REFUSED: /);
    expect(run.outputs.out).toMatch(/does not declare the "secrets:OTHER_TOKEN" permission/);
    expect(run.outputs.out).not.toContain('tok_undeclared');
    expect(stub.secretReads).toEqual([]);
  }, 60_000);

  it('delivers the one key that was declared and granted', async () => {
    const stub = stubCapabilities({ secrets: { API_TOKEN: 'tok_declared', OTHER_TOKEN: 'tok_undeclared' } });
    const { modules } = await load(SECRETS_ENTRY, ['secrets:API_TOKEN'], stub);

    const run = await runNode(modules.get('fixture.plugin.read_declared')!);

    expect(run.outputs.out).toBe('tok_declared');
    expect(stub.secretReads).toEqual(['API_TOKEN']);
  }, 60_000);
});
