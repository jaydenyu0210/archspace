/**
 * The JSON boundary: node-sdk's loose contract types on one side, the AI SDK's
 * on the other (ARCHITECTURE §10 / ADR-0010).
 *
 * ADR-0010 rule 1 says nodes only ever see *our* interface, so `generateObject`
 * takes node-sdk's `JsonSchemaObject` and returns node-sdk's `Value`. The AI SDK
 * speaks `Schema<T>` and `unknown`. Exactly two conversions bridge the gap, and
 * they live here rather than inside `gateway.ts` so the seam is a named thing a
 * future SDK swap can be diffed against.
 *
 *  * `toSdkSchema` is a cast, deliberately. `JsonSchemaObject` *is* a JSON
 *    Schema 2020-12 subset — the same document `jsonSchema()` wants — just
 *    typed loosely enough for a manifest to be hand-written. Re-validating it
 *    here would mean shipping a JSON Schema validator (a dependency ADR-0010
 *    does not have and §10's "thin by design" does not want) to re-prove
 *    something the node registry already accepted.
 *  * `asJsonValue` is *not* a cast. `generateObject` hands back `unknown`, and a
 *    wire value in this repo has an invariant (§5.2: JSON plus AssetRef, small)
 *    that `as Value` would only assert. Narrowing structurally is a few lines
 *    and it is the difference between a typed contract and a hopeful one.
 *
 * We pass `jsonSchema()` no `validate` callback for the same reason as the
 * cast: schema *enforcement* belongs to the provider's structured-output mode,
 * not to a hand-rolled validator in the gateway.
 */
import { jsonSchema, type JSONSchema7, type Schema } from 'ai';
import type { JsonSchemaObject, Value } from '@archspace/node-sdk';

/** node-sdk's manifest/param schema type, as the AI SDK's schema argument. */
export function toSdkSchema(schema: JsonSchemaObject): Schema<unknown> {
  return jsonSchema(schema as unknown as JSONSchema7);
}

/**
 * Narrow a provider's parsed JSON into a wire `Value`.
 *
 * Total on purpose: anything JSON cannot carry (`undefined`, a function, a
 * non-finite number) becomes `null` or is dropped rather than throwing. A model
 * that returned something odd should surface as an odd *value* the workflow can
 * see, not as a crash three nodes deep.
 */
export function asJsonValue(input: unknown): Value {
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
      return null; // undefined, function, symbol, bigint
  }
  if (Array.isArray(input)) return input.map(asJsonValue);
  const out: { [key: string]: Value } = {};
  for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
    if (value === undefined) continue;
    out[key] = asJsonValue(value);
  }
  return out;
}
