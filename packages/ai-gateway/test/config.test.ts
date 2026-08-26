/**
 * Pins the `ai.yaml` codec: the indirection that makes a workflow portable
 * (ARCHITECTURE §10 / ADR-0010 §3).
 *
 * A document says `profile: default`; *this machine* says what `default` means.
 * Everything worth pinning here follows from that being a hand-editable file on
 * someone's disk:
 *
 *  * **Round trip.** `parse → validate → serialize` has to be stable, or the
 *    settings panel rewrites the user's file into a different file every time
 *    it saves. Emission is canonical — fixed key order, LF, no trailing
 *    whitespace — so a second serialize is byte-identical to the first.
 *  * **Malformed input yields ConfigIssues, never an exception.** A settings
 *    file with a typo must not take the app down or, worse, be silently
 *    rewritten; parse reports and falls back for the session, leaving the file
 *    untouched.
 *  * **A broken profile is kept, not dropped** (config.ts rule 2). Deleting a
 *    user's hand-written binding because one field is wrong is a worse outcome
 *    than a red row in settings. The two exceptions — no name, no known
 *    provider — are the entries there is nothing to keep.
 *  * **A profile carries a secret KEY, never a secret value** (rule 1, §6.1,
 *    §11). A settings file is exactly the sort of place a pasted key goes to
 *    leak from, so anything that looks like a credential is an error.
 *
 * Only the codec is exercised here. `yaml-lite` is an implementation detail and
 * gets its own file.
 */
import { describe, expect, it } from 'vitest';
import {
  AI_CONFIG_FILENAME,
  defaultAiConfig,
  parseAiConfig,
  serializeAiConfig,
  validateAiConfig,
  type AiGatewayConfig,
} from '../src/index.js';

const RICH: AiGatewayConfig = {
  profiles: [
    { name: 'default', provider: 'anthropic', model: 'claude-opus-5', apiKeyRef: 'ai.anthropic.api_key', temperature: 0 },
    {
      name: 'local',
      provider: 'ollama',
      model: 'llama3.1',
      baseUrl: 'http://localhost:11434/v1',
      embeddingModel: 'nomic-embed-text',
      temperature: 0.25,
      maxOutputTokens: 2048,
      headers: { 'X-Team': 'aec' },
    },
    { name: 'offline', provider: 'mock', model: 'mock-small' },
  ],
  defaultProfile: 'local',
};

/** Just the errors — warnings are advice, errors are refusals. */
const errorsOf = (issues: { severity: string; path: string }[]) => issues.filter((i) => i.severity === 'error');

describe('defaultAiConfig', () => {
  it('is valid on its own terms', () => {
    // The out-of-the-box binding is what a new user's first run validates. If
    // it ever produced an issue, the app would open showing its own defaults as
    // broken.
    expect(validateAiConfig(defaultAiConfig()).issues).toEqual([]);
  });

  it('offers a cloud profile and a local profile as peers, and activates neither', () => {
    const config = defaultAiConfig();
    expect(config.profiles.map((p) => p.provider)).toEqual(['anthropic', 'ollama']);
    // The cloud one ships unbound: a suggestion, not an activation.
    expect(config.profiles[0].apiKeyRef).toBe('ai.anthropic.api_key');
    expect(config.defaultProfile).toBe('default');
  });

  it('names the file it belongs in', () => {
    expect(AI_CONFIG_FILENAME).toBe('ai.yaml');
  });
});

describe('round trip', () => {
  it('survives serialize → parse unchanged, for every field a profile can carry', () => {
    const parsed = parseAiConfig(serializeAiConfig(RICH));
    expect(errorsOf(parsed.issues)).toEqual([]);
    expect(parsed.config).toEqual(RICH);
  });

  it('keeps a temperature of 0 — the classic falsy-value round trip', () => {
    const parsed = parseAiConfig(serializeAiConfig(RICH));
    expect(parsed.config.profiles[0].temperature).toBe(0);
  });

  it('is canonical: serializing twice produces identical bytes', () => {
    const once = serializeAiConfig(RICH);
    const twice = serializeAiConfig(parseAiConfig(once).config);
    // Byte equality is what makes a settings save a no-op diff when nothing
    // changed, and makes a real change reviewable.
    expect(twice).toBe(once);
  });

  it('emits LF endings, one trailing newline and no trailing whitespace', () => {
    const text = serializeAiConfig(RICH);
    expect(text).not.toContain('\r');
    expect(text).not.toContain('\t');
    expect(text.endsWith('\n')).toBe(true);
    expect(text.endsWith('\n\n')).toBe(false);
    for (const line of text.split('\n')) expect(line).toBe(line.trimEnd());
  });

  it('leads with the warning that keeps credentials out of the file', () => {
    const text = serializeAiConfig(RICH);
    expect(text.startsWith('# Archspace AI model profiles.')).toBe(true);
    expect(text).toContain('apiKeyRef names a KEY in the OS keychain. Never paste a credential here.');
  });

  it('round trips the default config too', () => {
    const config = defaultAiConfig();
    expect(parseAiConfig(serializeAiConfig(config)).config).toEqual(config);
  });

  it('reads a hand-written file with comments and CRLF endings', () => {
    const handWritten = [
      '# my machine',
      'defaultProfile: local  # the one I actually use',
      'profiles:',
      '  - name: local',
      '    provider: ollama',
      '    model: llama3.1',
      '',
      '  - name: offline',
      '    provider: mock',
      '    model: mock-small',
      '',
    ].join('\r\n');

    const parsed = parseAiConfig(handWritten);

    expect(errorsOf(parsed.issues)).toEqual([]);
    expect(parsed.config).toEqual({
      profiles: [
        { name: 'local', provider: 'ollama', model: 'llama3.1' },
        { name: 'offline', provider: 'mock', model: 'mock-small' },
      ],
      defaultProfile: 'local',
    });
  });
});

