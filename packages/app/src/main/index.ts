/**
 * Electron main — window/menu/dialogs, settings, secrets, and process
 * supervision (§3.2).
 *
 * Two channels leave this process. The renderer and the engine child talk
 * directly over a MessageChannelMain pair that main only brokers, so run
 * events never take a detour through here. Main keeps a *second*, private port
 * to the engine — the control channel — for the three things the engine is
 * deliberately not allowed to do for itself: read settings files, unlock the
 * keychain, and open a browser (ARCHITECTURE §9.2, §12).
 */
import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  MessageChannelMain,
  shell,
  utilityProcess,
  type UtilityProcess,
} from 'electron';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { WorkflowDoc } from '@archspace/document';
import type { AiGatewayConfig } from '@archspace/ai-gateway';
import type { McpConfig } from '@archspace/mcp-host';
import { AUTODESK_CAPABILITIES, revitPresets } from '@archspace/autodesk';
import { isAssetRef, type AssetRef } from '@archspace/node-sdk';
import type {
  EngineControlEvent,
  EngineControlRequest,
  EnginePaths,
  MenuAction,
  PlatformInfo,
  PluginConsentState,
  SaveResult,
  SettingsResult,
} from '../shared/protocol';
import { saveAsset } from './assets';
import { openDefault, openPath, openWithDialog, save, setPluginNamespaces } from './documents';
import { authorize, cancelAuthorization } from './oauth';
import { installPluginWithConsent, uninstallPlugin } from './plugins';
import { initAutoUpdate } from './updates';
import {
  aiConfigPath,
  getSecret,
  listSecretKeys,
  loadAiConfig,
  loadMcpConfig,
  loadPluginConsent,
  mcpConfigPath,
  readOAuthSlot,
  saveAiConfig,
  saveMcpConfig,
  savePluginConsent,
  secretsAvailable,
  setSecret,
  deleteSecret,
  userDataDir,
  userPluginsDir,
  workflowsDir,
  writeOAuthSlot,
} from './settings';

const isDev = !!process.env['ELECTRON_RENDERER_URL'];

let win: BrowserWindow | null = null;
let engine: UtilityProcess | null = null;
let controlPort: Electron.MessagePortMain | null = null;
let quitting = false;

function resourcesDir(): string {
  // Dev: app.getAppPath() is packages/app. Packaged: examples ship as
  // extraResources next to the bundled plugins.
  return isPackaged() ? join(process.resourcesPath, 'resources') : join(app.getAppPath(), 'resources');
}

function isPackaged(): boolean {
  return app.isPackaged;
}

/**
 * Where first-party plugins live. In a packaged app they are extraResources;
 * in the workspace they are the `plugins/` directory beside `packages/`, which
 * is also what makes `pnpm dev` exercise the real loader rather than a
 * development shortcut (ARCHITECTURE §8.2).
 */
function enginePaths(): EnginePaths {
  const bundled = isPackaged()
    ? join(process.resourcesPath, 'plugins')
    : resolve(app.getAppPath(), '..', '..', 'plugins');
  return {
    bundledPluginDirs: existsSync(bundled) ? [bundled] : [],
    userPluginsDir: userPluginsDir(),
    pluginChildEntry: join(__dirname, 'plugin-child.js'),
    execPath: process.execPath,
  };
}

// ---------------------------------------------------------------------------
// Engine supervision
// ---------------------------------------------------------------------------

function spawnEngine(): void {
  engine = utilityProcess.fork(join(__dirname, 'engine.js'), [], {
    serviceName: 'archspace-engine',
  });
  engine.on('exit', (code) => {
    engine = null;
    controlPort = null;
    if (quitting) return;
    // Supervision: restart the engine host and tell the renderer its
    // in-flight run (if any) is dead (§3.2). Anything waiting on the old
    // process is dead with it, and must be told so rather than left hanging.
    rejectPendingEngineCalls('the engine stopped before it could answer');
    spawnEngine();
    connectControl();
    win?.webContents.send('engine:restarted', code);
  });
  connectControl();
}

function connectControl(): void {
  if (!engine) return;
  const { port1, port2 } = new MessageChannelMain();
  engine.postMessage({ type: 'control' }, [port2]);
  controlPort = port1;
  port1.on('message', (e) => {
    void handleControlEvent(e.data as EngineControlEvent);
  });
  port1.start();
}

function toEngine(msg: EngineControlRequest): void {
  controlPort?.postMessage(msg);
}

