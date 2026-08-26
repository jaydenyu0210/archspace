/**
 * Shared seams for the ai-gateway suites.
 *
 * ADR-0013 §6 puts live provider calls out of bounds in every blocking lane, so
 * nothing here opens a socket. Two seams stand in for the world:
 *
 *  * `NEVER_FETCH` is the assertion "no transport was reached", written as a
 *    value rather than as a spy. Handing it to a gateway turns any stray
 *    request into a thrown error at the line that made it, which is what the
 *    `mock` provider's and `listProfiles()`'s no-I/O promises need in order to
 *    be provable rather than merely stated.
 *  * `recordFetch` is the opposite: it lets a suite drive the *real* AI SDK
 *    provider code — URL construction, auth headers, request shaping, error
 *    mapping, embeddings — and then read back exactly what would have gone on
 *    the wire. The response builders below are the smallest bodies the
 *    `@ai-sdk/anthropic` and `@ai-sdk/openai-compatible` parsers accept, kept
 *    here so a suite reads as intent rather than as provider wire format.
 *
 * `keychain` is the third seam: `SecretResolver` is the only way a credential
 * enters this package (ARCHITECTURE §6.1, §11), and it records its reads so a
 * test can assert *when* the gateway resolves a key, not only that it did.
 */
import type { AiGatewayConfig, ModelProfile } from '../src/config.js';
import type { SecretResolver } from '../src/status.js';

// ---------------------------------------------------------------------------
// Transport seams
// ---------------------------------------------------------------------------

/** A `fetchImpl` whose only behaviour is to fail the test that reached it. */
export const NEVER_FETCH: typeof fetch = (input) => {
  throw new Error(`the gateway reached the transport: ${urlOf(input)}`);
};

export interface RecordedCall {
  url: string;
  method: string;
  /** Lower-cased header names, as `Headers` normalises them. */
  headers: Record<string, string>;
  body: Record<string, unknown>;
  /** The unparsed request body, for leak assertions over the raw bytes. */
  rawBody: string;
}

export interface FetchRecorder {
  fetchImpl: typeof fetch;
  calls: RecordedCall[];
  urls(): string[];
  /** The single recorded call, or a failure naming how many there really were.
   *  Named `single` rather than `only` so it cannot be mistaken, by a reader or
   *  a grep, for vitest's banned `.only`. */
  single(): RecordedCall;
}

function urlOf(input: Request | URL | string): string {
  if (typeof input === 'string') return input;
  return input instanceof URL ? input.href : input.url;
}

/**
 * Record every request and answer it with `respond`. The handler sees the call
 * it is answering, so a suite can serve `/chat/completions` and `/embeddings`
 * differently without a second recorder.
 */
export function recordFetch(respond: (call: RecordedCall) => Response): FetchRecorder {
  const calls: RecordedCall[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((value, key) => {
      headers[key] = value;
    });
    const rawBody = typeof init?.body === 'string' ? init.body : '';
    const call: RecordedCall = {
      url: urlOf(input),
      method: init?.method ?? 'GET',
      headers,
      body: rawBody === '' ? {} : (JSON.parse(rawBody) as Record<string, unknown>),
      rawBody,
    };
    calls.push(call);
    return respond(call);
  };
  return {
    fetchImpl,
    calls,
    urls: () => calls.map((c) => c.url),
    single: () => {
      if (calls.length !== 1) throw new Error(`expected exactly one request, saw ${calls.length}`);
      return calls[0];
    },
  };
}

/** Answer every request with the same response, whatever it asked for. */
export function alwaysRespond(make: () => Response): FetchRecorder {
  return recordFetch(() => make());
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

/** The shape `@ai-sdk/anthropic` parses out of `POST /messages`. */
export function anthropicMessage(text: string): Response {
  return json(200, {
    id: 'msg_fixture',
    type: 'message',
    role: 'assistant',
    model: 'claude-fixture',
    content: [{ type: 'text', text }],
    stop_reason: 'end_turn',
    stop_sequence: null,
    usage: { input_tokens: 1, output_tokens: 1 },
  });
}

/** An Anthropic-shaped failure body. The message is the provider's own words. */
export function anthropicFailure(status: number, message: string): Response {
  return json(status, { type: 'error', error: { type: 'api_error', message } });
}

/** The shape `@ai-sdk/openai-compatible` parses out of `POST /chat/completions`. */
export function chatCompletion(content: string): Response {
  return json(200, {
    id: 'chatcmpl-fixture',
    object: 'chat.completion',
    created: 0,
    model: 'fixture',
    choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  });
}

/** The shape `@ai-sdk/openai-compatible` parses out of `POST /embeddings`. */
export function embeddingList(vectors: number[][]): Response {
  return json(200, {
    object: 'list',
    data: vectors.map((embedding, index) => ({ object: 'embedding', index, embedding })),
    model: 'fixture',
    usage: { prompt_tokens: 1, total_tokens: 1 },
  });
}

/** An OpenAI-shaped failure body. */
export function openAiFailure(status: number, message: string): Response {
  return json(status, { error: { message, type: 'invalid_request_error', code: null } });
}

// ---------------------------------------------------------------------------
// Keychain seam
// ---------------------------------------------------------------------------

export interface RecordingKeychain extends SecretResolver {
  /** Every key the gateway asked for, in order. */
  reads: string[];
}

export function keychain(entries: Record<string, string | undefined> = {}): RecordingKeychain {
  const reads: string[] = [];
  return {
    reads,
    async get(key) {
      reads.push(key);
      return entries[key];
    },
  };
}

/** A keychain the OS has not unlocked. Rejecting is a real state, not a bug. */
export function lockedKeychain(message = 'the keychain is locked'): RecordingKeychain {
  const reads: string[] = [];
  return {
    reads,
    async get(key) {
      reads.push(key);
      throw new Error(message);
    },
  };
}

// ---------------------------------------------------------------------------
// Config fixtures
// ---------------------------------------------------------------------------

export function configOf(profiles: ModelProfile[], defaultProfile?: string): AiGatewayConfig {
  return { profiles, defaultProfile: defaultProfile ?? (profiles[0]?.name ?? '') };
}

/** An offline profile: the only kind that can run with `NEVER_FETCH` in place. */
export function mockProfile(name = 'offline', model = 'mock-small'): ModelProfile {
  return { name, provider: 'mock', model };
}
