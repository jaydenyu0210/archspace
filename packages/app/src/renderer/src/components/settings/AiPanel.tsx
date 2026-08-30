/**
 * AI model profiles — this machine's half of the portability contract
 * (ARCHITECTURE §10 / ADR-0010).
 *
 * A workflow says `ai: [default]`. *This machine* says what `default` means,
 * and that is the only reason a document from a colleague on Anthropic runs
 * unchanged against a local Ollama. So this panel is not "AI settings": it is
 * the editor for one side of a contract the document depends on, which is why
 * it shows the readiness of every binding next to the binding itself.
 *
 * **Shape: one row per provider, and the row IS the editor.** The panel used to
 * render five stacked sections — a profile list with every field expanded, a
 * separate key manager, and the whole provider catalogue with its prose — about
 * 1,700px of mostly-static text for a machine with two bindings.
 *
 * A binding needs exactly three things the user must supply: a provider, a
 * model id (`validateAiConfig` makes a blank one an error, and there is no
 * honest cross-provider default) and, for a cloud provider, a key. So the row
 * carries all three — provider on the head line, model and key as fields
 * beneath it — and the eight-field form is reached only through `Details`,
 * where the things almost nobody sets live: profile name, endpoint,
 * temperature, token budget, embedding model. Binding a provider is one click
 * on its name, which writes the catalogue's first model and the generated key
 * name; `openai-compatible` is the exception and opens the form, because it
 * ships no suggested models on purpose and requires an endpoint, so a one-click
 * bind there could only ever produce a refused save.
 *
 * Nothing was deleted from the data model: the grouping is a view, computed in
 * `ai-groups.ts` and tested there, and the write path below never sees a group.
 *
 * That last point is load-bearing. `saveAiConfig` is a verbatim whole-file
 * overwrite with no merge, so a profile the grouping dropped on the way to the
 * screen would be a profile deleted from the user's file the next time they
 * pressed Save on something unrelated. `groupProfilesByProvider` therefore
 * walks the profiles, never the catalogue, and the header counter states
 * profiles AND providers so a file with four bindings on two providers cannot
 * read as two bindings.
 *
 * Four lines are load-bearing here and each one shapes the markup:
 *
 *  1. **Config and status come from different owners.** The profile LIST is
 *     read from `getAiConfig()` — the file, owned by main — because the user
 *     must be able to edit `ai.yaml` while the engine is dead. The READINESS
 *     comes from `store.aiProfiles`, an engine mirror (§3.2) that is empty
 *     until the engine reports. Empty therefore never renders as "nothing
 *     configured"; with `engineReady === false` every row says the readiness
 *     is unknown, because saying otherwise is the honesty rule's failure mode.
 *  2. **`ready` is not `works`, and "bound" is not "connected".**
 *     `listProfiles()` makes no network call (status.ts) — it can only prove
 *     the binding resolves. So the badge says `bound`, never `connected`, and
 *     the only thing in this panel that may claim a provider answered is a
 *     probe, which earns the claim by printing the text the model returned.
 *     `Test` sits on the collapsed row precisely because it is the one control
 *     that answers "is this actually working".
 *  3. **Secrets are write-only from here.** The bridge deliberately has no
 *     `getSecret` (preload/index.ts header, §12): the renderer may create,
 *     list and delete key NAMES and can never read a value back. So the key
 *     field is a write-only input that is cleared the moment it is stored, and
 *     what the UI reports is existence and creation time — never a value, not
 *     even the one it just sent.
 *  4. **A key belongs to a profile, not to a provider.** When one provider's
 *     profiles name different `apiKeyRef`s the row shows a count and refuses to
 *     draw a single key field, because one field there would state the
 *     opposite of what the file says. Any later tidy-up that collapses that
 *     branch reintroduces the lie.
 *
 * The provider catalogue is rendered FROM `PROVIDERS` rather than from a list
 * written into this view, so "which providers exist, and what does each one
 * need" stays answered by data in one file (providers.ts) instead of by a
 * switch here that drifts. `ProviderDescriptor.kind` is surfaced in plain
 * words rather than as jargon: a user deciding between a cloud profile and a
 * local one is deciding whether their drawing leaves the machine, and the
 * `mock` provider — a real entry with `kind: 'test'` — is marked everywhere it
 * can appear, because a scripted answer that looked like a working cloud
 * integration is exactly the lie this codebase refuses to tell. Its
 * default-profile consequence is the one sentence that survives the fold.
 *
 * Writes go through `setAiConfig`, but main writes the file verbatim and only
 * validates on the way back IN — so this panel runs the same `validateAiConfig`
 * BEFORE persisting and refuses to write anything the next load would silently
 * rewrite. Errors block; warnings are shown and kept, matching config.ts's rule
 * that a broken profile is reported, not dropped.
 */

import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  PROVIDERS,
  providerById,
  validateAiConfig,
  type AiGatewayConfig,
  type ConfigIssue,
  type ModelProfile,
  type ProfileProbeResult,
  type ProfileStatus,
  type ProviderDescriptor,
  type ProviderId,
} from '@archspace/ai-gateway';
import { useStore } from '../../store';
import { probeAiProfile, requestEngineStatus } from '../../engine-client';
import { groupProfilesByProvider, unboundProviders, worstReadiness } from '../../ai-groups';
import type { SecretKeyInfo } from '../../../../shared/protocol';
import type { SettingsPanelProps } from '../Settings';


// ---------------------------------------------------------------------------
// Vocabulary: what a state means, in words a user can act on
// ---------------------------------------------------------------------------

/** Readiness → the row's left stripe. Same idiom as the canvas node's status. */
function stripeClass(readiness: ProfileStatus['readiness'] | null): string {
  switch (readiness) {
    case 'ready':
      return 'is-ok';
    case 'missing-key':
      return 'is-warn';
    case 'unreachable':
    case 'invalid':
      return 'is-error';
    default:
      return 'is-muted';
  }
}

function badgeClass(readiness: ProfileStatus['readiness']): string {
  switch (readiness) {
    case 'ready':
      return 'badge badge--ok';
    case 'missing-key':
      return 'badge badge--warn';
    case 'unreachable':
    case 'invalid':
      return 'badge badge--error';
    case 'unknown':
      return 'badge badge--muted';
  }
}

/**
 * `bound`, not `connected`. Nothing this panel computes has spoken to a
 * provider — see the header's second load-bearing line — and a word that
 * implied otherwise would be a claim the panel had not paid for.
 */
const READINESS_LABEL: Record<ProfileStatus['readiness'], string> = {
  ready: 'bound',
  'missing-key': 'missing key',
  unreachable: 'unreachable',
  unknown: 'unknown',
  invalid: 'invalid',
};

/**
 * What the readiness MEANS. `detail` from the engine is shown alongside this,
 * not instead of it: the engine's sentence explains this profile, and this one
 * explains the state — including, for `missing-key`, the exact key name the
 * profile expects, which is the single fact needed to fix it.
 *
 * Not rendered for `ready`: the badge already says that, and a sentence
 * repeating a badge is the crowding this panel was reshaped to remove.
 */
