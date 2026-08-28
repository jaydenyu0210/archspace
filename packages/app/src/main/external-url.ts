/**
 * What this app is willing to hand to the operating system.
 *
 * Split from `oauth.ts` for the reason `asset-naming.ts` is split from
 * `assets.ts`: the decision is pure, the module it came from cannot be imported
 * without an Electron runtime, and a wrong answer here is `shell.openExternal`
 * launching whatever a remote server named.
 *
 * The URL an OAuth flow opens comes out of a remote MCP server's discovery
 * document — the least trustworthy input this process handles — and
 * `shell.openExternal` passes what it is given to the OS, which will happily
 * act on `smb:`, `ms-msdt:`, or any application-registered scheme. So the check
 * is an ALLOWLIST. The set of schemes an OS acts on is open-ended and
 * platform-specific, so enumerating the dangerous ones is a race nobody wins;
 * enumerating the two an authorization endpoint may legitimately use is a
 * closed question with an answer in a spec.
 */

/** Hosts for which plain `http` is permitted — RFC 8252 §7.3's loopback carve-out. */
const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1', '[::1]', 'localhost']);

/**
 * Why a URL must not be opened, phrased for a person, or `null` if it may be.
 *
 * A reason rather than a boolean, because the message a user sees is the whole
 * value of refusing: "that server asked to open an smb: address" is something
 * they can act on, and "authorization failed" is not.
 */
export function unopenableReason(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return 'an address that is not a URL';
  }
  // OAuth 2.1 requires an https authorization endpoint.
  if (parsed.protocol === 'https:') return null;
  if (parsed.protocol === 'http:') {
    // The one exception, and only for the loopback host itself: a developer
    // running a local identity server. `localhost` is included because it is
    // what such a server prints, though `127.0.0.1` is the safer spelling —
    // no DNS answer can re-point a literal address.
    if (LOOPBACK_HOSTS.has(parsed.hostname)) return null;
    return `an insecure address (${parsed.protocol}//${parsed.host})`;
  }
  return `a "${parsed.protocol.replace(/:$/, '')}" address, which is not a web page`;
}
