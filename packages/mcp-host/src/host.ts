/**
 * The MCP client pool: one host, N logical servers, their tools as nodes
 * (ARCHITECTURE §9.2–§9.3 / ADR-0009 decisions 2–5).
 *
 * This is the file that ties `config` (what a logical name is bound to),
 * `connection` (how that binding is dialled), `manifest` (how a tool becomes a
 * node) and `content` (how a result becomes wire values) into the one object
 * the engine host owns. Its shape is decided by five judgements worth stating,
 * because each one had an easier alternative:
 *
 * 1. **`configure()` does not dial.** ADR-0009 §2 says lazy connect, and the
 *    reason is concrete: a settings apply that eagerly connected would spawn
 *    every stdio child at boot, block on a Windows box that is asleep, and pop
 *    an OAuth browser window before the user has asked for anything. So
 *    configure records bindings and surfaces status; the first *demand* dials.
 *    Demand is `connect()` (a user pressing Connect, or the CLI's `--connect`)
 *    or a generated node actually calling its tool — which is also what makes
 *    `errors.ts`'s promise true, that a `ConnectionClosed` retry "lands on a
 *    fresh session rather than the dead one".
 *
 * 2. **`supportCheck` is a fact about the machine, not a failure.** A
 *    Revit/AutoCAD server is Windows-only (research §3); on macOS it must never
 *    be dialled at all. Letting it spawn and reporting the resulting ENOENT
 *    would be a lie by omission — the user would go looking for a missing
 *    binary instead of reading "this needs a Windows machine; use the remote
 *    agent". So the check runs at configure time and the server sits in an
 *    `unsupported` state carrying the checker's own sentence.
 *
 * 3. **The authored tool surface is pinned; `refresh()` flags drift rather than
 *    absorbing it** (ADR-0009 §5). Regenerating manifests on every refresh was
 *    the obvious implementation and is exactly what the ADR forbids: it would
 *    silently change the ports and params under nodes already placed on a
 *    canvas, and the workflow — the reviewable source of truth — would be the
 *    last to know. Adopting a changed schema is therefore an explicit act:
 *    disconnect and connect again, which re-authors from the live surface.
 *
 * 4. **An unexpected drop keeps the nodes.** When a server dies the palette
 *    does not empty; the record keeps its authored tools, the state goes back
 *    to `idle`, and the next call re-dials (see 1). The alternative — tearing
 *    down the generated nodes on every hiccup — turns a two-second stdio crash
 *    into "half your workflow's node types no longer exist".
 *
 * 5. **Nothing here schedules.** `mcp:<name>` lanes are serial by default and
 *    the per-server `concurrency` override is applied by the callers as a lane
 *    cap (ARCHITECTURE §7.2); a mutex in this file would double-serialise and
 *    quietly defeat the user's own override.
 *
 * `McpServerStatus` is a plain, structured-clone-safe object because it crosses
 * a `MessagePort` to the sandboxed renderer (ARCHITECTURE §3.2 and
 * `packages/app/src/shared/protocol.ts`). No class instances, no `Error`s, no
 * live handles ever appear on it.
 */
import type { AssetStore, NodeContext, NodeModule, Outputs, Value } from '@archspace/node-sdk';
import {
  DEFAULT_REQUEST_TIMEOUT_MS,
  DEFAULT_SERVER_CONCURRENCY,
  MCP_CONFIG_FILENAME,
  describeBinding,
  sameServerConfig,
  type McpConfig,
  type McpServerConfig,
  type McpTransportKind,
} from './config.js';
import {
  listServerTools,
  openConnection,
  type ConnectionDeps,
  type LogFn,
  type OpenConnection,
  type TransportFactory,
} from './connection.js';
import { captureToolResult } from './content.js';
import { McpCallError, McpConnectionError, McpToolFailure, classifyFailure } from './errors.js';
import { mcpNodeType, toolToManifest, type McpToolInfo } from './manifest.js';
import type { McpOAuthDelegate } from './oauth.js';

