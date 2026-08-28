/**
 * Machine-local settings, owned by the main process because main is the only
 * process with the filesystem and the OS keychain.
 *
 * Three files live side by side in userData, all hand-editable on purpose
 * (ARCHITECTURE §9.1 — the binding for a logical server name is a property of
 * *this machine*, never of a shared workflow file):
 *
 *   mcp.yaml      logical MCP server name → transport binding
 *   ai.yaml       named model profiles → provider + model
 *   plugins.json  per-plugin enable/permission consent
 *
 * Secrets are the deliberate exception: they are never in any of those files.
 * They live in `secrets.json` encrypted with Electron's safeStorage (Keychain
 * on macOS), and only ever travel main → engine child. The renderer can write
 * a secret and list which KEYS exist; it can never read a value back. That
 * asymmetry is the whole point — a compromised renderer cannot exfiltrate a
 * key, and no credential can leak into a workflow document (§11, §12).
 */
import { app, safeStorage } from 'electron';
import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  AI_CONFIG_FILENAME,
  defaultAiConfig,
  parseAiConfig,
  serializeAiConfig,
  type AiGatewayConfig,
} from '@archspace/ai-gateway';
import {
  MCP_CONFIG_FILENAME,
  defaultMcpConfig,
  parseMcpConfig,
  serializeMcpConfig,
  type McpConfig,
} from '@archspace/mcp-host';
import type { OAuthStoreSlot, PluginConsentState, SecretKeyInfo } from '../shared/protocol';
import { parsePluginConsent, type ParsedConsent } from './consent';

const SECRETS_FILENAME = 'secrets.json';
const PLUGIN_CONSENT_FILENAME = 'plugins.json';
const OAUTH_FILENAME = 'mcp-oauth.json';

export function userDataDir(): string {
  return app.getPath('userData');
}
export function mcpConfigPath(): string {
  return join(userDataDir(), MCP_CONFIG_FILENAME);
}
export function aiConfigPath(): string {
  return join(userDataDir(), AI_CONFIG_FILENAME);
}
export function userPluginsDir(): string {
  return join(userDataDir(), 'plugins');
}
export function workflowsDir(): string {
  return join(userDataDir(), 'workflows');
}

/** Write via a temp file + rename so a crash mid-write cannot truncate config. */
async function writeAtomic(path: string, text: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  await writeFile(tmp, text, 'utf8');
  await rename(tmp, path);
}

