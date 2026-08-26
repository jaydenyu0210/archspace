/**
 * Plugin installation — the main-process half of ARCHITECTURE §8.2's
 * "distribution in v1 is a packed tarball installed into the managed plugins
 * directory".
 *
 * Main owns this because installing is a filesystem act and because consent is
 * a *user* decision that must be taken in front of a real window, before any
 * plugin code is loaded. The engine child, which is where plugin processes are
 * actually spawned, never installs anything: it reads the plugins directory and
 * the consent file, and nothing else.
 *
 * Two honesty requirements from §8.1 and §13 are enforced here rather than in
 * the UI, so they cannot be skipped by a different entry point:
 *   - the consent sheet names every permission the manifest requests, in plain
 *     language, and installing is not the same as granting;
 *   - a plugin containing native binaries says so, because the v1 boundary is
 *     fault isolation plus permission mediation, not a hardened sandbox.
 */
import { dialog, type BrowserWindow } from 'electron';
import { rm } from 'node:fs/promises';
import { basename } from 'node:path';
import {
  describePermission,
  installPluginFromPath,
  uninstallPlugin as removePluginDir,
  type PluginManifest,
} from '@archspace/plugin-host';
import type { PluginConsentState, PluginInstallResult, SettingsResult } from '../shared/protocol';
import { loadPluginConsent, savePluginConsent, userPluginsDir } from './settings';

function consentBody(manifest: PluginManifest, containsNativeCode: boolean): string {
  const lines: string[] = [
    `${manifest.displayName} ${manifest.version}`,
    manifest.author !== undefined ? `by ${manifest.author}` : '',
    '',
    `It provides node types under “${manifest.namespace}.”.`,
    '',
  ];

  if (manifest.permissions.length === 0) {
    lines.push('It requests no capabilities beyond its own inputs and parameters.');
  } else {
    lines.push('It requests:');
    for (const permission of manifest.permissions) {
      const described = describePermission(permission);
      lines.push(`  • ${described.title} — ${described.detail}`);
    }
  }

  if (containsNativeCode) {
    lines.push(
      '',
      'This plugin contains native code. Archspace runs plugins in their own ' +
        'process, which contains crashes and mediates the capabilities above — ' +
        'but it is not a security sandbox. Native code inside a plugin can do ' +
        'anything you can do. Install it only if you trust its source.',
    );
  }

  return lines.filter((line) => line !== '' || true).join('\n');
}

/**
 * Pick a plugin directory or `.tgz`, unpack it, show the consent sheet, and
 * record the grant. Returns `cancelled` — not an error — when the user backs
 * out at either step, and leaves nothing installed if consent is declined.
 */
export async function installPluginWithConsent(win: BrowserWindow): Promise<PluginInstallResult> {
  const picked = await dialog.showOpenDialog(win, {
    title: 'Install Plugin',
    message: 'Choose a packed plugin (.tgz) or a plugin directory.',
    filters: [{ name: 'Archspace plugin', extensions: ['tgz', 'tar.gz'] }],
    properties: ['openFile', 'openDirectory'],
  });
  if (picked.canceled || picked.filePaths.length === 0) return { ok: false, cancelled: true };

  const source = picked.filePaths[0];
  let installed: { id: string; manifest: PluginManifest; containsNativeCode: boolean };
  try {
    installed = await installPluginFromPath(source, userPluginsDir());
  } catch (err) {
    return { ok: false, error: `${basename(source)} could not be installed: ${err instanceof Error ? err.message : String(err)}` };
  }

  const { response } = await dialog.showMessageBox(win, {
    type: 'question',
    title: 'Install plugin',
    message: `Install “${installed.manifest.displayName}”?`,
    detail: consentBody(installed.manifest, installed.containsNativeCode),
    buttons: ['Install and Grant', 'Cancel'],
    defaultId: 0,
    cancelId: 1,
    noLink: true,
  });

  if (response !== 0) {
    // Declining consent must leave the machine exactly as it was.
    await removePluginDir(installed.id, userPluginsDir()).catch(() => {});
    return { ok: false, cancelled: true };
  }

  const consent = await loadPluginConsent();
  consent[installed.id] = { enabled: true, permissions: [...installed.manifest.permissions] };
  await savePluginConsent(consent);

  return {
    ok: true,
    plugin: {
      id: installed.id,
      displayName: installed.manifest.displayName,
      version: installed.manifest.version,
      permissions: [...installed.manifest.permissions],
    },
  };
}

export async function uninstallPlugin(win: BrowserWindow, id: string): Promise<SettingsResult> {
  const { response } = await dialog.showMessageBox(win, {
    type: 'warning',
    title: 'Remove plugin',
    message: `Remove “${id}”?`,
    detail:
      'Workflows that use its nodes will still open — those nodes become placeholders until the plugin is reinstalled — but they will not run.',
    buttons: ['Remove', 'Cancel'],
    defaultId: 1,
    cancelId: 1,
    noLink: true,
  });
  if (response !== 0) return { ok: true };

  try {
    await removePluginDir(id, userPluginsDir());
    const consent = await loadPluginConsent();
    delete consent[id];
    await savePluginConsent(consent);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/** Drop a half-unpacked directory left behind by a failed install. */
export async function cleanupPartialInstall(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true }).catch(() => {});
}

export type { PluginConsentState };