describe('malformed input reports rather than throws', () => {
  const cases: [string, string, string][] = [
    ['a tab in the indentation', 'profiles:\n\t- name: a\n', 'tabs are not valid YAML indentation'],
    ['a flow collection', 'profiles: [a, b]\n', 'flow collections are not supported here'],
    ['a multi-document stream', '---\nprofiles:\n  - name: a\n', 'multi-document streams are not supported here'],
    ['a block scalar', 'defaultProfile: |\n  a\n', 'block scalars are not supported here'],
  ];

  it.each(cases)('turns %s into a located ConfigIssue', (_label, text, expected) => {
    const parsed = parseAiConfig(text);

    expect(parsed.issues).toHaveLength(1);
    expect(parsed.issues[0].severity).toBe('error');
    expect(parsed.issues[0].path).toBe(AI_CONFIG_FILENAME);
    expect(parsed.issues[0].message).toContain(expected);
    expect(parsed.issues[0].message).toMatch(/^line \d+: /);
    // The user's file is not rewritten and the session still has an AI.
    expect(parsed.issues[0].message).toContain('The file was left untouched');
    expect(parsed.config).toEqual(defaultAiConfig());
  });

  it('never throws, whatever it is handed', () => {
    for (const text of ['', '   ', '# only a comment\n', 'null\n', 'just a string\n', '- a\n- b\n', ':\n']) {
      expect(() => parseAiConfig(text)).not.toThrow();
      expect(parseAiConfig(text).config.profiles.length).toBeGreaterThan(0);
    }
  });

  it('treats an empty file as "not configured yet", not as an error', () => {
    expect(parseAiConfig('')).toEqual({ config: defaultAiConfig(), issues: [] });
  });

  it('reports a root that is not a mapping', () => {
    expect(parseAiConfig('- a\n- b\n').issues).toEqual([
      { severity: 'error', path: '', message: 'ai config must be a mapping; using defaults for this session' },
    ]);
  });

  it('reports a profiles key that is not a list', () => {
    const parsed = parseAiConfig('defaultProfile: a\nprofiles: nope\n');
    expect(parsed.issues.map((i) => i.path)).toEqual(['profiles', 'profiles']);
    expect(parsed.config).toEqual(defaultAiConfig());
  });
});

