/**
 * One MCP server, connected (ARCHITECTURE §9.2 / research §5).
 *
 * Everything below the `Client` is the official SDK's, deliberately: the
 * research checklist — JSON-RPC framing, `initialize` version negotiation,
 * `notifications/initialized`, per-request timeouts, `notifications/cancelled`,
 * progress, Streamable HTTP session headers, `MCP-Protocol-Version` on
 * post-init requests, SSE resumption via `Last-Event-ID`, and the stdio
 * shutdown sequence (close stdin → wait → SIGTERM → SIGKILL) — is a
 * specification we should implement exactly once, in the reference
 * implementation, not twice.
 *
 * What this file adds is everything the SDK correctly refuses to decide for us:
 * which transport a logical name binds to, where the bearer token comes from
 * (a keychain KEY, never a literal), how the OAuth browser leg is delegated to
 * the app, what a server's stderr does (it becomes engine log lines rather than
 * polluting our own stderr), and how the negotiated protocol version is
 * observed so the status panel can show it.
 *
 * The transport is injectable so tests can drive a real client over the SDK's
 * `InMemoryTransport` — the fastest honest test of everything above the wire.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { UnauthorizedError } from '@modelcontextprotocol/sdk/client/auth.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { LogLevel } from '@archspace/node-sdk';
import {
  DEFAULT_REQUEST_TIMEOUT_MS,
  type McpHttpBinding,
  type McpServerConfig,
  type McpStdioBinding,
} from './config.js';
import { McpConnectionError } from './errors.js';
import { asJsonSchemaObject, hashToolSchema, type McpToolInfo } from './manifest.js';
import { createOAuthProvider, type DelegatedOAuthProvider, type McpOAuthDelegate } from './oauth.js';

export type LogFn = (level: LogLevel, message: string, data?: unknown) => void;

/** Test seam: hand back any `Transport` for a logical name. */
export type TransportFactory = (name: string, config: McpServerConfig) => Promise<Transport> | Transport;

export interface ConnectionDeps {
  clientInfo: { name: string; version: string };
  log: LogFn;
  secrets?: { get(key: string): Promise<string | undefined> };
  oauth?: McpOAuthDelegate;
  oauthRedirectUri?: string;
  createTransport?: TransportFactory;
  fetchImpl?: typeof fetch;
}

export interface OpenConnection {
  client: Client;
  transport: Transport;
  serverInfo?: { name: string; version: string };
  protocolVersion?: string;
  capabilities: { tools?: boolean; resources?: boolean; prompts?: boolean; logging?: boolean };
  instructions?: string;
  tools: McpToolInfo[];
  close(): Promise<void>;
}

function timeoutOf(config: McpServerConfig): number {
  return config.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
}

/**
 * The Client tells the transport the negotiated version and nothing else; there
 * is no getter. Wrapping the hook is how we learn it without forking the SDK.
 */
function observeProtocolVersion(transport: Transport, onVersion: (version: string) => void): void {
  const original = transport.setProtocolVersion?.bind(transport);
  transport.setProtocolVersion = (version: string) => {
    onVersion(version);
    original?.(version);
  };
}

async function buildStdioTransport(name: string, binding: McpStdioBinding, deps: ConnectionDeps): Promise<Transport> {
  const [command, ...args] = binding.command;
  if (!command) throw new McpConnectionError(name, `MCP server "${name}": the stdio command is empty.`);
  const transport = new StdioClientTransport({
    command,
    args,
    // stderr is the spec's channel for server logging; it belongs in the engine
    // log next to everything else, never inherited into our own stderr.
    stderr: 'pipe',
    ...(binding.env !== undefined ? { env: { ...process.env as Record<string, string>, ...binding.env } } : {}),
    ...(binding.cwd !== undefined ? { cwd: binding.cwd } : {}),
  });
  transport.stderr?.on('data', (chunk: Buffer | string) => {
    const text = String(chunk).trimEnd();
    if (text.length > 0) deps.log('debug', `[mcp:${name}] ${text}`);
  });
  return transport;
}

