/**
 * @archspace/plugin-host — the public face of the plugin boundary
 * (ARCHITECTURE §8 / ADR-0008).
 *
 * Four things live behind this barrel, and they are four because the boundary
 * has four separable jobs:
 *
 *   manifest   what a plugin declares about itself, and the permission
 *              vocabulary the consent sheet is written from;
 *   install    how a packed plugin becomes a directory under the managed
 *              plugins folder — and how it stops being one;
 *   spawn      the process seam, so nothing above it names `child_process`
 *              (or, in the app, Electron's fork);
 *   host       discovery, consent, supervision, and the capability RPC that
 *              is the only authority a plugin ever receives.
 *
 * `protocol` is exported too, even though it is machinery: it is the versioned
 * wire contract, and an embedder writing its own `PluginSpawn` (the app does,
 * for `ELECTRON_RUN_AS_NODE`; the CLI does, for `tsx`) has to be able to name
 * the messages that cross it.
 *
 * **`child.ts` is deliberately not here.** It is the runtime that executes
 * *inside* a plugin process — it installs a `process.on('message')` pump and
 * runs itself when it is the entry point. Re-exporting it would put the child's
 * module graph inside every host that imports this package and blur the one
 * distinction the whole design rests on: this side mediates, that side is
 * mediated. It has its own `"./child"` export path instead, which is what
 * `packages/app/src/plugin-child` imports and what `forkPluginSpawn` forks.
 *
 * Explicit re-exports rather than `export *`: `secretKeyOf` is deliberately
 * available from both `host` and `manifest`, and a star barrel would make that
 * an ambiguity to resolve rather than a convenience to offer.
 */

// --- What a plugin declares -------------------------------------------------
export {
  ENGINE_API,
  PLUGIN_MANIFEST_FILENAME,
  describePermission,
  entryPath,
  isContainedRelativePath,
  isKnownPermission,
  parsePluginManifest,
  secretKeyOf,
} from './manifest.js';
export type { ConfigIssue, PluginManifest } from './manifest.js';

// --- Getting one onto (and off) the machine ---------------------------------
export { installPluginFromPath, uninstallPlugin } from './install.js';
export type { PluginInstallation } from './install.js';
export { containsNativeCode } from './native.js';

// --- The process seam -------------------------------------------------------
export { forkPluginSpawn } from './spawn.js';
export type { PluginProcess, PluginSpawn, PluginSpawnOptions } from './spawn.js';

// --- The host ---------------------------------------------------------------
export { createPluginHost } from './host.js';
export type {
  CreatePluginHostOptions,
  HostCapabilities,
  HostLog,
  InstalledPluginInfo,
  PluginConsent,
  PluginConsentState,
  PluginHost,
  PluginState,
} from './host.js';

// --- The wire ---------------------------------------------------------------
export { PLUGIN_RPC_VERSION, fromBase64, isChildToHost, toBase64 } from './protocol.js';
export type {
  AiEmbedArgs,
  AiObjectArgs,
  AiTextArgs,
  AssetBytesArgs,
  AssetBytesResult,
  AssetPutArgs,
  CancelMessage,
  ChildToHost,
  ErrorMessage,
  ExecMessage,
  FetchArgs,
  FetchResult,
  HostCallMessage,
  HostCallMethod,
  HostResultMessage,
  HostToChild,
  InitMessage,
  LoadErrorMessage,
  LogMessage,
  ProgressMessage,
  ReadyMessage,
  ResultMessage,
  SecretGetArgs,
  ShutdownMessage,
} from './protocol.js';