/**
 * `idle` is "bound but never dialled" — the resting state of lazy connect, not
 * a problem. `needs-auth` is split out of `failed` because it is the one
 * failure with a button next to it ("Sign in"), and a status panel that cannot
 * tell those apart makes the user restart the app instead.
 */
export type McpConnectionState =
  | 'idle'
  | 'connecting'
  | 'connected'
  | 'disabled'
  | 'unsupported'
  | 'needs-auth'
  | 'failed';

/** One generated node's tool, as the status panel and `archspace mcp` show it. */
export interface McpToolSummary {
  /** The name the server published — what we always call it by on the wire. */
  name: string;
  /** `mcp.<server>.<tool>`; the id a workflow document writes down. */
  nodeType: string;
  title?: string;
  description?: string;
  /** Hash of the schema THIS node was generated from (ADR-0009 §5). */
  schemaHash: string;
  /** True when the live schema has since moved away from `schemaHash`. */
  drifted: boolean;
}

/**
 * A tool whose schema moved under an already-generated node. `removed` is drift
 * too, and the harshest kind: dropping the node type instead would turn a
 * reviewable "this tool is gone" into the engine's generic "unknown node type".
 */
export interface McpToolDrift {
  tool: string;
  nodeType: string;
  kind: 'changed' | 'removed';
  /** The hash the generated node is pinned to. */
  pinnedHash: string;
  /** The hash the server reports now; absent when the tool is gone. */
  liveHash?: string;
}

export interface McpServerStatus {
  name: string;
  state: McpConnectionState;
  enabled: boolean;
  transport: McpTransportKind;
  /** `describeBinding()`: the command, or the URL with credentials stripped. */
  target: string;
  description?: string;
  toolCount: number;
  tools: McpToolSummary[];
  serverInfo?: { name: string; version: string };
  /** Negotiated at `initialize`; the spec version this session actually speaks. */
  protocolVersion?: string;
  /** Why the last connect attempt failed, in the user's language. */
  error?: string;
  /** Why this machine cannot run this server at all (`supportCheck`). */
  unsupportedReason?: string;
  /** Non-empty means "tools changed — review" (ADR-0009 §5). */
  drift: McpToolDrift[];
  /** Effective `mcp:<name>` lane cap; the callers turn this into laneCaps. */
  concurrency: number;
  /** Epoch ms of the last successful connect; absent if never connected. */
  lastConnectedAt?: number;
}

export interface McpHost {
  /** Record bindings and surface status. Deliberately does not dial. */
  configure(config: McpConfig): Promise<void>;
  list(): McpServerStatus[];
  status(name: string): McpServerStatus | undefined;
  connect(name: string): Promise<void>;
  disconnect(name: string): Promise<void>;
  /** Re-read `tools/list` and report drift; never re-maps a generated node. */
  refresh(name: string): Promise<void>;
  nodeModules(): NodeModule[];
  /**
   * Node type → the schema hash the server reports *now*, for every connected
   * server. A document compares the hash it pinned at authoring time against
   * this map; the mismatch is the node's "tool changed — review" flag
   * (ADR-0009 §5, and see the note in `manifest.ts`).
   */
  toolSchemaHashes(): Record<string, string>;
  onChange(cb: (servers: McpServerStatus[]) => void): () => void;
  close(): Promise<void>;
}

export interface CreateMcpHostOptions {
  /** Where tool contents land; wires carry refs, never bytes (ADR-0011). */
  assets: AssetStore;
  /** Resolves `bearerTokenRef` keys. Absent ⇒ bearer-auth servers say so. */
  secrets?: { get(key: string): Promise<string | undefined> };
  /** The browser leg. Absent on purpose in the CLI: a headless run cannot
   *  open one, so an interactive-auth server reports that instead of hanging. */
  oauth?: McpOAuthDelegate;
  oauthRedirectUri?: string;
  log?: LogFn;
  /** Returns a human sentence when this machine cannot run the server at all. */
  supportCheck?: (name: string, config: McpServerConfig) => string | undefined;
  /** Identity sent at `initialize`. */
  clientInfo?: { name: string; version: string };
  /** Test seam (ADR-0013 §5): drive a real Client over `InMemoryTransport`. */
  createTransport?: TransportFactory;
  fetchImpl?: typeof fetch;
}

