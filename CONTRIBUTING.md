# Contributing to Archspace

Archspace is a desktop app for node-based AEC workflows. This guide is the set
of rules the repository actually enforces — the ones you will trip on, not
generic open-source advice. Everything below was derived from the repo itself:
the CI workflow, the ESLint config, the tsconfigs, and the ADRs.

Read [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) before your first change of
any size, and [`docs/adr/`](docs/adr/README.md) before you disagree with it.

---

## 1. Prerequisites

| Tool | Version | Where it is pinned |
|---|---|---|
| Node | 22 | [`.nvmrc`](.nvmrc) (`engines.node` is `>=22`) |
| pnpm | 10.33.2 | `packageManager` in [`package.json`](package.json) |

```sh
nvm use                 # reads .nvmrc
corepack enable         # or: npm i -g pnpm@10.33.2
pnpm install
```

`packageManager` is the single source of truth for the pnpm version — CI does
not pin it a second time, deliberately, so there is nothing to disagree with it.

Then:

```sh
pnpm dev     # launches the Electron app
pnpm cli run packages/app/resources/concept-compliance.archspace.yaml --trust-plugin aec-review
```

The second one is the whole product with the shell taken off. Get used to it —
it is also the CI gate (§3).

### If `pnpm dev` says Electron is not installed

You should not see this any more, but the shape of it is worth knowing.

The `electron` package is a few hundred kilobytes of JavaScript; the ~100 MB
runtime is a separate download. **Electron 44 removed the postinstall script
that used to fetch it** and made the download lazy — `require('electron')`
fetches it on first use. electron-vite does not go through that path: it reads
`path.txt` itself and throws `Error: Electron uninstall` when the file is
absent, so the lazy download never fires and a fresh clone dies at `pnpm dev`
with a message naming neither the cause nor the fix.

`pnpm dev` and `pnpm smoke` therefore run
[`scripts/check-electron.mjs`](packages/app/scripts/check-electron.mjs) first,
which requires `electron` and so triggers Electron's own downloader. The first
run prints `Downloading Electron binary...` and takes a minute.

If that download itself fails, run it directly to see why:

```sh
node packages/app/node_modules/electron/install.js
```

Not through pnpm — `pnpm install`, `pnpm install --force` and
`pnpm rebuild electron` will not do it, because electron declares no build
script for them to run. Usual causes are a proxy, a dropped connection, or
antivirus quarantining the archive; set `HTTPS_PROXY` or `ELECTRON_MIRROR` and
retry.

`pnpm build`, `pnpm test` and `pnpm cli` all work without the binary — only
launching the app needs it.

---

## 2. ADR-first

`docs/adr/` is the decision record, and **the ADR wins over intuition**. The
ADRs name the alternatives that were rejected and why they lost, so "obvious"
improvements are usually decisions that were already made in the other
direction — deliberately.

- Start at [`docs/adr/README.md`](docs/adr/README.md): sixteen accepted ADRs
  with a one-line summary each.
- If your change contradicts an accepted ADR, that is not a blocker — it is a
  **new ADR**. Write it in the same MADR-lite shape
  (Context → Decision → Consequences → Alternatives considered), mark the old
  one `Superseded-by-NNNN`, and put it in the same PR as the code.
- If your change is *consistent* with an ADR but not obvious from the code,
  cite the ADR in the file's doc comment (§5). That is how the decisions stay
  findable from the code.

Source files quote sections by number (`ARCHITECTURE §7 / ADR-0007`). Keep
doing that; it is the repo's navigation system.

---

## 3. The six commands CI runs

[`.github/workflows/ci.yml`](.github/workflows/ci.yml) is one job that runs, in
this order, exactly what you can run by hand from the repo root. That is on
purpose: a CI file no human can reproduce locally is a CI file that lies.

```sh
pnpm install --frozen-lockfile

pnpm lint                                          # 1
pnpm typecheck                                     # 2
pnpm --filter @archspace/plugin-aec-review build   # 3
pnpm test                                          # 4
pnpm cli run packages/app/resources/concept-compliance.archspace.yaml \
  --trust-plugin aec-review                        # 5
pnpm build                                         # 6
```

All six green is the definition of done. Three of the steps look misplaced until
you know why they are there.

### Why the app build is a gate and not just a packaging step

Neither `lint` nor `typecheck` compiles the app. That is not theoretical: a JSX
comment misplaced inside a `&&` expression passed both and failed esbuild, and
with no build in CI the first sign of it would have been a release tag. `pnpm
build` is the thing every other gate is a proxy for.

