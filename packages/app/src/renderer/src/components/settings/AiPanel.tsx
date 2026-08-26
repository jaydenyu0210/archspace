import { Fragment, useCallback, useEffect, useMemo, useState } from 'react';
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
import type { SecretKeyInfo } from '../../../../shared/protocol';
import type { SettingsPanelProps } from '../Settings';

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
 * Three lines are load-bearing here and each one shapes the markup:
 *
 *  1. **Config and status come from different owners.** The profile LIST is
 *     read from `getAiConfig()` — the file, owned by main — because the user
 *     must be able to edit `ai.yaml` while the engine is dead. The READINESS
 *     comes from `store.aiProfiles`, an engine mirror (§3.2) that is empty
 *     until the engine reports. Empty therefore never renders as "nothing
 *     configured"; with `engineReady === false` every row says the readiness
 *     is unknown, because saying otherwise is the honesty rule's failure mode.
 *  2. **`ready` is not `works`.** `listProfiles()` makes no network call
 *     (status.ts) — it can only prove the binding resolves. The only thing in
 *     this panel that may claim a provider answered is a probe, and it earns
 *     the claim by showing the text the model actually returned. A tick this
 *     panel drew on its own would be a claim it had not paid for.
 *  3. **Secrets are write-only from here.** The bridge deliberately has no
 *     `getSecret` (preload/index.ts header, §12): the renderer may create,
 *     list and delete key NAMES and can never read a value back. So the key
 *     field is a write-only input that is cleared the moment it is stored, and
 *     what the UI reports is existence and creation time — never a value, not
 *     even the one it just sent.
 *
 * The provider catalogue is rendered FROM `PROVIDERS` rather than from a list
 * written into this view, so "which providers exist, and what does each one
 * need" stays answered by data in one file (providers.ts) instead of by a
 * switch here that drifts. `ProviderDescriptor.kind` is surfaced in plain
 * words rather than as jargon: a user deciding between a cloud profile and a
 * local one is deciding whether their drawing leaves the machine, and the
 * `mock` provider — a real entry with `kind: 'test'` — is marked everywhere it
 * can appear, because a scripted answer that looked like a working cloud
 * integration is exactly the lie this codebase refuses to tell.
 *
 * Writes go through `setAiConfig`, but main writes the file verbatim and only
 * validates on the way back IN — so this panel runs the same `validateAiConfig`
 * BEFORE persisting and refuses to write anything the next load would silently
 * rewrite. Errors block; warnings are shown and kept, matching config.ts's rule
 * that a broken profile is reported, not dropped.
 */

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
 */
