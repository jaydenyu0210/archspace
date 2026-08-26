/**
 * mcp.yaml — the machine-local binding of logical MCP server names to what they
 * actually launch or dial (ARCHITECTURE §9.1 / ADR-0009 decision 1).
 *
 * The split this file encodes is load-bearing, not cosmetic. A workflow says
 * `mcp.revit.get_elements`; only this file says that `revit` is an HTTPS
 * endpoint on a colleague's Windows box behind OAuth. That is what keeps
 * workflows shareable (no absolute paths, no URLs, no credentials in git) and
 * what stops a cloned repository from making your machine execute a command.
 *
 * Parsing is deliberately tolerant and reporting: one malformed server must not
 * cost the user every other binding, so bad entries are dropped with an issue
 * rather than thrown on. Serialization is deterministic — the same config always
 * produces the same bytes — because this file is hand-editable and diffable and
 * the app rewrites it whenever settings change.
 *
 * Secrets are stored by KEY here, never by value (ARCHITECTURE §6.1, §11): a
 * bearer token lives in the keychain and `bearerTokenRef` names it.
 */
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';

export type McpTransportKind = 'stdio' | 'http';

export interface McpStdioBinding {
  transport: 'stdio';
  command: string[]; // argv; command[0] is the executable
  env?: Record<string, string>;
  cwd?: string;
}

export interface McpHttpBinding {
  transport: 'http'; // MCP Streamable HTTP
  url: string;
  auth?: 'none' | 'oauth' | 'bearer';
  /** Secret KEY for the bearer token — never the token itself. */
  bearerTokenRef?: string;
  headers?: Record<string, string>;
}

export type McpBinding = McpStdioBinding | McpHttpBinding;

export interface McpServerConfig {
  binding: McpBinding;
  enabled: boolean;
  description?: string;
  /** Per-request timeout (spec: clients SHOULD enforce one). Default 60_000. */
  timeoutMs?: number;
  /** Lane cap override for `mcp:<name>`; default 1 (ARCHITECTURE §7.2). */
  concurrency?: number;
  /** User override of the per-spec-advisory `readOnlyHint` cache gamble (§9.3). */
  trustReadOnlyHint?: boolean;
}

export interface McpConfig {
  servers: Record<string, McpServerConfig>;
}

export interface ConfigIssue {
  severity: 'error' | 'warning';
  path: string;
  message: string;
}

export const MCP_CONFIG_FILENAME = 'mcp.yaml';

/** Spec advice is "enforce a timeout"; 60 s matches the SDK's own default. */
export const DEFAULT_REQUEST_TIMEOUT_MS = 60_000;

/** Serial per server unless the user says otherwise (ARCHITECTURE §7.2). */
export const DEFAULT_SERVER_CONCURRENCY = 1;

/** Logical names are workflow-visible identifiers: [a-z][a-z0-9_]*. */
const SERVER_NAME = /^[a-z][a-z0-9_]*$/;

/** The interface that never leaves the machine, in every spelling `URL` emits. */
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

export function isValidServerName(name: string): boolean {
  return SERVER_NAME.test(name);
}

/**
 * A fresh install binds nothing. Inventing plausible-looking bindings would put
 * servers in the status panel that were never going to connect, and teach the
 * user that red is normal; the commented examples in the serialized header do
 * the teaching instead.
 */
