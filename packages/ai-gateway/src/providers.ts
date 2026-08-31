/**
 * The provider catalogue: the settings UI's source of truth for what an AI
 * model profile can be bound to (ARCHITECTURE §10 / ADR-0010).
 *
 * Two rules shape this table. First, **no provider is privileged** — the cloud
 * entry and the local entry are peers, and the list carries no hosted router at
 * all, because a middleman in the data path is not something an offline-capable
 * app gets to choose for its users. Second, the catalogue is *data*: it says
 * what a provider needs (a key, an endpoint) so the UI can render a form and
 * `validateAiConfig` can check a binding without ever constructing a client.
 *
 * `ollama` and `openai-compatible` are deliberately the same code path — Ollama
 * is just an OpenAI-compatible endpoint we happen to know the default URL of.
 * Keeping them separate entries is a UX affordance (a local Ollama needs zero
 * configuration), not a second integration to maintain.
 *
 * `openai` and `google`, by contrast, are NOT that. Both were reachable through
 * `openai-compatible` before they had entries here, and that route quietly cost
 * the thing they are most wanted for: `createOpenAICompatible` defaults
 * `supportsStructuredOutputs` to false, so `generateObject`'s JSON Schema was
 * downgraded to a bare `response_format: {type:'json_object'}` — free-form JSON,
 * schema discarded, with a warning nothing surfaced. A user's own OpenAI or
 * Gemini key would then produce objects that satisfied no schema at all. They
 * are first-class entries on their own SDK packages for the same reason
 * `anthropic` is: only the real provider integration knows its own structured
 * output, its own auth header, and its own embeddings endpoint.
 *
 * `suggestedModels` is a set of buttons that fill a free-text field, not a menu
 * that constrains it. Model line-ups move faster than releases do, so a stale
 * suggestion costs a click and never blocks a model the list has not heard of.
 *
 * **The FIRST entry is the default**, and is deliberately the cheapest tier
 * each vendor offers rather than the best. It is what a provider is bound to
 * before anyone chooses, so it is what an experiment costs — and someone
 * trying the app should not discover its price by accident. The stronger
 * models are one click away in the same list.
 *
 * `docsUrl` is an upstream documentation URL for every real provider; the
 * `mock` provider has no upstream, so it points at this repository's own ADR.
 */

export type ProviderId = 'anthropic' | 'openai' | 'google' | 'ollama' | 'openai-compatible' | 'mock';
export type ProviderKind = 'cloud' | 'local' | 'test';

export interface ProviderDescriptor {
  id: ProviderId;
  label: string;
  kind: ProviderKind;
  /** True when the provider needs an API key from the keychain. */
  needsApiKey: boolean;
  /** True when the user supplies the endpoint (local/self-hosted). */
  needsBaseUrl: boolean;
  defaultBaseUrl?: string;
  suggestedModels: string[];
  suggestedEmbeddingModels?: string[];
  docsUrl: string;
  /** One sentence for the settings UI. */
  summary: string;
}