/**
 * Requests that flow main → engine and expect an answer.
 *
 * Every other exchange on this channel runs the other way — the engine asks
 * main for a secret or an OAuth token — so the pending map is small and lives
 * here rather than in a shared helper. Reading an asset's bytes is currently
 * the only entry.
 */
const enginePending = new Map<number, { resolve: (bytes: Uint8Array) => void; reject: (err: Error) => void }>();
let engineSeq = 0;

/**
 * How long to wait for the engine to hand back an asset's bytes.
 *
 * Generous, because the store is in memory and the only real cost is the
 * structured-clone copy of a file that could be tens of megabytes. But bounded,
 * because the alternative is what a deliberately silenced engine produced in
 * the smoke test: a Save button that spins forever and says nothing. A timeout
 * that fires wrongly costs a retry; one that never fires costs the user their
 * understanding of whether anything is happening.
 */
const ASSET_READ_TIMEOUT_MS = 30_000;

function readAssetBytes(ref: AssetRef): Promise<Uint8Array> {
  const requestId = ++engineSeq;
  return new Promise<Uint8Array>((resolve, reject) => {
    if (controlPort === null) {
      reject(new Error('the engine is not running'));
      return;
    }
    const timer = setTimeout(() => {
      enginePending.delete(requestId);
      reject(new Error(`the engine did not answer within ${ASSET_READ_TIMEOUT_MS / 1000}s`));
    }, ASSET_READ_TIMEOUT_MS);
    enginePending.set(requestId, {
      resolve: (bytes) => {
        clearTimeout(timer);
        resolve(bytes);
      },
      reject: (err) => {
        clearTimeout(timer);
        reject(err);
      },
    });
    toEngine({ t: 'asset-read', requestId, ref });
  });
}

/**
 * Fail every in-flight engine request.
 *
 * Without this a save started just before the engine crashed would hang on a
 * promise nothing can ever settle, and the Save button would stay spinning
 * with no explanation.
 */
function rejectPendingEngineCalls(why: string): void {
  for (const [, entry] of enginePending) entry.reject(new Error(why));
  enginePending.clear();
}

async function pushConfig(): Promise<void> {
  const [mcp, ai, pluginConsent] = await Promise.all([loadMcpConfig(), loadAiConfig(), loadPluginConsent()]);
  // Parse issues are NOT pushed from here. They used to go out on a
  // `settings:issue` channel with no subscriber on the other end; they now
  // travel back with `getMcpConfig`/`getAiConfig`, so the panel that renders a
  // config renders what was wrong with it, at the moment someone is looking.
  toEngine({ t: 'config', mcp: mcp.config, ai: ai.config, pluginConsent });
}

async function handleControlEvent(event: EngineControlEvent): Promise<void> {
  switch (event.t) {
    case 'ready':
      toEngine({ t: 'init', paths: enginePaths() });
      await pushConfig();
      break;

    case 'secret-request': {
      try {
        const value = await getSecret(event.key);
        toEngine(value === undefined ? { t: 'secret-result', requestId: event.requestId } : { t: 'secret-result', requestId: event.requestId, value });
      } catch (err) {
        toEngine({ t: 'secret-result', requestId: event.requestId, error: err instanceof Error ? err.message : String(err) });
      }
      break;
    }

    case 'oauth-request': {
      try {
        const outcome = await authorize(event.server, event.authorizationUrl);
        toEngine({ t: 'oauth-result', requestId: event.requestId, ok: true, ...outcome });
      } catch (err) {
        toEngine({
          t: 'oauth-result',
          requestId: event.requestId,
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        });
      }
      break;
    }

    case 'oauth-store-read': {
      try {
        const json = await readOAuthSlot(event.server, event.slot);
        toEngine(json === null ? { t: 'oauth-store-result', requestId: event.requestId, ok: true } : { t: 'oauth-store-result', requestId: event.requestId, ok: true, json });
      } catch (err) {
        toEngine({ t: 'oauth-store-result', requestId: event.requestId, ok: false, error: err instanceof Error ? err.message : String(err) });
      }
      break;
    }

    case 'oauth-store-write': {
      try {
        await writeOAuthSlot(event.server, event.slot, event.json);
        toEngine({ t: 'oauth-store-result', requestId: event.requestId, ok: true });
      } catch (err) {
        toEngine({ t: 'oauth-store-result', requestId: event.requestId, ok: false, error: err instanceof Error ? err.message : String(err) });
      }
      break;
    }

    case 'asset-data': {
      const entry = enginePending.get(event.requestId);
      if (entry === undefined) break;
      enginePending.delete(event.requestId);
      if (event.ok && event.bytes !== undefined) entry.resolve(event.bytes);
      else entry.reject(new Error(event.error ?? 'the engine could not read that asset'));
      break;
    }

    case 'plugin-status':
      // The engine pushes this to the renderer as well; main listens because
      // the document serializer needs the installed namespaces to derive a
      // correct `requires:` block on save.
      setPluginNamespaces(
        Object.fromEntries(event.plugins.map((p) => [p.manifest.namespace, p.manifest.name])),
      );
      break;

    case 'mcp-status':
      break;
  }
}

