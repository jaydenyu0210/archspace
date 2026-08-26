/**
 * Pins the retry table in errors.ts, because that table is a **contract with
 * the engine**, not a convenience.
 *
 * ARCHITECTURE §7.5 gives retry and backoff to the engine; the gateway's whole
 * contribution is a verdict — is this worth trying again — carried two ways at
 * once. `AiProviderError.retryable` is a plain boolean field so that
 * `nodes-core`, which deliberately does not depend on this package, can read it
 * structurally without `instanceof`; and node-sdk's `markRetryable` stamps the
 * same verdict so the engine's policy still applies when a node rethrows the
 * error untouched. Those two must never disagree, so every case below asserts
 * both.
 *
 * The verdict is computed here rather than read off the SDK's own `isRetryable`
 * on purpose: it should change when we change it, not when a dependency does.
 * That is only worth writing down if the boundaries are pinned, so the statuses
 * below are the boundaries — 404 versus 408, 429, and the 500 line.
 *
 * The two profile errors get the same treatment from the other side: they are
 * setup problems, they name the profile and where to fix it, and they are never
 * retryable, because retrying an unbound profile is retrying a decision.
 */
import { describe, expect, it } from 'vitest';
import { isRetryableError } from '@archspace/node-sdk';
import {
  AiProfileError,
  AiProviderError,
  BIND_HINT,
  createAiGateway,
  missingKeyError,
  unknownProfileError,
} from '../src/index.js';
import { NEVER_FETCH, alwaysRespond, anthropicFailure, configOf, keychain, mockProfile } from './helpers.js';

const CLOUD = configOf([{ name: 'cloud', provider: 'anthropic' as const, model: 'claude-opus-5', apiKeyRef: 'ai.key' }]);
const KEYS = keychain({ 'ai.key': 'sk-ant-real-value' });

/** Drive a real provider failure with the given HTTP status. */
async function failWith(status: number, message = 'provider said no'): Promise<AiProviderError> {
  const net = alwaysRespond(() => anthropicFailure(status, message));
  const gateway = createAiGateway({ config: CLOUD, secrets: KEYS, fetchImpl: net.fetchImpl });
  const failure = await gateway.generateText({ prompt: 'x' }).catch((err: unknown) => err);
  expect(failure).toBeInstanceOf(AiProviderError);
  return failure as AiProviderError;
}

describe('a provider that answered badly', () => {
  it.each([400, 401, 403, 404, 422])('treats HTTP %i as final', async (status) => {
    const failure = await failWith(status);

    expect(failure.status).toBe(status);
    expect(failure.retryable).toBe(false);
    // The two carriers agree. A node that rethrows untouched must not get a
    // retry the flag says it should not have.
    expect(isRetryableError(failure)).toBe(false);
  });

  it.each([408, 429, 500, 502, 503])('treats HTTP %i as worth another attempt', async (status) => {
    const failure = await failWith(status);

    expect(failure.status).toBe(status);
    expect(failure.retryable).toBe(true);
    expect(isRetryableError(failure)).toBe(true);
  });

  it('names the provider in words a user recognises and quotes what it said', async () => {
    const failure = await failWith(429, 'rate limit exceeded');

    expect(failure.message).toBe(
      'Anthropic returned HTTP 429 for AI model profile "cloud": rate limit exceeded',
    );
    expect(failure.provider).toBe('anthropic');
    expect(failure.name).toBe('AiProviderError');
  });

  it('keeps the SDK error as the cause so a bug report has the whole chain', async () => {
    const failure = await failWith(500);
    expect(failure.cause).toBeInstanceOf(Error);
  });

  it('is readable structurally, the way a node with no dependency on this package reads it', async () => {
    // nodes-core cannot `instanceof` these classes by design, so the fields it
    // needs have to be own, enumerable and plain.
    const failure = await failWith(503);
    const asData = { ...failure } as Record<string, unknown>;

    expect(asData.retryable).toBe(true);
    expect(asData.provider).toBe('anthropic');
    expect(asData.status).toBe(503);
  });
});

