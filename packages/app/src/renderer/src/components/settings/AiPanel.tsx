/**
 * AI model profiles — this machine's half of the portability contract
 * (ARCHITECTURE §10 / ADR-0010).
 *
 * A workflow says `ai: [default]`. *This machine* says what `default` means,
 * and that is the only reason a document from a colleague on Anthropic runs
 * unchanged against a local Ollama.
 *
 * **Shape: pick a provider, paste a key. There is no form.** This panel has
 * been cut twice — first from five stacked sections to one row per provider,
 * then by deleting the eight-field profile editor outright. What a binding
 * actually needs is a provider, a model id and (for a cloud provider) a key,
 * so those are the only things on screen. Binding is one click on a provider's
 * name, which writes the catalogue's first model and the conventional key
 * name; the model sits in an editable field on the row; the key goes beside it.
 *
 * What that deletion costs, stated plainly because it is a real cost: profile
 * NAME, EMBEDDING MODEL, TEMPERATURE and MAX OUTPUT TOKENS are no longer
 * settable from the UI. They remain in the file format, are still read, and
 * are still carried through every write here untouched — but the place to
 * change them is now `ai.yaml`, which is why its path and Reveal button sit at
 * the top of this panel rather than being decoration. That is a deliberate
 * trade against ADR-0010's multi-profile capability, which nothing that ships
 * exercises: all three bundled examples declare `ai: []`, and no example or
 * test names a profile other than the default.
 *
 * ENDPOINT is the one field that could not go. `validateAiConfig` makes a
 * missing `baseUrl` an ERROR for a `needsBaseUrl` provider, so
 * `openai-compatible` — the "any endpoint you run" escape hatch that local
 * parity depends on — is unbindable without it. It appears inline and only
 * where it is needed: a provider that requires one, or a profile that already
 * sets one.
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
 *     the only thing here that may claim a provider answered is `Test`, which
 *     earns the claim by printing the text the model returned.
 *  3. **Secrets are write-only from here.** The bridge deliberately has no
 *     `getSecret` (preload/index.ts header, §12): the renderer may create,
 *     list and delete key NAMES and can never read a value back. So the key
 *     field is a write-only input cleared the moment it is stored, and what
 *     the UI reports is existence and creation time — never a value.
 *  4. **A key belongs to a profile, not to a provider.** When one provider's
 *     profiles name different `apiKeyRef`s the row shows a count and refuses
 *     to draw a single key field, because one field there would state the
 *     opposite of what the file says.
 *
 * Nothing was deleted from the DATA MODEL. The grouping is a view, computed in
 * `ai-groups.ts` and tested there, and the write path never sees a group —
 * load-bearing, because `saveAiConfig` is a verbatim whole-file overwrite with
 * no merge, so a profile the grouping dropped on the way to the screen would
 * be a profile deleted from the user's file on the next unrelated save. Every
 * write here is a spread over the existing profile, so `headers`,
 * `temperature` and the rest survive edits made from a UI that cannot show
 * them.
 *
 * No autosave, ever: `Save` appears only once a field differs from the file.
 */

