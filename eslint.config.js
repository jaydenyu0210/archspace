/**
 * Repo-wide ESLint flat config (ESLint 9 + typescript-eslint 8).
 *
 * Shape rationale:
 *
 * 1. **Type-aware, but only just.** The full type-checked presets are still off:
 *    they report ~200 findings here, nearly all of them stylistic
 *    (`no-unnecessary-type-assertion`, `require-await`), which is exactly the
 *    noise a contributor learns to ignore. What IS on is a four-rule layer that
 *    catches what `tsc` provably cannot, and it earned its place — enabling it
 *    found a floating promise wrapping the app's entire startup, and a
 *    `String()` on a param value that rendered "[object Object]" into an
 *    editable input, where the next keystroke wrote it back over the user's
 *    structured data.
 *
 *    It needs type information, which needs a project per file — hence
 *    `packages/app/tsconfig.json`, a references-only file that exists purely so
 *    the project service can find the three real configs. It costs about four
 *    seconds; the earlier note that this would take a minute predates
 *    `projectService`.
 *
 * 2. **CommonJS on purpose.** The repo is ESM everywhere, but the root
 *    package.json has no `"type": "module"`, so ESLint loads this file as CJS.
 *    Renaming it to `.mjs` would work too; keeping the conventional name and
 *    using `require` here is the smaller surprise. Nothing else in the repo
 *    loads this file.
 *
 * 3. **A rule earns its place by catching a real class of bug in this codebase
 *    or by enforcing a rule the architecture states.** Everything else is off
 *    with a reason, not left on to generate noise a contributor learns to
 *    ignore.
 */
const js = require('@eslint/js');
const globals = require('globals');
const tseslint = require('typescript-eslint');

