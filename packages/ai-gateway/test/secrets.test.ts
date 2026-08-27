/**
 * Pins a security property, not a nicety: **a resolved API key never reaches a
 * message, a status, a probe result, a serialized config or an error chain.**
 *
 * ARCHITECTURE §6.1/§11 give exactly one route for a credential into this
 * process — the `SecretResolver` seam — and exactly one destination, the
 * provider request. Everything else the gateway produces crosses a boundary
 * where a leak becomes permanent: a `ProfileStatus` and a `ProfileProbeResult`
 * go over IPC to a renderer that may log them; an `AiProviderError` message is
 * shown to the user, written to the run log and pasted into bug reports; a
 * serialized `ai.yaml` is a file in the user's home directory and, sooner or
 * later, in a screenshot.
 *
 * This is asserted the only way it can be asserted honestly: with a key that is
 * genuinely in play. Every gateway below resolves a real canary and really
 * sends it to a provider — the first test proves the request carried it — and
 * then every other surface is searched for that same string, including through
 * the `cause` chain of the SDK's own error objects, which is where a leak would
 * arrive from a dependency rather than from our code.
 *
 * The last block pins the other half of §11: an ambient `ANTHROPIC_API_KEY` is
 * never a fallback. gateway.ts passes `apiKey` explicitly for exactly this
 * reason — an env var the keychain never saw makes "which key did that run
 * use?" unanswerable.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createAiGateway,
  defaultAiConfig,
  parseAiConfig,
  serializeAiConfig,
  validateAiConfig,
} from '../src/index.js';
import {
  NEVER_FETCH,
  alwaysRespond,
  anthropicFailure,
  anthropicMessage,
  configOf,
  keychain,
  recordFetch,
} from './helpers.js';

/** A value that must appear in exactly one place: the provider request. */
const CANARY = 'sk-ant-api03-CANARY-must-never-appear';

const CONFIG = configOf([
  { name: 'cloud', provider: 'anthropic' as const, model: 'claude-opus-5', apiKeyRef: 'ai.anthropic.api_key' },
  { name: 'unbound', provider: 'anthropic' as const, model: 'claude-opus-5', apiKeyRef: 'ai.absent' },
]);

const secrets = () => keychain({ 'ai.anthropic.api_key': CANARY });

/**
 * Everything an error carries that a human or a log could ever see: the
 * message, the stack, its own enumerable fields, and the same again for every
 * link in the `cause` chain.
 */
function renderFully(value: unknown, depth = 0): string {
  if (depth > 8) return '';
  if (value instanceof Error) {
    const own = JSON.stringify(value, (_key, v: unknown) => (v instanceof Error ? `${v.name}: ${v.message}` : v));
    return [value.name, value.message, value.stack ?? '', own ?? '', renderFully(value.cause, depth + 1)].join('\n');
  }
  if (value === undefined) return '';
  // JSON.stringify returns undefined only for a function or a symbol, which
  // no config value can be; naming that case beats String()-ing an object.
  return JSON.stringify(value) ?? '[unserializable]';
}

describe('the key does reach the provider — otherwise this file proves nothing', () => {
  it('rides the provider auth header, and nothing else', async () => {
    const net = recordFetch(() => anthropicMessage('ok'));
    const gateway = createAiGateway({ config: CONFIG, secrets: secrets(), fetchImpl: net.fetchImpl });

    await gateway.generateText({ profile: 'cloud', prompt: 'x' });

    const call = net.single();
    expect(call.headers['x-api-key']).toBe(CANARY);
    // Not in the URL, not in a query string, not in the body — the three places
    // a credential ends up in an access log.
    expect(call.url).not.toContain(CANARY);
    expect(call.url).not.toContain('?');
    expect(call.rawBody).not.toContain(CANARY);
  });
});

