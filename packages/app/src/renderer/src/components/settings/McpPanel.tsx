import { useCallback, useEffect, useId, useMemo, useState } from 'react';
import type {
  McpBinding,
  McpConfig,
  McpServerConfig,
  McpServerStatus,
  McpTransportKind,
} from '@archspace/mcp-host';
import type { SettingsPanelProps } from '../Settings';
import { useStore } from '../../store';
import {
  connectMcpServer,
  disconnectMcpServer,
  refreshMcpServer,
  requestEngineStatus,
} from '../../engine-client';

/**
 * MCP Servers panel — the "server configuration UI" of ARCHITECTURE §9.1–§9.3 /
 * ADR-0009.
 *
 * TWO SOURCES OF TRUTH, ON PURPOSE. `mcp.yaml` (read here through
 * `getMcpConfig`) says what is BOUND; the engine's pushed `McpServerStatus[]`
 * (mirrored in the store) says what is LIVE. The obvious simplification —
 * derive one from the other — was rejected twice over: the file is
 * hand-editable and can move behind this panel's back, and the engine child
 * can be down, in which case a status list derived from the file would draw
 * servers as "idle" that nothing has even tried to dial. So the two are joined
 * by logical name and a row says plainly which halves of itself it actually
 * knows. Nothing here writes a status optimistically after an action returns:
 * every successful write ends in `requestEngineStatus()` and the panel waits
 * for the engine to say so itself.
 *
 * THE SPLIT IS EXPLAINED ON SCREEN because it is the whole point of ADR-0009 §1
 * and it is the first thing that confuses people: a workflow writes down
 * `mcp.revit.get_elements` and nothing else, and this file is the only place
 * that says `revit` is an OAuth endpoint on a machine down the corridor. Users
 * who are not told this go looking for the server list inside the workflow.
 *
 * `argv` is edited as an executable plus one argument per line rather than as a
 * single shell string. Splitting a shell string here would mean implementing
 * quoting rules that differ per platform, and getting them subtly wrong shows
 * up as a launch failure minutes later and a screen away from the typo. One
 * line per argument is lossless and needs no rules.
 *
 * The name regex and the two defaults below are MIRRORED from
 * `packages/mcp-host/src/config.ts` rather than imported. `@archspace/mcp-host`
 * has a single entry point that also re-exports `createMcpHost`, so importing
 * any value from it would pull the MCP client SDK — and its `child_process`
 * stdio transport — into a sandboxed renderer that has no Node at all
 * (ARCHITECTURE §3.2). Types are free; values are not.
 */

/** Mirrors `isValidServerName` — the identifier a workflow document writes. */
const SERVER_NAME = /^[a-z][a-z0-9_]*$/;
/** Mirrors DEFAULT_REQUEST_TIMEOUT_MS / DEFAULT_SERVER_CONCURRENCY. Shown as
 *  placeholders so an empty field reads as "the default", not "no limit". */
const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_CONCURRENCY = 1;

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1']);

type ControlKind = 'connect' | 'disconnect' | 'refresh';

// ---------------------------------------------------------------------------
// Display helpers
// ---------------------------------------------------------------------------

/**
 * Mirrors `describeBinding`: the command, or the URL with anything
 * credential-bearing stripped. Only used when the engine has no status for a
 * server — when it does, `status.target` is the authority, because that is the
 * string the process that actually dials it would print.
 */
