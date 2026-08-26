import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  resolveCapability,
  type AutodeskCapability,
  type CapabilityChannel,
  type CapabilityEvidence,
  type CapabilityStatus,
  type McpServerPreset,
} from '@archspace/autodesk';
import type { McpServerConfig } from '@archspace/mcp-host';
import { requestEngineStatus } from '../../engine-client';
import { useStore } from '../../store';
import type { SettingsPanelProps } from '../Settings';

/**
 * Autodesk & Revit — the capability matrix on screen (ARCHITECTURE §9.2 /
 * ADR-0001, rendered from `@archspace/autodesk`, sourced from
 * docs/research/ecosystem.md §1–§3).
 *
 * This panel is the UI half of the product's honesty requirement: where a
 * capability does not exist, ship the seam and mark it clearly as unimplemented
 * in BOTH the code and the UI. `packages/autodesk` has been the code half for a
 * while — eleven capabilities, six of them `not-implemented`, each naming its
 * empty seam by repo path — but until this file existed none of it reached a
 * user, so the requirement was met in the repository and unmet on the screen.
 * That is the whole reason this panel is here.
 *
 * Everything below is RENDERED from the capability map, never restated. The
 * per-capability verdict is `resolveCapability(cap, platform)` printed verbatim,
 * and the capability's own `unimplementedReason` and `seam` are the only words
 * this file uses for anything unbuilt. The rejected alternative was a
 * hand-written "Revit needs Windows, APS is coming later" paragraph: it would
 * drift from the table within one commit, and drift here means the UI claims
 * something the code does not do — the exact failure the honesty rule names.
 * For the same reason the two summary sentences that could go stale (the APS
 * one) are guarded by a check against the data rather than simply asserted.
 *
 * Two deliberate absences, both stated in the UI as well as here:
 *
 * 1. Nothing on this screen connects to anything. It signs in to no Autodesk
 *    service and dials no server; it reads `autodeskCapabilities()` and
 *    `autodeskPresets()` over the preload bridge and shows them with their
 *    citations. Connecting an MCP server is the MCP Servers tab's job.
 * 2. It does not write `mcp.yaml`. A preset is a template, and an "add this
 *    for me" button here would race the MCP tab's own draft of the same file
 *    and would have to invent values for the `<replace me>` placeholders that
 *    `presets.ts` leaves visible on purpose. So the panel emits the YAML block
 *    and points at the file instead.
 *
 * The YAML emitter below duplicates `serializeMcpConfig`'s key order by hand.
 * Importing the real one would be better and is not possible: `@archspace/mcp-host`
 * exports only its package root, and that root pulls the stdio/child-process
 * host into a sandboxed renderer bundle (ARCHITECTURE §3.2). The emitter covers
 * every field of `McpServerConfig` precisely so that it cannot silently drop
 * one and show the user a snippet that is not the preset.
 */

/** Defined in packages/autodesk/src/presets.ts, and quoted here rather than
 *  imported because it is not exported: "Visible on purpose: a half-filled
 *  preset should look wrong at a glance." We only detect it, never hide it. */
const PLACEHOLDER_SENTINEL = '<replace me>';

const STATUS_LABEL: Record<CapabilityStatus, string> = {
  available: 'available',
  'available-windows-only': 'windows only',
  'requires-remote-agent': 'needs a remote agent',
  'not-implemented': 'not implemented',
};

const CHANNEL_LABEL: Record<CapabilityChannel, string> = {
  mcp: 'MCP',
  'aps-rest': 'APS REST',
  'aps-graphql': 'APS GraphQL',
  'revit-addin': 'Revit add-in',
  none: 'no channel',
};

const ACCESS_LABEL: Record<AutodeskCapability['access'], string> = {
  none: 'no access',
  read: 'read',
  'read-export': 'read + export',
  'read-write': 'read + write',
};

/** Where a capability's SERVER side has to run — not where this app runs. */
const SERVER_PLATFORM_LABEL: Record<AutodeskCapability['platforms'][number], string> = {
  windows: 'Windows',
  macos: 'macOS',
  linux: 'Linux',
  cloud: 'Autodesk cloud',
};

