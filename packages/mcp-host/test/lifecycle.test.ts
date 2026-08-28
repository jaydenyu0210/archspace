/**
 * Connection lifecycle, and the status the settings panel renders
 * (ARCHITECTURE §9.2 / ADR-0009 decision 2, ADR-0013 §5).
 *
 * `nodes.test.ts` pins what a tool *becomes*; this file pins **when the host
 * goes to the wire and what it says about having gone there**. Both halves were
 * named deliverables and only the first had tests, which is how the expensive
 * mistakes in this file stay invisible: they are all mistakes of timing, and a
 * mistake of timing looks exactly like working code from the outside.
 *
 * The invariants worth the fixture, each one a judgement `host.ts` states in
 * its header and could silently lose:
 *
 *   - **Lazy connect.** `configure()` must not dial. An eager version spawns
 *     every stdio child at boot and pops an OAuth window before the user has
 *     asked for anything, and no assertion about the *result* of connecting
 *     would notice. `FakeServer.dials` is the whole test: it counts trips to
 *     the wire, so "did not dial" is assertable rather than hoped.
 *   - **One dial per demand.** Three simultaneous callers must share one
 *     session; the second session would be an orphaned stdio child.
 *   - **A drop keeps the nodes.** A two-second server crash must not delete
 *     node types out from under a canvas; it returns to `idle` and the next
 *     call re-dials.
 *   - **`refresh()` flags drift, never absorbs it** (ADR-0009 §5) — the pinned
 *     manifest stays pinned even as the live hash moves.
 *   - **The status is the UI's whole truth.** It crosses a `MessagePort` to the
 *     sandboxed renderer, so it must be structured-clone-safe, and a failure
 *     must arrive with the reason a user can act on — "sign in" and "install a
 *     binary" are different buttons.
 *
 * Everything runs over `InMemoryTransport` through the `createTransport` seam:
 * no processes, no sockets, no network (ADR-0013 §5, §6).
 */
import { describe, expect, it } from 'vitest';
import { createMemoryAssetStore } from '@archspace/node-sdk';
import { runNode } from '@archspace/node-sdk/testkit';
import type { NodeModule } from '@archspace/node-sdk';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { createMcpHost, type McpConnectionState, type McpHost, type McpServerStatus } from '../src/index.js';
import { McpConnectionError } from '../src/errors.js';
import type { McpHttpBinding } from '../src/config.js';
import { echoTool, fakeServer, stdioConfig, textResult, transportFor, type FakeServer, type FakeTool } from './helpers.js';

function hostFor(servers: Record<string, FakeServer>, opts: Partial<Parameters<typeof createMcpHost>[0]> = {}): McpHost {
  return createMcpHost({ assets: createMemoryAssetStore(), createTransport: transportFor(servers), ...opts });
}

function statusOf(host: McpHost, name: string): McpServerStatus {
  const status = host.status(name);
  if (status === undefined) throw new Error(`no status for "${name}"`);
  return status;
}

function moduleOf(modules: NodeModule[], type: string): NodeModule {
  const mod = modules.find((m) => m.manifest.type === type);
  if (mod === undefined) throw new Error(`no generated node "${type}" in [${modules.map((m) => m.manifest.type).join(', ')}]`);
  return mod;
}

function httpBinding(overrides: Partial<Omit<McpHttpBinding, 'transport'>> = {}): McpHttpBinding {
  return { transport: 'http', url: 'https://revit-agent.office.example:8443/mcp', ...overrides };
}

/** A tool whose schema a test can move under a live connection (§9.3 drift). */
function schemaTool(name: string, properties: Record<string, unknown>): FakeTool {
  return { name, inputSchema: { type: 'object', properties }, handle: () => textResult('ok') };
}

interface Gate {
  promise: Promise<void>;
  open(): void;
}

function gate(): Gate {
  let open = (): void => undefined;
  const promise = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { promise, open: () => open() };
}

