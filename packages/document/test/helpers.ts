import fc from 'fast-check';
import { deriveRequires } from '../src/index.js';
import type { DocEdge, DocNode, WorkflowDoc } from '../src/index.js';

/**
 * Normalize fc.jsonValue output for round-trip comparison: -0 becomes 0 (a
 * YAML round trip cannot preserve the sign of zero) and "__proto__" keys are
 * renamed (never a value worth supporting; plain-object extraction cannot
 * represent them safely).
 */
export function sanitizeJson(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sanitizeJson);
  if (v !== null && typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v)) {
      out[k === '__proto__' ? 'proto_' : k] = sanitizeJson(val);
    }
    return out;
  }
  if (Object.is(v, -0)) return 0;
  return v;
}

const round = (v: number): number => Math.round(v) + 0;

/**
 * What parse(emit(d)) must report: positions rounded, requires derived,
 * empty config ≡ {}, empty/undefined description ≡ absent, empty name
 * defaulted, layout restricted to known nodes in node order.
 */
export function normalizeDoc(d: WorkflowDoc): WorkflowDoc {
  const layout: Record<string, { x: number; y: number }> = {};
  for (const n of d.nodes) {
    const p = d.layout[n.id];
    if (p !== undefined) layout[n.id] = { x: round(p.x), y: round(p.y) };
  }
  return {
    meta: {
      name: d.meta.name === '' ? 'Untitled workflow' : d.meta.name,
      ...(d.meta.description !== undefined && d.meta.description !== ''
        ? { description: d.meta.description }
        : {}),
    },
    requires: deriveRequires(d.nodes),
    nodes: d.nodes.map((n) => ({
      id: n.id,
      type: n.type,
      version: n.version,
      ...(n.schemaHash !== undefined ? { schemaHash: n.schemaHash } : {}),
      // Sorted and deduped, matching `extractWorkflow`. Both sides of every
      // property must agree on the canonical form or the round-trip assertion
      // is testing the generator rather than the serializer.
      ...(n.promoted !== undefined && n.promoted.length > 0
        ? { promoted: [...new Set(n.promoted)].sort() }
        : {}),
      config: n.config ?? {},
    })),
    edges: d.edges.map((e) => ({ from: { ...e.from }, to: { ...e.to } })),
    layout,
  };
}

export const idArb = fc.stringMatching(/^n_[a-z2-7]{6}$/);
export const portArb = fc.stringMatching(/^[a-z][a-z0-9_]{0,7}$/);
const segArb = fc.stringMatching(/^[a-z][a-z0-9_]{0,7}$/);

export const typeArb = fc.oneof(
  fc.constant('aec.project_brief'),
  fc.constant('ai.generate_text'),
  fc.constant('mcp.revit.query_model'),
  fc.constant('acme.pointcloud.load'),
  fc.tuple(segArb, segArb).map(([a, b]) => `${a}.${b}`),
);

const configValueArb = fc.oneof(
  fc.jsonValue({ maxDepth: 3 }).map(sanitizeJson),
  fc.constantFrom<unknown>('line1\nline2\n', 'a\nb', 'true', '007', 'null', '', 'yes', 'trailing \nspace'),
);

export const configArb = fc.dictionary(portArb, configValueArb, { maxKeys: 4 });

const nameArb = fc.oneof(
  fc.string({ minLength: 1 }),
  fc.constantFrom('true', '007', 'null', 'a: b', '- x', 'Untitled workflow', '#hash'),
);

/**
 * Deliberately `fc.array`, not `fc.uniqueArray`, and deliberately unsorted.
 *
 * `promoted:` is normalised to sorted-and-deduped on read AND on write, and a
 * generator that only ever produced canonical lists would keep all six
 * properties green while proving nothing about the normalisation — which is
 * the one part of this field that can go wrong. Duplicates and reverse order
 * are the inputs that make round-trip and no-op-save load-bearing.
 */
const promotedArb = fc.option(fc.array(portArb, { maxLength: 4 }), { nil: undefined });

const nodeRecArb = fc.record({
  type: typeArb,
  version: fc.integer({ min: 1, max: 9 }),
  schemaHash: fc.option(fc.stringMatching(/^b3:[0-9a-f]{4,8}$/), { nil: undefined }),
  promoted: promotedArb,
  config: configArb,
});

const nodesArb: fc.Arbitrary<DocNode[]> = fc
  .uniqueArray(idArb, { maxLength: 5 })
  .chain((ids) =>
    ids.length === 0
      ? fc.constant([] as DocNode[])
      : fc.tuple(...ids.map(() => nodeRecArb)).map((recs) =>
          recs.map((r, i) => ({
            id: ids[i],
            type: r.type,
            version: r.version,
            ...(r.schemaHash !== undefined ? { schemaHash: r.schemaHash } : {}),
            ...(r.promoted !== undefined && r.promoted.length > 0 ? { promoted: r.promoted } : {}),
            config: r.config,
          })),
        ),
  );

const posArb = fc.oneof(
  fc.integer({ min: -10000, max: 10000 }),
  fc.double({ min: -10000, max: 10000, noNaN: true, noDefaultInfinity: true }),
);

function edgesFor(ids: string[]): fc.Arbitrary<DocEdge[]> {
  if (ids.length === 0) return fc.constant([]);
  return fc.array(
    fc.record({
      from: fc.record({ node: fc.constantFrom(...ids), port: portArb }),
      to: fc.record({ node: fc.constantFrom(...ids), port: portArb }),
    }),
    { maxLength: 6 },
  );
}

function layoutFor(ids: string[]): fc.Arbitrary<Record<string, { x: number; y: number }>> {
  if (ids.length === 0) return fc.constant({});
  return fc
    .tuple(...ids.map(() => fc.option(fc.record({ x: posArb, y: posArb }), { nil: undefined })))
    .map((entries) => {
      const layout: Record<string, { x: number; y: number }> = {};
      entries.forEach((e, i) => {
        if (e !== undefined) layout[ids[i]] = e;
      });
      return layout;
    });
}

export const docArb: fc.Arbitrary<WorkflowDoc> = nodesArb.chain((nodes) => {
  const ids = nodes.map((n) => n.id);
  return fc
    .record({
      name: nameArb,
      description: fc.option(fc.string(), { nil: undefined }),
      edges: edgesFor(ids),
      layout: layoutFor(ids),
    })
    .map(({ name, description, edges, layout }) => ({
      meta: description !== undefined ? { name, description } : { name },
      // parse artifact — emit/save ignore it, so its content is irrelevant here
      requires: { mcp: [], ai: [], plugins: [] },
      nodes,
      edges,
      layout,
    }));
});

/**
 * fc.assert parameters: default run count, overridable via FC_NUM_RUNS, with
 * an optional fixed seed via FC_SEED (for stress runs and reproductions).
 */
export function propRuns(defaultRuns: number): fc.Parameters<unknown> {
  const runs = process.env['FC_NUM_RUNS'];
  const seed = process.env['FC_SEED'];
  return {
    numRuns: runs !== undefined ? Number(runs) : defaultRuns,
    ...(seed !== undefined ? { seed: Number(seed) } : {}),
  };
}

/** All comment tails ("#..." to end of line) present in a YAML text. */
export function commentTails(text: string): string[] {
  return text
    .split('\n')
    .filter((l) => l.includes('#'))
    .map((l) => l.slice(l.indexOf('#')));
}
