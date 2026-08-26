/**
 * tools/list → nodes, and what happens when one of those nodes runs
 * (ARCHITECTURE §9.3 / ADR-0009 §3–§4, ADR-0013 §5).
 *
 * These are the assertions that keep the generated palette honest: the type id
 * and lane a workflow document will write down, the three fixed outputs, the
 * `caching: 'never'` rule that ADR-0009 §4 refuses to trade away, and the
 * promise that bulk content leaves the wire as an `AssetRef` (ADR-0011).
 */
import { describe, expect, it } from 'vitest';
import { createMemoryAssetStore, isAssetRef, isRetryableError, type AssetRef, type NodeModule } from '@archspace/node-sdk';
import { runNode } from '@archspace/node-sdk/testkit';
import { createMcpHost } from '../src/index.js';
import { McpCallError, McpToolFailure } from '../src/errors.js';
import { schemaTypeToPortType } from '../src/manifest.js';
import { echoTool, fakeServer, stdioConfig, textResult, transportFor, type FakeServer } from './helpers.js';

async function hostWith(server: FakeServer, config = stdioConfig()) {
  const assets = createMemoryAssetStore();
  const host = createMcpHost({ assets, createTransport: transportFor({ formats: server }) });
  await host.configure({ servers: { formats: config } });
  await host.connect('formats');
  return { host, assets };
}

function moduleOf(modules: NodeModule[], type: string): NodeModule {
  const mod = modules.find((m) => m.manifest.type === type);
  if (mod === undefined) throw new Error(`no generated node "${type}" in [${modules.map((m) => m.manifest.type).join(', ')}]`);
  return mod;
}

describe('tools become nodes', () => {
  it('maps every tool to a node with the ADR-0009 type id, lane, ports and caching', async () => {
    const server = fakeServer({
      tools: [
        {
          // Not a legal node-type segment: the id alphabet is stricter than
          // MCP's, so the name is folded and the wire name kept separately.
          name: 'get-elements',
          title: 'Get Elements',
          description: 'Reads elements from the model.',
          inputSchema: {
            type: 'object',
            properties: {
              category: { type: 'string', enum: ['walls', 'doors'] },
              limit: { type: 'number' },
              includeHidden: { type: 'boolean' },
              filter: { type: 'object' },
            },
            required: ['category'],
          },
          handle: () => textResult('ok'),
        },
        echoTool(),
      ],
    });
    const { host } = await hostWith(server);

    const modules = host.nodeModules();
    expect(modules.map((m) => m.manifest.type).sort()).toEqual(['mcp.formats.echo', 'mcp.formats.get_elements']);

    const manifest = moduleOf(modules, 'mcp.formats.get_elements').manifest;
    expect(manifest.lane).toBe('mcp:formats');
    expect(manifest.label).toBe('Get Elements');
    expect(manifest.category).toBe('MCP · formats');
    // ADR-0009 §4: never memoized, whatever the server's annotations claim.
    expect(manifest.caching).toBe('never');
    expect(manifest.inputs).toEqual([]);
    expect(manifest.outputs.map((p) => [p.id, p.type])).toEqual([
      ['result', 'json'],
      ['text', 'text'],
      ['assets', 'list<asset>'],
    ]);

    // Every tool property is a promotable param, and the §9.3 port-type table
    // is what a promotion would use: string→text, number→number,
    // boolean→boolean, object→json.
    const props = manifest.params.properties ?? {};
    expect(Object.keys(props).sort()).toEqual(['category', 'filter', 'includeHidden', 'limit']);
    expect(manifest.params.required).toEqual(['category']);
    expect(Object.values(props).every((p) => p['x-archspace']?.promotable === true)).toBe(true);
    expect(Object.entries(props).map(([name, p]) => [name, schemaTypeToPortType(p)])).toEqual([
      ['category', 'text'],
      ['limit', 'number'],
      ['includeHidden', 'boolean'],
      ['filter', 'json'],
    ]);
  });

  it('honours the per-server trustReadOnlyHint override, and only that', async () => {
    const readOnly = {
      ...echoTool('peek'),
      annotations: { readOnlyHint: true },
    };
    const withoutOverride = await hostWith(fakeServer({ tools: [readOnly] }));
    expect(moduleOf(withoutOverride.host.nodeModules(), 'mcp.formats.peek').manifest.caching).toBe('never');

    const withOverride = await hostWith(fakeServer({ tools: [readOnly] }), stdioConfig({ trustReadOnlyHint: true }));
    expect(moduleOf(withOverride.host.nodeModules(), 'mcp.formats.peek').manifest.caching).toBe('pure');
  });
});

