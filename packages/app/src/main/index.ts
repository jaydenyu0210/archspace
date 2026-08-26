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
import type {
  EngineControlEvent,
  EngineControlRequest,
  EnginePaths,
  MenuAction,
  PlatformInfo,
  PluginConsentState,
  SettingsResult,
} from '../shared/protocol';
import { openDefault, openPath, openWithDialog, save, setPluginNamespaces } from './documents';
import { authorize, cancelAuthorization } from './oauth';
import { installPluginWithConsent, uninstallPlugin } from './plugins';
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
    // in-flight run (if any) is dead (§3.2).
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

async function pushConfig(): Promise<void> {
  const [mcp, ai, pluginConsent] = await Promise.all([loadMcpConfig(), loadAiConfig(), loadPluginConsent()]);
  for (const issue of [...mcp.issues, ...ai.issues]) {
    win?.webContents.send('settings:issue', issue);
  }
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

ipcMain.handle('settings:get-mcp', async () => (await loadMcpConfig()).config);
ipcMain.handle('settings:set-mcp', async (_e, config: McpConfig) => {
  try {
    await saveMcpConfig(config);
    await pushConfig();
    return ok();
  } catch (err) {
    return fail(err);
  }
});

ipcMain.handle('settings:get-ai', async () => (await loadAiConfig()).config);
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

app.whenReady().then(() => {
  buildMenu();
  spawnEngine();
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('before-quit', () => {
  quitting = true;
  cancelAuthorization();
  engine?.kill();
});

app.on('window-all-closed', () => {
  app.quit();
});
