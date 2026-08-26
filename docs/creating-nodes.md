# Creating a node

A node is the unit of work in an Archspace workflow. This guide walks you
through building one from nothing, using a node that actually ships in this
repository — `aec.parking_estimate`, in
[`packages/nodes-core/src/parking-estimate.ts`](../packages/nodes-core/src/parking-estimate.ts).
Everything below is the real file, not a sketch; you can run it after every step.

The contract you are implementing is specified in
[ARCHITECTURE.md §5](ARCHITECTURE.md) and [ADR-0005](adr/0005-node-contract.md).
Read those when you want the reasoning. This page is the practical path.

---

## 1. What you are actually writing

A node type is exactly two things:

```ts
export const myNode: NodeModule<MyParams> = {
  manifest: { /* pure serializable data — ports, params, caching, lane */ },
  async execute(ctx, inputs, params) { /* one async function */ },
};
```

The **manifest** is data, never code. The app builds the palette, generates the
properties form, validates documents and computes cache keys from it *without
executing your node*. The **execute** function receives only what `ctx` gives
it: there is no ambient `fs`, no bare network, no provider SDKs. That single
property is what makes the plugin boundary and the testkit work.

Both halves live in one file under `packages/nodes-core/src/`. (When the plugin
host lands — §8 of the architecture — a third-party plugin will export this
exact `NodeModule` shape from its own package, so nothing you learn here is
throwaway.)

## 2. Decide the node's shape before writing code

Answer these five questions first; they *are* the manifest.

| Question | For our example |
|---|---|
| What comes in on wires? | The project brief (required), the site's zoning constraints (optional) |
| What goes out on wires? | A space count, a breakdown table, the full estimate |
| What is configured in the form? | Parking ratio, accessible %, EV-ready %, area per space |
| Same inputs ⇒ same outputs? | Yes — so `caching: 'pure'` |
| What does it spend? | CPU, microseconds — so `lane: 'cpu'` |

Two rules of thumb that will save you a rewrite:

- **Wires carry meaning, forms carry configuration.** If a value comes from
  another node, it is an input port. If a human types it, it is a param.
- **Wire values stay small.** Anything bulky — a model, an image, a big CSV —
  travels as an `AssetRef` into the content-addressed store, never as bytes on
  a wire.

## 3. The manifest

```ts
import type { NodeModule, Value } from '@archspace/node-sdk';
import type { ParkingEstimate, ProjectBrief, SiteConstraints, TableValue } from './shapes.js';
import { requireInput, round2, toValue } from './util.js';

export interface ParkingEstimateParams {
  ratio_per_100_m2: number;
  accessible_pct: number;
  ev_ready_pct: number;
  space_area_m2: number;
}

export const parkingEstimateNode: NodeModule<ParkingEstimateParams> = {
  manifest: {
    type: 'aec.parking_estimate',
    version: 1,
    label: 'Parking Estimate',
    description:
      'Estimates the parking spaces the brief requires — total, accessible and EV-ready — and the site area they consume.',
    category: 'Plan',
    keywords: ['parking', 'zoning', 'site', 'planning'],
    caching: 'pure',
    lane: 'cpu',
    params: {
      type: 'object',
      properties: {
        ratio_per_100_m2: {
          type: 'number',
          title: 'Spaces per 100 m²',
          description: 'Leave at 0 to take the ratio from the connected site constraints.',
          default: 0,
          minimum: 0,
          maximum: 20,
        },
        accessible_pct: { type: 'number', title: 'Accessible spaces (%)', default: 4, minimum: 0, maximum: 20 },
        ev_ready_pct:   { type: 'number', title: 'EV-ready spaces (%)',   default: 10, minimum: 0, maximum: 100 },
        space_area_m2:  { type: 'number', title: 'Area per space (m², incl. aisle)', default: 27.5, minimum: 15, maximum: 60 },
      },
    },
    inputs: [
      { id: 'brief', type: 'json', label: 'Brief', required: true },
      { id: 'constraints', type: 'json', label: 'Site constraints', required: false },
    ],
    outputs: [
      { id: 'spaces_required', type: 'number', label: 'Spaces required' },
      { id: 'breakdown', type: 'table', label: 'Breakdown' },
      { id: 'estimate', type: 'json', label: 'Estimate' },
    ],
  },
  // execute follows in §4
};
```

