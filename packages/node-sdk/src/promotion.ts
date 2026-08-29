/**
 * Param promotion: turning a configured param into a wireable input port
 * (ARCHITECTURE §5.1 and §9.3, ADR-0005 decision 3, ADR-0017).
 *
 * §5.1 decided that params and inputs are separate declarations bridged by
 * promotion — "any param marked *promotable* can be exposed as an input port of
 * the corresponding type; a wired value overrides the configured one". This
 * file is "of the corresponding type", and it is the ONLY place that answers
 * it. Five call sites read `manifest.inputs` — the engine's validator (three
 * times), its input assembly, the renderer's connection check and its node
 * card — and every one of them must see the same port list for the same
 * `(manifest, promoted)` pair or the product breaks in the least debuggable
 * way available: a graph that validates and then executes against a different
 * set of ports.
 *
 * **Its own module, and its own package export path, on purpose.** The
 * renderer draws promoted handles, so it needs this at runtime. Importing it
 * from `./index.js` would pull that module's top-level `@noble/hashes` import
 * into the browser bundle for the sake of a pure string mapping. Everything
 * this file imports is a `type`, which TypeScript erases, so `@archspace/node-sdk/promotion`
 * has no runtime dependencies at all.
 *
 * What is deliberately NOT here: any check of a wired *value* against the
 * param's schema. The §9.3 mapping is lossy — an `enum` becomes plain `text`,
 * an `array` becomes `json` — so a promoted enum port accepts any string. That
 * is a real fidelity loss and ADR-0017 records it as one. Validating wired
 * values and not configured ones would invent a rule §5.1 does not authorise:
 * the same value refused on a wire and accepted in the inspector form. Nothing
 * in this repository validates params against their schema, and promotion is
 * not the change that should start.
 */
import type { JsonSchemaProperty, NodeManifest, PortDecl } from './index.js';

/**
 * The port-type a promoted param takes, from ARCHITECTURE §9.3's table:
 * string→`text`, number→`number`, boolean→`boolean`, object/array→`json`.
 *
 * `integer` is JSON Schema's own second numeric type and the table does not
 * name it; it maps to `number`, which is the only honest answer — the port
 * system has no integer type and inventing one here would make a manifest's
 * declared type unrepresentable on a wire.
 *
 * A param with no declared `type` maps to `json` rather than `any`. `json`
 * accepts every primitive and every list by widening (§6.2), so it is already
 * the permissive end of the type system, and `any` additionally switches the
 * engine to unchecked delivery — a runtime-checked-nothing port is not what an
 * under-specified schema deserves.
 */