function connectEngine(): void {
  if (!engine || !win) return;
  const { port1, port2 } = new MessageChannelMain();
  engine.postMessage({ type: 'renderer' }, [port1]);
  win.webContents.postMessage('engine:port', null, [port2]);
}

// ---------------------------------------------------------------------------
// Menu
// ---------------------------------------------------------------------------

function sendMenu(action: MenuAction): void {
  win?.webContents.send('menu', action);
}

function buildMenu(): void {
  const menu = Menu.buildFromTemplate([
    {
      label: 'Archspace',
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        { label: 'MCP Servers…', accelerator: 'CmdOrCtrl+,', click: () => sendMenu('settings-mcp') },
        { label: 'AI Model Profiles…', click: () => sendMenu('settings-ai') },
        { label: 'Plugins…', click: () => sendMenu('settings-plugins') },
        { label: 'Autodesk & Revit…', click: () => sendMenu('settings-autodesk') },
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' },
      ],
    },
    {
      label: 'File',
      submenu: [
        { label: 'New Workflow', accelerator: 'CmdOrCtrl+N', click: () => sendMenu('new') },
        { label: 'Open…', accelerator: 'CmdOrCtrl+O', click: () => sendMenu('open') },
        { type: 'separator' },
        { label: 'Save', accelerator: 'CmdOrCtrl+S', click: () => sendMenu('save') },
        { label: 'Save As…', accelerator: 'Shift+CmdOrCtrl+S', click: () => sendMenu('save-as') },
        { type: 'separator' },
        { role: 'close' },
      ],
    },
    {
      label: 'Edit',
      submenu: [
        { label: 'Undo', accelerator: 'CmdOrCtrl+Z', click: () => sendMenu('undo') },
        { label: 'Redo', accelerator: 'Shift+CmdOrCtrl+Z', click: () => sendMenu('redo') },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' },
      ],
    },
    {
      label: 'Run',
      submenu: [
        { label: 'Run Workflow', accelerator: 'CmdOrCtrl+R', click: () => sendMenu('run') },
        { label: 'Cancel Run', accelerator: 'CmdOrCtrl+.', click: () => sendMenu('cancel-run') },
      ],
    },
    { role: 'viewMenu' },
    { role: 'windowMenu' },
  ]);
  Menu.setApplicationMenu(menu);
}

function createWindow(): void {
  win = new BrowserWindow({
    width: 1500,
    height: 950,
    minWidth: 1120,
    minHeight: 700,
    title: 'Archspace',
    backgroundColor: '#101318',
    show: false,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  });
  win.on('ready-to-show', () => win?.show());
  win.on('closed', () => {
    win = null;
  });

  if (isDev) {
    void win.loadURL(process.env['ELECTRON_RENDERER_URL'] as string);
  } else {
    void win.loadFile(join(__dirname, '../renderer/index.html'));
  }
}

// ---- IPC -------------------------------------------------------------------

const ok = (): SettingsResult => ({ ok: true });
const fail = (err: unknown): SettingsResult => ({
  ok: false,
  error: err instanceof Error ? err.message : String(err),
});

ipcMain.handle('workflow:open-dialog', () => (win ? openWithDialog(win) : { ok: false, error: 'no window' }));
ipcMain.handle('workflow:open-path', (_e, path: string) => openPath(path));
ipcMain.handle('workflow:open-default', () => openDefault(resourcesDir()));
ipcMain.handle('workflow:save', (_e, path: string | null, doc: WorkflowDoc) =>
  win ? save(win, path, doc) : { ok: false, error: 'no window' },
);
ipcMain.on('engine:request-port', () => connectEngine());
ipcMain.on('app:set-dirty', (_e, dirty: boolean) => {
  win?.setDocumentEdited(dirty);
});

