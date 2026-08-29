/**
 * tools/list → NodeManifest, mechanically (ARCHITECTURE §9.3 / ADR-0009 §3).
 *
 * This mapping is only possible because node params are already JSON Schema
 * (ADR-0005) and MCP tool inputs are too: the two contracts meet without an
 * adapter language in between. Everything here is pure so the table can be
 * tested and documented without a server, a socket, or a subprocess.
 *
 * Two decisions are worth stating, because both look like they could have gone
 * the easy way:
 *
 * 1. **`caching: 'never'`, always.** The spec is explicit that `readOnlyHint`
 *    and friends are untrusted hints from an untrusted server. Memoizing on a
 *    hint means a wrong answer, silently, later; the per-server
 *    `trustReadOnlyHint` override exists for users who own their server, and it
 *    is applied by the host, never inferred here.
 *
 * 2. **The schema hash does not live on the manifest.** `NodeManifest` is a
 *    frozen contract with no room for an `x-archspace` sidecar, and smuggling a
 *    hash through `keywords` would make a drift marker look like a search term.
 *    So the hash travels beside the manifest: `McpToolInfo.schemaHash` for live
 *    tools, `McpHost.toolSchemaHashes()` for the whole connected surface, and a
 *    document compares the hash it pinned at authoring time against that map.
 *    Drift is then a fact the caller reports, not a re-mapping we do behind the
 *    user's back.
 */
import { hashBytes, type JsonSchemaObject, type JsonSchemaProperty, type NodeManifest, type PortDecl } from '@archspace/node-sdk';

export interface McpToolInfo {
  name: string;
  title?: string;
  description?: string;
  inputSchema: JsonSchemaObject;
  /** b3 hash of the canonicalised inputSchema — the drift detector (§9.3). */
  schemaHash: string;
  annotations?: {
    readOnlyHint?: boolean;
    destructiveHint?: boolean;
    idempotentHint?: boolean;
    openWorldHint?: boolean;
    title?: string;
  };
}

/**
 * Key order is the only thing JSON.stringify leaves to chance, and a schema
 * whose keys were reordered by a server restart is not a changed schema. Sorting
 * every object key makes the hash mean "this contract changed", not "these bytes
 * changed".
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
}

export function hashToolSchema(schema: unknown): string {
  return hashBytes(new TextEncoder().encode(canonicalJson(schema)));
}

/**
 * JSON Schema type → Archspace port type (§9.3). The table is short on purpose:
 * anything we cannot map exactly lands in `json`, which is lossless, rather than
 * in a guess that would fail assignability checks at connection time.
 */
export function schemaTypeToPortType(prop: unknown): string {
  const type = jsonSchemaType(prop);
  switch (type) {
    case 'string':
      return 'text';
    case 'number':
    case 'integer':
      return 'number';
    case 'boolean':
      return 'boolean';
    default:
      return 'json';
  }
}

/** The declared type, tolerating the `["string","null"]` nullable idiom. */
function jsonSchemaType(prop: unknown): string | undefined {
  if (typeof prop !== 'object' || prop === null) return undefined;
  const raw = (prop as { type?: unknown }).type;
  if (typeof raw === 'string') return raw;
  if (Array.isArray(raw)) {
    const named = raw.find((t) => typeof t === 'string' && t !== 'null');
    if (typeof named === 'string') return named;
  }
  // A bare `enum` of strings is a string in everything but the annotation.
  const enumValues = (prop as { enum?: unknown }).enum;
  if (Array.isArray(enumValues) && enumValues.length > 0 && enumValues.every((v) => typeof v === 'string')) {
    return 'string';
  }
  return undefined;
}

/**
 * A tool's `inputSchema` as received is JSON of unknown provenance; this pins it
 * to the manifest's `JsonSchemaObject` without pretending to validate a server
 * we do not control. A tool that ships no object schema gets an empty one, which
 * generates a node with no params rather than no node.
 */
export function asJsonSchemaObject(raw: unknown): JsonSchemaObject {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return { type: 'object' };
  const source = raw as Record<string, unknown>;
  const schema: JsonSchemaObject = { type: 'object' };
  for (const [key, value] of Object.entries(source)) {
    if (key === 'type') continue;
    if (key === 'properties') {
      if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
        const properties: Record<string, JsonSchemaProperty> = {};
        for (const [propName, propValue] of Object.entries(value as Record<string, unknown>)) {
          properties[propName] =
            typeof propValue === 'object' && propValue !== null && !Array.isArray(propValue)
              ? ({ ...(propValue as Record<string, unknown>) } as JsonSchemaProperty)
              : {};
        }
        schema.properties = properties;
      }
      continue;
    }
    if (key === 'required') {
      if (Array.isArray(value)) schema.required = value.filter((r): r is string => typeof r === 'string');
      continue;
    }
    schema[key] = value;
  }
  return schema;
}

