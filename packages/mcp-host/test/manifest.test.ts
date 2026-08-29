/**
 * tools/list to NodeManifest, and the hash that pins it (ARCHITECTURE §9.3 /
 * ADR-0009 §3 and §5).
 *
 * Everything in `manifest.ts` is pure, which is the point: this is the layer
 * where a foreign server's JSON meets our own contracts, and it can be pinned
 * exhaustively without a socket or a subprocess. Three invariants are worth the
 * table:
 *
 *   1. **`hashToolSchema` IS the drift contract.** A generated node stores it in
 *      a committed workflow, so the hash has to mean "this tool's contract
 *      changed" and nothing else. Too sensitive — reacting to key order, which
 *      a server restart can change for free — and every workflow in the repo
 *      lights up "tool changed, review" until people learn to ignore the flag.
 *      Too blunt and a genuinely changed schema is absorbed silently, which
 *      ADR-0009 §5 exists to forbid.
 *   2. **Node type ids are a stricter alphabet than MCP tool names.** Servers
 *      ship `get-elements`, `Revit.Query`, and worse; the id has to come out
 *      legal for *every* input or the whole server's palette fails to register.
 *      So the table below is deliberately hostile.
 *   3. **The manifest is what the inspector renders.** Enum, minimum,
 *      description and any server-specific keyword must survive the trip, or a
 *      rich tool becomes a row of bare text boxes.
 *
 * `nodes.test.ts` asserts the same mapping end-to-end over a live session; this
 * file is the exhaustive half, where the cases that no reasonable fake server
 * would produce can be written down cheaply.
 */
import { describe, expect, it } from 'vitest';
import { createNodeRegistry, type NodeModule, type Outputs } from '@archspace/node-sdk';
import {
  asJsonSchemaObject,
  canonicalJson,
  hashToolSchema,
  mcpNodeType,
  schemaTypeToPortType,
  toolNameToTypeSegment,
  toolToManifest,
  type McpToolInfo,
} from '../src/index.js';

function toolInfo(overrides: Partial<McpToolInfo> & { name: string }): McpToolInfo {
  const inputSchema = overrides.inputSchema ?? { type: 'object' as const };
  return { schemaHash: hashToolSchema(inputSchema), ...overrides, inputSchema };
}

/** The manifest, wrapped in the least node possible, so a real registry can
 *  pass its verdict on the type id and the port types. */
function moduleFor(server: string, tool: McpToolInfo): NodeModule {
  return { manifest: toolToManifest(server, tool), execute: async (): Promise<Outputs> => ({}) };
}

describe('hashToolSchema, the drift detector (ADR-0009 §5)', () => {
  const schema = {
    type: 'object',
    properties: {
      category: { type: 'string', enum: ['walls', 'doors'], description: 'What to read.' },
      limit: { type: 'number', minimum: 1 },
    },
    required: ['category'],
  };

  it('is stable when a server reorders its keys', () => {
    // JSON object key order is the one thing `JSON.stringify` leaves to chance,
    // and a server that reserialized its schema after a restart has not changed
    // its contract. If this regresses, every MCP node in every saved workflow
    // flags itself for review after an unrelated server restart.
    const reordered = {
      required: ['category'],
      properties: {
        limit: { minimum: 1, type: 'number' },
        category: { description: 'What to read.', enum: ['walls', 'doors'], type: 'string' },
      },
      type: 'object',
    };

    expect(hashToolSchema(reordered)).toBe(hashToolSchema(schema));
  });

  it('is a content address in the document-visible format', () => {
    // This string is written into a committed workflow, so its shape is a
    // format contract, not an implementation detail.
    expect(hashToolSchema(schema)).toMatch(/^b3:[0-9a-f]{64}$/);
  });

  it.each<[string, unknown]>([
    ['a property changed type', { ...schema, properties: { ...schema.properties, limit: { type: 'string', minimum: 1 } } }],
    ['a property was added', { ...schema, properties: { ...schema.properties, offset: { type: 'number' } } }],
    ['a property was removed', { ...schema, properties: { category: schema.properties.category } }],
    ['a property became required', { ...schema, required: ['category', 'limit'] }],
    ['a constraint moved', { ...schema, properties: { ...schema.properties, limit: { type: 'number', minimum: 2 } } }],
    ['an enum gained a member', { ...schema, properties: { ...schema.properties, category: { ...schema.properties.category, enum: ['walls', 'doors', 'floors'] } } }],
    // Prose is not cosmetic here: `toParamProperty` carries `description`
    // through to the generated node, so the inspector form genuinely differs.
    ['a description was rewritten', { ...schema, properties: { ...schema.properties, category: { ...schema.properties.category, description: 'Which category.' } } }],
  ])('moves when %s', (_label, changed) => {
    expect(hashToolSchema(changed)).not.toBe(hashToolSchema(schema));
  });

  it('hashes the normalized schema, so drift is judged on what we generated from', () => {
    // `listServerTools` hashes the output of `asJsonSchemaObject`, never the
    // raw JSON, so a tool that ships no schema at all hashes the same as one
    // that ships `{}` while generating an identical node.
    expect(hashToolSchema(asJsonSchemaObject(undefined))).toBe(hashToolSchema(asJsonSchemaObject({})));
    expect(hashToolSchema(asJsonSchemaObject({ type: 'object' }))).toBe(hashToolSchema(asJsonSchemaObject(null)));
  });
});