describe('executing a generated node', () => {
  it('calls the tool through the pooled client and returns structured + text output', async () => {
    const server = fakeServer({ tools: [echoTool()] });
    const { host, assets } = await hostWith(server);

    const result = await runNode(moduleOf(host.nodeModules(), 'mcp.formats.echo'), {
      params: { message: 'hello revit' },
      assets,
    });

    expect(server.calls).toEqual([{ tool: 'echo', args: { message: 'hello revit' } }]);
    expect(result.outputs.result).toEqual({ echoed: 'hello revit' });
    expect(result.outputs.text).toBe('hello revit');
    expect(result.outputs.assets).toEqual([]);
  });

  it('captures binary content into the asset store and puts an AssetRef on the wire', async () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]);
    const server = fakeServer({
      tools: [
        {
          name: 'render',
          inputSchema: { type: 'object', properties: {} },
          handle: () => ({
            content: [
              { type: 'text', text: 'rendered' },
              { type: 'image', data: Buffer.from(png).toString('base64'), mimeType: 'image/png' },
            ],
          }),
        },
      ],
    });
    const { host, assets } = await hostWith(server);

    const result = await runNode(moduleOf(host.nodeModules(), 'mcp.formats.render'), { assets });

    const refs = result.outputs.assets as AssetRef[];
    expect(refs).toHaveLength(1);
    expect(isAssetRef(refs[0])).toBe(true);
    expect(refs[0]).toMatchObject({ mediaType: 'image/png', format: 'png', size: png.byteLength });
    // The bytes are in the store, not on the wire.
    expect(await assets.bytes(refs[0])).toEqual(png);
    expect(result.outputs.text).toBe('rendered');
    expect(result.outputs.result).toBeNull();
  });

  it('fails the node with the server’s own words when a tool reports isError', async () => {
    const server = fakeServer({
      tools: [
        {
          name: 'convert',
          inputSchema: { type: 'object', properties: {} },
          handle: () => textResult('the IFC file is truncated at byte 4096', { isError: true }),
        },
      ],
    });
    const { host, assets } = await hostWith(server);

    const failure = await runNode(moduleOf(host.nodeModules(), 'mcp.formats.convert'), { assets }).catch((err: unknown) => err);

    expect(failure).toBeInstanceOf(McpToolFailure);
    const err = failure as McpToolFailure;
    expect(err.message).toContain('the IFC file is truncated at byte 4096');
    expect(err.server).toBe('formats');
    expect(err.tool).toBe('convert');
    // A tool that ran and said no is not a transport fault: never retried.
    expect(isRetryableError(err)).toBe(false);
  });

  it('marks a dropped connection retryable so the engine tries again on a fresh session', async () => {
    const server = fakeServer({
      tools: [
        {
          name: 'flaky',
          inputSchema: { type: 'object', properties: {} },
          handle: async (_args, extra) => {
            await extra.drop();
            return new Promise<never>(() => undefined); // the answer never arrives
          },
        },
      ],
    });
    const { host, assets } = await hostWith(server);

    const failure = await runNode(moduleOf(host.nodeModules(), 'mcp.formats.flaky'), { assets }).catch((err: unknown) => err);

    expect(failure).toBeInstanceOf(McpCallError);
    expect(isRetryableError(failure as Error)).toBe(true);
    expect((failure as McpCallError).tool).toBe('flaky');
  });

  it('honours ctx.signal and lets the cancellation through untouched', async () => {
    const server = fakeServer({
      tools: [
        {
          name: 'slow',
          inputSchema: { type: 'object', properties: {} },
          handle: (_args, extra) =>
            new Promise((resolve) => {
              extra.signal.addEventListener('abort', () => resolve(textResult('cancelled')));
            }),
        },
      ],
    });
    const { host, assets } = await hostWith(server);
    const controller = new AbortController();

    const running = runNode(moduleOf(host.nodeModules(), 'mcp.formats.slow'), { assets, signal: controller.signal });
    // Let the request reach the server before cancelling it.
    await new Promise((resolve) => setTimeout(resolve, 5));
    controller.abort();

    const failure = await running.catch((err: unknown) => err);
    // The engine recognises a cancelled node by `err.name === 'AbortError'`;
    // wrapping it would turn a clean cancel into a failed run.
    expect((failure as Error).name).toBe('AbortError');
    expect(isRetryableError(failure as Error)).toBe(false);
  });
});