const DEFAULT_CLIENT_INFO = { name: 'archspace', version: '0.1.0' };

interface ServerRecord {
  name: string;
  config: McpServerConfig;
  state: McpConnectionState;
  unsupportedReason?: string;
  error?: string;
  conn?: OpenConnection;
  /** In-flight dial, so N concurrent demands produce ONE connection. */
  dialling?: Promise<OpenConnection>;
  /** The surface the generated nodes were authored from. Pinned (§9.3). */
  authored: McpToolInfo[];
  /** Tool name → the hash the server reports now. Diverges from `authored`
   *  exactly when a refresh found drift. */
  liveHashes: Record<string, string>;
  drift: McpToolDrift[];
  modules: NodeModule[];
  lastConnectedAt?: number;
}

export function createMcpHost(opts: CreateMcpHostOptions): McpHost {
  const log: LogFn = opts.log ?? ((): void => undefined);
  const assets = opts.assets;
  const supportCheck = opts.supportCheck;
  const records = new Map<string, ServerRecord>();
  const listeners = new Set<(servers: McpServerStatus[]) => void>();
  let closed = false;

  const deps: ConnectionDeps = {
    clientInfo: opts.clientInfo ?? DEFAULT_CLIENT_INFO,
    log,
    ...(opts.secrets !== undefined ? { secrets: opts.secrets } : {}),
    ...(opts.oauth !== undefined ? { oauth: opts.oauth } : {}),
    ...(opts.oauthRedirectUri !== undefined ? { oauthRedirectUri: opts.oauthRedirectUri } : {}),
    ...(opts.createTransport !== undefined ? { createTransport: opts.createTransport } : {}),
    ...(opts.fetchImpl !== undefined ? { fetchImpl: opts.fetchImpl } : {}),
  };

  // -------------------------------------------------------------------------
  // Status projection — the only shape that leaves this module
  // -------------------------------------------------------------------------

  function statusOf(record: ServerRecord): McpServerStatus {
    const drifted = new Set(record.drift.map((d) => d.tool));
    return {
      name: record.name,
      state: record.state,
      enabled: record.config.enabled,
      transport: record.config.binding.transport,
      target: describeBinding(record.config.binding),
      ...(record.config.description !== undefined ? { description: record.config.description } : {}),
      toolCount: record.authored.length,
      tools: record.authored.map((tool) => ({
        name: tool.name,
        nodeType: mcpNodeType(record.name, tool.name),
        ...(tool.title !== undefined ? { title: tool.title } : {}),
        ...(tool.description !== undefined ? { description: tool.description } : {}),
        schemaHash: tool.schemaHash,
        drifted: drifted.has(tool.name),
      })),
      ...(record.conn?.serverInfo !== undefined ? { serverInfo: { ...record.conn.serverInfo } } : {}),
      ...(record.conn?.protocolVersion !== undefined ? { protocolVersion: record.conn.protocolVersion } : {}),
      ...(record.error !== undefined ? { error: record.error } : {}),
      ...(record.unsupportedReason !== undefined ? { unsupportedReason: record.unsupportedReason } : {}),
      drift: record.drift.map((d) => ({ ...d })),
      concurrency: record.config.concurrency ?? DEFAULT_SERVER_CONCURRENCY,
      ...(record.lastConnectedAt !== undefined ? { lastConnectedAt: record.lastConnectedAt } : {}),
    };
  }

  function snapshot(): McpServerStatus[] {
    return [...records.values()]
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
      .map(statusOf);
  }

  function notify(): void {
    if (closed) return;
    const servers = snapshot();
    for (const cb of [...listeners]) cb(servers);
  }

  // -------------------------------------------------------------------------
  // Records
  // -------------------------------------------------------------------------

  /**
   * `unsupported` outranks `disabled`: a Windows-only server on a Mac stays
   * unsupported however the enable toggle is set, and showing "disabled" would
   * invite the user to flip a switch that cannot help.
   */
  function restingState(config: McpServerConfig, unsupportedReason: string | undefined): McpConnectionState {
    if (unsupportedReason !== undefined) return 'unsupported';
    if (!config.enabled) return 'disabled';
    return 'idle';
  }

  function freshRecord(name: string, config: McpServerConfig): ServerRecord {
    const unsupportedReason = supportCheck?.(name, config);
    if (unsupportedReason !== undefined) {
      log('warn', `[mcp:${name}] not supported on this machine: ${unsupportedReason}`);
    }
    return {
      name,
      config,
      state: restingState(config, unsupportedReason),
      ...(unsupportedReason !== undefined ? { unsupportedReason } : {}),
      authored: [],
      liveHashes: {},
      drift: [],
      modules: [],
    };
  }

  function requireRecord(name: string): ServerRecord {
    const record = records.get(name);
    if (record === undefined) {
      throw new McpConnectionError(
        name,
        `No MCP server named "${name}" is bound on this machine. Add it to ${MCP_CONFIG_FILENAME} (Settings → MCP servers).`,
      );
    }
    return record;
  }

  /** Forget the live session AND the generated nodes — the deliberate teardown
   *  (disconnect, rebinding, close), as opposed to an unexpected drop. */
  async function teardown(record: ServerRecord): Promise<void> {
    const dialling = record.dialling;
    if (dialling !== undefined) {
      // Never abandon a dial: the connection it is about to produce would own
      // an orphaned stdio child that nothing closes.
      await dialling.catch(() => undefined);
    }
    const conn = record.conn;
    record.conn = undefined;
    record.authored = [];
    record.liveHashes = {};
    record.drift = [];
    record.modules = [];
    record.error = undefined;
    record.state = restingState(record.config, record.unsupportedReason);
    if (conn !== undefined) await conn.close().catch(() => undefined);
  }

  // -------------------------------------------------------------------------
  // Authoring: tools/list → node modules
  // -------------------------------------------------------------------------

  function author(record: ServerRecord, tools: McpToolInfo[]): void {
    record.authored = tools;
    record.liveHashes = Object.fromEntries(tools.map((tool) => [tool.name, tool.schemaHash]));
    record.drift = [];
    record.modules = tools.map((tool) => moduleFor(record, tool));
  }

  function moduleFor(record: ServerRecord, tool: McpToolInfo): NodeModule {
    const manifest = toolToManifest(record.name, tool);
    // ADR-0009 §4: caching is 'never' and `toolToManifest` refuses to look at
    // `readOnlyHint`, because the spec calls annotations untrusted hints from an
    // untrusted server and a wrong memo is a wrong answer, silently, later. The
    // ONE way a tool becomes cacheable is a user who owns their server saying so
    // in mcp.yaml — applied here, where the user's setting lives, never inferred
    // from the hint alone.
    const trusted = record.config.trustReadOnlyHint === true && tool.annotations?.readOnlyHint === true;
    const mod: NodeModule<Record<string, Value>> = {
      manifest: trusted ? { ...manifest, caching: 'pure' } : manifest,
      async execute(ctx: NodeContext, inputs, params): Promise<Outputs> {
        const conn = await ensureConnected(record.name);
        const timeout = record.config.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
        let raw;
        try {
          raw = await conn.client.callTool(
            { name: tool.name, arguments: callArguments(tool, inputs, params) },
            undefined,
            // `signal` is what the SDK turns into `notifications/cancelled`, so
            // a cancelled run stops work on the server too rather than merely
            // ignoring its answer; `timeout` is the per-request limit the spec
            // asks clients to enforce (§9.2).
            { signal: ctx.signal, timeout },
          );
        } catch (err) {
          throw asCallError(ctx, record.name, tool.name, err);
        }
        const outcome = await captureToolResult(raw, assets);
        if (outcome.isError) {
          // A tool that ran and reported failure is the server talking to the
          // caller, not a transport fault: it fails the node with the server's
          // own words and is never retried (errors.ts).
          throw new McpToolFailure(record.name, tool.name, outcome.text.trim() === '' ? 'the tool reported an error with no message' : outcome.text);
        }
        return { result: outcome.structured, text: outcome.text, assets: outcome.assets };
      },
    };
    return mod as NodeModule;
  }

  // -------------------------------------------------------------------------
  // Connect / drop
  // -------------------------------------------------------------------------

  async function ensureConnected(name: string): Promise<OpenConnection> {
    if (closed) throw new McpConnectionError(name, `The MCP host is shut down; "${name}" cannot be connected.`);
    const record = requireRecord(name);
    if (record.conn !== undefined) return record.conn;
    if (record.dialling !== undefined) return record.dialling;
    if (record.unsupportedReason !== undefined) {
      throw new McpConnectionError(name, record.unsupportedReason);
    }
    if (!record.config.enabled) {
      throw new McpConnectionError(
        name,
        `MCP server "${name}" is disabled in ${MCP_CONFIG_FILENAME}. Enable it in Settings → MCP servers before using its tools.`,
      );
    }
    const dialling = dial(record);
    record.dialling = dialling;
    return dialling;
  }

  async function dial(record: ServerRecord): Promise<OpenConnection> {
    record.state = 'connecting';
    record.error = undefined;
    notify();
    try {
      const conn = await openConnection(record.name, record.config, deps);
      if (closed || records.get(record.name) !== record) {
        // Settings changed or the host shut down while we were dialling. The
        // connection is already real, so it must be closed here or its stdio
        // child outlives us.
        await conn.close().catch(() => undefined);
        throw new McpConnectionError(record.name, `MCP server "${record.name}" was reconfigured while connecting.`);
      }
      record.conn = conn;
      record.state = 'connected';
      record.lastConnectedAt = Date.now();
      author(record, conn.tools);
      watchForDrop(record, conn);
      log('info', `[mcp:${record.name}] connected (${conn.tools.length} tools, MCP ${conn.protocolVersion ?? 'unknown'})`);
      return conn;
    } catch (err) {
      const failure =
        err instanceof McpConnectionError
          ? err
          : new McpConnectionError(record.name, `MCP server "${record.name}" could not be connected: ${err instanceof Error ? err.message : String(err)}`, { cause: err });
      record.state = failure.requiresAuth ? 'needs-auth' : 'failed';
      record.error = failure.message;
      log('warn', `[mcp:${record.name}] ${failure.message}`);
      throw failure;
    } finally {
      record.dialling = undefined;
      notify();
    }
  }

  /**
   * An unexpected close keeps the authored tools (see judgement 4 in the header)
   * and returns the record to `idle`, which is exactly the state the next call's
   * `ensureConnected` re-dials from.
   */
  function watchForDrop(record: ServerRecord, conn: OpenConnection): void {
    conn.client.onclose = (): void => {
      if (record.conn !== conn) return; // already torn down deliberately
      record.conn = undefined;
      record.state = restingState(record.config, record.unsupportedReason);
      record.error = `MCP server "${record.name}" closed the connection; it will be reconnected on the next call.`;
      log('warn', `[mcp:${record.name}] connection closed by the server`);
      notify();
    };
  }

  // -------------------------------------------------------------------------
  // Drift (ADR-0009 §5)
  // -------------------------------------------------------------------------

  function applyDrift(record: ServerRecord, live: McpToolInfo[]): void {
    const byName = new Map(live.map((tool) => [tool.name, tool]));
    const drift: McpToolDrift[] = [];
    const liveHashes: Record<string, string> = {};

    for (const pinned of record.authored) {
      const now = byName.get(pinned.name);
      const nodeType = mcpNodeType(record.name, pinned.name);
      if (now === undefined) {
        drift.push({ tool: pinned.name, nodeType, kind: 'removed', pinnedHash: pinned.schemaHash });
        continue;
      }
      liveHashes[pinned.name] = now.schemaHash;
      if (now.schemaHash !== pinned.schemaHash) {
        drift.push({ tool: pinned.name, nodeType, kind: 'changed', pinnedHash: pinned.schemaHash, liveHash: now.schemaHash });
      }
    }

    // A tool that appeared since we authored has nothing pinned to it, so there
    // is nothing to review: generate its node now. Only tools we already handed
    // out manifests for can drift.
    const appeared = live.filter((tool) => !record.authored.some((pinned) => pinned.name === tool.name));
    if (appeared.length > 0) {
      record.authored = [...record.authored, ...appeared].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
      record.modules = record.authored.map((tool) => moduleFor(record, tool));
      for (const tool of appeared) liveHashes[tool.name] = tool.schemaHash;
    }

    record.liveHashes = liveHashes;
    record.drift = drift;
    if (drift.length > 0) {
      log('warn', `[mcp:${record.name}] ${drift.length} tool schema(s) changed since these nodes were generated; nodes are flagged for review, not re-mapped`);
    }
  }

  // -------------------------------------------------------------------------
  // The host
  // -------------------------------------------------------------------------

  return {
    async configure(config: McpConfig): Promise<void> {
      if (closed) throw new Error('the MCP host is shut down');

      // Rebinding drops the live session; an UNCHANGED binding must not
      // (`sameServerConfig`). Settings are rewritten wholesale on every edit in
      // the app, so a naive "reconfigure ⇒ reconnect" would kill a healthy Revit
      // session every time the user renamed an unrelated AI profile.
      const dropped: ServerRecord[] = [];
      for (const record of records.values()) {
        const incoming = config.servers[record.name];
        if (incoming === undefined || !sameServerConfig(record.config, incoming)) dropped.push(record);
      }
      await Promise.all(dropped.map((record) => teardown(record)));
      for (const record of dropped) records.delete(record.name);

      for (const [name, server] of Object.entries(config.servers)) {
        const existing = records.get(name);
        if (existing !== undefined) {
          // Same binding by `sameServerConfig`, so only advisory fields can
          // differ (description, trustReadOnlyHint). Take them without
          // disturbing the connection; the support verdict cannot have changed
          // because it is a function of the binding.
          existing.config = server;
          continue;
        }
        records.set(name, freshRecord(name, server));
      }
      notify();
    },

    list(): McpServerStatus[] {
      return snapshot();
    },

    status(name: string): McpServerStatus | undefined {
      const record = records.get(name);
      return record === undefined ? undefined : statusOf(record);
    },

    async connect(name: string): Promise<void> {
      await ensureConnected(name);
    },

    async disconnect(name: string): Promise<void> {
      const record = requireRecord(name);
      await teardown(record);
      log('info', `[mcp:${name}] disconnected`);
      notify();
    },

    async refresh(name: string): Promise<void> {
      const record = requireRecord(name);
      if (record.conn === undefined) {
        // Nothing is pinned yet, so a first connect IS the refresh — and it
        // authors from the live surface with no drift to report.
        await ensureConnected(name);
        return;
      }
      const live = await listServerTools(record.conn.client, record.config.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS);
      applyDrift(record, live);
      notify();
    },

    nodeModules(): NodeModule[] {
      // Keyed off the authored surface, not the connection state: a server that
      // dropped keeps its nodes and re-dials on the next call (judgement 4).
      const modules: NodeModule[] = [];
      for (const record of records.values()) modules.push(...record.modules);
      return modules;
    },

    toolSchemaHashes(): Record<string, string> {
      const hashes: Record<string, string> = {};
      for (const record of records.values()) {
        for (const [tool, hash] of Object.entries(record.liveHashes)) {
          hashes[mcpNodeType(record.name, tool)] = hash;
        }
      }
      return hashes;
    },

    onChange(cb: (servers: McpServerStatus[]) => void): () => void {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },

    async close(): Promise<void> {
      if (closed) return;
      closed = true;
      // `teardown` runs the SDK's shutdown for each transport, which for stdio
      // is the spec sequence (close stdin → SIGTERM → SIGKILL). Missing one
      // here orphans a child process for the life of the login session.
      await Promise.allSettled([...records.values()].map((record) => teardown(record)));
      listeners.clear();
    },
  };
}

