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
  keychain,
  openAiFailure,
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

    expect(net.single().body.response_format).toEqual({ type: 'json_object' });
    expect(result.object).toEqual({ room: 'R1', seats: 4, tags: ['a', null], nested: { deep: true } });
    // §5.2 says a wire value is JSON plus AssetRef; `asJsonValue` narrows
    // structurally rather than asserting with a cast, so this must survive IPC.
    expect(structuredClone(result.object)).toEqual(result.object);
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
