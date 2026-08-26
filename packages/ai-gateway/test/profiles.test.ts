/**
 * Pins the promise gateway.ts opens with: **profiles resolve per call, not at
 * construction** (ARCHITECTURE §10 / ADR-0010 §3).
 *
 * It is worth pinning because the alternative is invisible. `engine-child`
 * builds one gateway for the life of the process and calls `reconfigure()` when
 * settings change; if resolution had closed over the config handed to the
 * factory, every workflow would keep running against the binding that existed
 * at startup and nothing would look broken — the run would simply go to the
 * wrong provider, with the wrong key, forever. So these tests never assert on
 * "the config changed"; they assert on *where the next request actually went*.
 *
 * The client cache is the same promise from the other side. Clients are
 * memoized because constructing one costs a keychain round trip, and
 * `reconfigure()` is the single invalidation point — a cached client holds a
 * base URL and a resolved key, both of which an edit is allowed to change.
 */
import { describe, expect, it } from 'vitest';
import { createAiGateway } from '../src/index.js';
import { AiProfileError } from '../src/index.js';
import {
  NEVER_FETCH,
  alwaysRespond,
  chatCompletion,
  configOf,
  keychain,
  mockProfile,
} from './helpers.js';

/** Two bindings of the same logical name — the portability case in one pair. */
const ANTHROPIC_SIDE = configOf([{ name: 'default', provider: 'mock', model: 'cloud-model' }]);
const OLLAMA_SIDE = configOf([{ name: 'default', provider: 'mock', model: 'local-model' }]);

describe('a name resolves against the config in force at call time', () => {
  it('a request made after reconfigure() uses the new binding', async () => {
    const gateway = createAiGateway({ config: ANTHROPIC_SIDE, secrets: keychain(), fetchImpl: NEVER_FETCH });

    const before = await gateway.generateText({ profile: 'default', prompt: 'x' });
    expect(before.text).toContain('cloud-model');

    gateway.reconfigure(OLLAMA_SIDE);

    const after = await gateway.generateText({ profile: 'default', prompt: 'x' });
    expect(after.text).toContain('local-model');
    // The whole point of the indirection: the caller never changed.
    expect(after.text).not.toContain('cloud-model');
  });

  it('holds no closure over the config it was constructed with', async () => {
    const gateway = createAiGateway({ config: ANTHROPIC_SIDE, secrets: keychain(), fetchImpl: NEVER_FETCH });
    expect(gateway.profileNames()).toEqual(['default']);

    gateway.reconfigure(configOf([mockProfile('fast'), mockProfile('reasoning')], 'reasoning'));

    expect(gateway.profileNames()).toEqual(['fast', 'reasoning']);
    const statuses = await gateway.listProfiles();
    expect(statuses.map((s) => s.name)).toEqual(['fast', 'reasoning']);
    expect(statuses.find((s) => s.isDefault)?.name).toBe('reasoning');
  });

  it('makes a previously-unknown name resolvable — the colleague-opens-your-document case', async () => {
    const gateway = createAiGateway({
      config: configOf([mockProfile('default')]),
      secrets: keychain(),
      fetchImpl: NEVER_FETCH,
    });

    await expect(gateway.generateText({ profile: 'reasoning', prompt: 'x' })).rejects.toBeInstanceOf(AiProfileError);

    gateway.reconfigure(configOf([mockProfile('default'), mockProfile('reasoning', 'big-model')], 'default'));

    const answer = await gateway.generateText({ profile: 'reasoning', prompt: 'x' });
    expect(answer.text).toContain('big-model');
  });

  it('drops a name that reconfigure removed', async () => {
    const gateway = createAiGateway({
      config: configOf([mockProfile('default'), mockProfile('scratch')]),
      secrets: keychain(),
      fetchImpl: NEVER_FETCH,
    });
    await expect(gateway.generateText({ profile: 'scratch', prompt: 'x' })).resolves.toBeDefined();

    gateway.reconfigure(configOf([mockProfile('default')]));

    await expect(gateway.generateText({ profile: 'scratch', prompt: 'x' })).rejects.toMatchObject({
      name: 'AiProfileError',
      profile: 'scratch',
      reason: 'unknown',
    });
  });
});

