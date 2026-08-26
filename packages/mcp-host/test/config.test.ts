/**
 * The mcp.yaml codec: logical name → local binding (ARCHITECTURE §9.1 /
 * ADR-0009 decision 1, ADR-0013 §2).
 *
 * This file is a *compatibility surface* in three directions at once, which is
 * why it earns its own suite:
 *
 *   1. **Workflows name servers by this name.** `mcp.revit.get_elements` in a
 *      committed document resolves through `servers.revit` here, so the set of
 *      names `isValidServerName` accepts is a contract between a file in git
 *      and a file that is never in git. Widening it later is fine; narrowing it
 *      breaks documents that already parse.
 *   2. **The file is hand-edited and diffed.** Parsing is therefore tolerant
 *      and *reporting* — one malformed server must not cost the user every
 *      other binding — and serialization is deterministic, or the app rewriting
 *      settings would churn a file the user keeps in version control.
 *   3. **`sameServerConfig` decides whether a live session dies.** Settings are
 *      rewritten wholesale on every edit, so this predicate is the only thing
 *      standing between renaming an AI profile and killing a healthy Revit
 *      connection (see `configure()` in host.ts).
 *
 * The security property under all of it: secrets are named by KEY, never by
 * value. No test here may ever put a token in a config.
 */
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_REQUEST_TIMEOUT_MS,
  DEFAULT_SERVER_CONCURRENCY,
  MCP_CONFIG_FILENAME,
  defaultMcpConfig,
  describeBinding,
  isValidServerName,
  mcpNodeType,
  parseMcpConfig,
  sameServerConfig,
  serializeMcpConfig,
  type ConfigIssue,
  type McpBinding,
  type McpConfig,
  type McpServerConfig,
} from '../src/index.js';

/** Issue paths are what the settings panel points at; assert on those. */
function paths(issues: ConfigIssue[], severity?: ConfigIssue['severity']): string[] {
  return issues.filter((i) => severity === undefined || i.severity === severity).map((i) => i.path);
}

function parse(text: string): { config: McpConfig; issues: ConfigIssue[] } {
  return parseMcpConfig(text);
}

const STDIO: McpServerConfig = {
  binding: {
    transport: 'stdio',
    command: ['uvx', 'archspace-formats-server', '--strict'],
    env: { ARCHSPACE_FORMATS_CACHE: '/tmp/formats' },
    cwd: '/Users/tester/projects/tower',
  },
  enabled: true,
  description: 'IFC/DXF conversions',
  timeoutMs: 120_000,
  concurrency: 2,
  trustReadOnlyHint: true,
};

const HTTP: McpServerConfig = {
  binding: {
    transport: 'http',
    url: 'https://revit-agent.office.example:8443/mcp',
    auth: 'bearer',
    // A KEY into the keychain. If this ever reads like a token, the test is wrong.
    bearerTokenRef: 'revit_bridge_token',
    headers: { 'X-Archspace-Client': 'desktop' },
  },
  enabled: false,
  timeoutMs: 30_000,
};

describe('parse ⇄ serialize', () => {
  it('round-trips both binding shapes with every optional field intact', () => {
    const config: McpConfig = { servers: { formats: STDIO, revit: HTTP } };

    const { config: back, issues } = parse(serializeMcpConfig(config));

    expect(issues).toEqual([]);
    expect(back).toEqual(config);
  });

  it('is deterministic: the same config always produces the same bytes', () => {
    // Same servers, opposite insertion order — a settings panel rebuilding the
    // object must not produce a diff in a file the user has in git.
    const a: McpConfig = { servers: { formats: STDIO, revit: HTTP } };
    const b: McpConfig = { servers: { revit: HTTP, formats: STDIO } };

    expect(serializeMcpConfig(a)).toBe(serializeMcpConfig(b));
    // …and stable under a second trip, which is what "canonical" has to mean.
    expect(serializeMcpConfig(parse(serializeMcpConfig(a)).config)).toBe(serializeMcpConfig(a));
  });

  it('writes the binding flat, the way a human hand-editing this file expects', () => {
    const text = serializeMcpConfig({ servers: { formats: { binding: { transport: 'stdio', command: ['uvx', 'srv'] }, enabled: true } } });

    // `transport` and `command` are siblings of `enabled`; the in-memory shape
    // nests the binding only so the discriminated union stays honest.
    expect(text).toContain('servers:');
    expect(text).toMatch(/formats:\n\s+transport: stdio\n\s+command:\n\s+- uvx\n\s+- srv\n\s+enabled: true/);
    // The header teaches the format instead of shipping invented bindings.
    expect(text.startsWith('# Archspace')).toBe(true);
    expect(parse(text).config.servers.formats.binding).toEqual({ transport: 'stdio', command: ['uvx', 'srv'] });
  });

  it('treats an empty, blank or server-less document as "nothing is bound"', () => {
    for (const text of ['', '\n', '# just a comment\n', 'servers:\n', 'servers: null\n']) {
      const { config, issues } = parse(text);
      expect(config, text).toEqual(defaultMcpConfig());
      expect(issues, text).toEqual([]);
    }
    expect(defaultMcpConfig()).toEqual({ servers: {} });
  });
});