It also runs `packages/app/scripts/check-bundle.mjs`, which fails the build if
any `@archspace/*` specifier survives into `out/main` or `out/preload`.
electron-vite externalises workspace dependencies by default, which once
produced an app that passed every other command here and then would not launch
at all.

`pnpm dev` builds it too, for the same reason: without `dist/index.js` the
plugin host reports it as **failed to load**, the Plugins panel offers no
*Grant consent & enable* button, and the bundled example cannot run — which
looks like a broken consent UI rather than a missing build step.

### Why the plugin build comes before the tests

The first-party plugin is not a fixture. Per
[ADR-0008](docs/adr/0008-plugin-boundary.md), a plugin is an OS child process
loaded from its built **`dist/index.js`** by a real `PluginHost` — and the
first-party plugin ships as a real plugin precisely so the boundary cannot
quietly become decoration. So `plugins/aec-review/dist/` has to exist before
anything that loads it runs:

- `plugins/aec-review`'s own tests load the built entry;
- step 5 runs a workflow whose `aec.review.code_compliance` node lives in that
  plugin.

The same ordering is encoded in the root `build` script and in
`packages/app/electron-builder.yml`. If step 4 or 5 fails with a missing plugin
or an unknown node type, you skipped step 3.

### Why the headless run is a gate, not a demo

[ADR-0013](docs/adr/0013-testing-strategy.md) makes the CLI runner
simultaneously a user feature and **the integration harness**: everything below
the Electron shell is Electron-free, so a shipped workflow can run end to end
with no Electron, no network, and no AI provider (the `mock` provider serves the
`ai.*` nodes). When step 5 breaks, one of the engine, the document format, the
node registry, or the plugin boundary broke — and the event stream it prints
says which.

`--trust-plugin aec-review` is load-bearing, not incidental. ADR-0008 makes an
unconsented plugin unloadable even when it declares no permissions, and a CI
runner has no consent dialog, so the grant is made on the command line where it
is visible in the diff. Without the flag you get, correctly:

```
[error] unknown-type: node "n_r9t3kv" has unknown type "aec.review.code_compliance"
Validation failed — not running.
  plugin "aec-review" is needs-consent: this plugin has not been reviewed yet
```

If that flag ever stops being necessary, consent has stopped being enforced —
that is a bug, not a convenience.

### The vitest trap that will cost you an afternoon

Every package declares `"test": "vitest run"`, and **vitest exits 1 when it
finds no test files**:

```
No test files found, exiting with code 1
```

`pnpm test` is `pnpm -r run test`, which aborts on the first failing package
(`ERR_PNPM_RECURSIVE_RUN_FIRST_FAIL`). So a single package with the script and
no tests reds the entire suite, and every package after it in the topological
order never runs — the output looks like a partial suite, not a missing one.

Consequences worth internalising:

- **A new package needs a test file on the same day it gets a `test` script.**
  Not `--passWithNoTests`: that trades a loud, one-line failure for a package
  that silently never gets tested.
- If `pnpm test` reds in a package you did not touch with that exact message,
  that package has no tests yet. That is the finding, not your change — the
  README's **Known gaps in the repo itself** section tracks which packages are
  currently in that state.
- `pnpm typecheck` (`pnpm -r run typecheck`) aborts the same way, so it
  **under-reports**. When you are unpicking a wide breakage, typecheck packages
  individually to see the whole picture:

  ```sh
  pnpm --filter @archspace/engine typecheck
  ```

  `packages/app` alone has three tsconfigs (`node`, `preload`, `web`) and its
  `typecheck` script runs all three — easy to forget, easy to half-fix.

---

## 3a. Launch the app before you claim it works

Two launch-blocking bugs once shipped past a completely green CI at the same
time: the main bundle left workspace packages external and Electron died with
`ERR_MODULE_NOT_FOUND` before opening a window, and behind that an unstable
zustand selector made React give up with error #185 and mount nothing at all.

Neither is exotic, and nothing caught either. `tsc` reads source and never
looks at the bundle. The unit tests never construct a window. The headless CLI
runs through `tsx`, a loader with none of Electron's constraints. **No CI
command launches Electron**, so a product that could not start scored a perfect
run.

Two things close part of that gap, and both run in seconds:

```bash
pnpm build                           # includes scripts/check-bundle.mjs (now a CI gate, §3)
pnpm --filter @archspace/app smoke   # launches the app, asserts the UI rendered
```

`smoke` refuses to run when `out/` is older than `src/`, because it launches
whatever is in `out/` — so a failed build would otherwise have it report a pass
for the previous one. That happened once; a stale pass is worse than no test,
because it is trusted.

