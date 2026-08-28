/**
 * Two decisions main makes about untrusted input, both of which used to resolve
 * the wrong way when the input was malformed rather than merely hostile.
 *
 * `parsePluginConsent` guards ADR-0008 §2's boundary. It read a record as
 * ENABLED whenever the record failed to say `false` — so `{}`, a hand-edit, or
 * a write truncated by a power cut granted a plugin the right to run. The CLI
 * reading the same file has always required an explicit boolean and reported
 * what it could not read, so the two disagreed about which plugins were
 * consented on one machine, which is precisely what ADR-0013 §1 says must never
 * happen.
 *
 * `unopenableReason` guards `shell.openExternal`. The URL it judges comes from
 * a remote MCP server's OAuth discovery document — the least trustworthy input
 * this process handles — and `openExternal` hands what it is given to the OS,
 * which will act on `smb:`, `ms-msdt:` or any application-registered scheme.
 *
 * Both are pure, and both are split out of Electron-importing modules for
 * exactly that reason (the pattern `asset-naming.ts` established).
 */
import { describe, expect, it } from 'vitest';
import { parsePluginConsent } from '../src/main/consent';
import { unopenableReason } from '../src/main/external-url';

describe('parsePluginConsent', () => {
  const wellFormed = JSON.stringify({
    'aec-review': { enabled: true, permissions: [] },
    'other-plugin': { enabled: false, permissions: ['net'] },
  });

  it('reads what the app writes, and reports nothing', () => {
    const { consent, issues } = parsePluginConsent(wellFormed);
    expect(issues).toEqual([]);
    expect(consent).toEqual({
      'aec-review': { enabled: true, permissions: [] },
      'other-plugin': { enabled: false, permissions: ['net'] },
    });
  });

  it('treats a missing file as first run, not as a problem', () => {
    expect(parsePluginConsent(null)).toEqual({ consent: {}, issues: [] });
  });

  it('does NOT grant consent to a record that merely failed to refuse it', () => {
    // The regression, and the reason the strict check is worth the words:
    // `{}` used to mean enabled.
    for (const bad of ['{"aec-review": {}}', '{"aec-review": {"permissions": []}}', '{"aec-review": {"enabled": "yes", "permissions": []}}']) {
      const { consent, issues } = parsePluginConsent(bad);
      expect(consent, bad).toEqual({});
      expect(issues.join(' '), bad).toContain('aec-review');
      expect(issues.join(' '), bad).toContain('unconsented');
    }
  });

  it('keeps the records it can read when one beside them is damaged', () => {
    const { consent, issues } = parsePluginConsent(
      JSON.stringify({ good: { enabled: true, permissions: ['net'] }, bad: 'not a record' }),
    );
    expect(consent).toEqual({ good: { enabled: true, permissions: ['net'] } });
    expect(issues).toHaveLength(1);
    expect(issues[0]).toContain('"bad"');
  });

  it('refuses a permissions list that is not all strings', () => {
    // A permission is a capability grant; half-reading one is worse than
    // refusing it.
    const { consent, issues } = parsePluginConsent(JSON.stringify({ p: { enabled: true, permissions: ['net', 7] } }));
    expect(consent).toEqual({});
    expect(issues).toHaveLength(1);
  });

  it('reports damage rather than silently resetting', () => {
    // A consent file that silently empties leaves the user re-consenting to
    // plugins they had already approved, unable to tell a bug from an attack.
    expect(parsePluginConsent('{not json').issues[0]).toContain('not valid JSON');
    expect(parsePluginConsent('[]').issues[0]).toContain('consent object');
    expect(parsePluginConsent('"a string"').issues[0]).toContain('consent object');
  });

  it('copies the permissions array rather than aliasing the parsed one', () => {
    const { consent } = parsePluginConsent(JSON.stringify({ p: { enabled: true, permissions: ['net'] } }));
    consent.p.permissions.push('secrets:x');
    // Re-reading the same text must not see the mutation.
    expect(parsePluginConsent(JSON.stringify({ p: { enabled: true, permissions: ['net'] } })).consent.p.permissions).toEqual(['net']);
  });
});

describe('unopenableReason', () => {
  it('opens the https addresses an authorization endpoint actually uses', () => {
    expect(unopenableReason('https://login.example.com/authorize?client_id=x')).toBeNull();
    expect(unopenableReason('https://example.com:8443/authorize')).toBeNull();
  });

  it('opens plain http only on the loopback host', () => {
    // RFC 8252 §7.3's carve-out, for a local identity server.
    expect(unopenableReason('http://127.0.0.1:9000/authorize')).toBeNull();
    expect(unopenableReason('http://localhost:9000/authorize')).toBeNull();
    expect(unopenableReason('http://[::1]:9000/authorize')).toBeNull();
    // Not for anything else, however it is spelled.
    expect(unopenableReason('http://evil.example.com/authorize')).toContain('insecure');
    expect(unopenableReason('http://127.0.0.1.evil.example.com/authorize')).toContain('insecure');
  });

  it('refuses every scheme that is not a web page', () => {
    for (const url of [
      'smb://attacker.example.com/share',
      'file:///etc/passwd',
      'ms-msdt:/id',
      'javascript:alert(1)',
      'data:text/html,<script>1</script>',
      'vscode://x/y',
    ]) {
      expect(unopenableReason(url), url).not.toBeNull();
    }
  });

  it('refuses something that is not a URL at all', () => {
    expect(unopenableReason('')).toBe('an address that is not a URL');
    expect(unopenableReason('not a url')).toBe('an address that is not a URL');
  });

  it('says what was refused, because that is the whole value of refusing', () => {
    // "authorization failed" is not something a user can act on; "that server
    // asked to open an smb: address" is.
    expect(unopenableReason('smb://x/y')).toContain('"smb"');
    expect(unopenableReason('http://evil.example.com/a')).toContain('evil.example.com');
  });
});