function explainReadiness(status: ProfileStatus, profile: ModelProfile): string {
  switch (status.readiness) {
    case 'ready':
      return 'Provider, model and key all resolve on this machine. That is a check of the binding, not of the provider — test it to see whether anything answers.';
    case 'missing-key':
      return profile.apiKeyRef === undefined
        ? `This provider needs an API key and the profile names none. Give it a key reference (a name like "ai.${profile.provider}.api_key"), then store a value for that name.`
        : `No value is stored under the key "${profile.apiKeyRef}" on this machine. That name is what this profile asks the keychain for — store a value for exactly that key.`;
    case 'unreachable':
      return 'A real call to the provider did not get through. The binding is complete; the endpoint, the network or the credential is not.';
    case 'unknown':
      return 'The engine could not work out whether this binding resolves.';
    case 'invalid':
      return 'The binding itself is wrong — a missing model id or an endpoint this provider cannot use. Runs asking for this profile will fail before they call anything.';
  }
}

/** Plain words for `ProviderDescriptor.kind`: does my data leave this machine? */
function kindSentence(kind: ProviderDescriptor['kind']): string {
  switch (kind) {
    case 'cloud':
      return 'Cloud — prompts, and whatever a node puts in them, leave this machine.';
    case 'local':
      return 'Local — calls go to an endpoint you run; nothing leaves this machine unless that endpoint is remote.';
    case 'test':
      return 'Offline test provider — scripted answers, no network call of any kind.';
  }
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** `docsUrl` is an upstream URL for real providers and a repo path for `mock`. */
function isExternalUrl(url: string): boolean {
  return /^https?:\/\//.test(url);
}

// ---------------------------------------------------------------------------
// The profile editor's draft: strings, because a half-typed number is a string
// ---------------------------------------------------------------------------

interface Draft {
  /** Name of the profile being replaced; null when this is a new one. */
  original: string | null;
  name: string;
  provider: ProviderId;
  model: string;
  baseUrl: string;
  apiKeyRef: string;
  embeddingModel: string;
  temperature: string;
  maxOutputTokens: string;
  /**
   * Carried through untouched. `headers` is hand-edited in `ai.yaml` and has no
   * editor here; dropping it on the way through this form would delete a user's
   * work as a side effect of renaming a profile.
   */
  headers?: Record<string, string>;
}

function draftFor(profile: ModelProfile): Draft {
  return {
    original: profile.name,
    name: profile.name,
    provider: profile.provider,
    model: profile.model,
    baseUrl: profile.baseUrl ?? '',
    apiKeyRef: profile.apiKeyRef ?? '',
    embeddingModel: profile.embeddingModel ?? '',
    temperature: profile.temperature === undefined ? '' : String(profile.temperature),
    maxOutputTokens: profile.maxOutputTokens === undefined ? '' : String(profile.maxOutputTokens),
    ...(profile.headers ? { headers: profile.headers } : {}),
  };
}

function blankDraft(): Draft {
  const anthropic = providerById('anthropic');
  return {
    original: null,
    name: '',
    provider: anthropic?.id ?? PROVIDERS[0].id,
    model: '',
    baseUrl: '',
    apiKeyRef: '',
    embeddingModel: '',
    temperature: '',
    maxOutputTokens: '',
  };
}

/**
 * A name for a profile being added for a named provider.
 *
 * `default` first, and not as a nicety: every AI node's `profile` param
 * defaults to the literal string `default` (nodes-core/ai-common.ts), and the
 * gateway resolves that name exactly — so a machine whose first profile is
 * called something else answers every out-of-the-box workflow with "unknown
 * profile". Once `default` is taken the provider id is the obvious second
 * choice, then a numbered suffix; all three are shown in the editor's Name
 * field before anything is written, because a generated name the user never
 * saw is a name they cannot later recognise in a workflow.
 */
function suggestProfileName(existing: readonly ModelProfile[], id: ProviderId): string {
  const taken = new Set(existing.map((p) => p.name));
  if (!taken.has('default')) return 'default';
  if (!taken.has(id)) return id;
  for (let n = 2; ; n++) {
    const candidate = `${id}-${n}`;
    if (!taken.has(candidate)) return candidate;
  }
}

type NumberField = { kind: 'blank' } | { kind: 'value'; value: number } | { kind: 'bad' };

function optionalNumber(raw: string, integer: boolean): NumberField {
  const text = raw.trim();
  if (text === '') return { kind: 'blank' };
  const value = Number(text);
  if (!Number.isFinite(value)) return { kind: 'bad' };
  if (integer && !Number.isInteger(value)) return { kind: 'bad' };
  return { kind: 'value', value };
}

/**
 * Draft → profile. Only the errors that stop a profile being *built* live here;
 * everything else (name shape, credential-shaped key refs, a `baseUrl` this
 * provider requires) is left to `validateAiConfig`, which is the same check the
 * file will get on its way back in and therefore the one worth showing.
 */
function draftToProfile(draft: Draft): { profile: ModelProfile | null; errors: string[] } {
  const errors: string[] = [];
  const name = draft.name.trim();
  const model = draft.model.trim();
  if (name === '') errors.push('A profile needs a name — it is what a workflow will ask for.');
  if (model === '') errors.push('A profile needs a model id.');

  const temperature = optionalNumber(draft.temperature, false);
  if (temperature.kind === 'bad') errors.push('Temperature must be a number, or blank.');
  const maxOutputTokens = optionalNumber(draft.maxOutputTokens, true);
  if (maxOutputTokens.kind === 'bad') errors.push('Max output tokens must be a whole number, or blank.');

  if (errors.length > 0) return { profile: null, errors };

  const baseUrl = draft.baseUrl.trim();
  const apiKeyRef = draft.apiKeyRef.trim();
  const embeddingModel = draft.embeddingModel.trim();
  return {
    profile: {
      name,
      provider: draft.provider,
      model,
      ...(baseUrl === '' ? {} : { baseUrl }),
      ...(apiKeyRef === '' ? {} : { apiKeyRef }),
      ...(embeddingModel === '' ? {} : { embeddingModel }),
      ...(temperature.kind === 'value' ? { temperature: temperature.value } : {}),
      ...(maxOutputTokens.kind === 'value' ? { maxOutputTokens: maxOutputTokens.value } : {}),
      ...(draft.headers ? { headers: draft.headers } : {}),
    },
    errors,
  };
}

// ---------------------------------------------------------------------------

export function AiPanel(props: SettingsPanelProps) {
  const engineReady = useStore((s) => s.engineReady);
  const aiProfiles = useStore((s) => s.aiProfiles);
  const notify = useStore((s) => s.notify);

  const [config, setConfig] = useState<AiGatewayConfig | null>(null);
  const [configError, setConfigError] = useState<string | null>(null);
  /** What the validator objected to in the file on disk. See LoadedConfig. */
  const [configIssues, setConfigIssues] = useState<string[]>([]);

  const [secretKeys, setSecretKeys] = useState<SecretKeyInfo[] | null>(null);
  const [secretsError, setSecretsError] = useState<string | null>(null);
  /** Write-only, per key name, cleared the instant a value is accepted. */
  const [keyDrafts, setKeyDrafts] = useState<Record<string, string>>({});
  const [keyBusy, setKeyBusy] = useState<string | null>(null);
  /**
   * The model id being typed on a row, per profile name.
   *
   * Model and key are the whole of what a working binding needs beyond the
   * provider, so both are edited on the row itself and the eight-field form is
   * reached only through Details. Kept as a draft rather than written on every
   * keystroke because `saveAiConfig` is a verbatim whole-file overwrite with no
   * backup: every write stays behind a button someone pressed.
   */
  const [modelDrafts, setModelDrafts] = useState<Record<string, string>>({});

  const [draft, setDraft] = useState<Draft | null>(null);
  const [draftErrors, setDraftErrors] = useState<string[]>([]);
  const [issues, setIssues] = useState<ConfigIssue[]>([]);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState<string | null>(null);

  const [probes, setProbes] = useState<Record<string, ProfileProbeResult>>({});
  const [probing, setProbing] = useState<string | null>(null);

  /** Which provider rows are open. Collapsed is the resting state. */
  const [expanded, setExpanded] = useState<Set<ProviderId>>(new Set());
  const toggleExpanded = (id: ProviderId): void =>
    setExpanded((open) => {
      const next = new Set(open);
      if (!next.delete(id)) next.add(id);
      return next;
    });

  // The editor renders below the list, and the dialog body scrolls: on a long
  // list, "Edit" would otherwise open a form the user cannot see.
  const editorRef = useRef<HTMLDivElement>(null);
  const editing = draft !== null;
  useEffect(() => {
    if (editing) editorRef.current?.scrollIntoView({ block: 'nearest' });
  }, [editing]);

  const loadConfig = useCallback(() => {
    setConfigError(null);
    void window.archspace
      .getAiConfig()
      .then((loaded) => {
        setConfig(loaded.config);
        setConfigIssues(loaded.issues);
      })
      .catch((err: unknown) => setConfigError(errText(err)));
  }, []);

  const loadSecretKeys = useCallback(() => {
    setSecretsError(null);
    void window.archspace
      .listSecretKeys()
      .then(setSecretKeys)
      .catch((err: unknown) => setSecretsError(errText(err)));
  }, []);

  useEffect(() => {
    loadConfig();
    loadSecretKeys();
    // The dialog is mounted per opening (App.tsx), so this is the moment to ask
    // the engine to re-report: readiness may have changed since it last pushed
    // — a key stored from another panel, a config edited by hand. Silent no-op
    // when the engine is not connected.
    requestEngineStatus();
  }, [loadConfig, loadSecretKeys]);

  /**
   * Re-read everything this panel shows.
   *
   * The old panel's only reload sat inside the `configError` branch, so a file
   * that READ fine but parsed badly — the case the issues list is about — had
   * no route back except closing the dialog. Disabled while a draft is open,
   * because reloading under an unsaved edit would discard it silently.
   */
  const reload = useCallback(() => {
    loadConfig();
    loadSecretKeys();
    requestEngineStatus();
  }, [loadConfig, loadSecretKeys]);

  const statusByName = useMemo(() => {
    const map = new Map<string, ProfileStatus>();
    for (const status of aiProfiles) map.set(status.name, status);
    return map;
  }, [aiProfiles]);

  const keyInfoByName = useMemo(() => {
    const map = new Map<string, SecretKeyInfo>();
    for (const info of secretKeys ?? []) map.set(info.key, info);
    return map;
  }, [secretKeys]);

  const groups = useMemo(() => groupProfilesByProvider(config?.profiles ?? []), [config]);
  const unbound = useMemo(() => unboundProviders(config?.profiles ?? []), [config]);

  /** Every key name this config asks the keychain for, in profile order. */
  const referencedKeys = useMemo(() => {
    const names: string[] = [];
    for (const profile of config?.profiles ?? []) {
      if (profile.apiKeyRef !== undefined && !names.includes(profile.apiKeyRef)) names.push(profile.apiKeyRef);
    }
    return names;
  }, [config]);

  const unreferencedKeys = useMemo(
    () => (secretKeys ?? []).filter((info) => !referencedKeys.includes(info.key)),
    [secretKeys, referencedKeys],
  );

  /**
   * The one write path. Validates first with the very validator the file will
   * meet on reload, so nothing is written that would come back different — and
   * persists the validator's own canonical form for the same reason.
   */
  const persist = useCallback(
    async (next: AiGatewayConfig, done: string): Promise<boolean> => {
      const verdict = validateAiConfig(next);
      setIssues(verdict.issues);
      if (verdict.issues.some((i) => i.severity === 'error')) {
        setSaveError(null);
        return false;
      }
      setSaving(true);
      setSaveError(null);
      try {
        const result = await window.archspace.setAiConfig(verdict.config);
        if (!result.ok) {
          setSaveError(result.error);
          return false;
        }
        // Read back rather than trust the object we sent: the file is the
        // record, and this panel should be showing what is in it.
        const reloaded = await window.archspace.getAiConfig();
        setConfig(reloaded.config);
        setConfigIssues(reloaded.issues);
        requestEngineStatus();
        notify('info', done);
        return true;
      } catch (err) {
        setSaveError(errText(err));
        return false;
      } finally {
        setSaving(false);
      }
    },
    [notify],
  );

  const openDraft = (next: Draft): void => {
    setDraft(next);
    setDraftErrors([]);
    setIssues([]);
    setSaveError(null);
  };

  /**
   * Start a profile for one provider, with the fields the editor will show
   * filled in. Only visible fields are pre-filled — a value written into
   * `ai.yaml` that never appeared on screen is a value the user cannot account
   * for later.
   */
  const addForProvider = (descriptor: ProviderDescriptor): void => {
    openDraft({
      ...blankDraft(),
      name: suggestProfileName(config?.profiles ?? [], descriptor.id),
      provider: descriptor.id,
      model: descriptor.suggestedModels[0] ?? '',
      apiKeyRef: descriptor.needsApiKey ? `ai.${descriptor.id}.api_key` : '',
    });
    setExpanded((open) => new Set(open).add(descriptor.id));
  };

  /**
   * Can this provider be bound in one click, with nothing left to guess?
   *
   * Only when the catalogue supplies a model AND the provider has a default
   * endpoint. `validateAiConfig` makes both an ERROR rather than a warning — a
   * blank model and a missing `baseUrl` on a `needsBaseUrl` provider each
   * refuse the write — so a one-click bind for `openai-compatible`, which ships
   * no suggested models on purpose (only the endpoint knows what it serves),
   * could only ever produce a refused save. That provider opens the form
   * instead, which is the honest version of the same gesture.
   */
  const canBindDirectly = (descriptor: ProviderDescriptor): boolean =>
    descriptor.suggestedModels.length > 0 && !descriptor.needsBaseUrl;

  /**
   * Bind a provider straight from its button: one profile, the catalogue's
   * first model, and the generated key name. Everything written appears on the
   * row a moment later, and Remove undoes it — which is what makes writing on
   * a single click reasonable here rather than presumptuous.
   */
  const bindProvider = (descriptor: ProviderDescriptor): void => {
    if (config === null) return;
    if (!canBindDirectly(descriptor)) {
      addForProvider(descriptor);
      return;
    }
    const profile: ModelProfile = {
      name: suggestProfileName(config.profiles, descriptor.id),
      provider: descriptor.id,
      model: descriptor.suggestedModels[0],
      ...(descriptor.needsApiKey ? { apiKeyRef: `ai.${descriptor.id}.api_key` } : {}),
    };
    // A config whose defaultProfile names nothing is refused by the validator,
    // so the first binding on a machine also becomes the default.
    const keepsDefault = config.profiles.some((p) => p.name === config.defaultProfile);
    void persist(
      {
        profiles: [...config.profiles, profile],
        defaultProfile: keepsDefault ? config.defaultProfile : profile.name,
      },
      `Added the "${profile.name}" profile.`,
    );
  };

  /** The model id showing on a row: what is being typed, else what is saved. */
  const modelValue = (profile: ModelProfile): string => modelDrafts[profile.name] ?? profile.model;

  const saveModel = (profile: ModelProfile): void => {
    if (config === null) return;
    const model = modelValue(profile).trim();
    if (model === '' || model === profile.model) return;
    void persist(
      {
        profiles: config.profiles.map((p) => (p.name === profile.name ? { ...p, model } : p)),
        defaultProfile: config.defaultProfile,
      },
      `"${profile.name}" now uses ${model}.`,
    ).then((ok) => {
      if (ok) setModelDrafts((d) => ({ ...d, [profile.name]: model }));
    });
  };

  const saveDraft = () => {
    if (config === null || draft === null) return;
    const { profile, errors: problems } = draftToProfile(draft);
    setDraftErrors(problems);
    if (profile === null) return;

    const clashes = config.profiles.some((p) => p.name === profile.name && p.name !== draft.original);
    if (clashes) {
      setDraftErrors([`There is already a profile called "${profile.name}". Profile names are what workflows resolve, so they have to be unique.`]);
      return;
    }

    const profiles =
      draft.original === null
        ? [...config.profiles, profile]
        : config.profiles.map((p) => (p.name === draft.original ? profile : p));
    // A rename carries the default with it: the user renamed a binding, they
    // did not ask for a different one to become default behind their back.
    const defaultProfile = config.defaultProfile === draft.original ? profile.name : config.defaultProfile;
    void persist({ profiles, defaultProfile }, `Saved the "${profile.name}" profile.`).then((ok) => {
      if (ok) {
        setDraft(null);
        setDraftErrors([]);
      }
    });
  };

  const removeProfile = (name: string) => {
    if (config === null) return;
    const profiles = config.profiles.filter((p) => p.name !== name);
    // Removing the LAST profile is deliberately not special-cased: `persist`
    // runs the same validator the file meets on the way back in, and that
    // validator already refuses a config with no usable profile. One rule,
    // stated in one place, refusing in the words the file itself would use.
    const defaultProfile =
      config.defaultProfile === name ? (profiles[0]?.name ?? config.defaultProfile) : config.defaultProfile;
    void persist({ profiles, defaultProfile }, `Removed the "${name}" profile.`).then((ok) => {
      if (ok) {
        setConfirmRemove(null);
        if (draft?.original === name) setDraft(null);
      }
    });
  };

  const makeDefault = (name: string) => {
    if (config === null) return;
    void persist({ profiles: config.profiles, defaultProfile: name }, `"${name}" is now the default profile.`);
  };

  const runProbe = (name: string) => {
    setProbing(name);
    void probeAiProfile(name)
      .then((result) => setProbes((p) => ({ ...p, [name]: result })))
      .catch((err: unknown) =>
        // Only a dead engine rejects (engine-client), so this is not a probe
        // result at all — but it is still what happened, said plainly.
        setProbes((p) => ({ ...p, [name]: { profile: name, ok: false, error: errText(err) } })),
      )
      .finally(() => setProbing(null));
  };

  const storeSecret = (key: string) => {
    const value = keyDrafts[key] ?? '';
    if (value === '') return;
    setKeyBusy(key);
    setSecretsError(null);
    void window.archspace
      .setSecret(key, value)
      .then((result) => {
        if (!result.ok) {
          setSecretsError(result.error);
          return;
        }
        // Cleared, not re-rendered: the value is gone from the renderer the
        // moment main has it, and nothing here can ever read it back.
        setKeyDrafts((d) => ({ ...d, [key]: '' }));
        loadSecretKeys();
        requestEngineStatus();
        notify('info', `Stored a value for "${key}" in the OS keychain.`);
      })
      .catch((err: unknown) => setSecretsError(errText(err)))
      .finally(() => setKeyBusy(null));
  };

  const deleteSecret = (key: string) => {
    setKeyBusy(key);
    setSecretsError(null);
    void window.archspace
      .deleteSecret(key)
      .then((result) => {
        if (!result.ok) {
          setSecretsError(result.error);
          return;
        }
        loadSecretKeys();
        requestEngineStatus();
        notify('info', `Deleted the key "${key}".`);
      })
      .catch((err: unknown) => setSecretsError(errText(err)))
      .finally(() => setKeyBusy(null));
  };

  const descriptor = draft === null ? undefined : providerById(draft.provider);
  const blockingIssues = issues.filter((i) => i.severity === 'error');
  const warningIssues = issues.filter((i) => i.severity === 'warning');

  /** The write-only key control, wherever a single key name is being shown. */
  const keyField = (ref: string) => {
    const info = keyInfoByName.get(ref);
    return (
      <>
        <input
          id={`ai-secret-${ref}`}
          className="settings-input settings-input--mono"
          type="password"
          value={keyDrafts[ref] ?? ''}
          spellCheck={false}
          autoComplete="off"
          disabled={!props.platform.secretsAvailable || keyBusy !== null}
          placeholder={info ? 'a value is stored — type a new one to replace it' : 'paste the key'}
          onChange={(e) => setKeyDrafts((d) => ({ ...d, [ref]: e.target.value }))}
        />
        <button
          className="settings-btn settings-btn--small"
          disabled={
            !props.platform.secretsAvailable || keyBusy !== null || (keyDrafts[ref] ?? '') === ''
          }
          onClick={() => storeSecret(ref)}
        >
          {keyBusy === ref ? (
            <>
              <span className="settings-spinner" /> Storing…
            </>
          ) : (
            'Store'
          )}
        </button>
        <span className={info ? 'badge badge--ok' : 'badge badge--warn'}>
          {info ? 'stored' : 'not stored'}
        </span>
      </>
    );
  };

  return (
    <div className="settings-panel">
      {/* ---- what a profile is, and where it is written ------------------ */}
      <div className="settings-section">
        <div className="settings-section-head">
          <h3 className="settings-heading">AI Model Profiles</h3>
          {config !== null && (
            // Profiles AND providers, because the rows below are providers: a
            // file with four bindings on two providers must not read as two.
            <span className="settings-item-meta">
              {config.profiles.length} profile{config.profiles.length === 1 ? '' : 's'} across{' '}
              {groups.length} provider{groups.length === 1 ? '' : 's'} · default:{' '}
              {config.defaultProfile}
            </span>
          )}
        </div>
        <p className="settings-section-desc">
          A workflow names a profile; this machine says what that name means.
        </p>
        <div className="settings-path">
          <span className="settings-code" title={props.platform.paths.aiConfig}>
            {props.platform.paths.aiConfig}
          </span>
          <button
            className="settings-btn settings-btn--small"
            onClick={() => void window.archspace.revealPath(props.platform.paths.aiConfig)}
          >
            Reveal
          </button>
          <button className="settings-btn settings-btn--small" disabled={draft !== null} onClick={reload}>
            Reload
          </button>
        </div>

        {!engineReady && (
          <div className="settings-note settings-note--warn">
            The engine is not connected, so no binding below has been checked against the keychain
            or a provider. Profiles can still be edited — this panel reads and writes the file — but
            every readiness below is unknown rather than good.
          </div>
        )}
        {configIssues.length > 0 && (
          <div className="settings-note settings-note--warn">
            <strong>ai.yaml was not fully understood.</strong> Everything the validator
            could not read was skipped, so a profile you wrote may be missing below or
            may be showing a generated fallback rather than your own settings.
            <ul className="settings-issue-list">
              {configIssues.map((issue) => (
                <li key={issue}>{issue}</li>
              ))}
            </ul>
          </div>
        )}
        {configError !== null && (
          <div className="settings-note settings-note--error">
            Could not read the AI configuration: {configError}
          </div>
        )}
        {!props.platform.secretsAvailable && (
          <div className="settings-note settings-note--warn">
            This machine's keychain is not backing the app's encrypted store, so storing a secret
            would be refused. Any profile needing a key will keep reporting "missing key" until that
            is fixed; a local provider that needs no key works regardless.
          </div>
        )}
        {secretsError !== null && <div className="settings-note settings-note--error">{secretsError}</div>}
        {/* These three describe the FILE, not a binding, so they are stated
            once here rather than repeated into whichever row was touched. */}
        {blockingIssues.length > 0 && (
          <div className="settings-note settings-note--error">
            Not saved. This is what the same validator says would happen to the file on its way
            back in — so nothing was written:
            <div className="settings-kv">
              {blockingIssues.map((issue, i) => (
                <Fragment key={`${issue.path}-${i}`}>
                  <span className="settings-kv-key mono">{issue.path || 'config'}</span>
                  <span className="settings-kv-value">{issue.message}</span>
                </Fragment>
              ))}
            </div>
          </div>
        )}
        {warningIssues.length > 0 && (
          <div className="settings-note settings-note--warn">
            Saved, with warnings the validator kept rather than silently fixed:
            <div className="settings-kv">
              {warningIssues.map((issue, i) => (
                <Fragment key={`${issue.path}-${i}`}>
                  <span className="settings-kv-key mono">{issue.path || 'config'}</span>
                  <span className="settings-kv-value">{issue.message}</span>
                </Fragment>
              ))}
            </div>
          </div>
        )}
        {saveError !== null && (
          <div className="settings-note settings-note--error">Could not write the file: {saveError}</div>
        )}
      </div>

      {/* ---- one row per provider ---------------------------------------- */}
      <div className="settings-section">
        {/* No "Add profile" button: the unbound-provider row below is the same
            gesture with the choice already made, and a blank form was the more
            confusing of the two doors into one place. */}
        <div className="settings-section-head">
          <h4 className="settings-subheading">Providers on this machine</h4>
        </div>

        {config === null && configError === null && (
          <div className="settings-loading">
            <span className="settings-spinner" /> Reading {props.platform.paths.aiConfig}…
          </div>
        )}

        {config !== null && config.profiles.length === 0 && (
          <div className="settings-empty">
            <div className="settings-empty-title">No profiles</div>
            <div className="settings-empty-text">
              Nothing is bound on this machine, so any workflow asking for a model profile will
              refuse to run. Add one to fix that.
            </div>
          </div>
        )}

        {config !== null && groups.length > 0 && (
          <div className="settings-list">
            {groups.map((group) => {
              const known = group.profiles
                .map((p) => statusByName.get(p.name))
                .filter((s): s is ProfileStatus => s !== undefined);
              const allReported = known.length === group.profiles.length;
              const worst = worstReadiness(known.map((s) => s.readiness));
              const stripe = engineReady && allReported ? stripeClass(worst) : 'is-muted';
              const holdsDefault = group.profiles.some((p) => p.name === config.defaultProfile);
              const isOpen = expanded.has(group.id);
              const single = group.profiles.length === 1 ? group.profiles[0] : null;
              const draftsHere = draft !== null && draft.provider === group.id;
              const mockIsDefault = group.descriptor.kind === 'test' && holdsDefault;

              return (
                <div key={group.id} className={`settings-list-item ${stripe}`}>
                  <div className="settings-item-head">
                    <span className="settings-item-name">{group.descriptor.label}</span>
                    {!engineReady ? (
                      <span className="badge badge--muted" title="The engine has not reported.">
                        no engine
                      </span>
                    ) : known.length === 0 ? (
                      <span
                        className="badge badge--info"
                        title="Readiness appears as soon as the engine picks the new config up."
                      >
                        not reported yet
                      </span>
                    ) : (
                      worst !== null && <span className={badgeClass(worst)}>{READINESS_LABEL[worst]}</span>
                    )}
                    {group.descriptor.kind === 'test' && (
                      <span className="badge badge--unimplemented" title={kindSentence('test')}>
                        no network
                      </span>
                    )}
                    {holdsDefault && <span className="badge badge--info">default</span>}
                    {draftsHere && <span className="badge badge--warn">unsaved</span>}
                    {/* The model used to live here; it is an editable field on
                        the row now, so repeating it would be two places to
                        read one fact — and one of them stale while typing. */}
                    <span className="settings-item-meta">
                      {single !== null
                        ? single.name
                        : `${group.profiles.length} profiles${holdsDefault ? ' · default lives here' : ''}`}
                    </span>
                    <div className="settings-item-actions">
                      {/* Only meaningful for one binding: with several, "test
                          which?" has no answer, so Test moves inside. */}
                      {single !== null && (
                        <button
                          className="settings-btn settings-btn--small"
                          disabled={!engineReady || probing !== null}
                          title={
                            engineReady
                              ? 'Make one real, minimal call through this profile'
                              : 'The engine is not connected'
                          }
                          onClick={() => runProbe(single.name)}
                        >
                          {probing === single.name ? (
                            <>
                              <span className="settings-spinner" /> Testing…
                            </>
                          ) : (
                            'Test'
                          )}
                        </button>
                      )}
                      <button
                        className="settings-btn settings-btn--small"
                        aria-expanded={isOpen}
                        onClick={() => toggleExpanded(group.id)}
                      >
                        {isOpen ? 'Less' : 'Details'}
                      </button>
                    </div>
                  </div>

                  {/* Model and key: the whole of what a working binding needs
                      beyond the provider, so both are edited here and the
                      eight-field form is reached only through Details. Only for
                      a single-profile provider — with several, "which one" has
                      no answer on a collapsed row. */}
                  {single !== null && (
                    <div className="ai-key-line">
                      <input
                        className={`settings-input settings-input--mono${
                          modelValue(single).trim() === '' ? ' is-invalid' : ''
                        }`}
                        value={modelValue(single)}
                        spellCheck={false}
                        autoComplete="off"
                        aria-label={`Model for ${group.descriptor.label}`}
                        onChange={(e) =>
                          setModelDrafts((d) => ({ ...d, [single.name]: e.target.value }))
                        }
                      />
                      {modelValue(single).trim() !== single.model && (
                        // Only when it differs from the file. An always-present
                        // Save invites a write nobody meant, and this panel
                        // overwrites ai.yaml wholesale.
                        <button
                          className="settings-btn settings-btn--small settings-btn--primary"
                          disabled={saving || modelValue(single).trim() === ''}
                          onClick={() => saveModel(single)}
                        >
                          Save
                        </button>
                      )}
                    </div>
                  )}

                  {/* The key line: the one thing most visits to this panel are
                      for, so it sits outside the fold. */}
                  <div className="ai-key-line">
                    {group.keyRefs.length === 1 ? (
                      <>
                        <span className="settings-code" title={group.keyRefs[0]}>
                          {group.keyRefs[0]}
                        </span>
                        {keyField(group.keyRefs[0])}
                      </>
                    ) : group.keyRefs.length > 1 ? (
                      // Refused on purpose: apiKeyRef is per profile. One field
                      // here would say keys are per provider, which is false.
                      <span className="settings-item-meta">
                        {group.keyRefs.length} key names ·{' '}
                        {group.keyRefs.filter((ref) => keyInfoByName.has(ref)).length} stored — open
                        Details to set them
                      </span>
                    ) : group.descriptor.needsApiKey ? (
                      <>
                        <span className="settings-item-meta">
                          No key name yet — this provider needs one.
                        </span>
                        {single !== null && (
                          <button
                            className="settings-btn settings-btn--small"
                            disabled={saving || draft !== null}
                            onClick={() =>
                              openDraft({
                                ...draftFor(single),
                                apiKeyRef: `ai.${group.id}.api_key`,
                              })
                            }
                          >
                            Fix
                          </button>
                        )}
                      </>
                    ) : (
                      <span className="settings-item-meta">
                        No key needed ·{' '}
                        {single?.baseUrl ?? group.descriptor.defaultBaseUrl ?? 'endpoint set per profile'}
                      </span>
                    )}
                  </div>

                  {/* ADR-0010 §4 says the mock provider is never a default. If
                      the file makes it one anyway, the consequence reaches every
                      AI node in every workflow — so this one sentence is not
                      allowed to hide behind a disclosure. */}
                  {mockIsDefault && (
                    <div className="settings-note settings-note--unimplemented">
                      <strong>
                        The default profile is a mock, so every workflow that does not name another
                        one is answered by scripted text and never reaches a model.
                      </strong>
                    </div>
                  )}

                  {isOpen && (
                    <div className="settings-item-body">
                      <div className="settings-item-desc">{group.descriptor.summary}</div>
                      <div className="settings-item-desc">{kindSentence(group.descriptor.kind)}</div>
                      {isExternalUrl(group.descriptor.docsUrl) ? (
                        <button
                          className="settings-link"
                          onClick={() => void window.archspace.openExternal(group.descriptor.docsUrl)}
                        >
                          {group.descriptor.docsUrl}
                        </button>
                      ) : (
                        <div className="settings-path">
                          <span className="settings-code">{group.descriptor.docsUrl}</span>
                        </div>
                      )}

                      {group.keyRefs.length > 1 && (
                        <div className="ai-bindings">
                          {group.keyRefs.map((ref) => {
                            const users = group.profiles
                              .filter((p) => p.apiKeyRef === ref)
                              .map((p) => p.name);
                            return (
                              <div key={ref} className="ai-binding">
                                <div className="settings-item-head">
                                  <span className="settings-item-name mono">{ref}</span>
                                  <span className="settings-item-meta">
                                    Used by {users.map((n) => `"${n}"`).join(', ')}
                                  </span>
                                  <div className="settings-item-actions">
                                    {keyInfoByName.has(ref) && (
                                      <button
                                        className="settings-btn settings-btn--small settings-btn--danger"
                                        disabled={keyBusy !== null}
                                        onClick={() => deleteSecret(ref)}
                                      >
                                        Delete key
                                      </button>
                                    )}
                                  </div>
                                </div>
                                <div className="ai-key-line">{keyField(ref)}</div>
                              </div>
                            );
                          })}
                        </div>
                      )}

                      {group.keyRefs.length === 1 && (
                        <div className="settings-item-desc">
                          Used by{' '}
                          {group.profiles
                            .filter((p) => p.apiKeyRef === group.keyRefs[0])
                            .map((p) => `"${p.name}"`)
                            .join(', ')}
                          .{' '}
                          {keyInfoByName.has(group.keyRefs[0]) && (
                            <button
                              className="settings-btn settings-btn--small settings-btn--danger"
                              disabled={keyBusy !== null}
                              onClick={() => deleteSecret(group.keyRefs[0])}
                            >
                              Delete key
                            </button>
                          )}
                        </div>
                      )}

                      <div className="ai-bindings">
                        {group.profiles.map((profile) => {
                          const status = statusByName.get(profile.name);
                          const probe = probes[profile.name];
                          const isDefault = profile.name === config.defaultProfile;
                          return (
                            <div key={profile.name} className="ai-binding">
                              <div className="settings-item-head">
                                <span className="settings-item-name">{profile.name}</span>
                                {isDefault && <span className="badge badge--info">default</span>}
                                {engineReady && status !== undefined && (
                                  <span className={badgeClass(status.readiness)}>
                                    {READINESS_LABEL[status.readiness]}
                                  </span>
                                )}
                                <span className="settings-item-meta mono">{profile.model}</span>
                                <div className="settings-item-actions">
                                  <button
                                    className="settings-btn settings-btn--small"
                                    disabled={!engineReady || probing !== null}
                                    title={
                                      engineReady
                                        ? 'Make one real, minimal call through this profile'
                                        : 'The engine is not connected'
                                    }
                                    onClick={() => runProbe(profile.name)}
                                  >
                                    {probing === profile.name ? (
                                      <>
                                        <span className="settings-spinner" /> Testing…
                                      </>
                                    ) : (
                                      'Test'
                                    )}
                                  </button>
                                  {!isDefault && (
                                    <button
                                      className="settings-btn settings-btn--small"
                                      disabled={saving}
                                      onClick={() => makeDefault(profile.name)}
                                    >
                                      Make default
                                    </button>
                                  )}
                                  <button
                                    className="settings-btn settings-btn--small"
                                    disabled={saving}
                                    onClick={() => openDraft(draftFor(profile))}
                                  >
                                    Edit
                                  </button>
                                  {confirmRemove === profile.name ? (
                                    <>
                                      <button
                                        className="settings-btn settings-btn--small settings-btn--danger"
                                        disabled={saving}
                                        onClick={() => removeProfile(profile.name)}
                                      >
                                        Really remove
                                      </button>
                                      <button
                                        className="settings-btn settings-btn--small"
                                        onClick={() => setConfirmRemove(null)}
                                      >
                                        Keep
                                      </button>
                                    </>
                                  ) : (
                                    <button
                                      className="settings-btn settings-btn--small settings-btn--danger"
                                      disabled={saving}
                                      onClick={() => setConfirmRemove(profile.name)}
                                    >
                                      Remove
                                    </button>
                                  )}
                                </div>
                              </div>

                              {group.descriptor.kind === 'test' && (
                                <div className="settings-note settings-note--unimplemented">
                                  This profile calls nothing. The <span className="mono">mock</span>{' '}
                                  provider returns deterministic scripted text for offline demos and
                                  CI — a successful test here proves this app works, not that any
                                  model or provider does.
                                </div>
                              )}
                              {engineReady && status !== undefined && status.readiness !== 'ready' && (
                                <>
                                  <div className="settings-item-desc">
                                    {explainReadiness(status, profile)}
                                  </div>
                                  {status.detail !== undefined && (
                                    <div className="settings-item-desc mono">
                                      Engine: {status.detail}
                                    </div>
                                  )}
                                </>
                              )}

                              {/* Only what the collapsed row has not said. */}
                              <div className="settings-kv">
                                {profile.baseUrl !== undefined && (
                                  <>
                                    <span className="settings-kv-key">Endpoint</span>
                                    <span className="settings-kv-value mono">{profile.baseUrl}</span>
                                  </>
                                )}
                                <span className="settings-kv-key">Key ref</span>
                                <span className="settings-kv-value mono">
                                  {profile.apiKeyRef ??
                                    (group.descriptor.needsApiKey
                                      ? 'none — this provider needs one'
                                      : 'none needed')}
                                </span>
                                {profile.embeddingModel !== undefined && (
                                  <>
                                    <span className="settings-kv-key">Embeddings</span>
                                    <span className="settings-kv-value mono">{profile.embeddingModel}</span>
                                  </>
                                )}
                                {profile.temperature !== undefined && (
                                  <>
                                    <span className="settings-kv-key">Temperature</span>
                                    <span className="settings-kv-value mono">{profile.temperature}</span>
                                  </>
                                )}
                                {profile.maxOutputTokens !== undefined && (
                                  <>
                                    <span className="settings-kv-key">Max output</span>
                                    <span className="settings-kv-value mono">
                                      {profile.maxOutputTokens} tokens
                                    </span>
                                  </>
                                )}
                                {profile.headers !== undefined && (
                                  <>
                                    <span className="settings-kv-key">Headers</span>
                                    <span className="settings-kv-value">
                                      <span className="settings-tags">
                                        {Object.entries(profile.headers).map(([header, value]) => (
                                          <span key={header} className="settings-tag">
                                            {header}: {value}
                                          </span>
                                        ))}
                                      </span>
                                    </span>
                                  </>
                                )}
                              </div>

                              {probe !== undefined && (
                                <>
                                  <div className="settings-item-head">
                                    <span className={probe.ok ? 'badge badge--ok' : 'badge badge--error'}>
                                      {probe.ok ? 'answered' : 'failed'}
                                    </span>
                                    {probe.latencyMs !== undefined && (
                                      <span className="settings-item-meta">
                                        {probe.latencyMs} ms round trip
                                      </span>
                                    )}
                                    {group.descriptor.kind === 'test' && (
                                      <span className="settings-item-meta">
                                        scripted answer — nothing left this machine
                                      </span>
                                    )}
                                  </div>
                                  <div className="settings-kv">
                                    {probe.sample !== undefined && (
                                      <>
                                        <span className="settings-kv-key">Returned</span>
                                        <span className="settings-kv-value mono">{probe.sample}</span>
                                      </>
                                    )}
                                    {probe.error !== undefined && (
                                      <>
                                        <span className="settings-kv-key">Error</span>
                                        <span className="settings-kv-value">{probe.error}</span>
                                      </>
                                    )}
                                  </div>
                                </>
                              )}
                            </div>
                          );
                        })}
                      </div>

                      <div className="settings-actions">
                        <button
                          className="settings-btn settings-btn--small"
                          disabled={config === null || draft !== null}
                          onClick={() => addForProvider(group.descriptor)}
                        >
                          + Add another {group.descriptor.label} profile
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}

        {/* Whether anything is bound is a fact about the FILE, so this line
            stays true and useful with the engine dead. */}
        {config !== null && unbound.length > 0 && (
          <div className="ai-unbound">
            <span className="settings-item-meta">Not bound on this machine:</span>
            {unbound.map((provider) => (
              <button
                key={provider.id}
                className="settings-btn settings-btn--small"
                disabled={draft !== null}
                title={
                  provider.kind === 'test'
                    ? kindSentence('test')
                    : `${provider.summary} ${kindSentence(provider.kind)}`
                }
                onClick={() => bindProvider(provider)}
              >
                {provider.label}
              </button>
            ))}
          </div>
        )}

        {unreferencedKeys.length > 0 && (
          <div className="settings-note settings-note--info">
            This machine also holds {unreferencedKeys.length} key
            {unreferencedKeys.length === 1 ? '' : 's'} that no AI profile names —{' '}
            {unreferencedKeys.map((info) => info.key).join(', ')}. They may belong to another
            settings section, so they are listed rather than managed from here.
          </div>
        )}
      </div>

      {/* ---- the editor -------------------------------------------------- */}
      {draft !== null && config !== null && (
        <div className="settings-section" ref={editorRef}>
          <div className="settings-section-head">
            <h4 className="settings-subheading">
              {draft.original === null ? 'New profile' : `Editing "${draft.original}"`}
            </h4>
          </div>

          {draftErrors.length > 0 && (
            <div className="settings-note settings-note--error">
              <ul className="settings-issue-list">
                {draftErrors.map((problem) => (
                  <li key={problem}>{problem}</li>
                ))}
              </ul>
            </div>
          )}

          <div className="settings-row">
            <label className="settings-row-label" htmlFor="ai-profile-name">
              Name
            </label>
            <div className="settings-row-control">
              <input
                id="ai-profile-name"
                className={`settings-input settings-input--mono${draft.name.trim() === '' ? ' is-invalid' : ''}`}
                value={draft.name}
                spellCheck={false}
                autoComplete="off"
                placeholder="default"
                onChange={(e) => setDraft({ ...draft, name: e.target.value })}
              />
            </div>
            <div className="settings-row-hint">
              What a workflow asks for. Nodes ask for <span className="mono">default</span> unless
              told otherwise, so the first profile on a machine should usually keep that name.
            </div>
          </div>

          <div className="settings-row">
            <label className="settings-row-label" htmlFor="ai-profile-provider">
              Provider
            </label>
            <div className="settings-row-control">
              <select
                id="ai-profile-provider"
                className="settings-input"
                value={draft.provider}
                onChange={(e) => {
                  const next = providerById(e.target.value) ?? PROVIDERS[0];
                  setDraft({
                    ...draft,
                    provider: next.id,
                    apiKeyRef:
                      next.needsApiKey && draft.apiKeyRef === '' ? `ai.${next.id}.api_key` : draft.apiKeyRef,
                  });
                }}
              >
                {PROVIDERS.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.label}
                  </option>
                ))}
              </select>
            </div>
            <div className="settings-row-hint">
              {descriptor !== undefined && `${descriptor.summary} ${kindSentence(descriptor.kind)}`}
            </div>
          </div>

          <div className="settings-row">
            <label className="settings-row-label" htmlFor="ai-profile-model">
              Model
            </label>
            <div className="settings-row-control">
              <input
                id="ai-profile-model"
                className={`settings-input settings-input--mono${draft.model.trim() === '' ? ' is-invalid' : ''}`}
                value={draft.model}
                spellCheck={false}
                autoComplete="off"
                onChange={(e) => setDraft({ ...draft, model: e.target.value })}
              />
            </div>
            <div className="settings-row-hint">
              {descriptor !== undefined && descriptor.suggestedModels.length > 0 ? (
                <span className="settings-actions">
                  {descriptor.suggestedModels.map((model) => (
                    <button
                      key={model}
                      className="settings-btn settings-btn--small"
                      onClick={() => setDraft({ ...draft, model })}
                    >
                      {model}
                    </button>
                  ))}
                </span>
              ) : (
                'Only the endpoint knows what it serves, so there are no suggestions here that would be true.'
              )}
            </div>
          </div>

          <div className="settings-row">
            <label className="settings-row-label" htmlFor="ai-profile-base-url">
              Endpoint
            </label>
            <div className="settings-row-control">
              <input
                id="ai-profile-base-url"
                className={`settings-input settings-input--mono${
                  descriptor?.needsBaseUrl === true && draft.baseUrl.trim() === '' ? ' is-invalid' : ''
                }`}
                value={draft.baseUrl}
                spellCheck={false}
                autoComplete="off"
                placeholder={descriptor?.defaultBaseUrl ?? 'http://localhost:1234/v1'}
                onChange={(e) => setDraft({ ...draft, baseUrl: e.target.value })}
              />
            </div>
            <div className="settings-row-hint">
              {descriptor?.needsBaseUrl === true
                ? 'Required — this provider has no default endpoint. An http(s) URL of a server you run.'
                : descriptor?.defaultBaseUrl !== undefined
                  ? `Optional. Blank uses the provider default (${descriptor.defaultBaseUrl}).`
                  : 'Optional.'}
            </div>
          </div>

          <div className="settings-row">
            <label className="settings-row-label" htmlFor="ai-profile-key-ref">
              API key reference
            </label>
            <div className="settings-row-control">
              <input
                id="ai-profile-key-ref"
                className="settings-input settings-input--mono"
                value={draft.apiKeyRef}
                spellCheck={false}
                autoComplete="off"
                placeholder={`ai.${draft.provider}.api_key`}
                onChange={(e) => setDraft({ ...draft, apiKeyRef: e.target.value })}
              />
            </div>
            <div className="settings-row-hint">
              A NAME for a keychain entry, never the credential itself — the file this writes is
              plain text on disk, and a pasted key is refused by the validator. The value goes in
              the key field on the provider row.
            </div>
          </div>

          <div className="settings-row">
            <label className="settings-row-label" htmlFor="ai-profile-embedding">
              Embedding model
            </label>
            <div className="settings-row-control">
              <input
                id="ai-profile-embedding"
                className="settings-input settings-input--mono"
                value={draft.embeddingModel}
                spellCheck={false}
                autoComplete="off"
                placeholder={descriptor?.suggestedEmbeddingModels?.[0] ?? ''}
                onChange={(e) => setDraft({ ...draft, embeddingModel: e.target.value })}
              />
            </div>
            <div className="settings-row-hint">
              Optional, and separate from the chat model. Only needed by nodes that embed.
            </div>
          </div>

          <div className="settings-row">
            <label className="settings-row-label" htmlFor="ai-profile-temperature">
              Temperature
            </label>
            <div className="settings-row-control">
              <input
                id="ai-profile-temperature"
                className="settings-input settings-input--mono"
                value={draft.temperature}
                spellCheck={false}
                autoComplete="off"
                placeholder="provider default"
                onChange={(e) => setDraft({ ...draft, temperature: e.target.value })}
              />
            </div>
            <div className="settings-row-hint">Optional. Blank leaves it to the provider.</div>
          </div>

          <div className="settings-row">
            <label className="settings-row-label" htmlFor="ai-profile-max-tokens">
              Max output tokens
            </label>
            <div className="settings-row-control">
              <input
                id="ai-profile-max-tokens"
                className="settings-input settings-input--mono"
                value={draft.maxOutputTokens}
                spellCheck={false}
                autoComplete="off"
                placeholder="provider default"
                onChange={(e) => setDraft({ ...draft, maxOutputTokens: e.target.value })}
              />
            </div>
            <div className="settings-row-hint">Optional. A whole number, or blank.</div>
          </div>

          {draft.headers !== undefined && (
            <div className="settings-row">
              <span className="settings-row-label">Headers</span>
              <div className="settings-row-control">
                <span className="settings-tags">
                  {Object.entries(draft.headers).map(([header, value]) => (
                    <span key={header} className="settings-tag">
                      {header}: {value}
                    </span>
                  ))}
                </span>
              </div>
              <div className="settings-row-hint">
                Hand-written in ai.yaml and carried through unchanged — there is no editor for them
                here, and saving from this form does not drop them.
              </div>
            </div>
          )}

          <div className="settings-actions">
            <button className="settings-btn settings-btn--primary" disabled={saving} onClick={saveDraft}>
              {saving ? (
                <>
                  <span className="settings-spinner" /> Saving…
                </>
              ) : draft.original === null ? (
                'Add profile'
              ) : (
                'Save profile'
              )}
            </button>
            <button
              className="settings-btn"
              disabled={saving}
              onClick={() => {
                setDraft(null);
                setDraftErrors([]);
              }}
            >
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
