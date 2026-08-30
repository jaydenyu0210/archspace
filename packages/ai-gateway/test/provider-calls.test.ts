/**
 * Pins what actually goes on the wire, by driving the **real** AI SDK provider
 * code with the transport replaced (ADR-0013 §6).
 *
 * The `mock` provider covers everything except the parts that *are* the SDK —
 * URL construction, auth placement, request shaping, embeddings, error mapping
 * — and those are exactly the parts where a wrong assumption is invisible until
 * a user's key goes to the wrong host. `fetchImpl` reaches them offline, so
 * this file asserts against recorded requests rather than against a stub of our
 * own code: every expectation below is a fact about a request `@ai-sdk/anthropic`
 * or `@ai-sdk/openai-compatible` really built.
 *
 * The load-bearing one is `maxRetries: 0`. Retry and backoff belong to the
 * engine (§7.5 / ADR-0007), which alone knows the node's policy and the run's
 * cancellation state; the SDK's own default is 2, so leaving it in place would
 * stack two backoff loops and make the engine's documented retry schedule a
 * lie. That is not visible in any return value — only in how many requests a
 * single failing call produced. Hence the counting.
 */
import { describe, expect, it } from 'vitest';
import type { JsonSchemaObject } from '@archspace/node-sdk';
import { AiProfileError, AiProviderError, createAiGateway } from '../src/index.js';
import {
  NEVER_FETCH,
  alwaysRespond,
  anthropicMessage,
  chatCompletion,
  configOf,
  embeddingList,
  googleContent,
  googleEmbedding,
  keychain,
  openAiFailure,
  openAiResponse,
  recordFetch,
} from './helpers.js';

const KEYS = keychain({ 'ai.key': 'sk-ant-real-value' });

const OBJECT_SCHEMA: JsonSchemaObject = {
  type: 'object',
  properties: { room: { type: 'string' }, seats: { type: 'integer' } },
  required: ['room'],
};

/** Serve chat, embeddings and structured output from one endpoint. */
function endpoint(json = '{"room":"R1","seats":4}') {
  return recordFetch((call) => {
    if (call.url.endsWith('/embeddings')) return embeddingList([[0.1, 0.2, 0.3]]);
    return chatCompletion(call.body.response_format !== undefined ? json : 'hello');
  });
}