export function schemaTypeToPortType(schema: JsonSchemaProperty): string {
  switch (schema.type) {
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

/** Whether a param's schema opts into promotion (`x-archspace.promotable`). */
export function isPromotableSchema(schema: JsonSchemaProperty | undefined): boolean {
  return schema?.['x-archspace']?.promotable === true;
}

/**
 * A param name that a promoted port could never be wired to.
 *
 * The document's edge grammar is `<node>.<port> -> <node>.<port>` with
 * `[A-Za-z0-9_-]+` per segment (`packages/document/src/edge.ts`), so a param
 * named `file.path` — legal JSON Schema, and something an MCP server really
 * does publish — has no expressible edge. Refusing it here means the promote
 * affordance is never offered for a param that would produce an unsaveable
 * document, rather than discovering it at save time.
 */
const PROMOTABLE_NAME_RE = /^[A-Za-z0-9_-]+$/;

export function isPromotableName(name: string): boolean {
  return PROMOTABLE_NAME_RE.test(name);
}

/** Why one entry in a node's `promoted:` list could not become a port. */
export interface PromotionIssue {
  /** The param named in the list, carried separately from the message so a UI
   *  can list orphaned promotions without re-parsing prose. */
  param: string;
  message: string;
}

export interface ResolvedPromotions {
  /** The node's effective input ports: declared inputs, then promoted params in
   *  the order they were listed. */
  inputs: PortDecl[];
  issues: PromotionIssue[];
  /** The subset of `inputs` that exists because of promotion, by port id. Used
   *  by the engine to fold a wired value back into `params`, and by the
   *  renderer to draw a promoted handle differently from a declared one. */
  promotedIds: ReadonlySet<string>;
}

const EMPTY: ResolvedPromotions = { inputs: [], issues: [], promotedIds: new Set() };

/**
 * The effective input ports of one node instance.
 *
 * A promotion that cannot be honoured still produces a port — typed `any`,
 * `required: false`. That is not leniency, it is error economy. An edge into a
 * port that does not resolve produces `bad-edge`, and because `validateGraph`
 * only records an incoming edge once its target port resolves, it then produces
 * a *second*, false `missing-input` naming a port the user did wire. Two errors
 * for one mistake, one of them pointing at innocent work. Synthesising the port
 * suppresses both by construction, and the single accurate `bad-promotion`
 * error that this function reports is left standing alone.
 */
export function resolvePromotions(manifest: NodeManifest, promoted: readonly string[] | undefined): ResolvedPromotions {
  if (promoted === undefined || promoted.length === 0) {
    return manifest.inputs.length === 0 ? EMPTY : { inputs: manifest.inputs, issues: [], promotedIds: new Set() };
  }

  const declared = new Set(manifest.inputs.map((p) => p.id));
  const properties = manifest.params.properties ?? {};
  const inputs: PortDecl[] = [...manifest.inputs];
  const issues: PromotionIssue[] = [];
  const promotedIds = new Set<string>();

  for (const name of promoted) {
    if (promotedIds.has(name)) continue; // a duplicate is one port, not two
    if (declared.has(name)) {
      issues.push({
        param: name,
        message: `"${name}" is already an input port on ${manifest.type}@${manifest.version}, so promoting it would declare the same port twice`,
      });
      continue;
    }

    const schema = properties[name];
    const fail = (message: string): void => {
      issues.push({ param: name, message });
      inputs.push({ id: name, type: 'any', required: false, label: name });
      promotedIds.add(name);
    };

    if (schema === undefined) {
      fail(
        `"${name}" is promoted on this node but ${manifest.type}@${manifest.version} has no such param — ` +
          `the node type may have changed since the workflow was saved`,
      );
      continue;
    }
    if (!isPromotableName(name)) {
      fail(
        `"${name}" cannot be promoted: an edge endpoint may only contain letters, digits, "_" and "-", ` +
          `so no edge could ever target it`,
      );
      continue;
    }
    if (!isPromotableSchema(schema)) {
      fail(`"${name}" is not marked promotable by ${manifest.type}@${manifest.version}, so it cannot be exposed as a port`);
      continue;
    }

    inputs.push({
      id: name,
      type: schemaTypeToPortType(schema),
      // Always optional. A promoted param has a configured value (or a schema
      // default) behind it — that is what "a wired value *overrides* the
      // configured one" means — so an unwired promoted port is a node ready to
      // run, not a missing input. `validateGraph` errors on any port whose
      // `required` is not exactly `false`, so this is load-bearing.
      required: false,
      label: schema.title ?? name,
      ...(schema.description !== undefined ? { description: schema.description } : {}),
    });
    promotedIds.add(name);
  }

  return { inputs, issues, promotedIds };
}

/**
 * Every param on a manifest that could be promoted, in schema order — what the
 * inspector offers a promote affordance for.
 */
export function promotableParams(manifest: NodeManifest): string[] {
  const declared = new Set(manifest.inputs.map((p) => p.id));
  return Object.entries(manifest.params.properties ?? {})
    .filter(([name, schema]) => isPromotableSchema(schema) && isPromotableName(name) && !declared.has(name))
    .map(([name]) => name);
}