describe('the provider client cache is invalidated by reconfigure and nothing else', () => {
  const endpoint = (host: string) =>
    configOf([{ name: 'p', provider: 'openai-compatible', model: 'm', baseUrl: `http://${host}/v1`, apiKeyRef: 'ai.key' }]);

  it('a rebound endpoint takes effect on the very next request', async () => {
    const net = alwaysRespond(() => chatCompletion('hi'));
    const gateway = createAiGateway({
      config: endpoint('first'),
      secrets: keychain({ 'ai.key': 'k' }),
      fetchImpl: net.fetchImpl,
    });

    await gateway.generateText({ prompt: 'x' });
    gateway.reconfigure(endpoint('second'));
    await gateway.generateText({ prompt: 'x' });

    // Without the cache clear the second request would still go to `first`,
    // and the settings panel would show a URL the process is not using.
    expect(net.urls()).toEqual([
      'http://first/v1/chat/completions',
      'http://second/v1/chat/completions',
    ]);
  });

  it('resolves a profile key once and reuses the client until reconfigure', async () => {
    const net = alwaysRespond(() => chatCompletion('hi'));
    const secrets = keychain({ 'ai.key': 'k' });
    const gateway = createAiGateway({ config: endpoint('first'), secrets, fetchImpl: net.fetchImpl });

    await gateway.generateText({ prompt: '1' });
    await gateway.generateText({ prompt: '2' });
    await gateway.generateText({ prompt: '3' });
    // Three requests, one keychain round trip: that is the memoization.
    expect(net.calls).toHaveLength(3);
    expect(secrets.reads).toEqual(['ai.key']);

    gateway.reconfigure(endpoint('second'));
    await gateway.generateText({ prompt: '4' });
    // …and the edit is the only thing that expires it.
    expect(secrets.reads).toEqual(['ai.key', 'ai.key']);
  });

  it('caches per profile name, not globally', async () => {
    const net = alwaysRespond(() => chatCompletion('hi'));
    const secrets = keychain({ 'a.key': 'ka', 'b.key': 'kb' });
    const gateway = createAiGateway({
      config: configOf([
        { name: 'a', provider: 'openai-compatible', model: 'm', baseUrl: 'http://a/v1', apiKeyRef: 'a.key' },
        { name: 'b', provider: 'openai-compatible', model: 'm', baseUrl: 'http://b/v1', apiKeyRef: 'b.key' },
      ]),
      secrets,
      fetchImpl: net.fetchImpl,
    });

    await gateway.generateText({ profile: 'a', prompt: 'x' });
    await gateway.generateText({ profile: 'b', prompt: 'x' });
    await gateway.generateText({ profile: 'a', prompt: 'x' });

    expect(net.urls()).toEqual([
      'http://a/v1/chat/completions',
      'http://b/v1/chat/completions',
      'http://a/v1/chat/completions',
    ]);
    expect(secrets.reads).toEqual(['a.key', 'b.key']);
  });
});

describe('resolving no name at all', () => {
  it('uses the machine default', async () => {
    const gateway = createAiGateway({
      config: configOf([mockProfile('default', 'd-model'), mockProfile('fast', 'f-model')], 'fast'),
      secrets: keychain(),
      fetchImpl: NEVER_FETCH,
    });
    const answer = await gateway.generateText({ prompt: 'x' });
    expect(answer.text).toContain('f-model');
  });

  it('with nothing bound, says so and points at the fix rather than at the cause', async () => {
    const gateway = createAiGateway({
      config: configOf([mockProfile('offline')], ''),
      secrets: keychain(),
      fetchImpl: NEVER_FETCH,
    });

    await expect(gateway.generateText({ prompt: 'x' })).rejects.toSatisfy((err: unknown) => {
      expect(err).toBeInstanceOf(AiProfileError);
      const failure = err as AiProfileError;
      expect(failure.reason).toBe('unknown');
      expect(failure.message).toContain('did not name an AI model profile');
      expect(failure.message).toContain('Settings → AI model profiles');
      return true;
    });
  });

  it('with a default naming a profile this machine does not have, names it', async () => {
    const gateway = createAiGateway({
      config: configOf([mockProfile('offline')], 'reasoning'),
      secrets: keychain(),
      fetchImpl: NEVER_FETCH,
    });

    await expect(gateway.generateText({ prompt: 'x' })).rejects.toMatchObject({
      name: 'AiProfileError',
      profile: 'reasoning',
      reason: 'unknown',
    });
  });
});

describe('every entry point resolves the same way', () => {
  it('generateText, generateObject and embed all reject an unknown name identically', async () => {
    const gateway = createAiGateway({
      config: configOf([mockProfile('offline')]),
      secrets: keychain(),
      fetchImpl: NEVER_FETCH,
    });
    const schema = { type: 'object' as const, properties: { a: { type: 'string' } } };

    const failures = await Promise.all([
      gateway.generateText({ profile: 'ghost', prompt: 'x' }).catch((e: unknown) => e),
      gateway.generateObject({ profile: 'ghost', prompt: 'x', schema }).catch((e: unknown) => e),
      gateway.embed({ profile: 'ghost', values: ['x'] }).catch((e: unknown) => e),
    ]);

    for (const failure of failures) {
      expect(failure).toBeInstanceOf(AiProfileError);
      expect(failure).toMatchObject({ profile: 'ghost', reason: 'unknown' });
    }
    // One message, three call sites — the user sees the same sentence whichever
    // node they wired.
    expect(new Set(failures.map((f) => (f as Error).message)).size).toBe(1);
  });
});
