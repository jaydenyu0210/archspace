/**
 * OAuth 2.1 for remote MCP servers, delegated (ARCHITECTURE §9.2, research §5).
 *
 * On macOS every Revit path in the research is a *remote authenticated* server,
 * so this file is not optional polish — it is the reason the Revit story works
 * at all from a Mac.
 *
 * The protocol work — PKCE S256, RFC 9728 protected-resource discovery from the
 * 401, RFC 8414/OIDC authorization-server metadata, the RFC 8707 `resource`
 * parameter, refresh, dynamic registration — is the SDK's `auth()` orchestrator.
 * What the SDK deliberately does not decide is *where the browser lives* and
 * *where the tokens rest*, and neither of those belongs in a headless package:
 * the browser leg needs a window and a loopback listener (Electron main), and
 * the tokens need the Keychain via `safeStorage`. So this file is the adapter:
 * an `OAuthClientProvider` whose every side-effecting method is a call into an
 * `McpOAuthDelegate` the app supplies.
 *
 * Two safety properties are enforced here rather than assumed of the delegate:
 * the `state` parameter we generate is the one that must come back, and a
 * refusal to authorize surfaces as a plain error rather than a hung connect.
 */
import type { OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js';
import {
  OAuthClientInformationSchema,
  OAuthTokensSchema,
  type OAuthClientInformationMixed,
  type OAuthClientMetadata,
  type OAuthTokens,
} from '@modelcontextprotocol/sdk/shared/auth.js';

export type OAuthStoreSlot = 'client-information' | 'tokens' | 'code-verifier';

export interface McpOAuthDelegate {
  /** Run the browser leg; resolve with the authorization code. */
  authorize(server: string, authorizationUrl: string, redirectUri: string): Promise<{ code: string; state?: string }>;
  read(server: string, slot: OAuthStoreSlot): Promise<string | null>;
  write(server: string, slot: OAuthStoreSlot, json: string | null): Promise<void>;
}

/**
 * The loopback redirect. Fixed rather than ephemeral so a client registration
 * survives an app restart, and `127.0.0.1` rather than `localhost` so no DNS
 * answer can re-point it — the rebinding class the MCP transport spec warns
 * about. `packages/app/src/shared/protocol.ts` pins the identical value for the
 * listener main opens; the two must agree or the flow dead-ends at the browser.
 */
export const OAUTH_REDIRECT_PORT = 33418;
export const MCP_OAUTH_REDIRECT_URI = `http://127.0.0.1:${OAUTH_REDIRECT_PORT}/callback`;

export interface DelegatedOAuthProvider extends OAuthClientProvider {
  /**
   * The code the delegate returned during the last authorization leg, removed
   * as it is read. The SDK's `auth()` ends a fresh authorization by returning
   * 'REDIRECT' — it has no way to hand us a code — so the connection code takes
   * the code from here and completes the exchange with `finishAuth`.
   */
  takeAuthorizationCode(): string | undefined;
}

function randomState(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

export function createOAuthProvider(opts: {
  server: string;
  delegate: McpOAuthDelegate;
  redirectUri?: string;
  clientName?: string;
  clientUri?: string;
}): DelegatedOAuthProvider {
  const { server, delegate } = opts;
  const redirectUri = opts.redirectUri ?? MCP_OAUTH_REDIRECT_URI;
  let expectedState: string | undefined;
  let pendingCode: string | undefined;

  const metadata: OAuthClientMetadata = {
    redirect_uris: [redirectUri],
    client_name: opts.clientName ?? 'Archspace',
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
    // OAuth 2.1 public client: no secret to leak from a desktop binary; PKCE is
    // what proves possession, and the SDK refuses any AS that lacks S256.
    token_endpoint_auth_method: 'none',
    ...(opts.clientUri !== undefined ? { client_uri: opts.clientUri } : {}),
  };

  return {
    get redirectUrl() {
      return redirectUri;
    },
    get clientMetadata() {
      return metadata;
    },

    state(): string {
      expectedState = randomState();
      return expectedState;
    },

    async clientInformation(): Promise<OAuthClientInformationMixed | undefined> {
      const json = await delegate.read(server, 'client-information');
      if (!json) return undefined;
      const parsed = OAuthClientInformationSchema.safeParse(safeJson(json));
      // Unreadable stored registration ⇒ behave as unregistered, so the next
      // auth attempt re-registers instead of failing forever on stale bytes.
      return parsed.success ? parsed.data : undefined;
    },

    async saveClientInformation(clientInformation: OAuthClientInformationMixed): Promise<void> {
      await delegate.write(server, 'client-information', JSON.stringify(clientInformation));
    },

    async tokens(): Promise<OAuthTokens | undefined> {
      const json = await delegate.read(server, 'tokens');
      if (!json) return undefined;
      const parsed = OAuthTokensSchema.safeParse(safeJson(json));
      return parsed.success ? parsed.data : undefined;
    },

    async saveTokens(tokens: OAuthTokens): Promise<void> {
      await delegate.write(server, 'tokens', JSON.stringify(tokens));
    },

    async saveCodeVerifier(codeVerifier: string): Promise<void> {
      await delegate.write(server, 'code-verifier', JSON.stringify({ codeVerifier }));
    },

    async codeVerifier(): Promise<string> {
      const json = await delegate.read(server, 'code-verifier');
      const value = json ? (safeJson(json) as { codeVerifier?: unknown } | null) : null;
      if (!value || typeof value.codeVerifier !== 'string') {
        throw new Error(`MCP server "${server}": no PKCE code verifier is stored, so the authorization code cannot be exchanged. Start the sign-in again.`);
      }
      return value.codeVerifier;
    },

    async redirectToAuthorization(authorizationUrl: URL): Promise<void> {
      const result = await delegate.authorize(server, authorizationUrl.toString(), redirectUri);
      // A MISSING state is a failed check, not a skipped one.
      //
      // `state()` above mints one for every flow, so the authorization server
      // is required to echo it back (RFC 6749 §4.1.2) and a response without
      // one did not come from a flow we started. Treating absence as "nothing
      // to compare" made omitting the parameter the cheapest way past the
      // check: the redirect URI is a loopback listener on a fixed port, so any
      // local process — or any page the user visits while the five-minute
      // window is open — could deliver `?code=<attacker's>` with no state, and
      // the app would exchange it and bind this machine's session to someone
      // else's account. Rejecting an absent state is the entire point of
      // sending one.
      if (expectedState !== undefined && result.state !== expectedState) {
        throw new Error(
          `MCP server "${server}": the authorization response did not carry back the state parameter this ` +
            `sign-in sent, so it did not come from the page you were shown. Nothing was saved. Start the ` +
            `sign-in again, and if it keeps happening, sign in with no other browser tabs open.`,
        );
      }
      if (!result.code) {
        throw new Error(`MCP server "${server}": the authorization flow returned no code.`);
      }
      pendingCode = result.code;
    },

    async invalidateCredentials(scope: 'all' | 'client' | 'tokens' | 'verifier' | 'discovery'): Promise<void> {
      if (scope === 'all' || scope === 'client') await delegate.write(server, 'client-information', null);
      if (scope === 'all' || scope === 'tokens') await delegate.write(server, 'tokens', null);
      if (scope === 'all' || scope === 'verifier') await delegate.write(server, 'code-verifier', null);
    },

    takeAuthorizationCode(): string | undefined {
      const code = pendingCode;
      pendingCode = undefined;
      return code;
    },
  };
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
