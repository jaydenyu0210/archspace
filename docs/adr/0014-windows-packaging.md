# ADR-0014 — Package for Windows, unsigned, and stop calling it macOS-only

- **Status:** Accepted
- **Date:** 2026-08-26

## Context

ADR-0001 decided "build the application cross-platform (no platform-specific code below the shell), but **ship macOS first**", and stated that no milestone depends on a Windows build. That held: the codebase has no platform-specific implementation below the Electron shell, and the only uses of `process.platform` anywhere outside `packages/app` are in `mcpSupportCheck` and `revitPresets`, which *report* what a machine can do rather than branch on it. `packages/cli/src/config.ts` has resolved a Windows config directory since it was written.

So the Windows half of ADR-0001 was deferred, not designed around. The project owner has now asked for a Windows desktop build, which makes this the deferred half arriving rather than a change of direction.

There is a second, sharper reason to do it now. Revit runs only on Windows, and ADR-0001 decision 2 reaches Revit "exclusively as a remote MCP server" — a Windows agent talking to Archspace over the network. A user who is already on Windows is the one most likely to have Revit on the same machine, and shipping them a macOS-only app to talk to their own desktop is the least defensible version of that story.

## Decision

1. **Ship a Windows build**: NSIS installer and ZIP, for **x64 and arm64**, from the same `electron-builder.yml` as macOS. The arch list is explicit because electron-builder defaults to the host's architecture, and this repo is developed on Apple silicon — the first build produced an arm64-only installer, which almost no Windows user can run.
2. **Unsigned, and said so.** Windows code signing needs an Authenticode certificate from a CA; there is none, and one is not being bought for an alpha. SmartScreen will warn on first run, exactly as Gatekeeper does for the unsigned `.dmg`. `electron-builder` logs `signing with signtool.exe` during the build regardless; that line means it looked, not that it signed.
3. **One icon source for both platforms.** `win.icon` points at the same
   `build/icon.icns` that macOS uses; electron-builder converts it, producing a
   7-resolution `icon.ico` (16px through 256px). Keeping one source means the
   mark cannot drift between platforms, and `build/make-icon.py` stays the only
   place it is defined.
4. **NSIS with `oneClick: false` and `perMachine: false`.** A per-user install needs no elevation, and nothing the app does requires administrator rights: plugins install into the user's own data directory, and MCP servers are child processes of the app.
5. **macOS remains the primary platform.** ADR-0012 is unchanged — Developer ID, hardened runtime, notarization, universal binary. Windows gets no equivalent signing story in v1.
6. **The Windows build is produced but NOT verified.** It is built on macOS by cross-packaging. Nobody has run it on Windows. This is recorded as a known gap rather than smoothed over; see Consequences.

## Consequences

- ADR-0001 decision 1's "ship macOS first" is satisfied and now complete; its "no milestone depends on a Windows build" still holds, because nothing does — this is additive.
- **We are shipping an artifact nobody has executed.** Cross-packaging proves the bundle is *assembled* correctly — the `.exe`, the asar with workspace packages inlined, `extraResources` carrying the examples and the first-party plugin, `electron-updater` present, `app-update.yml` pointing at the real repository — and proves nothing about whether it *runs*. Everything Electron does at runtime on Windows is untested here: the utilityProcess engine child, `child_process.fork` for plugin processes, stdio MCP transports, `safeStorage` (which is DPAPI on Windows, not Keychain), and every path assumption. The `smoke` script cannot help; it needs a Windows host.
- SmartScreen on an unsigned installer is a worse first impression than Gatekeeper's, because the warning is modal and the "run anyway" affordance is hidden behind "More info". Any Windows distribution should say this in the same breath as the download link.
- Two platforms means two update feeds (`latest.yml` and `latest-mac.yml`) and twice the surface for a release to be half-published. The release workflow currently builds macOS only; making it build both is a separate change with its own risk, and is deliberately not folded in here.

## Alternatives considered

- **Stay macOS-only and wait for the Windows Revit agent** (ADR-0001 decision 3). Defensible, and was the status quo — but it makes the Revit story worse for exactly the users who have Revit, and the packaging cost turned out to be one config block rather than a port.
- **Build Windows in CI on a `windows-latest` runner instead of cross-packaging.** Strictly better: a native build, and the runner could at least launch the app. Not done here because the release workflow is macOS-shaped (keychain, `notarytool`, `spctl`) and splitting it into a matrix is a larger change than adding a target. This is the obvious next step and is recorded as such.
- **Sign with a cheap OV certificate.** OV certificates do not clear SmartScreen reputation immediately either; the warning persists until the certificate accrues reputation. Paying for a warning is not obviously better than an honest unsigned build for an alpha. Revisit with EV or Azure Trusted Signing when there is a real audience.
- **Portable `.exe` instead of an installer.** Avoids the installer UX entirely, but electron-updater has no story for it and the app would not know where to keep per-user data. Rejected.