module.exports = tseslint.config(
  {
    // Build output, vendored code and machine state. `.archspace/` is the
    // per-project run/cache directory (ARCHITECTURE §11) and is generated.
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/out/**',
      '**/coverage/**',
      '**/.archspace/**',
      '**/*.d.ts',
    ],
  },

  js.configs.recommended,
  ...tseslint.configs.recommended,

  {
    // The type-aware layer. Four rules, each catching a class the compiler
    // accepts and a human then has to find by reading:
    //
    //  - `no-floating-promises` / `no-misused-promises`: an un-awaited promise
    //    is a silent failure, and both were at zero when this was turned on, so
    //    the rule is a ratchet rather than a backlog.
    //  - `await-thenable`: an `await` on a non-promise reads as sequencing that
    //    is not happening.
    //  - `no-base-to-string`: "[object Object]" reaching a user. It found three
    //    real instances, one of which was destroying data on edit.
    files: ['**/*.ts', '**/*.tsx'],
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: __dirname },
    },
    rules: {
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
      '@typescript-eslint/await-thenable': 'error',
      '@typescript-eslint/no-base-to-string': 'error',
    },
  },

  {
    // Everything below the Electron shell runs in plain Node (ARCHITECTURE
    // §3.4); the renderer overrides this below.
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: { ...globals.node, ...globals.es2023 },
    },
    linterOptions: {
      // A disable comment that no longer suppresses anything is dead weight
      // and hides the fact that a rule stopped applying.
      reportUnusedDisableDirectives: 'error',
    },
    rules: {
      // The house rule from CONTRIBUTING: no `any`. `unknown` plus a narrowing
      // check is always available, and every public contract in this repo is
      // written without `any`.
      '@typescript-eslint/no-explicit-any': 'error',

      // A *warning*, deliberately. `tsconfig.base.json` does not set
      // `noUnusedLocals`, so this is the only thing that sees a stale import —
      // but a half-finished refactor with one dangling import is not a reason
      // to red a CI run, and a rule that reds CI for tidiness is a rule people
      // route around. Warnings here are expected to be cleaned before merge.
      // `_`-prefixed bindings are the documented way to say "required by the
      // signature, deliberately unused" — common in NodeModule.execute stubs.
      'no-unused-vars': 'off',
      '@typescript-eslint/no-unused-vars': [
        'warn',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
          destructuredArrayIgnorePattern: '^_',
        },
      ],

      // The document format and the engine both branch on `undefined` vs
      // `null` as distinct states, so `==` against them is intentional and
      // idiomatic here; every other loose comparison is a bug waiting.
      eqeqeq: ['error', 'always', { null: 'ignore' }],

      // Workflows are data: "no eval, no expressions in v1" (ARCHITECTURE
      // §12). This is the lint that keeps that promise honest.
      'no-eval': 'error',
      'no-implied-eval': 'error',
      'no-new-func': 'error',

      // Floating promises are the classic engine/IPC bug, but catching them
      // properly needs type information (see note 1). `no-async-promise-executor`
      // and `require-atomic-updates` are the un-typed subset worth having.
      'require-atomic-updates': 'off', // too many false positives on `await` in loops
      'no-async-promise-executor': 'error',

      // Off. In the engine the `!` is load-bearing and correct: the scheduler
      // indexes maps it has just proven non-empty, and `noUncheckedIndexedAccess`
      // is not on, so the alternative is a defensive branch that can never run
      // and cannot be tested. Leaving this on produced ~30 warnings in
      // packages/engine alone — a wall nobody would read. If the repo ever
      // turns on `noUncheckedIndexedAccess`, revisit.
      '@typescript-eslint/no-non-null-assertion': 'off',

      // Off. `Boolean(x) ? … : …` in the renderer's schema-driven form fields
      // is explicit coercion of a `Value` of unknown shape, not a redundant
      // cast the author forgot to delete.
      'no-extra-boolean-cast': 'off',

      // `interface X extends Y {}` is a deliberate naming seam in the node SDK
      // (a named contract that is currently an alias), and empty object types
      // appear in generated JSON-Schema shapes.
      '@typescript-eslint/no-empty-object-type': 'off',

      // Off because the codebase legitimately uses `require`-less dynamic
      // `import()` and declaration merging; the rule fires on neither, but the
      // ones below it in the preset fire on patterns we want.
      '@typescript-eslint/no-namespace': 'off',
    },
  },

  {
    // Renderer: sandboxed browser context, no Node globals (ARCHITECTURE §3.2).
    files: ['packages/app/src/renderer/**/*.{ts,tsx}'],
    languageOptions: {
      globals: { ...globals.browser, ...globals.es2023 },
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
    rules: {
      // The dependency rule, enforced where it is easiest to break by accident.
      // (Nothing *below* packages/app may import Electron either — that is
      // covered by the rule block after this one.)
      'no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: 'electron',
              message:
                'The renderer is sandboxed: no Node, no Electron. Go through the preload bridge (packages/app/src/preload) and the typed protocol in src/shared/protocol.ts.',
            },
          ],
        },
      ],
    },
  },

  {
    // ARCHITECTURE §3.4: `document`, `types`, `node-sdk`, `engine`, `nodes-core`,
    // `cli`, the gateway, the MCP host, the plugin host and every plugin run
    // headless in plain Node. An Electron import anywhere here silently breaks
    // the CLI and the whole headless test strategy (§14), and it breaks it at
    // runtime rather than at compile time — which is exactly what lint is for.
    files: ['packages/*/src/**/*.ts', 'packages/*/test/**/*.ts', 'plugins/*/src/**/*.ts', 'plugins/*/test/**/*.ts'],
    ignores: ['packages/app/**'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['electron', 'electron/*', 'electron-*'],
              message:
                'Nothing below packages/app may import Electron (ARCHITECTURE §3.4). Take the capability as an injected seam instead — that is what keeps the CLI and the headless test suites working.',
            },
          ],
        },
      ],
    },
  },

  {
    // Test files: expressive assertions beat ceremony, and fixtures are allowed
    // to be sloppy about shapes they are deliberately feeding as garbage.
    files: ['**/test/**/*.{ts,tsx}', '**/*.test.{ts,tsx}', '**/fixtures/**/*.{ts,mjs,js}'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-non-null-assertion': 'off',
      '@typescript-eslint/no-unused-expressions': 'off',
    },
  },

  {
    // Build scripts and config files are Node scripts, sometimes CJS.
    files: ['**/*.{js,cjs,mjs}'],
    languageOptions: {
      globals: { ...globals.node },
    },
    rules: {
      '@typescript-eslint/no-require-imports': 'off',
      '@typescript-eslint/no-var-requires': 'off',
    },
  },
);