describe('base-URL binding', () => {
  it('sends an Anthropic profile to the catalogue default endpoint', async () => {
    const net = alwaysRespond(() => anthropicMessage('ok'));
    const gateway = createAiGateway({
      config: configOf([{ name: 'cloud', provider: 'anthropic', model: 'claude-opus-5', apiKeyRef: 'ai.key' }]),
      secrets: KEYS,
      fetchImpl: net.fetchImpl,
    });

    await gateway.generateText({ prompt: 'x' });

    expect(net.single().url).toBe('https://api.anthropic.com/v1/messages');
  });

  it('lets a profile point Anthropic at a self-hosted proxy instead', async () => {
    const net = alwaysRespond(() => anthropicMessage('ok'));
    const gateway = createAiGateway({
      config: configOf([
        { name: 'cloud', provider: 'anthropic', model: 'claude-opus-5', apiKeyRef: 'ai.key', baseUrl: 'https://proxy.internal/anthropic' },
      ]),
      secrets: KEYS,
      fetchImpl: net.fetchImpl,
    });

    await gateway.generateText({ prompt: 'x' });

    expect(net.single().url).toBe('https://proxy.internal/anthropic/messages');
  });

  it('sends an Ollama profile to localhost with no key and no configuration', async () => {
    // "No privileged provider" made concrete: the local entry needs nothing the
    // cloud entry does, and reaches a machine-local endpoint.
    const net = alwaysRespond(() => chatCompletion('hello'));
    const secrets = keychain();
    const gateway = createAiGateway({
      config: configOf([{ name: 'local', provider: 'ollama', model: 'llama3.1' }]),
      secrets,
      fetchImpl: net.fetchImpl,
    });

    await gateway.generateText({ prompt: 'x' });

    const call = net.single();
    expect(call.url).toBe('http://localhost:11434/v1/chat/completions');
    expect(call.headers.authorization).toBeUndefined();
    expect(secrets.reads).toEqual([]);
  });

  it('refuses an OpenAI-compatible profile with no endpoint rather than guessing one', async () => {
    const gateway = createAiGateway({
      config: configOf([{ name: 'byo', provider: 'openai-compatible', model: 'm' }]),
      secrets: keychain(),
      fetchImpl: NEVER_FETCH,
    });

    await expect(gateway.generateText({ prompt: 'x' })).rejects.toMatchObject({
      name: 'AiProfileError',
      reason: 'invalid',
    });
  });

  it('routes Ollama and any other OpenAI-compatible endpoint through one code path', async () => {
    const net = alwaysRespond(() => chatCompletion('hello'));
    const gateway = createAiGateway({
      config: configOf([
        { name: 'ollama', provider: 'ollama', model: 'llama3.1', baseUrl: 'http://box:11434/v1' },
        { name: 'vllm', provider: 'openai-compatible', model: 'm', baseUrl: 'http://box:8000/v1' },
      ]),
      secrets: keychain(),
      fetchImpl: net.fetchImpl,
    });

    await gateway.generateText({ profile: 'ollama', prompt: 'x' });
    await gateway.generateText({ profile: 'vllm', prompt: 'x' });

    expect(net.urls()).toEqual(['http://box:11434/v1/chat/completions', 'http://box:8000/v1/chat/completions']);
    // Same body shape from both: one integration, two catalogue entries.
    expect(net.calls[0]?.body.messages).toEqual(net.calls[1]?.body.messages);
  });
});

describe('request shaping', () => {
  it('carries the profile parameters the user configured', async () => {
    const net = endpoint();
    const gateway = createAiGateway({
      config: configOf([
        { name: 'p', provider: 'openai-compatible', model: 'm', baseUrl: 'http://h/v1', temperature: 0.2, maxOutputTokens: 64, headers: { 'X-Team': 'aec' } },
      ]),
      secrets: keychain(),
      fetchImpl: net.fetchImpl,
    });

    await gateway.generateText({ prompt: 'x' });

    const call = net.single();
    expect(call.body).toMatchObject({ model: 'm', temperature: 0.2, max_tokens: 64 });
    expect(call.headers['x-team']).toBe('aec');
  });

  it('sends a system prompt as instructions rather than as a turn', async () => {
    const net = endpoint();
    const gateway = createAiGateway({
      config: configOf([{ name: 'p', provider: 'openai-compatible', model: 'm', baseUrl: 'http://h/v1' }]),
      secrets: keychain(),
      fetchImpl: net.fetchImpl,
    });

    await gateway.generateText({ system: 'You are terse.', prompt: 'x' });

    expect(net.single().body.messages).toEqual([
      { role: 'system', content: 'You are terse.' },
      { role: 'user', content: 'x' },
    ]);
  });

  it('keeps a scripted conversation in the order the node wrote it', async () => {
    // AI SDK 7 refuses system messages inside `messages` by default and would
    // otherwise hoist them to the front. A node that scripted a conversation
    // gets its own ordering — that is what `allowSystemInMessages` buys.
    const net = endpoint();
    const gateway = createAiGateway({
      config: configOf([{ name: 'p', provider: 'openai-compatible', model: 'm', baseUrl: 'http://h/v1' }]),
      secrets: keychain(),
      fetchImpl: net.fetchImpl,
    });

    await gateway.generateText({
      messages: [
        { role: 'user', content: 'first' },
        { role: 'system', content: 'change of instruction' },
        { role: 'assistant', content: 'noted' },
        { role: 'user', content: 'second' },
      ],
    });

    expect(net.single().body.messages).toEqual([
      { role: 'user', content: 'first' },
      { role: 'system', content: 'change of instruction' },
      { role: 'assistant', content: 'noted' },
      { role: 'user', content: 'second' },
    ]);
  });

  it('gives a probe its own output budget, overriding the profile', async () => {
    const net = alwaysRespond(() => anthropicMessage('ok'));
    const gateway = createAiGateway({
      config: configOf([{ name: 'cloud', provider: 'anthropic', model: 'claude-opus-5', apiKeyRef: 'ai.key', maxOutputTokens: 4096 }]),
      secrets: KEYS,
      fetchImpl: net.fetchImpl,
    });

    await gateway.generateText({ prompt: 'x' });
    await gateway.probe('cloud');

    expect(net.calls[0]?.body.max_tokens).toBe(4096);
    expect(net.calls[1]?.body.max_tokens).toBe(16);
  });
});

