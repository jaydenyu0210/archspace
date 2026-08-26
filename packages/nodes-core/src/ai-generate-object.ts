/**
 * ai.generate_object — a JSON-Schema-constrained model call (ARCHITECTURE §10
 * / ADR-0010).
 *
 * ADR-0010's Consequences section names this the workhorse: "structured
 * output becomes the workhorse for AI→`table`/`json` port flows". A `text`
 * completion has to be parsed by whoever receives it; an object shaped by a
 * schema the caller wrote lands on a `json` port and can be wired straight
 * into a node that keys into it. Like its siblings it is NOT a mock — it
 * reaches whatever provider this machine's model profile names, through
 * `ctx.ai` and nothing else, and never learns which one that was.
 *
 * The schema arrives from the form (JSON text in a textarea) or from a `json`
 * port, with the port winning when both are present. Two ways in, because the
 * two are different jobs: a schema typed into the form is part of the design
 * and belongs in the document's diff, while a schema arriving on a wire is one
 * an upstream node computed. The form-only alternative was rejected for making
 * a computed schema impossible; the port-only alternative for pushing every
 * fixed schema into a node of its own. Whichever it is, it is validated as a
 * JSON Schema *object* before the call: a scalar or array schema cannot
 * produce the object shape `generateObject` is contracted to return, and
 * failing here is cheaper and clearer than a provider error.
 *
 * Honest failure: no try/catch. When no profile is bound, `ctx.ai` throws an
 * error already naming the settings location; rethrowing it untouched is what
 * keeps that sentence in front of the user, and the gateway's own transient
 * marking survives the rethrow for the engine's retry policy (§7.5). The one
 * error this node raises about the *response* — a model that answered with
 * something other than an object — is marked with `ctx.retryable`, because
 * unlike an unbound profile it is exactly the failure that a re-sample fixes.
 *
 * Caching: 'never', the contract's default and a deliberate choice here (§5.2:
 * purity is opt-in). A schema constrains the *shape* of an answer, never its
 * content — two runs of the same request can return two different objects that
 * both satisfy it — and the memo key (§7.3) hashes params and input hashes
 * only, so it cannot see which provider the profile name resolved to on this
 * machine at this moment. Marking it 'pure' was considered and rejected for
 * the reason ADR-0009 §4 refused MCP's advisory `readOnlyHint`: cache entries
 * are valid forever by construction, so a wrong 'pure' is not a stale entry
 * but a permanently wrong one.
 */
import type { AiGateway, JsonSchemaObject, NodeModule, Value } from '@archspace/node-sdk';
import {
  composeUserPrompt,
  describeProfile,
  MODEL_PROFILE_PARAM,
  requestedProfile,
} from './ai-common.js';

export interface AiGenerateObjectParams {
  profile: string;
  system: string;
  prompt: string;
  schema: string;
}

/**
 * The schema shipped in the form by default. A real, runnable one: the node's
 * defaults have to produce a working call, the same way aec.project_brief's
 * defaults are tuned to run end-to-end.
 */
const DEFAULT_SCHEMA = `{
  "type": "object",
  "properties": {
    "summary": { "type": "string" },
    "risks": { "type": "array", "items": { "type": "string" } }
  },
  "required": ["summary", "risks"]
}`;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Narrowing, not casting: `generateObject` takes a JsonSchemaObject, and the
 * two places a schema can come from (a textarea, a wire) both deliver
 * `unknown`. The check is the honest one the type demands — an object whose
 * `type` is "object" — and everything below it stays the caller's business,
 * because a node that re-validated the whole of JSON Schema 2020-12 would be
 * a second, worse implementation of what the provider already enforces.
 */
function isSchemaObject(v: unknown): v is JsonSchemaObject {
  return isRecord(v) && v.type === 'object';
}

/** A value described the way an error message should describe it. */
function describeKind(v: Value): string {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'an array';
  return `a ${typeof v}`;
}

