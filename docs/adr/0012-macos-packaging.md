# ADR-0012 — electron-builder, Developer ID + notarization, no Mac App Store

- **Status:** Accepted
- **Date:** 2026-08-24

## Context

macOS is the first shipped platform (ADR-0001). An unsigned/un-notarized app is effectively unshippable past Gatekeeper. The product's spine — spawning stdio MCP servers, per-plugin child processes, opening arbitrary project directories — conflicts with the Mac App Store's App Sandbox.

## Decision

1. **electron-builder + electron-updater**, publishing to **GitHub Releases** (canonical) with a **Homebrew cask** alongside. Auto-update against Releases; staged rollouts/deltas later.
2. **Universal binary** (arm64 + x64), DMG for humans + ZIP for the updater.
3. **Developer ID Application** signing, **hardened runtime**, minimal entitlements, **notarization via `notarytool`** in GitHub Actions CI (cert + App Store Connect API key as CI secrets). Release gate: `spctl -a` passes on a clean macOS VM and update n−1 → n works.
4. **No Mac App Store in v1.** The App Sandbox would break stdio MCP subprocesses, plugin host processes, and free project-directory access. Revisit only if the process model ever changes.
5. **App Sandbox off; hardened runtime on.** The security story is the process/permission architecture (ADR-0008, ARCHITECTURE §12), stated honestly — not a store checkbox.
6. Plugins are user-installed code: downloaded archives keep quarantine semantics, and "contains native code" is surfaced during install consent.

## Consequences

- We own the update trust chain (signed releases, updater integrity) rather than delegating to a store.
- No MAS discovery channel; Homebrew + GitHub is the open-source-native equivalent for the target audience.
- Notarization makes CI the only sanctioned release path — no laptop builds; that's a feature.

## Alternatives considered

- **Electron Forge:** first-party and fine, but builder+updater+Releases is the most-trodden open-source path with the richest macOS packaging knobs. Rejected (revisitable cheaply — build tooling, not architecture).
- **Mac App Store:** sandbox incompatibility above; also review latency for a fast-moving alpha. Rejected for v1.
- **Unsigned "right-click to open" distribution:** hostile to exactly the non-developer AEC users we want. Rejected.
- **Sparkle updater:** the native-app standard, but electron-updater integrates directly with our build pipeline and Releases. Rejected.
