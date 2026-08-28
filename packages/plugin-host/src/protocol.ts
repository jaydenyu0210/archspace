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

const LOG_LEVELS = new Set(['debug', 'info', 'warn', 'error']);

const HOST_CALL_METHODS = new Set([
  'assets.bytes',
  'assets.put',
  'secrets.get',
  'ai.generateText',
  'ai.generateObject',
  'ai.embed',
  'fetch',
]);

const isNumber = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const isString = (v: unknown): v is string => typeof v === 'string';
const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * A plugin process is untrusted input: never destructure a message before this
 * has said it is one of ours.
 *
 * "One of ours" means the *shape*, not merely the tag. It used to mean the tag
 * alone, which made the guarantee this comment offers untrue in the one place
 * it mattered: `spawnAndLoad` reads `raw.manifests.find(…)` straight off a
 * `ready` message, so a plugin that sent `{"t":"ready","v":1}` — a bug in a
 * third-party SDK is enough, malice is not required — threw a TypeError inside
 * a `message` listener. That is an uncaught exception in the engine child, so
 * one malformed line from a plugin took down the process whose entire purpose
 * is to survive that plugin (ADR-0008, crash containment).
 *
 * Validation is per-tag and unforgiving, and a message that fails is dropped,
 * exactly as an unknown tag always was. Being strict here is safe because the
 * host never *needs* a child's message to make progress: `spawnAndLoad` has a
 * start timeout, and an exec whose `result` is dropped still fails when the
 * process exits or is killed.
 */
export function isChildToHost(message: unknown): message is ChildToHost {
  if (!isPlainObject(message)) return false;
  switch (message.t) {
    case 'ready':
      return isNumber(message.v) && Array.isArray(message.manifests) && message.manifests.every(isNodeManifestShaped);
    case 'load-error':
      return isString(message.message);
    case 'log':
      return isNumber(message.id) && isString(message.level) && LOG_LEVELS.has(message.level) && isString(message.message);
    case 'progress':
      return (
        isNumber(message.id) &&
        (message.fraction === undefined || isNumber(message.fraction)) &&
        (message.message === undefined || isString(message.message))
      );
    case 'host-call':
      return (
        isNumber(message.callId) && isNumber(message.id) && isString(message.method) && HOST_CALL_METHODS.has(message.method)
      );
    case 'result':
      return isNumber(message.id) && isPlainObject(message.outputs);
    case 'error':
      return (
        isNumber(message.id) &&
        isString(message.message) &&
        typeof message.retryable === 'boolean' &&
        (message.cancelled === undefined || typeof message.cancelled === 'boolean')
      );
    default:
      return false;
  }
}

/**
 * The fields of a `NodeManifest` the host itself dereferences before the plugin
 * has proved anything — deliberately not a full schema check.
 *
 * `type` is checked because the namespace guard reads it, `version` and
 * `label` because the palette does, and `inputs`/`outputs`/`params` because the
 * engine walks them for every edge. Beyond that the manifest is the plugin's
 * own contract with its users, and a host that validated it exhaustively would
 * be re-implementing the node SDK on the far side of a process boundary.
 */
function isNodeManifestShaped(value: unknown): boolean {
  return (
    isPlainObject(value) &&
    isString(value.type) &&
    isNumber(value.version) &&
    isString(value.label) &&
    Array.isArray(value.inputs) &&
    Array.isArray(value.outputs) &&
    isPlainObject(value.params)
  );
}

export function toBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('base64');
}

/**
 * The `<ArrayBuffer>` argument is load-bearing and not decoration. This module
 * is type-pulled into the renderer's compile (via `app/src/shared/protocol.ts`),
 * where `lib.dom` is in scope and `BodyInit` accepts a `BufferSource` — which
 * excludes a buffer that might be a `SharedArrayBuffer`. Bare `Uint8Array`
 * widens to `ArrayBufferLike` under TS ≥5.7 and so fails to satisfy it, even
 * though copying out of a `Buffer` can only ever produce a plain `ArrayBuffer`.
 * Pinning it here keeps every caller assignable under both libs, instead of
 * making each one cast at the point of use.
 */
export function fromBase64(text: string): Uint8Array<ArrayBuffer> {
  return new Uint8Array(Buffer.from(text, 'base64'));
}
