/**
 * Pins the one rule `probe()` cannot break: **it never throws.**
 *
 * `probe()` backs a settings-panel button, and its answer crosses an IPC
 * boundary as a value (`ai-probe-result`). An exception on that path is not a
 * failed probe — it is a *dropped message*: the renderer's promise never
 * settles and the button spins forever with nothing to show. So every failure,
 * including the ones nobody planned for, has to come back as
 * `{ ok: false, error }`.
 *
 * "Never throws" is only worth asserting against real failure modes, so this
 * file drives the method into each one it can actually meet: a refused
 * connection, a rejected key, a name that is not configured, a key the keychain
 * will not hand over, a profile that cannot be bound at all, and a caller who
 * cancelled. Each is asserted as a *returned value*, never as a rejection.
 *
 * The rest of the file guards the two things probe alone is allowed to report —
 * a `sample` of real model output and a `latencyMs` for a completed round trip
 * — and the promise that a probe stays cheap (§10: a liveness check, not a
 * generation).
 */
import { describe, expect, it } from 'vitest';
import { createAiGateway, probeReadiness } from '../src/index.js';
import type { ProfileProbeResult } from '../src/index.js';
import {
  NEVER_FETCH,
  alwaysRespond,
  anthropicFailure,
  anthropicMessage,
  chatCompletion,
  configOf,
  keychain,
  lockedKeychain,
  mockProfile,
  recordFetch,
} from './helpers.js';

const CLOUD = { name: 'cloud', provider: 'anthropic' as const, model: 'claude-opus-5', apiKeyRef: 'ai.key' };
const CONFIG = configOf([CLOUD, { name: 'no-endpoint', provider: 'openai-compatible', model: 'm' }, mockProfile()]);
const KEYS = keychain({ 'ai.key': 'sk-ant-real-value' });

/** Every probe result must be a value; this is the shape of "it came back". */
function expectValue(result: ProfileProbeResult, profile: string): void {
  expect(result).toBeTypeOf('object');
  expect(result.profile).toBe(profile);
  expect(structuredClone(result)).toEqual(result);
}

describe('probe() returns a failure rather than throwing one', () => {
  it('when the connection is refused', async () => {
    const gateway = createAiGateway({
      config: CONFIG,
      secrets: KEYS,
      fetchImpl: () => Promise.reject(new TypeError('fetch failed')),
    });

    const result = await gateway.probe('cloud');

    expectValue(result, 'cloud');
    expect(result.ok).toBe(false);
    expect(result.error).toContain('could not be reached');
    expect(result.error).toContain('fetch failed');
  });

  it('when the transport throws synchronously', async () => {
    // A `fetch` that throws before returning a promise is the shape a broken
    // proxy agent has; it must not escape as an exception either.
    const gateway = createAiGateway({ config: CONFIG, secrets: KEYS, fetchImpl: NEVER_FETCH });

    const result = await gateway.probe('cloud');

    expect(result.ok).toBe(false);
    expect(result.error).toContain('the gateway reached the transport');
  });

  it('when the provider rejects the key', async () => {
    const net = alwaysRespond(() => anthropicFailure(401, 'invalid x-api-key'));
    const gateway = createAiGateway({ config: CONFIG, secrets: KEYS, fetchImpl: net.fetchImpl });

    const result = await gateway.probe('cloud');

    expectValue(result, 'cloud');
    expect(result.ok).toBe(false);
    expect(result.error).toContain('HTTP 401');
    expect(result.error).toContain('invalid x-api-key');
  });

  it('when the profile is not configured on this machine', async () => {
    const gateway = createAiGateway({ config: CONFIG, secrets: KEYS, fetchImpl: NEVER_FETCH });

    const result = await gateway.probe('reasoning');

    // The requested name is echoed back even though nothing answers to it, so
    // the panel can put the failure on the row the user clicked.
    expectValue(result, 'reasoning');
    expect(result.ok).toBe(false);
    expect(result.error).toContain('"reasoning" is not configured on this machine');
    expect(result.error).toContain('Settings → AI keys');
  });

  it('when no key is bound', async () => {
    const gateway = createAiGateway({ config: CONFIG, secrets: keychain(), fetchImpl: NEVER_FETCH });

    const result = await gateway.probe('cloud');

    expect(result.ok).toBe(false);
    expect(result.error).toContain('is not usable');
    expect(result.error).toContain('the secret "ai.key" holds no value on this machine');
  });

  it('when the keychain itself refuses', async () => {
    const gateway = createAiGateway({ config: CONFIG, secrets: lockedKeychain(), fetchImpl: NEVER_FETCH });

    const result = await gateway.probe('cloud');

    expect(result.ok).toBe(false);
    expect(result.error).toBe('the keychain is locked');
  });

  it('when the profile cannot be bound at all', async () => {
    const gateway = createAiGateway({ config: CONFIG, secrets: KEYS, fetchImpl: NEVER_FETCH });

    const result = await gateway.probe('no-endpoint');

    expect(result.ok).toBe(false);
    expect(result.error).toContain('has no default endpoint');
  });

  it('when the caller cancelled before the request went out', async () => {
    const gateway = createAiGateway({ config: CONFIG, secrets: KEYS, fetchImpl: NEVER_FETCH });
    const controller = new AbortController();
    controller.abort();

    const result = await gateway.probe('cloud', controller.signal);

    expect(result.ok).toBe(false);
    expect(result.error).toBeTypeOf('string');
  });

  it('carries no latency and no sample on any failure', async () => {
    const gateway = createAiGateway({ config: CONFIG, secrets: keychain(), fetchImpl: NEVER_FETCH });

    for (const name of ['cloud', 'no-endpoint', 'ghost']) {
      const result = await gateway.probe(name);
      // "It took 12ms to fail DNS" is not a latency, and there is no model
      // output to sample when no model answered.
      expect(result.ok).toBe(false);
      expect(result.latencyMs).toBeUndefined();
      expect(result.sample).toBeUndefined();
    }
  });
});