describe('lazy connect (ADR-0009 decision 2)', () => {
  it('records bindings without dialling, and dials on the first demand', async () => {
    const server = fakeServer({ tools: [echoTool()] });
    const host = hostFor({ formats: server });

    await host.configure({ servers: { formats: stdioConfig() } });

    // The resting state of a bound-but-never-used server. Not a problem, and
    // not a connection: an eager configure would have spawned the child here.
    expect(server.dials).toBe(0);
    expect(statusOf(host, 'formats').state).toBe<McpConnectionState>('idle');
    expect(statusOf(host, 'formats').toolCount).toBe(0);
    expect(host.nodeModules()).toEqual([]);

    await host.connect('formats');

    expect(server.dials).toBe(1);
    expect(statusOf(host, 'formats').state).toBe<McpConnectionState>('connected');
    expect(host.nodeModules().map((m) => m.manifest.type)).toEqual(['mcp.formats.echo']);
  });

  it('opens ONE session for concurrent demands on the same server', async () => {
    const server = fakeServer({ tools: [echoTool()] });
    const host = hostFor({ formats: server });
    await host.configure({ servers: { formats: stdioConfig() } });

    await Promise.all([host.connect('formats'), host.connect('formats'), host.connect('formats')]);

    // The in-flight dial is shared, so three callers cost one child process.
    // Without it the two losers become orphans nothing ever closes.
    expect(server.dials).toBe(1);
    expect(server.closed).toBe(0);
    expect(statusOf(host, 'formats').state).toBe<McpConnectionState>('connected');
  });

  it('is a no-op to connect a server that is already connected', async () => {
    const server = fakeServer({ tools: [echoTool()] });
    const host = hostFor({ formats: server });
    await host.configure({ servers: { formats: stdioConfig() } });

    await host.connect('formats');
    await host.connect('formats');

    expect(server.dials).toBe(1);
  });
});

describe('disconnect and reconnect', () => {
  it('disconnect ends the session and forgets the generated nodes; connecting again re-authors them', async () => {
    const server = fakeServer({ tools: [echoTool()] });
    const host = hostFor({ formats: server });
    await host.configure({ servers: { formats: stdioConfig() } });
    await host.connect('formats');

    await host.disconnect('formats');

    // A deliberate teardown, unlike a drop: the nodes go with the session.
    expect(server.closed).toBe(1);
    const idle = statusOf(host, 'formats');
    expect(idle.state).toBe<McpConnectionState>('idle');
    expect(idle.toolCount).toBe(0);
    expect(idle.tools).toEqual([]);
    expect(idle.error).toBeUndefined();
    expect(host.nodeModules()).toEqual([]);

    await host.connect('formats');

    expect(server.dials).toBe(2);
    expect(host.nodeModules().map((m) => m.manifest.type)).toEqual(['mcp.formats.echo']);
  });

  it('keeps the nodes when the server drops, and re-dials on the next call', async () => {
    const server = fakeServer({ tools: [echoTool()] });
    const assets = createMemoryAssetStore();
    const host = createMcpHost({ assets, createTransport: transportFor({ formats: server }) });
    await host.configure({ servers: { formats: stdioConfig() } });
    await host.connect('formats');
    const mod = moduleOf(host.nodeModules(), 'mcp.formats.echo');

    await server.dropAll();

    // Judgement 4 in host.ts: an unexpected close must not empty the palette —
    // a two-second stdio crash would otherwise delete node types a canvas is
    // already using. The record goes back to `idle` carrying an explanation.
    const dropped = statusOf(host, 'formats');
    expect(dropped.state).toBe<McpConnectionState>('idle');
    expect(dropped.error).toContain('closed the connection');
    expect(dropped.toolCount).toBe(1);
    expect(host.nodeModules().map((m) => m.manifest.type)).toEqual(['mcp.formats.echo']);

    // `idle` is exactly the state the next demand re-dials from.
    const result = await runNode(mod, { params: { message: 'still here' }, assets });

    expect(result.outputs.text).toBe('still here');
    expect(server.dials).toBe(2);
    const reconnected = statusOf(host, 'formats');
    expect(reconnected.state).toBe<McpConnectionState>('connected');
    // The stale explanation is cleared by the successful re-dial.
    expect(reconnected.error).toBeUndefined();
  });

  it('reports the failure and stays re-dialable when the reconnect itself fails', async () => {
    const server = fakeServer({ tools: [echoTool()] });
    let refuse = false;
    const host = hostFor(
      {},
      {
        createTransport: (): Promise<Transport> => {
          if (refuse) throw new Error('spawn uvx ENOENT');
          return server.open();
        },
      },
    );
    await host.configure({ servers: { formats: stdioConfig() } });
    await host.connect('formats');

    await server.dropAll();
    refuse = true;
    const failure = await host.connect('formats').catch((err: unknown) => err);

    expect(failure).toBeInstanceOf(McpConnectionError);
    const status = statusOf(host, 'formats');
    expect(status.state).toBe<McpConnectionState>('failed');
    // The real reason, not a generic one: the user needs to know it was ENOENT.
    expect(status.error).toContain('spawn uvx ENOENT');
    // Failed is not fatal — the authored nodes survive for the next attempt.
    expect(status.toolCount).toBe(1);

    refuse = false;
    await host.connect('formats');
    expect(statusOf(host, 'formats').state).toBe<McpConnectionState>('connected');
  });
});

