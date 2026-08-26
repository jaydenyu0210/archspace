# Releasing Archspace (macOS)

This is the operational companion to [`packages/app/electron-builder.yml`](../packages/app/electron-builder.yml)
and [`.github/workflows/release.yml`](../.github/workflows/release.yml). Those two
files encode the decisions; this page says how to actually produce a release and
what every secret they read is for. Change one of the three and check the other
two — they are written to be kept in sync.

The reasoning lives in [ADR-0012](adr/0012-macos-packaging.md) and
[ARCHITECTURE.md §13](ARCHITECTURE.md). Read those if you want to know *why*
there is no Mac App Store build and why the App Sandbox is off.

**One rule underpins everything below: CI is the only sanctioned release path.**
Notarization needs an Apple API key, the key lives in GitHub Actions secrets and
not on a laptop, and a laptop build is therefore never a release. That is a
feature, not an inconvenience — it means every shipped artifact went through the
same lint/typecheck/test gate as every pull request.

> **Status of this document.** Archspace has never been released. No Developer ID
> identity exists in the environment this repo was built in, no tag has been
> pushed, and no artifact has been through `notarytool`. Everything here is
> written from the configuration in the repository, not from a release that
> happened. Section [Known gaps](#known-gaps-before-the-first-release) lists the
> things that are still wrong and will bite the first person who tries.

---

## 1. The pipeline in one paragraph

Push a `v*` tag → `.github/workflows/release.yml` runs on `macos-latest` →
lint, typecheck, build the first-party plugin, test, headless CLI run → check
whether the signing secrets are present → if they are, `electron-builder`
packages a universal DMG + ZIP, signs them with your Developer ID Application
certificate, submits them to Apple for notarization, and creates a **draft**
GitHub Release; if they are not, it packages the same artifacts **unsigned**,
labels them `UNSIGNED`, publishes nothing, and says so in the job summary. A
human then runs the [release gate](#6-the-release-gate) and publishes the draft.

`workflow_dispatch` does the same thing without a tag, for dry runs. It never
publishes.

---

## 2. Secrets

Six repository secrets appear in `release.yml`. Set them under
**Settings → Secrets and variables → Actions → Repository secrets**.

| Secret | What it is | What breaks without it |
|---|---|---|
| `CSC_LINK` | Base64 of your Developer ID Application `.p12` (certificate + private key) | Build runs unsigned and is never published |
| `CSC_KEY_PASSWORD` | The password you set when exporting that `.p12` | **The signing step fails mid-build** — see the warning below |
| `APPLE_API_KEY` | Base64 of an App Store Connect API key `.p8` file | Build runs unsigned and is never published |
| `APPLE_API_KEY_ID` | The 10-character Key ID of that key | Build runs unsigned and is never published |
| `APPLE_API_ISSUER` | The Issuer ID (a UUID) of your App Store Connect team | Build runs unsigned and is never published |
| `GH_TOKEN` | A GitHub token with `repo` scope, used by electron-builder to create the draft Release | **Publishing fails after a successful notarization** — see the warning below |

> ### ⚠️ Two of these are not covered by the pre-flight check
>
> The `Determine signing capability` step tests exactly four secrets —
> `CSC_LINK`, `APPLE_API_KEY`, `APPLE_API_KEY_ID`, `APPLE_API_ISSUER` — and
> decides from those alone whether to take the signed path.
>
> `CSC_KEY_PASSWORD` and `GH_TOKEN` are **read but never checked**. If you set
> the four and forget these two, the workflow does not fall back to the honest
> unsigned path. It commits to the signed path and then fails:
>
> - **Missing `CSC_KEY_PASSWORD`:** electron-builder cannot open the `.p12`, and
>   the build dies in the packaging step. Fast, loud, ~10 minutes in.
> - **Missing `GH_TOKEN`:** everything works — including a full, slow
>   notarization round trip — and then `--publish always` has no credential to
>   create the Release with. You lose the whole run at the last step.
>
> Set all six or none. "None" is a valid, supported state; "four" is not.

### 2.1 `CSC_LINK` and `CSC_KEY_PASSWORD` — the Developer ID certificate

A **Developer ID Application** certificate is the identity Apple issues to a
member of the Apple Developer Program (paid, $99/yr) for signing software
distributed **outside** the Mac App Store. It is not the same as an "Apple
Development" certificate (local debugging only) or a "Mac App Distribution"
certificate (App Store only) — and only Developer ID satisfies Gatekeeper for a
DMG a user downloads from GitHub. The certificate's private key is what makes a
signature yours; Apple only ever holds the public half.

Creating one, on a Mac:

1. **Keychain Access → Certificate Assistant → Request a Certificate From a
   Certificate Authority.** Enter your email, leave CA Email blank, choose
   *Saved to disk*. This produces a `CertificateSigningRequest.certSigningRequest`
   and — importantly — puts the matching **private key** in your login keychain.
2. **developer.apple.com → Certificates, IDs & Profiles → Certificates → +**.
   Choose **Developer ID Application**, upload the CSR, download the resulting
   `developerID_application.cer`.
3. Double-click the `.cer` to install it. In Keychain Access it should now show
   a disclosure triangle with a private key underneath. If it does not, you
   generated the CSR on a different machine and this certificate is unusable
   here — start again on the machine that holds the key.
4. **Export to `.p12`:** select the certificate *and* its private key, right-click
   → *Export 2 items…*, format **Personal Information Exchange (.p12)**. You will
   be asked for a password. **That password is `CSC_KEY_PASSWORD`.** Use a
   generated one; it is never typed by a human again.
5. **Base64 it.** On macOS, `base64 -i` emits a single unwrapped line, which is
   what you want:

   ```sh
   base64 -i DeveloperID.p12 | pbcopy   # now paste into the CSC_LINK secret
   ```

   (GNU `base64` wraps at 76 columns. Wrapped input still decodes, but if you
   are producing this on Linux, prefer `base64 -w0`.)

6. Delete the `.p12` from disk when you are done. The secret store is the copy
   that matters.

Certificates expire after five years, and Apple revokes them if the Developer
Program membership lapses. A revoked or expired certificate does not fail the
pre-flight check — `CSC_LINK` is still non-empty — it fails inside signing.

### 2.2 `APPLE_API_KEY`, `APPLE_API_KEY_ID`, `APPLE_API_ISSUER` — notarization

**Notarization** is separate from signing. Signing proves *who* built the app;
notarization is Apple scanning the signed artifact for malware and issuing a
ticket that says it passed. Since macOS 10.15 an un-notarized download is
refused by Gatekeeper even when it is correctly signed. `notarytool` (used by
electron-builder under `notarize: true`) authenticates with an **App Store
Connect API key** — a JWT-signing key, not a password, and the reason an
app-specific password is no longer the recommended path.

1. **appstoreconnect.apple.com → Users and Access → Integrations → App Store
   Connect API → Team Keys → +.** Name it something like `archspace-notarize`.
   Role: **Developer** is sufficient for notarization.
2. Download the `AuthKey_XXXXXXXXXX.p8`. **Apple lets you download it exactly
   once.** Lose it and you revoke the key and make a new one.
3. The 10-character `XXXXXXXXXX` in the filename is the **Key ID** →
   `APPLE_API_KEY_ID`.
4. The **Issuer ID** is the UUID shown at the top of the Team Keys page →
   `APPLE_API_ISSUER`. It is per-team, not per-key.
5. Base64 the `.p8` → `APPLE_API_KEY`:

   ```sh
   base64 -i AuthKey_XXXXXXXXXX.p8 | pbcopy
   ```

The workflow's `Materialise the App Store Connect API key` step decodes that
secret back into a file under `$RUNNER_TEMP`, because electron-builder passes
`APPLE_API_KEY` to `notarytool` as a **path**, not as key material. Two details
in that step are deliberate and worth not undoing:

- It writes to `$RUNNER_TEMP`, **outside the workspace**, so that no glob in
  `electron-builder.yml`'s `files:` list can ever sweep a private key into the
  app bundle.
- It greps the first decoded line for `BEGIN PRIVATE KEY`. A mangled secret —
  the usual cause being pasting the `.p8` text instead of its base64 — fails
  there in seconds with an actionable error, rather than forty minutes later
  inside `notarytool` with an opaque one.

A `Remove the API key` step runs with `if: always()`.

### 2.3 `GH_TOKEN` — creating the draft Release

electron-builder creates the GitHub Release itself (`--publish always` plus the
`publish:` block in `electron-builder.yml`). It reads `GH_TOKEN` from the
environment; it does not use the automatic `GITHUB_TOKEN` unless you wire it in.
Generate a fine-grained or classic personal access token with write access to
the target repository's contents.

The workflow's `permissions: contents: write` block grants the *default* token
the same right, so a maintainer can fall back to `GITHUB_TOKEN` by changing that
one line — but as written, `GH_TOKEN` is what runs.

---

## 3. Hardened runtime and entitlements

`hardenedRuntime: true` and `entitlements: build/entitlements.mac.plist` (plus
`entitlementsInherit:` pointing at the same file) are set in
`electron-builder.yml`. The hardened runtime is mandatory for notarization: it
locks down code injection, DYLD environment manipulation and unsigned executable
memory, and an entitlement is the explicit, auditable hole you punch in it.

**Verified on disk:** `packages/app/build/entitlements.mac.plist` **exists** and
is a well-formed plist (`plutil -lint` passes). `electron-builder.yml` references
that one path twice and no other plist, so there is no missing entitlement file.
There is deliberately **no** `entitlements.mas.plist` and no `mas` target —
`com.apple.security.inherit`, the usual reason for a separate inherit file, is an
App Sandbox key and the sandbox is off.

Three entitlements are requested. Each one names the concrete thing that breaks
without it; nothing is present because a template had it.

| Entitlement | Why |
|---|---|
| `com.apple.security.cs.allow-jit` | V8 compiles JavaScript to machine code at runtime. Without it the renderer and every Node-side process crash on launch under the hardened runtime. The one non-negotiable Electron entitlement. |
| `com.apple.security.cs.disable-library-validation` | Plugins are user-installed code and may ship native `.node` addons. Library validation refuses any dylib not signed by our Team ID, so a plugin with a native dependency could never load. This is the largest hole in the file, and it is why [ADR-0008](adr/0008-plugin-boundary.md) describes the plugin boundary as fault isolation and permission mediation rather than a security sandbox. |
| `com.apple.security.cs.allow-dyld-environment-variables` | Plugin children are `ELECTRON_RUN_AS_NODE` forks of our own signed binary, and stdio MCP servers are spawned with a caller-supplied `env` block. The hardened runtime restricts environment inheritance across a signed binary's exec; this is the documented escape hatch. |

**The third one is an unverified precaution, and the plist says so.** No signed
build has ever run, so nobody has established that plugin spawning and stdio MCP
servers actually need it. Removing an entitlement after a green signed build is
cheap; debugging a silently-dead plugin process on a notarized build is not, so
it ships enabled. **On the first real signed run, try deleting it**: if the
plugin-host crash-containment test and an stdio MCP server both still work in the
packaged app, delete the key and its comment. Add-backs need a note saying what
failed.

Deliberately absent, and not to be added casually:
`com.apple.security.app-sandbox` (would delete the extension model — ADR-0012),
`com.apple.security.cs.allow-unsigned-executable-memory` (modern Electron needs
`allow-jit` only), `com.apple.security.cs.debugger` and
`com.apple.security.automation.apple-events` (the app scripts nothing and debugs
nothing).

Separately, `mac.extendInfo` declares `NSDocumentsFolderUsageDescription`,
`NSDesktopFolderUsageDescription` and `NSDownloadsFolderUsageDescription`. These
are TCC consent strings, not entitlements — macOS shows them the first time the
user opens a project folder in one of those locations. Every extra key here is
another prompt asking the user to trust us, so add one only when a feature
actually needs it.

---

## 4. Building locally, and how it degrades

`notarize: true` is safe to leave on locally. With no `APPLE_API_*` variables
present, electron-builder logs `skipped macOS notarization` and continues, so a
fork or laptop build degrades to unsigned instead of failing.

For signing, electron-builder auto-discovers a Developer ID identity in your
login keychain. To force an unsigned build (the normal case for a contributor):

```sh
pnpm build                                     # plugin, then main/preload/renderer
cd packages/app
CSC_IDENTITY_AUTO_DISCOVERY=false pnpm exec electron-builder --mac --universal --publish never
```

Artifacts land in `packages/app/dist/` — `dist/`, not `release/`, because
`.gitignore` already ignores `dist/` and packaging output must never be a
candidate for `git add`.

> **Note:** the root `package.json` advertises a `pnpm dist` script that runs
> `pnpm --filter @archspace/app dist`, but `@archspace/app` defines no `dist`
> script. `pnpm dist` currently fails with
> `ERR_PNPM_RECURSIVE_RUN_NO_SCRIPT`. Use the two commands above until that is
> fixed.

### What a user sees for an unsigned build

This is the reason unsigned artifacts are never published, and it is worth
knowing precisely:

- The DMG mounts and the app copies to `/Applications` normally. Nothing warns
  you yet.
- On first launch of a build downloaded from the internet (i.e. carrying the
  `com.apple.quarantine` attribute), macOS shows **"Archspace" cannot be opened
  because Apple cannot check it for malicious software** — with no "Open anyway"
  button in the dialog. The user has to know to go to **System Settings →
  Privacy & Security** and click *Open Anyway* under the message there, or
  right-click → Open, or run `xattr -d com.apple.quarantine`.
- `spctl -a -vvv -t install /Applications/Archspace.app` reports `rejected`.

ADR-0012 rejected "unsigned, right-click to open" distribution outright: it is
hostile to exactly the non-developer AEC users this product is for, and it trains
people to bypass Gatekeeper. On a machine that built the app locally there is no
quarantine attribute and none of this happens — which is precisely why an
unsigned build feels fine to its author and is broken for everyone else.

The release workflow builds unsigned artifacts anyway on forks, so that the
packaging path stays tested on every PR that touches it. It uploads them named
`archspace-macos-UNSIGNED`, publishes nothing, and puts a "do not distribute"
block in the job summary.

---

## 5. Cutting a release

1. **Confirm CI is green on `main`.** The release workflow re-runs the same gate,
   but finding out at tag time wastes a tag.
2. **Bump the version.** `packages/app/package.json` is the one electron-builder
   reads and the one that ends up in the artifact filename and in
   `latest-mac.yml`. Every workspace package is currently pinned at `0.1.0` in
   lockstep; keep them consistent unless and until packages are published
   separately.
3. **Commit, then tag.** The tag must match `v*` or the workflow will not fire:

   ```sh
   git commit -am "Release v0.2.0"
   git tag v0.2.0
   git push origin main --follow-tags
   ```

4. **Watch the run.** Roughly: install and gate ~5 min, build ~2 min, packaging
   and signing ~10 min, notarization anywhere from 2 to 30+ minutes (Apple's
   queue, not ours). Timeout is 60 minutes.
5. **Run the release gate** (below) against the draft's artifacts.
6. **Publish the draft** on the GitHub Releases page, and write the release
   notes there.

Releases are created as drafts deliberately. The gate is a human step, and a
draft is the only reliable way to stop a download link existing before that step
has happened.

## 6. The release gate

Both checks are from ADR-0012. Neither is automatable today.

1. **Gatekeeper on a machine that has never seen this app.** A clean VM or a
   colleague's Mac — not the machine that built it, which has no quarantine
   attribute and will pass regardless. Download the DMG *through a browser*
   (so it is quarantined), install, then:

   ```sh
   spctl -a -vvv -t install /Applications/Archspace.app
   ```

   You want `accepted` and `source=Notarized Developer ID`. Anything else stops
   the release.

2. **Update n−1 → n.** Install the previous release, launch it, and confirm it
   updates itself to this one. **This check cannot pass today** — see below.

Also check before publishing: the release contains both a `.dmg` and a `.zip`
(the ZIP feeds the updater; the updater cannot consume a DMG), plus
`latest-mac.yml` and the `.blockmap` files; and the version in the artifact
filenames is the one you meant to ship.

---

## 7. Auto-update: what actually exists

**Auto-update is not wired.** Stating this plainly because the configuration
looks like it is:

- `electron-updater` **is** a declared dependency of `@archspace/app`.
- It is **never imported**. There is no `autoUpdater` reference anywhere in
  `packages/app/src/` or in any other package — the string appears only in
  `package.json` and in comments.
- The `publish:` block in `electron-builder.yml` **is** present and real. It
  makes electron-builder emit `latest-mac.yml` and bake an `app-update.yml` into
  the bundle, which is everything the *feed* side needs.

So a release produces a well-formed update feed that nothing consumes. A shipped
Archspace will not notice that a newer version exists, and the release gate's
"update n−1 → n verified" step cannot be performed. Do not claim otherwise in
release notes.

Auto-update is scoped to **M8** in [ARCHITECTURE.md §16](ARCHITECTURE.md),
alongside the Homebrew cask (also not present in this repository). Wiring it is
main-process work in `packages/app` — `packages/app` is the only package allowed
to import Electron or Electron-adjacent modules, so `electron-updater` belongs
there and nowhere else.

---

## 8. Known gaps before the first release

Found by auditing the configuration against the repository as it stands. All
four will affect the first person who tries to cut a release.

1. **`publish.owner` / `publish.repo` are placeholders.** `electron-builder.yml`
   says `archspace/archspace`, and its own comment flags this: the canonical
   GitHub location was never confirmed, and this working tree has no git remote
   configured. electron-updater bakes these into `app-update.yml`, so a wrong
   value ships a broken update feed to every installed copy. **Fix these before
   the first tagged release**, not after.

2. **The release workflow's headless CLI step is missing `--trust-plugin` and
   will fail.** `release.yml` runs:

   ```
   pnpm cli run packages/app/resources/concept-compliance.archspace.yaml
   ```

   while `ci.yml` runs the same command with `--trust-plugin aec-review`. That
   workflow uses `aec.review.code_compliance`, which lives in the first-party
   plugin, and ADR-0008 makes an unconsented plugin unloadable. Reproduced
   locally — the step exits 1 with:

   ```
   [error] unknown-type: node "n_r9t3kv" has unknown type "aec.review.code_compliance"
   Validation failed — not running.
   plugin "aec-review" is needs-consent: this plugin has not been reviewed yet
   ```

   The step sits **before** packaging, so every tagged release fails there. The
   `--trust-plugin` flag was added after `release.yml` was written and the
   release workflow was not updated with `ci.yml`.

3. **`pnpm dist` is broken.** The root script delegates to a `dist` script that
   `@archspace/app` does not define. See §4 for what to run instead.

4. **No app icon.** `build/` intentionally contains no `icon.icns`;
   electron-builder falls back to the default Electron icon with a warning. This
   is a known, accepted state — a fake icon would be worse than an obviously
   missing one — but the first alpha will ship looking like a generic Electron
   app. Do not "fix" it by adding `mac.icon:` pointing at a path that does not
   exist; a missing icon file *is* a hard error, unlike a missing icon.