describe('isValidServerName', () => {
  // A workflow document writes this name down, so the accepted set is a
  // compatibility contract, not a style preference.
  const ACCEPTED = ['revit', 'formats', 'a', 'a1', 'my_server_2', 'x_'];
  const REFUSED = ['', 'Revit', 'REVIT', '1revit', '_revit', 'revit-agent', 'revit.agent', 'revit agent', 'revit ', ' revit', 'révit', 'revit\n', 'mcp/revit'];

  it.each(ACCEPTED)('accepts %o', (name) => {
    expect(isValidServerName(name)).toBe(true);
  });

  it.each(REFUSED)('refuses %o', (name) => {
    expect(isValidServerName(name)).toBe(false);
  });

  it('accepts exactly the names that make a legal node type', () => {
    // `mcp.<server>.<tool>` — the server segment is used verbatim, so anything
    // this predicate accepts must already be in the node-type alphabet.
    for (const name of ACCEPTED) {
      expect(mcpNodeType(name, 'get_elements')).toBe(`mcp.${name}.get_elements`);
      expect(mcpNodeType(name, 'get_elements')).toMatch(/^mcp\.[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$/);
    }
  });

  it('drops a badly named server with an error and keeps every other binding', () => {
    const { config, issues } = parse(`
servers:
  Revit:
    transport: stdio
    command: ["revit-bridge"]
  formats:
    transport: stdio
    command: ["uvx", "archspace-formats-server"]
`);

    // Tolerant and reporting: one bad entry must not cost the user the rest.
    expect(Object.keys(config.servers)).toEqual(['formats']);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ severity: 'error', path: 'servers.Revit' });
    expect(issues[0].message).toContain('not a valid logical server name');
  });
});