describe('validation keeps a broken profile and says what is wrong with it', () => {
  it('keeps a profile whose model is missing', () => {
    const { config, issues } = validateAiConfig({
      defaultProfile: 'a',
      profiles: [{ name: 'a', provider: 'ollama' }],
    });

    // Kept, so listProfiles() can show it as `invalid` with a reason, rather
    // than the binding silently vanishing from the user's settings.
    expect(config.profiles).toEqual([{ name: 'a', provider: 'ollama', model: '' }]);
    expect(issues).toContainEqual({ severity: 'error', path: 'profiles[0].model', message: 'a profile needs a model id' });
  });

  it('keeps the profile but drops a field it cannot use', () => {
    const { config, issues } = validateAiConfig({
      defaultProfile: 'a',
      profiles: [
        {
          name: 'a',
          provider: 'ollama',
          model: 'llama3.1',
          baseUrl: 'ftp://nope',
          temperature: 9,
          maxOutputTokens: 0,
          embeddingModel: '',
          headers: { good: 'yes', bad: 12 },
        },
      ],
    });

    expect(config.profiles[0]).toEqual({ name: 'a', provider: 'ollama', model: 'llama3.1', headers: { good: 'yes' } });
    expect(errorsOf(issues).map((i) => i.path)).toEqual([
      'profiles[0].baseUrl',
      'profiles[0].embeddingModel',
      'profiles[0].temperature',
      'profiles[0].maxOutputTokens',
      'profiles[0].headers.bad',
    ]);
  });

  it('drops only what cannot be represented at all', () => {
    const { config, issues } = validateAiConfig({
      defaultProfile: 'keeper',
      profiles: [
        { provider: 'ollama', model: 'm' },
        { name: 'openrouter', provider: 'openrouter', model: 'm' },
        'not a mapping',
        { name: 'keeper', provider: 'mock', model: 'mock-small' },
      ],
    });

    expect(config.profiles.map((p) => p.name)).toEqual(['keeper']);
    expect(errorsOf(issues).map((i) => i.path)).toEqual(['profiles[0].name', 'profiles[1].provider', 'profiles[2]']);
    expect(issues[1].message).toContain('expected one of anthropic, ollama, openai-compatible, mock');
  });

  it('ignores the later of two profiles with the same name', () => {
    const { config, issues } = validateAiConfig({
      defaultProfile: 'a',
      profiles: [
        { name: 'a', provider: 'mock', model: 'first' },
        { name: 'a', provider: 'mock', model: 'second' },
      ],
    });

    expect(config.profiles).toEqual([{ name: 'a', provider: 'mock', model: 'first' }]);
    expect(issues).toContainEqual({
      severity: 'error',
      path: 'profiles[1].name',
      message: 'duplicate profile name "a"; the later entry is ignored',
    });
  });

  it('normalises a baseUrl by dropping its trailing slashes', () => {
    const { config } = validateAiConfig({
      defaultProfile: 'a',
      profiles: [{ name: 'a', provider: 'openai-compatible', model: 'm', baseUrl: 'http://box:8000/v1///' }],
    });
    expect(config.profiles[0].baseUrl).toBe('http://box:8000/v1');
  });

  it('requires an endpoint from the provider that has no default', () => {
    const { issues } = validateAiConfig({
      defaultProfile: 'a',
      profiles: [{ name: 'a', provider: 'openai-compatible', model: 'm' }],
    });
    expect(issues).toContainEqual({
      severity: 'error',
      path: 'profiles[0].baseUrl',
      message: 'provider "openai-compatible" has no default endpoint — set baseUrl to the server you are running',
    });
  });

  it('warns rather than refuses on an unusual profile name', () => {
    // Profile names are workflow-visible identifiers, but a user who typed
    // "Fast Draft" gets a warning and a working binding, not a deleted one.
    const { config, issues } = validateAiConfig({
      defaultProfile: 'Fast Draft',
      profiles: [{ name: 'Fast Draft', provider: 'mock', model: 'mock-small' }],
    });
    expect(config.profiles[0].name).toBe('Fast Draft');
    expect(issues).toEqual([
      {
        severity: 'warning',
        path: 'profiles[0].name',
        message: '"Fast Draft" is an unusual profile name; prefer lowercase letters, digits, "_" and "-"',
      },
    ]);
  });

  it('falls back to the first profile when defaultProfile is missing or unknown', () => {
    for (const [given, expected] of [
      [undefined, 'defaultProfile is missing; falling back to "a"'],
      ['ghost', 'defaultProfile "ghost" is not one of the configured profiles; falling back to "a"'],
    ] as const) {
      const { config, issues } = validateAiConfig({
        ...(given !== undefined ? { defaultProfile: given } : {}),
        profiles: [{ name: 'a', provider: 'mock', model: 'mock-small' }],
      });
      expect(config.defaultProfile).toBe('a');
      expect(issues).toContainEqual({ severity: 'error', path: 'defaultProfile', message: expected });
    }
  });

  it('falls back to the shipped defaults when nothing usable survives', () => {
    const { config, issues } = validateAiConfig({ defaultProfile: 'a', profiles: [] });
    expect(config).toEqual(defaultAiConfig());
    expect(issues).toContainEqual({
      severity: 'error',
      path: 'profiles',
      message: 'no usable model profile; using defaults for this session',
    });
  });
});