Field by field, with the parts that bite:

**`type`** — `<namespace>.<name>`, lowercase snake segments. `core`, `ai` and
`mcp` are reserved for the app; `aec` is this package's namespace. A plugin owns
its own namespace and may only register types under it.

**`version`** — an integer, bumped whenever the observable contract changes:
ports, params, or semantics. Documents pin `type@version`, and the engine
refuses to run a node whose pinned version is not the registered one. Adding a
*new optional* output field is additive and does not need a bump; renaming a
port does.

**`category`** — the palette group. This package uses the five workflow stages:
`Plan`, `Generate`, `Review`, `Modify`, `Report`. See [nodes.md](nodes.md).

**`params`** — a JSON Schema 2020-12 subset. Give **every param a `default`**,
so a freshly dropped node runs without being configured. The properties panel
generates its form straight from this schema
([`ParamField.tsx`](../packages/app/src/renderer/src/components/ParamField.tsx)),
which today renders:

| Schema | Control |
|---|---|
| `enum: [...]` | select |
| `type: 'boolean'` | checkbox |
| `type: 'number' \| 'integer'` | number input honouring `minimum`/`maximum` |
| `type: 'string'` | text input |
| `type: 'string'` + `'x-archspace': { widget: 'textarea', rows: 4 }` | textarea |

Anything else renders as "unsupported" — so if you need an array or a nested
object param today, model it as scalars. (`aec.filter_findings` does exactly
this: three booleans instead of an array of severities.)

**`inputs` / `outputs`** — `PortDecl`s. The `type` is a port-type expression
from [§6](ARCHITECTURE.md): `text`, `number`, `boolean`, `json`, `chat`,
`table`, `asset` / `asset<ifc>`, `list<T>`, or `any`. Inputs are required
unless you say `required: false`. An input marked `variadic: true` accepts many
edges and is delivered as `list<T>` in edge order — that is how
`aec.merge_findings` takes five reviews at once.

**`caching`** — `'pure'` means *same params and inputs always produce the same
outputs*, and lets the engine skip the node entirely on a re-run. `'never'` is
the default and always executes. Be honest here: a node that lies about purity
serves stale results forever.

**`lane`** — the concurrency pool: `cpu` (default), `io`, `ai`, or
`mcp:<server>`. Lanes have separate caps, so a slow `ai` node cannot starve
cheap `cpu` work.

## 4. The execute function

```ts
  async execute(ctx, inputs, params) {
    const brief = requireInput<ProjectBrief>(inputs, 'brief', 'aec.parking_estimate');
    const constraints = inputs.constraints as unknown as SiteConstraints | undefined;

    // Precedence: an explicit param wins, then the zoning ratio, then a
    // documented default — and the estimate records which one was used.
    let ratio = params.ratio_per_100_m2;
    let ratioSource: ParkingEstimate['ratioSource'] = 'param';
    if (ratio <= 0) {
      const zoned = constraints?.limits?.minParkingPer100M2;
      if (typeof zoned === 'number' && zoned > 0) {
        ratio = zoned;
        ratioSource = 'constraints';
      } else {
        ratio = FALLBACK_RATIO;
        ratioSource = 'default';
        ctx.log('info', `no parking ratio supplied — assuming ${FALLBACK_RATIO} spaces per 100 m²`);
      }
    }

    const grossAreaM2 = brief.targetGrossAreaM2;
    const total = Math.ceil((grossAreaM2 / 100) * ratio);
    const accessible = total > 0 ? Math.max(1, Math.ceil((total * params.accessible_pct) / 100)) : 0;
    const evReady = Math.ceil((total * params.ev_ready_pct) / 100);
    const standard = Math.max(0, total - accessible);
    const areaM2 = round2(total * params.space_area_m2);

    const estimate: ParkingEstimate = {
      grossAreaM2,
      ratioPer100M2: ratio,
      ratioSource,
      spaces: { total, standard, accessible, evReady },
      areaM2,
      areaRatio: grossAreaM2 > 0 ? round2(areaM2 / grossAreaM2) : 0,
    };

    const breakdown: TableValue = {
      columns: [
        { id: 'category', label: 'Category' },
        { id: 'spaces', label: 'Spaces' },
        { id: 'area_m2', label: 'Area (m²)' },
      ],
      rows: [
        { category: 'Standard',   spaces: standard,   area_m2: round2(standard * params.space_area_m2) },
        { category: 'Accessible', spaces: accessible, area_m2: round2(accessible * params.space_area_m2) },
        { category: 'EV-ready (of total)', spaces: evReady, area_m2: round2(evReady * params.space_area_m2) },
        { category: 'Total',      spaces: total,      area_m2: areaM2 },
      ] as Record<string, Value>[],
    };

    return { spaces_required: total, breakdown: toValue(breakdown), estimate: toValue(estimate) };
  },
```