ipcMain.handle(
  'app:platform',
  (): PlatformInfo => ({
    platform: process.platform,
    arch: process.arch,
    appVersion: app.getVersion(),
    electronVersion: process.versions.electron,
    paths: {
      userData: userDataDir(),
      mcpConfig: mcpConfigPath(),
      aiConfig: aiConfigPath(),
      userPlugins: userPluginsDir(),
      workflows: workflowsDir(),
    },
    secretsAvailable: secretsAvailable(),
  }),
);

ipcMain.handle('settings:get-mcp', async () => loadMcpConfig());
ipcMain.handle('settings:set-mcp', async (_e, config: McpConfig) => {
  try {
    await saveMcpConfig(config);
    await pushConfig();
    return ok();
  } catch (err) {
    return fail(err);
  }
});

ipcMain.handle('settings:get-ai', async () => loadAiConfig());
ipcMain.handle('settings:set-ai', async (_e, config: AiGatewayConfig) => {
  try {
    await saveAiConfig(config);
    await pushConfig();
    return ok();
  } catch (err) {
    return fail(err);
  }
});

ipcMain.handle('secrets:list', () => listSecretKeys());
ipcMain.handle('secrets:set', async (_e, key: string, value: string) => {
  try {
    await setSecret(key, value);
    // A newly available key can change a profile from "missing key" to "ready",
    // so the engine is told immediately rather than at next launch.
    await pushConfig();
    return ok();
  } catch (err) {
    return fail(err);
  }
});
ipcMain.handle('secrets:delete', async (_e, key: string) => {
  try {
    await deleteSecret(key);
    await pushConfig();
    return ok();
  } catch (err) {
    return fail(err);
  }
});

ipcMain.handle('plugins:install', () => (win ? installPluginWithConsent(win) : { ok: false, error: 'no window' }));
ipcMain.handle('plugins:uninstall', async (_e, id: string) => {
  if (!win) return fail(new Error('no window'));
  const result = await uninstallPlugin(win, id);
  if (result.ok) await pushConfig();
  return result;
});
ipcMain.handle('plugins:get-consent', () => loadPluginConsent());
ipcMain.handle('plugins:set-consent', async (_e, state: PluginConsentState) => {
  try {
    await savePluginConsent(state);
    await pushConfig();
    return ok();
  } catch (err) {
    return fail(err);
  }
});

ipcMain.handle('asset:save', async (_e, ref: AssetRef): Promise<SaveResult> => {
  if (!isAssetRef(ref)) return { ok: false, error: 'not an asset reference' };
  if (win === null) return { ok: false, error: 'no window to show a save dialog in' };
  return saveAsset(win, ref, readAssetBytes);
});

ipcMain.handle('autodesk:capabilities', () => AUTODESK_CAPABILITIES);
ipcMain.handle('autodesk:presets', () => revitPresets(process.platform));

ipcMain.handle('shell:reveal', (_e, path: string) => {
  shell.showItemInFolder(path);
});
ipcMain.handle('shell:open-external', async (_e, url: string) => {
  // Only ever http(s): a renderer-supplied URL must not be able to launch a
  // local handler.
  const parsed = new URL(url);
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new Error(`refusing to open a ${parsed.protocol} URL`);
  }
  await shell.openExternal(url);
});

// ---- lifecycle -------------------------------------------------------------

app
  .whenReady()
  .then(() => {
    buildMenu();
    spawnEngine();
    createWindow();
    // After the window, on purpose: the first thing this app does with the
    // user's network should be showing them their workflow, not polling a feed.
    initAutoUpdate();
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  })
  .catch((err: unknown) => {
    // Startup is the one failure with nothing left to fall back on: there is no
    // window to draw a notice in and no renderer to receive one. Without this
    // the whole boot path was a floating promise, so a throw in spawnEngine or
    // createWindow became an unhandled rejection — a silent quit, or a crash
    // report naming a line the user cannot act on. showErrorBox is the one
    // dialog that works before any window exists.
    dialog.showErrorBox(
      'Archspace could not start',
      `${err instanceof Error ? err.message : String(err)}\n\n` +
        'This is a bug. Reinstalling, or removing the plugins folder in the ' +
        'application support directory, is the usual way past it.',
    );
    app.quit();
  });

app.on('before-quit', () => {
  quitting = true;
  cancelAuthorization();
  engine?.kill();
});

app.on('window-all-closed', () => {
  app.quit();
});