describe('generateObject', () => {
  it('asks for structured output and narrows what comes back into a wire Value', async () => {
    const net = endpoint('{"room":"R1","seats":4,"tags":["a",null],"nested":{"deep":true}}');
    const gateway = createAiGateway({
      config: configOf([{ name: 'p', provider: 'openai-compatible', model: 'm', baseUrl: 'http://h/v1' }]),
      secrets: keychain(),
      fetchImpl: net.fetchImpl,
    });

    const result = await gateway.generateObject({ prompt: 'x', schema: OBJECT_SCHEMA });

    // A bare `json_object`, with the schema NOWHERE in the request: an
    // arbitrary compatible endpoint is not assumed to implement OpenAI's
    // structured outputs, so `@ai-sdk/openai-compatible` degrades to JSON mode
    // and warns. That is the correct conservative default here and the exact
    // reason `openai` and `google` are first-class entries on their own
    // packages rather than base-URL variants of this one — see the schema
    // cases below, which pin what those two send instead.
    expect(net.single().body.response_format).toEqual({ type: 'json_object' });
    expect(net.single().rawBody).not.toContain('seats');
    expect(result.object).toEqual({ room: 'R1', seats: 4, tags: ['a', null], nested: { deep: true } });
    // §5.2 says a wire value is JSON plus AssetRef; `asJsonValue` narrows
    // structurally rather than asserting with a cast, so this must survive IPC.
    expect(structuredClone(result.object)).toEqual(result.object);
  });

  /**
   * The schema has to actually reach the provider.
   *
   * This is the regression suite for a real defect: OpenAI and Gemini were
   * reachable only as `openai-compatible` base URLs, and on that path the
   * caller's JSON Schema was dropped in favour of `{"type":"json_object"}`
   * (pinned above) — so `ai.generate_object` against a user's own OpenAI or
   * Gemini key returned free-form JSON that satisfied no schema, and the node
   * checked only that it was an object. Each case below asserts the schema in
   * the provider's own dialect, because "we passed it to the SDK" is not the
   * claim worth testing; "it is in the bytes" is.
   */
  it('sends the schema to OpenAI in its Responses dialect, with strict off', async () => {
    const net = alwaysRespond(() => openAiResponse('{"room":"R1","seats":4}'));
    const gateway = createAiGateway({
      config: configOf([{ name: 'p', provider: 'openai', model: 'gpt-4o', apiKeyRef: 'ai.key' }]),
      secrets: KEYS,
      fetchImpl: net.fetchImpl,
    });

    const result = await gateway.generateObject({ prompt: 'x', schema: OBJECT_SCHEMA });

    const format = (net.single().body.text as { format: Record<string, unknown> }).format;
    expect(format.type).toBe('json_schema');
    expect(format.schema).toEqual(OBJECT_SCHEMA);
    // Strict mode demands `additionalProperties: false` on every object and
    // every property in `required`; manifest schemas are hand-written and
    // satisfy neither, so strict on would 400 the first call a user made with
    // their own key. See `objectOptions` in gateway.ts.
    expect(format.strict).toBe(false);
    expect(result.object).toEqual({ room: 'R1', seats: 4 });
  });

  it('sends the schema to Gemini as generationConfig.responseSchema', async () => {
    const net = alwaysRespond(() => googleContent('{"room":"R1","seats":4}'));
    const gateway = createAiGateway({
      config: configOf([{ name: 'p', provider: 'google', model: 'gemini-2.5-pro', apiKeyRef: 'ai.key' }]),
      secrets: KEYS,
      fetchImpl: net.fetchImpl,
    });

    const result = await gateway.generateObject({ prompt: 'x', schema: OBJECT_SCHEMA });

    const config = net.single().body.generationConfig as Record<string, unknown>;
    expect(config.responseMimeType).toBe('application/json');
    expect(config.responseSchema).toEqual(OBJECT_SCHEMA);
    expect(result.object).toEqual({ room: 'R1', seats: 4 });
  });

  it('sends the schema to Anthropic as output_config.format', async () => {
    const net = alwaysRespond(() => anthropicMessage('{"room":"R1"}'));
    const gateway = createAiGateway({
      config: configOf([{ name: 'p', provider: 'anthropic', model: 'claude-opus-5', apiKeyRef: 'ai.key' }]),
      secrets: KEYS,
      fetchImpl: net.fetchImpl,
    });

    await gateway.generateObject({ prompt: 'x', schema: OBJECT_SCHEMA });

    const format = (net.single().body.output_config as { format: Record<string, unknown> }).format;
    expect(format.type).toBe('json_schema');
    // The SDK adds `additionalProperties: false` itself here, so this asserts
    // the caller's own keys survived rather than deep-equality with the input.
    expect(format.schema).toMatchObject({ properties: OBJECT_SCHEMA.properties, required: ['room'] });
  });
});