describe('canonicalJson', () => {
  it('sorts object keys at every depth and leaves array order alone', () => {
    expect(canonicalJson({ b: 1, a: { d: 2, c: [3, { f: 4, e: 5 }] } })).toBe('{"a":{"c":[3,{"e":5,"f":4}],"d":2},"b":1}');
    // Arrays are ordered in JSON; reordering one IS a change.
    expect(canonicalJson([1, 2])).not.toBe(canonicalJson([2, 1]));
  });

  it('drops undefined-valued keys rather than emitting a hole', () => {
    expect(canonicalJson({ a: 1, b: undefined })).toBe('{"a":1}');
    expect(canonicalJson(undefined)).toBe('null');
  });

  it.each<[unknown, string]>([
    [null, 'null'],
    [true, 'true'],
    [1.5, '1.5'],
    ['x', '"x"'],
    [[], '[]'],
    [{}, '{}'],
  ])('encodes %o as %s', (value, expected) => {
    expect(canonicalJson(value)).toBe(expected);
  });
});

describe('toolNameToTypeSegment, hostile names into legal node types', () => {
  const NAMES: [string, string][] = [
    ['echo', 'echo'],
    ['get-elements', 'get_elements'],
    ['Revit.Query', 'revit_query'],
    ['get elements  now', 'get_elements_now'],
    ['__internal__', 'internal'],
    // Folding does not split camelCase, that is `humanize`'s job for the label.
    // The id just has to be legal and stable.
    ['getElementById', 'getelementbyid'],
    ['123go', 't_123go'],
    ['9', 't_9'],
    // A name shaped like a traversal is inert by construction: no path, no
    // separator and no dot survive the fold.
    ['../../etc/passwd', 'etc_passwd'],
    ['tool name', 'tool_name'],
    ['!!!', 'tool'],
    ['_', 'tool'],
    ['', 'tool'],
  ];

  it.each(NAMES)('folds %o into %o', (name, expected) => {
    expect(toolNameToTypeSegment(name)).toBe(expected);
  });

  it('folds non-ASCII names down to the id alphabet', () => {
    // Servers are not obliged to name tools in ASCII; node type ids are.
    expect(toolNameToTypeSegment('élément')).toBe('l_ment');
    expect(toolNameToTypeSegment('建築')).toBe('tool');
  });

  it('produces a type a real NodeRegistry accepts, for every one of them', () => {
    // The registry is the actual enforcer of the id alphabet; asserting against
    // a copy of its regex here would only test the copy. One registry per name,
    // because several of these names deliberately fold onto the same id (see
    // the next test) and this one is about legality, not uniqueness.
    for (const [name] of NAMES) {
      const registry = createNodeRegistry();
      expect(mcpNodeType('revit', name)).toBe(`mcp.revit.${toolNameToTypeSegment(name)}`);
      expect(() => registry.register(moduleFor('revit', toolInfo({ name })))).not.toThrow();
      // Registration proves the ports are legal port types too, not just the id.
      expect(registry.has(mcpNodeType('revit', name))).toBe(true);
    }
  });

  it('is many-to-one, so two tools can fold onto the same node type', () => {
    // Not a contract violation, since the wire name is kept separately and the
    // host always calls the server by the name it published, but it IS a fact
    // worth writing down: a server exposing both spellings hands the registry
    // two modules with one type, and the second registration throws. Nothing in
    // this package deduplicates today.
    expect(toolNameToTypeSegment('get-elements')).toBe(toolNameToTypeSegment('get_elements'));
    expect(toolNameToTypeSegment('Revit.Query')).toBe(toolNameToTypeSegment('revit query'));

    const registry = createNodeRegistry();
    registry.register(moduleFor('revit', toolInfo({ name: 'get-elements' })));
    expect(() => registry.register(moduleFor('revit', toolInfo({ name: 'get_elements' })))).toThrow(/duplicate node type/);
  });
});