/** "get_element_by_id" / "getElementById" → "Get Element By Id". */
function humanize(name: string): string {
  return name
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_\-.]+/g, ' ')
    .trim()
    .split(/\s+/)
    .map((word) => (word.length === 0 ? word : word[0].toUpperCase() + word.slice(1)))
    .join(' ');
}

/**
 * Node type ids are a stricter alphabet than MCP tool names ([a-z][a-z0-9_]*
 * per segment, enforced by the SDK's registry), and servers ship tools called
 * `get-elements` or `Revit.Query`. Rather than refuse those tools we fold the
 * name into the id alphabet and keep the wire name separately — the host always
 * calls the server with the name the server published.
 */
export function toolNameToTypeSegment(toolName: string): string {
  const folded = toolName.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  if (folded.length === 0) return 'tool';
  return /^[a-z]/.test(folded) ? folded : `t_${folded}`;
}

export function mcpNodeType(server: string, toolName: string): string {
  return `mcp.${server}.${toolNameToTypeSegment(toolName)}`;
}

/**
 * One tool property → one node param. The original property is carried through
 * (enum, minimum, description and any server-specific keywords survive) so the
 * inspector form is as rich as the server made it; only `type` is normalized,
 * because the manifest's `type` is a single string and JSON Schema's may be a
 * list.
 */
function toParamProperty(name: string, raw: unknown): JsonSchemaProperty {
  const source = typeof raw === 'object' && raw !== null && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const prop: JsonSchemaProperty = {};
  for (const [key, value] of Object.entries(source)) {
    // `type` is normalized below; `x-archspace` is ours to write, not theirs.
    if (key === 'type' || key === 'x-archspace') continue;
    prop[key] = value;
  }
  const type = jsonSchemaType(source);
  if (type !== undefined) prop.type = type;
  if (typeof prop.title !== 'string') prop.title = humanize(name);
  // Every MCP argument is promotable: a tool argument is exactly the kind of
  // value a user wants to drive from an upstream node rather than retype.
  const widget = paramWidget(type, source.enum);
  prop['x-archspace'] = widget === null ? { promotable: true } : { promotable: true, widget: widget.widget, rows: widget.rows };
  return prop;
}

/**
 * Free-text arguments get room to breathe; enums pick themselves.
 *
 * No hint for `object` or `array`, though they are the arguments that would
 * most obviously want a big box. The inspector has no control for a structured
 * param and deliberately will not grow one — `ParamField`'s header explains
 * why at length: an editable control seeded with a lossy rendering is how a
 * user destroys a value by looking at it. So it renders those read-only and
 * says to wire them from another node instead, which promotion (ADR-0017) now
 * makes a real instruction.
 *
 * Emitting `widget: 'textarea'` for them therefore described an editor that
 * does not exist, in a manifest a plugin author reads to learn what the hints
 * mean. A hint nothing honours is worse than none.
 */
function paramWidget(type: string | undefined, enumValues: unknown): { widget: 'textarea' | 'select'; rows?: number } | null {
  if (Array.isArray(enumValues) && enumValues.length > 0) return { widget: 'select' };
  if (type === 'string') return { widget: 'textarea', rows: 3 };
  return null;
}

/** The three outputs every MCP node has, in the order §9.3 names them. */
const MCP_OUTPUTS: readonly PortDecl[] = [
  { id: 'result', type: 'json', label: 'Result', description: 'structuredContent when the tool provides it, else null.' },
  { id: 'text', type: 'text', label: 'Text', description: 'Every text content block, joined.' },
  { id: 'assets', type: 'list<asset>', label: 'Assets', description: 'Image, audio and embedded resource contents, captured into the store.' },
];

/** Pure: the tool → node manifest mapping, exported for tests and for docs. */
export function toolToManifest(server: string, tool: McpToolInfo): NodeManifest {
  const properties: Record<string, JsonSchemaProperty> = {};
  const requiredNames = Array.isArray(tool.inputSchema.required) ? tool.inputSchema.required.filter((r): r is string => typeof r === 'string') : [];
  for (const [name, raw] of Object.entries(tool.inputSchema.properties ?? {})) {
    properties[name] = toParamProperty(name, raw);
  }

  const params: JsonSchemaObject = { type: 'object', properties };
  if (requiredNames.length > 0) params.required = [...requiredNames];

  return {
    type: mcpNodeType(server, tool.name),
    version: 1,
    label: tool.title ?? tool.annotations?.title ?? humanize(tool.name),
    description: tool.description ?? `The "${tool.name}" tool on MCP server "${server}".`,
    category: `MCP · ${server}`,
    keywords: ['mcp', server, tool.name],
    params,
    inputs: [],
    outputs: [...MCP_OUTPUTS],
    // Annotations are advisory per spec; correctness is not a gamble (§9.3).
    caching: 'never',
    lane: `mcp:${server}`,
  };
}