describe('refresh re-reads tools/list without re-mapping (ADR-0009 §5)', () => {
  it('flags a changed tool schema as drift and leaves the pinned manifest alone', async () => {
    const server = fakeServer({ tools: [schemaTool('convert', { path: { type: 'string' } })] });
    const host = hostFor({ formats: server });
    await host.configure({ servers: { formats: stdioConfig() } });
    await host.connect('formats');
    const pinnedHash = statusOf(host, 'formats').tools[0].schemaHash;
    const pinnedParams = moduleOf(host.nodeModules(), 'mcp.formats.convert').manifest.params;

    // The server is upgraded under a live connection.
    server.tools[0] = schemaTool('convert', { path: { type: 'string' }, dialect: { type: 'string' } });
    await host.refresh('formats');

    // A refresh reads the surface; it does not redial.
    expect(server.dials).toBe(1);
    const status = statusOf(host, 'formats');
    expect(status.drift).toHaveLength(1);
    expect(status.drift[0]).toMatchObject({ tool: 'convert', nodeType: 'mcp.formats.convert', kind: 'changed', pinnedHash });
    expect(status.drift[0].liveHash).toBeDefined();
    expect(status.drift[0].liveHash).not.toBe(pinnedHash);
    expect(status.tools[0].drifted).toBe(true);

    // The node keeps the contract it was authored against — the workflow stays
    // the reviewable source of truth. Re-mapping here would change the ports
    // under nodes already on a canvas and never tell anyone.
    expect(statusOf(host, 'formats').tools[0].schemaHash).toBe(pinnedHash);
    expect(moduleOf(host.nodeModules(), 'mcp.formats.convert').manifest.params).toEqual(pinnedParams);
    // …while the live hash is published separately, which is what a document
    // compares its own pinned hash against.
    expect(host.toolSchemaHashes()['mcp.formats.convert']).toBe(status.drift[0].liveHash);
  });

  it('reports a vanished tool as drift and keeps its node type', async () => {
    const server = fakeServer({ tools: [schemaTool('convert', {}), echoTool()] });
    const host = hostFor({ formats: server });
    await host.configure({ servers: { formats: stdioConfig() } });
    await host.connect('formats');
    const pinnedHash = statusOf(host, 'formats').tools.filter((t) => t.name === 'convert')[0].schemaHash;

    server.tools.splice(0, 1); // "convert" is gone
    await host.refresh('formats');

    const status = statusOf(host, 'formats');
    expect(status.drift).toEqual([{ tool: 'convert', nodeType: 'mcp.formats.convert', kind: 'removed', pinnedHash }]);
    // Deleting the node type instead would turn a reviewable "this tool is
    // gone" into the engine's generic "unknown node type" on a saved workflow.
    expect(host.nodeModules().map((m) => m.manifest.type).sort()).toEqual(['mcp.formats.convert', 'mcp.formats.echo']);
    // A removed tool has no live hash to publish.
    expect(host.toolSchemaHashes()['mcp.formats.convert']).toBeUndefined();
  });

  it('generates a node for a tool that appeared, with nothing to review', async () => {
    const server = fakeServer({ tools: [echoTool()] });
    const host = hostFor({ formats: server });
    await host.configure({ servers: { formats: stdioConfig() } });
    await host.connect('formats');

    server.tools.push(schemaTool('render', { view: { type: 'string' } }));
    await host.refresh('formats');

    // Only tools we already handed out manifests for can drift.
    expect(statusOf(host, 'formats').drift).toEqual([]);
    expect(statusOf(host, 'formats').toolCount).toBe(2);
    expect(host.nodeModules().map((m) => m.manifest.type).sort()).toEqual(['mcp.formats.echo', 'mcp.formats.render']);
  });

  it('treats a refresh of a never-connected server as the first connect', async () => {
    const server = fakeServer({ tools: [echoTool()] });
    const host = hostFor({ formats: server });
    await host.configure({ servers: { formats: stdioConfig() } });

    await host.refresh('formats');

    // Nothing was pinned, so there is nothing to review: the connect authors
    // from the live surface and reports no drift.
    expect(server.dials).toBe(1);
    expect(statusOf(host, 'formats').state).toBe<McpConnectionState>('connected');
    expect(statusOf(host, 'formats').drift).toEqual([]);
  });
});

