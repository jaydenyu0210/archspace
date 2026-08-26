/**
 * The plugin child entry, as shipped inside the app bundle.
 *
 * A plugin runs in its own OS process (ARCHITECTURE §8.1). The engine host
 * forks THIS script — never the plugin's own code directly — so the capability
 * RPC, the permission mediation and the crash reporting are the host's code on
 * both sides of the boundary, and the plugin only ever supplies node modules.
 *
 * It exists as a separate electron-vite entry point because a packaged app has
 * no `node` on PATH: the engine forks the Electron binary with
 * ELECTRON_RUN_AS_NODE=1 pointing at the built `out/main/plugin-child.js`.
 */
import { runPluginChild } from '@archspace/plugin-host/child';

runPluginChild();