describe('a provider that did not answer at all', () => {
  it('is the most retryable failure there is', async () => {
    // No status means no HTTP answer — DNS, a refused connection, a dropped
    // socket. A local Ollama that has not finished starting looks exactly like
    // this, so giving up on the first try would be wrong.
    const gateway = createAiGateway({
      config: CLOUD,
      secrets: KEYS,
      fetchImpl: () => Promise.reject(new TypeError('fetch failed')),
    });

    const failure = (await gateway.generateText({ prompt: 'x' }).catch((err: unknown) => err)) as AiProviderError;

    expect(failure).toBeInstanceOf(AiProviderError);
    expect(failure.status).toBeUndefined();
    expect(failure.retryable).toBe(true);
    expect(isRetryableError(failure)).toBe(true);
    expect(failure.message).toContain('could not be reached');
  });

  it('reports a transport timeout as a timeout, not as a cancellation', async () => {
    const gateway = createAiGateway({
      config: CLOUD,
      secrets: KEYS,
      fetchImpl: () => Promise.reject(Object.assign(new Error('too slow'), { name: 'TimeoutError' })),
    });

    const failure = (await gateway.generateText({ prompt: 'x' }).catch((err: unknown) => err)) as AiProviderError;

    expect(failure).toBeInstanceOf(AiProviderError);
    expect(failure.message).toBe('Anthropic timed out for AI model profile "cloud"');
    expect(failure.retryable).toBe(true);
  });
});

describe('a run the engine cancelled', () => {
  it('comes back as the engine own signal, not as a retryable provider failure', async () => {
    // Marking a cancellation retryable would have the engine retry a run it
    // just stopped.
    const gateway = createAiGateway({ config: CLOUD, secrets: KEYS, fetchImpl: NEVER_FETCH });
    const controller = new AbortController();
    controller.abort();

    const failure = (await gateway.generateText({ prompt: 'x', signal: controller.signal }).catch((e: unknown) => e)) as Error;

    expect(failure).not.toBeInstanceOf(AiProviderError);
    expect(isRetryableError(failure)).toBe(false);
  });

  it('is still the engine own signal when the cancellation lands mid-request', async () => {
    // One rule, two mechanisms: `textOf` refuses an already-aborted signal
    // before it builds anything, and `mapProviderError` passes an abort
    // straight back when the signal tripped while the request was open. The
    // test above only exercises the first, so on its own the second could be
    // deleted without anything going red. This is the case the guard exists
    // for, and it is the hard one: an aborted fetch and a transport timeout
    // arrive as the same `AbortError`-shaped object, and the only thing that
    // tells them apart is whether *our* signal is the one that fired.
    const controller = new AbortController();
    const gateway = createAiGateway({
      config: CLOUD,
      secrets: KEYS,
      fetchImpl: () => {
        controller.abort();
        return Promise.reject(Object.assign(new Error('The operation was aborted'), { name: 'AbortError' }));
      },
    });

    const failure = (await gateway
      .generateText({ prompt: 'x', signal: controller.signal })
      .catch((e: unknown) => e)) as Error;

    expect(failure).not.toBeInstanceOf(AiProviderError);
    expect(failure.name).toBe('AbortError');
    expect(isRetryableError(failure)).toBe(false);
    // A timeout with the same shape is retryable and says so. This one must
    // not borrow that message: nobody timed out, the engine stopped the run.
    expect(failure.message).not.toContain('timed out');
  });
});