// ---------------------------------------------------------------------------
// Call plumbing
// ---------------------------------------------------------------------------

/**
 * Tool arguments = params, with any connected input port winning.
 *
 * MCP node manifests declare no input ports today; every tool property is a
 * param marked promotable (§9.3), and promotion is the canvas's job. Reading
 * `inputs` anyway costs one loop and means this file needs no change on the day
 * promotion lands — while unknown keys are dropped, because a strict server is
 * entitled to reject an argument its schema never declared.
 */
function callArguments(tool: McpToolInfo, inputs: Record<string, Value | undefined>, params: Record<string, Value>): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...params };
  for (const [key, value] of Object.entries(inputs)) {
    if (value !== undefined) merged[key] = value;
  }
  const declared = Object.keys(tool.inputSchema.properties ?? {});
  if (declared.length === 0) {
    // A tool that publishes no properties gets whatever the document wrote:
    // refusing everything would make such tools uncallable rather than strict.
    return Object.fromEntries(Object.entries(merged).filter(([, value]) => value !== undefined));
  }
  const args: Record<string, unknown> = {};
  for (const key of declared) {
    if (merged[key] !== undefined) args[key] = merged[key];
  }
  return args;
}

/**
 * One verdict, decided here so the engine's retry policy is fed a fact rather
 * than a guess (§7.5). Cancellation is re-thrown untouched: the engine
 * recognises a cancelled node by `err.name === 'AbortError'`, and wrapping it
 * would turn a clean cancel into a failed run.
 */
