/**
 * The APS seam: a suite that asserts an absence (ADR-0001; research §2.4–§2.5).
 *
 * There is no Autodesk Platform Services implementation in Archspace — no
 * registered application, no OAuth flow, no Design Automation pipeline, no
 * GraphQL client. So the thing under test is not behaviour, it is a refusal,
 * and the properties worth pinning are the ones that stop the refusal from
 * decaying into a plausible-looking stub:
 *
 *   1. Every method throws, *synchronously*, and the throw carries the
 *      capability id, the same reason string the settings panel shows, and the
 *      repo path of the empty seam.
 *   2. Nothing reaches the network. This is asserted by replacing
 *      `globalThis.fetch` with a spy that fails loudly if touched — the only
 *      injection point the seam offers, and deliberately so: giving the client
 *      a `fetch` option today would be the first half of a mock, and a mock
 *      here is indistinguishable from a working integration at every call site
 *      (see the file comment in src/aps.ts).
 *   3. Nothing the caller configures escapes into a message, a log line, or a
 *      URL.
 *
 * When a real APS client lands, (2) and (3) are the tests to *rewrite*, not to
 * delete: the fake fetch stops asserting "never called" and starts asserting
 * request shaping — bearer credentials in the Authorization header, never in a
 * query string, never in a log.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  UnimplementedCapabilityError,
  capabilityById,
  createApsClient,
  type ApsClient,
} from '../src/index.js';

/** The four seam methods, with the capability each one refuses on behalf of. */
const METHODS: [keyof ApsClient, string, () => unknown][] = [
  ['authenticate', 'aps-oauth', () => undefined],
  ['queryAecDataModel', 'aps-aec-data-model', () => 'query { hubs { id } }'],
  ['startDesignAutomationWorkItem', 'aps-design-automation-revit', () => ({ activityId: 'x' })],
  ['translateModelDerivative', 'aps-model-derivative', () => 'urn:adsk.objects:os.object:bucket/model.rvt'],
];

/** A value a real client would treat as sensitive, handed in through the only
 *  option the seam accepts. Nothing must ever echo it back. */
const CANARY = 'canary-2f9c-do-not-log';

const call = (client: ApsClient, method: keyof ApsClient, arg: unknown): void => {
  // Deliberately not awaited. The seam throws synchronously precisely so that a
  // caller who forgot the `await` still fails at the line that made the wrong
  // assumption, instead of producing an unhandled rejection somewhere else.
  (client[method] as (a?: unknown) => unknown)(arg);
};

describe('createApsClient — every method refuses', () => {
  const client = createApsClient();

  it.each(METHODS)('%s() throws UnimplementedCapabilityError', (method, capabilityId, arg) => {
    expect(() => call(client, method, arg())).toThrow(UnimplementedCapabilityError);
    try {
      call(client, method, arg());
      expect.unreachable('the seam returned instead of throwing');
    } catch (err) {
      expect(err).toBeInstanceOf(Error);
      const failure = err as UnimplementedCapabilityError;
      expect(failure.name).toBe('UnimplementedCapabilityError');
      expect(failure.capabilityId).toBe(capabilityId);
    }
  });

  it('throws rather than returning a rejected promise', () => {
    // The distinction the src/aps.ts comment makes, asserted: a rejected
    // promise from an un-awaited call becomes a process-level unhandled
    // rejection with no useful stack. If this ever regresses, `expect(...)
    // .toThrow()` above still passes for a thrown value but this one catches
    // the promise-returning variant.
    for (const [method, , arg] of METHODS) {
      let returned: unknown = 'not called';
      expect(() => {
        returned = (client[method] as (a?: unknown) => unknown)(arg());
      }).toThrow();
      expect(returned).toBe('not called');
    }
  });

  it('exposes exactly the four seam methods and nothing that looks like a client', () => {
    // A stray `get`, `post` or `token` here would be the first sign the seam
    // is growing an implementation without a capability row to describe it.
    expect(Object.keys(client).sort()).toEqual([
      'authenticate',
      'queryAecDataModel',
      'startDesignAutomationWorkItem',
      'translateModelDerivative',
    ]);
  });
});