describe('a machine that is not set up', () => {
  it('says which profile, why, and where to fix it', () => {
    const unknown = unknownProfileError('reasoning');
    expect(unknown).toBeInstanceOf(AiProfileError);
    expect(unknown.name).toBe('AiProfileError');
    expect(unknown.profile).toBe('reasoning');
    expect(unknown.reason).toBe('unknown');
    expect(unknown.message).toBe(
      `AI model profile "reasoning" is not configured on this machine. Bind it in ${BIND_HINT}.`,
    );
  });

  it('distinguishes a key that was never named from one that holds nothing', () => {
    expect(missingKeyError('cloud', undefined, 'anthropic').message).toBe(
      `AI model profile "cloud" is not usable: provider "anthropic" needs an API key and the profile names none. Bind it in ${BIND_HINT}.`,
    );
    expect(missingKeyError('cloud', 'ai.key', 'anthropic').message).toBe(
      `AI model profile "cloud" is not usable: the secret "ai.key" holds no value on this machine. Bind it in ${BIND_HINT}.`,
    );
    expect(missingKeyError('cloud', 'ai.key', 'anthropic').reason).toBe('missing-key');
  });

  it('points every binding message at one place in the UI', () => {
    // One settings location, quoted verbatim — there is no second, friendlier
    // version of this sentence anywhere.
    expect(BIND_HINT).toBe('Settings → AI model profiles');
    for (const failure of [unknownProfileError('x'), missingKeyError('x', 'k', 'ollama')]) {
      expect(failure.message).toContain(BIND_HINT);
    }
  });

  it('is never retryable: retrying a decision does not make it a different decision', async () => {
    const gateway = createAiGateway({
      config: configOf([{ name: 'cloud', provider: 'anthropic', model: 'claude-opus-5' }, mockProfile()]),
      secrets: keychain(),
      fetchImpl: NEVER_FETCH,
    });

    const failures = await Promise.all([
      gateway.generateText({ profile: 'ghost', prompt: 'x' }).catch((e: unknown) => e),
      gateway.generateText({ profile: 'cloud', prompt: 'x' }).catch((e: unknown) => e),
      gateway.embed({ profile: 'offline', values: ['x'] }).then(() => null).catch((e: unknown) => e),
    ]);

    expect(failures[0]).toBeInstanceOf(AiProfileError);
    expect(failures[1]).toBeInstanceOf(AiProfileError);
    for (const failure of failures.slice(0, 2)) {
      expect(isRetryableError(failure)).toBe(false);
    }
  });
});

describe('a request the gateway itself rejected, before contacting anyone', () => {
  /**
   * KNOWN FAILURE — a real defect in gateway.ts, left red on purpose.
   *
   * `promptArgs()` throws "ctx.ai needs either a prompt or a non-empty messages
   * list" from *inside* the try block that wraps the SDK call, so
   * `mapProviderError` sweeps it up with everything else and its catch-all
   * branch turns a local argument check into
   *
   *     AiProviderError: Anthropic could not be reached for AI model profile
   *     "cloud": ctx.ai needs either a prompt or a non-empty messages list
   *
   * with `retryable: true`. Two things are wrong with that, and both are the
   * gateway's own documented rules:
   *
   *   1. No request was ever built, so no provider was "reached" or not
   *      reached. errors.ts reserves AiProviderError for "the provider answered
   *      badly (or not at all)". A user reading this reports an Anthropic
   *      outage; the actual bug is in the node that called `ctx.ai`.
   *   2. `retryable: true` hands the engine a deterministic input error to run
   *      through the full §7.5 backoff schedule — three attempts, two waits,
   *      identical failure — before surfacing the same misleading message.
   *
   * The fix is small: validate the prompt before entering the try, or have
   * `mapProviderError` pass through errors that are not provider failures. The
   * assertions below describe the behaviour the file's own header already
   * claims, so they should turn green when it is fixed rather than be deleted.
   */
  it('is not marked retryable and does not blame the provider', async () => {
    const gateway = createAiGateway({ config: CLOUD, secrets: KEYS, fetchImpl: NEVER_FETCH });

    const failure = (await gateway.generateText({ prompt: '' }).catch((err: unknown) => err)) as Error;

    expect(failure.message).toContain('ctx.ai needs either a prompt or a non-empty messages list');
    expect(isRetryableError(failure)).toBe(false);
    expect(failure.message).not.toContain('could not be reached');
  });
});
