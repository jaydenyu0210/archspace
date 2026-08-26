/**
 * A real MCP server, in this process (ADR-0013 §5).
 *
 * The suite drives a real SDK `Client` against a real SDK `Server` over
 * `InMemoryTransport`, injected through the host's `createTransport` seam. That
 * is deliberate and it is the whole reason the seam exists: a hand-rolled fake
 * client would let us assert whatever we had implemented, while this exercises
 * `initialize` negotiation, `tools/list` pagination, `tools/call` framing,
 * cancellation and connection teardown exactly as a stdio or HTTP server would
 * — minus the process and the socket, so the suite stays sub-second and has no
 * timing flake. Process-level spawn/kill behaviour is the fixture-server tier
 * of §5, not this one.
 *
 * Each `open()` builds a NEW linked pair and a NEW `Server`, because that is
 * what dialling really does: a reconnect is a fresh session with a fresh tool
 * surface. `dials` is therefore a truthful count of how often the host went to
 * the wire, which is how the lazy-connect tests are written.
 */
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { CallToolRequestSchema, ListToolsRequestSchema, type CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { McpServerConfig } from '../src/config.js';
import type { TransportFactory } from '../src/connection.js';

export interface ToolCallExtra {
  /** Aborted when the client sends `notifications/cancelled`. */
  signal: AbortSignal;
  /** Kill this session from inside a call — the dropped-connection case. */
  drop(): Promise<void>;
}

export interface FakeTool {
  name: string;
  title?: string;
  description?: string;
  inputSchema: Record<string, unknown>;
  annotations?: Record<string, unknown>;
  handle(args: Record<string, unknown>, extra: ToolCallExtra): CallToolResult | Promise<CallToolResult>;
}

export interface FakeServer {
  /** Mutable so a test can change a tool's schema under a live connection. */
  tools: FakeTool[];
  /** How many times the host dialled. The lazy-connect assertion. */
  readonly dials: number;
  /** Every `tools/call` the server saw, in order. */
  readonly calls: { tool: string; args: Record<string, unknown> | undefined }[];
  /** Sessions the server has ended (its side of `close()`). */
  readonly closed: number;
  open(): Promise<Transport>;
  dropAll(): Promise<void>;
}

export function fakeServer(opts: { tools: FakeTool[]; name?: string; version?: string }): FakeServer {
  const sessions: InMemoryTransport[] = [];
  const state = { dials: 0, closed: 0 };
  const calls: { tool: string; args: Record<string, unknown> | undefined }[] = [];
  const tools = [...opts.tools];

  const fake: FakeServer = {
    tools,
    get dials() {
      return state.dials;
    },
    get calls() {
      return calls;
    },
    get closed() {
      return state.closed;
    },

    async open(): Promise<Transport> {
      state.dials += 1;
      const [clientEnd, serverEnd] = InMemoryTransport.createLinkedPair();
      const server = new Server(
        { name: opts.name ?? 'fake-mcp-server', version: opts.version ?? '1.2.3' },
        { capabilities: { tools: {} } },
      );

      server.setRequestHandler(ListToolsRequestSchema, () => ({
        tools: fake.tools.map((tool) => ({
          name: tool.name,
          ...(tool.title !== undefined ? { title: tool.title } : {}),
          ...(tool.description !== undefined ? { description: tool.description } : {}),
          inputSchema: tool.inputSchema as { type: 'object' },
          ...(tool.annotations !== undefined ? { annotations: tool.annotations } : {}),
        })),
      }));

      server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
        const args = request.params.arguments as Record<string, unknown> | undefined;
        calls.push({ tool: request.params.name, args });
        const tool = fake.tools.find((t) => t.name === request.params.name);
        if (tool === undefined) throw new Error(`fake server has no tool "${request.params.name}"`);
        return tool.handle(args ?? {}, {
          signal: extra.signal,
          drop: async () => {
            await serverEnd.close();
          },
        });
      });

      server.onclose = (): void => {
        state.closed += 1;
      };
      await server.connect(serverEnd);
      sessions.push(serverEnd);
      return clientEnd;
    },

    async dropAll(): Promise<void> {
      const open = sessions.splice(0, sessions.length);
      for (const session of open) await session.close();
    },
  };
  return fake;
}

/** The `createTransport` seam, routed by logical name like the real thing. */
export function transportFor(servers: Record<string, FakeServer>): TransportFactory {
  return (name: string) => {
    const server = servers[name];
    if (server === undefined) throw new Error(`test: no fake server bound for "${name}"`);
    return server.open();
  };
}

/** A binding whose command is never run — `createTransport` intercepts first. */
export function stdioConfig(overrides: Partial<McpServerConfig> = {}): McpServerConfig {
  return {
    binding: { transport: 'stdio', command: ['fake-mcp-server'] },
    enabled: true,
    ...overrides,
  };
}

export function textResult(text: string, extra: Partial<CallToolResult> = {}): CallToolResult {
  return { content: [{ type: 'text', text }], ...extra };
}

/** The simplest possible tool: echoes its arguments back as structured output. */
export function echoTool(name = 'echo'): FakeTool {
  return {
    name,
    description: 'Echoes its arguments.',
    inputSchema: {
      type: 'object',
      properties: { message: { type: 'string', description: 'What to echo.' } },
      required: ['message'],
    },
    handle: (args) => ({
      content: [{ type: 'text', text: typeof args.message === 'string' ? args.message : JSON.stringify(args.message ?? '') }],
      structuredContent: { echoed: args.message ?? null },
    }),
  };
}