describe('the error is the message the user already saw', () => {
  const client = createApsClient();

  it.each(METHODS)('%s() quotes the capability table verbatim', (method, capabilityId, arg) => {
    // Same text in the thrown error, the settings panel and
    // docs/autodesk-revit.md — there is no second, friendlier version.
    const cap = capabilityById(capabilityId)!;
    expect(cap.status).toBe('not-implemented');
    try {
      call(client, method, arg());
      expect.unreachable();
    } catch (err) {
      const failure = err as UnimplementedCapabilityError;
      expect(failure.reason).toBe(cap.unimplementedReason);
      expect(failure.seam).toBe(cap.seam);
      // Actionable, not a bare throw: what, why, and where the hole is.
      expect(failure.message).toContain(capabilityId);
      expect(failure.message).toContain('is not implemented in Archspace');
      expect(failure.message).toContain(cap.unimplementedReason!);
      expect(failure.message).toContain('Seam: packages/autodesk/');
    }
  });

  it('is catchable narrowly, so a caller can distinguish it from a real failure', () => {
    // `instanceof` has to work for the app to tell "we never built this" apart
    // from "the network is down" — they need different UI, not one error toast.
    try {
      call(client, 'authenticate', undefined);
      expect.unreachable();
    } catch (err) {
      expect(err instanceof UnimplementedCapabilityError).toBe(true);
      expect(err instanceof Error).toBe(true);
    }
  });
});

describe('nothing reaches the network, and nothing leaks', () => {
  const realFetch = globalThis.fetch;
  let fakeFetch: ReturnType<typeof vi.fn>;
  let logs: unknown[][];

  beforeEach(() => {
    fakeFetch = vi.fn(() => {
      throw new Error('the APS seam attempted a network call');
    });
    globalThis.fetch = fakeFetch as unknown as typeof fetch;
    logs = [];
    for (const level of ['debug', 'log', 'info', 'warn', 'error'] as const) {
      vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
        logs.push(args);
      });
    }
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
    vi.restoreAllMocks();
  });

  it('never calls fetch, on any method, however it is configured', () => {
    // The strongest form of "no credential is ever embedded in a URL": no URL
    // is ever built, because no request is ever made. Rewrite this assertion
    // when there is a real client — do not delete it.
    const client = createApsClient({ region: CANARY });
    for (const [method, , arg] of METHODS) {
      expect(() => call(client, method, arg())).toThrow(UnimplementedCapabilityError);
    }
    expect(fakeFetch).not.toHaveBeenCalled();
  });

  it('logs nothing at all', () => {
    // A seam that logs its own arguments is how the first credential leaks:
    // the log line long predates the client that would have redacted it.
    const client = createApsClient({ region: CANARY });
    for (const [method, , arg] of METHODS) {
      expect(() => call(client, method, arg())).toThrow();
    }
    expect(logs).toEqual([]);
  });

  it('echoes back nothing the caller configured', () => {
    const client = createApsClient({ region: CANARY });
    for (const [method, , arg] of METHODS) {
      try {
        call(client, method, arg());
        expect.unreachable();
      } catch (err) {
        const failure = err as UnimplementedCapabilityError;
        expect(failure.message).not.toContain(CANARY);
        expect(JSON.stringify({ ...failure })).not.toContain(CANARY);
        // No endpoint, no query string, nowhere for a secret to ride along.
        expect(failure.message).not.toMatch(/https?:\/\//);
      }
    }
  });

  it('behaves identically whether or not a region is configured', () => {
    // `region` is accepted so callers can wire configuration now without a
    // later shape change; asserting it has no observable effect is what stops
    // the option from implying that a connection is being made to one.
    const configured = createApsClient({ region: 'EMEA' });
    const bare = createApsClient();
    for (const [method, , arg] of METHODS) {
      const a = (() => { try { call(configured, method, arg()); } catch (err) { return (err as Error).message; } })();
      const b = (() => { try { call(bare, method, arg()); } catch (err) { return (err as Error).message; } })();
      expect(a).toBe(b);
    }
  });
});
