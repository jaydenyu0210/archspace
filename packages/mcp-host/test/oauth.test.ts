/**
 * The OAuth 2.1 provider's state parameter (ARCHITECTURE §9.4, ADR-0009).
 *
 * This file exists because the provider had no tests at all, and the one hole
 * in it was the kind a test suite is for. `state()` mints a nonce for every
 * flow, so the authorization server is required to echo it back (RFC 6749
 * §4.1.2) — but the check was written as "if a state came back, it must
 * match", which makes *omitting* the parameter the cheapest way past it.
 *
 * That matters more here than in a web client. The redirect URI is a loopback
 * listener on a fixed port (`OAUTH_REDIRECT_PORT`, chosen fixed so a client
 * registration survives a restart), and it is open for five minutes. Anything
 * that can reach `http://127.0.0.1:33418/callback` in that window — another
 * local process, or a page the user happens to visit — could deliver
 * `?code=<its own>` with no state at all, and the app would exchange it and
 * bind this machine's MCP session to someone else's account.
 *
 * The delegate is a stub rather than a real browser leg: what is under test is
 * the provider's verdict on what the delegate returns, and a real listener
 * would only add a socket to the thing being asserted.
 */
import { describe, expect, it } from 'vitest';
import { MCP_OAUTH_REDIRECT_URI, createOAuthProvider, type McpOAuthDelegate } from '../src/index.js';

/** A delegate that returns exactly what a test tells it to. */
function delegateReturning(result: { code: string; state?: string }): {
  delegate: McpOAuthDelegate;
  authorizeCalls: string[];
  store: Map<string, string | null>;
} {
  const store = new Map<string, string | null>();
  const authorizeCalls: string[] = [];
  return {
    authorizeCalls,
    store,
    delegate: {
      async authorize(_server, authorizationUrl) {
        authorizeCalls.push(authorizationUrl);
        return result;
      },
      async read(server, slot) {
        return store.get(`${server}/${slot}`) ?? null;
      },
      async write(server, slot, json) {
        store.set(`${server}/${slot}`, json);
      },
    },
  };
}

/**
 * A provider whose delegate computes its answer at call time, so a test can
 * echo the nonce `state()` minted after the provider already exists.
 */
function echoingProvider(answer: () => { code: string; state?: string }) {
  return createOAuthProvider({
    server: 'revit',
    delegate: {
      async authorize() {
        return answer();
      },
      async read() {
        return null;
      },
      async write() {
        /* these tests assert on the verdict, not on what is stored */
      },
    },
    clientName: 'Archspace',
    redirectUri: MCP_OAUTH_REDIRECT_URI,
  });
}

function providerFor(result: { code: string; state?: string }) {
  const { delegate, authorizeCalls, store } = delegateReturning(result);
  const provider = createOAuthProvider({
    server: 'revit',
    delegate,
    clientName: 'Archspace',
    redirectUri: MCP_OAUTH_REDIRECT_URI,
  });
  return { provider, authorizeCalls, store };
}

describe('the authorization state parameter', () => {
  it('accepts a response that carries back the state it sent', async () => {
    // The delegate echoes whatever `state()` minted, which is what a
    // conforming authorization server does (RFC 6749 §4.1.2).
    const provider = echoingProvider(() => ({ code: 'good-code', state: minted }));
    const minted = (await provider.state?.()) as string;
    expect(minted).toMatch(/^[0-9a-f]{32}$/);

    await provider.redirectToAuthorization(new URL('https://example.test/authorize'));
    expect(provider.takeAuthorizationCode()).toBe('good-code');
    // Read once and gone, so a second connection cannot replay it.
    expect(provider.takeAuthorizationCode()).toBeUndefined();
  });

  it('REFUSES a response with no state at all', async () => {
    // The regression. Absence used to skip the comparison instead of failing
    // it, which made "send no state" the way past the check.
    const { provider } = providerFor({ code: 'attacker-code' });
    await provider.state?.();

    await expect(provider.redirectToAuthorization(new URL('https://example.test/authorize'))).rejects.toThrow(
      /did not carry back the state parameter/,
    );
    expect(provider.takeAuthorizationCode()).toBeUndefined();
  });

  it('refuses a response carrying somebody else’s state', async () => {
    const { provider } = providerFor({ code: 'attacker-code', state: 'not-the-one-we-sent' });
    await provider.state?.();

    await expect(provider.redirectToAuthorization(new URL('https://example.test/authorize'))).rejects.toThrow(
      /did not carry back the state parameter/,
    );
    expect(provider.takeAuthorizationCode()).toBeUndefined();
  });

  it('says what happened and what to do, not just that it failed', async () => {
    const { provider } = providerFor({ code: 'attacker-code' });
    await provider.state?.();
    // try/catch rather than `.catch(...)`: the SDK types
    // `redirectToAuthorization` as `void | Promise<void>`, so the returned
    // value has no `.then` to hang a handler on.
    let err: Error | null = null;
    try {
      await provider.redirectToAuthorization(new URL('https://example.test/authorize'));
    } catch (caught) {
      err = caught as Error;
    }
    expect(err).not.toBeNull();
    expect(err?.message).toContain('revit');
    expect(err?.message).toContain('Nothing was saved');
    expect(err?.message).toMatch(/start the sign-in again/i);
  });

  it('mints a fresh nonce per flow', async () => {
    // `state()` is typed `string | Promise<string>` by the SDK, hence the
    // await: ours is synchronous, and a test that assumed so would break the
    // day the interface is honoured.
    const { provider } = providerFor({ code: 'c' });
    const seen = new Set<string>();
    for (let i = 0; i < 32; i++) seen.add((await provider.state?.()) as string);
    expect(seen.size).toBe(32);
    for (const s of seen) expect(s).toMatch(/^[0-9a-f]{32}$/);
  });

  it('still refuses a response with no code, once the state checks out', async () => {
    // The state check must not have swallowed the check that follows it.
    const provider = echoingProvider(() => ({ code: '', state: minted }));
    const minted = (await provider.state?.()) as string;
    await expect(provider.redirectToAuthorization(new URL('https://example.test/authorize'))).rejects.toThrow(
      /returned no code/,
    );
  });
});
