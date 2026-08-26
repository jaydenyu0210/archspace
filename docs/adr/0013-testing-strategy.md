# ADR-0013 — Headless-first testing: property suites, deterministic scheduler, testkit

- **Status:** Accepted
- **Date:** 2026-08-24

## Context

The riskiest components — serializer, type rules, scheduler/cache/cancellation, plugin RPC — are exactly the ones E2E tests cover worst. Desktop E2E is slow and flaky; concurrency bugs don't reproduce under real clocks; AI calls in CI are nondeterministic and cost money.

## Decision

1. **Architecture serves testing:** every package below the Electron shell is Electron-free; the CLI runner (`archspace run`) is simultaneously a user feature and the integration harness. CI runs real workflows headless from M2 onward.
2. **Property-based suites (fast-check) guard the document:** parse/emit round-trip, canonical stability, **comment survival through open→edit→save**, migration round-trips — plus golden workflow files whose diffs make serializer changes reviewable events.
3. **The scheduler ships with a deterministic mode** (virtual clock, seeded ordering, simulated nodes): branch-overlap, cancellation-latency, zero-recompute-on-cache-hit, independent-branch-survival, and exact retry backoff are asserted, not hoped. Run event logs are snapshot-tested.
4. **`@archspace/node-sdk/testkit`:** run any `NodeModule` against fixtures with an in-memory ctx (mock assets/ai/secrets, captured logs/progress) — no app required. Plugin authors get the same tool we use for core nodes.
5. **MCP:** SDK `InMemoryTransport` for unit tests; a fixture server binary for process-level spawn/kill/timeout/cancel tests; CI contract run against the reference `everything` server; drift fixtures; Revit-path smoke against recorded community-server fixtures (no Windows/Revit in CI).
6. **AI:** `mock` provider only in blocking lanes; optional non-blocking nightly live smoke behind secrets.
7. **E2E (Playwright-for-Electron) stays thin:** the create→wire→run→save→reload happy path and little else. Packaging gate: clean-VM Gatekeeper + updater checks (ADR-0012).

Coverage is a signal; the gates are the property suites, golden files, and deterministic engine suite.

## Consequences

- Deterministic mode and the testkit are built features with maintenance cost — paid deliberately, early (M1–M2), because they cheapen every later milestone.
- Golden-file churn requires review discipline (a canonicalization change touches many goldens at once — that's the point).
- Live-provider and live-Revit coverage is explicitly non-blocking; fixtures are the contract in CI.

## Alternatives considered

- **E2E-heavy pyramid:** slow, flaky, and blind to scheduler/serializer internals. Rejected.
- **Example-only serializer tests:** the bug space is combinatorial (nesting × comments × migrations); properties or bust. Rejected.
- **Live AI/MCP calls in CI:** nondeterministic, slow, costly, secret-leaky. Rejected from blocking lanes.