describe('nothing the gateway hands back carries the key', () => {
  it('not a profile status', async () => {
    const gateway = createAiGateway({ config: CONFIG, secrets: secrets(), fetchImpl: NEVER_FETCH });

    const statuses = await gateway.listProfiles();

    // The ref name is the whole point — it is a pointer, not a credential.
    expect(statuses[0]?.apiKeyRef).toBe('ai.anthropic.api_key');
    expect(JSON.stringify(statuses)).not.toContain(CANARY);
  });

  it('not a status whose key failed to resolve', async () => {
    const gateway = createAiGateway({ config: CONFIG, secrets: secrets(), fetchImpl: NEVER_FETCH });

    const statuses = await gateway.listProfiles();

    expect(statuses[1]).toMatchObject({
      readiness: 'missing-key',
      detail: 'the secret "ai.absent" holds no value on this machine',
    });
    expect(JSON.stringify(statuses)).not.toContain(CANARY);
  });

  it('not a successful probe result', async () => {
    const net = alwaysRespond(() => anthropicMessage('ok'));
    const gateway = createAiGateway({ config: CONFIG, secrets: secrets(), fetchImpl: net.fetchImpl });

    const result = await gateway.probe('cloud');

    expect(result.ok).toBe(true);
    expect(JSON.stringify(result)).not.toContain(CANARY);
  });

  it('not a probe result from a provider that rejected the key', async () => {
    // The most tempting place for a leak: the natural "here is what we sent"
    // diagnostic on a 401.
    const net = alwaysRespond(() => anthropicFailure(401, 'invalid x-api-key'));
    const gateway = createAiGateway({ config: CONFIG, secrets: secrets(), fetchImpl: net.fetchImpl });

    const result = await gateway.probe('cloud');

    expect(result.ok).toBe(false);
    expect(result.error).toContain('HTTP 401');
    expect(JSON.stringify(result)).not.toContain(CANARY);
  });

  it('not an error message, its fields, or anywhere in its cause chain', async () => {
    const net = alwaysRespond(() => anthropicFailure(403, 'forbidden'));
    const gateway = createAiGateway({ config: CONFIG, secrets: secrets(), fetchImpl: net.fetchImpl });

    const failure = await gateway.generateText({ profile: 'cloud', prompt: 'x' }).catch((err: unknown) => err);

    const rendered = renderFully(failure);
    // The SDK's APICallError is in this chain, so this also pins that our
    // dependency does not attach request headers to its errors.
    expect(rendered).toContain('HTTP 403');
    expect(rendered).not.toContain(CANARY);
  });

  it('not an error raised when the transport itself fails', async () => {
    const gateway = createAiGateway({
      config: CONFIG,
      secrets: secrets(),
      fetchImpl: () => Promise.reject(new TypeError('fetch failed')),
    });

    const failure = await gateway.generateText({ profile: 'cloud', prompt: 'x' }).catch((err: unknown) => err);

    expect(renderFully(failure)).not.toContain(CANARY);
  });

  it('not any surface at all, across every entry point', async () => {
    const net = alwaysRespond(() => anthropicFailure(500, 'boom'));
    const gateway = createAiGateway({ config: CONFIG, secrets: secrets(), fetchImpl: net.fetchImpl });
    const schema = { type: 'object' as const, properties: { a: { type: 'string' } } };

    const surfaces: unknown[] = [
      await gateway.listProfiles(),
      await gateway.probe('cloud'),
      gateway.profileNames(),
      await gateway.generateText({ profile: 'cloud', prompt: 'x' }).catch((e: unknown) => e),
      await gateway.generateObject({ profile: 'cloud', prompt: 'x', schema }).catch((e: unknown) => e),
      await gateway.embed({ profile: 'cloud', values: ['x'] }).catch((e: unknown) => e),
    ];

    for (const surface of surfaces) {
      expect(renderFully(surface)).not.toContain(CANARY);
    }
  });
});

describe('nothing written back to disk carries the key', () => {
  it('a serialized config names the keychain entry and holds no value', () => {
    const text = serializeAiConfig(CONFIG);

    expect(text).toContain('apiKeyRef: ai.anthropic.api_key');
    expect(text).not.toContain(CANARY);
  });

  it('a config that arrived with a pasted credential cannot be written back out', () => {
    // The user pasted a key into the file by hand. Validation refuses it, and
    // the next save must not re-persist what it refused.
    const pasted = `defaultProfile: cloud\nprofiles:\n  - name: cloud\n    provider: anthropic\n    model: claude-opus-5\n    apiKeyRef: ${CANARY}\n`;

    const parsed = parseAiConfig(pasted);

    expect(parsed.config.profiles[0]?.apiKeyRef).toBeUndefined();
    expect(serializeAiConfig(parsed.config)).not.toContain(CANARY);
    expect(JSON.stringify(parsed.issues)).not.toContain(CANARY);
  });

  it('reports a refused credential without quoting it back', () => {
    // An issue message is UI text and log text. Echoing the rejected value is
    // how a "we protected you" message becomes the leak itself.
    const { issues } = validateAiConfig({
      defaultProfile: 'a',
      profiles: [{ name: 'a', provider: 'anthropic', model: 'm', apiKeyRef: CANARY, headers: { Authorization: CANARY } }],
    });

    expect(issues.length).toBeGreaterThan(0);
    expect(JSON.stringify(issues)).not.toContain(CANARY);
  });

  it('ships no credential in the defaults', () => {
    expect(serializeAiConfig(defaultAiConfig())).not.toMatch(/sk-|xoxb-|ghp_|AIza/);
  });
});

describe('the keychain is the only source of a key', () => {
  const ENV_CANARY = 'sk-ant-api03-FROM-THE-ENVIRONMENT';
  let saved: string | undefined;

  beforeEach(() => {
    saved = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = ENV_CANARY;
  });

  afterEach(() => {
    if (saved === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = saved;
  });

  it('sends the keychain value even when an ambient env var is set', async () => {
    const net = recordFetch(() => anthropicMessage('ok'));
    const gateway = createAiGateway({ config: CONFIG, secrets: secrets(), fetchImpl: net.fetchImpl });

    await gateway.generateText({ profile: 'cloud', prompt: 'x' });

    const call = net.single();
    expect(call.headers['x-api-key']).toBe(CANARY);
    expect(JSON.stringify(call)).not.toContain(ENV_CANARY);
  });

  it('does not quietly authenticate a profile that named no key', async () => {
    // The SDK's own `ANTHROPIC_API_KEY` fallback would make this request
    // succeed with a credential the keychain never saw. It must stay a
    // missing-key binding error instead.
    const gateway = createAiGateway({
      config: configOf([{ name: 'cloud', provider: 'anthropic', model: 'claude-opus-5' }]),
      secrets: keychain(),
      fetchImpl: NEVER_FETCH,
    });

    await expect(gateway.generateText({ prompt: 'x' })).rejects.toMatchObject({
      name: 'AiProfileError',
      reason: 'missing-key',
    });
    expect((await gateway.listProfiles())[0]?.readiness).toBe('missing-key');
  });

  it('asks the keychain for the ref the profile names, and for nothing else', async () => {
    const store = secrets();
    const gateway = createAiGateway({ config: CONFIG, secrets: store, fetchImpl: NEVER_FETCH });

    await gateway.listProfiles();

    expect(store.reads).toEqual(['ai.anthropic.api_key', 'ai.absent']);
  });
});