async function readIfPresent(path: string): Promise<string | null> {
  if (!existsSync(path)) return null;
  try {
    return await readFile(path, 'utf8');
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// mcp.yaml / ai.yaml
// ---------------------------------------------------------------------------

/**
 * Read a config file, seeding it on first launch. A malformed file is NOT
 * silently replaced — the defaults are returned for this session and the
 * user's file is left exactly as they wrote it, so a typo never destroys a
 * hand-maintained binding.
 */
export async function loadMcpConfig(): Promise<{ config: McpConfig; issues: string[] }> {
  const text = await readIfPresent(mcpConfigPath());
  if (text === null) {
    const config = defaultMcpConfig();
    await writeAtomic(mcpConfigPath(), serializeMcpConfig(config));
    return { config, issues: [] };
  }
  const parsed = parseMcpConfig(text);
  return {
    config: parsed.config,
    issues: parsed.issues.filter((i) => i.severity === 'error').map((i) => `${i.path}: ${i.message}`),
  };
}

export async function saveMcpConfig(config: McpConfig): Promise<void> {
  await writeAtomic(mcpConfigPath(), serializeMcpConfig(config));
}

export async function loadAiConfig(): Promise<{ config: AiGatewayConfig; issues: string[] }> {
  const text = await readIfPresent(aiConfigPath());
  if (text === null) {
    const config = defaultAiConfig();
    await writeAtomic(aiConfigPath(), serializeAiConfig(config));
    return { config, issues: [] };
  }
  const parsed = parseAiConfig(text);
  return {
    config: parsed.config,
    issues: parsed.issues.filter((i) => i.severity === 'error').map((i) => `${i.path}: ${i.message}`),
  };
}

export async function saveAiConfig(config: AiGatewayConfig): Promise<void> {
  await writeAtomic(aiConfigPath(), serializeAiConfig(config));
}

// ---------------------------------------------------------------------------
// Plugin consent
// ---------------------------------------------------------------------------

export async function loadPluginConsent(): Promise<PluginConsentState> {
  return (await loadPluginConsentWithIssues()).consent;
}

/**
 * The same read, with what could not be read.
 *
 * Kept beside the plain version rather than replacing it because most callers
 * only need the state — but a caller that is about to tell the user which
 * plugins are consented needs to be able to say "and this file was damaged",
 * or a consent record that silently reset looks exactly like one the user
 * forgot they had granted.
 */
export async function loadPluginConsentWithIssues(): Promise<ParsedConsent> {
  return parsePluginConsent(await readIfPresent(join(userDataDir(), PLUGIN_CONSENT_FILENAME)));
}

export async function savePluginConsent(state: PluginConsentState): Promise<void> {
  await writeAtomic(join(userDataDir(), PLUGIN_CONSENT_FILENAME), `${JSON.stringify(state, null, 2)}\n`);
}

// ---------------------------------------------------------------------------
// Secrets (safeStorage-encrypted, main-process only)
// ---------------------------------------------------------------------------

interface SecretRecord {
  /** base64 of the safeStorage ciphertext. */
  cipher: string;
  createdAt: number;
}

type SecretsFile = Record<string, SecretRecord>;

let secretsCache: SecretsFile | null = null;

async function readSecrets(): Promise<SecretsFile> {
  if (secretsCache !== null) return secretsCache;
  const text = await readIfPresent(join(userDataDir(), SECRETS_FILENAME));
  if (text === null) {
    secretsCache = {};
    return secretsCache;
  }
  try {
    const parsed: unknown = JSON.parse(text);
    secretsCache = typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? (parsed as SecretsFile) : {};
  } catch {
    secretsCache = {};
  }
  return secretsCache;
}

async function writeSecrets(file: SecretsFile): Promise<void> {
  secretsCache = file;
  await writeAtomic(join(userDataDir(), SECRETS_FILENAME), `${JSON.stringify(file, null, 2)}\n`);
}

export function secretsAvailable(): boolean {
  try {
    return safeStorage.isEncryptionAvailable();
  } catch {
    return false;
  }
}

export async function listSecretKeys(): Promise<SecretKeyInfo[]> {
  const file = await readSecrets();
  return Object.entries(file)
    .map(([key, record]) => ({ key, createdAt: record.createdAt }))
    .sort((a, b) => a.key.localeCompare(b.key));
}

export async function setSecret(key: string, value: string): Promise<void> {
  if (!secretsAvailable()) {
    // Refusing beats writing plaintext: a "saved" key the OS cannot protect is
    // worse than an honest failure the user can act on.
    throw new Error(
      'The OS keychain is unavailable, so secrets cannot be stored safely. ' +
        'Set the value as an environment variable for the MCP server instead, or run on a session with a keychain.',
    );
  }
  const file = { ...(await readSecrets()) };
  file[key] = {
    cipher: safeStorage.encryptString(value).toString('base64'),
    createdAt: file[key]?.createdAt ?? Date.now(),
  };
  await writeSecrets(file);
}

export async function deleteSecret(key: string): Promise<void> {
  const file = { ...(await readSecrets()) };
  delete file[key];
  await writeSecrets(file);
}

/** Resolve a secret VALUE. Only ever called on behalf of the engine child. */
export async function getSecret(key: string): Promise<string | undefined> {
  const file = await readSecrets();
  const record = file[key];
  if (record === undefined) return undefined;
  if (!secretsAvailable()) return undefined;
  try {
    return safeStorage.decryptString(Buffer.from(record.cipher, 'base64'));
  } catch {
    // A ciphertext this machine can no longer decrypt (restored backup, new
    // keychain) is a missing secret, not a crash.
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// MCP OAuth token store
// ---------------------------------------------------------------------------

/**
 * Client registrations, PKCE verifiers and tokens for authenticated remote MCP
 * servers. Encrypted with the same key as `secrets.json` and kept separate from
 * it so a user clearing their API keys does not silently drop OAuth sessions.
 */
type OAuthFile = Record<string, Partial<Record<OAuthStoreSlot, string>>>;

let oauthCache: OAuthFile | null = null;

async function readOAuth(): Promise<OAuthFile> {
  if (oauthCache !== null) return oauthCache;
  const text = await readIfPresent(join(userDataDir(), OAUTH_FILENAME));
  if (text === null) {
    oauthCache = {};
    return oauthCache;
  }
  try {
    const parsed: unknown = JSON.parse(text);
    oauthCache = typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? (parsed as OAuthFile) : {};
  } catch {
    oauthCache = {};
  }
  return oauthCache;
}

export async function readOAuthSlot(server: string, slot: OAuthStoreSlot): Promise<string | null> {
  const file = await readOAuth();
  const cipher = file[server]?.[slot];
  if (cipher === undefined) return null;
  if (!secretsAvailable()) return null;
  try {
    return safeStorage.decryptString(Buffer.from(cipher, 'base64'));
  } catch {
    return null;
  }
}

export async function writeOAuthSlot(server: string, slot: OAuthStoreSlot, json: string | null): Promise<void> {
  if (!secretsAvailable()) {
    throw new Error('The OS keychain is unavailable, so OAuth tokens cannot be stored safely.');
  }
  const file = { ...(await readOAuth()) };
  const entry = { ...(file[server] ?? {}) };
  if (json === null) {
    delete entry[slot];
  } else {
    entry[slot] = safeStorage.encryptString(json).toString('base64');
  }
  file[server] = entry;
  oauthCache = file;
  await writeAtomic(join(userDataDir(), OAUTH_FILENAME), `${JSON.stringify(file, null, 2)}\n`);
}
