/**
 * `archspace-plugin.json` — the declaration a plugin makes about itself
 * (ARCHITECTURE §8.2, ADR-0008 §2).
 *
 * The manifest is the only thing the host trusts *before* it starts the plugin
 * process, so parsing is deliberately unforgiving: an unknown permission is an
 * error rather than a shrug, because a permission nobody understands cannot be
 * consented to honestly, and a manifest that says less than the code does is
 * exactly the failure mode consent exists to prevent.
 *
 * Contract of the return value: `manifest` is non-null iff the JSON is a
 * *structurally* valid manifest. `issues` may still contain `severity: 'error'`
 * next to a non-null manifest — a missing entry file, say — because the caller
 * wants the parsed identity (name, version, permissions) in order to *report*
 * the failure well. The host's rule is simple: any error issue ⇒ the plugin
 * does not load.
 */
import { existsSync } from 'node:fs';
import { isAbsolute, join, normalize, resolve, sep } from 'node:path';

/** The node-contract ABI a plugin is built against. Bumped when
 *  `@archspace/node-sdk`'s `NodeModule`/`NodeContext` change incompatibly. */
export const ENGINE_API = 1;

export const PLUGIN_MANIFEST_FILENAME = 'archspace-plugin.json';

export interface PluginManifest {
  name: string;
  version: string;
  namespace: string;
  displayName: string;
  description?: string;
  author?: string;
  license?: string;
  engineApi: number;
  entry: string;
  permissions: string[];
  types?: { name: string; label: string }[];
}

export interface ConfigIssue {
  severity: 'error' | 'warning';
  path: string;
  message: string;
}

/** Plugin id: kebab-case, because it is also a directory name and a UI key. */
const NAME_RE = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;
/** Namespace: dotted snake_case segments, so `<namespace>.<node>` is a legal
 *  node type id under the registry's rule in @archspace/node-sdk. */
const NAMESPACE_RE = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)*$/;
const SECRET_KEY_RE = /^[A-Za-z0-9_.-]+$/;
/** Not full semver — plugins may ship "1.2.3-beta.1"; we only need it to be a
 *  stable string we can compare for consent re-arming. */
const VERSION_RE = /^[0-9A-Za-z][0-9A-Za-z.+-]*$/;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** True when `entry` stays inside the plugin directory. A plugin that points
 *  its entry at `../../something` is not a packaging mistake, it is an escape. */
export function isContainedRelativePath(entry: string): boolean {
  if (entry.length === 0) return false;
  if (isAbsolute(entry) || /^[A-Za-z]:/.test(entry)) return false;
  const normalized = normalize(entry);
  return !normalized.startsWith('..') && !normalized.split(sep).includes('..');
}

