/**
 * What the settings UI is allowed to say about a profile, and how sure it is.
 *
 * The split matters: `listProfiles()` makes **no network calls**, so it can
 * only report what is statically knowable — is the provider real, is the
 * endpoint set, does the named secret resolve. `ready` therefore means "fully
 * bound", not "reachable". Only `probe()` does real I/O, and it is the only
 * thing that may return `unreachable` or a `sample` of model output. Keeping
 * that line sharp is what stops a settings panel from quietly making a paid
 * API call every time it repaints.
 */
import type { AiGateway } from '@archspace/node-sdk';
import type { AiGatewayConfig } from './config.js';
import type { ProviderId, ProviderKind } from './providers.js';

export interface SecretResolver {
  get(key: string): Promise<string | undefined>;
}

export type ProfileReadiness = 'ready' | 'missing-key' | 'unreachable' | 'unknown' | 'invalid';

export interface ProfileStatus {
  name: string;
  provider: ProviderId;
  providerKind: ProviderKind;
  model: string;
  isDefault: boolean;
  readiness: ProfileReadiness;
  /** Human-readable reason when readiness is not 'ready'. */
  detail?: string;
  baseUrl?: string;
  apiKeyRef?: string;
}

export interface ProfileProbeResult {
  profile: string;
  ok: boolean;
  /** Round-trip latency of the probe call, when it completed. */
  latencyMs?: number;
  /** Text the model actually returned, truncated — proof it is a real call. */
  sample?: string;
  error?: string;
}

export interface ArchspaceAiGateway extends AiGateway {
  reconfigure(config: AiGatewayConfig): void;
  listProfiles(): Promise<ProfileStatus[]>;
  probe(profileName: string, signal?: AbortSignal): Promise<ProfileProbeResult>;
  /** Names of every configured profile, for `requires:` reporting. */
  profileNames(): string[];
}
