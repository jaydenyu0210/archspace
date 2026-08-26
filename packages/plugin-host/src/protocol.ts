/**
 * The versioned host ↔ plugin-child RPC wire format (ARCHITECTURE §8.1, ADR-0008).
 *
 * This is hand-written rather than generated because the boundary is the
 * security-relevant surface of the whole plugin system: every message a plugin
 * process can send has to be enumerable, and reviewable, on one screen.
 *
 * Two constraints shape it:
 *
 *  - **JSON only.** `node:child_process` IPC is only *guaranteed* to carry
 *    JSON; `serialization: 'advanced'` is an option an embedder (Electron's
 *    ELECTRON_RUN_AS_NODE fork, a future socket transport) may not offer. So
 *    bytes travel base64 and nothing here relies on structured clone. That is
 *    affordable precisely because of the wire-value invariant of §8.1 — bulk
 *    data is an `AssetRef`, never a payload — so base64 is paid on the rare
 *    deliberate byte transfer, not on ordinary node output.
 *  - **Request/response by id, in both directions.** The host answers a child's
 *    `host-call` with `host-result`; the child answers the host's `exec` with
 *    `result` or `error`. Everything else (`log`, `progress`) is one-way and
 *    carries the exec id so the host can attribute it to the right node.
 *
 * Capability calls are named methods rather than a generic "invoke", because
 * the host has to make a permission decision per method and an open-ended
 * surface cannot be mediated.
 */
import type { AssetRef, ChatMessage, JsonSchemaObject, LogLevel, NodeManifest, Value } from '@archspace/node-sdk';

/** Bumped when the message shapes change incompatibly. Independent of
 *  `ENGINE_API`, which versions the *node* contract a plugin is built against. */
export const PLUGIN_RPC_VERSION = 1;

// ---------------------------------------------------------------------------
// Host → child
// ---------------------------------------------------------------------------

export interface InitMessage {
  t: 'init';
  v: number;
  pluginId: string;
  namespace: string;
  /** Absolute path to the plugin's built ESM entry. */
  entry: string;
  /** Declared ∩ granted. The child mediates against this too, so an undeclared
   *  capability is refused before it ever reaches the host. */
  permissions: string[];
}

export interface ExecMessage {
  t: 'exec';
  id: number;
  nodeType: string;
  runId: string;
  nodeId: string;
  inputs: Record<string, Value>;
  params: Value;
}

export interface CancelMessage {
  t: 'cancel';
  id: number;
}

export interface HostResultMessage {
  t: 'host-result';
  callId: number;
  ok: boolean;
  value?: unknown;
  error?: string;
}

export interface ShutdownMessage {
  t: 'shutdown';
}

export type HostToChild = InitMessage | ExecMessage | CancelMessage | HostResultMessage | ShutdownMessage;

// ---------------------------------------------------------------------------
// Child → host
// ---------------------------------------------------------------------------

export interface ReadyMessage {
  t: 'ready';
  v: number;
  manifests: NodeManifest[];
}

export interface LoadErrorMessage {
  t: 'load-error';
  message: string;
}

export interface LogMessage {
  t: 'log';
  id: number;
  level: LogLevel;
  message: string;
  data?: Value;
}

export interface ProgressMessage {
  t: 'progress';
  id: number;
  fraction?: number;
  message?: string;
}

export interface HostCallMessage {
  t: 'host-call';
  callId: number;
  /** The exec this call belongs to; 0 when it belongs to no node (never today). */
  id: number;
  method: HostCallMethod;
  args: unknown;
}

export interface ResultMessage {
  t: 'result';
  id: number;
  outputs: Record<string, Value>;
}

export interface ErrorMessage {
  t: 'error';
  id: number;
  message: string;
  /** The node marked the failure transient with `ctx.retryable` (§7.5). */
  retryable: boolean;
  /** The failure is the node observing its own cancellation, not a fault. */
  cancelled?: boolean;
}

export type ChildToHost =
  | ReadyMessage
  | LoadErrorMessage
  | LogMessage
  | ProgressMessage
  | HostCallMessage
  | ResultMessage
  | ErrorMessage;

// ---------------------------------------------------------------------------
// Capability calls
// ---------------------------------------------------------------------------

export type HostCallMethod =
  | 'assets.bytes'
  | 'assets.put'
  | 'secrets.get'
  | 'ai.generateText'
  | 'ai.generateObject'
  | 'ai.embed'
  | 'fetch';

export interface AssetBytesArgs {
  ref: AssetRef;
}
export interface AssetBytesResult {
  base64: string;
}

export interface AssetPutArgs {
  base64: string;
  meta: { mediaType: string; format?: string; name?: string };
}

export interface SecretGetArgs {
  key: string;
}

/** `AbortSignal` is not serializable; cancellation travels as a `cancel`
 *  message instead and the host aborts the in-flight capability call. */
export interface AiTextArgs {
  profile?: string;
  prompt?: string;
  system?: string;
  messages?: ChatMessage[];
}
export interface AiObjectArgs extends AiTextArgs {
  schema: JsonSchemaObject;
}
export interface AiEmbedArgs {
  profile?: string;
  values: string[];
}

export interface FetchArgs {
  url: string;
  method: string;
  /** Header pairs, because `Headers` does not survive JSON. */
  headers: [string, string][];
  bodyBase64?: string;
}
export interface FetchResult {
  status: number;
  statusText: string;
  headers: [string, string][];
  bodyBase64: string;
}

// ---------------------------------------------------------------------------
// Narrowing
// ---------------------------------------------------------------------------

const CHILD_MESSAGE_TAGS = new Set(['ready', 'load-error', 'log', 'progress', 'host-call', 'result', 'error']);

/** A plugin process is untrusted input: never destructure a message before
 *  this has said it is one of ours. */
export function isChildToHost(message: unknown): message is ChildToHost {
  return (
    typeof message === 'object' &&
    message !== null &&
    typeof (message as { t?: unknown }).t === 'string' &&
    CHILD_MESSAGE_TAGS.has((message as { t: string }).t)
  );
}

export function toBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('base64');
}

export function fromBase64(text: string): Uint8Array {
  return new Uint8Array(Buffer.from(text, 'base64'));
}
