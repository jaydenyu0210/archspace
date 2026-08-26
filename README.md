# Archspace

Node-based workflows for AEC work. See `docs/ARCHITECTURE.md` for the full
architecture; this repository currently contains the **thin vertical build**:
the desktop shell, canvas editor, execution engine, workflow document format,
and six built-in `aec.*` nodes running against deterministic mock backends.

## Run it

```sh
pnpm install
pnpm dev          # launches the Electron app; the example workflow opens on first launch
```

Headless (the CLI is also the integration harness):

```sh
pnpm cli run packages/app/resources/example.archspace.yaml
```

Tests and typecheck:

```sh
pnpm test
pnpm typecheck
```

## Layout

```
packages/
  types/        port type system: grammar, assignability, coercions
  node-sdk/     public node contract + testkit
  document/     canonical comment-preserving YAML, CST patch-on-save
  engine/       demand-driven DAG scheduler, lanes, cancellation, event stream
  nodes-core/   the six aec.* nodes (mock generate/review backends)
  cli/          `archspace run` headless runner
  app/          Electron shell (main + engine utilityProcess + renderer)
```

What is real vs. mocked in this build is documented in the manifests and in
`packages/nodes-core/src/shapes.ts` — the mock generate/review nodes return
the exact shapes a real backend integration must produce.