/**
 * The two hosted providers that are not Anthropic.
 *
 * They exist as first-class entries because routing them through
 * `openai-compatible` cost structured output (see the generateObject cases
 * above) — but the rest of what a first-class entry buys is here: the right
 * host, the right auth header, and a key that came from the keychain and
 * nowhere else.
 */
describe('OpenAI and Gemini as first-class providers', () => {
  it('sends an OpenAI profile to the Responses API with a bearer key', async () => {
    const net = alwaysRespond(() => openAiResponse('hello'));
    const gateway = createAiGateway({
      config: configOf([{ name: 'p', provider: 'openai', model: 'gpt-4o', apiKeyRef: 'ai.key' }]),
      secrets: KEYS,
      fetchImpl: net.fetchImpl,
    });

    const result = await gateway.generateText({ profile: 'p', prompt: 'x' });

    const call = net.single();
    expect(call.url).toBe('https://api.openai.com/v1/responses');
    expect(call.headers.authorization).toBe('Bearer sk-ant-real-value');
    expect(result.text).toBe('hello');
  });

  it('sends a Gemini profile to generateContent with the x-goog-api-key header', async () => {
    const net = alwaysRespond(() => googleContent('hello'));
    const gateway = createAiGateway({
      config: configOf([{ name: 'p', provider: 'google', model: 'gemini-2.5-pro', apiKeyRef: 'ai.key' }]),
      secrets: KEYS,
      fetchImpl: net.fetchImpl,
    });

    const result = await gateway.generateText({ profile: 'p', prompt: 'x' });

    const call = net.single();
    expect(call.url).toBe('https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-pro:generateContent');
    // Not a bearer token: Gemini authenticates on its own header, which is
    // precisely the kind of per-vendor fact a shared "compatible" path gets
    // wrong.
    expect(call.headers['x-goog-api-key']).toBe('sk-ant-real-value');
    expect(call.headers.authorization).toBeUndefined();
    expect(result.text).toBe('hello');
  });

  it('lets either be pointed at a proxy the user runs', async () => {
    for (const [provider, model, respond, expected] of [
      ['openai', 'gpt-4o', openAiResponse, 'https://proxy.internal/v1/responses'],
      ['google', 'gemini-2.5-pro', googleContent, 'https://proxy.internal/v1/models/gemini-2.5-pro:generateContent'],
    ] as const) {
      const net = alwaysRespond(() => respond('hello'));
      const gateway = createAiGateway({
        config: configOf([
          { name: 'p', provider, model, apiKeyRef: 'ai.key', baseUrl: 'https://proxy.internal/v1' },
        ]),
        secrets: KEYS,
        fetchImpl: net.fetchImpl,
      });

      await gateway.generateText({ profile: 'p', prompt: 'x' });
      expect(net.single().url).toBe(expected);
    }
  });

  it('embeds through both of Gemini\'s two endpoints, and through OpenAI\'s one', async () => {
    const openai = alwaysRespond(() => embeddingList([[0.1, 0.2]]));
    const openaiGateway = createAiGateway({
      config: configOf([
        { name: 'p', provider: 'openai', model: 'gpt-4o', apiKeyRef: 'ai.key', embeddingModel: 'text-embedding-3-small' },
      ]),
      secrets: KEYS,
      fetchImpl: openai.fetchImpl,
    });
    expect(await openaiGateway.embed({ values: ['a'] })).toEqual({ embeddings: [[0.1, 0.2]] });
    expect(openai.single().url).toBe('https://api.openai.com/v1/embeddings');

    // Google splits on batch size — one value goes to :embedContent and reads
    // back a different shape than :batchEmbedContents. Both are exercised
    // because a fixture serving one of them passes half the integration.
    const batches: { values: string[]; vectors: number[][]; endpoint: string }[] = [
      { values: ['a'], vectors: [[0.3, 0.4]], endpoint: ':embedContent' },
      { values: ['a', 'b'], vectors: [[0.3, 0.4], [0.5, 0.6]], endpoint: ':batchEmbedContents' },
    ];
    for (const { values, vectors, endpoint } of batches) {
      const net = recordFetch(googleEmbedding(vectors));
      const gateway = createAiGateway({
        config: configOf([
          { name: 'p', provider: 'google', model: 'gemini-2.5-pro', apiKeyRef: 'ai.key', embeddingModel: 'text-embedding-004' },
        ]),
        secrets: KEYS,
        fetchImpl: net.fetchImpl,
      });

      expect(await gateway.embed({ values })).toEqual({ embeddings: vectors });
      expect(net.single().url.endsWith(endpoint)).toBe(true);
    }
  });
});

