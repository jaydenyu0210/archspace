/**
 * The process seam (ADR-0008 §1).
 *
 * `PluginSpawn` exists so the host never reaches for `child_process` directly:
 * Electron has to fork with `ELECTRON_RUN_AS_NODE`, tests want a fake process
 * they can crash on demand, and a future sandboxed launcher (the seatbelt
 * milestone) is a different spawn again. Everything above this file talks to a
 * `PluginProcess` and cannot tell which it got.
 *
 * The default is a plain `fork` with JSON IPC. `execArgv` gets a TypeScript
 * loader when — and only when — the child entry is a `.ts` file, which is how
 * the CLI runs from source while the packaged app runs the bundled `.js`
 * without paying for a loader.
 */
import { fork } from 'node:child_process';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import type { HostToChild } from './protocol.js';

export interface PluginSpawnOptions {
  cwd: string;
  env: Record<string, string>;
}

export interface PluginProcess {
  /**
   * Outbound is typed to the protocol union, not `unknown`: the host is the
   * only author of these messages, so there is nothing to validate and every
   * transport (`fork`, an Electron fork, a test fake) can then prove it accepts
   * exactly what the host sends. Typing it `unknown` pushed a cast into every
   * implementer, which is the opposite of what a seam is for.
   */
  send(message: HostToChild): void;
  /**
   * Inbound stays `unknown` on purpose, and asymmetrically: this is the one
   * place plugin-authored bytes enter the host, so the type has to force a
   * validation step rather than assert a shape we have not checked (§8.1).
   */
  onMessage(cb: (message: unknown) => void): void;
  onExit(cb: (code: number | null, signal: string | null) => void): void;
  kill(signal?: NodeJS.Signals): void;
  /** Optional because a fake process in a test has no stderr to speak of. */
  onStderr?(cb: (text: string) => void): void;
  readonly pid: number | undefined;
}

export type PluginSpawn = (childEntry: string, argv: string[], opts: PluginSpawnOptions) => PluginProcess;

/**
 * Resolve a TypeScript loader for a `.ts` child entry.
 *
 * Node ≥22.18 strips types natively, but not for files it considers to be in
 * `node_modules`, and the child imports the SDK from a workspace link — so we
 * prefer `tsx` when it is installed next to the entry and fall back to bare
 * node rather than failing loudly, since the packaged app never takes this path.
 */
function typescriptExecArgv(childEntry: string): string[] {
  if (!childEntry.endsWith('.ts')) return [];
  try {
    const require = createRequire(pathToFileURL(childEntry));
    return ['--import', pathToFileURL(require.resolve('tsx/esm')).href];
  } catch {
    return [];
  }
}

export const forkPluginSpawn: PluginSpawn = (childEntry, argv, opts) => {
  const child = fork(childEntry, argv, {
    cwd: opts.cwd,
    env: opts.env,
    execArgv: typescriptExecArgv(childEntry),
    // stdout/stderr are piped rather than inherited so a chatty plugin cannot
    // scribble over the app's own output; the host forwards stderr to its log.
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });

  return {
    get pid(): number | undefined {
      return child.pid;
    },
    send(message: HostToChild): void {
      // The channel is gone the instant the child dies; a plugin crashing
      // mid-send must not take the host's event loop down with it.
      if (child.connected) child.send(message, undefined, undefined, () => undefined);
    },
    onMessage(cb): void {
      child.on('message', (message) => cb(message));
    },
    onExit(cb): void {
      child.on('exit', (code, signal) => cb(code, signal));
      child.on('error', () => cb(null, null));
    },
    onStderr(cb): void {
      child.stderr?.setEncoding('utf8');
      child.stderr?.on('data', (chunk: string) => cb(chunk));
      child.stdout?.setEncoding('utf8');
      child.stdout?.on('data', (chunk: string) => cb(chunk));
    },
    kill(signal): void {
      child.kill(signal);
    },
  };
};