`check-bundle.mjs` fails the build if an `@archspace/*` specifier survives into
`out/main` or `out/preload` — that is the first bug, caught statically.

`smoke-ui.mjs` runs the whole product against a throwaway profile and prints
what it saw:

```
smoke: UI rendered — 4 panels, 18 node types in the palette
       opened "Concept compliance check" with 6 nodes on the canvas
       settings tabs rendered — mcp:1761, ai:3852, plugins:2466, autodesk:21240
       consent granted in-app — palette 18 -> 25 types, 7 from the plugin
       +4.55s run finished: succeeded — 6 complete, 0 failed, 0 skipped
```

Each line is a chain no unit test can reach. The palette count is non-zero only
if main spawned the engine child and the two agreed over a MessagePort. The
consent line means the settings UI wrote a grant, the plugin host read it,
spawned a process, loaded the plugin and pushed its node types back. The last
line means the engine then ran a graph that depends on one of those nodes.

It uses a fresh `--user-data-dir` every time, which is both hygiene and
correctness: the flow grants consent, and consent persists, so without
isolation one run would silently change the state every later run observed.

`smoke` is not in CI, deliberately: it needs a window server, and whether a
GitHub runner reliably provides one has not been verified here. A flaky gate
teaches people to re-run rather than to read. Run it by hand after touching
main, preload, the store, or the build config.

**A note on zustand selectors**, since one cost an entire working UI: a
selector must return something reference-stable. `useStore((s) => s.nodes)` is
fine; `useStore((s) => s.nodes.filter(...))` builds a fresh array every call,
so `useSyncExternalStore` sees a changed snapshot forever. Select, then derive
in the component body.

---

## 4. The hard rules

These are enforced by [`eslint.config.js`](eslint.config.js) and the tsconfigs,
or by review. None of them is stylistic.

### No `any`

`@typescript-eslint/no-explicit-any` is an **error** outside test files.
`unknown` plus a narrowing check is always available, and every public contract
in this repo is written without `any`.

### Nothing that stringifies an object, and no unawaited promise

Four type-aware rules are on — `no-floating-promises`, `no-misused-promises`,
`await-thenable`, `no-base-to-string`. They exist because `tsc` accepts all
four mistakes and each has already shipped here at least once: a floating
promise around the app's whole startup path, and a `String()` that rendered
`[object Object]` into an editable form field, where the next keystroke wrote
that literal string back over the user's data.

The full type-checked presets are deliberately NOT on; they report around two
hundred mostly-stylistic findings, which is the kind of noise people learn to
scroll past.

One of them deserves a specific warning. `no-unnecessary-condition` reports 77
findings here and **nearly all are correct defensive code** — `arr[0]`,
`record[key]` and `e.ports[0]` guarded with an `undefined` check. Those guards
are right and the types are wrong: `noUncheckedIndexedAccess` is off, so an
index claims to return a value it may not have, and the rule believes it. Do
not "fix" those findings by deleting the checks. Enabling
`noUncheckedIndexedAccess` is the real fix and is worth doing. It is 648
compiler errors across twelve packages (measured 2026-08-26), so it is being
done **per package**, not repo-wide: a package's own `tsconfig.json` turns the
flag on once that package is clean.

Done: `types`, `node-sdk`, `ai-gateway`. Remaining, with the error counts from
that measurement — `aec-review` 190, `cli` 68, `engine` 67, `app` 67,
`plugin-host` 62, `mcp-host` 55, `nodes-core` 43, `document` 35, `autodesk` 30.

Two things learned on the first three, both of which cost time:

- **Most of it is not bugs.** Nearly every error is correct code the compiler
  cannot prove — a regex group a match guarantees, `segments[0]` after a
  `split`, an index taken from `findIndex`. The fix that reads best lets the
  impossible case fall into the function's *existing* contract rather than
  assert: `parsePortType` already answers null for anything invalid, so an
  unreachable `return null` is free and says where the guarantee comes from.
- **Do not bulk-rewrite `x[0].y` into `x[0]?.y`.** It is illegal on the
  left-hand side of an assignment, and in an expression like
  `word[0]?.toUpperCase() + word.slice(1)` it silently turns a throw into the
  string `"undefinedxyz"`. A script can find the sites; each fix is a
  judgement.

If you want to see what the presets say, it is one command:

```bash
# Scoped to .ts/.tsx on purpose: a type-aware rule crashes on the .mjs build
# scripts, which have no project to draw type information from.
npx eslint 'packages/**/*.ts' 'packages/**/*.tsx' 'plugins/**/*.ts' \
  --rule '{"@typescript-eslint/no-unnecessary-condition":"error"}'
```

