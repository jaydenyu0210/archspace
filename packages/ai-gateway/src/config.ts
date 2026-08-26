/**
 * `ai.yaml` — named model profiles, the indirection that makes a workflow
 * portable (ARCHITECTURE §10 / ADR-0010).
 *
 * A workflow says `profile: default`; *this machine* says what `default` means.
 * That is the whole point: a colleague on Anthropic and a colleague on a local
 * Ollama run the same document unchanged. So this file is machine-local, lives
 * beside `mcp.yaml`, and is hand-editable on purpose.
 *
 * Two rules the validator enforces rather than trusts:
 *
 *  1. **A profile carries a secret KEY, never a secret value** (§6.1, §11).
 *     `apiKeyRef` names an entry in the OS keychain; anything that looks like
 *     an actual credential is rejected as an error, because a settings file is
 *     exactly the sort of place a pasted key goes to leak from.
 *  2. **A broken profile is kept, not dropped.** Validation reports what is
 *     wrong and leaves the binding in place, so `listProfiles()` can show it as
 *     `invalid` with a reason. Silently deleting a user's hand-written binding
 *     because one field is wrong is a worse outcome than a red row in settings.
 *     The one exception is an entry we cannot represent at all (no name, or a
 *     provider id that is not in the catalogue) — there is nothing to keep.
 */
import { PROVIDERS, providerById, providerHasEmbeddings, type ProviderId } from './providers.js';
import { emitYamlSubset, parseYamlSubset, YamlSubsetError, type YamlValue } from './yaml-lite.js';

export interface ModelProfile {
  name: string;
  provider: ProviderId;
  model: string;
  baseUrl?: string;
  /** Secret KEY, never a secret value (ARCHITECTURE §6.1, §11). */
  apiKeyRef?: string;
  embeddingModel?: string;
  temperature?: number;
  maxOutputTokens?: number;
  headers?: Record<string, string>;
}

export interface AiGatewayConfig {
  profiles: ModelProfile[];
  defaultProfile: string;
}

export interface ConfigIssue {
  severity: 'error' | 'warning';
  path: string;
  message: string;
}

/** YAML persistence (ai.yaml alongside mcp.yaml, ARCHITECTURE §9.1 pattern). */
export const AI_CONFIG_FILENAME = 'ai.yaml';

/** Profile names are workflow-visible identifiers, like MCP server names. */
const PROFILE_NAME = /^[a-z][a-z0-9_-]*$/;

/** Heuristics for "this is a credential, not a key name" (see rule 1 above). */
const LOOKS_LIKE_SECRET = /^(sk-|xoxb-|ghp_|AIza)|^[A-Za-z0-9_-]{40,}$/;

/**
 * The out-of-the-box binding: one cloud profile and one local profile, so the
 * first thing a new user sees is that both are ordinary, equal choices. The
 * cloud one ships unbound (no key) — it is a suggestion, not an activation.
 */