describe('a profile carries a secret key, never a secret value', () => {
  const pasted = ['sk-ant-api03-not-a-real-key', 'xoxb-1234567890', 'ghp_abcdefghij', 'AIzaSyABCDEFG', 'a'.repeat(40)];

  it.each(pasted)('refuses %s as an apiKeyRef', (credential) => {
    const { config, issues } = validateAiConfig({
      defaultProfile: 'a',
      profiles: [{ name: 'a', provider: 'anthropic', model: 'm', apiKeyRef: credential }],
    });

    expect(config.profiles[0].apiKeyRef).toBeUndefined();
    expect(issues).toContainEqual({
      severity: 'error',
      path: 'profiles[0].apiKeyRef',
      message:
        'apiKeyRef looks like an API key itself — it must name a keychain entry, never hold the credential. Ignored',
    });
    // And the rejected value cannot come back out through the writer.
    expect(serializeAiConfig(config)).not.toContain(credential);
  });

  it('refuses a credential smuggled through a custom header', () => {
    const { config, issues } = validateAiConfig({
      defaultProfile: 'a',
      profiles: [{ name: 'a', provider: 'ollama', model: 'm', headers: { Authorization: 'sk-ant-api03-not-a-real-key' } }],
    });

    expect(config.profiles[0].headers).toBeUndefined();
    expect(issues).toContainEqual({
      severity: 'error',
      path: 'profiles[0].headers.Authorization',
      message: 'this header value looks like a credential; put it in the keychain and use apiKeyRef. Ignored',
    });
  });

  it('accepts an ordinary keychain key name', () => {
    const { config, issues } = validateAiConfig({
      defaultProfile: 'a',
      profiles: [{ name: 'a', provider: 'anthropic', model: 'm', apiKeyRef: 'ai.anthropic.api_key' }],
    });
    expect(config.profiles[0].apiKeyRef).toBe('ai.anthropic.api_key');
    expect(issues).toEqual([]);
  });

  it('warns when a key-needing provider names none', () => {
    const { issues } = validateAiConfig({
      defaultProfile: 'a',
      profiles: [{ name: 'a', provider: 'anthropic', model: 'm' }],
    });
    expect(issues).toEqual([
      {
        severity: 'warning',
        path: 'profiles[0].apiKeyRef',
        message: 'provider "anthropic" needs an API key; the profile will report "missing-key" until one is bound',
      },
    ]);
  });
});

describe('the embeddings warning', () => {
  it('fires for a provider that genuinely has no embeddings endpoint', () => {
    const { issues } = validateAiConfig({
      defaultProfile: 'a',
      profiles: [{ name: 'a', provider: 'anthropic', model: 'm', apiKeyRef: 'ai.key', embeddingModel: 'whatever' }],
    });
    expect(issues).toContainEqual({
      severity: 'warning',
      path: 'profiles[0].embeddingModel',
      message: 'provider "anthropic" has no embeddings endpoint; ctx.ai.embed will fail on this profile',
    });
  });

  it('stays quiet for Ollama and for the offline provider', () => {
    for (const provider of ['ollama', 'mock'] as const) {
      const { issues } = validateAiConfig({
        defaultProfile: 'a',
        profiles: [{ name: 'a', provider, model: 'm', embeddingModel: 'nomic-embed-text' }],
      });
      expect(issues).toEqual([]);
    }
  });

  /**
   * KNOWN FAILURE — a real defect in config.ts, left red on purpose.
   *
   * `validateProfile` derives "can this provider embed?" from
   * `descriptor.suggestedEmbeddingModels === undefined`, and the
   * `openai-compatible` catalogue entry deliberately carries no suggestions
   * because only the endpoint knows what it serves. So a correctly configured
   * vLLM or LM Studio profile is told
   *
   *     provider "openai-compatible" has no embeddings endpoint;
   *     ctx.ai.embed will fail on this profile
   *
   * which is false. `gateway.ts` embeds happily on that provider — see
   * `hasEmbeddings()`, which is written as an exhaustive switch precisely
   * *because* the catalogue field is a UI suggestion list and not a capability
   * flag, and whose comment says so in as many words:
   *
   *     "an arbitrary OpenAI-compatible endpoint legitimately serves
   *      /v1/embeddings while we cannot suggest a single model id for it"
   *
   * provider-calls.test.ts drives a real embeddings request through that path
   * offline, so the two files disagree about the same fact and the validator is
   * the one that is wrong. Worse, the warning fires exactly when the user has
   * done the right thing — named an embedding model on a self-hosted endpoint —
   * which is the one case §10 calls out as first-class.
   *
   * The fix is to ask the same question `hasEmbeddings()` asks (a capability on
   * the descriptor, or the switch itself), not to relax this assertion.
   */
  it('does not fire for an OpenAI-compatible endpoint, which the gateway can embed on', () => {
    const { issues } = validateAiConfig({
      defaultProfile: 'a',
      profiles: [
        { name: 'a', provider: 'openai-compatible', model: 'm', baseUrl: 'http://box:8000/v1', embeddingModel: 'text-embed' },
      ],
    });

    expect(issues).toEqual([]);
  });
});
