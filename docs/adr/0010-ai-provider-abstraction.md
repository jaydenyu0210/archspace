# ADR-0010 — Own AiGateway over the AI SDK provider layer; model profiles

- **Status:** Accepted
- **Date:** 2026-08-24

## Context

AI is first-class but no provider may be privileged — including local models (Ollama, self-hosted OpenAI-compatible endpoints). Nodes must not embed provider SDKs, and a workflow written against one provider must run unchanged against another.

## Decision

1. **Nodes call `ctx.ai`** — our own minimal interface: `generateText`, `generateObject` (JSON-Schema-constrained), `embed`. It is the only AI surface in `node-sdk`.
2. **The gateway is implemented over the Vercel AI SDK provider layer** (`ai` + `@ai-sdk/*`, Apache-2.0): one maintained local library covering Anthropic, OpenAI, Google, Mistral, Ollama, and any OpenAI-compatible endpoint. It is a *library*, not a routed service — no traffic touches a middleman, no hosted gateway is a default. Because nodes only see our interface, the AI SDK is swappable if it churns.
3. **Workflows reference named model profiles** (`default`, `fast`, `reasoning`), defined in user settings as provider+model+params, keys in the Keychain. Profile names resolve per machine — that is what makes workflows portable across providers. Hard `provider/model` pins are allowed but lint-flagged.
4. A **`mock` provider** ships in-tree: scripted responses for CI and the testkit; no live API calls in any blocking test lane.

## Consequences

- A second abstraction layer (ours over the SDK's) — thin by design; the cost of never leaking a dependency into the public contract.
- Structured output (`generateObject`) becomes the workhorse for AI→`table`/`json` port flows.
- Provider capability differences (context length, modality) surface as profile-level validation errors, not node-level surprises.

## Alternatives considered

- **LangChain:** heavy, churn-prone abstraction; our graph *is* the chain — we need calls, not orchestration. Rejected.
- **N provider SDKs behind our interface:** that's volunteering to maintain N integrations; the AI SDK provider layer is exactly that maintenance, shared with a large community. Rejected.
- **Hosted router (OpenRouter-style) as default:** privileges a middleman, adds a network dependency and a data-path third party to an offline-capable app; users may still configure one as an endpoint — their choice. Rejected as default.
- **Raw per-node HTTP:** no shared retry/abort/usage accounting, keys handled ad hoc. Rejected.
