/**
 * The registry that must stay empty (ARCHITECTURE §9.3; ADR-0001 decision 2).
 *
 * If you are here because you added an `autodesk.*` node and this test went
 * red: read packages/autodesk/src/nodes.ts first, then this comment, and only
 * then change either. The emptiness is the feature.
 *
 * Real Autodesk capability arrives as MCP tools. The host generates one node
 * per tool of a *connected* server (§9.3), so the palette shows Revit tools
 * exactly when a Revit server is reachable, and shows nothing when it is not.
 * A hand-written `autodesk.revit.get_elements` node would break that coupling
 * in the worst possible direction: it would appear in the palette on a Mac
 * with no agent configured, be dragged onto a canvas, be wired into a
 * workflow, be saved into a document and committed to a repository — and only
 * then, at run time, throw. The document would still contain it. Every
 * reviewer of that workflow would read it as a working Revit integration.
 *
 * The rejected alternative is the obvious one: ship the node and have
 * `execute()` throw a clear error. That is strictly worse than nothing,
 * because a node is discoverable and a throw is not — the palette is a
 * catalogue of promises, and this package has none to make (research §3:
 * everything Revit-session-bound is Windows-only, and Archspace is only ever
 * the MCP client).
 */
import { describe, expect, it } from 'vitest';
import { autodeskNodeModules } from '../src/index.js';

describe('autodeskNodeModules', () => {
  it('is empty', () => {
    expect(autodeskNodeModules()).toEqual([]);
  });

  it('is empty on every call, and hands back a fresh array each time', () => {
    // A shared, exported constant could be pushed to by a caller and would
    // then be non-empty for everyone. "No nodes" has to survive misuse, not
    // just good behaviour.
    const first = autodeskNodeModules();
    first.push({} as never);
    expect(autodeskNodeModules()).toEqual([]);
    expect(autodeskNodeModules()).not.toBe(first);
  });

  it('contributes no node type that a workflow could reference', () => {
    // Stated as the property that actually matters, so the assertion still
    // says something if the return type ever changes shape: no manifest, no
    // type id, nothing a saved document could name.
    const types = autodeskNodeModules().map((module) => module.manifest.type);
    expect(types).toEqual([]);
  });
});