export function parsePluginManifest(
  json: unknown,
  opts: { dir?: string } = {},
): { manifest: PluginManifest | null; issues: ConfigIssue[] } {
  const issues: ConfigIssue[] = [];
  const error = (path: string, message: string): void => {
    issues.push({ severity: 'error', path, message });
  };
  const warn = (path: string, message: string): void => {
    issues.push({ severity: 'warning', path, message });
  };

  if (!isRecord(json)) {
    error('', `${PLUGIN_MANIFEST_FILENAME} must contain a JSON object`);
    return { manifest: null, issues };
  }

  const str = (key: string, re?: RegExp, hint?: string): string | null => {
    const value = json[key];
    if (typeof value !== 'string' || value.trim().length === 0) {
      error(key, `"${key}" is required and must be a non-empty string`);
      return null;
    }
    if (re && !re.test(value)) {
      error(key, `"${key}" is invalid: ${hint ?? `expected ${String(re)}`}`);
      return null;
    }
    return value;
  };

  const name = str('name', NAME_RE, 'a kebab-case id such as "acme-pointcloud"');
  const version = str('version', VERSION_RE, 'a version string such as "0.3.1"');
  const namespace = str('namespace', NAMESPACE_RE, 'dotted lowercase segments such as "acme.pointcloud"');
  const displayName = str('displayName');
  const entry = str('entry');

  if (entry !== null && !isContainedRelativePath(entry)) {
    error('entry', `"entry" must be a relative path inside the plugin directory, got "${entry}"`);
  } else if (entry !== null && opts.dir !== undefined && !existsSync(resolve(opts.dir, entry))) {
    error('entry', `entry "${entry}" does not exist — the plugin has not been built`);
  }

  const engineApiRaw = json.engineApi;
  let engineApi = ENGINE_API;
  if (typeof engineApiRaw !== 'number' || !Number.isInteger(engineApiRaw) || engineApiRaw < 1) {
    error('engineApi', '"engineApi" is required and must be a positive integer');
  } else {
    engineApi = engineApiRaw;
    if (engineApi !== ENGINE_API) {
      warn(
        'engineApi',
        `plugin targets engine API ${engineApi}; this build implements ${ENGINE_API} — it will not be loaded`,
      );
    }
  }

  const permissions: string[] = [];
  const permissionsRaw = json.permissions;
  if (permissionsRaw !== undefined) {
    if (!Array.isArray(permissionsRaw)) {
      error('permissions', '"permissions" must be an array of strings');
    } else {
      permissionsRaw.forEach((permission, index) => {
        if (typeof permission !== 'string') {
          error(`permissions[${index}]`, 'each permission must be a string');
          return;
        }
        if (!isKnownPermission(permission)) {
          error(
            `permissions[${index}]`,
            `unknown permission "${permission}" — this build understands "net" and "secrets:<key>"`,
          );
        }
        if (permissions.includes(permission)) {
          warn(`permissions[${index}]`, `duplicate permission "${permission}"`);
          return;
        }
        permissions.push(permission);
      });
    }
  }

  let types: { name: string; label: string }[] | undefined;
  const typesRaw = json.types;
  if (typesRaw !== undefined) {
    if (!Array.isArray(typesRaw)) {
      error('types', '"types" must be an array of { name, label }');
    } else {
      types = [];
      typesRaw.forEach((entryValue, index) => {
        if (!isRecord(entryValue) || typeof entryValue.name !== 'string' || typeof entryValue.label !== 'string') {
          error(`types[${index}]`, 'each declared type needs a string "name" and "label"');
          return;
        }
        types!.push({ name: entryValue.name, label: entryValue.label });
      });
    }
  }

  const optionalText = (key: 'description' | 'author' | 'license'): string | undefined => {
    const value = json[key];
    if (value === undefined) return undefined;
    if (typeof value !== 'string') {
      warn(key, `"${key}" should be a string; ignoring`);
      return undefined;
    }
    return value;
  };

  if (name === null || version === null || namespace === null || displayName === null || entry === null) {
    return { manifest: null, issues };
  }

  const manifest: PluginManifest = {
    name,
    version,
    namespace,
    displayName,
    engineApi,
    entry,
    permissions,
    ...(optionalText('description') !== undefined ? { description: optionalText('description')! } : {}),
    ...(optionalText('author') !== undefined ? { author: optionalText('author')! } : {}),
    ...(optionalText('license') !== undefined ? { license: optionalText('license')! } : {}),
    ...(types !== undefined ? { types } : {}),
  };
  return { manifest, issues };
}

export function isKnownPermission(permission: string): boolean {
  if (permission === 'net') return true;
  if (permission.startsWith('secrets:')) return SECRET_KEY_RE.test(permission.slice('secrets:'.length));
  return false;
}

/** The secret key a `secrets:<key>` permission refers to, or null. */
export function secretKeyOf(permission: string): string | null {
  return permission.startsWith('secrets:') ? permission.slice('secrets:'.length) : null;
}

/**
 * Consent-dialog copy. The `detail` says what the permission *actually* allows,
 * including what it does not stop — a consent dialog that oversells the
 * boundary is worse than none, given ADR-0008's honesty clause.
 */
export function describePermission(permission: string): { title: string; detail: string; risk: 'low' | 'medium' | 'high' } {
  if (permission === 'net') {
    return {
      title: 'Network access',
      detail:
        'Lets this plugin make outbound HTTP requests. The request is performed by Archspace on the plugin’s behalf, so it can be logged and revoked — but the plugin chooses the address and the body, so anything it can see it can send.',
      risk: 'high',
    };
  }
  const key = secretKeyOf(permission);
  if (key !== null && SECRET_KEY_RE.test(key)) {
    return {
      title: `Secret “${key}”`,
      detail: `Reads the value stored under “${key}” in the OS keychain. No other secret is reachable, and the secrets file itself is not.`,
      risk: 'medium',
    };
  }
  return {
    title: `Unrecognised permission “${permission}”`,
    detail:
      'This build does not know what this permission grants, so it cannot be granted. The plugin will not load until it declares only permissions this version understands.',
    risk: 'high',
  };
}

/** Absolute path of a plugin's entry, given its directory. */
export function entryPath(dir: string, manifest: PluginManifest): string {
  return join(dir, manifest.entry);
}