import { Fragment, useCallback, useEffect, useMemo, useState } from 'react';
import {
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
 * provider, and a word implying otherwise would be a claim it had not paid for.
 */
const READINESS_LABEL: Record<ProfileStatus['readiness'], string> = {
  ready: 'bound',
  'missing-key': 'missing key',
  unreachable: 'unreachable',
  unknown: 'unknown',
  invalid: 'invalid',
};

/**
 * What a readiness MEANS, for the states a badge cannot carry alone. Empty for
 * `ready`: the badge already says that, and a sentence repeating a badge is
 * exactly the crowding this panel was cut to remove.
 */
function explainReadiness(status: ProfileStatus, profile: ModelProfile): string {
  switch (status.readiness) {
    case 'ready':
      return '';
    case 'missing-key':
      return profile.apiKeyRef === undefined
        ? 'This provider needs an API key and the profile names none.'
        : `Nothing is stored under "${profile.apiKeyRef}" on this machine — paste the key above.`;
    case 'unreachable':
      return 'A real call did not get through. The binding is complete; the endpoint, the network or the credential is not.';
    case 'unknown':
      return 'The engine could not work out whether this binding resolves.';
    case 'invalid':
      return 'The binding itself is wrong — a missing model id, or an endpoint this provider cannot use.';
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

/** The keychain name this panel generates for a provider. */
function conventionalKeyRef(id: ProviderId): string {
  return `ai.${id}.api_key`;
}

/**
 * A name for a profile being created.
 *
 * `default` first, and not as a nicety: every AI node's `profile` param
 * defaults to the literal string `default` (nodes-core/ai-common.ts) and the
 * gateway resolves that name exactly, so a machine whose first profile is
 * called anything else answers every out-of-the-box workflow with "unknown
 * profile". With no name field on screen any more, getting this right here is
 * the difference between a working install and a baffling one.
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

/** Whether a row needs an endpoint field at all. */
function showsEndpoint(descriptor: ProviderDescriptor, profile: ModelProfile | null): boolean {
  return descriptor.needsBaseUrl || profile?.baseUrl !== undefined;
}

/** Unsaved edits to the two fields a row can change. */
interface RowEdit {
  model?: string;
  baseUrl?: string;
}

/** A provider chosen but not yet written, for the case that needs setup. */
interface Pending {
  id: ProviderId;
  model: string;
  baseUrl: string;
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

  /** Per profile name, the fields being typed on its row. */
  const [edits, setEdits] = useState<Record<string, RowEdit>>({});
  const [pending, setPending] = useState<Pending | null>(null);

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
    // the engine to re-report: readiness may have changed since it last pushed.
    requestEngineStatus();
  }, [loadConfig, loadSecretKeys]);

  /** Re-read everything, including a file edited by hand while this was open. */
  const reload = useCallback(() => {
    setEdits({});
    setPending(null);
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

  /**
   * Replace one profile, spreading over what is already there.
   *
   * The spread is the whole reason edits from a UI with three fields cannot
   * destroy a file with eight: `temperature`, `embeddingModel`, `headers` and
   * anything else hand-written ride through untouched.
   */
  const updateProfile = (name: string, change: Partial<ModelProfile>, done: string): void => {
    if (config === null) return;
    void persist(
      {
        profiles: config.profiles.map((p) => (p.name === name ? { ...p, ...change } : p)),
        defaultProfile: config.defaultProfile,
      },
      done,
    ).then((ok) => {
      if (ok) setEdits((e) => ({ ...e, [name]: {} }));
    });
  };

  /** The config with `profile` appended, defaulting to it if nothing else is. */
  const withProfile = (existing: AiGatewayConfig, profile: ModelProfile): AiGatewayConfig => {
    const keepsDefault = existing.profiles.some((p) => p.name === existing.defaultProfile);
    return {
      profiles: [...existing.profiles, profile],
      defaultProfile: keepsDefault ? existing.defaultProfile : profile.name,
    };
  };

  /**
   * Bind a provider from its button.
   *
   * One click when the catalogue supplies everything — a model, and an endpoint
   * the provider already defaults. Otherwise the provider gets a pending row
   * with the two fields it needs, because `validateAiConfig` makes a blank
   * model and a missing `baseUrl` on a `needsBaseUrl` provider both ERRORS:
   * writing immediately there could only ever produce a refused save.
   */
  const bindProvider = (descriptor: ProviderDescriptor): void => {
    if (config === null) return;
    const model = descriptor.suggestedModels[0] ?? '';
    if (model === '' || descriptor.needsBaseUrl) {
      setPending({ id: descriptor.id, model, baseUrl: descriptor.defaultBaseUrl ?? '' });
      return;
    }
    const profile: ModelProfile = {
      name: suggestProfileName(config.profiles, descriptor.id),
      provider: descriptor.id,
      model,
      ...(descriptor.needsApiKey ? { apiKeyRef: conventionalKeyRef(descriptor.id) } : {}),
    };
    void persist(withProfile(config, profile), `Added ${descriptor.label}.`);
  };

  const createPending = (): void => {
    if (config === null || pending === null) return;
    const descriptor = providerById(pending.id);
    if (descriptor === undefined) return;
    const model = pending.model.trim();
    const baseUrl = pending.baseUrl.trim();
    if (model === '') return;
    const profile: ModelProfile = {
      name: suggestProfileName(config.profiles, pending.id),
      provider: pending.id,
      model,
      ...(baseUrl === '' ? {} : { baseUrl }),
      ...(descriptor.needsApiKey ? { apiKeyRef: conventionalKeyRef(pending.id) } : {}),
    };
    void persist(withProfile(config, profile), `Added ${descriptor.label}.`).then((ok) => {
      if (ok) setPending(null);
    });
  };

  const removeProfile = (name: string) => {
    if (config === null) return;
    const profiles = config.profiles.filter((p) => p.name !== name);
    // Removing the LAST profile is deliberately not special-cased: `persist`
    // runs the same validator the file meets on the way back in, and that
    // validator already refuses a config with no usable profile.
    const defaultProfile =
      config.defaultProfile === name ? (profiles[0]?.name ?? config.defaultProfile) : config.defaultProfile;
    void persist({ profiles, defaultProfile }, `Removed "${name}".`).then((ok) => {
      if (ok) setConfirmRemove(null);
    });
  };

  const makeDefault = (name: string) => {
    if (config === null) return;
    void persist({ profiles: config.profiles, defaultProfile: name }, `"${name}" is now the default.`);
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
        notify('info', `Stored a value for "${key}".`);
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

  const blockingIssues = issues.filter((i) => i.severity === 'error');
  const warningIssues = issues.filter((i) => i.severity === 'warning');

  /** The write-only key control, wherever a key name is being shown. */
  const keyField = (ref: string) => {
    const info = keyInfoByName.get(ref);
    return (
      <>
        <input
          className="settings-input settings-input--mono"
          type="password"
          value={keyDrafts[ref] ?? ''}
          spellCheck={false}
          autoComplete="off"
          aria-label={`API key for ${ref}`}
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
          A workflow names a profile; this machine says what that name means. Anything not shown
          here — profile names, temperature, token budgets, embedding models — lives in the file
          below and survives every edit made from this screen.
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
          <button className="settings-btn settings-btn--small" onClick={reload}>
            Reload
          </button>
        </div>

        {!engineReady && (
          <div className="settings-note settings-note--warn">
            The engine is not connected, so nothing below has been checked against the keychain or
            a provider. Keys can still be stored and the file still edited — but every readiness
            shown is unknown rather than good.
          </div>
        )}
        {configIssues.length > 0 && (
          <div className="settings-note settings-note--warn">
            <strong>ai.yaml was not fully understood.</strong> Everything the validator could not
            read was skipped, so a profile you wrote may be missing below.
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
            This machine's keychain is not backing the app's encrypted store, so storing a key
            would be refused. Any provider needing one will keep reporting "missing key"; a local
            provider that needs no key works regardless.
          </div>
        )}
        {secretsError !== null && <div className="settings-note settings-note--error">{secretsError}</div>}
        {/* These describe the FILE, not a binding, so they are stated once. */}
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
            <div className="settings-empty-title">Nothing bound</div>
            <div className="settings-empty-text">
              Any workflow asking for a model profile will refuse to run. Pick a provider below.
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
              const edit: RowEdit = single === null ? {} : (edits[single.name] ?? {});
              const modelValue = edit.model ?? single?.model ?? '';
              const urlValue = edit.baseUrl ?? single?.baseUrl ?? '';
              const dirty =
                single !== null &&
                ((modelValue.trim() !== single.model && modelValue.trim() !== '') ||
                  (edit.baseUrl !== undefined && edit.baseUrl.trim() !== (single.baseUrl ?? '')));
              // A key name generated for a DIFFERENT provider — what a
              // hand-edited file, or an older build's provider switch, leaves
              // behind. Harmless until that other provider is bound too, at
              // which point both resolve to one keychain entry.
              const foreignKeyRef =
                single?.apiKeyRef !== undefined &&
                group.descriptor.needsApiKey &&
                single.apiKeyRef !== conventionalKeyRef(group.id);

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
                    {single === null && (
                      <span className="settings-item-meta">{group.profiles.length} profiles</span>
                    )}
                    <div className="settings-item-actions">
                      {single !== null && (
                        <button
                          className="settings-btn settings-btn--small"
                          disabled={!engineReady || probing !== null}
                          title={
                            engineReady
                              ? 'Make one real, minimal call through this provider'
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

                  {/* Model, and the endpoint only where one is needed. */}
                  {single !== null && (
                    <div className="ai-key-line">
                      <input
                        className={`settings-input settings-input--mono${
                          modelValue.trim() === '' ? ' is-invalid' : ''
                        }`}
                        value={modelValue}
                        spellCheck={false}
                        autoComplete="off"
                        aria-label={`Model for ${group.descriptor.label}`}
                        onChange={(e) =>
                          setEdits((s) => ({
                            ...s,
                            [single.name]: { ...s[single.name], model: e.target.value },
                          }))
                        }
                      />
                      {showsEndpoint(group.descriptor, single) && (
                        <input
                          className="settings-input settings-input--mono"
                          value={urlValue}
                          spellCheck={false}
                          autoComplete="off"
                          aria-label={`Endpoint for ${group.descriptor.label}`}
                          placeholder={group.descriptor.defaultBaseUrl ?? 'http://localhost:1234/v1'}
                          onChange={(e) =>
                            setEdits((s) => ({
                              ...s,
                              [single.name]: { ...s[single.name], baseUrl: e.target.value },
                            }))
                          }
                        />
                      )}
                      {dirty && (
                        // Only once something differs from the file: an
                        // always-present Save invites a write nobody meant.
                        <button
                          className="settings-btn settings-btn--small settings-btn--primary"
                          disabled={saving || modelValue.trim() === ''}
                          onClick={() =>
                            updateProfile(
                              single.name,
                              {
                                model: modelValue.trim(),
                                ...(edit.baseUrl === undefined
                                  ? {}
                                  : edit.baseUrl.trim() === ''
                                    ? { baseUrl: undefined }
                                    : { baseUrl: edit.baseUrl.trim() }),
                              },
                              `Saved ${group.descriptor.label}.`,
                            )
                          }
                        >
                          Save
                        </button>
                      )}
                    </div>
                  )}

                  {/* The key. */}
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
                        Details
                      </span>
                    ) : group.descriptor.needsApiKey && single !== null ? (
                      <>
                        <span className="settings-item-meta">This provider needs a key.</span>
                        <button
                          className="settings-btn settings-btn--small"
                          disabled={saving}
                          onClick={() =>
                            updateProfile(
                              single.name,
                              { apiKeyRef: conventionalKeyRef(group.id) },
                              `${group.descriptor.label} will use ${conventionalKeyRef(group.id)}.`,
                            )
                          }
                        >
                          Add a key
                        </button>
                      </>
                    ) : (
                      <span className="settings-item-meta">
                        No key needed ·{' '}
                        {single?.baseUrl ?? group.descriptor.defaultBaseUrl ?? 'endpoint set per profile'}
                      </span>
                    )}
                  </div>

                  {foreignKeyRef && single !== null && (
                    <div className="ai-key-line">
                      <span className="settings-item-meta">
                        That key name belongs to another provider.
                      </span>
                      <button
                        className="settings-btn settings-btn--small"
                        disabled={saving}
                        onClick={() =>
                          updateProfile(
                            single.name,
                            { apiKeyRef: conventionalKeyRef(group.id) },
                            `Now using ${conventionalKeyRef(group.id)}.`,
                          )
                        }
                      >
                        Use {conventionalKeyRef(group.id)}
                      </button>
                    </div>
                  )}

                  {/* ADR-0010 §4 says the mock provider is never a default. If
                      the file makes it one anyway, the consequence reaches every
                      AI node in every workflow — so it never hides in a fold. */}
                  {group.descriptor.kind === 'test' && holdsDefault && (
                    <div className="settings-note settings-note--unimplemented">
                      <strong>
                        The default is a mock, so every workflow that does not name another profile
                        is answered by scripted text and never reaches a model.
                      </strong>
                    </div>
                  )}

                  {isOpen && (
                    <div className="settings-item-body">
                      <div className="settings-item-desc">{kindSentence(group.descriptor.kind)}</div>
                      {isExternalUrl(group.descriptor.docsUrl) && (
                        <button
                          className="settings-link"
                          onClick={() => void window.archspace.openExternal(group.descriptor.docsUrl)}
                        >
                          {group.descriptor.docsUrl}
                        </button>
                      )}

                      <div className="ai-bindings">
                        {group.profiles.map((profile) => {
                          const status = statusByName.get(profile.name);
                          const probe = probes[profile.name];
                          const isDefault = profile.name === config.defaultProfile;
                          const explanation =
                            engineReady && status !== undefined ? explainReadiness(status, profile) : '';
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
                                  {group.profiles.length > 1 && (
                                    <button
                                      className="settings-btn settings-btn--small"
                                      disabled={!engineReady || probing !== null}
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
                                  )}
                                  {!isDefault && (
                                    <button
                                      className="settings-btn settings-btn--small"
                                      disabled={saving}
                                      onClick={() => makeDefault(profile.name)}
                                    >
                                      Make default
                                    </button>
                                  )}
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

                              {group.keyRefs.length > 1 && profile.apiKeyRef !== undefined && (
                                <div className="ai-key-line">
                                  <span className="settings-code">{profile.apiKeyRef}</span>
                                  {keyField(profile.apiKeyRef)}
                                  {keyInfoByName.has(profile.apiKeyRef) && (
                                    <button
                                      className="settings-btn settings-btn--small settings-btn--danger"
                                      disabled={keyBusy !== null}
                                      onClick={() => deleteSecret(profile.apiKeyRef!)}
                                    >
                                      Delete key
                                    </button>
                                  )}
                                </div>
                              )}

                              {explanation !== '' && (
                                <div className="settings-item-desc">{explanation}</div>
                              )}
                              {engineReady && status?.detail !== undefined && (
                                <div className="settings-item-desc mono">Engine: {status.detail}</div>
                              )}

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

                      {group.keyRefs.length === 1 && keyInfoByName.has(group.keyRefs[0]) && (
                        <div className="settings-actions">
                          <button
                            className="settings-btn settings-btn--small settings-btn--danger"
                            disabled={keyBusy !== null}
                            onClick={() => deleteSecret(group.keyRefs[0])}
                          >
                            Delete key
                          </button>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}

        {/* A provider that needs more than a key before it can be written. */}
        {pending !== null && (
          <div className="settings-list-item is-muted">
            <div className="settings-item-head">
              <span className="settings-item-name">
                {providerById(pending.id)?.label ?? pending.id}
              </span>
              <span className="badge badge--warn">not added yet</span>
              <span className="settings-item-meta">
                Only the endpoint knows what it serves, so this one needs a model and a URL.
              </span>
            </div>
            <div className="ai-key-line">
              <input
                className={`settings-input settings-input--mono${
                  pending.model.trim() === '' ? ' is-invalid' : ''
                }`}
                value={pending.model}
                spellCheck={false}
                autoComplete="off"
                aria-label="Model"
                placeholder="model id"
                onChange={(e) => setPending({ ...pending, model: e.target.value })}
              />
              <input
                className={`settings-input settings-input--mono${
                  pending.baseUrl.trim() === '' ? ' is-invalid' : ''
                }`}
                value={pending.baseUrl}
                spellCheck={false}
                autoComplete="off"
                aria-label="Endpoint"
                placeholder="http://localhost:1234/v1"
                onChange={(e) => setPending({ ...pending, baseUrl: e.target.value })}
              />
              <button
                className="settings-btn settings-btn--small settings-btn--primary"
                disabled={saving || pending.model.trim() === '' || pending.baseUrl.trim() === ''}
                onClick={createPending}
              >
                Add
              </button>
              <button className="settings-btn settings-btn--small" onClick={() => setPending(null)}>
                Cancel
              </button>
            </div>
          </div>
        )}

        {/* Whether anything is bound is a fact about the FILE, so this stays
            true and useful with the engine dead. */}
        {config !== null && unbound.length > 0 && (
          <div className="ai-unbound">
            <span className="settings-item-meta">Add:</span>
            {unbound.map((provider) => (
              <button
                key={provider.id}
                className="settings-btn settings-btn--small"
                disabled={saving || pending !== null}
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
    </div>
  );
}