function hostLabel(platform: NodeJS.Platform): string {
  if (platform === 'darwin') return 'macOS';
  if (platform === 'win32') return 'Windows';
  if (platform === 'linux') return 'Linux';
  return platform;
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Citation link text. The full URL goes in `title` and into `openExternal`;
 * the visible text is host plus the last path segment, because a 110-character
 * GUID URL in a flex row wraps into an unreadable block and the ellipsis is
 * honest about being an abbreviation.
 */
function shortUrl(raw: string): string {
  try {
    const url = new URL(raw);
    const segments = url.pathname.split('/').filter(Boolean);
    if (segments.length === 0) return url.hostname;
    const last = segments[segments.length - 1];
    const shown = last.length > 30 ? `${last.slice(0, 29)}…` : last;
    return segments.length === 1 ? `${url.hostname}/${shown}` : `${url.hostname}/…/${shown}`;
  } catch {
    return raw;
  }
}

/** Single-quoted YAML: the only escape is a doubled quote, so a Windows path
 *  keeps its backslashes literally. Double-quoted style would need every one
 *  of them escaped, and a mis-escaped path is a preset that silently fails. */
function yamlScalar(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/**
 * The preset as it would appear in mcp.yaml. Key order and the flattened
 * binding (transport/url/command directly under the server name) mirror
 * `serializeMcpConfig` in @archspace/mcp-host — see the file header for why
 * this is a copy and not a call.
 */
function presetYaml(logicalName: string, config: McpServerConfig): string {
  const lines: string[] = ['servers:', `  ${logicalName}:`];
  const binding = config.binding;
  lines.push(`    transport: ${binding.transport}`);
  if (binding.transport === 'stdio') {
    lines.push('    command:');
    for (const arg of binding.command) lines.push(`      - ${yamlScalar(arg)}`);
    if (binding.env !== undefined) {
      lines.push('    env:');
      for (const [key, value] of Object.entries(binding.env)) {
        lines.push(`      ${key}: ${yamlScalar(value)}`);
      }
    }
    if (binding.cwd !== undefined) lines.push(`    cwd: ${yamlScalar(binding.cwd)}`);
  } else {
    lines.push(`    url: ${yamlScalar(binding.url)}`);
    if (binding.auth !== undefined) lines.push(`    auth: ${binding.auth}`);
    if (binding.bearerTokenRef !== undefined) {
      lines.push(`    bearerTokenRef: ${yamlScalar(binding.bearerTokenRef)}`);
    }
    if (binding.headers !== undefined) {
      lines.push('    headers:');
      for (const [key, value] of Object.entries(binding.headers)) {
        lines.push(`      ${key}: ${yamlScalar(value)}`);
      }
    }
  }
  lines.push(`    enabled: ${config.enabled}`);
  if (config.description !== undefined) lines.push(`    description: ${yamlScalar(config.description)}`);
  if (config.timeoutMs !== undefined) lines.push(`    timeoutMs: ${config.timeoutMs}`);
  if (config.concurrency !== undefined) lines.push(`    concurrency: ${config.concurrency}`);
  if (config.trustReadOnlyHint !== undefined) {
    lines.push(`    trustReadOnlyHint: ${config.trustReadOnlyHint}`);
  }
  return lines.join('\n');
}

export function AutodeskPanel({ platform }: SettingsPanelProps) {
  const host = platform.platform;
  const notify = useStore((s) => s.notify);
  const engineReady = useStore((s) => s.engineReady);
  const mcpServers = useStore((s) => s.mcpServers);

  const [capabilities, setCapabilities] = useState<AutodeskCapability[] | null>(null);
  const [presets, setPresets] = useState<McpServerPreset[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [openEvidence, setOpenEvidence] = useState<Record<string, boolean>>({});
  const [openYaml, setOpenYaml] = useState<Record<string, boolean>>({});

  const load = useCallback(() => {
    setLoadError(null);
    void Promise.all([window.archspace.autodeskCapabilities(), window.archspace.autodeskPresets()])
      .then(([caps, sets]) => {
        setCapabilities(caps);
        setPresets(sets);
      })
      .catch((err: unknown) => setLoadError(errorText(err)));
  }, []);

  // Settings is mounted only while open, so this runs once per opening of the
  // dialog. The status request is for the preset cross-reference below: the
  // store's `mcpServers` is the engine's mirror, and asking on open is the only
  // way this panel's "already bound in mcp.yaml" line is current rather than
  // whatever the engine last happened to push. It no-ops when the engine is down.
  useEffect(() => {
    load();
    requestEngineStatus();
  }, [load]);

  const openLink = (url: string) => {
    void window.archspace
      .openExternal(url)
      .catch((err: unknown) => notify('error', `Could not open ${url}: ${errorText(err)}`));
  };

  const revealMcpConfig = () => {
    void window.archspace
      .revealPath(platform.paths.mcpConfig)
      .catch((err: unknown) => notify('error', `Could not reveal mcp.yaml: ${errorText(err)}`));
  };

  const copyYaml = (yaml: string, label: string) => {
    // Reported either way: a copy button that quietly did nothing would be the
    // small version of the thing this whole panel exists to prevent.
    try {
      void navigator.clipboard
        .writeText(yaml)
        .then(() => notify('info', `Copied the ${label} block. Paste it under "servers:" in mcp.yaml.`))
        .catch((err: unknown) =>
          notify('error', `Could not copy: ${errorText(err)}. Select the block and copy it by hand.`),
        );
    } catch (err: unknown) {
      notify('error', `Could not copy: ${errorText(err)}. Select the block and copy it by hand.`);
    }
  };

  const summary = useMemo(() => {
    if (capabilities === null) return null;
    let usableHere = 0;
    let blockedHere = 0;
    let unimplemented = 0;
    for (const cap of capabilities) {
      if (cap.status === 'not-implemented') unimplemented += 1;
      else if (resolveCapability(cap, host).usableHere) usableHere += 1;
      else blockedHere += 1;
    }
    return { total: capabilities.length, usableHere, blockedHere, unimplemented };
  }, [capabilities, host]);

  // Asserted from the data, not from memory. If someone ever implements an APS
  // capability, this sentence disappears instead of becoming a lie.
  const apsRows = capabilities?.filter((cap) => cap.channel.startsWith('aps-')) ?? [];
  const apsAllUnimplemented =
    apsRows.length > 0 && apsRows.every((cap) => cap.status === 'not-implemented');

  const toggleEvidence = (id: string) =>
    setOpenEvidence((prev) => ({ ...prev, [id]: prev[id] !== true }));
  const toggleYaml = (id: string) => setOpenYaml((prev) => ({ ...prev, [id]: prev[id] !== true }));

  function evidenceBlock(id: string, entries: CapabilityEvidence[]) {
    const isOpen = openEvidence[id] === true;
    return (
      <>
        <div className="settings-actions">
          <button
            className="settings-btn settings-btn--small"
            onClick={() => toggleEvidence(id)}
            aria-expanded={isOpen}
          >
            {isOpen ? 'Hide evidence' : `Evidence (${entries.length})`}
          </button>
        </div>
        {isOpen && (
          <div className="settings-evidence">
            {entries.map((entry, i) => (
              <div className="settings-evidence-item" key={`${entry.source}-${i}`}>
                <span className={`badge ${entry.directlyVerified ? 'badge--ok' : 'badge--warn'}`}>
                  {entry.directlyVerified ? 'verified' : 'not verified'}
                </span>
                <span>{entry.claim}</span>
                <button className="settings-link" title={entry.source} onClick={() => openLink(entry.source)}>
                  {shortUrl(entry.source)}
                </button>
                {entry.note !== undefined && <span className="panel-hint">{entry.note}</span>}
              </div>
            ))}
          </div>
        )}
      </>
    );
  }

  function capabilityItem(cap: AutodeskCapability) {
    const verdict = resolveCapability(cap, host);
    const unimplemented = cap.status === 'not-implemented';
    // No stripe and no dimming for an unimplemented row: `is-muted` is 70%
    // opacity, which reads as "loading" or "coming soon" — the two readings the
    // requirement forbids. The dashed badge and the dashed note carry it, the
    // same way styles.css argues the badge is "an absence, not a fault".
    const stripe = unimplemented ? '' : verdict.usableHere ? ' is-ok' : ' is-warn';
    const statusBadge = unimplemented
      ? 'badge--unimplemented'
      : verdict.usableHere
        ? 'badge--ok'
        : 'badge--warn';

    return (
      <div className={`settings-list-item${stripe}`} key={cap.id}>
        <div className="settings-item-head">
          <span className="settings-item-name">{cap.title}</span>
          <span className={`badge ${statusBadge}`}>{STATUS_LABEL[cap.status]}</span>
          <span className="badge badge--muted">{CHANNEL_LABEL[cap.channel]}</span>
          <span className={`badge ${cap.access === 'read-write' ? 'badge--warn' : 'badge--muted'}`}>
            {ACCESS_LABEL[cap.access]}
          </span>
        </div>
        <div className="settings-item-meta">{cap.id}</div>
        <div className="settings-item-desc">{cap.summary}</div>

        {unimplemented ? (
          <div className="settings-note settings-note--unimplemented">
            <strong>Not implemented in Archspace.</strong> {cap.unimplementedReason}
            {cap.seam !== undefined && (
              <>
                <br />
                Seam: <span className="mono">{cap.seam}</span>
              </>
            )}
          </div>
        ) : (
          <div className={`settings-note ${verdict.usableHere ? 'settings-note--info' : 'settings-note--warn'}`}>
            {verdict.reason}
          </div>
        )}

        <div className="settings-item-body">
          <div className="settings-subheading">Server side runs on</div>
          <div className="settings-tags">
            {cap.platforms.map((p) => (
              <span className="settings-tag" key={p}>
                {SERVER_PLATFORM_LABEL[p]}
              </span>
            ))}
          </div>
          <div className="panel-hint">
            Where this capability&rsquo;s server has to run — not where Archspace runs. This machine is{' '}
            {hostLabel(host)}.
          </div>
        </div>

        <div className="settings-item-body">
          <div className="settings-subheading">Requires</div>
          {cap.requires.map((requirement, i) => (
            <label className="settings-check is-disabled" key={i}>
              <input type="checkbox" disabled />
              <span>{requirement}</span>
            </label>
          ))}
          <div className="panel-hint">
            Archspace cannot check any of these for you — they are what you have to supply, and
            nothing here verifies that you have.
          </div>
        </div>

        {evidenceBlock(cap.id, cap.evidence)}
      </div>
    );
  }

  function presetItem(preset: McpServerPreset) {
    const { availability } = preset;
    // The engine mirrors mcp.yaml. Only a POSITIVE match is claimed: an absent
    // entry could equally mean the engine has not pushed its status yet, and
    // "you have not configured this" would then be a guess presented as a fact.
    const bound = engineReady ? mcpServers.find((s) => s.name === preset.logicalName) : undefined;
    const yaml = presetYaml(preset.logicalName, preset.config);
    const hasSentinel = yaml.includes(PLACEHOLDER_SENTINEL);
    const yamlOpen = openYaml[preset.id] === true;

    return (
      <div className={`settings-list-item ${availability.available ? 'is-ok' : 'is-warn'}`} key={preset.id}>
        <div className="settings-item-head">
          <span className="settings-item-name">{preset.label}</span>
          <span className={`badge ${availability.available ? 'badge--ok' : 'badge--warn'}`}>
            {availability.available ? 'available here' : 'not available here'}
          </span>
          <span className="badge badge--muted">{preset.config.binding.transport}</span>
        </div>
        <div className="settings-item-meta">
          {preset.logicalName} · {preset.capabilityId}
        </div>
        <div className="settings-item-desc">{preset.description}</div>

        {!availability.available && availability.reason !== undefined && (
          <div className="settings-note settings-note--warn">{availability.reason}</div>
        )}

        {bound !== undefined && (
          <div className="settings-note settings-note--info">
            Already bound in mcp.yaml as <span className="mono">{bound.name}</span> — the engine
            currently reports it as {bound.state}
            {bound.enabled ? '' : ' (disabled)'}. Manage it on the MCP Servers tab.
          </div>
        )}

        <div className="settings-item-body">
          <div className="settings-subheading">Fields you must fill</div>
          {preset.placeholders.length === 0 ? (
            <div className="panel-hint">
              None — this preset has no fillable fields, because it is not offered as usable.
            </div>
          ) : (
            preset.placeholders.map((placeholder) => (
              <div className="settings-row settings-row--stack" key={placeholder.path}>
                <span className="settings-row-label">{placeholder.label}</span>
                <div className="settings-row-control">
                  <code className="settings-code" title={placeholder.path}>
                    {placeholder.path}
                  </code>
                </div>
                <span className="settings-row-hint">{placeholder.hint}</span>
              </div>
            ))
          )}
        </div>

        <div className="settings-actions">
          <button
            className="settings-btn settings-btn--small"
            onClick={() => toggleYaml(preset.id)}
            aria-expanded={yamlOpen}
          >
            {yamlOpen ? 'Hide mcp.yaml block' : 'Show mcp.yaml block'}
          </button>
          {yamlOpen && (
            <button className="settings-btn settings-btn--small" onClick={() => copyYaml(yaml, preset.logicalName)}>
              Copy block
            </button>
          )}
        </div>

        {yamlOpen && (
          <div className="settings-item-body">
            <textarea
              className="settings-textarea"
              readOnly
              spellCheck={false}
              rows={yaml.split('\n').length + 1}
              value={yaml}
              aria-label={`mcp.yaml block for ${preset.logicalName}`}
            />
            {hasSentinel && (
              <div className="settings-note settings-note--warn">
                This block still contains <span className="mono">{PLACEHOLDER_SENTINEL}</span>. That
                is deliberate: a half-filled preset should look wrong at a glance. Replace every one
                of them before enabling the server — Archspace does not guess these values.
              </div>
            )}
          </div>
        )}

        {evidenceBlock(`preset:${preset.id}`, preset.evidence)}
      </div>
    );
  }

  if (loadError !== null) {
    return (
      <div className="settings-panel">
        <div className="settings-section">
          <div className="settings-section-head">
            <h3 className="settings-heading">Autodesk &amp; Revit</h3>
          </div>
          <div className="settings-note settings-note--error">
            Could not read the Autodesk capability map from the app: {loadError}. Nothing is shown
            below rather than a guess at what this machine can reach.
          </div>
          <div className="settings-actions">
            <button className="settings-btn settings-btn--small" onClick={load}>
              Try again
            </button>
          </div>
        </div>
      </div>
    );
  }

  if (capabilities === null || presets === null || summary === null) {
    return (
      <div className="settings-panel">
        <div className="settings-loading">
          <span className="settings-spinner" /> Reading the Autodesk capability map…
        </div>
      </div>
    );
  }

  return (
    <div className="settings-panel">
      <div className="settings-section">
        <div className="settings-section-head">
          <h3 className="settings-heading">Autodesk &amp; Revit</h3>
          <span className="badge badge--muted">{hostLabel(host)}</span>
        </div>
        <p className="settings-section-desc">
          What Archspace can and cannot reach in the Autodesk world, with the source behind every
          claim. Nothing on this screen signs in to Autodesk, dials a server or writes configuration:
          it reads the capability map and the MCP server presets and shows them as they are. Binding
          and connecting a server happens on the MCP Servers tab.
        </p>

        <div className="settings-kv">
          <span className="settings-kv-key">This machine</span>
          <span className="settings-kv-value mono">
            {platform.platform} · {platform.arch} · Archspace {platform.appVersion}
          </span>
          <span className="settings-kv-key">Capabilities mapped</span>
          <span className="settings-kv-value">{summary.total}</span>
          <span className="settings-kv-key">Usable from here</span>
          <span className="settings-kv-value">{summary.usableHere}</span>
          <span className="settings-kv-key">Need a Windows host</span>
          <span className="settings-kv-value">{summary.blockedHere}</span>
          <span className="settings-kv-key">Not implemented</span>
          <span className="settings-kv-value">{summary.unimplemented}</span>
        </div>

        {host === 'win32' ? (
          <div className="settings-note settings-note--info">
            This machine is Windows, so the local Autodesk MCP servers can run here beside a live
            Revit or AutoCAD session. Archspace still only ever speaks MCP to them; it links no Revit
            code and ships no add-in.
          </div>
        ) : (
          <div className="settings-note settings-note--warn">
            Revit is a Windows application and Autodesk publishes no macOS build, so on{' '}
            {hostLabel(host)} no capability that needs a live Revit or AutoCAD session can ever run
            locally — not under any setting on this screen. The only route from here to a live model
            is a Windows machine (workstation, office box, Parallels VM, cloud VM) running Revit plus
            an MCP bridge, reached over MCP Streamable HTTP: the &ldquo;Remote Revit agent&rdquo;
            preset below. Archspace does not ship that agent; you point the preset at one you run.
          </div>
        )}

        {apsAllUnimplemented && (
          <div className="settings-note settings-note--unimplemented">
            Archspace has no Autodesk Platform Services integration at all: no registered APS
            application, no sign-in, no Design Automation pipeline, no data-API client. Every APS row
            below is an unimplemented seam that names where that code would live and throws if
            anything reaches for it.
          </div>
        )}
      </div>

      <div className="settings-section">
        <div className="settings-section-head">
          <h3 className="settings-heading">Capability matrix</h3>
        </div>
        <p className="settings-section-desc">
          Every capability the research confirmed, and every one it confirmed does not exist here.
          Status is resolved for this machine; &ldquo;server side runs on&rdquo; is where the
          capability&rsquo;s own server has to live, not where Archspace runs. Open the evidence on
          any row to see the claim, its source and whether that page could actually be retrieved.
        </p>
        {capabilities.length === 0 ? (
          <div className="settings-empty">
            <div className="settings-empty-title">No capabilities</div>
            <div className="settings-empty-text">
              The app returned an empty capability map. That is not a state Archspace should be able
              to reach — treat it as a bug rather than as &ldquo;nothing is supported&rdquo;.
            </div>
          </div>
        ) : (
          <div className="settings-list">{capabilities.map(capabilityItem)}</div>
        )}
      </div>

      <div className="settings-section">
        <div className="settings-section-head">
          <h3 className="settings-heading">MCP server presets</h3>
        </div>
        <p className="settings-section-desc">
          A preset is a template for <span className="mono">mcp.yaml</span>, never a connection. Each
          one produces a real server binding with the machine-specific parts left blank, and none is
          enabled by default. A preset&rsquo;s availability comes from the capability it belongs to,
          so it can never look usable while the matrix above says otherwise. The field paths below
          are the config object&rsquo;s own; in the file itself the binding fields sit directly under
          the server name.
        </p>
        <div className="settings-note settings-note--unimplemented">
          Adding a preset to <span className="mono">mcp.yaml</span> from this panel is not
          implemented — there is no button here that edits the file. Copy the block into it yourself,
          or add the server on the MCP Servers tab.
        </div>
        <div className="settings-path">
          <code className="settings-code" title={platform.paths.mcpConfig}>
            {platform.paths.mcpConfig}
          </code>
          <button className="settings-btn settings-btn--small" onClick={revealMcpConfig}>
            Reveal mcp.yaml
          </button>
        </div>
        {!engineReady && (
          <div className="panel-hint">
            The engine has not reported yet, so this panel cannot say which of these servers are
            already bound in <span className="mono">mcp.yaml</span>.
          </div>
        )}
        {presets.length === 0 ? (
          <div className="settings-empty">
            <div className="settings-empty-title">No presets</div>
            <div className="settings-empty-text">
              The app returned no Autodesk MCP presets. You can still bind any server by hand on the
              MCP Servers tab.
            </div>
          </div>
        ) : (
          <div className="settings-list">{presets.map(presetItem)}</div>
        )}
      </div>
    </div>
  );
}