describe('embeddings', () => {
  const embedding = configOf([
    { name: 'p', provider: 'openai-compatible', model: 'm', baseUrl: 'http://h/v1', embeddingModel: 'text-embed' },
  ]);

  it('posts the values to the endpoint the profile names', async () => {
    const net = endpoint();
    const gateway = createAiGateway({ config: embedding, secrets: keychain(), fetchImpl: net.fetchImpl });

    const result = await gateway.embed({ values: ['alpha', 'beta'] });

    const call = net.single();
    expect(call.url).toBe('http://h/v1/embeddings');
    expect(call.body).toMatchObject({ model: 'text-embed', input: ['alpha', 'beta'] });
    expect(result.embeddings).toEqual([[0.1, 0.2, 0.3]]);
  });

  it('opens no connection when there is nothing to embed', async () => {
    const gateway = createAiGateway({ config: embedding, secrets: keychain(), fetchImpl: NEVER_FETCH });
    await expect(gateway.embed({ values: [] })).resolves.toEqual({ embeddings: [] });
  });

  it('refuses a provider with no embeddings endpoint before building a request', async () => {
    // Caught here rather than at the SDK: `@ai-sdk/anthropic` types
    // `textEmbeddingModel` as `never` and throws when called, so this would
    // otherwise land mid-run as a provider crash instead of a binding error.
    const gateway = createAiGateway({
      config: configOf([{ name: 'cloud', provider: 'anthropic', model: 'claude-opus-5', apiKeyRef: 'ai.key' }]),
      secrets: KEYS,
      fetchImpl: NEVER_FETCH,
    });

    const failure = await gateway.embed({ values: ['x'] }).catch((err: unknown) => err);

    expect(failure).toBeInstanceOf(AiProfileError);
    expect((failure as AiProfileError).reason).toBe('invalid');
    expect((failure as Error).message).toContain('which has no embeddings endpoint');
    expect((failure as Error).message).toContain('Settings → AI model profiles');
  });

  it('refuses an embedding-capable provider that names no embedding model', async () => {
    const gateway = createAiGateway({
      config: configOf([{ name: 'p', provider: 'openai-compatible', model: 'm', baseUrl: 'http://h/v1' }]),
      secrets: keychain(),
      fetchImpl: NEVER_FETCH,
    });

    const failure = await gateway.embed({ values: ['x'] }).catch((err: unknown) => err);

    expect(failure).toBeInstanceOf(AiProfileError);
    expect((failure as AiProfileError).reason).toBe('invalid');
    expect((failure as Error).message).toContain('names no embedding model');
  });
});

