/**
 * Plugins panel — the consent surface for the boundary in ARCHITECTURE §8 /
 * ADR-0008.
 *
 * This screen exists because consent is a *decision*, and a decision the user
 * cannot reach is not a decision. A first-party plugin ships inside the app and
 * every bundled example workflow uses its node types; with no UI here, the
 * out-of-the-box answer to "why does the example not run?" was a state the user
 * could neither see nor change. `setPluginConsent` had no caller. It does now.
 *
 * Three things shape the layout:
 *
 * 1. **The list is the engine's, not ours.** `store.plugins` is a mirror of the
 *    plugin host's own snapshot (§7.6 — events in, UI out). Every write here
 *    goes out through the bridge and then asks the engine again
 *    (`requestEngineStatus`); nothing is patched locally to look like it
 *    worked. The alternative — flip the row optimistically — would let this
 *    panel say "loaded" over a plugin that failed to start, which is the exact
 *    class of lie the house honesty rule exists to stop. Consequence, made
 *    explicit in the UI: while `engineReady` is false the list is empty because
 *    there is nothing to mirror, NOT because nothing is installed.
 *
 * 2. **Consent is read-modify-written against main's copy**, never against a
 *    cached one. `getPluginConsent` is re-read immediately before every write
 *    so a second window, a hand-edited file, or main's own install sheet cannot
 *    be clobbered by a stale map this component was holding.
 *
 * 3. **The honesty clause of §8.1 / ADR-0008 §3 is on screen, not in a
 *    comment.** A permissions list rendered without it reads as a security
 *    guarantee; v1's boundary is fault isolation plus permission mediation, and
 *    a plugin runs with the user's own authority. The wording is deliberately
 *    consistent with the native consent sheet in `main/plugins.ts`, so the
 *    install-time and after-the-fact stories cannot drift apart.
 *
 * Grant and toggle are deliberately DIFFERENT paths, which is not obvious:
 * `setPluginEnabled` asks the engine to re-apply consent it already holds
 * (`plugin-set-enabled` rebuilds the consent map from its own
 * `grantedPermissions`), so it can flip an already-consented plugin without a
 * restart but cannot carry a *first* grant — for that, `setPluginConsent` and
 * the config push it triggers are the whole mechanism.
 */

import { useCallback, useEffect, useState } from 'react';
import { useStore } from '../../store';
import { reloadPlugins, requestEngineStatus, setPluginEnabled } from '../../engine-client';
import type { SettingsPanelProps } from '../Settings';
import type { InstalledPluginInfo } from '@archspace/plugin-host';
import type { PluginConsentState } from '../../../../shared/protocol';


// ---------------------------------------------------------------------------
// Permission copy
// ---------------------------------------------------------------------------

/**
 * Renderer-side transcription of `describePermission` from
 * `packages/plugin-host/src/manifest.ts`, which is the source of truth and is
 * what main's native consent sheet renders.
 *
 * It is copied rather than imported because it cannot be imported: the only
 * export path `@archspace/plugin-host` publishes is its barrel, and the barrel
 * reaches `node:fs`, `node:path` and `node:child_process` at module scope, so
 * Rollup fails the renderer bundle outright ("isAbsolute is not exported by
 * __vite-browser-external"). The renderer is sandboxed — that import is
 * supposed to fail. The strings below are therefore VERBATIM, and the fix that
 * removes this duplication is a browser-safe `./permissions` export on
 * plugin-host (or a bridge call), not a rewording here: a permission whose
 * explanation differs between the install sheet and this panel would be worse
 * than either alone.
 */
const SECRET_KEY_RE = /^[A-Za-z0-9_.-]+$/;

interface PermissionCopy {
  title: string;
  detail: string;
  risk: 'low' | 'medium' | 'high';
}

