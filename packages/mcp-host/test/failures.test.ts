/**
 * What "transient" means, decided once (ARCHITECTURE §7.5 / ADR-0013 §5).
 *
 * The engine's retry policy is only as good as the verdict it is fed. A 429
 * from a busy Revit bridge and a 400 from a badly typed argument arrive at this
 * layer as indistinguishable exceptions; retrying the first is polite and
 * retrying the second is a loop that burns three attempts and an exponential
 * backoff to reach the same failure. So `classifyFailure` is a table, and a
 * table is exactly the thing that rots quietly when nothing pins it.
 *
 * The case this file exists for, though, is the one that cannot be pinned by
 * inspection:
 *
 *   **An aborted request and an expired request are the same error.** The SDK
 *   rejects a cancelled request with `McpError(-32001)` and rejects its own
 *   per-request timeout with `McpError(-32001)`, differing only in a message
 *   string inside someone else's library. `host.ts` therefore decides
 *   cancellation from `ctx.signal` and never from the error. That decision has
 *   two failure modes and they are opposites: read the error and a genuine
 *   timeout is reported as a clean cancellation, so a workflow that timed out
 *   looks to the user like one they cancelled themselves and never retries;
 *   read it the other way and a user pressing Stop gets a failed run. Both
 *   directions are covered here — the cancel half lives in `nodes.test.ts`, and
 *   this file owns the timeout half, which is the one with no test at all until
 *   now.
 */
import { describe, expect, it } from 'vitest';
import { createMemoryAssetStore, isRetryableError, type NodeModule } from '@archspace/node-sdk';
import { runNode } from '@archspace/node-sdk/testkit';
import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';
import { StreamableHTTPError } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { classifyFailure, createMcpHost } from '../src/index.js';
import { McpCallError } from '../src/errors.js';
import { fakeServer, stdioConfig, textResult, transportFor, type FakeServer } from './helpers.js';

function moduleOf(modules: NodeModule[], type: string): NodeModule {
  const mod = modules.find((m) => m.manifest.type === type);
  if (mod === undefined) throw new Error(`no generated node "${type}" in [${modules.map((m) => m.manifest.type).join(', ')}]`);
  return mod;
}

async function hostWith(server: FakeServer, config = stdioConfig()) {
  const assets = createMemoryAssetStore();
  const host = createMcpHost({ assets, createTransport: transportFor({ formats: server }) });
  await host.configure({ servers: { formats: config } });
  await host.connect('formats');
  return { host, assets };
}

/** A tool that answers only when the client gives up on it. */
function unanswerableTool(name: string): FakeServer {
  return fakeServer({
    tools: [
      {
        name,
        inputSchema: { type: 'object', properties: {} },
        handle: (_args, extra) =>
          new Promise<CallToolResult>((resolve) => {
            // Resolving on abort keeps the fixture tidy when the client sends
            // `notifications/cancelled`; the answer is never sent either way.
            extra.signal.addEventListener('abort', () => resolve(textResult('too late')));
          }),
      },
    ],
  });
}

