/**
 * The browser leg of MCP's OAuth 2.1 flow (research §5, ARCHITECTURE §9.2).
 *
 * The engine child owns the protocol — PKCE, RFC 9728 resource-metadata
 * discovery, the RFC 8707 `resource` parameter — but it cannot open a browser
 * or bind a loopback port that the OS will hand a redirect to. Main can, so
 * main owns exactly two things: `shell.openExternal` and a short-lived
 * `127.0.0.1` listener that catches the authorization code.
 *
 * The port is fixed rather than ephemeral because a native OAuth client has to
 * register its redirect URI *before* the flow starts, and re-registering a new
 * URI on every launch would defeat any authorization server that pins them.
 * 127.0.0.1 (not `localhost`) is deliberate: it cannot be re-pointed by a DNS
 * answer, which is the same class of attack the MCP spec's Origin-validation
 * requirement defends against.
 */
import { shell } from 'electron';
import { createServer, type Server } from 'node:http';
import { OAUTH_REDIRECT_PORT, OAUTH_REDIRECT_URI } from '../shared/protocol';
import { unopenableReason } from './external-url';

export { OAUTH_REDIRECT_PORT, OAUTH_REDIRECT_URI };

/** How long a user gets to complete the browser flow before we give the port back. */
const FLOW_TIMEOUT_MS = 5 * 60 * 1000;

export interface AuthorizationOutcome {
  code: string;
  state?: string;
}

function page(title: string, body: string): string {
  return `<!doctype html><meta charset="utf-8"><title>${title}</title>
<style>
  :root { color-scheme: light dark; }
  body { font: 15px/1.6 -apple-system, BlinkMacSystemFont, system-ui, sans-serif;
         margin: 0; min-height: 100vh; display: grid; place-items: center;
         background: Canvas; color: CanvasText; }
  main { max-width: 30rem; padding: 2rem; text-align: center; }
  h1 { font-size: 1.15rem; margin: 0 0 .5rem; }
  p { margin: 0; opacity: .75; }
</style>
<main><h1>${title}</h1><p>${body}</p></main>`;
}

let active: Server | null = null;

/**
 * Run one authorization. Rejects — rather than hanging — on a denied consent,
 * a mismatched port, or a timeout, because a silent hang here shows up to the
 * user as "the server never connects" with nothing to act on.
 */
export function authorize(server: string, authorizationUrl: string): Promise<AuthorizationOutcome> {
  if (active !== null) {
    return Promise.reject(new Error('Another MCP authorization is already in progress — finish or cancel it first.'));
  }

  // The URL comes from a remote server's OAuth discovery document, and it ends
  // at `shell.openExternal`, which hands whatever it is given to the OS. That
  // is how a scheme like `smb:` or a registered application handler becomes
  // something a hostile — or merely compromised — MCP server can make this
  // machine open, with no dialog, from a settings panel the user thought was
  // about signing in. Only the two schemes an authorization endpoint may
  // actually use get through (RFC 8252 §7.3; OAuth 2.1 requires https, and
  // loopback http is the exception a local dev server needs).
  const rejection = unopenableReason(authorizationUrl);
  if (rejection !== null) {
    return Promise.reject(
      new Error(`MCP server "${server}" asked to open ${rejection}. Nothing was opened. Check the server's address.`),
    );
  }

  return new Promise<AuthorizationOutcome>((resolve, reject) => {
    let settled = false;
    const finish = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const closing = active;
      active = null;
      closing?.close();
      fn();
    };

    const http = createServer((req, res) => {
      const url = new URL(req.url ?? '/', OAUTH_REDIRECT_URI);
      if (url.pathname !== '/callback') {
        res.writeHead(404, { 'content-type': 'text/plain' }).end('not found');
        return;
      }
      const error = url.searchParams.get('error');
      const code = url.searchParams.get('code');
      const state = url.searchParams.get('state') ?? undefined;

      if (error !== null) {
        const description = url.searchParams.get('error_description') ?? error;
        res
          .writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
          .end(page('Authorization declined', 'You can close this tab and return to Archspace.'));
        finish(() => reject(new Error(`Authorization for "${server}" was declined: ${description}`)));
        return;
      }
      if (code === null) {
        res
          .writeHead(400, { 'content-type': 'text/html; charset=utf-8' })
          .end(page('Missing authorization code', 'The authorization server did not return a code.'));
        finish(() => reject(new Error(`Authorization for "${server}" returned no code.`)));
        return;
      }
      res
        .writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
        .end(page('Connected', `Archspace is finishing the connection to “${server}”. You can close this tab.`));
      finish(() => resolve(state === undefined ? { code } : { code, state }));
    });

    const timer = setTimeout(() => {
      finish(() => reject(new Error(`Authorization for "${server}" timed out after 5 minutes.`)));
    }, FLOW_TIMEOUT_MS);

    http.on('error', (err: NodeJS.ErrnoException) => {
      const detail =
        err.code === 'EADDRINUSE'
          ? `port ${OAUTH_REDIRECT_PORT} is already in use — close whatever is holding it and try again`
          : err.message;
      finish(() => reject(new Error(`Could not start the OAuth callback listener: ${detail}`)));
    });

    active = http;
    http.listen(OAUTH_REDIRECT_PORT, '127.0.0.1', () => {
      void shell.openExternal(authorizationUrl).catch((err: unknown) => {
        finish(() => reject(new Error(`Could not open the browser: ${err instanceof Error ? err.message : String(err)}`)));
      });
    });
  });
}

/** Cancel any in-flight flow — called on quit so we never leak the port. */
export function cancelAuthorization(): void {
  active?.close();
  active = null;
}