function explainReadiness(status: ProfileStatus, profile: ModelProfile): string {
  switch (status.readiness) {
    case 'ready':
      return 'Provider, model and key all resolve on this machine. That is a check of the binding, not of the provider — probe it to see whether anything answers.';
    case 'missing-key':
      return profile.apiKeyRef === undefined
        ? `This provider needs an API key and the profile names none. Give it a key reference (a name like "ai.${profile.provider}.api_key"), then store a value for that name under API keys below.`
        : `No value is stored under the key "${profile.apiKeyRef}" on this machine. That name is what this profile asks the keychain for — store a value for exactly that key below.`;
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

const KIND_LABEL: Record<ProviderDescriptor['kind'], string> = {
  cloud: 'cloud',
  local: 'local',
  test: 'test',
};

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

  const [secretKeys, setSecretKeys] = useState<SecretKeyInfo[] | null>(null);
  const [secretsError, setSecretsError] = useState<string | null>(null);
  /** Write-only, per key name, cleared the instant a value is accepted. */
  const [keyDrafts, setKeyDrafts] = useState<Record<string, string>>({});
  const [keyBusy, setKeyBusy] = useState<string | null>(null);

  const [draft, setDraft] = useState<Draft | null>(null);
  const [draftErrors, setDraftErrors] = useState<string[]>([]);
  const [issues, setIssues] = useState<ConfigIssue[]>([]);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState<string | null>(null);

  const [probes, setProbes] = useState<Record<string, ProfileProbeResult>>({});
  const [probing, setProbing] = useState<string | null>(null);

  const loadConfig = useCallback(() => {
    setConfigError(null);
    void window.archspace
      .getAiConfig()
      .then(setConfig)
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
        setConfig(await window.archspace.getAiConfig());
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

  return (
    <div className="settings-panel">
      {/* ---- what a profile is, and where it is written ------------------ */}
      <div className="settings-section">
        <div className="settings-section-head">
          <h3 className="settings-heading">AI Model Profiles</h3>
          {config !== null && (
            <span className="settings-item-meta">
              {config.profiles.length} profile{config.profiles.length === 1 ? '' : 's'} · default:{' '}
              {config.defaultProfile}
            </span>
          )}
        </div>
        <p className="settings-section-desc">
          Workflows reference named profiles — <span className="mono">default</span>,{' '}
          <span className="mono">fast</span>, <span className="mono">reasoning</span> — never a
          provider or a model id. Each profile binds a name to a provider, a model and a key held in
          the OS keychain, so a workflow written by someone on a cloud provider runs unchanged here
          against a local one. These bindings are machine-local and are never saved into a document.
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
        </div>
        {!engineReady && (
          <div className="settings-note settings-note--warn">
            The engine is not connected, so no binding below has been checked against the keychain
            or against a provider. Profiles can still be edited — this panel reads and writes the
            file — but every readiness shown is unknown rather than good.
          </div>
        )}
      </div>

      {/* ---- the profiles ------------------------------------------------ */}
      <div className="settings-section">
        <div className="settings-section-head">
          <h4 className="settings-subheading">Profiles</h4>
          <div className="settings-actions">
            <button
              className="settings-btn settings-btn--small"
              disabled={config === null || draft !== null}
              onClick={() => {
                setDraft(blankDraft());
                setDraftErrors([]);
                setIssues([]);
                setSaveError(null);
              }}
            >
              Add profile
            </button>
          </div>
        </div>

        {configError !== null && (
          <>
            <div className="settings-note settings-note--error">
              Could not read the AI configuration: {configError}
            </div>
            <div className="settings-actions">
              <button className="settings-btn settings-btn--small" onClick={loadConfig}>
                Try again
              </button>
            </div>
          </>
        )}

        {config === null && configError === null && (
          <div className="settings-loading">
            <span className="settings-spinner" /> Reading {props.platform.paths.aiConfig}…
          </div>
        )}

        {blockingIssues.length > 0 && (
          <div className="settings-note settings-note--error">
            Not saved — the file would not survive being read back:
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

        {config !== null && config.profiles.length === 0 && (
          <div className="settings-empty">
            <div className="settings-empty-title">No profiles</div>
            <div className="settings-empty-text">
              Nothing is bound on this machine, so any workflow asking for a model profile will
              refuse to run. Add one to fix that.
            </div>
          </div>
        )}

        {config !== null && (
          <div className="settings-list">
            {config.profiles.map((profile) => {
              const status = statusByName.get(profile.name);
              const provider = providerById(profile.provider);
              const probe = probes[profile.name];
              const isDefault = profile.name === config.defaultProfile;
              const stripe = engineReady && status ? stripeClass(status.readiness) : 'is-muted';
              return (
                <div key={profile.name} className={`settings-list-item ${stripe}`}>
                  <div className="settings-item-head">
                    <span className="settings-item-name">{profile.name}</span>
                    {isDefault && <span className="badge badge--info">default</span>}
                    {!engineReady ? (
                      <span className="badge badge--muted" title="The engine has not reported.">
                        no engine
                      </span>
                    ) : status === undefined ? (
                      <span className="badge badge--info">not reported yet</span>
                    ) : (
                      <span className={badgeClass(status.readiness)}>{READINESS_LABEL[status.readiness]}</span>
                    )}
                    {provider?.kind === 'test' && (
                      <span className="badge badge--unimplemented" title={kindSentence('test')}>
                        no network
                      </span>
                    )}
                    <span className="settings-item-meta">
                      {provider?.label ?? profile.provider} · {profile.model}
                    </span>
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
                            <span className="settings-spinner" /> Probing…
                          </>
                        ) : (
                          'Probe'
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
                        onClick={() => {
                          setDraft(draftFor(profile));
                          setDraftErrors([]);
                          setIssues([]);
                          setSaveError(null);
                        }}
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

                  <div className="settings-item-body">
                    {provider?.kind === 'test' && (
                      <div className="settings-note settings-note--unimplemented">
                        This profile calls nothing. The <span className="mono">mock</span> provider
                        returns deterministic scripted text for offline demos and CI — a successful
                        probe here proves this app works, not that any model or provider does.
                      </div>
                    )}
                    {provider !== undefined && provider.kind !== 'test' && (
                      <div className="settings-item-desc">{kindSentence(provider.kind)}</div>
                    )}
                    {!engineReady ? (
                      <div className="settings-item-desc">
                        Readiness unknown — nothing has checked this binding.
                      </div>
                    ) : status === undefined ? (
                      <div className="settings-item-desc">
                        The engine has not reported on this profile yet. If it was just added, its
                        readiness appears as soon as the engine picks the new config up.
                      </div>
                    ) : (
                      <>
                        <div className="settings-item-desc">{explainReadiness(status, profile)}</div>
                        {status.detail !== undefined && (
                          <div className="settings-item-desc mono">Engine: {status.detail}</div>
                        )}
                      </>
                    )}

                    <div className="settings-kv">
                      <span className="settings-kv-key">Provider</span>
                      <span className="settings-kv-value">
                        {provider?.label ?? profile.provider}{' '}
                        <span className="mono">({profile.provider})</span>
                      </span>
                      <span className="settings-kv-key">Model</span>
                      <span className="settings-kv-value mono">{profile.model}</span>
                      {profile.baseUrl !== undefined && (
                        <>
                          <span className="settings-kv-key">Endpoint</span>
                          <span className="settings-kv-value mono">{profile.baseUrl}</span>
                        </>
                      )}
                      {profile.baseUrl === undefined && provider?.defaultBaseUrl !== undefined && (
                        <>
                          <span className="settings-kv-key">Endpoint</span>
                          <span className="settings-kv-value mono">
                            {provider.defaultBaseUrl} (provider default)
                          </span>
                        </>
                      )}
                      <span className="settings-kv-key">Key ref</span>
                      <span className="settings-kv-value mono">
                        {profile.apiKeyRef ?? (provider?.needsApiKey ? 'none — this provider needs one' : 'none needed')}
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
                          <span className="settings-kv-value mono">{profile.maxOutputTokens} tokens</span>
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
                            {probe.ok ? 'probe answered' : 'probe failed'}
                          </span>
                          {probe.latencyMs !== undefined && (
                            <span className="settings-item-meta">{probe.latencyMs} ms round trip</span>
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
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* ---- the editor -------------------------------------------------- */}
      {draft !== null && config !== null && (
        <div className="settings-section">
          <div className="settings-section-head">
            <h4 className="settings-subheading">
              {draft.original === null ? 'New profile' : `Editing "${draft.original}"`}
            </h4>
          </div>

          {draftErrors.length > 0 && (
            <div className="settings-note settings-note--error">
              {draftErrors.map((message) => (
                <div key={message}>{message}</div>
              ))}
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
              What a workflow asks for. Lowercase letters, digits, <span className="mono">_</span>{' '}
              and <span className="mono">-</span>; renaming one changes what every workflow naming it
              resolves to on this machine.
            </div>
          </div>

          <div className="settings-row">
            <label className="settings-row-label" htmlFor="ai-profile-provider">
              Provider
            </label>
            <div className="settings-row-control">
              <select
                id="ai-profile-provider"
                className="settings-select"
                value={draft.provider}
                onChange={(e) => {
                  const next = providerById(e.target.value);
                  if (next === undefined) return;
                  setDraft({
                    ...draft,
                    provider: next.id,
                    // Offer the conventional key name for the provider just
                    // chosen, but only into an empty field: overwriting a name
                    // the user typed would silently re-point their binding at a
                    // different keychain entry.
                    apiKeyRef: next.needsApiKey && draft.apiKeyRef === '' ? `ai.${next.id}.api_key` : draft.apiKeyRef,
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
            {descriptor !== undefined && (
              <div className="settings-row-hint">
                {descriptor.summary} {kindSentence(descriptor.kind)}
              </div>
            )}
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
              plain text on disk, and a pasted key is refused by the validator. Store the value
              itself under API keys below.
              {descriptor?.needsApiKey === true
                ? ' This provider needs one; without it the profile reports "missing key".'
                : ' This provider does not need one — leave it blank unless your endpoint requires a bearer token.'}
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
                onChange={(e) => setDraft({ ...draft, embeddingModel: e.target.value })}
              />
            </div>
            <div className="settings-row-hint">
              Optional; only <span className="mono">ctx.ai.embed</span> uses it.
              {descriptor !== undefined &&
                descriptor.suggestedEmbeddingModels === undefined &&
                descriptor.kind !== 'test' &&
                ' This provider ships no embeddings endpoint, so setting one here will fail at run time.'}
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
            <div className="settings-row-hint">Blank leaves it to the provider. 0–2.</div>
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
            <div className="settings-row-hint">Blank leaves it to the provider.</div>
          </div>

          {draft.headers !== undefined && (
            <div className="settings-row settings-row--stack">
              <span className="settings-row-label">Custom headers</span>
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
                Kept exactly as they are. There is no editor for headers here — they are hand-written
                in <span className="mono">ai.yaml</span>, and this form carries them through
                untouched rather than deleting them as a side effect of an edit.
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

      {/* ---- keys -------------------------------------------------------- */}
      <div className="settings-section">
        <div className="settings-section-head">
          <h4 className="settings-subheading">API keys</h4>
        </div>
        <p className="settings-section-desc">
          Values are stored in the OS keychain and are write-only from this window: the app can
          create, list and delete key NAMES here, and can never read a value back — not even one it
          has just stored. What is shown below is whether a key exists and when it was first
          written.
        </p>

        {!props.platform.secretsAvailable && (
          <div className="settings-note settings-note--warn">
            This machine's keychain is not backing the app's encrypted store, so storing a secret
            would be refused. Any profile needing a key will keep reporting "missing key" until that
            is fixed; a local provider that needs no key works regardless.
          </div>
        )}

        {secretsError !== null && (
          <div className="settings-note settings-note--error">{secretsError}</div>
        )}

        {secretKeys === null && secretsError === null && (
          <div className="settings-loading">
            <span className="settings-spinner" /> Reading which keys exist…
          </div>
        )}

        {secretKeys !== null && referencedKeys.length === 0 && (
          <div className="settings-empty">
            <div className="settings-empty-title">No key needed</div>
            <div className="settings-empty-text">
              No profile on this machine names an API key. Give a profile a key reference to store a
              credential for it.
            </div>
          </div>
        )}

        {secretKeys !== null && referencedKeys.length > 0 && (
          <div className="settings-list">
            {referencedKeys.map((key) => {
              const info = keyInfoByName.get(key);
              const users = (config?.profiles ?? []).filter((p) => p.apiKeyRef === key).map((p) => p.name);
              return (
                <div key={key} className={`settings-list-item ${info ? 'is-ok' : 'is-warn'}`}>
                  <div className="settings-item-head">
                    <span className="settings-item-name mono">{key}</span>
                    <span className={info ? 'badge badge--ok' : 'badge badge--warn'}>
                      {info ? 'stored' : 'not stored'}
                    </span>
                    {info !== undefined && (
                      <span className="settings-item-meta">
                        first written {new Date(info.createdAt).toLocaleString()}
                      </span>
                    )}
                    <div className="settings-item-actions">
                      {info !== undefined && (
                        <button
                          className="settings-btn settings-btn--small settings-btn--danger"
                          disabled={keyBusy !== null}
                          onClick={() => deleteSecret(key)}
                        >
                          Delete
                        </button>
                      )}
                    </div>
                  </div>
                  <div className="settings-item-body">
                    <div className="settings-item-desc">
                      Used by {users.length > 0 ? users.map((n) => `"${n}"`).join(', ') : 'no profile'}.
                    </div>
                    <div className="settings-row">
                      <label className="settings-row-label" htmlFor={`ai-secret-${key}`}>
                        {info ? 'Replace value' : 'Value'}
                      </label>
                      <div className="settings-row-control">
                        <input
                          id={`ai-secret-${key}`}
                          className="settings-input settings-input--mono"
                          type="password"
                          value={keyDrafts[key] ?? ''}
                          spellCheck={false}
                          autoComplete="off"
                          disabled={!props.platform.secretsAvailable || keyBusy !== null}
                          placeholder={info ? 'a value is stored — type a new one to replace it' : 'paste the key'}
                          onChange={(e) => setKeyDrafts((d) => ({ ...d, [key]: e.target.value }))}
                        />
                        <button
                          className="settings-btn settings-btn--small"
                          disabled={
                            !props.platform.secretsAvailable ||
                            keyBusy !== null ||
                            (keyDrafts[key] ?? '') === ''
                          }
                          onClick={() => storeSecret(key)}
                        >
                          {keyBusy === key ? (
                            <>
                              <span className="settings-spinner" /> Storing…
                            </>
                          ) : (
                            'Store'
                          )}
                        </button>
                      </div>
                      <div className="settings-row-hint">
                        Sent straight to the keychain and cleared from this field. It is not shown
                        again, here or anywhere else in the app.
                      </div>
                    </div>
                  </div>
                </div>
              );
            })}
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

      {/* ---- the catalogue ----------------------------------------------- */}
      <div className="settings-section">
        <div className="settings-section-head">
          <h4 className="settings-subheading">Providers</h4>
        </div>
        <p className="settings-section-desc">
          Every provider a profile can be bound to. No provider is privileged and there is no hosted
          router in this list: a middleman in the data path is not a default an offline-capable app
          gets to choose for you.
        </p>
        <div className="settings-list">
          {PROVIDERS.map((provider) => (
            <div
              key={provider.id}
              className={`settings-list-item ${provider.kind === 'test' ? 'is-muted' : ''}`}
            >
              <div className="settings-item-head">
                <span className="settings-item-name">{provider.label}</span>
                <span className="settings-item-meta">{provider.id}</span>
                {provider.kind === 'test' ? (
                  <span className="badge badge--unimplemented">not a real provider</span>
                ) : (
                  <span className="settings-tag">{KIND_LABEL[provider.kind]}</span>
                )}
                {provider.needsApiKey && <span className="settings-tag">needs an API key</span>}
                {provider.needsBaseUrl && <span className="settings-tag">needs an endpoint</span>}
              </div>
              <div className="settings-item-body">
                <div className="settings-item-desc">{provider.summary}</div>
                <div className="settings-item-desc">{kindSentence(provider.kind)}</div>
                {isExternalUrl(provider.docsUrl) ? (
                  <button
                    className="settings-link"
                    onClick={() => void window.archspace.openExternal(provider.docsUrl)}
                  >
                    {provider.docsUrl}
                  </button>
                ) : (
                  <div className="settings-path">
                    <span className="settings-code" title={provider.docsUrl}>
                      {provider.docsUrl}
                    </span>
                    <span className="settings-item-meta">in this repository — it has no upstream</span>
                  </div>
                )}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
