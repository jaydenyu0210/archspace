/**
 * Output port-type conformance for the aec-review suite.
 *
 * The nodes-core suites assert this with `isValueOfType` from
 * `@archspace/types`. This plugin cannot import it: it declares only
 * `@archspace/node-sdk` and `@archspace/nodes-core`, so `@archspace/types`
 * does not resolve from here at all. Reaching it anyway by relative path
 * (`../../../packages/types/src/index.js`) was the obvious alternative and is
 * rejected on purpose — a plugin tunnelling through the workspace to a package
 * it never declared is exactly the boundary erosion ADR-0008 moved these nodes
 * out of nodes-core to prevent, and a suite that proves the boundary must not
 * be the first thing to breach it. The real fix is one line in the plugin's
 * package.json (`@archspace/types` as a devDependency); this module should be
 * deleted in favour of the canonical import the day that lands.
 *
 * Until then: a transcription of the branches of `isValueOfType`
 * (packages/types/src/index.ts, ARCHITECTURE §6.1) that this plugin's declared
 * output ports actually use — `json`, `table`, `number` — and nothing else.
 * `unknownOutputPortTypes` exists so the narrowing cannot silently rot into a
 * weaker check than nodes-core's: the moment a node declares an output type
 * this file does not model, the suite fails instead of passing vacuously.
 */
import type { NodeModule, Outputs } from '@archspace/node-sdk';

/** Every port type this module can judge. Kept minimal deliberately. */
const MODELLED: readonly string[] = ['json', 'table', 'number'];

/**
 * Structural check that a runtime value inhabits a `Value` (JSON ∪ AssetRef).
 * Mirrors `isValueShape`: NaN and ±Infinity are rejected at the boundary, and
 * only plain objects count — a class instance is not a wire value.
 */
function isValueShape(v: unknown): boolean {
  if (v === null || typeof v === 'string' || typeof v === 'boolean') return true;
  if (typeof v === 'number') return Number.isFinite(v);
  if (Array.isArray(v)) return v.every(isValueShape);
  if (typeof v === 'object') {
    const proto = Object.getPrototypeOf(v);
    return proto === Object.prototype || proto === null
      ? Object.values(v as Record<string, unknown>).every(isValueShape)
      : false;
  }
  return false;
}

/** `isValueOfType(v, t)` for the three port types this plugin emits. */
export function isValueOfModelledType(v: unknown, type: string): boolean {
  switch (type) {
    case 'json':
      return isValueShape(v);
    case 'number':
      return typeof v === 'number' && Number.isFinite(v);
    case 'table': {
      if (typeof v !== 'object' || v === null || Array.isArray(v)) return false;
      const table = v as Record<string, unknown>;
      return (
        Array.isArray(table.columns) &&
        table.columns.every(
          (c) => typeof c === 'object' && c !== null && typeof (c as Record<string, unknown>).id === 'string',
        ) &&
        Array.isArray(table.rows) &&
        table.rows.every((r) => typeof r === 'object' && r !== null && !Array.isArray(r) && isValueShape(r))
      );
    }
    default:
      throw new Error(`port-types: "${type}" is not modelled here — see unknownOutputPortTypes`);
  }
}

/**
 * Output port types the node declares that this module cannot judge. A
 * non-empty result means the conformance assertions below have gone blind and
 * the suite must fail rather than report a green it did not earn.
 */
export function unknownOutputPortTypes(mod: NodeModule<never> | NodeModule<unknown>): string[] {
  return mod.manifest.outputs.map((port) => port.type).filter((type) => !MODELLED.includes(type));
}

/**
 * Every output that does not inhabit its declared port type, as readable
 * strings. Returning the mismatches rather than asserting keeps this module
 * assertion-free and gives the failing test a message naming the port.
 */
export function portTypeMismatches(mod: NodeModule<never> | NodeModule<unknown>, outputs: Outputs): string[] {
  const unknown = unknownOutputPortTypes(mod);
  if (unknown.length > 0) {
    return [`${mod.manifest.type}: unmodelled output port type(s) ${unknown.join(', ')}`];
  }
  const problems: string[] = [];
  for (const port of mod.manifest.outputs) {
    if (!(port.id in outputs)) {
      problems.push(`${mod.manifest.type}.${port.id}: declared output was never emitted`);
    } else if (!isValueOfModelledType(outputs[port.id], port.type)) {
      problems.push(`${mod.manifest.type}.${port.id}: does not inhabit ${port.type}`);
    }
  }
  return problems;
}