describe('malformed config produces issues, not exceptions', () => {
  it('reports YAML that does not parse at all', () => {
    const { config, issues } = parse('servers:\n  formats:\n   - [unbalanced\n');

    expect(config).toEqual(defaultMcpConfig());
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ severity: 'error', path: '' });
    expect(issues[0].message).toContain('not valid YAML');
  });

  it.each([
    ['a scalar document', '"just a string"\n', ''],
    ['servers as a list', 'servers:\n  - formats\n', 'servers'],
    ['a server that is not a mapping', 'servers:\n  formats: "uvx archspace-formats-server"\n', 'servers.formats'],
    ['an unknown transport', 'servers:\n  formats:\n    transport: websocket\n', 'servers.formats.transport'],
    ['a missing transport', 'servers:\n  formats:\n    command: ["uvx"]\n', 'servers.formats.transport'],
    ['stdio with no argv', 'servers:\n  formats:\n    transport: stdio\n    command: []\n', 'servers.formats.command'],
    ['stdio with a string command', 'servers:\n  formats:\n    transport: stdio\n    command: "uvx srv"\n', 'servers.formats.command'],
    ['http with no url', 'servers:\n  revit:\n    transport: http\n', 'servers.revit.url'],
    ['http with a nonsense url', 'servers:\n  revit:\n    transport: http\n    url: "revit-agent:8443"\n', 'servers.revit.url'],
    ['http over an unsupported scheme', 'servers:\n  revit:\n    transport: http\n    url: "ftp://revit-agent.example/mcp"\n', 'servers.revit.url'],
    ['an unknown auth mode', 'servers:\n  revit:\n    transport: http\n    url: "https://revit.example/mcp"\n    auth: mtls\n', 'servers.revit.auth'],
  ])('drops %s with an error at %s', (_label, text, path) => {
    const { config, issues } = parse(text);

    expect(config.servers).toEqual({});
    expect(paths(issues, 'error')).toContain(path);
  });

  it('warns but keeps the binding when only an advisory field is wrong', () => {
    const { config, issues } = parse(`
servers:
  formats:
    transport: stdio
    command: ["uvx", "srv"]
    env: {ARCHSPACE_DEBUG: 1}
    cwd: 42
    enabled: "yes"
    description: ["not", "a", "string"]
    timeoutMs: -5
    concurrency: 0
    trustReadOnlyHint: "sure"
`);

    const formats = config.servers.formats;
    expect(formats.binding).toEqual({ transport: 'stdio', command: ['uvx', 'srv'] });
    // Every rejected field falls back to its default rather than to nothing.
    expect(formats.timeoutMs).toBeUndefined();
    expect(formats.concurrency).toBeUndefined();
    expect(formats.description).toBeUndefined();
    expect(formats.trustReadOnlyHint).toBeUndefined();
    // `enabled` is the one that is not advisory: an unreadable value is not a
    // licence to start a subprocess, so it reads as false.
    expect(formats.enabled).toBe(false);
    expect(paths(issues, 'error')).toEqual([]);
    expect(paths(issues, 'warning').sort()).toEqual([
      'servers.formats.concurrency',
      'servers.formats.cwd',
      'servers.formats.description',
      'servers.formats.enabled',
      'servers.formats.env',
      'servers.formats.timeoutMs',
      'servers.formats.trustReadOnlyHint',
    ]);
    expect(issues.find((i) => i.path === 'servers.formats.timeoutMs')?.message).toContain(String(DEFAULT_REQUEST_TIMEOUT_MS));
    expect(issues.find((i) => i.path === 'servers.formats.concurrency')?.message).toContain(String(DEFAULT_SERVER_CONCURRENCY));
  });

  it('treats an absent `enabled` as enabled — the user wrote the binding to use it', () => {
    const { config, issues } = parse('servers:\n  formats:\n    transport: stdio\n    command: ["uvx", "srv"]\n');

    expect(config.servers.formats.enabled).toBe(true);
    expect(issues).toEqual([]);
  });

  it('warns about plaintext http to a non-loopback host but still binds it', () => {
    const { config, issues } = parse('servers:\n  revit:\n    transport: http\n    url: "http://10.0.0.4:8443/mcp"\n');

    // Allowed — developers run local bridges — but never silent.
    expect(config.servers.revit.binding).toMatchObject({ transport: 'http', url: 'http://10.0.0.4:8443/mcp' });
    expect(issues).toHaveLength(1);
    expect(issues[0].severity).toBe('warning');
    expect(issues[0].message).toContain('unencrypted');
  });

  it.each(['http://127.0.0.1:8443/mcp', 'http://localhost:8443/mcp'])(
    'says nothing about plaintext http to the loopback interface (%s)',
    (url) => {
      expect(parse(`servers:\n  revit:\n    transport: http\n    url: "${url}"\n`).issues).toEqual([]);
    },
  );

  it('says nothing about plaintext http to the IPv6 loopback either', () => {
    // This was red when it was written, and the defect it found is now fixed:
    // the parser exempted three loopback spellings, `::1` among them, but
    // compared against `URL.hostname`, which for an IPv6 literal is the
    // *bracketed* form `[::1]`. The `'::1'` arm could therefore never match,
    // and a developer running a bridge on the IPv6 loopback was told their
    // credentials travel unencrypted over a link that never leaves the host.
    // It failed safe (an extra warning, never a missing one), which is exactly
    // why nothing had noticed it — and why it needs a test to stay fixed.
    expect(parse('servers:\n  revit:\n    transport: http\n    url: "http://[::1]:8443/mcp"\n').issues).toEqual([]);
  });

  it('warns when bearer auth names no secret to send', () => {
    const { config, issues } = parse('servers:\n  revit:\n    transport: http\n    url: "https://revit.example/mcp"\n    auth: bearer\n');

    // Still bound: the fix is to name a key, and the connect attempt says so
    // again with a "Sign in" affordance rather than failing generically.
    expect(config.servers.revit.binding).toMatchObject({ auth: 'bearer' });
    expect(paths(issues, 'warning')).toEqual(['servers.revit.bearerTokenRef']);
  });

  it('names the file the user has to go and fix', () => {
    expect(MCP_CONFIG_FILENAME).toBe('mcp.yaml');
  });
});

describe('describeBinding — the status panel target, never a credential', () => {
  it.each<[string, McpBinding, string]>([
    ['stdio argv joined', { transport: 'stdio', command: ['uvx', 'archspace-formats-server', '--strict'] }, 'uvx archspace-formats-server --strict'],
    ['http with the query string dropped', { transport: 'http', url: 'https://revit.example/mcp?access_token=abc123' }, 'https://revit.example/mcp'],
    ['http with userinfo dropped', { transport: 'http', url: 'https://svc:hunter2@revit.example/mcp' }, 'https://revit.example/mcp'],
    ['an unparseable url verbatim', { transport: 'http', url: 'not a url' }, 'not a url'],
  ])('%s', (_label, binding, expected) => {
    expect(describeBinding(binding)).toBe(expected);
  });
});