function describeTarget(binding: McpBinding): string {
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

interface StateChip {
  label: string;
  badge: string;
  stripe: string;
}

/** One place decides what a connection state looks like and what it is called. */
function chipFor(status: McpServerStatus | undefined, configured: McpServerConfig | undefined): StateChip {
  if (!status) {
    return configured && !configured.enabled
      ? { label: 'disabled', badge: 'badge--muted', stripe: 'is-muted' }
      : { label: 'no engine report', badge: 'badge--muted', stripe: 'is-muted' };
  }
  switch (status.state) {
    case 'connected':
      return { label: 'connected', badge: 'badge--ok', stripe: 'is-ok' };
    case 'connecting':
      return { label: 'connecting', badge: 'badge--info', stripe: '' };
    case 'needs-auth':
      return { label: 'needs sign-in', badge: 'badge--warn', stripe: 'is-warn' };
    case 'unsupported':
      return { label: 'unsupported here', badge: 'badge--warn', stripe: 'is-warn' };
    case 'failed':
      return { label: 'failed', badge: 'badge--error', stripe: 'is-error' };
    case 'disabled':
      return { label: 'disabled', badge: 'badge--muted', stripe: 'is-muted' };
    case 'idle':
      return { label: 'not dialled', badge: 'badge--muted', stripe: '' };
  }
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// ---------------------------------------------------------------------------
// The draft: a server binding while it is being typed
// ---------------------------------------------------------------------------

/**
 * Every field is a string, including the numbers. A half-typed timeout is a
 * legitimate intermediate state; parsing on every keystroke and storing the
 * number would make the field fight the user (`6` → `60` is a different value
 * than `60_000` on the way to it). Conversion happens once, in `reviewDraft`.
 */
interface Draft {
  /** The key this draft replaces; null while adding a new server. */
  originalName: string | null;
  name: string;
  description: string;
  enabled: boolean;
  transport: McpTransportKind;
  command: string;
  args: string;
  env: string;
  cwd: string;
  url: string;
  auth: 'none' | 'oauth' | 'bearer';
  bearerTokenRef: string;
  headers: string;
  timeoutMs: string;
  concurrency: string;
  trustReadOnlyHint: boolean;
}

type DraftField =
  | 'name'
  | 'command'
  | 'env'
  | 'cwd'
  | 'url'
  | 'bearerTokenRef'
  | 'headers'
  | 'timeoutMs'
  | 'concurrency';

interface DraftReview {
  errors: Partial<Record<DraftField, string>>;
  /** True but not fatal — the same things `parseMcpConfig` warns about. */
  warnings: string[];
  name: string;
  /** Null whenever anything in `errors` is set: there is nothing safe to save. */
  server: McpServerConfig | null;
}

function emptyDraft(): Draft {
  return {
    originalName: null,
    name: '',
    description: '',
    enabled: true,
    transport: 'stdio',
    command: '',
    args: '',
    env: '',
    cwd: '',
    url: '',
    auth: 'none',
    bearerTokenRef: '',
    headers: '',
    timeoutMs: '',
    concurrency: '',
    trustReadOnlyHint: false,
  };
}

function pairsToText(pairs: Record<string, string> | undefined, sep: string): string {
  return Object.entries(pairs ?? {})
    .map(([key, value]) => `${key}${sep}${value}`)
    .join('\n');
}

function draftFrom(name: string, server: McpServerConfig): Draft {
  const draft = emptyDraft();
  draft.originalName = name;
  draft.name = name;
  draft.description = server.description ?? '';
  draft.enabled = server.enabled;
  draft.transport = server.binding.transport;
  draft.timeoutMs = server.timeoutMs === undefined ? '' : String(server.timeoutMs);
  draft.concurrency = server.concurrency === undefined ? '' : String(server.concurrency);
  draft.trustReadOnlyHint = server.trustReadOnlyHint ?? false;
  if (server.binding.transport === 'stdio') {
    const [command, ...args] = server.binding.command;
    draft.command = command ?? '';
    draft.args = args.join('\n');
    draft.env = pairsToText(server.binding.env, '=');
    draft.cwd = server.binding.cwd ?? '';
  } else {
    draft.url = server.binding.url;
    draft.auth = server.binding.auth ?? 'none';
    draft.bearerTokenRef = server.binding.bearerTokenRef ?? '';
    draft.headers = pairsToText(server.binding.headers, ': ');
  }
  return draft;
}

function splitLines(text: string): string[] {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '');
}

/** `KEY=VALUE` / `Name: value`, one per line, `#` comments allowed. Bad lines
 *  are reported by NUMBER rather than dropped: a silently ignored header is a
 *  request that goes out wrong and a debugging session that starts elsewhere. */
function parsePairs(text: string, sep: string): { pairs: Record<string, string>; bad: number[] } {
  const pairs: Record<string, string> = {};
  const bad: number[] = [];
  text.split('\n').forEach((raw, index) => {
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) return;
    const at = line.indexOf(sep);
    const key = at === -1 ? '' : line.slice(0, at).trim();
    if (at === -1 || key === '') {
      bad.push(index + 1);
      return;
    }
    pairs[key] = line.slice(at + 1).trim();
  });
  return { pairs, bad };
}

function plural(n: number, one: string, many: string): string {
  return n === 1 ? one : many;
}

/**
 * The same rules `parseMcpConfig` applies, applied BEFORE the file is written.
 * Main does not validate what it is handed — it serializes it — so a name this
 * panel let through would be written to `mcp.yaml` and then dropped by the very
 * next parse, with the binding gone and only an issue in a log to say why.
 */
function reviewDraft(draft: Draft, takenNames: string[]): DraftReview {
  const errors: Partial<Record<DraftField, string>> = {};
  const warnings: string[] = [];

  const name = draft.name.trim();
  if (name === '') {
    errors.name = 'A logical name is required — it is the only thing a workflow writes down.';
  } else if (!SERVER_NAME.test(name)) {
    errors.name = `"${name}" is not a valid logical name. Use lowercase letters, digits and underscores, starting with a letter — mcp.yaml refuses anything else, and a refused entry is a binding that silently disappears.`;
  } else if (takenNames.includes(name)) {
    errors.name = `"${name}" is already bound. Logical names are unique; edit that server instead.`;
  }

  let binding: McpBinding | null = null;

  if (draft.transport === 'stdio') {
    const command = draft.command.trim();
    if (command === '') errors.command = 'An stdio binding needs an executable to launch.';
    const env = parsePairs(draft.env, '=');
    if (env.bad.length > 0) {
      errors.env = `${plural(env.bad.length, 'Line', 'Lines')} ${env.bad.join(', ')} ${plural(env.bad.length, 'is', 'are')} not KEY=VALUE.`;
    }
    if (command !== '' && env.bad.length === 0) {
      const stdio: McpBinding = {
        transport: 'stdio',
        command: [command, ...splitLines(draft.args)],
        ...(Object.keys(env.pairs).length > 0 ? { env: env.pairs } : {}),
        ...(draft.cwd.trim() !== '' ? { cwd: draft.cwd.trim() } : {}),
      };
      binding = stdio;
    }
  } else {
    const url = draft.url.trim();
    let parsed: URL | null = null;
    if (url === '') {
      errors.url = 'An http binding needs a URL — the Streamable HTTP endpoint of the server.';
    } else {
      try {
        parsed = new URL(url);
      } catch {
        parsed = null;
      }
      if (parsed === null) {
        errors.url = `Not a valid URL: ${url}`;
      } else if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        errors.url = `Unsupported scheme "${parsed.protocol}" — use http or https.`;
      } else if (parsed.protocol === 'http:' && !LOOPBACK.has(parsed.hostname)) {
        warnings.push(
          'Plaintext http to a non-loopback host: credentials and tool arguments travel unencrypted.',
        );
      }
    }
    const headers = parsePairs(draft.headers, ':');
    if (headers.bad.length > 0) {
      errors.headers = `${plural(headers.bad.length, 'Line', 'Lines')} ${headers.bad.join(', ')} ${plural(headers.bad.length, 'is', 'are')} not "Name: value".`;
    }
    const ref = draft.bearerTokenRef.trim();
    if (draft.auth === 'bearer' && ref === '') {
      warnings.push('Auth is "bearer" but no secret key names the token to send, so nothing will be sent.');
    }
    if (parsed !== null && errors.url === undefined && headers.bad.length === 0) {
      const http: McpBinding = {
        transport: 'http',
        url,
        auth: draft.auth,
        ...(ref !== '' ? { bearerTokenRef: ref } : {}),
        ...(Object.keys(headers.pairs).length > 0 ? { headers: headers.pairs } : {}),
      };
      binding = http;
    }
  }

  let timeoutMs: number | undefined;
  if (draft.timeoutMs.trim() !== '') {
    const value = Number(draft.timeoutMs.trim());
    if (!Number.isFinite(value) || value <= 0) {
      errors.timeoutMs = `Must be a positive number of milliseconds; leave it empty for the ${DEFAULT_TIMEOUT_MS} ms default.`;
    } else {
      timeoutMs = value;
    }
  }

  let concurrency: number | undefined;
  if (draft.concurrency.trim() !== '') {
    const value = Number(draft.concurrency.trim());
    if (!Number.isInteger(value) || value < 1) {
      errors.concurrency = `Must be a whole number of 1 or more; leave it empty for the default of ${DEFAULT_CONCURRENCY} (serial).`;
    } else {
      concurrency = value;
    }
  }

  const fatal = Object.keys(errors).length > 0;
  const server: McpServerConfig | null =
    fatal || binding === null
      ? null
      : {
          binding,
          enabled: draft.enabled,
          ...(draft.description.trim() !== '' ? { description: draft.description.trim() } : {}),
          ...(timeoutMs !== undefined ? { timeoutMs } : {}),
          ...(concurrency !== undefined ? { concurrency } : {}),
          ...(draft.trustReadOnlyHint ? { trustReadOnlyHint: true } : {}),
        };

  return { errors, warnings, name, server };
}

