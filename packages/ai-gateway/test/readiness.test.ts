/**
 * Pins the line status.ts draws: **`listProfiles()` makes no network calls.**
 *
 * The settings panel repaints; a paid API call must not. So readiness is only
 * ever what is *statically* knowable — is the provider in the catalogue, is an
 * endpoint set, does the named secret resolve — and `ready` means "fully
 * bound", never "reachable". Only `probe()` may say `unreachable`.
 *
 * The proof method matters here. Asserting "listProfiles returned statuses" is
 * not evidence of anything; a suite that mocked the transport would pass with a
 * gateway that called it on every repaint. So every gateway in this file is
 * built with `NEVER_FETCH`, which turns a request into a thrown error at the
 * line that made it. A green run is the assertion.
 *
 * The second invariant is that one function answers both "what colour is this
 * row" and "may this request proceed" — a green row and a failing run cannot
 * disagree, because `inspect()` decides both. The last block asserts that
 * agreement directly rather than trusting the comment that claims it.
 */
import { describe, expect, it } from 'vitest';
import { createAiGateway } from '../src/index.js';
import type { ProfileReadiness } from '../src/index.js';
import { NEVER_FETCH, configOf, keychain, mockProfile } from './helpers.js';

/** One config carrying every readiness the static path can produce. */
const EVERY_STATE = configOf(
  [
    { name: 'bound', provider: 'anthropic', model: 'claude-opus-5', apiKeyRef: 'ai.anthropic.api_key' },
    { name: 'unnamed-key', provider: 'anthropic', model: 'claude-opus-5' },
    { name: 'empty-key', provider: 'anthropic', model: 'claude-opus-5', apiKeyRef: 'ai.absent' },
    { name: 'blank-key', provider: 'anthropic', model: 'claude-opus-5', apiKeyRef: 'ai.blank' },
    { name: 'no-model', provider: 'ollama', model: '' },
    { name: 'no-endpoint', provider: 'openai-compatible', model: 'm' },
    { name: 'local', provider: 'ollama', model: 'llama3.1' },
    mockProfile('offline'),
  ],
  'local',
);

const KEYS = keychain({ 'ai.anthropic.api_key': 'sk-ant-real-value', 'ai.blank': '' });

function gatewayOverEveryState(): ReturnType<typeof createAiGateway> {
  return createAiGateway({ config: EVERY_STATE, secrets: KEYS, fetchImpl: NEVER_FETCH });
}

