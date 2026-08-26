/**
 * Auto-update against GitHub Releases (ADR-0012 §1).
 *
 * ADR-0012 decides this: electron-builder publishing to Releases as the
 * canonical channel, with electron-updater applying updates and the ZIP target
 * existing specifically because the updater cannot consume a DMG. The
 * dependency was declared when that decision was made and then never imported,
 * which is the worst of both worlds — the app shipped the updater's weight and
 * none of its behaviour, while `package.json` implied a feature that did not
 * exist. This module is the missing half.
 *
 * Four decisions, each of which is the reason a line below looks the way it
 * does:
 *
 *  - **Packaged builds only.** A `pnpm dev` run has no published version to
 *    compare itself against and no feed to read, so electron-updater fails
 *    looking for `dev-app-update.yml`. The guard is not a workaround for that
 *    error, it is the correct scope: there is no such thing as updating a
 *    working tree. Same reasoning covers CI, where the app is never packaged.
 *  - **`checkForUpdatesAndNotify`, not a silent swap.** ADR-0012's consequence
 *    section is explicit that we own the update trust chain rather than
 *    delegating it to a store. Replacing a signed binary under a user who was
 *    given no say is precisely the power that obliges us to say so; the native
 *    notification is how. The download still happens in the background and the
 *    swap still happens on quit — the user is informed, not interrogated.
 *  - **A failed check is logged and nothing else.** No dialog, never fatal. An
 *    unreachable feed, a rate limit, or a machine offline on a plane must leave
 *    the app exactly as it was: someone opening a workflow does not care that
 *    GitHub was briefly unavailable, and a modal about it would be the second
 *    thing to go wrong. This is also why the promise is explicitly caught —
 *    `checkForUpdatesAndNotify` rejects rather than resolving to null on a
 *    network error, and an unhandled rejection in main is a crash report.
 *  - **No update check before the window exists.** It runs after
 *    `createWindow()` so the first thing the app does with the user's network
 *    is show them their own workflow, not poll a release feed.
 *
 * Honest limitation, stated here because the code cannot enforce it: on macOS
 * the updater can only *apply* an update to a signed application. An unsigned
 * local `pnpm dist` build will download an update and then fail to install it.
 * That is a property of Gatekeeper, not a bug here, and it is why ADR-0012 §3
 * makes notarized CI the only sanctioned release path. See `docs/releasing.md`.
 *
 * **Why `electron-updater` is imported dynamically inside a try/catch**, which
 * a static import would express more cleanly: electron-vite leaves it external,
 * so the packaged app resolves a real `require` at runtime — and this workspace
 * installs with pnpm's symlinked `node_modules`, which electron-builder is
 * known to under-collect. If the module ever fails to make it into the bundle,
 * a static import turns that packaging miss into a crash on launch: the app
 * would not open at all because a *background* feature was missing. The app
 * must start without auto-update; auto-update must not start without the app.
 * So the failure degrades to a log line, and the release checklist verifies the
 * module is really there rather than trusting that it is.
 */
import { app } from 'electron';

export type UpdateLog = (level: 'info' | 'warn', message: string) => void;

const defaultLog: UpdateLog = (level, message) => {
  if (level === 'warn') console.warn(`[updates] ${message}`);
  else console.log(`[updates] ${message}`);
};

/**
 * Wire the updater and kick off one check. Safe to call unconditionally — it
 * decides for itself whether this build is one that can be updated.
 */
export function initAutoUpdate(log: UpdateLog = defaultLog): void {
  if (!app.isPackaged) {
    log('info', 'not a packaged build; skipping the update check');
    return;
  }
  void start(log).catch((err: unknown) => {
    // Everything below this point is best-effort. Reaching here means the app
    // has no auto-update, which is a degraded feature and not a broken app.
    log('warn', `auto-update unavailable: ${err instanceof Error ? err.message : String(err)}`);
  });
}

async function start(log: UpdateLog): Promise<void> {
  const { autoUpdater } = await import('electron-updater');

  // electron-updater has its own logger seam and defaults to none. Pointing it
  // at ours means a user who reports "it never updates" produces a log with the
  // reason in it, rather than silence.
  autoUpdater.logger = {
    info: (m: unknown) => log('info', String(m)),
    warn: (m: unknown) => log('warn', String(m)),
    error: (m: unknown) => log('warn', String(m)),
    debug: () => undefined,
  };

  autoUpdater.on('update-downloaded', (info) => {
    log('info', `update ${info.version} downloaded; it will be applied on quit`);
  });

  // Caught, not awaited: nothing upstream can act on the result, and an
  // unhandled rejection here would be a crash report about a network blip.
  void autoUpdater.checkForUpdatesAndNotify().catch((err: unknown) => {
    log('warn', `update check failed: ${err instanceof Error ? err.message : String(err)}`);
  });
}
