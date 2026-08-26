/**
 * `createAiGateway` — the only implementation of `ctx.ai` (ARCHITECTURE §10 /
 * ADR-0010).
 *
 * ADR-0010 decides *what* this is: our own three-method interface over the
 * Vercel AI SDK's provider layer, used as a library and never as a routed
 * service. Everything below is the *how*, and each piece exists to keep one of
 * that ADR's promises honest:
 *
 *  * **Profiles resolve per call, not at construction.** `engine-child` builds
 *    one gateway for the life of the process and calls `reconfigure()` whenever
 *    settings change (§3.3), so a binding captured in a closure at startup
 *    would be a stale binding forever. `resolveProfile` therefore reads the
 *    current config on every request. Rebuilding the gateway on each settings
 *    change was the alternative; it would have meant handing a new object to
 *    every holder of `ctx.ai`, which is a lifetime problem in exchange for a
 *    map lookup.
 *  * **Provider clients are cached; readiness is not.** Constructing a client
 *    means a keychain round trip, so the client is memoized per profile name
 *    and the cache is dropped wholesale by `reconfigure()` — the same event
 *    that is allowed to change what a name means. A time-based TTL was
 *    rejected: nothing here expires on a clock, it expires on an edit.
 *  * **`maxRetries: 0` on every SDK call.** Retry and backoff belong to the
 *    engine (§7.5 / ADR-0007), which is the only layer that knows the node's
 *    policy and the run's cancellation state. Leaving the SDK's default of 2 in
 *    place would stack two backoff loops and make the engine's documented
 *    schedule a lie. We hand the engine a `retryable` flag instead and let it
 *    decide (see errors.ts).
 *  * **`listProfiles()` never touches the network** (status.ts says why). It
 *    reads the config and the keychain and stops there; `probe()` is the only
 *    method that does I/O to a provider, and the only one that may report
 *    `unreachable` or a `sample`.
 *  * **`probe()` never throws.** It backs a settings-panel button whose result
 *    crosses an IPC boundary as a value (`ai-probe-result`); an exception there
 *    is a dropped message, so every failure comes back as `{ ok: false, error }`.
 *
 * `fetchImpl` is the test seam. ADR-0013 forbids live provider calls in the
 * blocking lanes, and the `mock` provider covers everything except the code
 * paths that *are* the AI SDK — error mapping, base-URL binding, embeddings.
 * Injecting `fetch` reaches those without a network, and it is an option on
 * this factory rather than a module-level import so two gateways in one process
 * cannot fight over it.
 */
import { createAnthropic, type AnthropicProvider } from '@ai-sdk/anthropic';
import { createOpenAICompatible, type OpenAICompatibleProvider } from '@ai-sdk/openai-compatible';
import {
  APICallError,
  embedMany,
  generateObject as sdkGenerateObject,
  generateText as sdkGenerateText,
  type LanguageModel,
  type ModelMessage,
} from 'ai';
import type { ChatMessage } from '@archspace/node-sdk';
import type { AiGatewayConfig, ModelProfile } from './config.js';
import { AiProfileError, AiProviderError, BIND_HINT, missingKeyError, unknownProfileError } from './errors.js';
import { providerById, type ProviderDescriptor, type ProviderId } from './providers.js';
import { mockEmbeddings, mockObject, mockText, type MockPrompt } from './mock.js';
import { asJsonValue, toSdkSchema } from './schema.js';
import type {
  ArchspaceAiGateway,
  ProfileProbeResult,
  ProfileReadiness,
  ProfileStatus,
  SecretResolver,
} from './status.js';

export interface AiGatewayOptions {
  config: AiGatewayConfig;
  /** Keychain seam. A profile names a key; only this resolves it (§6.1, §11). */
  secrets: SecretResolver;
  /**
   * Transport seam for the AI SDK providers. Defaults to the SDK's own `fetch`.
   * Tests inject a fake to exercise the live-provider code paths offline
   * (ADR-0013 §6); the `mock` provider ignores it entirely because it never
   * reaches a transport at all.
   */
  fetchImpl?: typeof fetch;
}

/** A probe is a liveness check, not a generation. Keep it nearly free. */
const PROBE_SYSTEM = 'You are a connection probe. Answer with the single word: ok.';
const PROBE_PROMPT = 'ping';
const PROBE_MAX_OUTPUT_TOKENS = 16;

/** How much model output a probe result carries back to the settings panel. */
const SAMPLE_CHARS = 200;