Five things worth copying from this:

1. **Read required inputs through `requireInput`.** It throws a message naming
   the node and the port, which is what the user sees on the failed node.
2. **Treat optional inputs as genuinely absent.** `constraints?.limits?.…` and
   a documented fallback — never assume a wire is connected.
3. **Return every declared output.** The engine fails the node if any declared
   output is missing, and rejects non-finite numbers on a `number` port.
4. **Log decisions, not noise.** `ctx.log` lands in the execution panel and the
   run manifest; one line explaining a fallback is worth ten tracing values.
5. **Round at the boundary.** `round2`/`round3` from `util.ts` keep outputs
   stable and diffable instead of carrying float noise.

## 5. Test it — before wiring it into anything

The testkit runs a node standalone with an in-memory context: mock asset store,
scripted AI, captured logs and progress. No app, no engine, no Electron.

```ts
import { describe, expect, it } from 'vitest';
import { isValueOfType } from '@archspace/types';
import { runNode } from '@archspace/node-sdk/testkit';
import { parkingEstimateNode } from '../src/parking-estimate.js';
import { projectBriefNode } from '../src/project-brief.js';

describe('aec.parking_estimate', () => {
  it('runs with defaults and every output matches its declared port type', async () => {
    const brief = (await runNode(projectBriefNode, {})).outputs.brief;
    const run = await runNode(parkingEstimateNode, { inputs: { brief } });

    for (const port of parkingEstimateNode.manifest.outputs) {
      expect(isValueOfType(run.outputs[port.id], port.type), port.id).toBe(true);
    }
  });

  it('derives the space count from the brief and the ratio', async () => {
    const brief = (await runNode(projectBriefNode, { params: { target_gross_area_m2: 7600 } })).outputs.brief;
    const run = await runNode(parkingEstimateNode, { inputs: { brief } });
    expect(run.outputs.spaces_required).toBe(114); // 7600 m² at 1.5 / 100 m²
  });
});
```

`runNode` applies your schema defaults automatically, so `params` in the test
only names what you are varying. The full suite is in
[`test/parking-estimate.test.ts`](../packages/nodes-core/test/parking-estimate.test.ts).

Build inputs by **running the real upstream node**, as above, rather than
hand-writing a fixture. Fixtures drift; upstream nodes do not.

What to cover, in rough priority order:

1. Runs with defaults, and every output satisfies `isValueOfType` for its port.
2. Determinism — two identical runs deep-equal each other.
3. Inputs actually drive outputs — change something upstream and assert the
   *specific* expected change, not merely that the output differs.
4. Every behavioural branch: each fallback, each rule, each mode.
5. Failure paths — assert the message a user would read.

```sh
pnpm --filter @archspace/nodes-core exec vitest run test/parking-estimate.test.ts
pnpm --filter @archspace/nodes-core typecheck
```

## 6. Register it

Add it to [`src/index.ts`](../packages/nodes-core/src/index.ts) — export it, and
list it in `CORE_NODES`:

