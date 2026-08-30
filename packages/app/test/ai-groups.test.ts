/**
 * Grouping profiles for the settings panel.
 *
 * The case that matters is the permutation one. The panel renders provider
 * rows, but `saveAiConfig` overwrites `ai.yaml` wholesale with no merge — so a
 * profile the grouping silently dropped would be a profile deleted from the
 * user's file the next time they pressed Save on something unrelated. That is
 * data loss caused by a display function, which is exactly the class a display
 * function is never suspected of, so it is pinned here rather than trusted.
 */
import { describe, expect, it } from 'vitest';
import { PROVIDERS, type ModelProfile } from '@archspace/ai-gateway';
import { groupProfilesByProvider, unboundProviders, worstReadiness } from '../src/renderer/src/ai-groups.js';

const profile = (name: string, provider: ModelProfile['provider'], over: Partial<ModelProfile> = {}): ModelProfile => ({
  name,
  provider,
  model: 'm',
  ...over,
});

describe('groupProfilesByProvider', () => {
  it('keeps every profile exactly once, whatever the order in', () => {
    const profiles = [
      profile('work', 'openai'),
      profile('default', 'anthropic'),
      profile('local', 'ollama'),
      profile('fast', 'openai'),
      profile('cheap', 'anthropic'),
    ];

    const groups = groupProfilesByProvider(profiles);
    const flattened = groups.flatMap((g) => g.profiles.map((p) => p.name));

    expect(flattened).toHaveLength(profiles.length);
    expect([...flattened].sort()).toEqual([...profiles.map((p) => p.name)].sort());
  });

  it('preserves file order within a provider', () => {
    const groups = groupProfilesByProvider([
      profile('second', 'openai'),
      profile('other', 'google'),
      profile('first', 'openai'),
    ]);

    const openai = groups.find((g) => g.id === 'openai');
    expect(openai?.profiles.map((p) => p.name)).toEqual(['second', 'first']);
  });

  it('emits groups in catalogue order, not in the order profiles appear', () => {
    // The list must not reshuffle when a profile is added, so the order comes
    // from providers.ts rather than from whatever the file happens to say.
    const groups = groupProfilesByProvider([profile('a', 'mock'), profile('b', 'anthropic')]);
    const catalogue = PROVIDERS.map((p) => p.id);

    expect(groups.map((g) => g.id)).toEqual(
      catalogue.filter((id) => id === 'anthropic' || id === 'mock'),
    );
  });

  it('collects distinct key refs in profile order, and omits profiles that name none', () => {
    const groups = groupProfilesByProvider([
      profile('a', 'openai', { apiKeyRef: 'ai.openai.api_key' }),
      profile('b', 'openai'),
      profile('c', 'openai', { apiKeyRef: 'ai.work.api_key' }),
      profile('d', 'openai', { apiKeyRef: 'ai.openai.api_key' }),
    ]);

    expect(groups[0]?.keyRefs).toEqual(['ai.openai.api_key', 'ai.work.api_key']);
  });

  it('accounts for every catalogue entry between bound and unbound', () => {
    const profiles = [profile('a', 'anthropic')];

    const groups = groupProfilesByProvider(profiles);
    const unbound = unboundProviders(profiles);

    expect(groups.length + unbound.length).toBe(PROVIDERS.length);
    // No provider may appear in both halves, or the panel would offer to add
    // one it is already showing.
    const ids = new Set([...groups.map((g) => g.id), ...unbound.map((d) => d.id)]);
    expect(ids.size).toBe(PROVIDERS.length);
  });

  it('groups nothing when nothing is bound, and offers every provider', () => {
    expect(groupProfilesByProvider([])).toEqual([]);
    expect(unboundProviders([]).map((d) => d.id)).toEqual(PROVIDERS.map((p) => p.id));
  });
});

describe('worstReadiness', () => {
  it('reports the worst, never the most common or the first', () => {
    // A broken binding hiding behind a working sibling is the one direction a
    // rolled-up status must never fail in.
    expect(worstReadiness(['ready', 'ready', 'missing-key'])).toBe('missing-key');
    expect(worstReadiness(['missing-key', 'invalid'])).toBe('invalid');
    expect(worstReadiness(['ready', 'unreachable', 'unknown'])).toBe('unreachable');
    expect(worstReadiness(['unknown', 'ready'])).toBe('unknown');
  });

  it('says ready only when everything is', () => {
    expect(worstReadiness(['ready', 'ready'])).toBe('ready');
  });

  it('has no answer for no profiles, rather than a cheerful one', () => {
    expect(worstReadiness([])).toBeNull();
  });
});