export const PROVIDERS: readonly ProviderDescriptor[] = [
  {
    id: 'anthropic',
    label: 'Anthropic',
    kind: 'cloud',
    needsApiKey: true,
    needsBaseUrl: false,
    defaultBaseUrl: 'https://api.anthropic.com/v1',
    suggestedModels: ['claude-haiku-4-5', 'claude-sonnet-5', 'claude-opus-5'],
    // Anthropic ships no embeddings endpoint, so a profile bound here cannot
    // serve ctx.ai.embed — validateAiConfig warns rather than letting the
    // failure surface mid-run.
    docsUrl: 'https://docs.anthropic.com/en/api/overview',
    summary: 'Claude models over the hosted Anthropic API. Needs an API key stored in the keychain.',
  },
  {
    id: 'openai',
    label: 'OpenAI',
    kind: 'cloud',
    needsApiKey: true,
    needsBaseUrl: false,
    defaultBaseUrl: 'https://api.openai.com/v1',
    // Cheapest first, and `nano` really is cheaper than `mini` — roughly
    // $0.10 against $0.15 per million input tokens. `o3-mini` is a reasoning
    // model and costs multiples of either, so it is not on this ladder: the
    // list is "cheap, then capable", not every id the vendor sells.
    suggestedModels: ['gpt-4.1-nano', 'gpt-4.1-mini', 'gpt-4o'],
    suggestedEmbeddingModels: ['text-embedding-3-small', 'text-embedding-3-large'],
    docsUrl: 'https://platform.openai.com/docs/api-reference/chat',
    summary: 'GPT models over the hosted OpenAI API. Needs an API key stored in the keychain.',
  },
  {
    id: 'google',
    label: 'Google Gemini',
    kind: 'cloud',
    needsApiKey: true,
    needsBaseUrl: false,
    // The SDK's own prefix. Google also ships an OpenAI-compatible shim at
    // `/v1beta/openai`, which is what this provider existed as before it had an
    // entry — the native path is here because the shim does not carry a JSON
    // Schema through `generateObject`.
    defaultBaseUrl: 'https://generativelanguage.googleapis.com/v1beta',
    // `gemini-2.5-flash` shipped here and was already retired: Google answered
    // a probe with "This model models/gemini-2.5-flash is no longer available
    // to new users. Please update your code to use models/gemini-3.6-flash".
    // That is the whole argument for these being buttons over a free-text
    // field rather than a menu — a retired id costs one edit, not a dead end —
    // and for the first entry mattering most, since a one-click bind writes it.
    // Only what the provider itself named is listed; guessing a sibling would
    // reproduce exactly the failure this replaces.
    suggestedModels: ['gemini-3.6-flash'],
    suggestedEmbeddingModels: ['text-embedding-004', 'gemini-embedding-001'],
    docsUrl: 'https://ai.google.dev/gemini-api/docs',
    summary: 'Gemini models over the hosted Google AI API. Needs an API key stored in the keychain.',
  },
  {
    id: 'ollama',
    label: 'Ollama (local)',
    kind: 'local',
    needsApiKey: false,
    needsBaseUrl: false,
    // Ollama's OpenAI-compatible surface: /v1/chat/completions and /v1/embeddings.
    defaultBaseUrl: 'http://localhost:11434/v1',
    suggestedModels: ['llama3.1', 'qwen2.5', 'mistral'],
    suggestedEmbeddingModels: ['nomic-embed-text', 'mxbai-embed-large'],
    docsUrl: 'https://github.com/ollama/ollama/blob/main/docs/openai.md',
    summary: 'Models running on this machine through Ollama. No key, no network egress.',
  },
  {
    id: 'openai-compatible',
    label: 'OpenAI-compatible endpoint',
    kind: 'local',
    needsApiKey: false,
    needsBaseUrl: true,
    // No suggested models: only the endpoint knows what it serves, and inventing
    // a list here would be a guess presented as a fact.
    suggestedModels: [],
    docsUrl: 'https://ai-sdk.dev/providers/openai-compatible-providers',
    summary: 'Any endpoint speaking the OpenAI API — LM Studio, vLLM, a self-hosted router.',
  },
  {
    id: 'mock',
    label: 'Mock (offline)',
    kind: 'test',
    needsApiKey: false,
    needsBaseUrl: false,
    suggestedModels: ['mock-small'],
    docsUrl: 'docs/adr/0010-ai-provider-abstraction.md',
    summary: 'Deterministic scripted responses for CI and offline demos. Never a default.',
  },
];

export function providerById(id: string): ProviderDescriptor | undefined {
  return PROVIDERS.find((p) => p.id === id);
}

/**
 * Can this provider serve `ctx.ai.embed`?
 *
 * An exhaustive switch on `ProviderId`, never a read of
 * `suggestedEmbeddingModels`. That field is a UI suggestion list, and an
 * arbitrary OpenAI-compatible endpoint legitimately serves `/v1/embeddings`
 * while we cannot suggest a single model id for whatever the user is running —
 * so "no suggestions" and "no embeddings" are different facts. Deriving one
 * from the other told users on the self-hosted path that a correct profile
 * would fail, which is the worst direction for a warning to be wrong in.
 *
 * It lives here rather than in either caller because it had been answered
 * twice, differently: the gateway switched on the provider and the config
 * validator read the catalogue field, so the validator warned about profiles
 * the gateway went on to serve. One authority is the fix; the switch breaking
 * at compile time when a provider is added is the reason it stays a switch.
 */
export function providerHasEmbeddings(provider: ProviderId): boolean {
  switch (provider) {
    case 'anthropic':
      return false;
    case 'openai':
    case 'google':
    case 'ollama':
    case 'openai-compatible':
    case 'mock':
      return true;
  }
}
