/**
 * Profiles, grouped by the provider they bind to (ARCHITECTURE §10 / ADR-0010).
 *
 * The settings panel shows one row per provider, but the data model is and
 * stays a flat list of named profiles: a workflow says `ai: [default]` and this
 * machine says what `default` means, so the profile — not the provider — is the
 * thing a document depends on. Grouping is therefore a VIEW, computed here and
 * never written back. `saveAiConfig` is a verbatim whole-file overwrite with no
 * merge (main/settings.ts), so a profile that fell out of a group on the way to
 * the screen would be a profile deleted from the user's file on the next save.
 * That is the invariant this module exists to make testable, and why
 * `groupProfilesByProvider` walks the PROFILES and never the catalogue: a loop
 * over `PROVIDERS` collecting matches cannot express "every profile appears
 * exactly once", while a loop over profiles cannot fail to.
 *
 * Pure on purpose — no React, no store, no three.js — for the reason
 * `vitest.config.ts` records about `drift.ts`: the app's suite runs under plain
 * node with no DOM, so logic that decides what the UI *claims* has to live
 * outside the component to be tested at all.
 */
import { PROVIDERS, providerById, type ModelProfile, type ProfileStatus, type ProviderDescriptor, type ProviderId } from '@archspace/ai-gateway';

/** One provider that has at least one profile bound to it on this machine. */
export interface ProviderGroup {
  id: ProviderId;
  descriptor: ProviderDescriptor;
  /** In the order the file lists them. */
  profiles: ModelProfile[];
  /**
   * The distinct keychain names this provider's profiles ask for, in profile
   * order. Usually one; more than one is legal and is why the collapsed row
   * refuses to draw a single key field — `apiKeyRef` is per profile, and one
   * input here would state the opposite of what the file says.
   */
  keyRefs: string[];
}

/**
 * Group in catalogue order, skipping providers nothing is bound to.
 *
 * `providerById` cannot miss: `ModelProfile.provider` is a `ProviderId`, and a
 * profile naming an id the catalogue does not carry is dropped by
 * `validateAiConfig` in main before it ever crosses the bridge. The lookup is
 * still written total rather than asserted, because the cost of being wrong
 * here is a profile vanishing from the screen and then from the file.
 */
export function groupProfilesByProvider(profiles: readonly ModelProfile[]): ProviderGroup[] {
  const byId = new Map<ProviderId, ProviderGroup>();
  for (const profile of profiles) {
    const descriptor = providerById(profile.provider);
    if (descriptor === undefined) continue;
    let group = byId.get(profile.provider);
    if (group === undefined) {
      group = { id: profile.provider, descriptor, profiles: [], keyRefs: [] };
      byId.set(profile.provider, group);
    }
    group.profiles.push(profile);
    if (profile.apiKeyRef !== undefined && !group.keyRefs.includes(profile.apiKeyRef)) {
      group.keyRefs.push(profile.apiKeyRef);
    }
  }
  // Catalogue order, so the list does not reshuffle when a profile is added.
  return PROVIDERS.map((p) => byId.get(p.id)).filter((g): g is ProviderGroup => g !== undefined);
}

/** Catalogue entries nothing is bound to — the "add one of these" affordance. */
export function unboundProviders(profiles: readonly ModelProfile[]): ProviderDescriptor[] {
  const bound = new Set(profiles.map((p) => p.provider));
  return PROVIDERS.filter((p) => !bound.has(p.id));
}

/**
 * The providers whose entire setup is "paste a key".
 *
 * These are shown ALWAYS, bound or not, because asking someone to add a
 * provider before they can give it a key is a step that exists only in the
 * data model: a hosted vendor that needs a key and nothing else has no
 * decision in it worth a click. Everything else — a local Ollama, a
 * self-hosted endpoint — genuinely does need choosing, and stays behind Add.
 *
 * Derived from the catalogue rather than listed here, so a fourth hosted
 * vendor appears on this screen the day it gets a descriptor.
 */
export function keyOnlyProviders(): ProviderDescriptor[] {
  return PROVIDERS.filter((p) => p.kind === 'cloud' && p.needsApiKey && !p.needsBaseUrl);
}

/** Those of them this machine has no profile for yet. */
export function unboundKeyProviders(profiles: readonly ModelProfile[]): ProviderDescriptor[] {
  const bound = new Set(profiles.map((p) => p.provider));
  return keyOnlyProviders().filter((p) => !bound.has(p.id));
}

/**
 * Worst readiness first, so one collapsed row can speak for several profiles.
 *
 * Ordered by how much it stops a run: an invalid binding fails before anything
 * is called, an unreachable one fails at the call, a missing key is a thing the
 * user can fix in this panel, `unknown` is an absence of information, and
 * `ready` is the only good news. A row summarising two profiles must show the
 * bad one — the opposite rounding would let a broken binding hide behind a
 * working sibling, which is the one direction a status display must never fail.
 */
const READINESS_ORDER: ProfileStatus['readiness'][] = [
  'invalid',
  'unreachable',
  'missing-key',
  'unknown',
  'ready',
];

export function worstReadiness(
  readinesses: readonly ProfileStatus['readiness'][],
): ProfileStatus['readiness'] | null {
  for (const candidate of READINESS_ORDER) {
    if (readinesses.includes(candidate)) return candidate;
  }
  return null;
}