export function defaultAiConfig(): AiGatewayConfig {
  return {
    profiles: [
      {
        name: 'default',
        provider: 'anthropic',
        model: 'claude-opus-5',
        apiKeyRef: 'ai.anthropic.api_key',
      },
      {
        name: 'local',
        provider: 'ollama',
        model: 'llama3.1',
        baseUrl: 'http://localhost:11434/v1',
        embeddingModel: 'nomic-embed-text',
      },
    ],
    defaultProfile: 'default',
  };
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function validateProfile(
  raw: Record<string, unknown>,
  index: number,
  issues: ConfigIssue[],
): ModelProfile | null {
  const at = `profiles[${index}]`;
  const name = raw.name;
  if (typeof name !== 'string' || name.trim() === '') {
    issues.push({ severity: 'error', path: `${at}.name`, message: 'a profile needs a name; entry ignored' });
    return null;
  }
  if (!PROFILE_NAME.test(name)) {
    issues.push({
      severity: 'warning',
      path: `${at}.name`,
      message: `"${name}" is an unusual profile name; prefer lowercase letters, digits, "_" and "-"`,
    });
  }

  const descriptor = typeof raw.provider === 'string' ? providerById(raw.provider) : undefined;
  if (descriptor === undefined) {
    issues.push({
      severity: 'error',
      path: `${at}.provider`,
      message: `unknown provider ${JSON.stringify(raw.provider)}; expected one of ${PROVIDERS.map((p) => p.id).join(', ')}. Entry ignored`,
    });
    return null;
  }

  const profile: ModelProfile = { name, provider: descriptor.id, model: '' };

  if (typeof raw.model === 'string' && raw.model.trim() !== '') {
    profile.model = raw.model;
  } else {
    issues.push({ severity: 'error', path: `${at}.model`, message: 'a profile needs a model id' });
  }

  if (raw.baseUrl !== undefined) {
    if (typeof raw.baseUrl !== 'string' || !/^https?:\/\//.test(raw.baseUrl)) {
      issues.push({ severity: 'error', path: `${at}.baseUrl`, message: 'baseUrl must be an http(s) URL; ignored' });
    } else {
      profile.baseUrl = raw.baseUrl.replace(/\/+$/, '');
    }
  }
  if (descriptor.needsBaseUrl && profile.baseUrl === undefined) {
    issues.push({
      severity: 'error',
      path: `${at}.baseUrl`,
      message: `provider "${descriptor.id}" has no default endpoint — set baseUrl to the server you are running`,
    });
  }

  if (raw.apiKeyRef !== undefined) {
    if (typeof raw.apiKeyRef !== 'string' || raw.apiKeyRef.trim() === '') {
      issues.push({ severity: 'error', path: `${at}.apiKeyRef`, message: 'apiKeyRef must be a secret key name; ignored' });
    } else if (LOOKS_LIKE_SECRET.test(raw.apiKeyRef)) {
      issues.push({
        severity: 'error',
        path: `${at}.apiKeyRef`,
        message: 'apiKeyRef looks like an API key itself — it must name a keychain entry, never hold the credential. Ignored',
      });
    } else {
      profile.apiKeyRef = raw.apiKeyRef;
    }
  }
  if (descriptor.needsApiKey && profile.apiKeyRef === undefined) {
    issues.push({
      severity: 'warning',
      path: `${at}.apiKeyRef`,
      message: `provider "${descriptor.id}" needs an API key; the profile will report "missing-key" until one is bound`,
    });
  }

  if (raw.embeddingModel !== undefined) {
    if (typeof raw.embeddingModel !== 'string' || raw.embeddingModel.trim() === '') {
      issues.push({ severity: 'error', path: `${at}.embeddingModel`, message: 'embeddingModel must be a model id; ignored' });
    } else {
      profile.embeddingModel = raw.embeddingModel;
      // Asked of the one authority (providers.ts), not derived from whether the
      // catalogue happens to suggest a model id. See providerHasEmbeddings.
      if (!providerHasEmbeddings(descriptor.id)) {
        issues.push({
          severity: 'warning',
          path: `${at}.embeddingModel`,
          message: `provider "${descriptor.id}" has no embeddings endpoint; ctx.ai.embed will fail on this profile`,
        });
      }
    }
  }

  if (raw.temperature !== undefined) {
    if (typeof raw.temperature !== 'number' || !Number.isFinite(raw.temperature) || raw.temperature < 0 || raw.temperature > 2) {
      issues.push({ severity: 'error', path: `${at}.temperature`, message: 'temperature must be a number between 0 and 2; ignored' });
    } else {
      profile.temperature = raw.temperature;
    }
  }

  if (raw.maxOutputTokens !== undefined) {
    if (typeof raw.maxOutputTokens !== 'number' || !Number.isInteger(raw.maxOutputTokens) || raw.maxOutputTokens < 1) {
      issues.push({ severity: 'error', path: `${at}.maxOutputTokens`, message: 'maxOutputTokens must be a positive integer; ignored' });
    } else {
      profile.maxOutputTokens = raw.maxOutputTokens;
    }
  }

  if (raw.headers !== undefined) {
    if (!isRecord(raw.headers)) {
      issues.push({ severity: 'error', path: `${at}.headers`, message: 'headers must be a mapping of header name to value; ignored' });
    } else {
      const headers: Record<string, string> = {};
      for (const [key, value] of Object.entries(raw.headers)) {
        if (typeof value !== 'string') {
          issues.push({ severity: 'error', path: `${at}.headers.${key}`, message: 'header values must be strings; ignored' });
          continue;
        }
        if (LOOKS_LIKE_SECRET.test(value)) {
          issues.push({
            severity: 'error',
            path: `${at}.headers.${key}`,
            message: 'this header value looks like a credential; put it in the keychain and use apiKeyRef. Ignored',
          });
          continue;
        }
        headers[key] = value;
      }
      if (Object.keys(headers).length > 0) profile.headers = headers;
    }
  }

  return profile;
}

export function validateAiConfig(c: unknown): { config: AiGatewayConfig; issues: ConfigIssue[] } {
  const issues: ConfigIssue[] = [];
  if (!isRecord(c)) {
    issues.push({ severity: 'error', path: '', message: 'ai config must be a mapping; using defaults for this session' });
    return { config: defaultAiConfig(), issues };
  }

  const profiles: ModelProfile[] = [];
  const rawProfiles = c.profiles;
  if (!Array.isArray(rawProfiles)) {
    issues.push({ severity: 'error', path: 'profiles', message: 'profiles must be a list; using defaults for this session' });
  } else {
    const seen = new Set<string>();
    rawProfiles.forEach((raw, index) => {
      if (!isRecord(raw)) {
        issues.push({ severity: 'error', path: `profiles[${index}]`, message: 'a profile must be a mapping; entry ignored' });
        return;
      }
      const profile = validateProfile(raw, index, issues);
      if (profile === null) return;
      if (seen.has(profile.name)) {
        issues.push({
          severity: 'error',
          path: `profiles[${index}].name`,
          message: `duplicate profile name "${profile.name}"; the later entry is ignored`,
        });
        return;
      }
      seen.add(profile.name);
      profiles.push(profile);
    });
  }

  if (profiles.length === 0) {
    issues.push({ severity: 'error', path: 'profiles', message: 'no usable model profile; using defaults for this session' });
    return { config: defaultAiConfig(), issues };
  }

  const first = profiles[0] as ModelProfile;
  let defaultProfile = first.name;
  if (typeof c.defaultProfile !== 'string' || c.defaultProfile === '') {
    issues.push({
      severity: 'error',
      path: 'defaultProfile',
      message: `defaultProfile is missing; falling back to "${defaultProfile}"`,
    });
  } else if (!profiles.some((p) => p.name === c.defaultProfile)) {
    issues.push({
      severity: 'error',
      path: 'defaultProfile',
      message: `defaultProfile "${c.defaultProfile}" is not one of the configured profiles; falling back to "${defaultProfile}"`,
    });
  } else {
    defaultProfile = c.defaultProfile;
  }

  return { config: { profiles, defaultProfile }, issues };
}

export function parseAiConfig(text: string): { config: AiGatewayConfig; issues: ConfigIssue[] } {
  let parsed: YamlValue;
  try {
    parsed = parseYamlSubset(text);
  } catch (err) {
    const message = err instanceof YamlSubsetError ? err.message : String(err);
    return {
      config: defaultAiConfig(),
      issues: [
        {
          severity: 'error',
          path: AI_CONFIG_FILENAME,
          message: `${message}. The file was left untouched; using defaults for this session`,
        },
      ],
    };
  }
  if (parsed === null) return { config: defaultAiConfig(), issues: [] };
  return validateAiConfig(parsed);
}

const HEADER = `# Archspace AI model profiles.
#
# Workflows reference profile NAMES ("default", "fast", "local"), never
# providers — so the same workflow runs on whatever this machine is bound to.
#
# apiKeyRef names a KEY in the OS keychain. Never paste a credential here.
`;

/** Canonical emission: fixed key order, LF endings, no trailing whitespace. */
export function serializeAiConfig(config: AiGatewayConfig): string {
  const profiles: YamlValue[] = config.profiles.map((p) => ({
    name: p.name,
    provider: p.provider,
    model: p.model,
    baseUrl: p.baseUrl,
    apiKeyRef: p.apiKeyRef,
    embeddingModel: p.embeddingModel,
    temperature: p.temperature,
    maxOutputTokens: p.maxOutputTokens,
    headers: p.headers,
  }));
  return HEADER + emitYamlSubset({ defaultProfile: config.defaultProfile, profiles });
}
