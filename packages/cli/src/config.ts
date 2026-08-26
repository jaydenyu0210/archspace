/**
 * Headless configuration for the CLI.
 *
 * The CLI reads the SAME `mcp.yaml`, `ai.yaml` and `plugins.json` the desktop
 * app writes, from the same directory, because a workflow that runs in the app
 * has to run in CI against the same bindings — that is the whole point of
 * keeping bindings out of the workflow document (ARCHITECTURE §9.1) and of the
 * CLI being both a user feature and the integration harness (ADR-0013).
 *
 * Secrets are the one place the CLI cannot follow the app: there is no
 * Electron `safeStorage` here, and reading the app's encrypted store from a
 * plain Node process is not something the OS will allow anyway. So the CLI
 * resolves secrets from the environment — `ARCHSPACE_SECRET_<KEY>` — which is
 * also exactly how MCP's own spec expects a stdio server's credentials to
 * arrive (research §5: "stdio servers get credentials from the environment").
 * A missing secret is reported by name; it is never silently empty.
 */
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import { join, resolve } from 'node:path';
import {
  AI_CONFIG_FILENAME,
  defaultAiConfig,
  parseAiConfig,
  type AiGatewayConfig,
} from '@archspace/ai-gateway';
import { MCP_CONFIG_FILENAME, defaultMcpConfig, parseMcpConfig, type McpConfig } from '@archspace/mcp-host';

export interface CliConfig {
  dir: string;
  mcp: McpConfig;
  ai: AiGatewayConfig;
  pluginConsent: Record<string, { enabled: boolean; permissions: string[] }>;
  issues: string[];
}

/** Same directory Electron's `app.getPath('userData')` resolves to. */
export function defaultConfigDir(): string {
  const override = process.env['ARCHSPACE_CONFIG_DIR'];
  if (override !== undefined && override !== '') return resolve(override);
  const home = homedir();
  switch (platform()) {
    case 'darwin':
      return join(home, 'Library', 'Application Support', 'Archspace');
    case 'win32':
      return join(process.env['APPDATA'] ?? join(home, 'AppData', 'Roaming'), 'Archspace');
    default:
      return join(process.env['XDG_CONFIG_HOME'] ?? join(home, '.config'), 'Archspace');
  }
}

async function readOptional(path: string): Promise<string | null> {
  if (!existsSync(path)) return null;
  try {
    return await readFile(path, 'utf8');
  } catch {
    return null;
  }
}

export async function loadCliConfig(dir = defaultConfigDir()): Promise<CliConfig> {
  const issues: string[] = [];

  const mcpText = await readOptional(join(dir, MCP_CONFIG_FILENAME));
  const mcpParsed = mcpText === null ? { config: defaultMcpConfig(), issues: [] } : parseMcpConfig(mcpText);
  for (const issue of mcpParsed.issues) issues.push(`${MCP_CONFIG_FILENAME} ${issue.path}: ${issue.message}`);

  const aiText = await readOptional(join(dir, AI_CONFIG_FILENAME));
  const aiParsed = aiText === null ? { config: defaultAiConfig(), issues: [] } : parseAiConfig(aiText);
  for (const issue of aiParsed.issues) issues.push(`${AI_CONFIG_FILENAME} ${issue.path}: ${issue.message}`);

  let pluginConsent: CliConfig['pluginConsent'] = {};
  const consentText = await readOptional(join(dir, 'plugins.json'));
  if (consentText !== null) {
    try {
      const parsed: unknown = JSON.parse(consentText);
      if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
        pluginConsent = parsed as CliConfig['pluginConsent'];
      }
    } catch {
      issues.push('plugins.json is not valid JSON; treating every plugin as unconsented');
    }
  }

  return { dir, mcp: mcpParsed.config, ai: aiParsed.config, pluginConsent, issues };
}

/**
 * `ARCHSPACE_SECRET_<KEY>`, upper-cased with non-alphanumerics folded to `_`.
 * `acme_api_key` → `ARCHSPACE_SECRET_ACME_API_KEY`.
 */
export function envVarForSecret(key: string): string {
  return `ARCHSPACE_SECRET_${key.replace(/[^A-Za-z0-9]+/g, '_').toUpperCase()}`;
}

export const cliSecrets = {
  async get(key: string): Promise<string | undefined> {
    return process.env[envVarForSecret(key)];
  },
};

export const cliStrictSecrets = {
  async get(key: string): Promise<string> {
    const value = await cliSecrets.get(key);
    if (value === undefined) {
      throw new Error(`secret "${key}" is not set — export ${envVarForSecret(key)} before running`);
    }
    return value;
  },
};

/**
 * Where bundled first-party plugins live when running from the workspace.
 * Resolved from this file's own location so it works from any cwd.
 */
export function workspacePluginsDir(fromUrl: string): string | null {
  // packages/cli/src/config.ts → repo root → plugins/
  const dir = resolve(new URL('.', fromUrl).pathname, '..', '..', '..', 'plugins');
  return existsSync(dir) ? dir : null;
}
