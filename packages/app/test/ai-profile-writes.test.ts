/**
 * The AI panel can no longer SHOW temperature, embedding models, token budgets
 * or headers — so this pins that it cannot DESTROY them either.
 *
 * The panel writes by spreading a change over the existing profile and handing
 * the result to `validateAiConfig`, then persisting the validator's canonical
 * form rather than the object it built. Both halves have to preserve fields the
 * UI knows nothing about, and the second half is the one worth testing: a
 * validator that dropped an attribute it could not place would turn "I changed
 * the model" into "my hand-written ai.yaml lost its headers", silently, on a
 * whole-file overwrite with no backup.
 *
 * This is the closest a node-environment test can get to that write path — the
 * spread itself lives in a React component this suite cannot mount (there is no
 * jsdom here by design, see vitest.config.ts) — so the spread is reproduced
 * exactly as the panel performs it.
 */
import { describe, expect, it } from 'vitest';
import { validateAiConfig, type ModelProfile } from '@archspace/ai-gateway';

/** A profile using every field the panel cannot render. */
const RICH: ModelProfile = {
  name: 'default',
  provider: 'google',
  model: 'gemini-2.5-flash',
  apiKeyRef: 'ai.google.api_key',
  embeddingModel: 'text-embedding-004',
  temperature: 0.2,
  maxOutputTokens: 4096,
  headers: { 'x-team': 'aec' },
};

/** Exactly what AiPanel's `updateProfile` builds before validating. */
function panelWrite(profile: ModelProfile, change: Partial<ModelProfile>) {
  return validateAiConfig({
    profiles: [{ ...profile, ...change }],
    defaultProfile: profile.name,
  });
}

describe('the panel write path', () => {
  it('keeps every field the UI cannot show when the model changes', () => {
    const { config, issues } = panelWrite(RICH, { model: 'gemini-2.5-pro' });

    expect(issues.filter((i) => i.severity === 'error')).toEqual([]);
    expect(config.profiles[0]).toEqual({ ...RICH, model: 'gemini-2.5-pro' });
  });

  it('keeps them when only the key reference is renamed', () => {
    // The "that key name belongs to another provider" fix, which writes one
    // field on a profile carrying seven.
    const { config } = panelWrite({ ...RICH, apiKeyRef: 'ai.anthropic.api_key' }, {
      apiKeyRef: 'ai.google.api_key',
    });

    expect(config.profiles[0]).toEqual(RICH);
  });

  it('drops an endpoint when the field is cleared, and nothing else with it', () => {
    const withUrl: ModelProfile = { ...RICH, baseUrl: 'https://proxy.internal/v1' };

    const { config } = panelWrite(withUrl, { baseUrl: undefined });

    expect(config.profiles[0]?.baseUrl).toBeUndefined();
    expect(config.profiles[0]).toEqual(RICH);
  });

  it('refuses a blank model rather than writing one the gateway calls invalid', () => {
    // The row's Save is disabled on a blank model, but the validator is the
    // boundary that has to hold — it is what `persist` consults before writing.
    const { issues } = panelWrite(RICH, { model: '' });

    expect(issues.some((i) => i.severity === 'error' && i.path.endsWith('.model'))).toBe(true);
  });

  it('refuses a self-hosted profile with no endpoint, which is why that one has a form', () => {
    const compatible: ModelProfile = { name: 'local', provider: 'openai-compatible', model: 'm' };

    const { issues } = panelWrite(compatible, {});

    expect(issues.some((i) => i.severity === 'error' && i.path.endsWith('.baseUrl'))).toBe(true);
  });
});
