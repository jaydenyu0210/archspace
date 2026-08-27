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
> happened. §8 lists what is still unfinished.

---

## 1. The pipeline in one paragraph

Push a `v*` tag → `.github/workflows/release.yml` runs on `macos-latest` →
the tag and `packages/app/package.json` must agree on the version → lint,
typecheck, build the first-party plugin, test, headless CLI run → one step
decides whether this run signs and whether it publishes → if the signing secrets
are present, `electron-builder` packages a universal DMG + ZIP, signs them with
your Developer ID Application certificate, submits them to Apple for
notarization, and (on a tag, with a real update feed configured) creates a
**draft** GitHub Release; if the secrets are absent it packages the same
artifacts **unsigned**, labels them `UNSIGNED`, publishes nothing, and says so in
the job summary. Either way the built `.app` is then inspected to prove its
internal layout matches what main resolves at runtime. A human runs the
[release gate](#6-the-release-gate) and publishes the draft.

`workflow_dispatch` does the same thing without a tag, for dry runs. It never
publishes, and that is enforced by keying `--publish` off the *event* rather than
off the secrets — a manual run in the canonical repo has every secret it needs to
publish and must still refuse to.

---

## 2. Secrets

Six repository secrets appear in `release.yml`. Set them under
**Settings → Secrets and variables → Actions → Repository secrets**.

| Secret | What it is | Required? |
|---|---|---|
| `CSC_LINK` | Base64 of your Developer ID Application `.p12` (certificate + private key) | One of the five |
| `CSC_KEY_PASSWORD` | The password you set when exporting that `.p12` | One of the five |
| `APPLE_API_KEY` | Base64 of an App Store Connect API key `.p8` file | One of the five |
| `APPLE_API_KEY_ID` | The 10-character Key ID of that key | One of the five |
| `APPLE_API_ISSUER` | The Issuer ID (a UUID) of your App Store Connect team | One of the five |
| `GH_TOKEN` | A token for creating the draft Release under a specific account | **Optional** |

**The five signing secrets are all-or-nothing.** The `Decide how this run
packages` step checks every one of them, including `CSC_KEY_PASSWORD`; if any is
missing the run downgrades cleanly to an unsigned, unpublished build and warns.
Setting four of five does not get you a partly-signed release — it gets you an
unsigned one, which is the correct and honest outcome. (`CSC_KEY_PASSWORD` is in
that check specifically because a `.p12` without its password fails deep inside
electron-builder with an opaque keychain error.)

**`GH_TOKEN` is genuinely optional.** The publish step reads
`${{ secrets.GH_TOKEN || secrets.GITHUB_TOKEN }}`, and the workflow's
`permissions: contents: write` block is what makes that fallback real rather than
decorative. Set `GH_TOKEN` only if you need the draft Release created under an
account other than the workflow's own token.

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
3. Double-click the `.cer` to install it. In Keychain Access it should now show a
   disclosure triangle with a private key underneath. If it does not, you
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

   (GNU `base64` wraps at 76 columns. Wrapped input still decodes, but if you are
   producing this on Linux, prefer `base64 -w0`.)

6. Delete the `.p12` from disk when you are done. The secret store is the copy
   that matters.

Certificates expire after five years, and Apple revokes them if the Developer
Program membership lapses. A revoked or expired certificate does **not** downgrade
the run to unsigned — `CSC_LINK` is still non-empty, so the pre-flight check
passes and signing fails instead.

### 2.2 `APPLE_API_KEY`, `APPLE_API_KEY_ID`, `APPLE_API_ISSUER` — notarization

**Notarization** is separate from signing. Signing proves *who* built the app;
notarization is Apple scanning the signed artifact for malware and issuing a
ticket that says it passed. Since macOS 10.15 an un-notarized download is refused
by Gatekeeper even when it is correctly signed. `notarytool` (used by
electron-builder under `notarize: true`) authenticates with an **App Store Connect
API key** — a JWT-signing key, not a password, and the reason an app-specific
password is no longer the recommended path.

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
`APPLE_API_KEY` to `notarytool` as a **path**, not as key material. Two details in
that step are deliberate and worth not undoing:

- It writes to `$RUNNER_TEMP`, **outside the workspace**, so that no glob in
  `electron-builder.yml`'s `files:` list can ever sweep a private key into the app
  bundle.
- It greps the first decoded line for `BEGIN PRIVATE KEY`. A mangled secret — the
  usual cause being pasting the `.p8` text instead of its base64 — fails there in
  seconds with an actionable error, rather than forty minutes later inside
  `notarytool` with an opaque one.

A `Remove the API key` step runs with `if: always()`.

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
cheap; debugging a silently-dead plugin process on a notarized build is not, so it
ships enabled. **On the first real signed run, try deleting it**: if the
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

```sh
pnpm dist    # builds the first-party plugin, then the app, then packages it
```

That is the root `dist` script; it runs the plugin build first because the
plugin's `dist/index.js` is copied into the app's `extraResources`, and packaging
before it exists produces an app with no plugin. `packages/app`'s own `dist`
script passes `--publish never`.

For signing, electron-builder auto-discovers a Developer ID identity in your login
keychain. To force an unsigned build — the normal case for a contributor who
happens to have a certificate installed:

```sh
CSC_IDENTITY_AUTO_DISCOVERY=false pnpm dist
```

Artifacts land in `packages/app/dist/` — `dist/`, not `release/`, because
`.gitignore` already ignores `dist/` and packaging output must never be a
candidate for `git add`.

**A local `pnpm dist` produces an app whose updater points at nothing**, because
the `publish.owner`/`publish.repo` placeholders are still in
`electron-builder.yml` (§8). CI refuses to publish in that state; a local build
does not, so do not hand a locally-built DMG to anyone.

### What a user sees for an unsigned build

This is the reason unsigned artifacts are never published, and it is worth knowing
precisely:

- The DMG mounts and the app copies to `/Applications` normally. Nothing warns you
  yet.
- On first launch of a build downloaded from the internet (i.e. carrying the
  `com.apple.quarantine` attribute), macOS shows **"Archspace" cannot be opened
  because Apple cannot check it for malicious software** — with no "Open anyway"
  button in the dialog. The user has to know to go to **System Settings → Privacy
  & Security** and click *Open Anyway* under the message there, or right-click →
  Open, or run `xattr -d com.apple.quarantine`.
- `spctl -a -vvv -t install /Applications/Archspace.app` reports `rejected`.

ADR-0012 rejected "unsigned, right-click to open" distribution outright: it is
hostile to exactly the non-developer AEC users this product is for, and it trains
people to bypass Gatekeeper. On a machine that built the app locally there is no
quarantine attribute and none of this happens — which is precisely why an unsigned
build feels fine to its author and is broken for everyone else.

The release workflow builds unsigned artifacts anyway on forks, so that the
packaging path stays tested on every PR that touches it. It uploads them named
`archspace-macos-UNSIGNED`, publishes nothing, and puts a "do not distribute"
block in the job summary.

---

## 5. Cutting a release

1. **Confirm CI is green on `main`.** The release workflow re-runs the same gate —
   same steps, same order, same flags as `ci.yml` — but finding out at tag time
   wastes a tag.
2. **Confirm the update feed is configured.** `publish.owner` / `publish.repo` in
   `electron-builder.yml` must not still say `REPLACE-ME-*`. A signed tag build
   **hard-fails** while they do (§8).
3. **Bump the version in `packages/app/package.json`.** electron-builder derives
   the artifact filenames and the version inside `latest-mac.yml` from that file,
   **not from the tag**. The workflow's first step fails the run if the tag and
   that version disagree, because a mismatch produces a release that looks fine and
   an update feed no installed app will ever accept. Every workspace package is
   currently pinned at `0.1.0` in lockstep; keep them consistent unless and until
   packages are published separately.
4. **Commit, then tag.** The tag must match `v*` or the workflow will not fire, and
   `v<X.Y.Z>` must equal the app's version exactly:

   ```sh
   git commit -am "Release v0.2.0"
   git tag v0.2.0
   git push origin main --follow-tags
   ```

5. **Watch the run.** Roughly: install and gate ~5 min, build ~2 min, packaging and
   signing ~10 min, notarization anywhere from 2 to 30+ minutes (Apple's queue, not
   ours). Timeout is 60 minutes.
6. **Run the release gate** (§6) against the draft's artifacts.
7. **Publish the draft** on the GitHub Releases page, and write the release notes
   there.

Releases are created as drafts deliberately. The gate is a human step, and a draft
is the only reliable way to stop a download link existing before that step has
happened.

To rehearse all of this without a tag, run the workflow via **workflow_dispatch**.
It builds, signs and notarizes exactly as a tag run would, and publishes nothing.

## 6. The release gate

Both checks are from ADR-0012. Neither is automatable today.

1. **Gatekeeper on a machine that has never seen this app.** A clean VM or a
   colleague's Mac — not the machine that built it, which has no quarantine
   attribute and will pass regardless. Download the DMG *through a browser* (so it
   is quarantined), install, then:

   ```sh
   spctl -a -vvv -t install /Applications/Archspace.app
   ```

   You want `accepted` and `source=Notarized Developer ID`. Anything else stops the
   release.

2. **Update n−1 → n.** Install the previous release, launch it, and confirm it
   updates itself to this one. **This check cannot pass today** — see §7.

Also check before publishing: the release contains both a `.dmg` and a `.zip` (the
ZIP feeds the updater; the updater cannot consume a DMG), plus `latest-mac.yml` and
the `.blockmap` files; and the version in the artifact filenames is the one you
meant to ship.

### What CI already checks so you do not have to

The `Verify the packaged layout matches what main resolves at runtime` step opens
the built `Archspace.app` and asserts that every example workflow is at
`Contents/Resources/resources/` and that the first-party plugin is at
`Contents/Resources/plugins/aec-review/dist/index.js`.

This exists because the bug it catches has no unit test and no dev-mode symptom.
`files:` in `electron-builder.yml` puts things **inside** `app.asar`;
`extraResources:` puts them **beside** it. Main resolves both the bundled examples
and the plugin from `process.resourcesPath`, so getting that wrong leaves
`pnpm dev` perfect while the shipped `.dmg` opens to an empty canvas. The check
derives the example list from the source directory rather than restating it, so
adding a workflow cannot silently skip it.

---

## 7. Auto-update: what actually exists

**Auto-update is not wired.** Stating this plainly because the configuration looks
like it is:

- `electron-updater` **is** a declared dependency of `@archspace/app`.
- It is **never imported**. There is no `autoUpdater` reference anywhere in any
  package's `src/` — the string appears only in `package.json` and in comments.
- The `publish:` block in `electron-builder.yml` **is** present and real. It makes
  electron-builder emit `latest-mac.yml` and bake an `app-update.yml` into the
  bundle, which is everything the *feed* side needs.

So a release produces a well-formed update feed that nothing consumes. A shipped
Archspace will not notice that a newer version exists, and the release gate's
"update n−1 → n verified" step cannot be performed. Do not claim otherwise in
release notes.

Auto-update is scoped to **M8** in [ARCHITECTURE.md §16](ARCHITECTURE.md),
alongside the Homebrew cask (also not present in this repository). Wiring it is
main-process work in `packages/app` — `packages/app` is the only package allowed to
import Electron or Electron-adjacent modules, so `electron-updater` belongs there
and nowhere else.

---

## 8. Before the first release

**The update feed now points somewhere real, but at a private repository.**
`electron-builder.yml` names `jaydenyu0210/archspace`, and
`packages/app/src/main/updates.ts` reads that feed — both halves that were
missing are now present. But an update feed can only be read anonymously from a
**public** repository, so auto-update will not reach anyone while this repo is
private. Make it public, or point `publish` at a public mirror, before promising
users updates.

The `REPLACE-ME` guard in the `Decide how this run packages` step is retained
even though the token is gone. It still **hard-fails** a signed tag build if a
placeholder ever reappears, and **warns** on any other run. It costs nothing and
it is the check that stops a release which can never receive an update.

### What an unsigned `pnpm dist` has actually been shown to do

Run on 2026-08-26, macOS, no signing identity present. Everything in this list
was observed, not reasoned about:

- **It builds.** `dist/Archspace-0.1.0-universal.dmg` and the matching `.zip`
  (~233 MB each), plus their blockmaps, universal (arm64 + x64).
- **Signing degrades honestly.** electron-builder reports
  `skipped macOS application code signing … 0 identities found` and carries on.
  A fork with no certificate gets an unsigned build, not a confusing failure.
- **`electron-updater` is collected** — 38 entries inside `app.asar`. The worry
  that pnpm's symlinked `node_modules` would defeat electron-builder was
  unfounded. (`updates.ts` still imports it dynamically inside a try/catch, so
  a future miss degrades to "no auto-update" rather than a crash on launch.)
- **`app-update.yml` carries the real coordinates**, `jaydenyu0210/archspace`.
- **extraResources ship**: all three `*.archspace.yaml` examples under
  `Contents/Resources/resources`, and the first-party plugin with its built
  `dist/` under `Contents/Resources/plugins`.
- **`icon.icns` is in the bundle.**
- **The packaged app launches and works.** Driven over the DevTools Protocol:
  the shell renders (toolbar, library, canvas, inspector), the palette holds
  18 node types — which only happens if main spawned the engine child and the
  two agreed over a MessagePort — and it opens the bundled example by name,
  "Concept compliance check", six nodes on the canvas, no error notices.

### What is still unproven

Everything that needs credentials or a published release, which is to say the
entire second half of this document:

- No `codesign`, no `notarytool`, no stapling, no `spctl -a` on a clean
  machine — there is no Developer ID identity here.
- No tag has been pushed, so `release.yml` has never run.
- Auto-update has never fetched anything. The feed is real but the repository
  is private, and a Releases feed is only anonymously readable from a public
  one.

So: the packaging is verified, the *release* is not. The first tag will be the
first time the signing half of this file is exercised.

**The app icon is generated, not drawn.** `build/make-icon.py` renders
`icon.png` and `icon.icns`, and `mac.icon` points at the `.icns`. Both artifacts
are checked in so a contributor without the toolchain still builds an app that
looks right; regenerate with `python3 packages/app/build/make-icon.py` (macOS
only — it shells out to `sips` and `iconutil`).

If you change it, judge it at **16px and 32px first**. The initial version was
composed at 1024 and turned to mush in the Dock, which is where an icon is
actually seen. Note also that `mac.icon` pointing at a path that does not exist
is a hard error — worse than having no `icon` key at all — so delete the key and
the file together if you ever remove it.
