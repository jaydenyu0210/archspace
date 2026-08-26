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
 * `docsUrl` is an upstream documentation URL for every real provider; the
 * `mock` provider has no upstream, so it points at this repository's own ADR.
 */

export type ProviderId = 'anthropic' | 'ollama' | 'openai-compatible' | 'mock';
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
    suggestedModels: ['claude-opus-5', 'claude-sonnet-5', 'claude-haiku-4-5'],
    // Anthropic ships no embeddings endpoint, so a profile bound here cannot
    // serve ctx.ai.embed — validateAiConfig warns rather than letting the
    // failure surface mid-run.
    docsUrl: 'https://docs.anthropic.com/en/api/overview',
    summary: 'Claude models over the hosted Anthropic API. Needs an API key stored in the keychain.',
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