describe('reconfiguring', () => {
  it('keeps a live session when the binding is unchanged, and takes advisory edits', async () => {
    const server = fakeServer({ tools: [echoTool()] });
    const host = hostFor({ formats: server });
    await host.configure({ servers: { formats: stdioConfig() } });
    await host.connect('formats');

    // Settings are rewritten wholesale on every edit in the app; a naive
    // "reconfigure ⇒ reconnect" would kill a healthy Revit session every time
    // the user renamed an unrelated AI profile.
    await host.configure({ servers: { formats: stdioConfig({ description: 'Format conversions' }) } });

    expect(server.closed).toBe(0);
    expect(server.dials).toBe(1);
    const status = statusOf(host, 'formats');
    expect(status.state).toBe<McpConnectionState>('connected');
    expect(status.description).toBe('Format conversions');
  });

  it('applies a trustReadOnlyHint toggle to the nodes, without dropping the session', async () => {
    // `sameServerConfig` deliberately treats this flag as advisory, so a
    // toggle-only edit keeps the connection — which is right. What was wrong is
    // what "take the advisory edit" meant. `description` is read live out of
    // `record.config` by `statusOf`, so storing it is enough. This flag's only
    // consumer copies it into a manifest at AUTHORING time, and authoring
    // happens on dial — so storing it changed nothing a caller can see. The
    // engine kept memoizing results (run.ts gates on `manifest.caching`) from a
    // server the user had just declared untrustworthy for exactly that, with no
    // error and a checkbox showing the new value.
    const readOnly = { ...echoTool('peek'), annotations: { readOnlyHint: true } };
    const server = fakeServer({ tools: [readOnly] });
    const host = hostFor({ formats: server });
    await host.configure({ servers: { formats: stdioConfig({ trustReadOnlyHint: true }) } });
    await host.connect('formats');

    const cachingOf = (h: McpHost) =>
      h.nodeModules().find((m) => m.manifest.type === 'mcp.formats.peek')!.manifest.caching;
    expect(cachingOf(host)).toBe('pure');

    await host.configure({ servers: { formats: stdioConfig({ trustReadOnlyHint: false }) } });
    expect(cachingOf(host)).toBe('never');
    // Re-authoring must not have cost a round trip: the tool list is already
    // recorded, so this is a pure re-derivation.
    expect(server.dials).toBe(1);
    expect(server.closed).toBe(0);
    expect(statusOf(host, 'formats').state).toBe<McpConnectionState>('connected');

    // And back, because a one-way fix is half a fix.
    await host.configure({ servers: { formats: stdioConfig({ trustReadOnlyHint: true }) } });
    expect(cachingOf(host)).toBe('pure');
    expect(server.dials).toBe(1);
  });

  it('drops the session when the binding really changed, and does not eagerly re-dial', async () => {
    const server = fakeServer({ tools: [echoTool()] });
    const host = hostFor({ formats: server });
    await host.configure({ servers: { formats: stdioConfig() } });
    await host.connect('formats');

    await host.configure({
      servers: { formats: { binding: { transport: 'stdio', command: ['uvx', 'archspace-formats-server'] }, enabled: true } },
    });

    expect(server.closed).toBe(1);
    // Lazy connect still governs: rebinding is not itself a demand.
    expect(server.dials).toBe(1);
    expect(statusOf(host, 'formats').state).toBe<McpConnectionState>('idle');
    expect(host.nodeModules()).toEqual([]);
  });

  it('tears down a server that disappeared from the config', async () => {
    const server = fakeServer({ tools: [echoTool()] });
    const host = hostFor({ formats: server });
    await host.configure({ servers: { formats: stdioConfig() } });
    await host.connect('formats');

    await host.configure({ servers: {} });

    expect(server.closed).toBe(1);
    expect(host.list()).toEqual([]);
    expect(host.status('formats')).toBeUndefined();
    expect(host.nodeModules()).toEqual([]);
  });
});