function describePermission(permission: string): PermissionCopy {
  if (permission === 'net') {
    return {
      title: 'Network access',
      detail:
        'Lets this plugin make outbound HTTP requests. The request is performed by Archspace on the plugin’s behalf, so it can be logged and revoked — but the plugin chooses the address and the body, so anything it can see it can send.',
      risk: 'high',
    };
  }
  const key = permission.startsWith('secrets:') ? permission.slice('secrets:'.length) : null;
  if (key !== null && SECRET_KEY_RE.test(key)) {
    return {
      title: `Secret “${key}”`,
      detail: `Reads the value stored under “${key}” in the OS keychain. No other secret is reachable, and the secrets file itself is not.`,
      risk: 'medium',
    };
  }
  return {
    title: `Unrecognised permission “${permission}”`,
    detail:
      'This build does not know what this permission grants, so it cannot be granted. The plugin will not load until it declares only permissions this version understands.',
    risk: 'high',
  };
}

// ---------------------------------------------------------------------------
// State vocabulary
// ---------------------------------------------------------------------------

/** The five states the plugin host reports, rendered as one badge and one
 *  sentence saying what it means for the user's workflows. */
function stateBadge(plugin: InstalledPluginInfo): { label: string; badge: string; stripe: string } {
  switch (plugin.state) {
    case 'loaded':
      return { label: 'running', badge: 'badge--ok', stripe: 'is-ok' };
    case 'disabled':
      return { label: 'disabled', badge: 'badge--muted', stripe: 'is-muted' };
    case 'needs-consent':
      return { label: 'needs consent', badge: 'badge--warn', stripe: 'is-warn' };
    case 'incompatible':
      return { label: 'incompatible', badge: 'badge--error', stripe: 'is-error' };
    case 'failed':
      return { label: 'failed', badge: 'badge--error', stripe: 'is-error' };
  }
}

function stateNote(plugin: InstalledPluginInfo): { tone: string; text: string } | null {
  const because = plugin.error !== undefined ? ` Reason given by the engine: ${plugin.error}.` : '';
  switch (plugin.state) {
    case 'loaded':
      return null;
    case 'disabled':
      return {
        tone: 'settings-note--info',
        text: `Disabled. Consent is still on file, but the plugin process is not running and its node types are not registered — workflows that use them cannot run.${because}`,
      };
    case 'needs-consent':
      return {
        tone: 'settings-note--warn',
        text: `Not running. Nothing in this plugin has been loaded or executed. Review what it asks for below, then grant consent to run it.${because}`,
      };
    case 'incompatible':
      return {
        tone: 'settings-note--error',
        text: `This plugin cannot run in this build of Archspace, and granting consent will not change that.${because || ' The engine did not say why.'}`,
      };
    case 'failed':
      return {
        tone: 'settings-note--error',
        text: `This plugin failed to load.${because || ' The engine did not say why.'}`,
      };
  }
}

// ---------------------------------------------------------------------------
// One installed plugin
// ---------------------------------------------------------------------------

interface PluginRowProps {
  plugin: InstalledPluginInfo;
  /** What the consent file says about this id — `undefined` means no record,
   *  which is a different thing from a record that says `enabled: false`. */
  consent: { enabled: boolean; permissions: string[] } | undefined;
  busy: boolean;
  /** Any control busy anywhere: one write at a time, since they all
   *  read-modify-write the same consent file. */
  anyBusy: boolean;
  error: string | null;
  onGrant(): void;
  onSetEnabled(enabled: boolean): void;
  onRevoke(): void;
  onUninstall(): void;
}

