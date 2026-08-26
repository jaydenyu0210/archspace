/**
 * @archspace/ai-gateway — named model profiles over the AI SDK's provider
 * layer, and the only implementation of `ctx.ai` (ARCHITECTURE §10 / ADR-0010).
 *
 * The surface is grouped by who imports it rather than alphabetised, because
 * the three callers want disjoint thirds and the grouping is the documentation:
 *
 *  - the **engine host** (`packages/app/src/engine-child`, `packages/cli`)
 *    wants `createAiGateway` and nothing else — it builds one gateway per
 *    process and calls `reconfigure()` on settings changes (gateway.ts says
 *    why that beats rebuilding);
 *  - the **settings layer** (Electron main, the CLI's config loader) wants only
 *    the `ai.yaml` codec and the profile/provider vocabulary. It must never
 *    pull a provider client into the main process, which is why the codec is
 *    free of any SDK import and can be loaded on its own;
 *  - the **renderer**, across IPC, wants the value types (`ProfileStatus`,
 *    `ProfileProbeResult`, `PROVIDERS`) so the settings panel can render a
 *    profile list and a probe result without knowing what a provider is.
 *
 * Two modules are deliberately *not* re-exported:
 *
 *  - `yaml-lite` is an implementation detail of the codec. Publishing a second
 *    YAML parser next to the document package's would invite callers to pick
 *    the wrong one for workflow files, and the subset it accepts is tuned to
 *    `ai.yaml` specifically — it is not a general parser and should not look
 *    like one.
 *  - `schema` adapts our `JsonSchemaObject` to the AI SDK's `Schema<unknown>`.
 *    Exporting it would leak an `ai` package type into our public surface and
 *    make every consumer of this barrel a transitive consumer of the SDK's
 *    types — precisely the coupling ADR-0010 uses this package to prevent.
 *
 * The `mock` provider's synthesisers *are* exported, because ADR-0013 makes
 * them load-bearing outside this package: the node testkit and golden-file
 * tests need the same deterministic answers the gateway would give, without
 * standing a gateway up.
 */

// The gateway itself: what `ctx.ai` is, for the two processes that host nodes.
export { createAiGateway, probeReadiness } from './gateway.js';
export type { AiGatewayOptions } from './gateway.js';
export type {
  ArchspaceAiGateway,
  ProfileProbeResult,
  ProfileReadiness,
  ProfileStatus,
  SecretResolver,
} from './status.js';

// ai.yaml: logical profile name → provider + model. The split that keeps a
// workflow shareable — a document names a profile, never a vendor or a key.
export {
  AI_CONFIG_FILENAME,
  defaultAiConfig,
  parseAiConfig,
  serializeAiConfig,
  validateAiConfig,
} from './config.js';
export type { AiGatewayConfig, ConfigIssue, ModelProfile } from './config.js';

// The provider catalogue the settings UI renders from, so "which providers
// exist" is answered by data in one file rather than by a switch in the view.
export { PROVIDERS, providerById } from './providers.js';
export type { ProviderDescriptor, ProviderId, ProviderKind } from './providers.js';

// One place decides what a failure means, so the engine's retry policy (§7.5)
// acts on a flag rather than on a guess about a provider's error text.
export { AiProfileError, AiProviderError, BIND_HINT, missingKeyError, unknownProfileError } from './errors.js';
export type { AiProfileErrorReason } from './errors.js';

// The offline provider (ADR-0013 §6). Deterministic, never touches the network.
export { mockEmbeddings, mockObject, mockText } from './mock.js';
export type { MockPrompt } from './mock.js';