describe('close()', () => {
  it('ends every session, empties the palette and refuses further work', async () => {
    const formats = fakeServer({ tools: [echoTool()] });
    const revit = fakeServer({ tools: [schemaTool('get_elements', {})] });
    const host = hostFor({ formats, revit });
    await host.configure({ servers: { formats: stdioConfig(), revit: stdioConfig() } });
    await Promise.all([host.connect('formats'), host.connect('revit')]);
    let notifiedAfterClose = false;
    host.onChange(() => {
      notifiedAfterClose = true;
    });

    await host.close();

    // Missing one of these orphans a child process for the life of the login
    // session, which is the failure nobody notices until Activity Monitor.
    expect(formats.closed).toBe(1);
    expect(revit.closed).toBe(1);
    expect(host.nodeModules()).toEqual([]);
    expect(notifiedAfterClose).toBe(false);

    await expect(host.connect('formats')).rejects.toThrow(/shut down/);
    await expect(host.configure({ servers: {} })).rejects.toThrow(/shut down/);
    // Idempotent: a second close from a different shutdown path must not throw.
    await expect(host.close()).resolves.toBeUndefined();
  });

  it('does not abandon a dial that is in flight while it shuts down', async () => {
    const server = fakeServer({ tools: [echoTool()] });
    const held = gate();
    const host = hostFor(
      {},
      {
        createTransport: async (): Promise<Transport> => {
          await held.promise;
          return server.open();
        },
      },
    );
    await host.configure({ servers: { formats: stdioConfig() } });

    const connecting = host.connect('formats').catch((err: unknown) => err);
    const closing = host.close();
    held.open();
    const failure = await connecting;
    await closing;

    // The connection was already real by the time close() won the race, so it
    // has to be closed here or its stdio child outlives the host.
    expect(server.dials).toBe(1);
    expect(server.closed).toBe(1);
    expect(failure).toBeInstanceOf(McpConnectionError);
  });
});