function buildHttpTransport(
  name: string,
  binding: McpHttpBinding,
  headers: Record<string, string>,
  provider: DelegatedOAuthProvider | undefined,
  deps: ConnectionDeps,
): StreamableHTTPClientTransport {
  return new StreamableHTTPClientTransport(new URL(binding.url), {
    requestInit: { headers },
    ...(provider !== undefined ? { authProvider: provider } : {}),
    ...(deps.fetchImpl !== undefined ? { fetch: deps.fetchImpl } : {}),
  });
}

async function httpHeaders(name: string, binding: McpHttpBinding, deps: ConnectionDeps): Promise<Record<string, string>> {
  const headers: Record<string, string> = { ...(binding.headers ?? {}) };
  if (binding.auth !== 'bearer') return headers;
  if (!binding.bearerTokenRef) {
    throw new McpConnectionError(name, `MCP server "${name}" is configured for bearer auth but names no secret. Set bearerTokenRef to a key in Settings → Secrets.`, {
      requiresAuth: true,
    });
  }
  if (!deps.secrets) {
    throw new McpConnectionError(name, `MCP server "${name}" needs the secret "${binding.bearerTokenRef}", but this host was created without a secret resolver.`, {
      requiresAuth: true,
    });
  }
  const token = await deps.secrets.get(binding.bearerTokenRef);
  if (!token) {
    throw new McpConnectionError(name, `MCP server "${name}" needs the secret "${binding.bearerTokenRef}", which is not set. Add it in Settings → Secrets.`, {
      requiresAuth: true,
    });
  }
  headers.Authorization = `Bearer ${token}`;
  return headers;
}

/**
 * Exported because `host.ts` re-reads this exact surface on `refresh()` to
 * detect schema drift (ADR-0009 §5); pagination and the stable sort below are
 * the parts that must not be reimplemented differently there.
 */