describe('schemaTypeToPortType, the §9.3 mapping table', () => {
  it.each<[string, unknown, string]>([
    ['string', { type: 'string' }, 'text'],
    ['number', { type: 'number' }, 'number'],
    ['integer', { type: 'integer' }, 'number'],
    ['boolean', { type: 'boolean' }, 'boolean'],
    ['object', { type: 'object' }, 'json'],
    ['array', { type: 'array' }, 'json'],
    ['null', { type: 'null' }, 'json'],
    ['the nullable idiom', { type: ['string', 'null'] }, 'text'],
    ['a nullable number', { type: ['null', 'integer'] }, 'number'],
    ['a bare string enum', { enum: ['walls', 'doors'] }, 'text'],
    ['a mixed enum', { enum: [1, 'walls'] }, 'json'],
    ['an empty enum', { enum: [] }, 'json'],
    ['no type at all', {}, 'json'],
    ['a non-schema', 'nonsense', 'json'],
    ['nothing', null, 'json'],
  ])('maps %s to %s', (_label, prop, expected) => {
    // Anything unmappable lands in `json`, which is lossless, rather than in a
    // guess that would fail assignability at connection time.
    expect(schemaTypeToPortType(prop)).toBe(expected);
  });
});

describe('asJsonSchemaObject, pinning JSON of unknown provenance', () => {
  it.each<[string, unknown]>([
    ['undefined', undefined],
    ['null', null],
    ['an array', [1, 2]],
    ['a string', 'object'],
    ['a number', 7],
  ])('gives %s an empty object schema, so the tool still becomes a node', (_label, raw) => {
    // A tool with no usable schema generates a node with no params, never no
    // node: refusing it would hide a callable tool from the palette.
    expect(asJsonSchemaObject(raw)).toEqual({ type: 'object' });
  });

  it('keeps every keyword a server sent, and forces the top-level type', () => {
    expect(
      asJsonSchemaObject({
        type: 'array', // a server that got this wrong still gets an object schema
        $schema: 'https://json-schema.org/draft/2020-12/schema',
        additionalProperties: false,
        properties: { path: { type: 'string' }, broken: 'not an object' },
        required: ['path', 7, null],
      }),
    ).toEqual({
      type: 'object',
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      additionalProperties: false,
      properties: { path: { type: 'string' }, broken: {} },
      required: ['path'],
    });
  });

  it('drops a required list that is not a list', () => {
    expect(asJsonSchemaObject({ type: 'object', required: 'path' })).toEqual({ type: 'object' });
  });
});