describe('status reporting', () => {
  it('emits the transitions the settings panel renders, and stops on unsubscribe', async () => {
    const server = fakeServer({ tools: [echoTool()] });
    const host = hostFor({ formats: server });
    const seen: McpConnectionState[] = [];
    const off = host.onChange((servers) => {
      const formats = servers.find((s) => s.name === 'formats');
      if (formats !== undefined) seen.push(formats.state);
    });

    await host.configure({ servers: { formats: stdioConfig() } });
    await host.connect('formats');
    await host.disconnect('formats');

    // `connecting` is the whole reason the panel has a spinner; a host that
    // only emitted terminal states would render a frozen row on a slow dial.
    expect(seen).toEqual<McpConnectionState[]>(['idle', 'connecting', 'connected', 'idle']);

    off();
    await host.connect('formats');
    expect(seen).toHaveLength(4);
  });

  it('emits connecting → failed with the reason, not a generic failure', async () => {
    const host = hostFor(
      {},
      {
        createTransport: (): never => {
          throw new Error('connect ECONNREFUSED 10.0.0.4:8443');
        },
      },
    );
    const seen: McpConnectionState[] = [];
    host.onChange((servers) => seen.push(servers[0].state));
    await host.configure({ servers: { revit: stdioConfig() } });

    await expect(host.connect('revit')).rejects.toBeInstanceOf(McpConnectionError);

    expect(seen).toEqual<McpConnectionState[]>(['idle', 'connecting', 'failed']);
    expect(statusOf(host, 'revit').error).toContain('connect ECONNREFUSED 10.0.0.4:8443');
  });

  it('reports a server that requires authorization as needs-auth, with the sign-in route', async () => {
    // No `oauth` delegate: exactly the CLI's situation, where a headless run
    // cannot open a browser. The server must say so rather than hang or fail
    // generically — `needs-auth` is the one failure with a button next to it.
    const host = hostFor({}, { createTransport: (): never => { throw new Error('the transport must never be reached'); } });
    await host.configure({ servers: { revit: { binding: httpBinding({ auth: 'oauth' }), enabled: true } } });

    const failure = await host.connect('revit').catch((err: unknown) => err);

    expect(failure).toBeInstanceOf(McpConnectionError);
    expect((failure as McpConnectionError).requiresAuth).toBe(true);
    const status = statusOf(host, 'revit');
    expect(status.state).toBe<McpConnectionState>('needs-auth');
    expect(status.error).toContain('requires OAuth sign-in');
    expect(status.error).toContain('Settings → MCP servers');
  });

  it('names the missing secret when a bearer-auth server has no token', async () => {
    const host = hostFor({}, { createTransport: (): never => { throw new Error('the transport must never be reached'); } });
    await host.configure({
      servers: { revit: { binding: httpBinding({ auth: 'bearer', bearerTokenRef: 'revit_bridge_token' }), enabled: true } },
    });

    const failure = await host.connect('revit').catch((err: unknown) => err);

    expect((failure as McpConnectionError).requiresAuth).toBe(true);
    expect(statusOf(host, 'revit').state).toBe<McpConnectionState>('needs-auth');
    // The key, never the value — and the key is what the user has to go set.
    expect(statusOf(host, 'revit').error).toContain('revit_bridge_token');
  });

  it('never dials a disabled server, and says which file disabled it', async () => {
    const server = fakeServer({ tools: [echoTool()] });
    const host = hostFor({ formats: server });
    await host.configure({ servers: { formats: stdioConfig({ enabled: false }) } });

    expect(statusOf(host, 'formats').state).toBe<McpConnectionState>('disabled');
    await expect(host.connect('formats')).rejects.toThrow(/mcp\.yaml/);
    expect(server.dials).toBe(0);
  });

  it('reports an unsupported machine with the checker’s own sentence, outranking disabled', async () => {
    const reason = 'Revit runs only on Windows; bind “revit” to the remote agent over http instead.';
    const server = fakeServer({ tools: [echoTool()] });
    const host = hostFor({ revit: server }, { supportCheck: () => reason });
    await host.configure({ servers: { revit: stdioConfig({ enabled: false }) } });

    // `unsupported` outranks `disabled`: showing "disabled" would invite the
    // user to flip a switch that cannot help.
    const status = statusOf(host, 'revit');
    expect(status.state).toBe<McpConnectionState>('unsupported');
    expect(status.unsupportedReason).toBe(reason);
    await expect(host.connect('revit')).rejects.toThrow(reason);
    // Letting it spawn and reporting the ENOENT would send the user looking
    // for a missing binary instead of reading this sentence.
    expect(server.dials).toBe(0);
  });

  it('refuses a logical name that is not bound on this machine', async () => {
    const host = hostFor({});
    await host.configure({ servers: {} });

    await expect(host.connect('revit')).rejects.toThrow(/No MCP server named "revit"/);
    expect(host.status('revit')).toBeUndefined();
  });

  it('projects a structured-clone-safe row per server, sorted, with credentials stripped', async () => {
    const formats = fakeServer({ tools: [echoTool()], name: 'formats-server', version: '2.1.0' });
    const host = hostFor({ formats });
    await host.configure({
      servers: {
        // Deliberately out of order, and with a URL carrying exactly the two
        // things that must never reach the renderer.
        revit: {
          binding: httpBinding({ url: 'https://svc:hunter2@revit-agent.office.example:8443/mcp?access_token=abc123' }),
          enabled: true,
          concurrency: 4,
        },
        formats: stdioConfig(),
      },
    });
    await host.connect('formats');

    const list = host.list();
    expect(list.map((s) => s.name)).toEqual(['formats', 'revit']);
    const [formatsRow, revitRow] = list;

    expect(formatsRow).toMatchObject({
      transport: 'stdio',
      target: 'fake-mcp-server',
      state: 'connected',
      toolCount: 1,
      concurrency: 1, // serial per server unless overridden (ARCHITECTURE §7.2)
      serverInfo: { name: 'formats-server', version: '2.1.0' },
    });
    expect(formatsRow.protocolVersion).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(formatsRow.lastConnectedAt).toBeTypeOf('number');
    expect(formatsRow.tools).toEqual([
      { name: 'echo', nodeType: 'mcp.formats.echo', description: 'Echoes its arguments.', schemaHash: expect.stringMatching(/^b3:[0-9a-f]{64}$/), drifted: false },
    ]);

    expect(revitRow.transport).toBe('http');
    expect(revitRow.target).toBe('https://revit-agent.office.example:8443/mcp');
    expect(revitRow.target).not.toContain('hunter2');
    expect(revitRow.target).not.toContain('abc123');
    expect(revitRow.concurrency).toBe(4);

    // The status crosses a MessagePort to the sandboxed renderer, so no class
    // instance, Error or live handle may ride along (ARCHITECTURE §3.2).
    expect(structuredClone(list)).toEqual(list);
  });
});

