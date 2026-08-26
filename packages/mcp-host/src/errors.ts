/**
 * Failure classification for MCP work (ARCHITECTURE §7.5).
 *
 * The engine's retry policy only helps if "transient" is decided once, by the
 * layer that can actually tell the difference. A 429 from a busy Revit bridge
 * and a 400 from a badly-typed argument both arrive as exceptions; retrying the
 * first is polite and retrying the second is a loop. So the transport statuses
 * the spec and HTTP agree are temporary are named here, and the generated nodes
 * do nothing more than pass the verdict on to `ctx.retryable`.
 *
 * A tool that returns `isError: true` is *not* a transport failure — it is the
 * server telling the model something went wrong — and it is never retryable.
 */
import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';
import { StreamableHTTPError } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

/** HTTP statuses that mean "come back later", not "you asked wrong". */
const TRANSIENT_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);

export class McpHostError extends Error {
  readonly server: string;
  constructor(server: string, message: string) {
    super(message);
    this.name = 'McpHostError';
    this.server = server;
  }
}

/** Could not reach or complete the lifecycle handshake with a server. */
export class McpConnectionError extends McpHostError {
  readonly requiresAuth: boolean;
  readonly retryable: boolean;
  constructor(server: string, message: string, opts?: { requiresAuth?: boolean; retryable?: boolean; cause?: unknown }) {
    super(server, message);
    this.name = 'McpConnectionError';
    this.requiresAuth = opts?.requiresAuth === true;
    this.retryable = opts?.retryable === true;
    if (opts?.cause !== undefined) this.cause = opts.cause;
  }
}

/** A `tools/call` that failed at the protocol or transport level. */
export class McpCallError extends McpHostError {
  readonly tool: string;
  readonly status?: number;
  readonly retryable: boolean;
  constructor(server: string, tool: string, message: string, opts?: { status?: number; retryable?: boolean; cause?: unknown }) {
    super(server, message);
    this.name = 'McpCallError';
    this.tool = tool;
    if (opts?.status !== undefined) this.status = opts.status;
    this.retryable = opts?.retryable === true;
    if (opts?.cause !== undefined) this.cause = opts.cause;
  }
}

/** A tool ran and reported failure. The node fails with the server's own words. */
export class McpToolFailure extends McpHostError {
  readonly tool: string;
  constructor(server: string, tool: string, message: string) {
    super(server, `MCP tool "${tool}" on server "${server}" failed: ${message}`);
    this.name = 'McpToolFailure';
    this.tool = tool;
  }
}

export interface FailureClassification {
  retryable: boolean;
  status?: number;
  /** True when the failure is the request being cancelled, not the server. */
  cancelled: boolean;
  message: string;
}

export function classifyFailure(err: unknown): FailureClassification {
  if (err instanceof StreamableHTTPError) {
    const status = err.code;
    return {
      retryable: status !== undefined && TRANSIENT_STATUS.has(status),
      ...(status !== undefined ? { status } : {}),
      cancelled: false,
      message: err.message,
    };
  }
  if (err instanceof McpError) {
    // A dropped connection is worth one more attempt: the pool reconnects
    // lazily, so the retry lands on a fresh session rather than the dead one.
    return {
      retryable: err.code === ErrorCode.ConnectionClosed,
      cancelled: false,
      message: err.message,
    };
  }
  if (isAbort(err)) {
    return { retryable: false, cancelled: true, message: 'cancelled' };
  }
  const message = err instanceof Error ? err.message : String(err);
  // Node's fetch reports every socket-level problem as an opaque "fetch failed"
  // with the real cause nested; a network hiccup deserves the same second
  // chance as a 503.
  const cause = err instanceof Error && err.cause instanceof Error ? err.cause.message : undefined;
  const networkish = /fetch failed|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|socket hang up/i;
  return {
    retryable: networkish.test(message) || (cause !== undefined && networkish.test(cause)),
    cancelled: false,
    message: cause !== undefined ? `${message}: ${cause}` : message,
  };
}

function isAbort(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const name = (err as { name?: unknown }).name;
  return name === 'AbortError' || name === 'TimeoutError';
}
