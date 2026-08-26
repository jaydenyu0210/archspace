/**
 * ai.embed — text to vectors, through whichever provider this machine binds
 * (ARCHITECTURE §10, §16 M4 / ADR-0010).
 *
 * The third node §16 M4 names, and the only one of the four that returns
 * numbers rather than prose. Like its siblings it reaches a real provider
 * through `ctx.ai` and never learns which one, so a graph that clusters room
 * descriptions runs unchanged against a cloud embedding model here and a local
 * one on the next desk.
 *
 * **Why the vectors come out as `json` and not `list<number>`.** An embedding
 * set is `number[][]`, and §6's grammar can spell that — `list<list<number>>` —
 * but a port typed that way would connect to almost nothing: widening runs
 * *towards* `json` (§6.2), never away from it, so every consumer would need an
 * exact match. `json` is what an MCP tool, a plugin node or a `table` builder
 * can actually take, and the shape is documented here instead of in the type.
 *
 * **Why `values` is a port and `text` is a param, rather than one input that
 * accepts both.** Embedding is a batch operation — the whole point of
 * `embedMany` is that N texts cost one round trip — so the wired case is the
 * real one and it is a list. The param exists for the other genuine case: a
 * single literal being compared against a wired corpus, where forcing the user
 * to build a one-element list upstream would be ceremony. They are not merged:
 * concatenating a param onto a wired list would silently shift every index, and
 * the caller's whole reason for embedding a list is that index i means row i.
 *
 * **Caching is 'never', for ai.generate_text's reason and not for its own.**
 * An embedding model is far closer to deterministic than a chat model, so the
 * usual argument does not apply — but the memo key hashes the profile *name*,
 * never the binding behind it (§7.3), and cache entries are valid forever by
 * construction. A `default` profile pointed at a 384-dimension local model
 * today and a 1536-dimension hosted one tomorrow hashes identically for two
 * incompatible answers, and a wrong 'pure' there is not a stale entry, it is a
 * permanently wrong one that re-running cannot clear.
 *
 * Failure is left alone here exactly as in the sibling nodes: an unbound
 * profile throws from `ctx.ai` with a message that already names the settings
 * location, and rewrapping it would replace the sentence the user can act on.
 */
import type { NodeModule, Value } from '@archspace/node-sdk';
import { describeProfile, MODEL_PROFILE_PARAM, requestedProfile } from './ai-common.js';
import { toValue } from './util.js';

export interface AiEmbedParams {
  profile: string;
  text: string;
}

/**
 * A wired `list<text>` port, read defensively.
 *
 * Every other node in this package trusts its declared port type, and the type
 * system does guarantee the *port* is a list. It cannot guarantee the elements
 * survived a `json` widening upstream — an MCP tool's structured result may
 * arrive as a list holding a number — and a non-string reaching a provider's
 * embedding endpoint is a 400 whose message will not mention this node. So the
 * one thing that is genuinely uncertain is checked, and nothing else is.
 */
function readValues(input: Value | undefined): string[] {
  if (input === undefined || input === null) return [];
  if (!Array.isArray(input)) return [];
  return input.map((item) => (typeof item === 'string' ? item : JSON.stringify(item)));
}

export const aiEmbedNode: NodeModule<AiEmbedParams> = {
  manifest: {
    type: 'ai.embed',
    version: 1,
    label: 'Embed Text',
    description:
      'Turns text into embedding vectors using the model bound to a named profile. One request for the whole batch; index i of the output is index i of the input.',
    category: 'AI',
    keywords: ['ai', 'embedding', 'vector', 'similarity', 'search', 'cluster'],
    // See the header: the cache key cannot see which model a profile binds, and
    // two embedding models do not even agree on how many dimensions to return.
    caching: 'never',
    lane: 'ai',
    // Nothing: `ctx.ai` is unconditional (§5.2) and the gateway holds the keys,
    // so this node asks for neither 'net' nor a secret. Stated rather than
    // omitted, because a node that reaches a provider is where a reader will
    // look for a permission.
    permissions: [],
    params: {
      type: 'object',
      properties: {
        profile: MODEL_PROFILE_PARAM,
        text: {
          type: 'string',
          title: 'Text',
          description:
            'A single value to embed, for when there is no list to wire. Ignored whenever the values port is connected — the two are never merged, because that would shift every index in the wired list.',
          default: '',
          'x-archspace': {
            widget: 'textarea',
            rows: 4,
            placeholder: 'A naturally lit meeting room for six people.',
          },
        },
      },
    },
    inputs: [{ id: 'values', type: 'list<text>', label: 'Values', required: false }],
    outputs: [
      // number[][], parallel to the input. See the header for why this is json.
      { id: 'embeddings', type: 'json', label: 'Embeddings' },
      { id: 'count', type: 'number', label: 'Count' },
      // The provider's dimensionality, reported rather than assumed: it is the
      // number a downstream similarity step has to agree on, and it is a
      // property of the bound model that the workflow file cannot know.
      { id: 'dimensions', type: 'number', label: 'Dimensions' },
    ],
  },

  async execute(ctx, inputs, params) {
    const wired = readValues(inputs.values);
    const literal = params.text.trim();
    const values = wired.length > 0 ? wired : literal === '' ? [] : [literal];

    if (values.length === 0) {
      throw new Error('ai.embed: nothing to embed — write a value, or wire the values port');
    }

    const profile = requestedProfile(params.profile);
    ctx.progress(0.1, `embedding ${values.length} value(s) with ${describeProfile(profile)}`);

    // One call for the batch: `embedMany` is why this node takes a list at all.
    // Cancellation is the `signal` line — an abort tears the provider call down
    // mid-flight (§7.4) rather than discarding a result we already paid for.
    const { embeddings } = await ctx.ai.embed({
      signal: ctx.signal,
      ...(profile !== undefined ? { profile } : {}),
      values,
    });

    // A provider that returns a different number of vectors than it was given
    // has broken the index correspondence this node's whole contract rests on.
    // Downstream that reads as data silently misaligned against the wrong rows,
    // so it fails loudly here instead.
    if (embeddings.length !== values.length) {
      throw new Error(
        `ai.embed: asked for ${values.length} embedding(s) but the provider returned ${embeddings.length} — the outputs would not line up with the inputs`,
      );
    }

    const dimensions = embeddings[0]?.length ?? 0;
    ctx.progress(1, `received ${embeddings.length} vector(s) of ${dimensions} dimension(s)`);

    return {
      embeddings: toValue(embeddings),
      count: embeddings.length,
      dimensions,
    };
  },
};
