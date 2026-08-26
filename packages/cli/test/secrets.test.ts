/**
 * Secrets in a headless run: the name mangling, and the two readers.
 *
 * This is the one place the CLI cannot follow the desktop app. There is no
 * `safeStorage` in a plain Node process, so a secret KEY — the only form a
 * workflow, an `mcp.yaml` or an `ai.yaml` ever contains (ARCHITECTURE §6.1,
 * §11) — is resolved from `ARCHSPACE_SECRET_<KEY>` instead of the keychain.
 *
 * `envVarForSecret` is therefore a *user-facing* function even though it looks
 * like an implementation detail. `archspace ai` prints its output as the
 * instruction an operator is supposed to follow ("key ref … → env …"), and a CI
 * job's secret bindings are written from it by hand, in a YAML file, months
 * before anyone runs the workflow. If the mapping ever shifts, nothing errors:
 * the variable the operator exported stops being the variable the CLI reads,
 * and the run fails as "secret not set" while the secret is very much set.
 * That makes the awkward inputs — dots, dashes, runs, case — worth spelling out
 * one by one rather than asserting a regex against itself.
 *
 * The two readers exist because their callers differ in what a missing secret
 * means. Nothing here reads a real credential: every case exports its own
 * variable into this process and puts it back afterwards.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { defaultAiConfig } from '@archspace/ai-gateway';
import { cliSecrets, cliStrictSecrets, envVarForSecret } from '../src/config.js';
import { withEnv } from './helpers.js';

let restoreEnv: (() => void) | undefined;

afterEach(() => {
  restoreEnv?.();
  restoreEnv = undefined;
});

function exportSecret(key: string, value: string | undefined): void {
  restoreEnv = withEnv({ [envVarForSecret(key)]: value });
}

describe('envVarForSecret — the documented mapping', () => {
  it('maps the example in the doc comment', () => {
    expect(envVarForSecret('acme_api_key')).toBe('ARCHSPACE_SECRET_ACME_API_KEY');
  });

  it('maps the key the shipped AI defaults actually name', () => {
    // Not a hypothetical: `defaultAiConfig()`'s first profile names this key,
    // so this string is what a brand-new user is told to export the first time
    // they run `archspace ai`. Read from the real default rather than pasted,
    // so a change to the default profile shows up here as a diff.
    const apiKeyRef = defaultAiConfig().profiles[0].apiKeyRef;

    expect(apiKeyRef).toBe('ai.anthropic.api_key');
    expect(envVarForSecret(apiKeyRef!)).toBe('ARCHSPACE_SECRET_AI_ANTHROPIC_API_KEY');
  });

  it('folds every non-alphanumeric run to a single underscore and upper-cases', () => {
    const cases: [string, string][] = [
      // The three separators a key is likely to use in the wild.
      ['ai.anthropic.api_key', 'ARCHSPACE_SECRET_AI_ANTHROPIC_API_KEY'],
      ['acme-api-key', 'ARCHSPACE_SECRET_ACME_API_KEY'],
      ['acme api key', 'ARCHSPACE_SECRET_ACME_API_KEY'],
      // Already shouting: idempotent, so re-running the mapping is harmless.
      ['ACME_API_KEY', 'ARCHSPACE_SECRET_ACME_API_KEY'],
      // A *run* collapses to one underscore, not one per character — the `+`
      // in the pattern. `acme..key` and `acme_key` are the same variable.
      ['acme..key', 'ARCHSPACE_SECRET_ACME_KEY'],
      ['acme---key', 'ARCHSPACE_SECRET_ACME_KEY'],
      // Leading and trailing separators are kept as underscores rather than
      // trimmed, so `.acme` and `acme` are different variables.
      ['.acme', 'ARCHSPACE_SECRET__ACME'],
      ['acme.', 'ARCHSPACE_SECRET_ACME_'],
      // Digits survive; only non-alphanumerics fold.
      ['s3_bucket_2', 'ARCHSPACE_SECRET_S3_BUCKET_2'],
      // camelCase is upper-cased, not split. A user expecting
      // ACME_API_KEY here gets ACMEAPIKEY, which is why `archspace ai`
      // prints the answer instead of asking people to derive it.
      ['acmeApiKey', 'ARCHSPACE_SECRET_ACMEAPIKEY'],
    ];

    expect(cases.map(([key]) => envVarForSecret(key))).toEqual(cases.map(([, variable]) => variable));
  });

  it('always produces a name a shell can actually export', () => {
    // The prefix is what buys this: a key like "2fa" would otherwise start a
    // variable name with a digit, which `export` rejects. Worth pinning because
    // the printed line is meant to be copy-pasteable, and a name that cannot be
    // exported turns a helpful hint into a dead end.
    const shellVariable = /^[A-Za-z_][A-Za-z0-9_]*$/;
    for (const key of ['2fa', 'acme_api_key', 'ai.anthropic.api_key', 'acme-key', 'a', '', 'ünïcødé']) {
      expect(envVarForSecret(key)).toMatch(shellVariable);
      expect(envVarForSecret(key).startsWith('ARCHSPACE_SECRET_')).toBe(true);
    }
  });

  it('is not injective — distinct keys can land on one variable', () => {
    // Pinned as a hazard, not as a feature. The plugin manifest's own key rule
    // (`[A-Za-z0-9_.-]+`, @archspace/plugin-host) admits all three of these, so
    // two plugins declaring `acme.key` and `acme-key` share one credential in a
    // headless run and neither of them can tell. If this ever needs fixing, it
    // is this assertion that should change — deliberately, and with the printed
    // hint in `archspace ai` changing alongside it.
    const collisions = ['acme.key', 'acme-key', 'acme_key', 'ACME.KEY'];

    expect(new Set(collisions.map(envVarForSecret)).size).toBe(1);
  });
});

describe('cliSecrets — the reader that reports absence', () => {
  it('returns undefined for a secret nobody exported', async () => {
    exportSecret('acme_api_key', undefined);

    await expect(cliSecrets.get('acme_api_key')).resolves.toBeUndefined();
  });

  it('reads the environment at call time, not at import time', async () => {
    // The CLI's own commands resolve secrets lazily and long after this module
    // was loaded; a value captured at import would make `archspace mcp
    // --connect` behave differently from a plugin asking for the same key.
    await expect(cliSecrets.get('acme_api_key')).resolves.toBeUndefined();

    exportSecret('acme_api_key', 'sk-live-000');

    await expect(cliSecrets.get('acme_api_key')).resolves.toBe('sk-live-000');
  });

  it('returns the value verbatim', async () => {
    // No trimming: `ARCHSPACE_SECRET_X="$(cat token.txt)"` keeps whatever the
    // file held. Pinned so that if trimming is ever added it is a decision
    // rather than a drive-by, since trimming a credential that legitimately
    // ends in whitespace is its own silent failure.
    exportSecret('acme_api_key', ' sk-live-000\n');

    await expect(cliSecrets.get('acme_api_key')).resolves.toBe(' sk-live-000\n');
  });
});

describe('cliStrictSecrets — the reader that refuses absence', () => {
  it('throws for a missing secret, naming both the key and the variable to export', async () => {
    // The whole difference between the two readers. This message is the only
    // instruction the operator gets, and it has to carry both halves: the key
    // ties the failure back to the workflow or manifest that asked for it, the
    // variable is the fix. The key alone would leave them to re-derive the
    // mangling by hand — the exact mistake this file exists to prevent.
    exportSecret('acme_api_key', undefined);

    await expect(cliStrictSecrets.get('acme_api_key')).rejects.toThrow(/acme_api_key/);
    await expect(cliStrictSecrets.get('acme_api_key')).rejects.toThrow(/ARCHSPACE_SECRET_ACME_API_KEY/);
  });

  it('agrees with cliSecrets whenever the secret is present', async () => {
    // The readers differ on absence and only on absence; a present secret must
    // not come back transformed by one and not the other.
    exportSecret('acme_api_key', 'sk-live-000');

    await expect(cliStrictSecrets.get('acme_api_key')).resolves.toBe('sk-live-000');
    await expect(cliSecrets.get('acme_api_key')).resolves.toBe('sk-live-000');
  });

  it('treats an exported-but-empty variable as present, not missing', async () => {
    // `ARCHSPACE_SECRET_ACME_API_KEY=` — a CI secret that was declared and
    // never filled in, which is the most common way this variable goes wrong.
    // The strict reader only refuses `undefined`, so the empty string passes
    // straight through to whoever asked.
    //
    // Contained rather than harmless: `@archspace/ai-gateway` re-checks for ''
    // when it binds a profile ("holds no value on this machine") and
    // `@archspace/mcp-host` re-checks it before building an Authorization
    // header, so neither host sends an unauthenticated request. The plugin
    // capability path — the only caller of `cliStrictSecrets` — does not, and
    // hands the empty string to the plugin. Pinned here so that closing the gap
    // is a deliberate edit to this assertion and to those two guards together.
    exportSecret('acme_api_key', '');

    await expect(cliStrictSecrets.get('acme_api_key')).resolves.toBe('');
    await expect(cliSecrets.get('acme_api_key')).resolves.toBe('');
  });
});
