/**
 * Preload — the only bridge between the sandboxed renderer and the world.
 * Exposes a small typed API and forwards the engine MessagePort into the
 * main world (ports cannot cross contextBridge, so we re-post them).
 *
 * Note what is NOT here: there is no `getSecret`. The renderer can create,
 * list and delete secret KEYS, and it can never read a value back — that
 * asymmetry is deliberate and is the reason the whole settings surface routes
 * through main instead of living in the renderer (ARCHITECTURE §12).
 */
import { contextBridge, ipcRenderer } from 'electron';
import { ENGINE_PORT_MESSAGE, type ArchspaceBridge, type MenuAction } from '../shared/protocol';

const bridge: ArchspaceBridge = {
  openDialog: () => ipcRenderer.invoke('workflow:open-dialog'),
  openDefault: () => ipcRenderer.invoke('workflow:open-default'),
  save: (path, doc) => ipcRenderer.invoke('workflow:save', path, doc),
  requestEnginePort: () => ipcRenderer.send('engine:request-port'),
  onMenu: (cb) => {
    ipcRenderer.on('menu', (_e, action: MenuAction) => cb(action));
  },
  onEngineRestarted: (cb) => {
    ipcRenderer.on('engine:restarted', () => cb());
  },
  onEngineGaveUp: (cb) => {
    ipcRenderer.on('engine:gave-up', (_e, restarts: number) => cb(restarts));
  },
  setDirty: (dirty) => ipcRenderer.send('app:set-dirty', dirty),

  platform: () => ipcRenderer.invoke('app:platform'),

  getMcpConfig: () => ipcRenderer.invoke('settings:get-mcp'),
  setMcpConfig: (config) => ipcRenderer.invoke('settings:set-mcp', config),
  revealPath: (path) => ipcRenderer.invoke('shell:reveal', path),

  getAiConfig: () => ipcRenderer.invoke('settings:get-ai'),
  setAiConfig: (config) => ipcRenderer.invoke('settings:set-ai', config),

  listSecretKeys: () => ipcRenderer.invoke('secrets:list'),
  setSecret: (key, value) => ipcRenderer.invoke('secrets:set', key, value),
  deleteSecret: (key) => ipcRenderer.invoke('secrets:delete', key),

  installPlugin: () => ipcRenderer.invoke('plugins:install'),
  uninstallPlugin: (id) => ipcRenderer.invoke('plugins:uninstall', id),
  getPluginConsent: () => ipcRenderer.invoke('plugins:get-consent'),
  setPluginConsent: (state) => ipcRenderer.invoke('plugins:set-consent', state),

  autodeskCapabilities: () => ipcRenderer.invoke('autodesk:capabilities'),
  autodeskPresets: () => ipcRenderer.invoke('autodesk:presets'),

  openExternal: (url) => ipcRenderer.invoke('shell:open-external', url),

  saveAsset: (ref) => ipcRenderer.invoke('asset:save', ref),
  readAsset: (ref) => ipcRenderer.invoke('asset:read', ref),
};

contextBridge.exposeInMainWorld('archspace', bridge);

// Electron's documented pattern: relay the MessagePort to the main world
// via window.postMessage, which CAN transfer ports across the isolation
// boundary.
ipcRenderer.on('engine:port', (event) => {
  window.postMessage({ type: ENGINE_PORT_MESSAGE }, '*', event.ports);
});