export async function listServerTools(client: Client, timeout: number): Promise<McpToolInfo[]> {
  const tools: McpToolInfo[] = [];
  let cursor: string | undefined;
  do {
    const page = await client.listTools(cursor === undefined ? {} : { cursor }, { timeout });
    for (const tool of page.tools) {
      const inputSchema = asJsonSchemaObject(tool.inputSchema);
      tools.push({
        name: tool.name,
        ...(tool.title !== undefined ? { title: tool.title } : {}),
        ...(tool.description !== undefined ? { description: tool.description } : {}),
        inputSchema,
        schemaHash: hashToolSchema(inputSchema),
        ...(tool.annotations !== undefined ? { annotations: { ...tool.annotations } } : {}),
      });
    }
    cursor = typeof page.nextCursor === 'string' ? page.nextCursor : undefined;
  } while (cursor !== undefined);
  // Stable order: the palette must not reshuffle because a server changed its
  // internal iteration order between connects.
  return tools.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

/**
 * Connect, negotiate, and read the tool surface.
 *
 * The OAuth retry is the one piece of choreography the SDK leaves to the
 * caller: `auth()` ends a fresh authorization by returning 'REDIRECT', because
 * in a browser client the process genuinely ends there. Our delegate resolves
 * the whole browser leg inline, so the code is already in hand by the time
 * `UnauthorizedError` surfaces — we exchange it and dial again on a clean
 * transport, rather than asking the user to press connect a second time.
 */
export async function openConnection(name: string, config: McpServerConfig, deps: ConnectionDeps): Promise<OpenConnection> {
  const timeout = timeoutOf(config);
  const binding = config.binding;
  const wantsOAuth = binding.transport === 'http' && binding.auth === 'oauth';

  if (wantsOAuth && !deps.oauth) {
    throw new McpConnectionError(
      name,
      `MCP server "${name}" requires OAuth sign-in, but no authorization handler is available in this process. Connect it from the app (Settings → MCP servers), which runs the browser flow and stores the tokens in the keychain.`,
      { requiresAuth: true },
    );
  }

  const provider =
    wantsOAuth && deps.oauth
      ? createOAuthProvider({
          server: name,
          delegate: deps.oauth,
          ...(deps.oauthRedirectUri !== undefined ? { redirectUri: deps.oauthRedirectUri } : {}),
        })
      : undefined;

  const headers = binding.transport === 'http' ? await httpHeaders(name, binding, deps) : {};

  const makeTransport = async (): Promise<Transport> => {
    if (deps.createTransport) return deps.createTransport(name, config);
    return binding.transport === 'stdio'
      ? buildStdioTransport(name, binding, deps)
      : buildHttpTransport(name, binding, headers, provider, deps);
  };

  let protocolVersion: string | undefined;
  const connectOnce = async (): Promise<{ client: Client; transport: Transport }> => {
    const transport = await makeTransport();
    observeProtocolVersion(transport, (version) => {
      protocolVersion = version;
    });
    const client = new Client(deps.clientInfo, {
      // We advertise nothing beyond the base protocol: `roots`, `sampling` and
      // `elicitation` all hand a server authority over the user's machine or
      // model budget, and ADR-0009 §6 defers them behind a consent toggle.
      capabilities: {},
    });
    try {
      await client.connect(transport, { timeout });
    } catch (err) {
      await client.close().catch(() => undefined);
      await transport.close().catch(() => undefined);
      throw err;
    }
    return { client, transport };
  };

  let opened: { client: Client; transport: Transport };
  try {
    opened = await connectOnce();
  } catch (err) {
    const code = provider?.takeAuthorizationCode();
    if (!(err instanceof UnauthorizedError) || !provider || !code) {
      throw asConnectionError(name, err, wantsOAuth);
    }
    deps.log('info', `[mcp:${name}] exchanging authorization code for tokens`);
    try {
      const exchangeTransport = buildHttpTransport(name, binding as McpHttpBinding, headers, provider, deps);
      await exchangeTransport.finishAuth(code);
      await exchangeTransport.close();
      opened = await connectOnce();
    } catch (retryErr) {
      throw asConnectionError(name, retryErr, true);
    }
  }

  const { client, transport } = opened;
  const serverCapabilities = client.getServerCapabilities();
  const capabilities = {
    tools: serverCapabilities?.tools !== undefined,
    resources: serverCapabilities?.resources !== undefined,
    prompts: serverCapabilities?.prompts !== undefined,
    logging: serverCapabilities?.logging !== undefined,
  };

  let tools: McpToolInfo[] = [];
  if (capabilities.tools) {
    try {
      tools = await listServerTools(client, timeout);
    } catch (err) {
      await client.close().catch(() => undefined);
      throw asConnectionError(name, err, false);
    }
  } else {
    deps.log('warn', `[mcp:${name}] server advertises no tools capability; no nodes will be generated`);
  }

  const info = client.getServerVersion();
  const instructions = client.getInstructions();

  return {
    client,
    transport,
    ...(info !== undefined ? { serverInfo: { name: info.name, version: info.version } } : {}),
    ...(protocolVersion !== undefined ? { protocolVersion } : {}),
    capabilities,
    ...(instructions !== undefined ? { instructions } : {}),
    tools,
    close: async () => {
      // Client.close() closes the transport, which for stdio runs the spec
      // shutdown sequence and for HTTP releases the SSE stream.
      await client.close().catch(() => undefined);
    },
  };
}

function asConnectionError(name: string, err: unknown, authContext: boolean): McpConnectionError {
  if (err instanceof McpConnectionError) return err;
  if (err instanceof UnauthorizedError) {
    return new McpConnectionError(name, `MCP server "${name}" refused the connection as unauthorized. Sign in again from Settings → MCP servers.`, {
      requiresAuth: true,
      cause: err,
    });
  }
  const message = err instanceof Error ? err.message : String(err);
  return new McpConnectionError(name, `MCP server "${name}" could not be connected: ${message}`, {
    ...(authContext ? { requiresAuth: false } : {}),
    cause: err,
  });
}