export const aiGenerateObjectNode: NodeModule<AiGenerateObjectParams> = {
  manifest: {
    type: 'ai.generate_object',
    version: 1,
    label: 'Generate Object',
    description:
      'Calls the model bound to a named profile and returns an object shaped by a JSON Schema you supply — the structured half of the AI surface.',
    category: 'AI',
    keywords: ['ai', 'llm', 'json', 'schema', 'structured', 'extract'],
    // See the header: a schema fixes the shape of an answer, not its content.
    caching: 'never',
    lane: 'ai',
    // Nothing: `ctx.ai` is unconditional (§5.2) and the gateway holds the
    // keys, so no 'net' and no secret. Stated rather than omitted because an
    // AI node is where a reader would reasonably wonder.
    permissions: [],
    params: {
      type: 'object',
      properties: {
        profile: MODEL_PROFILE_PARAM,
        system: {
          type: 'string',
          title: 'System instruction',
          description:
            'Standing instruction for the model — role, tone, constraints. Sent as the request\'s system message.',
          default: '',
          'x-archspace': { widget: 'textarea', rows: 3 },
        },
        prompt: {
          type: 'string',
          title: 'Prompt',
          description:
            'The instruction for this call. Anything wired to the context port is appended below it under a "# Context" heading.',
          default: '',
          'x-archspace': {
            widget: 'textarea',
            rows: 6,
            placeholder: 'Summarize this review and list the risks it implies.',
          },
        },
        schema: {
          type: 'string',
          title: 'JSON Schema',
          description:
            'The object schema the answer must satisfy. Ignored when the schema port is wired.',
          default: DEFAULT_SCHEMA,
          'x-archspace': { widget: 'textarea', rows: 10 },
        },
      },
    },
    inputs: [
      // `json` widens from every primitive and container (§6.2), so a report,
      // a table or an MCP tool's structured result all connect unconverted.
      { id: 'context', type: 'json', label: 'Context', required: false },
      { id: 'schema', type: 'json', label: 'Schema', required: false },
    ],
    outputs: [{ id: 'object', type: 'json', label: 'Object' }],
  },

  async execute(ctx, inputs, params) {
    const resolved = resolveSchema(inputs.schema, params.schema);
    if (resolved.source === 'port') {
      // A form field silently ignored because a port happens to be connected
      // is the kind of thing a user spends twenty minutes on.
      ctx.log('info', 'using the schema from the schema port — the schema param is ignored');
    }
    const schema = resolved.schema;

    const user = composeUserPrompt(params.prompt, inputs.context);
    if (user === '') {
      throw new Error(
        'ai.generate_object: nothing to send — write a prompt, or wire the context port',
      );
    }
    const system = params.system.trim();
    const profile = requestedProfile(params.profile);

    ctx.progress(0.1, `calling ${describeProfile(profile)}`);

    // Naming the gateway's own inline request type keeps this call in step
    // with the contract instead of restating it. `signal` is the whole of
    // cancellation: an abort tears the provider call down mid-flight (§7.4).
    const request: Parameters<AiGateway['generateObject']>[0] = {
      schema,
      prompt: user,
      signal: ctx.signal,
      ...(profile !== undefined ? { profile } : {}),
      ...(system !== '' ? { system } : {}),
    };
    const { object } = await ctx.ai.generateObject(request);

    if (!isRecord(object)) {
      // The schema said "object"; the provider answered otherwise. Retryable
      // because re-sampling is precisely the remedy — but never absorbed into
      // an empty object, which would hand downstream nodes a plausible-looking
      // answer that no model gave.
      throw ctx.retryable(
        new Error(
          `ai.generate_object: the model returned ${describeKind(object)} where the schema requires an object`,
        ),
      );
    }

    ctx.progress(1, `received ${Object.keys(object).length} field(s)`);
    return { object };
  },
};

/** Where the schema the call was made with came from — the wire beats the form. */
interface ResolvedSchema {
  schema: JsonSchemaObject;
  source: 'port' | 'param';
}

function resolveSchema(wired: Value | undefined, written: string): ResolvedSchema {
  if (wired !== undefined && wired !== null) {
    if (!isSchemaObject(wired)) {
      throw new Error(
        'ai.generate_object: the wired schema is not a JSON Schema object (it needs "type": "object" at the top level)',
      );
    }
    return { schema: wired, source: 'port' };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(written);
  } catch (err) {
    // The parser's own message names the offending position; keeping it is the
    // difference between "invalid schema" and a fixable error.
    throw new Error(
      `ai.generate_object: the schema param is not valid JSON — ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (!isSchemaObject(parsed)) {
    throw new Error(
      'ai.generate_object: the schema param is not a JSON Schema object (it needs "type": "object" at the top level)',
    );
  }
  return { schema: parsed, source: 'param' };
}