describe('the SDK never retries — the engine owns that (§7.5)', () => {
  const failing = () =>
    recordFetch(() => openAiFailure(503, 'the model is overloaded'));
  const config = configOf([
    { name: 'p', provider: 'openai-compatible', model: 'm', baseUrl: 'http://h/v1', embeddingModel: 'text-embed' },
  ]);

  it('makes exactly one request per generateText call', async () => {
    const net = failing();
    const gateway = createAiGateway({ config, secrets: keychain(), fetchImpl: net.fetchImpl });

    await expect(gateway.generateText({ prompt: 'x' })).rejects.toThrow();

    // The SDK default is 2 retries. Three requests here would mean the engine's
    // documented backoff schedule is running on top of a hidden one.
    expect(net.calls).toHaveLength(1);
  });

  it('makes exactly one request per generateObject call', async () => {
    const net = failing();
    const gateway = createAiGateway({ config, secrets: keychain(), fetchImpl: net.fetchImpl });

    await expect(gateway.generateObject({ prompt: 'x', schema: OBJECT_SCHEMA })).rejects.toThrow();

    expect(net.calls).toHaveLength(1);
  });

  it('makes exactly one request per embed call', async () => {
    const net = failing();
    const gateway = createAiGateway({ config, secrets: keychain(), fetchImpl: net.fetchImpl });

    await expect(gateway.embed({ values: ['x'] })).rejects.toThrow();

    expect(net.calls).toHaveLength(1);
  });

  it('does not retry a probe either', async () => {
    const net = failing();
    const gateway = createAiGateway({ config, secrets: keychain(), fetchImpl: net.fetchImpl });

    expect((await gateway.probe('p')).ok).toBe(false);

    expect(net.calls).toHaveLength(1);
  });
});

describe('cancellation', () => {
  it('does not send a request for a run that was already cancelled', async () => {
    // Counted, not caught. Every entry point rejects either way — a gateway
    // that dialled the provider and only then noticed the signal would still
    // reject — so `rejects.toThrow()` on its own asserts nothing about the
    // thing this test is named after. The recorder is what turns "did not
    // send" into an observation, and the error's identity is what says the
    // rejection came from the engine's signal rather than from the wire.
    const net = recordFetch(() => chatCompletion('nobody should have asked'));
    const gateway = createAiGateway({
      config: configOf([{ name: 'p', provider: 'openai-compatible', model: 'm', baseUrl: 'http://h/v1', embeddingModel: 'e' }]),
      secrets: keychain(),
      fetchImpl: net.fetchImpl,
    });
    const controller = new AbortController();
    controller.abort();

    const calls = [
      () => gateway.generateText({ prompt: 'x', signal: controller.signal }),
      () => gateway.generateObject({ prompt: 'x', schema: OBJECT_SCHEMA, signal: controller.signal }),
      () => gateway.embed({ values: ['x'], signal: controller.signal }),
    ];
    for (const call of calls) {
      const failure = (await call().then(() => null, (err: unknown) => err)) as Error;
      expect(failure.name).toBe('AbortError');
      expect(failure).not.toBeInstanceOf(AiProviderError);
    }

    expect(net.calls).toEqual([]);
  });
});
