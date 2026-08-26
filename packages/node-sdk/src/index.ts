/**
 * @archspace/node-sdk — the public node contract (ARCHITECTURE §5.2 / ADR-0005).
 *
 * A node type is a declarative NodeManifest (pure serializable data; params as
 * a JSON Schema 2020-12 subset) plus one async execute(ctx, inputs, params).
 * The ctx is the entire world a node can touch — no ambient authority.
 */
import { blake3 } from '@noble/hashes/blake3';
import { bytesToHex } from '@noble/hashes/utils';
import { parsePortType } from '@archspace/types';

/** Everything that flows on a wire: JSON values plus asset references.
 *  Invariant: wire values are small. Bulk bytes always travel as AssetRef. */
export type Value =
  | null | boolean | number | string
  | Value[]
  | { [key: string]: Value }
  | AssetRef;

export interface AssetRef {
  kind: 'asset';
  hash: string;              // "b3:<hex>" — content address
  mediaType: string;         // "model/ifc", "image/png", "text/csv", …
  format?: string;           // port-type tag: "ifc" | "dxf" | "csv" | …
  name?: string;             // display name hint
  size: number;              // bytes
}

export function isAssetRef(v: unknown): v is AssetRef {
  return typeof v === 'object' && v !== null
    && (v as AssetRef).kind === 'asset'
    && typeof (v as AssetRef).hash === 'string'
    && typeof (v as AssetRef).mediaType === 'string'
    && typeof (v as AssetRef).size === 'number';
}

/** Port type expression — grammar and rules in @archspace/types (§6). */
export type PortType = string;

export interface PortDecl {
  id: string;                // snake_case, unique within the node
  type: PortType;
  label?: string;
  description?: string;
  required?: boolean;        // inputs only; default true
  variadic?: boolean;        // inputs only; N edges of T collected into list<T>
}

/** Loose JSON Schema (2020-12 subset) object type for manifest params. */
export interface JsonSchemaObject {
  type: 'object';
  properties?: Record<string, JsonSchemaProperty>;
  required?: string[];
  additionalProperties?: boolean;
  [key: string]: unknown;
}

export interface JsonSchemaProperty {
  type?: string;
  title?: string;
  description?: string;
  default?: unknown;
  enum?: unknown[];
  minimum?: number;
  maximum?: number;
  multipleOf?: number;
  'x-archspace'?: {
    widget?: 'textarea' | 'select' | 'slider';
    rows?: number;
    placeholder?: string;
    promotable?: boolean;
    secretRef?: boolean;
    group?: string;
  };
  [key: string]: unknown;
}

export type Lane = 'cpu' | 'io' | 'ai' | `mcp:${string}`;

export interface NodeManifest {
  /** Globally unique, namespaced: "<ns>.<group>.<name>".
   *  Namespaces "core", "ai", "mcp" (and, in this build, "aec") are the app's. */
  type: string;
  /** Major version of the observable contract (ports/params/semantics). */
  version: number;
  label: string;
  description: string;
  category: string;          // palette grouping
  icon?: string;
  keywords?: string[];
  params: JsonSchemaObject;
  inputs: PortDecl[];
  outputs: PortDecl[];
  /** 'pure': same inputs+params ⇒ same outputs; engine may memoize (§7).
   *  'never': always executes. Default 'never' — purity is opt-in. */
  caching: 'pure' | 'never';
  /** Scheduler lane (§7). Default 'cpu'. */
  lane?: Lane;
  /** Capabilities requested; anything undeclared is absent from ctx. */
  permissions?: string[];
}

export type Inputs = Readonly<Record<string, Value | undefined>>;
export type Outputs = Record<string, Value>;

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

/** Provider-agnostic AI surface (§10). This build ships no real gateway; the
 *  engine injects a stub that fails with a clear message, and the testkit lets
 *  tests script responses. The interface is the forward-compat hook. */
export interface AiGateway {
  generateText(req: {
    profile?: string;
    prompt?: string;
    system?: string;
    messages?: ChatMessage[];
    signal?: AbortSignal;
  }): Promise<{ text: string }>;
  generateObject(req: {
    profile?: string;
    prompt?: string;
    system?: string;
    messages?: ChatMessage[];
    schema: JsonSchemaObject;
    signal?: AbortSignal;
  }): Promise<{ object: Value }>;
  embed(req: { profile?: string; values: string[]; signal?: AbortSignal }): Promise<{ embeddings: number[][] }>;
}

export interface AssetStore {
  open(ref: AssetRef): Promise<ReadableStream<Uint8Array>>;
  bytes(ref: AssetRef): Promise<Uint8Array>;
  put(
    data: Uint8Array | ReadableStream<Uint8Array>,
    meta: { mediaType: string; format?: string; name?: string },
  ): Promise<AssetRef>;
}

/** Everything a node can touch. Nothing else is reachable. */
export interface NodeContext {
  signal: AbortSignal;
  runId: string;
  nodeId: string;

  log(level: LogLevel, message: string, data?: Value): void;
  progress(fraction?: number, message?: string): void;

  assets: AssetStore;

  /** Resolves only keys declared in manifest.permissions AND granted. */
  secrets: { get(key: string): Promise<string> };

  ai: AiGateway;