describe('listProfiles() reports readiness without any I/O to a provider', () => {
  it('answers for every configured profile with the transport disabled', async () => {
    const statuses = await gatewayOverEveryState().listProfiles();

    expect(statuses.map((s) => [s.name, s.readiness])).toEqual([
      ['bound', 'ready'],
      ['unnamed-key', 'missing-key'],
      ['empty-key', 'missing-key'],
      ['blank-key', 'missing-key'],
      ['no-model', 'invalid'],
      ['no-endpoint', 'invalid'],
      ['local', 'ready'],
      ['offline', 'ready'],
    ]);
  });

  it('never produces the two readiness values that would require a round trip', async () => {
    const statuses = await gatewayOverEveryState().listProfiles();
    const reachedOverTheWire: ProfileReadiness[] = ['unreachable', 'unknown'];
    for (const status of statuses) {
      expect(reachedOverTheWire).not.toContain(status.readiness);
    }
  });

  it('constructs no provider client, even for a profile that could not have one', async () => {
    // `no-endpoint` has nothing to build a client from. Reporting it as
    // `invalid` rather than throwing is what lets settings render a red row
    // instead of an empty list.
    const statuses = await gatewayOverEveryState().listProfiles();
    const broken = statuses.find((s) => s.name === 'no-endpoint');
    expect(broken).toMatchObject({
      readiness: 'invalid',
      detail: 'provider "openai-compatible" has no default endpoint; set the server URL',
    });
  });

  it('carries a reason for every row that is not ready, and none for the rows that are', async () => {
    const statuses = await gatewayOverEveryState().listProfiles();
    for (const status of statuses) {
      if (status.readiness === 'ready') expect(status.detail).toBeUndefined();
      else expect(status.detail).toBeTruthy();
    }
    expect(statuses.find((s) => s.name === 'unnamed-key')?.detail).toBe(
      'provider "anthropic" needs an API key and none is named',
    );
    expect(statuses.find((s) => s.name === 'empty-key')?.detail).toBe(
      'the secret "ai.absent" holds no value on this machine',
    );
    expect(statuses.find((s) => s.name === 'no-model')?.detail).toBe('no model id is set on this profile');
  });

  it('treats a named-but-unresolved key as missing even where the provider needs none', async () => {
    // Sending an anonymous request would be the wrong repair: the user asked
    // for authentication and did not get it.
    const gateway = createAiGateway({
      config: configOf([{ name: 'local', provider: 'ollama', model: 'llama3.1', apiKeyRef: 'ai.absent' }]),
      secrets: keychain(),
      fetchImpl: NEVER_FETCH,
    });
    expect(await gateway.listProfiles()).toEqual([
      {
        name: 'local',
        provider: 'ollama',
        providerKind: 'local',
        model: 'llama3.1',
        isDefault: true,
        readiness: 'missing-key',
        detail: 'the secret "ai.absent" holds no value on this machine',
        apiKeyRef: 'ai.absent',
      },
    ]);
  });

  it('marks exactly one row as the default, the one the config names', async () => {
    const statuses = await gatewayOverEveryState().listProfiles();
    expect(statuses.filter((s) => s.isDefault).map((s) => s.name)).toEqual(['local']);
  });

  it('echoes the provider kind so the panel can group cloud and local as peers', async () => {
    const statuses = await gatewayOverEveryState().listProfiles();
    expect(statuses.find((s) => s.name === 'bound')?.providerKind).toBe('cloud');
    expect(statuses.find((s) => s.name === 'local')?.providerKind).toBe('local');
    expect(statuses.find((s) => s.name === 'offline')?.providerKind).toBe('test');
  });

  it('crosses IPC as a plain value', async () => {
    // The renderer reads these over `ai-profile-list`; anything unclonable here
    // is a dropped message rather than a compile error.
    const statuses = await gatewayOverEveryState().listProfiles();
    expect(structuredClone(statuses)).toEqual(statuses);
  });

  it('reflects a reconfigure without a request', async () => {
    const gateway = gatewayOverEveryState();
    await gateway.listProfiles();
    gateway.reconfigure(configOf([mockProfile('only')]));
    expect((await gateway.listProfiles()).map((s) => s.name)).toEqual(['only']);
  });
});

describe('a green row and a failing run cannot disagree', () => {
  it('a row reported missing-key fails the request with the same verdict', async () => {
    const gateway = gatewayOverEveryState();
    const row = (await gateway.listProfiles()).find((s) => s.name === 'empty-key');
    expect(row?.readiness).toBe('missing-key');

    await expect(gateway.generateText({ profile: 'empty-key', prompt: 'x' })).rejects.toMatchObject({
      name: 'AiProfileError',
      profile: 'empty-key',
      reason: 'missing-key',
    });
  });

  it('a row reported invalid fails the request with reason invalid', async () => {
    const gateway = gatewayOverEveryState();
    const row = (await gateway.listProfiles()).find((s) => s.name === 'no-model');
    expect(row?.readiness).toBe('invalid');

    await expect(gateway.generateText({ profile: 'no-model', prompt: 'x' })).rejects.toMatchObject({
      name: 'AiProfileError',
      profile: 'no-model',
      reason: 'invalid',
    });
  });

  it('a row reported ready on the offline provider actually runs', async () => {
    const gateway = gatewayOverEveryState();
    const row = (await gateway.listProfiles()).find((s) => s.name === 'offline');
    expect(row?.readiness).toBe('ready');
    await expect(gateway.generateText({ profile: 'offline', prompt: 'x' })).resolves.toMatchObject({
      text: expect.stringContaining('mock-small'),
    });
  });
});

describe('a name that is not in the list', () => {
  it('is answered by resolution, not by a status row', async () => {
    // `unknown` is a *resolution* verdict: there is no row to colour, so
    // listProfiles has nothing to say and the error carries the whole answer.
    const gateway = gatewayOverEveryState();
    expect((await gateway.listProfiles()).some((s) => s.name === 'ghost')).toBe(false);
    await expect(gateway.generateText({ profile: 'ghost', prompt: 'x' })).rejects.toMatchObject({
      reason: 'unknown',
    });
  });
});