// ---------------------------------------------------------------------------

export function McpPanel({ platform }: SettingsPanelProps) {
  const servers = useStore((s) => s.mcpServers);
  const engineReady = useStore((s) => s.engineReady);
  const notify = useStore((s) => s.notify);

  const [config, setConfig] = useState<McpConfig | null>(null);
  const [configError, setConfigError] = useState<string | null>(null);
  const [secretKeys, setSecretKeys] = useState<string[] | null>(null);

  const [draft, setDraft] = useState<Draft | null>(null);
  const [attempted, setAttempted] = useState(false);
  const [writeError, setWriteError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState<string | null>(null);

  const [busy, setBusy] = useState<Record<string, ControlKind>>({});
  const [controlError, setControlError] = useState<Record<string, string>>({});
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});

  const [tokenValue, setTokenValue] = useState('');
  const [secretBusy, setSecretBusy] = useState(false);
  const [secretError, setSecretError] = useState<string | null>(null);

  const ids = useId();

  const loadConfig = useCallback(async (): Promise<void> => {
    setConfigError(null);
    try {
      setConfig(await window.archspace.getMcpConfig());
    } catch (err) {
      setConfigError(message(err));
    }
  }, []);

  const loadSecretKeys = useCallback(async (): Promise<void> => {
    try {
      const keys = await window.archspace.listSecretKeys();
      setSecretKeys(keys.map((k) => k.key));
    } catch {
      // Not fatal to this panel: only the bearer-token affordance depends on
      // it, and that one says "cannot tell" rather than guessing "not stored".
      setSecretKeys(null);
    }
  }, []);

  // Settings is mounted only while open, so this runs once per opening — which
  // is exactly when the file may have been edited by hand since we last read it.
  useEffect(() => {
    void loadConfig();
    void loadSecretKeys();
    // The store's mirror may be minutes old if nothing changed since the last
    // push. Silent when the engine is not connected.
    requestEngineStatus();
  }, [loadConfig, loadSecretKeys]);

  const statusByName = useMemo(
    () => new Map(servers.map((s) => [s.name, s])),
    [servers],
  );

  const rows = useMemo(() => {
    const configured = config?.servers ?? {};
    const names = new Set([...Object.keys(configured), ...servers.map((s) => s.name)]);
    return [...names]
      .sort()
      .map((name) => ({ name, server: configured[name], status: statusByName.get(name) }));
  }, [config, servers, statusByName]);

  const review = useMemo(() => {
    if (draft === null) return null;
    const taken = Object.keys(config?.servers ?? {}).filter((n) => n !== draft.originalName);
    return reviewDraft(draft, taken);
  }, [draft, config]);

  /** An error is shown once the field has been touched or Save has been tried;
   *  a blank new form should not open covered in red. */
  const errorFor = (field: DraftField, value: string): string | undefined => {
    if (review === null) return undefined;
    if (!attempted && value.trim() === '') return undefined;
    return review.errors[field];
  };

  const update = (patch: Partial<Draft>): void => {
    setDraft((current) => (current === null ? null : { ...current, ...patch }));
    setWriteError(null);
  };

  const beginAdd = (): void => {
    setDraft(emptyDraft());
    setAttempted(false);
    setWriteError(null);
    setSecretError(null);
    setTokenValue('');
  };

  const beginEdit = (name: string, server: McpServerConfig): void => {
    setDraft(draftFrom(name, server));
    setAttempted(false);
    setWriteError(null);
    setSecretError(null);
    setTokenValue('');
  };

  /**
   * Write the whole config and re-read it. Re-reading rather than trusting the
   * object we just sent is the honest ending: `mcp.yaml` is what the engine
   * will be given, so what round-tripped through it is what this panel should
   * be showing — including anything the codec chose to drop.
   */
  const writeConfig = async (next: McpConfig, done: string): Promise<boolean> => {
    setSaving(true);
    setWriteError(null);
    try {
      const result = await window.archspace.setMcpConfig(next);
      if (!result.ok) {
        setWriteError(result.error);
        return false;
      }
      await loadConfig();
      // Main pushed the new config to the engine on the control channel; that
      // push does not order against this IPC reply, so ask for the truth.
      requestEngineStatus();
      notify('info', done);
      return true;
    } catch (err) {
      setWriteError(message(err));
      return false;
    } finally {
      setSaving(false);
    }
  };

  const save = async (): Promise<void> => {
    if (draft === null || review === null || config === null) return;
    setAttempted(true);
    if (review.server === null) return;
    const next: McpConfig = { servers: { ...config.servers } };
    if (draft.originalName !== null && draft.originalName !== review.name) {
      delete next.servers[draft.originalName];
    }
    next.servers[review.name] = review.server;
    const renamed = draft.originalName !== null && draft.originalName !== review.name;
    const ok = await writeConfig(
      next,
      renamed
        ? `Renamed "${draft.originalName}" to "${review.name}" in mcp.yaml.`
        : `Saved the binding for "${review.name}".`,
    );
    if (ok) setDraft(null);
  };

  const remove = async (name: string): Promise<void> => {
    if (config === null) return;
    const next: McpConfig = { servers: { ...config.servers } };
    delete next.servers[name];
    const ok = await writeConfig(next, `Removed the binding for "${name}".`);
    if (ok) {
      setConfirmRemove(null);
      if (draft?.originalName === name) setDraft(null);
    }
  };

  const control = async (name: string, kind: ControlKind): Promise<void> => {
    setBusy((b) => ({ ...b, [name]: kind }));
    setControlError((e) => {
      const next = { ...e };
      delete next[name];
      return next;
    });
    try {
      if (kind === 'connect') await connectMcpServer(name);
      else if (kind === 'disconnect') await disconnectMcpServer(name);
      else await refreshMcpServer(name);
    } catch (err) {
      setControlError((e) => ({ ...e, [name]: message(err) }));
    } finally {
      setBusy((b) => {
        const next = { ...b };
        delete next[name];
        return next;
      });
    }
  };

  const storeToken = async (key: string): Promise<void> => {
    setSecretBusy(true);
    setSecretError(null);
    try {
      const result = await window.archspace.setSecret(key, tokenValue);
      if (!result.ok) {
        setSecretError(result.error);
        return;
      }
      setTokenValue('');
      await loadSecretKeys();
      requestEngineStatus();
      notify('info', `Stored a value for the secret "${key}".`);
    } catch (err) {
      setSecretError(message(err));
    } finally {
      setSecretBusy(false);
    }
  };

  const deleteToken = async (key: string): Promise<void> => {
    setSecretBusy(true);
    setSecretError(null);
    try {
      const result = await window.archspace.deleteSecret(key);
      if (!result.ok) {
        setSecretError(result.error);
        return;
      }
      await loadSecretKeys();
      requestEngineStatus();
      notify('info', `Deleted the secret "${key}".`);
    } catch (err) {
      setSecretError(message(err));
    } finally {
      setSecretBusy(false);
    }
  };

  // -------------------------------------------------------------------------

  function editor(current: Draft, checked: DraftReview) {
    const ref = current.bearerTokenRef.trim();
    const stored = secretKeys === null ? null : secretKeys.includes(ref);
    return (
      <section className="settings-section">
        <div className="settings-section-head">
          <h3 className="settings-heading">
            {current.originalName === null ? 'Add a server' : `Edit "${current.originalName}"`}
          </h3>
        </div>

        <div className="settings-row">
          <label className="settings-row-label" htmlFor={`${ids}-name`}>
            Logical name
          </label>
          <div className="settings-row-control">
            <input
              id={`${ids}-name`}
              className={`settings-input settings-input--mono${errorFor('name', current.name) ? ' is-invalid' : ''}`}
              value={current.name}
              spellCheck={false}
              placeholder="revit"
              onChange={(e) => update({ name: e.target.value })}
            />
          </div>
          <div className="settings-row-hint">
            {errorFor('name', current.name) ??
              (current.originalName !== null && current.originalName !== current.name.trim()
                ? `Renaming rebinds the name: workflows that reference "${current.originalName}" will have nothing to resolve on this machine.`
                : 'Nodes are typed mcp.<name>.<tool>. This name is the only part a workflow file carries.')}
          </div>
        </div>

        <div className="settings-row">
          <label className="settings-row-label" htmlFor={`${ids}-desc`}>
            Description
          </label>
          <div className="settings-row-control">
            <input
              id={`${ids}-desc`}
              className="settings-input"
              value={current.description}
              placeholder="Optional — what this server is, for the next person"
              onChange={(e) => update({ description: e.target.value })}
            />
          </div>
        </div>

        <div className="settings-row">
          <span className="settings-row-label">Enabled</span>
          <div className="settings-row-control">
            <label className="settings-check">
              <input
                type="checkbox"
                checked={current.enabled}
                onChange={(e) => update({ enabled: e.target.checked })}
              />
              Available to workflows on this machine
            </label>
          </div>
        </div>

        <div className="settings-row">
          <label className="settings-row-label" htmlFor={`${ids}-transport`}>
            Transport
          </label>
          <div className="settings-row-control">
            <select
              id={`${ids}-transport`}
              className="settings-select"
              value={current.transport}
              onChange={(e) => update({ transport: e.target.value as McpTransportKind })}
            >
              <option value="stdio">stdio — launch a local process</option>
              <option value="http">http — dial a Streamable HTTP endpoint</option>
            </select>
          </div>
        </div>

        {current.transport === 'stdio' ? (
          <>
            <div className="settings-row">
              <label className="settings-row-label" htmlFor={`${ids}-command`}>
                Executable
              </label>
              <div className="settings-row-control">
                <input
                  id={`${ids}-command`}
                  className={`settings-input settings-input--mono${errorFor('command', current.command) ? ' is-invalid' : ''}`}
                  value={current.command}
                  spellCheck={false}
                  placeholder="uvx"
                  onChange={(e) => update({ command: e.target.value })}
                />
              </div>
              {errorFor('command', current.command) && (
                <div className="settings-row-hint">{errorFor('command', current.command)}</div>
              )}
            </div>

            <div className="settings-row settings-row--stack">
              <label className="settings-row-label" htmlFor={`${ids}-args`}>
                Arguments — one per line
              </label>
              <div className="settings-row-control">
                <textarea
                  id={`${ids}-args`}
                  className="settings-textarea"
                  rows={3}
                  value={current.args}
                  spellCheck={false}
                  placeholder={'archspace-formats-server\n--stdio'}
                  onChange={(e) => update({ args: e.target.value })}
                />
              </div>
              <div className="settings-row-hint">
                One argument per line, not a shell command line: nothing here is split on spaces or
                unquoted, so a path with a space needs no escaping. Blank lines are ignored and
                surrounding spaces are trimmed.
              </div>
            </div>

            <div className="settings-row settings-row--stack">
              <label className="settings-row-label" htmlFor={`${ids}-env`}>
                Environment — KEY=VALUE per line
              </label>
              <div className="settings-row-control">
                <textarea
                  id={`${ids}-env`}
                  className={`settings-textarea${errorFor('env', current.env) ? ' is-invalid' : ''}`}
                  rows={3}
                  value={current.env}
                  spellCheck={false}
                  placeholder={'# lines starting with # are ignored\nPYTHONUNBUFFERED=1'}
                  onChange={(e) => update({ env: e.target.value })}
                />
              </div>
              <div className="settings-row-hint">
                {errorFor('env', current.env) ??
                  'These values are written into mcp.yaml in clear text. There is no secret reference for stdio environment variables — do not put a token here.'}
              </div>
            </div>

            <div className="settings-row">
              <label className="settings-row-label" htmlFor={`${ids}-cwd`}>
                Working directory
              </label>
              <div className="settings-row-control">
                <input
                  id={`${ids}-cwd`}
                  className="settings-input settings-input--mono"
                  value={current.cwd}
                  spellCheck={false}
                  placeholder="Optional — inherits the app's directory"
                  onChange={(e) => update({ cwd: e.target.value })}
                />
              </div>
            </div>
          </>
        ) : (
          <>
            <div className="settings-row">
              <label className="settings-row-label" htmlFor={`${ids}-url`}>
                URL
              </label>
              <div className="settings-row-control">
                <input
                  id={`${ids}-url`}
                  className={`settings-input settings-input--mono${errorFor('url', current.url) ? ' is-invalid' : ''}`}
                  value={current.url}
                  spellCheck={false}
                  placeholder="https://revit-agent.office.example:8443/mcp"
                  onChange={(e) => update({ url: e.target.value })}
                />
              </div>
              {errorFor('url', current.url) && (
                <div className="settings-row-hint">{errorFor('url', current.url)}</div>
              )}
            </div>

            <div className="settings-row">
              <label className="settings-row-label" htmlFor={`${ids}-auth`}>
                Authorization
              </label>
              <div className="settings-row-control">
                <select
                  id={`${ids}-auth`}
                  className="settings-select"
                  value={current.auth}
                  onChange={(e) => update({ auth: e.target.value as Draft['auth'] })}
                >
                  <option value="none">none</option>
                  <option value="oauth">oauth — OAuth 2.1 + PKCE in your browser</option>
                  <option value="bearer">bearer — a token from the keychain</option>
                </select>
              </div>
              {current.auth === 'oauth' && (
                <div className="settings-row-hint">
                  Connecting opens your browser; the app listens on a fixed loopback redirect and
                  keeps the registration and tokens in the OS keychain.
                </div>
              )}
            </div>

            {current.auth === 'bearer' && (
              <>
                <div className="settings-row">
                  <label className="settings-row-label" htmlFor={`${ids}-ref`}>
                    Secret key
                  </label>
                  <div className="settings-row-control">
                    <input
                      id={`${ids}-ref`}
                      className="settings-input settings-input--mono"
                      value={current.bearerTokenRef}
                      spellCheck={false}
                      placeholder="revit_bearer_token"
                      onChange={(e) => update({ bearerTokenRef: e.target.value })}
                    />
                    {ref !== '' && stored === true && <span className="badge badge--ok">value stored</span>}
                    {ref !== '' && stored === false && <span className="badge badge--warn">no value stored</span>}
                    {ref !== '' && stored === null && <span className="badge badge--muted">keys unreadable</span>}
                  </div>
                  <div className="settings-row-hint">
                    mcp.yaml stores the KEY, never the token. The value lives in the OS keychain and
                    the renderer cannot read it back — only replace or delete it.
                  </div>
                </div>

                {platform.secretsAvailable ? (
                  <div className="settings-row">
                    <label className="settings-row-label" htmlFor={`${ids}-token`}>
                      Token value
                    </label>
                    <div className="settings-row-control">
                      <input
                        id={`${ids}-token`}
                        className="settings-input settings-input--mono"
                        type="password"
                        value={tokenValue}
                        autoComplete="off"
                        placeholder={stored === true ? 'Stored — type to replace' : 'Paste the token'}
                        onChange={(e) => setTokenValue(e.target.value)}
                      />
                      <button
                        className="settings-btn settings-btn--small"
                        disabled={secretBusy || ref === '' || tokenValue === ''}
                        onClick={() => void storeToken(ref)}
                      >
                        {secretBusy && <span className="settings-spinner" />} Store
                      </button>
                      {stored === true && (
                        <button
                          className="settings-btn settings-btn--small settings-btn--danger"
                          disabled={secretBusy}
                          onClick={() => void deleteToken(ref)}
                        >
                          Delete
                        </button>
                      )}
                    </div>
                    {secretError !== null && <div className="settings-row-hint">{secretError}</div>}
                  </div>
                ) : (
                  <div className="settings-note settings-note--warn">
                    This machine&apos;s keychain is not backing safeStorage, so the app refuses to
                    store secrets at all. A bearer token cannot be saved here, and a server bound to
                    one will not be able to authenticate.
                  </div>
                )}
              </>
            )}

            <div className="settings-row settings-row--stack">
              <label className="settings-row-label" htmlFor={`${ids}-headers`}>
                Headers — Name: value per line
              </label>
              <div className="settings-row-control">
                <textarea
                  id={`${ids}-headers`}
                  className={`settings-textarea${errorFor('headers', current.headers) ? ' is-invalid' : ''}`}
                  rows={3}
                  value={current.headers}
                  spellCheck={false}
                  placeholder={'X-Workspace: studio-a'}
                  onChange={(e) => update({ headers: e.target.value })}
                />
              </div>
              <div className="settings-row-hint">
                {errorFor('headers', current.headers) ??
                  'Sent on every request. Written into mcp.yaml in clear text — for a credential use the bearer secret key above instead.'}
              </div>
            </div>
          </>
        )}

        <div className="settings-divider" />

        <div className="settings-row">
          <label className="settings-row-label" htmlFor={`${ids}-timeout`}>
            Request timeout (ms)
          </label>
          <div className="settings-row-control">
            <input
              id={`${ids}-timeout`}
              className={`settings-input settings-input--mono${errorFor('timeoutMs', current.timeoutMs) ? ' is-invalid' : ''}`}
              value={current.timeoutMs}
              spellCheck={false}
              placeholder={String(DEFAULT_TIMEOUT_MS)}
              onChange={(e) => update({ timeoutMs: e.target.value })}
            />
          </div>
          {errorFor('timeoutMs', current.timeoutMs) && (
            <div className="settings-row-hint">{errorFor('timeoutMs', current.timeoutMs)}</div>
          )}
        </div>

        <div className="settings-row">
          <label className="settings-row-label" htmlFor={`${ids}-concurrency`}>
            Lane concurrency
          </label>
          <div className="settings-row-control">
            <input
              id={`${ids}-concurrency`}
              className={`settings-input settings-input--mono${errorFor('concurrency', current.concurrency) ? ' is-invalid' : ''}`}
              value={current.concurrency}
              spellCheck={false}
              placeholder={String(DEFAULT_CONCURRENCY)}
              onChange={(e) => update({ concurrency: e.target.value })}
            />
          </div>
          <div className="settings-row-hint">
            {errorFor('concurrency', current.concurrency) ??
              'How many calls this server may run at once. Serial by default because most MCP servers hold one session and a shared model.'}
          </div>
        </div>

        <div className="settings-row">
          <span className="settings-row-label">Caching</span>
          <div className="settings-row-control">
            <label className="settings-check">
              <input
                type="checkbox"
                checked={current.trustReadOnlyHint}
                onChange={(e) => update({ trustReadOnlyHint: e.target.checked })}
              />
              Trust this server&apos;s readOnlyHint and allow caching
            </label>
          </div>
          <div className="settings-row-hint">
            Off by default: the spec calls readOnlyHint an untrusted hint, so results from this
            server are never cached unless you say this server&apos;s hints can be believed.
          </div>
        </div>

        {checked.warnings.length > 0 && (
          <div className="settings-note settings-note--warn">
            {checked.warnings.map((w) => (
              <div key={w}>{w}</div>
            ))}
          </div>
        )}

        {attempted && checked.server === null && (
          <div className="settings-note settings-note--error">
            This binding is not written yet — the fields marked above would be dropped by mcp.yaml on
            the next read.
          </div>
        )}

        {writeError !== null && (
          <div className="settings-note settings-note--error">
            mcp.yaml was not written: {writeError}
          </div>
        )}

        <div className="settings-actions">
          <button className="settings-btn settings-btn--primary" disabled={saving} onClick={() => void save()}>
            {saving && <span className="settings-spinner" />}
            {current.originalName === null ? 'Add server' : 'Save changes'}
          </button>
          <button className="settings-btn" disabled={saving} onClick={() => setDraft(null)}>
            Cancel
          </button>
        </div>
      </section>
    );
  }

  function serverRow(name: string, server: McpServerConfig | undefined, status: McpServerStatus | undefined) {
    const chip = chipFor(status, server);
    const running = busy[name];
    const editing = draft?.originalName === name;
    const target = status?.target ?? (server ? describeTarget(server.binding) : null);
    const transport = status?.transport ?? server?.binding.transport;
    const canControl = engineReady && status !== undefined;
    // No Connect button on a disabled or unsupported server: the host refuses
    // both by design, and a button whose only possible outcome is an error
    // teaches the user to distrust the ones that work.
    const connectable =
      status !== undefined &&
      status.state !== 'connected' &&
      status.state !== 'connecting' &&
      status.state !== 'disabled' &&
      status.state !== 'unsupported';
    const rowError = controlError[name];
    const showTools = expanded[name] === true;

    return (
      <div key={name} className={`settings-list-item ${editing ? 'is-selected' : chip.stripe}`.trimEnd()}>
        <div className="settings-item-head">
          <span className="settings-item-name mono">{name}</span>
          {transport && <span className="settings-item-meta">{transport}</span>}
          <span className={`badge ${chip.badge}`}>
            {running === 'connect' && <span className="settings-spinner" />}
            {chip.label}
          </span>
          {status && status.state === 'connected' && (
            <span className="settings-item-meta">
              {status.toolCount} {plural(status.toolCount, 'tool', 'tools')}
            </span>
          )}
          {status && status.drift.length > 0 && <span className="badge badge--warn">tools changed</span>}
          <div className="settings-item-actions">
            {connectable && (
              <button
                className="settings-btn settings-btn--small"
                disabled={!canControl || running !== undefined}
                title={canControl ? undefined : 'The engine is not connected.'}
                onClick={() => void control(name, 'connect')}
              >
                {status?.state === 'needs-auth' ? 'Sign in and connect' : 'Connect'}
              </button>
            )}
            {status?.state === 'connected' && (
              <>
                <button
                  className="settings-btn settings-btn--small"
                  disabled={running !== undefined}
                  onClick={() => void control(name, 'refresh')}
                >
                  {running === 'refresh' && <span className="settings-spinner" />} Refresh tools
                </button>
                <button
                  className="settings-btn settings-btn--small settings-btn--danger"
                  disabled={running !== undefined}
                  onClick={() => void control(name, 'disconnect')}
                >
                  {running === 'disconnect' && <span className="settings-spinner" />} Disconnect
                </button>
              </>
            )}
            {server && (
              <button
                className="settings-btn settings-btn--small"
                disabled={saving}
                onClick={() => beginEdit(name, server)}
              >
                Edit
              </button>
            )}
            {server && confirmRemove !== name && (
              <button
                className="settings-btn settings-btn--small settings-btn--danger"
                disabled={saving}
                onClick={() => setConfirmRemove(name)}
              >
                Remove
              </button>
            )}
          </div>
        </div>

        {server?.description && <div className="settings-item-desc">{server.description}</div>}

        <div className="settings-item-body">
          {target !== null && (
            <div className="settings-path">
              <span className="settings-code" title={target}>
                {target}
              </span>
            </div>
          )}

          {server === undefined && (
            <div className="settings-note settings-note--warn">
              The engine reports this server, but it is not in the mcp.yaml this panel has read. The
              file changed underneath — reload the bindings to edit it here.
            </div>
          )}

          {status === undefined && server !== undefined && (
            <div className="settings-note settings-note--info">
              {engineReady
                ? 'The engine has not reported this server yet. It was probably added since the last configuration push; reopen this dialog or reload the bindings.'
                : 'Bound in mcp.yaml. The engine is not connected, so nothing is known about whether it would connect.'}
            </div>
          )}

          {status?.state === 'idle' && (
            <div className="settings-item-desc">
              Bound but never dialled — servers connect lazily, on the first run that needs one.
              Connecting here is how you check the binding before you rely on it.
            </div>
          )}

          {status?.state === 'disabled' && (
            <div className="settings-item-desc">
              Disabled in mcp.yaml: the binding is kept, its tools generate no nodes, and the engine
              refuses to dial it. Edit the server and tick &quot;Enabled&quot; to use it again.
            </div>
          )}

          {status?.unsupportedReason !== undefined && (
            <div className="settings-note settings-note--warn">{status.unsupportedReason}</div>
          )}

          {status?.state === 'needs-auth' && (
            <div className="settings-note settings-note--warn">
              This server wants authorization. Connect opens your browser for the OAuth 2.1 flow; the
              tokens are kept in the OS keychain, not in mcp.yaml.
            </div>
          )}

          {rowError !== undefined && (
            <div className="settings-note settings-note--error">{rowError}</div>
          )}

          {status?.error !== undefined && status.error !== rowError && (
            <div className="settings-note settings-note--error">{status.error}</div>
          )}

          {status && status.drift.length > 0 && (
            <div className="settings-note settings-note--warn">
              {status.drift.length} {plural(status.drift.length, 'tool has', 'tools have')} changed
              since the nodes on your canvas were generated. Those nodes are flagged for review, never
              silently re-mapped:
              <div className="settings-tags">
                {status.drift.map((d) => (
                  <span key={d.nodeType} className="settings-tag">
                    {d.nodeType} — {d.kind}
                  </span>
                ))}
              </div>
            </div>
          )}

          {status && (status.serverInfo !== undefined || status.protocolVersion !== undefined) && (
            <div className="settings-kv">
              {status.serverInfo !== undefined && (
                <>
                  <span className="settings-kv-key">Server</span>
                  <span className="settings-kv-value mono">
                    {status.serverInfo.name} {status.serverInfo.version}
                  </span>
                </>
              )}
              {status.protocolVersion !== undefined && (
                <>
                  <span className="settings-kv-key">Protocol</span>
                  <span className="settings-kv-value mono">{status.protocolVersion}</span>
                </>
              )}
              <span className="settings-kv-key">Lane cap</span>
              <span className="settings-kv-value mono">
                mcp:{name} · {status.concurrency}
              </span>
            </div>
          )}

          {status && status.tools.length > 0 && (
            <>
              <div className="settings-actions">
                <button
                  className="settings-btn settings-btn--small"
                  aria-expanded={showTools}
                  onClick={() => setExpanded((e) => ({ ...e, [name]: !showTools }))}
                >
                  {showTools ? 'Hide' : 'Show'} {status.tools.length}{' '}
                  {plural(status.tools.length, 'tool', 'tools')}
                </button>
              </div>
              {showTools && (
                <div className="settings-table-wrap">
                  <table className="settings-table">
                    <thead>
                      <tr>
                        <th>Tool</th>
                        <th>Node type</th>
                        <th>Description</th>
                      </tr>
                    </thead>
                    <tbody>
                      {status.tools.map((tool) => (
                        <tr key={tool.nodeType}>
                          <td>
                            {tool.title ?? tool.name}{' '}
                            {tool.drifted && <span className="badge badge--warn">changed</span>}
                          </td>
                          <td className="mono" title={`schema ${tool.schemaHash}`}>
                            {tool.nodeType}
                          </td>
                          <td>{tool.description ?? ''}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </>
          )}

          {status?.state === 'connected' && status.tools.length === 0 && (
            <div className="settings-item-desc">
              Connected, and the server published no tools — so this server contributes no nodes.
            </div>
          )}

          {confirmRemove === name && (
            <>
              <div className="settings-note settings-note--error">
                Remove the binding for &quot;{name}&quot;? Workflows that reference it will have
                nothing to resolve on this machine until it is bound again. The workflow files
                themselves are untouched.
              </div>
              <div className="settings-actions">
                <button
                  className="settings-btn settings-btn--small settings-btn--danger"
                  disabled={saving}
                  onClick={() => void remove(name)}
                >
                  {saving && <span className="settings-spinner" />} Remove binding
                </button>
                <button
                  className="settings-btn settings-btn--small"
                  disabled={saving}
                  onClick={() => setConfirmRemove(null)}
                >
                  Keep it
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    );
  }

  // -------------------------------------------------------------------------

  return (
    <div className="settings-panel">
      <section className="settings-section">
        <div className="settings-section-head">
          <h3 className="settings-heading">MCP Servers</h3>
        </div>
        <p className="settings-section-desc">
          A workflow names servers logically — <span className="mono">revit</span>,{' '}
          <span className="mono">formats</span> — and carries nothing else about them. This machine
          decides what each name actually launches or dials, and that binding lives here, never in
          the workflow file. It is what keeps a workflow shareable (no absolute paths, no URLs, no
          credentials in git) and what stops a cloned repository from making your machine run a
          command. A server&apos;s tools become nodes typed{' '}
          <span className="mono">mcp.&lt;name&gt;.&lt;tool&gt;</span>, so the name is the contract.
        </p>
        <div className="settings-path">
          <span className="settings-code" title={platform.paths.mcpConfig}>
            {platform.paths.mcpConfig}
          </span>
          <button
            className="settings-btn settings-btn--small"
            onClick={() => void window.archspace.revealPath(platform.paths.mcpConfig)}
          >
            Reveal
          </button>
        </div>
        <div className="settings-row-hint">
          Hand-editable YAML, and the source of truth. Anything edited there shows up here after a
          reload; anything saved here is rewritten deterministically, comments in the header aside.
        </div>
        <div className="settings-note settings-note--unimplemented">
          Two things this panel does not do. It cannot forget a stored OAuth registration or token
          for a server — the app has no call for that yet, so re-authorizing a server that went wrong
          means clearing the keychain entry by hand. And it cannot import the bindings a workflow
          suggests in its <span className="mono">requires:</span> block; that consent flow is not
          built, so every server here is one you added yourself.
        </div>
      </section>

      <section className="settings-section">
        <div className="settings-section-head">
          <h3 className="settings-subheading">Configured servers</h3>
          <div className="settings-actions">
            <button className="settings-btn settings-btn--small" disabled={saving} onClick={() => void loadConfig()}>
              Reload from disk
            </button>
            <button
              className="settings-btn settings-btn--small settings-btn--primary"
              disabled={config === null || saving || draft !== null}
              onClick={beginAdd}
            >
              Add server
            </button>
          </div>
        </div>

        {!engineReady && (
          <div className="settings-note settings-note--warn">
            The engine is not connected, so no connection state is known for any server below —
            neither connected nor failed, simply unknown. Connect, disconnect and refresh are
            unavailable until it comes back.
          </div>
        )}

        {configError !== null && (
          <div className="settings-note settings-note--error">
            Could not read mcp.yaml: {configError}. Nothing below is the file&apos;s real contents.
          </div>
        )}

        {writeError !== null && draft === null && (
          <div className="settings-note settings-note--error">mcp.yaml was not written: {writeError}</div>
        )}

        {config === null && configError === null ? (
          <div className="settings-loading">
            <span className="settings-spinner" /> Reading mcp.yaml…
          </div>
        ) : rows.length === 0 ? (
          <div className="settings-empty">
            <div className="settings-empty-title">No servers bound</div>
            <div className="settings-empty-text">
              A fresh install binds nothing — inventing plausible bindings would only fill this list
              with servers that were never going to connect. Add one, or write it into mcp.yaml by
              hand and reload.
            </div>
          </div>
        ) : (
          <div className="settings-list">{rows.map((row) => serverRow(row.name, row.server, row.status))}</div>
        )}
      </section>

      {draft !== null && review !== null && editor(draft, review)}
    </div>
  );
}