describe('toolToManifest', () => {
  const tool = toolInfo({
    name: 'get-elements',
    description: 'Reads elements from the model.',
    // Through `asJsonSchemaObject`, exactly as `listServerTools` builds it from
    // the wire — which is also the only way to express the `["integer","null"]`
    // idiom, since a JsonSchemaProperty's own `type` is a single string.
    inputSchema: asJsonSchemaObject({
      type: 'object',
      properties: {
        category: { type: 'string', enum: ['walls', 'doors'], description: 'Which category.' },
        limit: { type: ['integer', 'null'], minimum: 1, maximum: 500 },
        includeHidden: { type: 'boolean' },
        filter: { type: 'object' },
        notes: { type: 'string' },
      },
      required: ['category'],
    }),
  });

  it('produces the ADR-0009 §3 identity: type, lane, category, keywords, ports, caching', () => {
    const manifest = toolToManifest('revit', tool);

    expect(manifest.type).toBe('mcp.revit.get_elements');
    expect(manifest.version).toBe(1);
    expect(manifest.lane).toBe('mcp:revit');
    expect(manifest.category).toBe('MCP · revit');
    // Keywords carry the name the SERVER published, which is what a user will
    // type into the palette search. The folded id is ours, not theirs.
    expect(manifest.keywords).toEqual(['mcp', 'revit', 'get-elements']);
    expect(manifest.inputs).toEqual([]);
    expect(manifest.outputs.map((p) => [p.id, p.type])).toEqual([
      ['result', 'json'],
      ['text', 'text'],
      ['assets', 'list<asset>'],
    ]);
    // Annotations are advisory per spec; the host applies the user's own
    // override, and this pure mapping never gambles on the hint (ADR-0009 §4).
    expect(manifest.caching).toBe('never');
  });

  it.each<[string, Partial<McpToolInfo>, string]>([
    ['the tool title when it has one', { title: 'Get Elements' }, 'Get Elements'],
    ['the annotation title next', { annotations: { title: 'Element Reader' } }, 'Element Reader'],
    ['a humanized name last', {}, 'Get Elements'],
  ])('labels a node with %s', (_label, extra, expected) => {
    expect(toolToManifest('revit', toolInfo({ name: 'get-elements', ...extra })).label).toBe(expected);
  });

  it('falls back to naming the tool and server when a tool ships no description', () => {
    expect(toolToManifest('revit', toolInfo({ name: 'get-elements' })).description).toBe('The "get-elements" tool on MCP server "revit".');
  });

  it('turns every tool property into a promotable param, keeping the server keywords', () => {
    const props = toolToManifest('revit', tool).params.properties ?? {};

    expect(Object.keys(props)).toEqual(['category', 'limit', 'includeHidden', 'filter', 'notes']);
    // The nullable idiom is collapsed to the single type the manifest allows,
    // and the constraints survive so the inspector form stays as rich as the
    // server made it.
    expect(props.limit).toEqual({ type: 'integer', minimum: 1, maximum: 500, title: 'Limit', 'x-archspace': { promotable: true } });
    // An enum picks itself; free text gets room to breathe.
    expect(props.category).toMatchObject({ type: 'string', description: 'Which category.', title: 'Category', 'x-archspace': { promotable: true, widget: 'select' } });
    expect(props.notes['x-archspace']).toEqual({ promotable: true, widget: 'textarea', rows: 3 });
    // A structured argument gets NO widget hint. It used to get
    // `textarea`/rows 4, describing an editor that does not exist: the
    // inspector renders a structured param read-only on purpose
    // (`ParamField`'s header says why), so the hint was read by nobody and
    // misinformed the plugin author reading the manifest to learn what hints
    // mean. Promotion is the real answer for those, and the form says so.
    expect(props.filter['x-archspace']).toEqual({ promotable: true });
    expect(props.includeHidden).toEqual({ type: 'boolean', title: 'Include Hidden', 'x-archspace': { promotable: true } });
    // Every one of them, without exception: a tool argument is exactly the kind
    // of value a user wants to drive from an upstream node.
    expect(Object.values(props).every((p) => p['x-archspace']?.promotable === true)).toBe(true);
  });

  it('carries `required` through, and omits it when the tool requires nothing', () => {
    expect(toolToManifest('revit', tool).params.required).toEqual(['category']);
    expect(toolToManifest('revit', toolInfo({ name: 'ping' })).params).toEqual({ type: 'object', properties: {} });
  });

  it('refuses to let a server write our own x-archspace key', () => {
    const hostile = toolInfo({
      name: 'sneaky',
      inputSchema: { type: 'object', properties: { path: { type: 'string', 'x-archspace': { promotable: false, widget: 'select' } } } },
    });

    const prop = (toolToManifest('revit', hostile).params.properties ?? {}).path;

    // `x-archspace` is ours to write, not theirs: a server must not be able to
    // reach into the inspector or un-promote its own argument.
    expect(prop['x-archspace']).toEqual({ promotable: true, widget: 'textarea', rows: 3 });
  });

  it('keeps a title the server supplied for a property instead of humanizing it', () => {
    const named = toolInfo({ name: 'x', inputSchema: { type: 'object', properties: { rvt_path: { type: 'string', title: 'Revit file' } } } });

    expect((toolToManifest('revit', named).params.properties ?? {}).rvt_path.title).toBe('Revit file');
  });
});