describe('childPids — the synchronous last-resort reap', () => {
  it('reports nothing for a transport with no child process', async () => {
    // The in-memory transport stands in for the HTTP case: a real connection,
    // no child to kill. Reporting a pid here would mean signalling a number
    // that belongs to some unrelated process.
    const host = hostFor({ formats: fakeServer({ tools: [echoTool()] }) });
    await host.configure({ servers: { formats: stdioConfig() } });
    await host.connect('formats');

    expect(statusOf(host, 'formats').state).toBe('connected');
    expect(host.childPids()).toEqual([]);
    await host.close();
  });

  it('reports the pid a stdio transport exposes, and drops it on close', async () => {
    // The SDK's StdioClientTransport carries `pid`; the fake does not, so the
    // pid is grafted onto the transport the seam returns. That is exactly the
    // shape `stdioChildPid` reads, and reading it structurally rather than by
    // `instanceof` is what makes this testable without spawning anything.
    const server = fakeServer({ tools: [echoTool()] });
    const host = createMcpHost({
      assets: createMemoryAssetStore(),
      createTransport: async (name, config) => {
        const transport = await transportFor({ formats: server })(name, config);
        return Object.assign(transport, { pid: 424242 });
      },
    });

    await host.configure({ servers: { formats: stdioConfig() } });
    // Not connected yet: lazy connect means there is no child to reap.
    expect(host.childPids()).toEqual([]);

    await host.connect('formats');
    expect(host.childPids()).toEqual([424242]);

    await host.close();
    // After a graceful close the child is already gone; still reporting it
    // would make the exit handler signal a dead pid, or worse a recycled one.
    expect(host.childPids()).toEqual([]);
  });

  it('ignores a transport whose pid is not a usable number', async () => {
    // `StdioClientTransport.pid` is `number | null` — null before spawn and
    // after exit. Passing null (or 0) to process.kill would target the whole
    // process group, which on this path means killing ourselves.
    const server = fakeServer({ tools: [echoTool()] });
    const host = createMcpHost({
      assets: createMemoryAssetStore(),
      createTransport: async (name, config) => {
        const transport = await transportFor({ formats: server })(name, config);
        return Object.assign(transport, { pid: null });
      },
    });
    await host.configure({ servers: { formats: stdioConfig() } });
    await host.connect('formats');

    expect(host.childPids()).toEqual([]);
    await host.close();
  });
});