These rules need type information, which is why `packages/app/tsconfig.json`
exists: a references-only file so the project service can find the three real
configs. It is inert for the build, which passes `-p` explicitly.

### No escape hatches to reach green

`@ts-expect-error`, `eslint-disable`, `.skip`, and assertions weakened until
they pass are all defects here, whatever the deadline. **A false green is worse
than a known failure**: the failure is information, the false green is a lie
that someone else will pay for. Leave it red, and say so in the PR.

(Corollary, already enforced: `reportUnusedDisableDirectives` is an *error*, so
a disable comment that no longer suppresses anything fails lint.)

### Relative imports: match the package you are in

Two conventions coexist, and both are correct where they are:

| Where | Style | Why |
|---|---|---|
| Most Node packages — `ai-gateway`, `mcp-host`, `nodes-core`, `plugin-host`, `autodesk`, `cli`, `node-sdk`, `plugins/*` | `import { x } from './foo.js'` | ESM specifiers, written from `.ts` |
| `packages/document`, `packages/engine` | `import { x } from './foo'` | extensionless throughout; internally consistent |
| **All of `packages/app`**, including the renderer | `import { x } from './foo'` | bundled by electron-vite; a `.js` specifier is wrong here |

`.js` is the convention to reach for in a new Node package. In an existing one,
**match its neighbours and never mix styles inside a package.** In the renderer
(`packages/app/src/renderer`) do not add `.js` — the bundler resolves it.

### Only `packages/app` may import Electron

ESLint blocks `electron`, `electron/*` and `electron-*` everywhere under
`packages/*/src` and `plugins/*/src` except `packages/app`. This is
ARCHITECTURE §3.4, and it is the rule the whole testing strategy rests on: the
document, type system, engine, node SDK, gateway, MCP host, plugin host and CLI
run headless in plain Node. An Electron import there breaks the CLI **at
runtime**, not at compile time.

Take the capability as an **injected seam** instead — a parameter or an
interface the app fills in with the Electron implementation and the tests fill
in with a fake. That is what makes ADR-0013 possible.

The renderer has a second, tighter version of the rule: it is fully sandboxed
(`contextIsolation: true`, `sandbox: true`, `nodeIntegration: false`) and
reaches main **only** through the preload bridge — `window.archspace`, typed by
`packages/app/src/shared/protocol.ts`.

### No DOM lib in the Node packages

`tsconfig.base.json` sets `lib: ["ES2023"]`. Only `packages/app`'s `web` and
`preload` tsconfigs add `DOM`. If you need a fetch-adjacent type in a Node
package, derive it rather than reaching for a DOM name — this is real code from
`packages/plugin-host/src/child.ts`:

```ts
input: Parameters<typeof fetch>[0],
requestInit?: Parameters<typeof fetch>[1],
```

`RequestInfo` and `RequestInit` would need the DOM lib. `Parameters<typeof
fetch>[n]` does not.

### Layering

`packages/nodes-core` must never depend on `plugins/aec-review`. The
`aec.review.*` nodes live in the plugin on purpose (ADR-0008 §5) — pulling them
into `nodes-core` inverts the dependency and cycles. A compile error pointing
that way is a layering signal, not an import to add.

---

## 5. The doc-comment standard

This is the convention no linter enforces and the one that makes generated or
copy-pasted code obvious at a glance.

**Every source file opens with a doc comment that gives the design rationale
and cites the section it implements** (`ARCHITECTURE §10 / ADR-0010`). Comments
explain **why**, and typically name the alternative that was rejected and why
it lost. Before adding to a package, read two or three neighbouring files and
match their density and voice.

A real example — the opening of
[`packages/nodes-core/src/ai-generate-text.ts`](packages/nodes-core/src/ai-generate-text.ts),
lightly elided:

```ts
/**
 * ai.generate_text — one provider-agnostic model call (ARCHITECTURE §10 /
 * ADR-0010).
 *
 * This is the node the architecture's own worked example wires up (§4.2): the
 * prompt lives in the form, the material arrives on a `context` port from
 * whatever produced it upstream. Unlike every `aec.*` generate node in this
 * package it is NOT a mock — it reaches the provider that the user's model
 * profile names on THIS machine, through `ctx.ai` and nothing else. […]
 *
 * Caching: 'never' — the contract's default, and here a considered one (§5.2:
 * purity is opt-in). A model call is not a function of its inputs. […]
 * 'pure' was weighed and rejected on the same grounds ADR-0009 §4 refused to
 * trust MCP's advisory `readOnlyHint`: cache entries are valid forever by
 * construction (§7.3), so a wrong 'pure' is not a stale entry, it is a
 * permanently wrong one that re-running cannot clear. […]
 *
 * `chat` in and out: […] The rejected alternative was a separate `ai.chat`
 * node — a second copy of this manifest to gain one port.
 */
```