```ts
export { parkingEstimateNode, type ParkingEstimateParams } from './parking-estimate.js';

const CORE_NODES: readonly NodeModule<unknown>[] = [
  // …
  parkingEstimateNode,
];
```

The registry validates on registration: it rejects a malformed type id, a
duplicate type, a non-positive version, a duplicate port id, and any port whose
type expression does not parse. If your node registers, its manifest is
structurally sound.

## 7. Run it for real

```sh
pnpm dev    # the node appears in the library under its category
```

Drag it onto the canvas, wire the brief into it, and hit Run (⌘R). Or headless:

```sh
pnpm cli run packages/app/resources/example.archspace.yaml
```

The CLI prints the same event stream the UI folds into node statuses — it is
the fastest way to see what your node does under the real engine.

---

## Beyond the basics

### Long-running work: progress and cancellation

Anything that takes real time must be interruptible. Use the abort-aware
`sleep` from `util.ts` (or pass `ctx.signal` to whatever you call), and report
progress so the node's bar moves:

```ts
ctx.progress(0.1, 'checking room geometry');
await sleep(params.mock_latency_ms / 3, ctx.signal);
```

`ctx.signal` aborts when the user cancels the run. A node that ignores it keeps
running after Cancel, and the run cannot finish cleanly.

### Producing files

Bulk output goes into the content-addressed store and travels as a reference:

```ts
const ref = await ctx.assets.put(new TextEncoder().encode(csv), {
  mediaType: 'text/csv',
  format: 'csv',
  name: params.file_name,
});
return { csv: ref };            // port type: asset<csv>
```

The `format` tag is what makes the port type `asset<csv>` rather than bare
`asset`. Reading works the same way: `ctx.assets.bytes(ref)`.
See `aec.export_table_csv` and `aec.generate_bim_model`.

### Failures and retries

Throw to fail the node. Its descendants become `skipped (upstream failed)`,
while independent branches keep running. Make the message actionable — quote
the numbers:

```ts
throw new Error(
  `Floor plan capacity exceeded: target gross area ${target} m² does not fit ` +
  `${floors} floor(s) on a ${siteArea} m² site (usable ${usable} m² at 85% coverage). ` +
  `Reduce target_gross_area_m2 or increase floors.`,
);
```

Only mark an error retryable when it is genuinely transient — a rate limit, a
502. The engine then retries up to 3 attempts with backoff:

```ts
throw ctx.retryable(new Error('provider returned 429'));
```

Everything else fails fast, deliberately: silently retrying non-idempotent work
is how tools corrupt models.

### Determinism is not optional

`Math.random()`, `Date.now()` and `new Date()` are banned in node bodies. They
break memoization (a `pure` node must be reproducible), they break the golden
tests, and they make a workflow non-reproducible for the next person who opens
it. Seed a PRNG instead:

```ts
const rng = mulberry32(fnv1a(`${plan.planId}:${params.seed}`));
```

Give the node a `seed` param whenever it makes arbitrary choices, so a user can
ask for a different variant on purpose.

### Mock now, real backend later

Several nodes here stand in for backends that do not exist yet. The discipline
that keeps that honest: **the output shape is the contract**. Declare it as an
interface in [`shapes.ts`](../packages/nodes-core/src/shapes.ts), document that
a real backend must return it, and compute the mock from the actual inputs. Then
swapping in the real service is a change inside `execute()` — not a port
rewrite, not a document migration, not a workflow edit.

---

## Checklist

- [ ] `type` is namespaced, `version` starts at 1
- [ ] Every param has a `default`, a `title`, and bounds where numeric
- [ ] Ports use real port-type expressions; optional inputs say `required: false`
- [ ] `caching: 'pure'` only if it is genuinely reproducible
- [ ] `lane` reflects what the node spends
- [ ] Required inputs read through `requireInput`; optional inputs have a fallback
- [ ] Every declared output is returned; numbers are finite
- [ ] No `Math.random` / `Date.now`; long work honours `ctx.signal` and reports progress
- [ ] Tests: defaults, port types, determinism, each branch, failure messages
- [ ] Registered in `CORE_NODES`, and `pnpm test` + `pnpm typecheck` are green