describe('a probe that succeeds', () => {
  it('reports a latency and a sample of what the model actually said', async () => {
    const net = alwaysRespond(() => anthropicMessage('ok'));
    const gateway = createAiGateway({ config: CONFIG, secrets: KEYS, fetchImpl: net.fetchImpl });

    const result = await gateway.probe('cloud');

    expect(result).toMatchObject({ profile: 'cloud', ok: true, sample: 'ok' });
    expect(result.latencyMs).toBeTypeOf('number');
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
    expect(result.error).toBeUndefined();
    expect(structuredClone(result)).toEqual(result);
  });

  it('truncates a chatty model to 200 characters with an ellipsis', async () => {
    const chatty = 'a'.repeat(500);
    const net = alwaysRespond(() => chatCompletion(chatty));
    const gateway = createAiGateway({
      config: configOf([{ name: 'local', provider: 'ollama', model: 'llama3.1' }]),
      secrets: keychain(),
      fetchImpl: net.fetchImpl,
    });

    const result = await gateway.probe('local');

    expect(result.ok).toBe(true);
    expect(result.sample).toHaveLength(200);
    expect(result.sample?.endsWith('...')).toBe(true);
    expect(result.sample).toBe(`${'a'.repeat(197)}...`);
  });

  it('leaves a sample exactly at the limit untouched', async () => {
    const net = alwaysRespond(() => chatCompletion('b'.repeat(200)));
    const gateway = createAiGateway({
      config: configOf([{ name: 'local', provider: 'ollama', model: 'llama3.1' }]),
      secrets: keychain(),
      fetchImpl: net.fetchImpl,
    });

    expect((await gateway.probe('local')).sample).toBe('b'.repeat(200));
  });

  it('stays cheap: one request, a tiny output budget and a one-word prompt', async () => {
    // §10 calls a probe a liveness check, not a generation. If this ever grows
    // a real prompt or an unbounded budget, clicking "test connection" starts
    // costing money.
    const net = recordFetch(() => anthropicMessage('ok'));
    const gateway = createAiGateway({ config: CONFIG, secrets: KEYS, fetchImpl: net.fetchImpl });

    await gateway.probe('cloud');

    const call = net.single();
    expect(call.url).toBe('https://api.anthropic.com/v1/messages');
    expect(call.body.max_tokens).toBe(16);
    expect(JSON.stringify(call.body.messages)).toContain('ping');
    expect(JSON.stringify(call.body.system)).toContain('connection probe');
  });

  it('answers from the offline provider with the same deterministic bytes every time', async () => {
    const gateway = createAiGateway({
      config: configOf([mockProfile()]),
      secrets: keychain(),
      fetchImpl: NEVER_FETCH,
    });

    const first = await gateway.probe('offline');
    const second = await gateway.probe('offline');

    expect(first.ok).toBe(true);
    // Literal, not self-comparison: a mock probe has to look the same in CI on
    // another machine as it does here.
    expect(first.sample).toBe('[mock mock-small 95f827623827] ping');
    expect(second.sample).toBe(first.sample);
  });
});

describe('probeReadiness folds a probe back into the row it came from', () => {
  it('is the only source of "unreachable"', async () => {
    const gateway = createAiGateway({ config: CONFIG, secrets: KEYS, fetchImpl: NEVER_FETCH });
    expect(probeReadiness(await gateway.probe('cloud'))).toBe('unreachable');
  });

  it('reports ready for a probe that completed', async () => {
    const net = alwaysRespond(() => anthropicMessage('ok'));
    const gateway = createAiGateway({ config: CONFIG, secrets: KEYS, fetchImpl: net.fetchImpl });
    expect(probeReadiness(await gateway.probe('cloud'))).toBe('ready');
  });
});
