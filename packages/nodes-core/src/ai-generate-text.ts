/**
 * ai.generate_text — one provider-agnostic model call (ARCHITECTURE §10 /
 * ADR-0010).
 *
 * This is the node the architecture's own worked example wires up (§4.2): the
 * prompt lives in the form, the material arrives on a `context` port from
 * whatever produced it upstream. Unlike every `aec.*` generate node in this
 * package it is NOT a mock — it reaches the provider that the user's model
 * profile names on THIS machine, through `ctx.ai` and nothing else. The node
 * never learns which provider that was, which is exactly what makes the same
 * document run unchanged on someone else's machine (ADR-0010 §3).
 *
 * Honest failure: when no profile is bound, `ctx.ai` throws an error whose
 * message already names the settings location. It is rethrown untouched —
 * there is no try/catch here at all. Wrapping it as "ai.generate_text failed:
 * …" would replace the one sentence the user can act on ("Bind it in
 * Settings → AI model profiles") with one they cannot, and re-marking it would
 * be redundant: the gateway already marks transient provider errors, and the
 * engine reads that mark straight off the rethrown error (§7.5).
 *
 * Caching: 'never' — the contract's default, and here a considered one (§5.2:
 * purity is opt-in). A model call is not a function of its inputs. Two
 * identical requests may return different text; even a temperature-0 profile
 * makes repetition likely rather than guaranteed, and "likely" is not a cache
 * key. Decisively, the memo key is hash(engineAbi, type, version, params,
 * inputHashes) (§7.3) and the params carry the profile *name*, never the
 * binding behind it — so "default" pointing at a local 8B model today and a
 * frontier model tomorrow hashes identically for two genuinely different
 * answers. 'pure' was weighed and rejected on the same grounds ADR-0009 §4
 * refused to trust MCP's advisory `readOnlyHint`: cache entries are valid
 * forever by construction (§7.3), so a wrong 'pure' is not a stale entry, it
 * is a permanently wrong one that re-running cannot clear. The lever for
 * someone who wants repeat runs to skip the provider is a profile they
 * control, not a lie in the manifest.
 *
 * `chat` in and out: `AiGateway.generateText` accepts `messages`, and §6.1's
 * `chat` type would otherwise have no producer or consumer anywhere in the
 * build. Wiring this node's `messages` output into the next one's `messages`
 * input is how a multi-turn exchange is expressed as a graph. The rejected
 * alternative was a separate `ai.chat` node — a second copy of this manifest
 * to gain one port.
 */
import type { AiGateway, ChatMessage, NodeModule } from '@archspace/node-sdk';
import {
  composeUserPrompt,
  describeProfile,
  MODEL_PROFILE_PARAM,
  requestedProfile,
} from './ai-common.js';
import { toValue } from './util.js';

export interface AiGenerateTextParams {
  profile: string;
  system: string;
  prompt: string;
}

export const aiGenerateTextNode: NodeModule<AiGenerateTextParams> = {
  manifest: {
    type: 'ai.generate_text',
    version: 1,
    label: 'Generate Text',
    description:
      'Calls the model bound to a named profile and returns its completion. Provider-agnostic: the workflow names a profile, this machine names the provider.',
    category: 'AI',
    keywords: ['ai', 'llm', 'prompt', 'text', 'chat', 'summarize'],
    // See the header: a model call is not a pure function of its inputs, and
    // the cache key cannot see the binding that produced the answer.
    caching: 'never',
    lane: 'ai',
    // Nothing. `ctx.ai` is unconditional (§5.2) and the gateway holds the
    // keys, so this node asks for neither 'net' nor a secret — the one place
    // a reader would reasonably wonder, which is why the empty list is stated
    // rather than omitted.
    permissions: [],
    params: {
      type: 'object',
      properties: {
        profile: MODEL_PROFILE_PARAM,
        system: {
          type: 'string',
          title: 'System instruction',
          description:
            'Standing instruction for the model — role, tone, constraints. Sent as the request\'s system message, never as a conversation turn.',
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
            rows: 8,
            placeholder: 'Summarize the room schedule below and flag rooms missing an area.',
          },
        },
      },
    },
    inputs: [
      // `json` rather than `text` on purpose: json widens from every primitive
      // and container (§6.2), so a text report, a number, a table or an MCP
      // tool's structured result all connect without a converter node.
      { id: 'context', type: 'json', label: 'Context', required: false },
      { id: 'messages', type: 'chat', label: 'Messages', required: false },
    ],
    outputs: [
      { id: 'text', type: 'text', label: 'Text' },
      { id: 'messages', type: 'chat', label: 'Messages' },
    ],
  },

  async execute(ctx, inputs, params) {
    // A `chat` wire carries exactly this shape by contract (§6.1), so this is
    // the same trusted read `requireInput` performs for every other node here.
    const prior = (inputs.messages ?? []) as unknown as ChatMessage[];
    const user = composeUserPrompt(params.prompt, inputs.context);
    if (user === '' && prior.length === 0) {
      throw new Error(
        'ai.generate_text: nothing to send — write a prompt, or wire the context or messages port',
      );
    }

    const system = params.system.trim();
    const profile = requestedProfile(params.profile);
    // The conversation this call is a continuation of. The system instruction
    // is deliberately not a turn: it stays a param of whoever is calling, so
    // chaining two of these nodes does not accumulate two system messages.
    const turns: ChatMessage[] =
      user === '' ? [...prior] : [...prior, { role: 'user', content: user }];

    ctx.progress(0.1, `calling ${describeProfile(profile)}`);

    // Naming the gateway's own inline request type keeps this call in step
    // with the contract instead of restating it.
    // `prompt` XOR `messages`, never both: the gateway accepts either, and a
    // request carrying both would leave precedence to a provider adapter this
    // node deliberately cannot see. A wired conversation therefore absorbs the
    // prompt as its final user turn. Cancellation is the one `signal` line —
    // an abort tears the provider call down mid-flight (§7.4) rather than
    // discarding a result we already paid for.
    const request: Parameters<AiGateway['generateText']>[0] = {
      signal: ctx.signal,
      ...(profile !== undefined ? { profile } : {}),
      ...(system !== '' ? { system } : {}),
      ...(prior.length === 0 ? { prompt: user } : { messages: turns }),
    };
    const { text } = await ctx.ai.generateText(request);

    if (text === '') {
      // Surfaced, never smoothed over: an empty completion is a real answer
      // from the provider and downstream nodes will see it, so say so here
      // rather than let it look like a wiring mistake.
      ctx.log('warn', 'the model returned an empty completion');
    }
    ctx.progress(1, `received ${text.length} character(s)`);

    return {
      text,
      messages: toValue([...turns, { role: 'assistant', content: text }] satisfies ChatMessage[]),
    };
  },
};