export function defaultMcpConfig(): McpConfig {
  return { servers: {} };
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function isStringMap(v: unknown): v is Record<string, string> {
  return isRecord(v) && Object.values(v).every((x) => typeof x === 'string');
}

function parseBinding(
  raw: Record<string, unknown>,
  path: string,
  issues: ConfigIssue[],
): McpBinding | null {
  // The binding is written flat in YAML (transport/url/command as siblings of
  // `enabled`) because that is what a human hand-editing this file expects; the
  // in-memory shape nests it so the discriminated union stays honest.
  const transport = raw.transport;
  if (transport === 'stdio') {
    const command = raw.command;
    if (!Array.isArray(command) || command.length === 0 || !command.every((c) => typeof c === 'string')) {
      issues.push({ severity: 'error', path: `${path}.command`, message: 'stdio binding needs a non-empty argv array of strings' });
      return null;
    }
    const binding: McpStdioBinding = { transport: 'stdio', command: command as string[] };
    if (raw.env !== undefined) {
      if (isStringMap(raw.env)) binding.env = raw.env;
      else issues.push({ severity: 'warning', path: `${path}.env`, message: 'env must be a map of string to string; ignored' });
    }
    if (raw.cwd !== undefined) {
      if (typeof raw.cwd === 'string') binding.cwd = raw.cwd;
      else issues.push({ severity: 'warning', path: `${path}.cwd`, message: 'cwd must be a string; ignored' });
    }
    return binding;
  }

  if (transport === 'http') {
    if (typeof raw.url !== 'string' || raw.url.length === 0) {
      issues.push({ severity: 'error', path: `${path}.url`, message: 'http binding needs a url' });
      return null;
    }
    let url: URL;
    try {
      url = new URL(raw.url);
    } catch {
      issues.push({ severity: 'error', path: `${path}.url`, message: `not a valid URL: ${raw.url}` });
      return null;
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      issues.push({ severity: 'error', path: `${path}.url`, message: `unsupported scheme "${url.protocol}"; use http or https` });
      return null;
    }
    // Plain http to anything but the loopback interface ships bearer tokens in
    // clear text. It is allowed (developers run local bridges) but never silent.
    // `URL.hostname` keeps an IPv6 literal in its bracketed form, so the
    // loopback spelling a user writes as `http://[::1]:8443` arrives here as
    // `[::1]` and never as `::1`; both are listed or the exemption is dead code.
    if (url.protocol === 'http:' && !LOOPBACK_HOSTS.has(url.hostname)) {
      issues.push({ severity: 'warning', path: `${path}.url`, message: 'plaintext http to a non-loopback host: credentials and tool arguments travel unencrypted' });
    }
    const binding: McpHttpBinding = { transport: 'http', url: raw.url };
    if (raw.auth !== undefined) {
      if (raw.auth === 'none' || raw.auth === 'oauth' || raw.auth === 'bearer') binding.auth = raw.auth;
      else {
        issues.push({ severity: 'error', path: `${path}.auth`, message: `auth must be "none", "oauth" or "bearer"; got ${JSON.stringify(raw.auth)}` });
        return null;
      }
    }
    if (raw.bearerTokenRef !== undefined) {
      if (typeof raw.bearerTokenRef === 'string') binding.bearerTokenRef = raw.bearerTokenRef;
      else issues.push({ severity: 'warning', path: `${path}.bearerTokenRef`, message: 'bearerTokenRef must be a secret key string; ignored' });
    }
    if (binding.auth === 'bearer' && binding.bearerTokenRef === undefined) {
      issues.push({ severity: 'warning', path: `${path}.bearerTokenRef`, message: 'auth is "bearer" but no bearerTokenRef names the secret to send' });
    }
    if (raw.headers !== undefined) {
      if (isStringMap(raw.headers)) binding.headers = raw.headers;
      else issues.push({ severity: 'warning', path: `${path}.headers`, message: 'headers must be a map of string to string; ignored' });
    }
    return binding;
  }

  issues.push({
    severity: 'error',
    path: `${path}.transport`,
    message: `transport must be "stdio" or "http"; got ${JSON.stringify(transport)}`,
  });
  return null;
}

function parseServer(raw: unknown, path: string, issues: ConfigIssue[]): McpServerConfig | null {
  if (!isRecord(raw)) {
    issues.push({ severity: 'error', path, message: 'server entry must be a mapping' });
    return null;
  }
  const binding = parseBinding(raw, path, issues);
  if (!binding) return null;

  const config: McpServerConfig = {
    binding,
    // Absent `enabled` means enabled: a user who wrote the binding meant to use it.
    enabled: raw.enabled === undefined ? true : raw.enabled === true,
  };
  if (raw.enabled !== undefined && typeof raw.enabled !== 'boolean') {
    issues.push({ severity: 'warning', path: `${path}.enabled`, message: 'enabled must be a boolean; treated as false' });
  }
  if (raw.description !== undefined) {
    if (typeof raw.description === 'string') config.description = raw.description;
    else issues.push({ severity: 'warning', path: `${path}.description`, message: 'description must be a string; ignored' });
  }
  if (raw.timeoutMs !== undefined) {
    if (typeof raw.timeoutMs === 'number' && Number.isFinite(raw.timeoutMs) && raw.timeoutMs > 0) config.timeoutMs = raw.timeoutMs;
    else issues.push({ severity: 'warning', path: `${path}.timeoutMs`, message: `timeoutMs must be a positive number; using ${DEFAULT_REQUEST_TIMEOUT_MS}` });
  }
  if (raw.concurrency !== undefined) {
    if (typeof raw.concurrency === 'number' && Number.isInteger(raw.concurrency) && raw.concurrency >= 1) config.concurrency = raw.concurrency;
    else issues.push({ severity: 'warning', path: `${path}.concurrency`, message: `concurrency must be an integer >= 1; using ${DEFAULT_SERVER_CONCURRENCY}` });
  }
  if (raw.trustReadOnlyHint !== undefined) {
    if (typeof raw.trustReadOnlyHint === 'boolean') config.trustReadOnlyHint = raw.trustReadOnlyHint;
    else issues.push({ severity: 'warning', path: `${path}.trustReadOnlyHint`, message: 'trustReadOnlyHint must be a boolean; ignored' });
  }
  return config;
}

export function parseMcpConfig(text: string): { config: McpConfig; issues: ConfigIssue[] } {
  const issues: ConfigIssue[] = [];
  let doc: unknown;
  try {
    doc = parseYaml(text);
  } catch (err) {
    issues.push({ severity: 'error', path: '', message: `not valid YAML: ${(err as Error).message}` });
    return { config: defaultMcpConfig(), issues };
  }
  if (doc === null || doc === undefined) return { config: defaultMcpConfig(), issues };
  if (!isRecord(doc)) {
    issues.push({ severity: 'error', path: '', message: 'top level must be a mapping with a "servers" key' });
    return { config: defaultMcpConfig(), issues };
  }
  const rawServers = doc.servers;
  if (rawServers === undefined || rawServers === null) return { config: defaultMcpConfig(), issues };
  if (!isRecord(rawServers)) {
    issues.push({ severity: 'error', path: 'servers', message: 'servers must be a mapping of logical name to binding' });
    return { config: defaultMcpConfig(), issues };
  }

  const servers: Record<string, McpServerConfig> = {};
  for (const [name, raw] of Object.entries(rawServers)) {
    const path = `servers.${name}`;
    if (!isValidServerName(name)) {
      issues.push({
        severity: 'error',
        path,
        message: `"${name}" is not a valid logical server name: use lowercase letters, digits and underscores, starting with a letter`,
      });
      continue;
    }
    const server = parseServer(raw, path, issues);
    if (server) servers[name] = server;
  }
  return { config: { servers }, issues };
}

const HEADER = `# Archspace — MCP server bindings (machine-local; never committed with a workflow).
#
# Workflows reference servers by logical name only. This file says what each
# name actually is. Secrets are referenced by KEY; the values live in the OS
# keychain.
#
# servers:
#   formats:
#     transport: stdio
#     command: ["uvx", "archspace-formats-server"]
#   revit:
#     transport: http
#     url: https://revit-agent.office.example:8443/mcp
#     auth: oauth
`;

/** Deterministic: servers in name order, keys in a fixed order. */
export function serializeMcpConfig(config: McpConfig): string {
  const servers: Record<string, Record<string, unknown>> = {};
  for (const name of Object.keys(config.servers).sort()) {
    const server = config.servers[name];
    const out: Record<string, unknown> = {};
    const b = server.binding;
    out.transport = b.transport;
    if (b.transport === 'stdio') {
      out.command = [...b.command];
      if (b.env !== undefined) out.env = { ...b.env };
      if (b.cwd !== undefined) out.cwd = b.cwd;
    } else {
      out.url = b.url;
      if (b.auth !== undefined) out.auth = b.auth;
      if (b.bearerTokenRef !== undefined) out.bearerTokenRef = b.bearerTokenRef;
      if (b.headers !== undefined) out.headers = { ...b.headers };
    }
    out.enabled = server.enabled;
    if (server.description !== undefined) out.description = server.description;
    if (server.timeoutMs !== undefined) out.timeoutMs = server.timeoutMs;
    if (server.concurrency !== undefined) out.concurrency = server.concurrency;
    if (server.trustReadOnlyHint !== undefined) out.trustReadOnlyHint = server.trustReadOnlyHint;
    servers[name] = out;
  }
  const body = stringifyYaml({ servers }, { lineWidth: 0 });
  return `${HEADER}\n${body}`;
}

/** Display target for the status panel: the command, or the URL with any
 *  credential-bearing query string removed. Never a token. */
export function describeBinding(binding: McpBinding): string {
  if (binding.transport === 'stdio') return binding.command.join(' ');
  try {
    const url = new URL(binding.url);
    url.search = '';
    url.username = '';
    url.password = '';
    return url.toString();
  } catch {
    return binding.url;
  }
}

/** Structural equality — the test for "does this rebinding need a reconnect?". */
export function sameServerConfig(a: McpServerConfig, b: McpServerConfig): boolean {
  return JSON.stringify(normalizeForCompare(a)) === JSON.stringify(normalizeForCompare(b));
}

function normalizeForCompare(c: McpServerConfig): unknown {
  const b = c.binding;
  return b.transport === 'stdio'
    ? ['stdio', b.command, sortedEntries(b.env), b.cwd ?? null, c.enabled, c.timeoutMs ?? null, c.concurrency ?? null]
    : ['http', b.url, b.auth ?? 'none', b.bearerTokenRef ?? null, sortedEntries(b.headers), c.enabled, c.timeoutMs ?? null, c.concurrency ?? null];
}

/**
 * `env` and `headers` are maps, and a map has no order — but `JSON.stringify`
 * has one: whichever order the keys happened to be inserted in. Comparing them
 * raw would make moving one env line in a hand-edited mcp.yaml read as a
 * changed binding, and `configure()` turns that verdict into the teardown of a
 * live session — precisely the "renamed an unrelated setting, lost my Revit
 * connection" failure this predicate exists to prevent. `manifest.ts`
 * canonicalises keys before hashing for exactly the same reason.
 */
function sortedEntries(map: Record<string, string> | undefined): [string, string][] | null {
  return map === undefined ? null : Object.entries(map).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
}
