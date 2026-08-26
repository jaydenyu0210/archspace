/**
 * MCP tool results → Archspace wire values (ARCHITECTURE §9.3, §11).
 *
 * The invariant this file exists to protect is "wires carry references, never
 * bytes" (ADR-0011). A tool that returns a rendered floor plan hands us a
 * base64 PNG inline in the JSON-RPC response; if that string reached a port it
 * would be copied into every downstream node, every cache entry and every run
 * event. So image, audio and embedded-resource blocks are decoded once, put in
 * the content-addressed store, and travel onward as `AssetRef`s.
 *
 * The three outputs are fixed and total: `text` is every text block joined,
 * `result` is `structuredContent` or null, `assets` is everything binary. No
 * block type is silently dropped — `resource_link` is the one thing we cannot
 * capture (it is a pointer into the server's resource space, and MCP resources
 * are deferred per ADR-0009 §6), so it is surfaced in `text` rather than lost.
 */
import type { AssetRef, AssetStore, Value } from '@archspace/node-sdk';

export interface McpToolCallOutcome {
  isError: boolean;
  /** Joined text content. */
  text: string;
  /** structuredContent when the tool provides it, else null. */
  structured: Value | null;
  /** image/audio/resource contents captured into the CAS. */
  assets: AssetRef[];
}

/** The shape of a `tools/call` response we actually read. */
export interface RawToolResult {
  content?: unknown;
  structuredContent?: unknown;
  isError?: unknown;
  [key: string]: unknown;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * A port-type format tag derived from the media type, so `asset<png>` and
 * `asset<ifc>` connect to typed inputs instead of everything being bare
 * `asset`. Structured suffixes win (`application/vnd.x+json` is json), because
 * that is the part a consumer can actually parse.
 */
export function formatTagFor(mediaType: string): string | undefined {
  const subtype = mediaType.split(';')[0].trim().split('/')[1];
  if (!subtype) return undefined;
  const plus = subtype.lastIndexOf('+');
  const candidate = (plus === -1 ? subtype : subtype.slice(plus + 1)).toLowerCase().replace(/[^a-z0-9]+/g, '_');
  return /^[a-z][a-z0-9_]*$/.test(candidate) ? candidate : undefined;
}

/** Last path segment of a resource URI, for a human-readable asset name. */
function nameFromUri(uri: string): string | undefined {
  try {
    const parsed = new URL(uri);
    const last = parsed.pathname.split('/').filter(Boolean).pop();
    return last ?? undefined;
  } catch {
    const last = uri.split(/[/\\]/).filter(Boolean).pop();
    return last ?? undefined;
  }
}

/** JSON-shaped deep copy. Anything that is not a JSON value becomes null
 *  rather than crossing a wire that promises `Value`. */
export function toValue(input: unknown): Value {
  if (input === null) return null;
  switch (typeof input) {
    case 'boolean':
    case 'string':
      return input;
    case 'number':
      return Number.isFinite(input) ? input : null;
    case 'object':
      break;
    default:
      return null;
  }
  if (Array.isArray(input)) return input.map(toValue);
  const out: Record<string, Value> = {};
  for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
    if (value === undefined) continue;
    out[key] = toValue(value);
  }
  return out;
}

async function putBase64(
  assets: AssetStore,
  base64: string,
  meta: { mediaType: string; name?: string },
): Promise<AssetRef> {
  const bytes = new Uint8Array(Buffer.from(base64, 'base64'));
  const format = formatTagFor(meta.mediaType);
  return assets.put(bytes, {
    mediaType: meta.mediaType,
    ...(format !== undefined ? { format } : {}),
    ...(meta.name !== undefined ? { name: meta.name } : {}),
  });
}

/**
 * Capture one tool result. `assets.put` is awaited in order so the resulting
 * `assets` list matches the order the server sent — a node that returns two
 * images must not have them swapped by scheduling.
 */
export async function captureToolResult(result: RawToolResult, assets: AssetStore): Promise<McpToolCallOutcome> {
  const texts: string[] = [];
  const refs: AssetRef[] = [];
  const blocks = Array.isArray(result.content) ? result.content : [];

  for (const block of blocks) {
    if (!isRecord(block)) continue;
    switch (block.type) {
      case 'text': {
        if (typeof block.text === 'string') texts.push(block.text);
        break;
      }
      case 'image':
      case 'audio': {
        if (typeof block.data === 'string') {
          const mediaType = typeof block.mimeType === 'string' ? block.mimeType : block.type === 'image' ? 'image/png' : 'audio/wav';
          refs.push(await putBase64(assets, block.data, { mediaType }));
        }
        break;
      }
      case 'resource': {
        const resource = isRecord(block.resource) ? block.resource : undefined;
        if (!resource) break;
        const mediaType = typeof resource.mimeType === 'string' ? resource.mimeType : 'application/octet-stream';
        const name = typeof resource.uri === 'string' ? nameFromUri(resource.uri) : undefined;
        if (typeof resource.blob === 'string') {
          refs.push(await putBase64(assets, resource.blob, { mediaType, ...(name !== undefined ? { name } : {}) }));
        } else if (typeof resource.text === 'string') {
          const bytes = new TextEncoder().encode(resource.text);
          const format = formatTagFor(mediaType);
          refs.push(
            await assets.put(bytes, {
              mediaType: typeof resource.mimeType === 'string' ? mediaType : 'text/plain',
              ...(format !== undefined ? { format } : {}),
              ...(name !== undefined ? { name } : {}),
            }),
          );
        }
        break;
      }
      case 'resource_link': {
        // Not fetchable without the resources capability (deferred, ADR-0009
        // §6); naming it in the text keeps the information visible.
        if (typeof block.uri === 'string') texts.push(`[resource] ${typeof block.name === 'string' ? `${block.name}: ` : ''}${block.uri}`);
        break;
      }
      default:
        break;
    }
  }

  return {
    isError: result.isError === true,
    text: texts.join('\n'),
    structured: result.structuredContent === undefined || result.structuredContent === null ? null : toValue(result.structuredContent),
    assets: refs,
  };
}
