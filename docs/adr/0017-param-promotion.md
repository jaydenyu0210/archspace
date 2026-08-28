# ADR-0017 — Param promotion persists as a `promoted:` list on the node entry

- **Status:** Accepted
- **Date:** 2026-08-28

## Context

[ARCHITECTURE §5.1](../ARCHITECTURE.md) and [ADR-0005](0005-node-contract.md) decision 3 already settled *that* promotion exists: params and inputs are separate declarations, "but any param marked *promotable* can be exposed as an input port of the corresponding type; a wired value overrides the configured one". Grasshopper's everything-is-an-input was rejected as hostile to form-based configuration, n8n's hard split as hostile to composition, and promotion named as the converged middle.

Nothing was built. [§9.3](../ARCHITECTURE.md) states the schema-type → port-type table and `mcp-host` already marks **every** MCP tool argument `promotable: true`; `host.ts`'s `callArguments` already merges `inputs` over `params` with a comment saying it "needs no change on the day promotion lands". What was missing was not the plumbing at the ends but the thing in the middle: **§4.2's node entry has no field for the choice**, so a user's promotion had nowhere to live, and no code anywhere read the `promotable` flag.

Two facts about this repository shaped the answer more than anything else:

- **`packages/document` resolves no node registry.** It validates that an edge's *node ids* exist and never that its *ports* do — port existence is the engine's job, at `validateGraph`. So a document is readable, reviewable and hand-editable without a registry, deliberately.
- **There is no migration framework.** `archspace: 2` is a hard parse failure with no upgrade path (recorded in §16 and [STATUS.md](../STATUS.md)). Any change to the format has to be additive within `archspace: 1` or it is not a change we can afford.

## Decision

1. **A node entry gains an optional `promoted:` key** — a flow sequence of param names, between `schemaHash` and `config`, above `layout:` and therefore on the semantic side of §4.2 rule 2's quarantine.

   ```yaml
   nodes:
     - id: n_p2f6dy
       type: aec.export_dxf
       version: 1
       promoted: [file_name]
       config:
         file_name: riverside-tower.dxf   # retained: the fallback if the wire goes
         level: all

   edges:
     - n_c1a9qw.text -> n_p2f6dy.file_name
   ```

2. **Declared, not inferred from the edges.** The tempting alternative is to make an edge into a param *be* the promotion, changing nothing in `packages/document` at all. It was rejected on two grounds. A promotion that is not yet wired becomes unrepresentable, so a user who exposes six MCP arguments and wires three loses the other three on reload — and this project's own notes record sessions being interrupted. And it makes the document stop being self-describing: `n_a.text -> n_b.prompt` is indistinguishable from a typo to every reader without a registry, in a package that is registry-free on purpose.

3. **The port id is the param name, verbatim.** No snake_case folding, no namespacing. This is forced, not chosen: `callArguments` filters the merged arguments against `Object.keys(tool.inputSchema.properties)`, so any renaming scheme would silently drop the wired value and send the stale configured one to the server. Verbatim ids make the two key spaces identical by construction, which is what makes that file's "no change needed" claim actually true.

4. **A param whose name cannot be an edge endpoint is not promotable.** The edge grammar is `[A-Za-z0-9_-]+` per segment, so a tool argument named `file.path` — legal JSON Schema, and something servers really publish — is refused at the affordance rather than producing a document that cannot be saved.

5. **`promoted:` is sorted and deduped, on read and on write.** It is a set, and a set has one written form; `requires:` is the house precedent. This costs no diff churn: `saveWorkflow` re-extracts the CST it is about to patch to get its baseline, and `extractWorkflow` normalises both sides, so a file containing `promoted: [b, a]` compares equal to itself and is left exactly as the human typed it until the promotions actually change.

6. **One derivation of the effective port list**, `resolvePromotions`, in `@archspace/node-sdk/promotion`. Five sites read `manifest.inputs` — the validator three times, the runner's input assembly, the renderer's connection check and its node card — and a graph that validates against one port list and executes against another is the silent failure this design exists to prevent. Its own module and its own package export path, because the renderer needs it at runtime and importing it from the barrel would drag `@noble/hashes` into the browser bundle for a pure string mapping.

7. **A promoted port is always `required: false`.** The configured param, or its schema default, is what it falls back to — that *is* "a wired value overrides the configured one". `validateGraph` errors on any port whose `required` is not exactly `false`, so this is load-bearing rather than a default.

8. **The wired value is folded into `params` between `applySchemaDefaults` and the cache key, and deleted from `inputs`.** Placement is the whole correctness argument: a value that reached `execute` without reaching `hashValue` would be memoized under a key that does not describe it, and §7.3's "a cache entry is valid forever by construction" would quietly stop being true. Deleting it from `inputs` is the other half — `execute(ctx, inputs, params)` must see a promoted param in exactly one place, and §5.1 says which: it is a param that happens to be wired, not an input that happens to have a default.