  /** Present only when 'net' permission is declared and granted. */
  fetch?: typeof fetch;

  tempDir(): Promise<string>;

  /** Marks a thrown failure as transient so the engine may retry it (§7.5). */
  retryable<E extends Error>(err: E): E;
}

export interface NodeModule<P = unknown> {
  manifest: NodeManifest;
  execute(ctx: NodeContext, inputs: Inputs, params: P): Promise<Outputs>;
  /** Rewrite params written by an older major version of this node. */
  migrateParams?(old: unknown, fromVersion: number): P;
}

// ---------------------------------------------------------------------------
// Retryable error marking
// ---------------------------------------------------------------------------

const RETRYABLE = Symbol.for('archspace.retryable');

export function markRetryable<E extends Error>(err: E): E {
  (err as E & { [RETRYABLE]?: boolean })[RETRYABLE] = true;
  return err;
}

export function isRetryableError(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { [RETRYABLE]?: boolean })[RETRYABLE] === true;
}

// ---------------------------------------------------------------------------
// Node registry
// ---------------------------------------------------------------------------

const NODE_TYPE = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/;

export interface NodeRegistry {
  register(mod: NodeModule<never> | NodeModule<unknown>): void;
  has(type: string): boolean;
  get(type: string): NodeModule<unknown> | undefined;
  manifests(): NodeManifest[];
}

export function createNodeRegistry(): NodeRegistry {
  const byType = new Map<string, NodeModule<unknown>>();
  return {
    register(mod) {
      const m = mod.manifest;
      if (!NODE_TYPE.test(m.type)) throw new Error(`invalid node type id "${m.type}"`);
      if (byType.has(m.type)) throw new Error(`duplicate node type "${m.type}"`);
      if (!Number.isInteger(m.version) || m.version < 1) throw new Error(`node "${m.type}": version must be a positive integer`);
      const seen = new Set<string>();
      for (const port of [...m.inputs, ...m.outputs]) {
        if (parsePortType(port.type) === null) {
          throw new Error(`node "${m.type}": port "${port.id}" has invalid type "${port.type}"`);
        }
        const side = m.inputs.includes(port) ? 'in' : 'out';
        const key = `${side}:${port.id}`;
        if (seen.has(key)) throw new Error(`node "${m.type}": duplicate ${side}put port "${port.id}"`);
        seen.add(key);
      }
      byType.set(m.type, mod as NodeModule<unknown>);
    },
    has: (type) => byType.has(type),
    get: (type) => byType.get(type),
    manifests: () => [...byType.values()].map((mod) => mod.manifest),
  };
}

// ---------------------------------------------------------------------------
// Shared helpers: schema defaults, content hashing, in-memory asset store
// ---------------------------------------------------------------------------

/** Merge top-level schema defaults under explicit config (shallow, v1). */
export function applySchemaDefaults(
  schema: JsonSchemaObject,
  config: Record<string, unknown> | undefined,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, prop] of Object.entries(schema.properties ?? {})) {
    if (prop.default !== undefined) out[key] = structuredClone(prop.default);
  }
  return { ...out, ...(config ?? {}) };
}

export function hashBytes(data: Uint8Array): string {
  return `b3:${bytesToHex(blake3(data))}`;
}

async function collect(data: Uint8Array | ReadableStream<Uint8Array>): Promise<Uint8Array> {
  if (data instanceof Uint8Array) return data;
  const chunks: Uint8Array[] = [];
  const reader = data.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) chunks.push(value);
  }
  const total = chunks.reduce((n, c) => n + c.byteLength, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.byteLength;
  }
  return out;
}

/** Content-addressed in-memory asset store. The only store in this build —
 *  it stands in for the persistent CAS of ARCHITECTURE §11. */
export class MemoryAssetStore implements AssetStore {
  private blobs = new Map<string, { bytes: Uint8Array; ref: AssetRef }>();

  async put(
    data: Uint8Array | ReadableStream<Uint8Array>,
    meta: { mediaType: string; format?: string; name?: string },
  ): Promise<AssetRef> {
    const bytes = await collect(data);
    const hash = hashBytes(bytes);
    const ref: AssetRef = {
      kind: 'asset',
      hash,
      mediaType: meta.mediaType,
      ...(meta.format !== undefined ? { format: meta.format } : {}),
      ...(meta.name !== undefined ? { name: meta.name } : {}),
      size: bytes.byteLength,
    };
    this.blobs.set(hash, { bytes, ref });
    return ref;
  }

  async bytes(ref: AssetRef): Promise<Uint8Array> {
    const entry = this.blobs.get(ref.hash);
    if (!entry) throw new Error(`asset not found: ${ref.hash}`);
    return entry.bytes;
  }

  async open(ref: AssetRef): Promise<ReadableStream<Uint8Array>> {
    const bytes = await this.bytes(ref);
    return new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes);
        controller.close();
      },
    });
  }

  async text(ref: AssetRef): Promise<string> {
    return new TextDecoder().decode(await this.bytes(ref));
  }

  list(): AssetRef[] {
    return [...this.blobs.values()].map((e) => e.ref);
  }

  has(hash: string): boolean {
    return this.blobs.has(hash);
  }
}

export function createMemoryAssetStore(): MemoryAssetStore {
  return new MemoryAssetStore();
}