/** The prompt half of a request, shared by generateText/generateObject/probe. */
interface TextPrompt extends MockPrompt {
  messages?: ChatMessage[];
}

/**
 * A constructed, key-bound provider client. `mock` is a member with no client
 * behind it: routing it through this union is what guarantees a mock profile
 * takes the same resolution and readiness path as a real one, and still cannot
 * reach a transport.
 */
type ProviderClient =
  | { kind: 'anthropic'; provider: AnthropicProvider }
  | { kind: 'openai-compatible'; provider: OpenAICompatibleProvider }
  | { kind: 'mock' };

/**
 * The statically-knowable state of a profile, plus the secret it resolved to.
 * One function answers both "what colour is this row in settings" and "may this
 * request proceed", so a green row and a failing run can never disagree.
 */
interface ProfileBinding {
  readiness: Exclude<ProfileReadiness, 'unreachable' | 'unknown'>;
  detail?: string;
  apiKey?: string;
}

export function createAiGateway(options: AiGatewayOptions): ArchspaceAiGateway {
  const { secrets, fetchImpl } = options;
  let config = options.config;
  const clients = new Map<string, ProviderClient>();

  // -------------------------------------------------------------------------
  // Profile resolution
  // -------------------------------------------------------------------------

  function resolveProfile(name: string | undefined): ModelProfile {
    if (name !== undefined) {
      const named = config.profiles.find((p) => p.name === name);
      if (named === undefined) throw unknownProfileError(name);
      return named;
    }
    const fallback = config.defaultProfile;
    const bound = fallback === '' ? undefined : config.profiles.find((p) => p.name === fallback);
    if (bound !== undefined) return bound;
    // Reached when a workflow names no profile and the machine has nothing
    // bound to fall back on — the case a colleague hits opening someone else's
    // document, so the message has to point at the fix rather than the cause.
    throw new AiProfileError(
      fallback === ''
        ? `This step did not name an AI model profile and no default profile is bound on this machine. Bind one in ${BIND_HINT}.`
        : `The default AI model profile "${fallback}" is not configured on this machine. Bind it in ${BIND_HINT}.`,
      fallback,
      'unknown',
    );
  }

  /**
   * `ProviderId` is exactly the catalogue's key set, so this cannot miss. The
   * throw is here so that adding an id without a descriptor fails loudly at the
   * first call instead of producing a profile with no capabilities.
   */
  function descriptorFor(provider: ProviderId): ProviderDescriptor {
    const descriptor = providerById(provider);
    if (descriptor === undefined) throw new Error(`provider "${provider}" is missing from the catalogue`);
    return descriptor;
  }

  /** Static readiness. Reads config and the keychain; never the network. */
  async function inspect(profile: ModelProfile): Promise<ProfileBinding> {
    const descriptor = descriptorFor(profile.provider);

    if (profile.model === '') {
      return { readiness: 'invalid', detail: 'no model id is set on this profile' };
    }
    const baseUrl = profile.baseUrl ?? descriptor.defaultBaseUrl;
    if (descriptor.needsBaseUrl && baseUrl === undefined) {
      return {
        readiness: 'invalid',
        detail: `provider "${descriptor.id}" has no default endpoint; set the server URL`,
      };
    }

    if (profile.apiKeyRef === undefined) {
      return descriptor.needsApiKey
        ? { readiness: 'missing-key', detail: `provider "${descriptor.id}" needs an API key and none is named` }
        : { readiness: 'ready' };
    }
    const apiKey = await secrets.get(profile.apiKeyRef);
    if (apiKey === undefined || apiKey === '') {
      // A named-but-unresolved key is 'missing-key' even for a provider that
      // does not require one: the user asked for authentication and did not get
      // it, and silently sending an anonymous request is the wrong repair.
      return { readiness: 'missing-key', detail: `the secret "${profile.apiKeyRef}" holds no value on this machine` };
    }
    return { readiness: 'ready', apiKey };
  }

  function bindingError(profile: ModelProfile, binding: ProfileBinding): AiProfileError {
    if (binding.readiness === 'missing-key') {
      return missingKeyError(profile.name, profile.apiKeyRef, profile.provider);
    }
    return new AiProfileError(
      `AI model profile "${profile.name}" is not usable: ${binding.detail ?? 'the binding is incomplete'}. Fix it in ${BIND_HINT}.`,
      profile.name,
      'invalid',
    );
  }

  async function clientFor(profile: ModelProfile): Promise<ProviderClient> {
    const cached = clients.get(profile.name);
    if (cached !== undefined) return cached;

    const binding = await inspect(profile);
    if (binding.readiness !== 'ready') throw bindingError(profile, binding);

    const created = createClient(profile, binding.apiKey);
    clients.set(profile.name, created);
    return created;
  }

  function createClient(profile: ModelProfile, apiKey: string | undefined): ProviderClient {
    const descriptor = descriptorFor(profile.provider);
    switch (profile.provider) {
      case 'mock':
        return { kind: 'mock' };

      case 'anthropic':
        return {
          kind: 'anthropic',
          provider: createAnthropic({
            // Always explicit, never the SDK's ANTHROPIC_API_KEY fallback: §11
            // says a credential reaches this process through the keychain seam
            // and nowhere else, and an ambient env var is exactly the leak that
            // makes "which key did that run use?" unanswerable.
            ...(apiKey !== undefined ? { apiKey } : {}),
            ...(profile.baseUrl !== undefined ? { baseURL: profile.baseUrl } : {}),
            ...(profile.headers !== undefined ? { headers: profile.headers } : {}),
            ...(fetchImpl !== undefined ? { fetch: fetchImpl } : {}),
          }),
        };

      // providers.ts is explicit that these are one integration: Ollama is an
      // OpenAI-compatible endpoint whose default URL we happen to know. Two
      // catalogue entries, one code path.
      case 'ollama':
      case 'openai-compatible': {
        const baseURL = profile.baseUrl ?? descriptor.defaultBaseUrl;
        if (baseURL === undefined) throw bindingError(profile, { readiness: 'invalid', detail: 'no endpoint URL is set' });
        return {
          kind: 'openai-compatible',
          provider: createOpenAICompatible<string, string, string, string>({
            name: descriptor.id,
            baseURL,
            ...(apiKey !== undefined ? { apiKey } : {}),
            ...(profile.headers !== undefined ? { headers: profile.headers } : {}),
            ...(fetchImpl !== undefined ? { fetch: fetchImpl } : {}),
          }),
        };
      }
    }
  }

  function languageModelOf(client: ProviderClient, profile: ModelProfile): LanguageModel {
    if (client.kind === 'mock') throw new Error('the mock provider has no language model');
    return client.provider(profile.model);
  }

  // -------------------------------------------------------------------------
  // Request shaping
  // -------------------------------------------------------------------------

  /**
   * ChatMessage is our own tiny role+text shape (node-sdk §5.2); the SDK wants
   * `ModelMessage`, whose content can be multi-part. The switch is written out
   * rather than cast because the role literals are what make each branch a
   * different SDK type.
   */
  function toModelMessage(message: ChatMessage): ModelMessage {
    switch (message.role) {
      case 'system':
        return { role: 'system', content: message.content };
      case 'assistant':
        return { role: 'assistant', content: message.content };
      default:
        return { role: 'user', content: message.content };
    }
  }

  /**
   * AI SDK 7 renamed `system` to `instructions` and, by default, refuses system
   * messages inside `messages`. We opt back in: a node that scripted a
   * conversation gets its own ordering rather than having its system turns
   * silently hoisted to the front.
   */
  function promptArgs(
    prompt: TextPrompt,
  ): { prompt: string; instructions?: string } | { messages: ModelMessage[]; instructions?: string; allowSystemInMessages: true } {
    const instructions = prompt.system !== undefined ? { instructions: prompt.system } : {};
    if (prompt.messages !== undefined && prompt.messages.length > 0) {
      return { messages: prompt.messages.map(toModelMessage), ...instructions, allowSystemInMessages: true };
    }
    if (prompt.prompt === undefined || prompt.prompt === '') {
      throw new Error('ctx.ai needs either a prompt or a non-empty messages list');
    }
    return { prompt: prompt.prompt, ...instructions };
  }

  function callSettings(profile: ModelProfile, maxOutputTokens: number | undefined): {
    temperature?: number;
    maxOutputTokens?: number;
    headers?: Record<string, string>;
    maxRetries: number;
  } {
    const budget = maxOutputTokens ?? profile.maxOutputTokens;
    return {
      ...(profile.temperature !== undefined ? { temperature: profile.temperature } : {}),
      ...(budget !== undefined ? { maxOutputTokens: budget } : {}),
      ...(profile.headers !== undefined ? { headers: profile.headers } : {}),
      maxRetries: 0, // the engine owns retry (§7.5); see the header note
    };
  }

  // -------------------------------------------------------------------------
  // Failure mapping
  // -------------------------------------------------------------------------

  /**
   * The retry table errors.ts documents. We compute it ourselves rather than
   * trusting the SDK's own `isRetryable`, because this flag is a contract with
   * the engine's backoff policy and it should change only when we change it.
   *
   * No status at all means the request never got an HTTP answer — DNS, a
   * refused connection, a dropped socket — which is the most retryable failure
   * there is: a local Ollama that has not finished starting looks exactly like
   * this.
   */
  function retryableStatus(status: number | undefined): boolean {
    if (status === undefined) return true;
    if (status === 408 || status === 429) return true;
    return status >= 500;
  }

  function messageOf(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
  }

  /** True for the shape Node and undici throw on an aborted or timed-out fetch. */
  function isAbortLike(err: unknown): boolean {
    return err instanceof Error && (err.name === 'AbortError' || err.name === 'TimeoutError');
  }

  function mapProviderError(err: unknown, profile: ModelProfile, signal: AbortSignal | undefined): unknown {
    // A profile problem we raised ourselves is already the right error.
    if (err instanceof AiProfileError || err instanceof AiProviderError) return err;
    // The caller cancelled: that is the engine's own signal coming back, not a
    // provider failure, and marking it retryable would have the engine retry a
    // run it just stopped.
    if (signal?.aborted === true) return err;

    const label = descriptorFor(profile.provider).label;
    if (APICallError.isInstance(err)) {
      const status = err.statusCode;
      return new AiProviderError(
        status === undefined
          ? `${label} did not answer for AI model profile "${profile.name}": ${err.message}`
          : `${label} returned HTTP ${status} for AI model profile "${profile.name}": ${err.message}`,
        {
          provider: profile.provider,
          ...(status !== undefined ? { status } : {}),
          retryable: retryableStatus(status),
          cause: err,
        },
      );
    }
    if (isAbortLike(err)) {
      // Aborted without our signal being aborted: a transport timeout.
      return new AiProviderError(`${label} timed out for AI model profile "${profile.name}"`, {
        provider: profile.provider,
        retryable: true,
        cause: err,
      });
    }
    return new AiProviderError(`${label} could not be reached for AI model profile "${profile.name}": ${messageOf(err)}`, {
      provider: profile.provider,
      retryable: true,
      cause: err,
    });
  }

  // -------------------------------------------------------------------------
  // The three calls
  // -------------------------------------------------------------------------

  async function textOf(
    profile: ModelProfile,
    prompt: TextPrompt,
    signal: AbortSignal | undefined,
    maxOutputTokens?: number,
  ): Promise<string> {
    signal?.throwIfAborted();
    const client = await clientFor(profile);
    if (client.kind === 'mock') return mockText(profile.model, prompt);
    try {
      const result = await sdkGenerateText({
        model: languageModelOf(client, profile),
        ...promptArgs(prompt),
        ...callSettings(profile, maxOutputTokens),
        ...(signal !== undefined ? { abortSignal: signal } : {}),
      });
      return result.text;
    } catch (err) {
      throw mapProviderError(err, profile, signal);
    }
  }

  /** Providers whose code path exposes an embeddings endpoint.
   *
   *  Written as an exhaustive switch on `ProviderId` rather than read off the
   *  catalogue's `suggestedEmbeddingModels`: that field is a UI suggestion list
   *  and an arbitrary OpenAI-compatible endpoint legitimately serves
   *  `/v1/embeddings` while we cannot suggest a single model id for it. Adding
   *  a provider breaks this switch at compile time, which is the point.
   */
  function hasEmbeddings(provider: ProviderId): boolean {
    switch (provider) {
      case 'anthropic':
        return false;
      case 'ollama':
      case 'openai-compatible':
      case 'mock':
        return true;
    }
  }

  const gateway: ArchspaceAiGateway = {
    async generateText(req) {
      const profile = resolveProfile(req.profile);
      return { text: await textOf(profile, req, req.signal) };
    },

    async generateObject(req) {
      const profile = resolveProfile(req.profile);
      req.signal?.throwIfAborted();
      const client = await clientFor(profile);
      if (client.kind === 'mock') return { object: mockObject(profile.model, req, req.schema) };
      try {
        const result = await sdkGenerateObject({
          model: languageModelOf(client, profile),
          schema: toSdkSchema(req.schema),
          ...promptArgs(req),
          ...callSettings(profile, undefined),
          ...(req.signal !== undefined ? { abortSignal: req.signal } : {}),
        });
        return { object: asJsonValue(result.object) };
      } catch (err) {
        throw mapProviderError(err, profile, req.signal);
      }
    },

    async embed(req) {
      const profile = resolveProfile(req.profile);
      req.signal?.throwIfAborted();
      // Nothing to embed is not a reason to open a connection.
      if (req.values.length === 0) return { embeddings: [] };

      if (!hasEmbeddings(profile.provider)) {
        // Caught here rather than at the SDK: `@ai-sdk/anthropic` types
        // `textEmbeddingModel` as returning `never` and throws when called, so
        // the failure would otherwise land mid-run as a provider crash instead
        // of a binding error the user can act on.
        throw new AiProfileError(
          `AI model profile "${profile.name}" is bound to ${descriptorFor(profile.provider).label}, which has no embeddings endpoint. Point this step at an embedding-capable profile in ${BIND_HINT}.`,
          profile.name,
          'invalid',
        );
      }

      const client = await clientFor(profile);
      if (client.kind === 'mock') return { embeddings: mockEmbeddings(profile.model, req.values) };
      if (profile.embeddingModel === undefined) {
        throw new AiProfileError(
          `AI model provided profile "${profile.name}" names no embedding model. Set one in ${BIND_HINT}.`,
          profile.name,
          'invalid',
        );
      }
      if (client.kind !== 'openai-compatible') {
        throw new Error(`provider "${profile.provider}" claims embeddings but has no embedding client`);
      }
      try {
        const result = await embedMany({
          model: client.provider.embeddingModel(profile.embeddingModel),
          values: [...req.values],
          maxRetries: 0,
          ...(profile.headers !== undefined ? { headers: profile.headers } : {}),
          ...(req.signal !== undefined ? { abortSignal: req.signal } : {}),
        });
        return { embeddings: result.embeddings.map((embedding) => [...embedding]) };
      } catch (err) {
        throw mapProviderError(err, profile, req.signal);
      }
    },

    reconfigure(next) {
      config = next;
      // The only invalidation point there is. A cached client holds a base URL
      // and a resolved key, both of which this edit is allowed to have changed.
      clients.clear();
    },

    async listProfiles() {
      // Deliberately no network and no client construction (status.ts). The
      // only await in here is the keychain.
      return Promise.all(
        config.profiles.map(async (profile): Promise<ProfileStatus> => {
          const descriptor = descriptorFor(profile.provider);
          const binding = await inspect(profile);
          return {
            name: profile.name,
            provider: profile.provider,
            providerKind: descriptor.kind,
            model: profile.model,
            isDefault: profile.name === config.defaultProfile,
            readiness: binding.readiness,
            ...(binding.detail !== undefined ? { detail: binding.detail } : {}),
            ...(profile.baseUrl !== undefined ? { baseUrl: profile.baseUrl } : {}),
            ...(profile.apiKeyRef !== undefined ? { apiKeyRef: profile.apiKeyRef } : {}),
          };
        }),
      );
    },

    async probe(profileName, signal) {
      const startedAt = Date.now();
      try {
        const profile = resolveProfile(profileName);
        const text = await textOf(
          profile,
          { system: PROBE_SYSTEM, prompt: PROBE_PROMPT },
          signal,
          PROBE_MAX_OUTPUT_TOKENS,
        );
        const sample = text.length <= SAMPLE_CHARS ? text : `${text.slice(0, SAMPLE_CHARS - 3)}...`;
        return { profile: profileName, ok: true, latencyMs: Date.now() - startedAt, sample };
      } catch (err) {
        // No latencyMs on failure: status.ts reserves it for a completed
        // round trip, and "it took 12ms to fail DNS" is not a latency.
        return { profile: profileName, ok: false, error: messageOf(err) };
      }
    },

    profileNames() {
      return config.profiles.map((profile) => profile.name);
    },
  };

  return gateway;
}

/**
 * A probe's only network-derived readiness value. Exported so a settings view
 * can fold a probe result back into the row it came from without re-deriving
 * the rule that `listProfiles()` is not allowed to produce it.
 */
export function probeReadiness(result: ProfileProbeResult): ProfileReadiness | undefined {
  return result.ok ? 'ready' : 'unreachable';
}
