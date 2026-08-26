# ADR-0003 — React + React Flow canvas; three.js + web-ifc viewer

- **Status:** Accepted
- **Date:** 2026-08-24

## Context

The canvas is the product's face: node rendering, edges, selection, pan/zoom, minimap, inline status badges. Expected scale: tens to a few hundred nodes per workflow. We also need a 3D preview for IFC assets.

## Decision

- **React** for the UI, **`@xyflow/react` (React Flow, MIT)** for the graph canvas, with custom node/edge components fed by the engine's event stream. Renderer state in Zustand.
- **three.js + web-ifc (MPL-2.0)** power an app-level 3D preview panel for `asset<ifc>` values (ships with the IFC plugin milestone). The panel is an app feature, not a node UI.
- The document model is renderer-agnostic: nothing outside the `app` package knows React Flow exists.

## Consequences

- We inherit React Flow's interaction model and its performance ceiling; with memoized nodes it comfortably covers the target scale.
- If profiling ever shows AEC workflows blowing past that scale, the escape hatch is a custom WebGL renderer behind the same document model — a renderer swap, not an architecture change.

## Alternatives considered

- **LiteGraph** (ComfyUI's canvas): battle-tested at scale but imperative, aging API, poor React integration. Rejected.
- **Rete.js v2:** ships its own processing-engine opinions that would fight ADR-0007; smaller ecosystem. Rejected.
- **Custom WebGL canvas from day one:** months of table-stakes interaction work (selection, routing, minimap) before any product value; premature. Rejected as v1, retained as escape hatch.
- **Svelte/Vue:** viable, but React Flow is the strongest node-editor library and the plugin-ecosystem gravity is React. Rejected.