function asCallError(ctx: NodeContext, server: string, tool: string, err: unknown): Error {
  // Ask the signal before inspecting the error, because the error cannot answer
  // this. The SDK re-dresses an aborted request as `McpError(-32001)` — the very
  // code it also raises for its own request timeout — and leaves the word
  // "AbortError" only inside the message text. So `classifyFailure` sees an
  // McpError and honestly reports "not cancelled", and the alternative of
  // matching the message would make a string in someone else's library into our
  // cancellation contract. The signal is the thing that was actually aborted,
  // and a timeout leaves it untouched, so it separates the two exactly.
  if (ctx.signal.aborted) {
    // Prefer the reason the aborter gave: `controller.abort()` supplies a
    // DOMException already named AbortError, which is the most faithful error
    // to hand back. A custom reason is not passed through — the engine keys
    // cancellation off `name === 'AbortError'` (run.ts), so a differently-named
    // error would read as a genuine failure.
    const reason: unknown = ctx.signal.reason;
    if (reason instanceof Error && reason.name === 'AbortError') return reason;
    return new DOMException('The operation was aborted', 'AbortError');
  }
  const failure = classifyFailure(err);
  if (failure.cancelled) return err instanceof Error ? err : new Error(failure.message);
  const callError = new McpCallError(server, tool, `MCP tool "${tool}" on server "${server}" could not be called: ${failure.message}`, {
    ...(failure.status !== undefined ? { status: failure.status } : {}),
    retryable: failure.retryable,
    cause: err,
  });
  return failure.retryable ? ctx.retryable(callError) : callError;
}
