/**
 * Reading `plugins.json` — what the user has actually consented to (ADR-0008 §2).
 *
 * Split from `settings.ts` for the reason `asset-naming.ts` is split from
 * `assets.ts`: this is a pure decision, `settings.ts` cannot be imported
 * without an Electron runtime, and a wrong answer here is a plugin running
 * because a file was damaged rather than because a person said yes.
 *
 * **It must agree with `packages/cli/src/config.ts`.** The two read the same
 * file on the same machine, and ADR-0013 §1's whole promise — the workflow that
 * runs in the app runs in CI — is false the moment they disagree about which
 * plugins are consented. The CLI has always required an explicit boolean and
 * reported a record it could not read; this side accepted anything that failed
 * to say `false`, and said nothing. That is the same file being read two ways,
 * and the lenient one was the one guarding the security boundary.
 *
 * `issues` is returned rather than swallowed for the same reason the CLI prints
 * them: a consent file that silently resets leaves the user re-consenting to
 * plugins they had already approved, with no way to tell whether that was a bug
 * or an attack.
 */

/** One plugin's consent, as `savePluginConsent` writes it. */
export interface ConsentRecord {
  enabled: boolean;
  permissions: string[];
}

export type PluginConsent = Record<string, ConsentRecord>;

export interface ParsedConsent {
  consent: PluginConsent;
  issues: string[];
}

/**
 * The shape check, identical to the CLI's `isConsentRecord`.
 *
 * `enabled` must be a boolean, not merely "not false". Every record this app
 * writes carries one, so the strict test changes nothing for a well-formed
 * file — and for a malformed one it resolves the doubt towards asking the user
 * again, which is the only direction a doubt about consent may resolve in.
 */
function isConsentRecord(value: unknown): value is ConsentRecord {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const record = value as { enabled?: unknown; permissions?: unknown };
  return (
    typeof record.enabled === 'boolean' &&
    Array.isArray(record.permissions) &&
    record.permissions.every((p) => typeof p === 'string')
  );
}

/**
 * Parse the contents of `plugins.json`.
 *
 * `null` text means the file does not exist, which is the ordinary first-run
 * state and not a problem: nothing is consented, and nothing is reported.
 */
export function parsePluginConsent(text: string | null): ParsedConsent {
  if (text === null) return { consent: {}, issues: [] };

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return {
      consent: {},
      issues: ['plugins.json is not valid JSON; treating every plugin as unconsented'],
    };
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return {
      consent: {},
      issues: [
        'plugins.json does not contain a consent object (expected {"<plugin-id>": {"enabled": …}}); treating every plugin as unconsented',
      ],
    };
  }

  const consent: PluginConsent = {};
  const issues: string[] = [];
  for (const [id, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (isConsentRecord(value)) {
      consent[id] = { enabled: value.enabled, permissions: [...value.permissions] };
      continue;
    }
    issues.push(
      `plugins.json: the consent record for "${id}" is malformed (expected {"enabled": boolean, "permissions": string[]}); treating that plugin as unconsented`,
    );
  }
  return { consent, issues };
}