Note what it does *not* do: restate what the code says. It records the choice, the
constraint behind it, and the option that lost. A file without a header like
this reads as foreign here and will be asked for in review.

### The honesty rule

It outranks looking finished: **never present a mock, a placeholder, or an
unimplemented capability as a working integration anywhere a user can see it.**
Where something is not implemented, the UI must say so plainly — in the UI, not
only in a code comment. Several `aec.*` nodes are mock backends and their
manifests and doc comments say so in as many words; `packages/autodesk` throws
synchronously and names the repo path of the empty seam rather than returning a
plausible-looking fake. Do the same.

---

## 6. Adding a node

The practical, worked walkthrough is
[`docs/creating-nodes.md`](docs/creating-nodes.md) — it builds a node that
actually ships (`aec.parking_estimate`) from nothing, and ends in a checklist.
The contract it implements is ARCHITECTURE §5 / ADR-0005: a **declarative
manifest** (pure serializable data — ports, params, caching, lane) plus one
`execute(ctx, inputs, params)` async function that gets nothing but what `ctx`
gives it.

Two rules of thumb from that guide that save rewrites:

- **Wires carry meaning, forms carry configuration.** From another node ⇒ input
  port. Typed by a human ⇒ param.
- **Wire values stay small.** Anything bulky travels as an `AssetRef` into the
  content-addressed store, never as bytes on a wire.

### Core node, plugin, or MCP server?

Decide this *before* you write anything. ADR-0008 (§4 in particular, with §2
and §5) settles it:

| Ship it as | When |
|---|---|
| **A core node** in `packages/nodes-core` | It is generic app functionality in TypeScript with no heavy or native dependencies, and it belongs to everyone: `core.*` and `ai.*`. |
| **A plugin** in its own package | TypeScript, but a distinct domain, its own namespace, its own release cadence, or it needs native/heavy dependencies. A plugin is an OS child process with a capability-scoped API and install-time consent; it owns node type ids under its declared namespace. `plugins/aec-review` is the worked first-party example. |
| **An MCP server** | It is not JavaScript. **MCP is the polyglot tier** (ADR-0008 §4): Python/C#/anything authors ship an MCP server, not a plugin — that is how IfcOpenShell and ezdxf join with zero linking or FFI, and it is the same story Revit already requires (ADR-0001). Tools become nodes mechanically from `tools/list` (ADR-0009 §3). |

Also from ADR-0008: a ten-line utility node should not be an MCP server
(ceremony, no shared `ctx.ai`/asset semantics), and nothing should be an
in-process `require()` — that was rejected outright.

---

## 7. Pull requests

- **Branch off `main`.** CI runs on every PR and on pushes to `main`.
- **Run all six commands (§3) before pushing.** They take well under a minute
  in total on a warm install; CI runs on macOS because that is the shipped
  platform (ADR-0001).
- **One concern per PR.** A serializer change that dirties many golden files is
  a reviewable event by design (ADR-0013) — do not bury it under a feature.
- **Say what is not done.** An honest "this seam is unimplemented and the UI
  says so" is mergeable. A green build that hides it is not.
- **Include the ADR** when you contradict one (§2).
- Formatting is `.editorconfig`: UTF-8, LF, 2-space indent, final newline,
  trailing whitespace trimmed (except in Markdown, where it is meaningful).
  There is no repo-wide formatter to fight with.
- Licence: contributions are under **Apache-2.0** (see [`LICENSE`](LICENSE)).
  If you add a runtime dependency that ships in the app, add it to
  [`NOTICE`](NOTICE) with the version and licence read out of the installed
  package — not from memory.

## 8. Issues and questions

- **Bugs:** use the issue templates. The two fields that make a report
  actionable here are **the workflow document** (plain YAML — paste it; by
  design it contains no paths, URLs, or credentials) and **the run event
  stream** from `pnpm cli run <workflow>`, which reproduces most bugs with no
  Electron in the way.
- **Questions and half-formed ideas:** Discussions, not the issue tracker.
- **Security vulnerabilities:** do not open an issue. See
  [`SECURITY.md`](SECURITY.md).