describe('classifyFailure, the transient-status table', () => {
  it.each([408, 425, 429, 500, 502, 503, 504])('retries HTTP %i, which means "come back later"', (status) => {
    const failure = classifyFailure(new StreamableHTTPError(status, 'server said no'));

    expect(failure).toMatchObject({ retryable: true, status, cancelled: false });
  });

  it.each([400, 401, 403, 404, 405, 409, 410, 413, 422, 501])('never retries HTTP %i, which means "you asked wrong"', (status) => {
    // Retrying these is a loop: the same request produces the same answer, and
    // 401/403 in particular need a human with a password, not a backoff.
    expect(classifyFailure(new StreamableHTTPError(status, 'nope'))).toMatchObject({ retryable: false, status, cancelled: false });
  });

  it('carries no status when the transport could not name one', () => {
    const failure = classifyFailure(new StreamableHTTPError(undefined, 'stream closed'));

    expect(failure.status).toBeUndefined();
    expect(failure.retryable).toBe(false);
  });

  it('retries a dropped connection, because the pool re-dials lazily', () => {
    // The one JSON-RPC code worth another attempt: `ensureConnected` will open
    // a fresh session, so the retry lands somewhere alive rather than on the
    // corpse of the old one.
    expect(classifyFailure(new McpError(ErrorCode.ConnectionClosed, 'Connection closed'))).toMatchObject({ retryable: true, cancelled: false });
  });

  it.each<[string, number]>([
    ['a request timeout', ErrorCode.RequestTimeout],
    ['invalid params', ErrorCode.InvalidParams],
    ['method not found', ErrorCode.MethodNotFound],
    ['an internal server error', ErrorCode.InternalError],
    ['a parse error', ErrorCode.ParseError],
  ])('does not retry %s', (_label, code) => {
    expect(classifyFailure(new McpError(code, 'no'))).toMatchObject({ retryable: false, cancelled: false });
  });

  it('never calls an McpError a cancellation, whatever its code says', () => {
    // -32001 is the SDK's code for BOTH its own request timeout and a request
    // aborted by the caller. This function honestly reports "not cancelled" for
    // both, and `host.ts` asks `ctx.signal` instead. Matching on the message
    // text would make a string in someone else's library into our cancellation
    // contract.
    const timedOut = classifyFailure(new McpError(ErrorCode.RequestTimeout, 'Request timed out'));
    const abortedByTheSdk = classifyFailure(new McpError(ErrorCode.RequestTimeout, 'AbortError: This operation was aborted'));

    expect(timedOut.cancelled).toBe(false);
    expect(abortedByTheSdk.cancelled).toBe(false);
    expect(timedOut.message).toContain('Request timed out');
  });

  it.each(['AbortError', 'TimeoutError'])('reports a raw %s as cancelled and never retryable', (name) => {
    // These reach us when the abort happened outside a request, e.g. in the
    // transport itself. A cancelled run must not be retried into existence.
    const failure = classifyFailure(new DOMException('The operation was aborted', name));

    expect(failure).toMatchObject({ retryable: false, cancelled: true, message: 'cancelled' });
  });

  it.each(['fetch failed', 'read ECONNRESET', 'connect ECONNREFUSED 10.0.0.4:8443', 'connect ETIMEDOUT', 'getaddrinfo EAI_AGAIN revit.example', 'socket hang up'])(
    'retries the socket-level failure %o',
    (message) => {
      // A network hiccup deserves the same second chance as a 503.
      expect(classifyFailure(new Error(message))).toMatchObject({ retryable: true, cancelled: false });
    },
  );

  it('unwraps the cause Node hides behind "fetch failed"', () => {
    // Node's fetch reports every socket problem as an opaque "fetch failed"
    // with the real story nested one level down; the message a user reads has
    // to carry that story.
    const failure = classifyFailure(Object.assign(new Error('fetch failed'), { cause: new Error('connect ECONNREFUSED 10.0.0.4:8443') }));

    expect(failure.retryable).toBe(true);
    expect(failure.message).toBe('fetch failed: connect ECONNREFUSED 10.0.0.4:8443');
  });

  it.each<[string, unknown, string]>([
    ['a plain error', new Error('unit is not one of mm, cm, m'), 'unit is not one of mm, cm, m'],
    ['a thrown string', 'the server exploded', 'the server exploded'],
    ['a thrown object', { detail: 'nope' }, '[object Object]'],
  ])('does not retry %s', (_label, err, message) => {
    expect(classifyFailure(err)).toMatchObject({ retryable: false, cancelled: false, message });
  });
});

describe('a genuine timeout is not a cancellation', () => {
  it('fails the node with the timeout instead of reporting a clean cancel', async () => {
    const server = unanswerableTool('ponder');
    // The per-request timeout the spec asks clients to enforce, set low enough
    // that the test is a test and not a wait.
    const { host, assets } = await hostWith(server, stdioConfig({ timeoutMs: 25 }));

    const failure = await runNode(moduleOf(host.nodeModules(), 'mcp.formats.ponder'), { assets }).catch((err: unknown) => err);

    // The engine keys cancellation off `name === 'AbortError'` (run.ts). If the
    // timeout ever came back with that name, a workflow that silently timed out
    // would be reported to the user as one they cancelled themselves — and
    // `ctx.signal` was never aborted, so nobody cancelled anything.
    expect((failure as Error).name).toBe('McpCallError');
    expect(failure).toBeInstanceOf(McpCallError);
    expect((failure as McpCallError).tool).toBe('ponder');
    expect((failure as McpCallError).server).toBe('formats');
    expect((failure as Error).message).toContain('Request timed out');
    // A tool that ran out of time on a live connection is not a transport
    // hiccup; the engine must not spend two more attempts discovering that.
    expect(isRetryableError(failure as Error)).toBe(false);

    await host.close();
  });

  it('still calls a real cancellation a cancellation, on the same error code', async () => {
    // The mirror of the case above, sharing McpError(-32001) with it: only
    // `ctx.signal` separates them, so both directions have to be asserted or
    // the fix for one silently breaks the other.
    const server = unanswerableTool('ponder');
    const { host, assets } = await hostWith(server, stdioConfig({ timeoutMs: 60_000 }));
    const controller = new AbortController();

    const running = runNode(moduleOf(host.nodeModules(), 'mcp.formats.ponder'), { assets, signal: controller.signal });
    await new Promise((resolve) => setTimeout(resolve, 5));
    controller.abort();
    const failure = await running.catch((err: unknown) => err);

    expect((failure as Error).name).toBe('AbortError');
    expect(failure).not.toBeInstanceOf(McpCallError);

    await host.close();
  });
});
