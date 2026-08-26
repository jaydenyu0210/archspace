/**
 * The two failure modes a caller of the gateway can act on, kept apart because
 * the remedies are different people's jobs.
 *
 *   AiProfileError   the machine is not set up: no such profile, no key bound,
 *                    a provider that cannot do what was asked. The message
 *                    always names the profile and where to fix it, because this
 *                    error reaches a user who opened someone else's workflow.
 *   AiProviderError  the provider answered badly (or not at all). Carries the
 *                    HTTP status when there was one and a `retryable` flag.
 *
 * Retryable errors are additionally marked with node-sdk's `markRetryable`, so
 * the engine's retry policy (ARCHITECTURE §7.5) applies even when the node
 * rethrows the error untouched. Nodes cannot `instanceof` these classes —
 * nodes-core does not depend on this package, by design — so the `retryable`
 * property is deliberately a plain boolean field a node can read structurally.
 */
import { markRetryable } from '@archspace/node-sdk';
import type { ProviderId } from './providers.js';

/** Why a profile is not usable. Mirrors ProfileReadiness in status.ts. */
export type AiProfileErrorReason = 'missing-key' | 'unreachable' | 'unknown' | 'invalid';

export class AiProfileError extends Error {
  readonly profile: string;
  readonly reason: AiProfileErrorReason;

  constructor(message: string, profile: string, reason: AiProfileErrorReason) {
    super(message);
    this.name = 'AiProfileError';
    this.profile = profile;
    this.reason = reason;
  }
}

export class AiProviderError extends Error {
  readonly provider: ProviderId;
  readonly status?: number;
  readonly retryable: boolean;

  constructor(message: string, opts: { provider: ProviderId; status?: number; retryable: boolean; cause?: unknown }) {
    super(message, opts.cause !== undefined ? { cause: opts.cause } : undefined);
    this.name = 'AiProviderError';
    this.provider = opts.provider;
    if (opts.status !== undefined) this.status = opts.status;
    this.retryable = opts.retryable;
    if (opts.retryable) markRetryable(this);
  }
}

/** The settings location every profile-binding message points at. */
export const BIND_HINT = 'Settings → AI model profiles';

export function unknownProfileError(name: string): AiProfileError {
  return new AiProfileError(
    `AI model profile "${name}" is not configured on this machine. Bind it in ${BIND_HINT}.`,
    name,
    'unknown',
  );
}

export function missingKeyError(name: string, apiKeyRef: string | undefined, provider: ProviderId): AiProfileError {
  const detail =
    apiKeyRef === undefined
      ? `provider "${provider}" needs an API key and the profile names none`
      : `the secret "${apiKeyRef}" holds no value on this machine`;
  return new AiProfileError(
    `AI model profile "${name}" is not usable: ${detail}. Bind it in ${BIND_HINT}.`,
    name,
    'missing-key',
  );
}