function PluginRow(props: PluginRowProps) {
  const { plugin, consent, busy, anyBusy, error } = props;
  const [open, setOpen] = useState(false);
  const { label, badge, stripe } = stateBadge(plugin);
  const note = stateNote(plugin);
  const permissions = plugin.manifest.permissions;
  // Consent controls are meaningful only where consent is the thing standing in
  // the way. A plugin that failed to parse or targets another engine API will
  // not run however it is consented, and offering to enable it would be a
  // button that cannot work.
  const consentable = plugin.state === 'loaded' || plugin.state === 'disabled' || plugin.state === 'needs-consent';
  const consented = plugin.state === 'loaded' || plugin.state === 'disabled';
  const removable = plugin.source === 'user';

  return (
    <div className={`settings-list-item ${stripe}`}>
      <div className="settings-item-head">
        <span className="settings-item-name">{plugin.manifest.displayName || plugin.id}</span>
        <span className={`badge ${badge}`}>{label}</span>
        {plugin.source === 'bundled' && <span className="badge badge--muted">bundled</span>}
        {plugin.containsNativeCode && <span className="badge badge--warn">native code</span>}
        {plugin.restarts > 0 && (
          <span className="badge badge--warn" title="Times the engine restarted this plugin after it exited unexpectedly.">
            {plugin.restarts} restart{plugin.restarts === 1 ? '' : 's'}
          </span>
        )}
        <div className="settings-item-actions">
          {busy && <span className="settings-spinner" />}
          {consented && (
            <label className={`settings-check${anyBusy ? ' is-disabled' : ''}`}>
              <input
                type="checkbox"
                checked={plugin.state === 'loaded'}
                disabled={anyBusy}
                onChange={(e) => props.onSetEnabled(e.target.checked)}
              />
              Enabled
            </label>
          )}
          {plugin.state === 'needs-consent' && (
            <button className="settings-btn settings-btn--primary settings-btn--small" disabled={anyBusy} onClick={props.onGrant}>
              Grant consent &amp; enable
            </button>
          )}
          {consentable && consent !== undefined && (
            <button
              className="settings-btn settings-btn--small"
              disabled={anyBusy}
              title="Forget this decision. The plugin stops and is asked for again next time."
              onClick={props.onRevoke}
            >
              Revoke consent
            </button>
          )}
          {!consentable && consent !== undefined && (
            <button className="settings-btn settings-btn--small" disabled={anyBusy} onClick={props.onRevoke}>
              Forget consent record
            </button>
          )}
          {removable && (
            <button className="settings-btn settings-btn--danger settings-btn--small" disabled={anyBusy} onClick={props.onUninstall}>
              Remove…
            </button>
          )}
          <button className="settings-btn settings-btn--small" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
            {open ? 'Less' : 'Details'}
          </button>
        </div>
      </div>

      <div className="settings-item-meta mono">
        {plugin.id} v{plugin.manifest.version} · {plugin.manifest.namespace} · engine API {plugin.manifest.engineApi}
      </div>

      {plugin.manifest.description !== undefined && <div className="settings-item-desc">{plugin.manifest.description}</div>}

      <div className="settings-item-body">
        {note !== null && <div className={`settings-note ${note.tone}`}>{note.text}</div>}

        {error !== null && <div className="settings-note settings-note--error">{error}</div>}

        {plugin.containsNativeCode && (
          <div className="settings-note settings-note--warn">
            This plugin contains native code. Archspace runs plugins in their own process, which contains crashes and
            mediates the capabilities below — but it is not a security sandbox. Native code inside a plugin can do
            anything you can do. Grant it only if you trust its source.
          </div>
        )}

        <div className="settings-subheading">What it asks for</div>
        {permissions.length === 0 ? (
          <div className="settings-item-desc">
            It requests no capabilities beyond its own inputs and parameters — no network, no secrets. Consent is still
            required: running this code at all is the decision, and only you can make it.
          </div>
        ) : (
          <div className="settings-evidence">
            {permissions.map((permission) => {
              const copy = describePermission(permission);
              const has = plugin.grantedPermissions.includes(permission);
              return (
                <div key={permission} className="settings-evidence-item">
                  <span className="settings-tag">{permission}</span>
                  <span className={`badge ${has ? 'badge--ok' : 'badge--muted'}`}>{has ? 'granted' : 'not granted'}</span>
                  <span className={`badge ${copy.risk === 'high' ? 'badge--warn' : 'badge--muted'}`}>{copy.risk} risk</span>
                  <span>
                    <strong>{copy.title}</strong> — {copy.detail}
                  </span>
                </div>
              );
            })}
          </div>
        )}

        {open && (
          <>
            <div className="settings-divider" />
            <div className="settings-subheading">Node types it contributes</div>
            {plugin.nodeTypes.length > 0 ? (
              <div className="settings-tags">
                {plugin.nodeTypes.map((type) => (
                  <span key={type} className="settings-tag">
                    {type}
                  </span>
                ))}
              </div>
            ) : (
              <div className="settings-item-desc">
                None registered. The engine only learns a plugin&apos;s node types by starting it, so this list stays
                empty until the plugin runs — it is not a claim that the plugin has none.
              </div>
            )}

            {plugin.manifest.types !== undefined && plugin.manifest.types.length > 0 && (
              <>
                <div className="settings-subheading">Port types it declares</div>
                <div className="settings-tags">
                  {plugin.manifest.types.map((type) => (
                    <span key={type.name} className="settings-tag">
                      {type.name} — {type.label}
                    </span>
                  ))}
                </div>
              </>
            )}

            <div className="settings-kv">
              <span className="settings-kv-key">Source</span>
              <span className="settings-kv-value">
                {plugin.source === 'bundled' ? 'Ships inside Archspace — read-only, cannot be removed here' : 'Installed by you'}
              </span>
              {plugin.manifest.author !== undefined && (
                <>
                  <span className="settings-kv-key">Author</span>
                  <span className="settings-kv-value">{plugin.manifest.author}</span>
                </>
              )}
              {plugin.manifest.license !== undefined && (
                <>
                  <span className="settings-kv-key">License</span>
                  <span className="settings-kv-value">{plugin.manifest.license}</span>
                </>
              )}
              <span className="settings-kv-key">Consent on file</span>
              <span className="settings-kv-value">
                {consent === undefined
                  ? 'none — this plugin has not been reviewed'
                  : `${consent.enabled ? 'enabled' : 'disabled'}; ${
                      consent.permissions.length > 0 ? consent.permissions.join(', ') : 'no permissions'
                    }`}
              </span>
            </div>

            <div className="settings-path">
              <span className="settings-code" title={plugin.dir}>
                {plugin.dir}
              </span>
              <button className="settings-btn settings-btn--small" onClick={() => void window.archspace.revealPath(plugin.dir)}>
                Reveal
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// The panel
// ---------------------------------------------------------------------------

export function PluginsPanel(props: SettingsPanelProps) {
  const plugins = useStore((s) => s.plugins);
  const engineReady = useStore((s) => s.engineReady);
  const notify = useStore((s) => s.notify);

  const [consent, setConsent] = useState<PluginConsentState | null>(null);
  const [consentError, setConsentError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [rowError, setRowError] = useState<{ id: string; message: string } | null>(null);
  const [panelBusy, setPanelBusy] = useState<'install' | 'reload' | null>(null);
  const [panelError, setPanelError] = useState<string | null>(null);
  /** Records in `plugins.json` this machine could not read — shown, because a
   *  consent record that silently reset is indistinguishable from one the user
   *  forgot they had granted (ADR-0008 §2). */
  const [consentIssues, setConsentIssues] = useState<string[]>([]);

  const loadConsent = useCallback(() => {
    setConsentError(null);
    void window.archspace
      .getPluginConsent()
      .then(({ consent: loaded, issues }) => {
        setConsent(loaded);
        setConsentIssues(issues);
      })
      .catch((err: unknown) => setConsentError(err instanceof Error ? err.message : String(err)));
  }, []);

  // The dialog is mounted per opening (App.tsx renders it only while open), so
  // this runs once per visit: read what main has on file, and re-ask the engine
  // rather than trusting whatever snapshot happened to be in the store.
  useEffect(() => {
    loadConsent();
    requestEngineStatus();
  }, [loadConsent]);

  const busy = busyId !== null || panelBusy !== null;

  /** Every consent write is read-modify-write against main's live copy. */
  const writeConsent = async (mutate: (current: PluginConsentState) => PluginConsentState): Promise<void> => {
    const { consent: current } = await window.archspace.getPluginConsent();
    const next = mutate(current);
    const result = await window.archspace.setPluginConsent(next);
    if (!result.ok) throw new Error(result.error);
    setConsent(next);
    // Main pushed the new config to the engine on the control channel, which is
    // a different port than the one this renderer's status arrives on — nothing
    // orders that push against the IPC reply just awaited. Ask again.
    requestEngineStatus();
  };

  const runForRow = (id: string, work: () => Promise<void>): void => {
    setBusyId(id);
    setRowError(null);
    void work()
      .catch((err: unknown) => setRowError({ id, message: err instanceof Error ? err.message : String(err) }))
      .finally(() => setBusyId(null));
  };

  const grant = (plugin: InstalledPluginInfo): void =>
    runForRow(plugin.id, async () => {
      // Granting is one step, not two: `setPluginEnabled` rebuilds the engine's
      // consent map from the permissions it has ALREADY granted (none, here),
      // so it cannot carry a first grant. `setPluginConsent` is the whole act —
      // main persists it and pushes it, and the engine re-discovers.
      await writeConsent((current) => ({
        ...current,
        [plugin.id]: { enabled: true, permissions: [...plugin.manifest.permissions] },
      }));
    });

  const setEnabled = (plugin: InstalledPluginInfo, enabled: boolean): void =>
    runForRow(plugin.id, async () => {
      await writeConsent((current) => ({
        ...current,
        [plugin.id]: { enabled, permissions: [...plugin.grantedPermissions] },
      }));
      // Second step: ask the engine to apply it now, so the node library updates
      // without a restart. A failure here does not undo the persisted decision,
      // so it is a warning rather than an error thrown back into the row.
      try {
        await setPluginEnabled(plugin.id, enabled);
      } catch (err) {
        notify('warn', `Saved, but the engine did not apply it: ${err instanceof Error ? err.message : String(err)}`);
      }
      requestEngineStatus();
    });

  const revoke = (plugin: InstalledPluginInfo): void =>
    runForRow(plugin.id, async () => {
      // Deleting the record, not setting `enabled: false`: revoking should put
      // the plugin back where it was before it was ever reviewed, so the next
      // decision is taken against the permissions it declares *then*.
      await writeConsent((current) => {
        const next = { ...current };
        delete next[plugin.id];
        return next;
      });
    });

  const uninstall = (plugin: InstalledPluginInfo): void =>
    runForRow(plugin.id, async () => {
      // Main owns the confirmation sheet and the filesystem, and it pushes the
      // new config itself. It also answers `ok` when the user cancels its
      // dialog, so nothing here claims the plugin was removed — the list below
      // is the engine's answer, and it is the only claim made.
      const result = await window.archspace.uninstallPlugin(plugin.id);
      if (!result.ok) throw new Error(result.error);
      loadConsent();
      requestEngineStatus();
    });

  const install = (): void => {
    setPanelBusy('install');
    setPanelError(null);
    void (async () => {
      const result = await window.archspace.installPlugin();
      if (result.cancelled === true) return;
      if (!result.ok) {
        setPanelError(result.error ?? 'The install failed and the app was not told why.');
        return;
      }
      // Main's install handler writes the grant taken in its own consent sheet
      // but is the one settings write that does NOT push the new config. Read
      // what it just wrote and put it back through `setPluginConsent`, which
      // does push — otherwise the engine would keep reporting the freshly
      // installed plugin as un-reviewed and this panel would repeat that.
      const { consent: current } = await window.archspace.getPluginConsent();
      const written = await window.archspace.setPluginConsent(current);
      setConsent(current);
      requestEngineStatus();
      if (!written.ok) {
        setPanelError(
          `${result.plugin?.displayName ?? 'The plugin'} was installed, but the engine could not be told about it: ${written.error}`,
        );
        return;
      }
      notify('info', `Installed ${result.plugin?.displayName ?? 'plugin'} ${result.plugin?.version ?? ''}`.trim());
    })()
      .catch((err: unknown) => setPanelError(err instanceof Error ? err.message : String(err)))
      .finally(() => setPanelBusy(null));
  };

  const reload = (): void => {
    setPanelBusy('reload');
    setPanelError(null);
    void reloadPlugins()
      .then(() => requestEngineStatus())
      .catch((err: unknown) => setPanelError(err instanceof Error ? err.message : String(err)))
      .finally(() => setPanelBusy(null));
  };

  const blockedBundled = plugins.filter((p) => p.source === 'bundled' && p.state !== 'loaded');
  const consentRecords = consent === null ? [] : Object.entries(consent);

  return (
    <div className="settings-panel">
      <div className="settings-section">
        <div className="settings-section-head">
          <h3 className="settings-heading">Plugins</h3>
          {engineReady && <span className="badge badge--muted">{plugins.length} installed</span>}
        </div>
        <p className="settings-section-desc">
          Each installed plugin runs in its own child process of the engine and is handed only what its manifest
          declared and you granted: the asset store, the secrets it named, the AI gateway, and network access if it
          asked for it. Nothing in that API leads to your project folder, the rest of your disk, other plugins, or
          this window — which is a description of what a plugin is <em>given</em>, and the paragraph below is why that
          is a smaller guarantee than it sounds.
        </p>
        <div className="settings-note settings-note--warn">
          That boundary is fault isolation plus permission mediation — <strong>not</strong> a hardened security sandbox
          (ADR-0008 §3). A plugin process runs with your own authority, so a native dependency inside one can do
          anything you can do. What consent buys you is a contained crash, a mediated capability list, and the ability
          to revoke. Grant it only to code whose source you trust.
        </div>
      </div>

      <div className="settings-divider" />

      <div className="settings-section">
        <div className="settings-toolbar">
          <button className="settings-btn" disabled={busy} onClick={install}>
            Install plugin…
          </button>
          <button
            className="settings-btn"
            disabled={busy || !engineReady}
            title={engineReady ? 'Re-scan the plugin directories' : 'The engine is not connected'}
            onClick={reload}
          >
            Reload plugins
          </button>
        </div>

        {panelBusy !== null && (
          <div className="settings-loading">
            <span className="settings-spinner" />
            {panelBusy === 'install'
              ? 'Waiting on the install and consent sheets — they open over the main window.'
              : 'Re-scanning the plugin directories…'}
          </div>
        )}

        {panelError !== null && <div className="settings-note settings-note--error">{panelError}</div>}

        {/* The file was readable but part of it was not. Distinct from
            `consentError` above, which means nothing could be read: here the
            panel is usable and some plugins have quietly returned to
            needs-consent, which the user has to be told or they will read it as
            the app forgetting a decision they made. */}
        {consentIssues.length > 0 && (
          <div className="settings-note settings-note--error">
            Part of the consent file could not be read, so those plugins are treated as un-reviewed. Grant them again
            to fix the file.
            <ul>
              {consentIssues.map((issue) => (
                <li key={issue}>{issue}</li>
              ))}
            </ul>
          </div>
        )}

        {consentError !== null && (
          <>
            <div className="settings-note settings-note--error">
              Could not read the consent file: {consentError}. Granting, revoking and enabling are disabled until it can
              be read — a write from here would have to overwrite a file this panel never saw, and could silently drop
              another plugin&apos;s decision.
            </div>
            <div className="settings-actions">
              <button className="settings-btn settings-btn--small" onClick={loadConsent}>
                Try again
              </button>
            </div>
          </>
        )}

        {blockedBundled.length > 0 && (
          <div className="settings-note settings-note--warn">
            Shipped with Archspace and not running: {blockedBundled.map((p) => p.manifest.displayName || p.id).join(', ')}.
            The bundled example workflows use node types from these plugins, so those examples cannot run until each is
            consented and enabled below.
          </div>
        )}

        {!engineReady ? (
          <>
            <div className="settings-note settings-note--warn">
              The engine has not reported yet, so there is no installed-plugin list to show. This is an empty mirror,
              not an empty plugins folder — nothing below should be read as “nothing is installed”.
            </div>
            {consentRecords.length > 0 && (
              <>
                <div className="settings-subheading">Consent on file (from main, not the engine)</div>
                <div className="settings-table-wrap">
                  <table className="settings-table">
                    <thead>
                      <tr>
                        <th>Plugin id</th>
                        <th>Enabled</th>
                        <th>Permissions granted</th>
                      </tr>
                    </thead>
                    <tbody>
                      {consentRecords.map(([id, entry]) => (
                        <tr key={id}>
                          <td className="mono">{id}</td>
                          <td>{entry.enabled ? 'yes' : 'no'}</td>
                          <td className="mono">{entry.permissions.length > 0 ? entry.permissions.join(', ') : '—'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </>
            )}
          </>
        ) : plugins.length === 0 ? (
          <div className="settings-empty">
            <div className="settings-empty-title">No plugins installed</div>
            <div className="settings-empty-text">
              The engine scanned the bundled and user plugin directories and found nothing to load. Install a packed
              plugin (<span className="mono">.tgz</span>) or a plugin directory to add node types.
            </div>
          </div>
        ) : (
          <div className="settings-list">
            {plugins.map((plugin) => (
              <PluginRow
                key={plugin.id}
                plugin={plugin}
                consent={consent?.[plugin.id]}
                busy={busyId === plugin.id}
                anyBusy={busy || consent === null}
                error={rowError !== null && rowError.id === plugin.id ? rowError.message : null}
                onGrant={() => grant(plugin)}
                onSetEnabled={(enabled) => setEnabled(plugin, enabled)}
                onRevoke={() => revoke(plugin)}
                onUninstall={() => uninstall(plugin)}
              />
            ))}
          </div>
        )}
      </div>

      <div className="settings-divider" />

      <div className="settings-section">
        <div className="settings-subheading">Where plugins live</div>
        <div className="settings-row settings-row--stack">
          <span className="settings-row-label">Installed by you</span>
          <div className="settings-path">
            <span className="settings-code" title={props.platform.paths.userPlugins}>
              {props.platform.paths.userPlugins}
            </span>
            <button
              className="settings-btn settings-btn--small"
              onClick={() => void window.archspace.revealPath(props.platform.paths.userPlugins)}
            >
              Reveal
            </button>
          </div>
          <div className="settings-row-hint">
            One directory per plugin, named by its id. Bundled first-party plugins ship inside the application bundle
            instead and cannot be removed from here — they can still be disabled, and disabling one stops its process.
          </div>
        </div>
        <div className="settings-row settings-row--stack">
          <span className="settings-row-label">Application data</span>
          <div className="settings-path">
            <span className="settings-code" title={props.platform.paths.userData}>
              {props.platform.paths.userData}
            </span>
            <button
              className="settings-btn settings-btn--small"
              onClick={() => void window.archspace.revealPath(props.platform.paths.userData)}
            >
              Reveal
            </button>
          </div>
          <div className="settings-row-hint">
            Your decisions are recorded in <span className="mono">plugins.json</span> here. Consent is machine-local and
            never travels in a workflow file: a workflow records that it <em>needs</em> a plugin, but whether that
            plugin may run on this machine is always this decision.
          </div>
        </div>
      </div>
    </div>
  );
}