describe('sameServerConfig — does this edit need a reconnect?', () => {
  const base: McpServerConfig = { binding: { transport: 'stdio', command: ['uvx', 'srv'] }, enabled: true };

  it('is true for a config that only differs in advisory fields', () => {
    // These change nothing about the session, and a reconnect here is the bug
    // `configure()` exists to avoid: a wholesale settings rewrite must not kill
    // a healthy Revit connection.
    expect(sameServerConfig(base, { ...base })).toBe(true);
    expect(sameServerConfig(base, { ...base, description: 'Format conversions' })).toBe(true);
    expect(sameServerConfig(base, { ...base, trustReadOnlyHint: true })).toBe(true);
  });

  it.each<[string, McpServerConfig]>([
    ['a different executable', { ...base, binding: { transport: 'stdio', command: ['uv', 'srv'] } }],
    ['a different argument', { ...base, binding: { transport: 'stdio', command: ['uvx', 'srv', '--strict'] } }],
    ['reordered arguments', { ...base, binding: { transport: 'stdio', command: ['srv', 'uvx'] } }],
    ['an added env var', { ...base, binding: { transport: 'stdio', command: ['uvx', 'srv'], env: { DEBUG: '1' } } }],
    ['a working directory', { ...base, binding: { transport: 'stdio', command: ['uvx', 'srv'], cwd: '/tmp' } }],
    ['a different transport', { ...base, binding: { transport: 'http', url: 'https://revit.example/mcp' } }],
    ['the enable toggle', { ...base, enabled: false }],
    ['a different request timeout', { ...base, timeoutMs: 5_000 }],
    ['a different lane cap', { ...base, concurrency: 4 }],
  ])('is false for %s', (_label, other) => {
    expect(sameServerConfig(base, other)).toBe(false);
    expect(sameServerConfig(other, base)).toBe(false);
  });

  it('is false for any http field the session is actually dialled with', () => {
    const http: McpServerConfig = { binding: { transport: 'http', url: 'https://revit.example/mcp', auth: 'bearer', bearerTokenRef: 'tok_a' }, enabled: true };
    expect(sameServerConfig(http, { ...http, binding: { ...http.binding, url: 'https://revit.example/mcp/v2' } as typeof http.binding })).toBe(false);
    expect(sameServerConfig(http, { ...http, binding: { ...http.binding, bearerTokenRef: 'tok_b' } as typeof http.binding })).toBe(false);
    expect(sameServerConfig(http, { ...http, binding: { ...http.binding, headers: { 'X-Client': 'desktop' } } as typeof http.binding })).toBe(false);
  });

  it('treats an absent auth mode and an explicit "none" as the same binding', () => {
    const implicit: McpServerConfig = { binding: { transport: 'http', url: 'https://revit.example/mcp' }, enabled: true };
    const explicit: McpServerConfig = { binding: { transport: 'http', url: 'https://revit.example/mcp', auth: 'none' }, enabled: true };

    // Round-tripping the file must not change the answer.
    expect(sameServerConfig(implicit, explicit)).toBe(true);
  });

  it('ignores the order the user happened to write env vars in', () => {
    // This was red when it was written, and the defect it found is now fixed:
    // `normalizeForCompare` handed `env` (and `headers`) straight to
    // `JSON.stringify`, so the comparison was byte equality of a serialization
    // whose key order is whatever the YAML happened to say. `manifest.ts` had
    // already learned this lesson and canonicalises keys before hashing for
    // exactly this reason; this predicate had not.
    //
    // The scenario: the user hand-edits mcp.yaml and moves one env line above
    // another. Nothing about the session changed — same executable, same
    // environment — so this must not be a reconnect. `configure()` turns a
    // `false` here into a teardown of a live connection, which is precisely
    // the "renamed an unrelated setting, lost my Revit session" failure the
    // predicate exists to prevent.
    const written: McpServerConfig = { ...base, binding: { transport: 'stdio', command: ['uvx', 'srv'], env: { ARCHSPACE_CACHE: '/tmp', ARCHSPACE_LOG: 'debug' } } };
    const reordered: McpServerConfig = { ...base, binding: { transport: 'stdio', command: ['uvx', 'srv'], env: { ARCHSPACE_LOG: 'debug', ARCHSPACE_CACHE: '/tmp' } } };

    expect(sameServerConfig(written, reordered)).toBe(true);
  });
});
