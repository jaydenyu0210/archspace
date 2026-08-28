# Architecture Decision Records

Short records of the significant decisions behind [`docs/ARCHITECTURE.md`](../ARCHITECTURE.md).
Format: MADR-lite (Context → Decision → Consequences → Alternatives). Statuses: Proposed, Accepted, Superseded-by-NNNN.

| ADR | Title | Status |
|---|---|---|
| [0001](0001-platform-strategy.md) | Cross-platform core, macOS ships first, Revit via remote MCP | Accepted |
| [0002](0002-language-and-desktop-framework.md) | TypeScript + Electron, engine in a utility process | Accepted |
| [0003](0003-frontend-and-canvas.md) | React + React Flow canvas; three.js + web-ifc viewer | Accepted |
| [0004](0004-workflow-document-format.md) | Canonical comment-preserving YAML with quarantined layout | Accepted |
| [0005](0005-node-contract.md) | Declarative manifest + capability-scoped execute function | Accepted |
| [0006](0006-port-type-system.md) | Small nominal type set, explicit lifts, no implicit mapping | Accepted |
| [0007](0007-execution-engine.md) | Demand-driven memoized DAG with laned concurrency | Accepted |
| [0008](0008-plugin-boundary.md) | One OS process per plugin; MCP as the polyglot tier | Accepted |
| [0009](0009-mcp-integration.md) | Logical server names; MCP tools generated as nodes | Accepted |
| [0010](0010-ai-provider-abstraction.md) | Own gateway over AI SDK providers; model profiles | Accepted |
| [0011](0011-assets-and-projects.md) | Project directory + content-addressed derived store | Accepted |
| [0012](0012-macos-packaging.md) | electron-builder, Developer ID + notarization, no MAS | Accepted |
| [0013](0013-testing-strategy.md) | Headless-first testing with property suites and testkit | Accepted |
| [0014](0014-windows-packaging.md) | Windows build shipped unsigned; macOS stays primary | Accepted |
| [0015](0015-dxf-export.md) | Floor plans export as hand-written DXF R12; no DWG, no invented door swings | Accepted |
| [0016](0016-ifc-geometry.md) | IFC gains real swept-solid geometry, verified against IfcOpenShell | Accepted |
| [0017](0017-param-promotion.md) | Param promotion persists as a sorted `promoted:` list on the node entry | Accepted |