9. **A promotion that cannot be honoured still produces a port**, typed `any` and optional, alongside one `bad-promotion` error. This is error economy, not leniency: without the synthesised port the same mistake yields a `bad-edge` *and* a false `missing-input` naming a port the user did wire.

10. **Promotion validation is suppressed for placeholder nodes**, exactly as port validation already is. An unknown type or a version mismatch `continue`s before any port check, and `promoted:` round-trips verbatim regardless — so opening a colleague's workflow without their plugin never deletes their wiring.

11. **No `ENGINE_ABI` bump.** A document with no promotions produces byte-identical `params` and `inputHashes`, so every existing memo stays valid.

12. **No validation of wired values against the param schema.** See Consequences; this is the decision most worth disagreeing with.

## Consequences

- **The engine's scheduling machinery needed no change at all.** `upstreamOf`/`downstreamOf`, the demand closure, the topological order, `incomingByPort`, `remainingDeps`/`dependents` and `findCycles` are built from `graph.edges` alone and never consult a manifest — so an edge into a promoted port already creates the dependency, already delays the node, and already participates in cycle detection. This is the single most reassuring fact about promotion and it is invisible unless someone reads those five call sites.
- **A wired value and the same configured value produce one cache key, not two.** That is a correctness result rather than a collision: `execute` receives an identical `(inputs, params)` pair either way, so a pure node's answer is identical and one memo is the right number of memos.
- **The §9.3 mapping is lossy, and we are accepting the loss.** `enum` collapses to `text` and `array` to `json`, so a promoted enum port accepts any string and a promoted array port accepts any JSON value — and since every MCP argument is promotable and MCP nodes declare `inputs: []`, this is the primary case rather than an edge case. A wrong value therefore surfaces as a strict server's rejection one screen and one run away from the wiring mistake. The alternative — checking a wired value against its schema at delivery — was drafted and dropped: nothing in this repository validates params against their schema, so it would refuse on a wire exactly what the inspector form accepts, and "overrides the configured one" would silently become "overrides it and is also held to a standard it is not". Params validation deserves its own ADR and its own symmetry argument.
- **Removing `promotable` from a shipped param, renaming it, or an MCP server dropping the property, turns a saved edge into a hard refusal.** A `version` bump is owed, and owing it does not help anyone, because there are no migrations. What the user sees is a `bad-promotion` error naming the param and the node type — which is the honest outcome, and the reason `bad-edge` now says "is a promotable param … add it to that node's `promoted:` list" instead of "unknown input port".
- **A 20-argument MCP tool can grow 20 handles.** v1 accepts that, because the user chose each one: the inspector promotes one param at a time and the canvas draws what the document says. If it becomes a problem the fix is presentational (collapse unwired promoted ports into an expandable stub) and needs no format change.
- **`{{input_name}}` substitution (§4.2) is still deferred**, and inherits the same forbidden-param rule when it lands: it would run at the same seam, immediately before the cache key, and must not read a param a static derivation depends on.
- Two pre-existing defects were fixed because promotion put them in the path. `edgesInto` was populated only when the target port resolved, so a mistyped port name produced one accurate error and one false one; and nothing kept `canonicalNodeShape`'s key order in step with `NODE_ORDER`, a latent hazard that adding a field would have doubled. Both now have tests that fail when reintroduced.

## Alternatives considered

- **Promotion is the edge; no new field** (the minimal-format design). Genuinely elegant — no change to `packages/document`, no `EngineNodeSpec` field, no doc→graph mapping to keep in step — and its cache analysis was the sharpest of the three considered. Rejected because it makes "promoted but not yet wired" unrepresentable, pushing the user's intent into session state that dies on reload; because it makes the document unreadable without a registry; and because exposing every promotable param as a port on every instance is, for the MCP case where *every* argument is promotable, materially the Grasshopper design ADR-0005 named as rejected, with a UI curtain in front of it.
- **Preserve the author's order in `promoted:` instead of sorting.** Defensible — `save.ts` refuses to tidy a human's key order on the same principle. Rejected because it makes `[a, b]` and `[b, a]` two documents where the product means one, forcing every downstream comparison to decide independently whether order matters. Sorting on both sides gets the canonical form *and* keeps the human's file untouched, because the diff is computed after normalisation.
- **A richer entry than a name list** — per-promotion type overrides, labels, defaults. Rejected as scope with no demand behind it: the schema already carries a title, a description and a type, and a second place to say those things is a second place for them to disagree.
- **Track failed promotions in a side structure** rather than synthesising an `any` port. Equivalent in effect and worse in upkeep: a second collection to keep in step with the edge loop, where the synthesised port suppresses the derivative errors by construction.
